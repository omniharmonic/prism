/**
 * Human collaboration commands — the server-authored write path for suggest-level
 * people and capability-link guests (R07/R12, suggest-only enforcement).
 *
 * A suggest actor's collab socket is read-only (collab.ts `rawWriteLevel`), so it
 * cannot put anything into the shared Y.Doc itself. It sends a bounded command
 * (`@prism/core/collab-commands`) and THIS module writes the change: suggestion
 * marks for an insert / delete / replace over an exact range, or a comment
 * thread operation. Nothing here trusts the body for identity — the caller
 * (routes/human-collab.ts) passes the actor it resolved from the credential.
 *
 * `executeHumanCommand` is SYNCHRONOUS on purpose: the route does its last
 * authorization check and calls it with no await in between, so access cannot
 * change between "may this actor do it" and "it is done".
 *
 * ── Idempotency (durable receipts) ──────────────────────────────────────────
 * Receipts live in SQLite (`collab_command_receipts`), keyed by
 * (vault, note, actor, requestId) and bound to the body's hash. Two states:
 *
 *   applied  written in the same better-sqlite3 transaction / JS tick as the Yjs
 *            mutation. The change exists only in the in-memory document.
 *   durable  flipped by `storeDocumentState` in the same transaction that saves
 *            the document snapshot, and only when the vault copy was written.
 *
 * The route answers 200 only for a durable receipt. Consequences:
 *  - lost acknowledgement → the retry finds the durable receipt and returns the
 *    ORIGINAL result, even after the suggestion was accepted/rejected, the doc
 *    was unloaded and reloaded, or an external vault edit reseeded it;
 *  - crash / unload before the store → the next load of the document drops its
 *    'applied' receipts (`loadDocumentState`), so the retry applies the command
 *    afresh instead of replaying a result for a change that never reached disk;
 *  - a retry while the document is still in memory finds the 'applied' receipt,
 *    does NOT re-apply, and just waits for the store again;
 *  - same requestId with a different body → 409.
 * Independently of receipts a command can never apply twice while its first
 * effect is present: applying requires the document's revision to equal the one
 * the client saw BEFORE the command, and every effect changes the revision.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { Node as PMNode, Mark as PMMark } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { initProseMirrorDoc } from "@tiptap/y-tiptap";
import {
  canonicalCollabState,
  humanCollabRevisionInput,
  HUMAN_COLLAB_LIMITS,
  type HumanCollabCommand,
  type HumanCollabErrorCode,
  type HumanCollabResult,
} from "@prism/core/collab-commands";
import { config } from "./config";
import { FIELD, collabSchema, proseToHtml, setLostCommandCleanup } from "./collab";
import { editFragment, getThread, setThreadResolved } from "./collab-ops";
import { db, countCollabReceipts, getCollabReceipt, insertCollabReceipt, pruneCollabReceipts, type UnconfirmedCollabReceipt } from "./db";
import { atLeast, type Level } from "./permissions";

/** How far in the future a command's `createdAt` may be (client clock skew). */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
/**
 * Receipts are kept for the command max age plus twice the allowed skew — no
 * longer. Why a pruned receipt can never be re-applied: a receipt's `created_at`
 * is the SERVER time of application, and the command was accepted only with
 * `createdAt <= created_at + FUTURE_SKEW_MS`. Once `created_at < now − RETENTION`
 * (prunable), `createdAt < now − RETENTION + FUTURE_SKEW_MS <= now − maxAge`, so
 * the same request is refused as `expired` before anything else is looked at.
 */
export const RECEIPT_RETENTION_MS = HUMAN_COLLAB_LIMITS.maxAgeMs + 2 * FUTURE_SKEW_MS;
/** Retained receipts per (document, actor): one actor cannot use up a document. */
export const RECEIPTS_PER_ACTOR = 500;
/** Retained receipts per document across all actors (a backstop, not the working limit). */
export const RECEIPTS_PER_DOCUMENT = 20_000;
/** A command may not grow the rendered note past this (the vault refuses updates
 *  over 2,000,000 bytes while history is on; stay well clear of it). */
export const MAX_DOCUMENT_BYTES = 1_000_000;
/** …nor the comments map (JSON) past this. */
export const MAX_COMMENTS_BYTES = 1_000_000;
/** Unreviewed suggestions one actor may have open on one document. */
export const PENDING_SUGGESTIONS_PER_ACTOR = 100;
/** Comments (root + replies) in one thread. */
export const COMMENTS_PER_THREAD = 200;
/** Comment threads on one document. */
export const THREADS_PER_DOCUMENT = 1000;

export class HumanCommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: HumanCollabErrorCode,
    message: string,
    readonly retry = false,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new HumanCommandError(400, "invalid_command", message);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Who the server resolved the request to. Never taken from the body. */
export interface HumanCommandContext {
  vaultId: string;
  noteId: string;
  /** The collab document name the command is applied to (receipts are confirmed
   *  and dropped per in-memory document). */
  docName: string;
  /** Receipt identity: `user:<email>` | `capability:<id>`. Server-side only. */
  actor: string;
  /** The actor's collab level on this note right now (≥ suggest). */
  level: Level;
  /** How the change is attributed inside the document. */
  author: { name: string; color: string; actorId: string };
  /** Injectable clock (tests). */
  now?: number;
}

export interface HumanCommandOutcome {
  result: HumanCollabResult;
  /** True when an existing receipt answered (nothing was mutated by this call). */
  replayed: boolean;
  state: "applied" | "durable";
}

/**
 * The id written into the document for an actor (`actorId` on suggestion marks
 * and comment items — visible to every viewer). A keyed hash, so a guest reading
 * the document's HTML cannot recover, or confirm a guess at, an account's email.
 */
export function documentActorId(identity: string): string {
  return `h_${createHmac("sha256", config.sessionSecret).update(`prism-collab-author\0${identity}`).digest("hex").slice(0, 32)}`;
}

const proseOf = (doc: Y.Doc): PMNode => initProseMirrorDoc(doc.getXmlFragment(FIELD), collabSchema()).doc;
/** The comments root as JSON, without creating the root on a doc that has none. */
const commentsOf = (doc: Y.Doc): unknown => (doc.share.has("comments") ? doc.getMap("comments").toJSON() : {});

/** The revision of a live document — same input as the browser's `humanCollabRevision`. */
export function humanRevision(doc: Y.Doc): string {
  return sha256(humanCollabRevisionInput(proseOf(doc).toJSON(), commentsOf(doc)));
}

export const commandHash = (command: HumanCollabCommand): string => sha256(canonicalCollabState(command));

/**
 * The receipt for this request, if one exists. Throws 409 when the request id
 * was already used for a different body. Safe to call before the document is
 * open (a durable receipt needs no document at all).
 */
export function findReceipt(ctx: Pick<HumanCommandContext, "vaultId" | "noteId" | "actor">, command: HumanCollabCommand): HumanCommandOutcome | null {
  const row = getCollabReceipt(ctx.vaultId, ctx.noteId, ctx.actor, command.requestId);
  if (!row) return null;
  if (row.command_hash !== commandHash(command)) {
    throw new HumanCommandError(409, "request_id_reused", "This request ID already describes a different change. Start a new request.");
  }
  return { result: JSON.parse(row.result) as HumanCollabResult, replayed: true, state: row.state };
}

const REVIEW_MARKS = new Set(["insertion", "deletion"]);
const hasReviewMark = (marks: readonly PMMark[] | undefined): boolean => !!marks?.some((m) => REVIEW_MARKS.has(m.type.name));

interface Planned {
  result: HumanCollabResult;
  /** The body after the command, or null when the body is unchanged. */
  nextProse: PMNode | null;
  /** Comment-map work, run inside the Yjs transaction. */
  commit: (doc: Y.Doc, origin: string) => void;
}

/** Validate a range against the current body and its quote. */
function checkRange(prose: PMNode, from: number, to: number, quote: string): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > prose.content.size) {
    throw invalid("That selection is outside the document.");
  }
  let text: string;
  try {
    prose.resolve(from);
    prose.resolve(to);
    text = prose.textBetween(from, to, "\n", "￼");
  } catch {
    throw invalid("That selection is outside the document.");
  }
  if (text !== quote) {
    throw new HumanCommandError(409, "quote_changed", "The selected passage changed. Your draft is kept; select the passage again before submitting.");
  }
}

/** Resolve ONE suggestion (by id) on a document: the reviewer's accept / reject. */
function resolveOne(doc: PMNode, suggestionId: string, action: "accept" | "reject"): PMNode {
  const drop = action === "accept" ? "deletion" : "insertion";
  type J = { marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: J[] } & Record<string, unknown>;
  const mine = (m: { type: string; attrs?: Record<string, unknown> }) => REVIEW_MARKS.has(m.type) && m.attrs?.suggestionId === suggestionId;
  const visit = (n: J): J | null => {
    const marks = n.marks ?? [];
    if (marks.some((m) => mine(m) && m.type === drop)) return null;
    const out: J = { ...n };
    if (n.marks) {
      const kept = marks.filter((m) => !mine(m));
      if (kept.length) out.marks = kept;
      else delete out.marks;
    }
    if (n.content) out.content = n.content.map(visit).filter((c): c is J => c !== null);
    return out;
  };
  return collabSchema().nodeFromJSON(visit(doc.toJSON() as J));
}

/** What a body becomes once it has been written into Yjs and read back — marks
 *  the shared types cannot carry (e.g. on a line break) are gone here. */
function throughYjs(doc: Y.Doc, next: PMNode): PMNode {
  const fork = new Y.Doc();
  try {
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc));
    editFragment(fork, () => next);
    return proseOf(fork);
  } finally {
    fork.destroy();
  }
}

/** This actor's open suggestions in a body. */
function pendingSuggestionsOf(prose: PMNode, actorId: string): number {
  const ids = new Set<string>();
  prose.descendants((node) => {
    for (const m of node.marks) if (REVIEW_MARKS.has(m.type.name) && m.attrs.actorId === actorId) ids.add(String(m.attrs.suggestionId ?? ""));
  });
  return ids.size;
}

const UNMARKABLE = "That selection includes content a suggestion cannot cover (inline code, a line break or an embedded item). Select plain text within one paragraph.";

function planSuggest(doc: Y.Doc, prose: PMNode, command: Extract<HumanCollabCommand, { kind: "suggest" }>, ctx: HumanCommandContext): Planned {
  const schema = collabSchema();
  const { from, to, text } = command;
  // A line break is a node, not text: the shared Yjs types keep no mark on it,
  // so it could be neither attributed nor rejected. Refuse rather than add
  // content nobody can review.
  if (/[\r\n\u2028\u2029]/.test(text)) throw invalid("A suggestion cannot contain a line break. Suggest each line separately.");
  checkRange(prose, from, to, command.quote);
  const $from = prose.resolve(from);
  const $to = prose.resolve(to);
  const insertion = schema.marks.insertion!;
  const deletion = schema.marks.deletion!;
  if (!$from.parent.isTextblock || !$to.parent.isTextblock) throw invalid("Select text, or place the cursor inside a paragraph.");
  if (!$from.sameParent($to)) throw invalid("A suggestion has to stay within one paragraph. Suggest each paragraph separately.");
  if (from === to && !text) throw invalid("Enter text to insert, or select text to remove.");
  if (!$to.parent.type.allowsMarkType(insertion) || !$to.parent.type.allowsMarkType(deletion)) throw invalid("Suggested edits are not available in this kind of block.");

  // One open suggestion per passage: a second one over (or touching) it would
  // make accept/reject ambiguous. The reviewer resolves the first one first.
  let overlap = from === to && (hasReviewMark($from.marks()) || hasReviewMark($from.nodeBefore?.marks) || hasReviewMark($from.nodeAfter?.marks));
  prose.nodesBetween(from, to, (node) => {
    if (node.isInline && hasReviewMark(node.marks)) overlap = true;
    return true;
  });
  if (overlap) {
    throw new HumanCommandError(409, "suggestion_overlap", "This passage already has a pending suggestion. It has to be reviewed before another change can be proposed here.");
  }
  if (pendingSuggestionsOf(prose, ctx.author.actorId) >= PENDING_SUGGESTIONS_PER_ACTOR) {
    throw new HumanCommandError(429, "too_many_pending_suggestions", "You have too many suggestions waiting for review on this document. Wait until an editor has reviewed some of them.");
  }

  const suggestionId = randomUUID();
  const attrs = { user: ctx.author.name, color: ctx.author.color, suggestionId, actorId: ctx.author.actorId, turnId: null };
  // Keep the surrounding formatting (bold, link…), never another review/comment mark.
  const around = (from !== to ? $to.nodeBefore?.marks : $to.marks()) ?? [];
  const keep = around.filter((m) => !REVIEW_MARKS.has(m.type.name) && m.type.name !== "comment");
  let next: PMNode;
  let accepted: PMNode;
  try {
    const tr = new Transform(prose);
    if (from !== to) tr.addMark(from, to, deletion.create(attrs));
    if (text) tr.insert(to, schema.text(text, [...keep, insertion.create(attrs)]));
    next = tr.doc;
    next.check();
    // What accepting the suggestion must produce: the plain edit, nothing else.
    const plain = new Transform(prose);
    if (text) plain.replaceWith(from, to, schema.text(text, keep));
    else plain.delete(from, to);
    accepted = plain.doc;
  } catch {
    throw invalid("That change cannot be placed at this position.");
  }
  // FAIL-CLOSED post-condition, checked on what Yjs will actually hold:
  //  - rejecting this suggestion gives back EXACTLY the current body, and
  //  - accepting it gives EXACTLY the plain edit.
  // Together: every node the command adds carries the insertion mark, every
  // node in the range carries the deletion mark, and nothing else changed. A
  // range that can only be marked in part (inline code excludes other marks, a
  // line break or image carries none) fails here and nothing is mutated.
  let stored: PMNode;
  try {
    stored = throughYjs(doc, next);
  } catch {
    throw invalid("That change cannot be placed at this position.");
  }
  if (stored.eq(prose) || !resolveOne(stored, suggestionId, "reject").eq(prose) || !resolveOne(stored, suggestionId, "accept").eq(accepted)) {
    throw invalid(UNMARKABLE);
  }
  if (Buffer.byteLength(proseToHtml(stored)) > MAX_DOCUMENT_BYTES && text) {
    throw new HumanCommandError(413, "document_too_large", "This document is too large to take another suggested insertion. An editor needs to review pending suggestions or split the document first.");
  }
  return { result: { requestId: command.requestId, kind: "suggest", suggestionId }, nextProse: next, commit: () => {} };
}

interface StoredComment {
  id?: string;
  actorId?: string;
  author?: string;
}

/** Refuse a comment/reply that would push the comments map past its size budget. */
function commentBudget(doc: Y.Doc, text: string): void {
  const used = Buffer.byteLength(JSON.stringify(commentsOf(doc)));
  if (used + Buffer.byteLength(text) + 400 > MAX_COMMENTS_BYTES) {
    throw new HumanCommandError(413, "document_too_large", "This document's comments have reached their size limit. Resolve and delete old threads first.");
  }
}

function planComment(prose: PMNode, command: Exclude<HumanCollabCommand, { kind: "suggest" }>, ctx: HumanCommandContext, doc: Y.Doc, now: number): Planned {
  const schema = collabSchema();
  const item = (text: string, id: string) => ({ id, author: ctx.author.name, actorId: ctx.author.actorId, color: ctx.author.color, text, createdAt: now, agent: false });

  if (command.kind === "comment") {
    const text = command.text.trim();
    if (!text) throw invalid("Enter a comment.");
    checkRange(prose, command.from, command.to, command.quote);
    if (command.from === command.to) throw invalid("Select the text you want to comment on.");
    const threadId = `c-${randomUUID()}`;
    const commentId = randomUUID();
    let next: PMNode;
    try {
      next = new Transform(prose).addMark(command.from, command.to, schema.marks.comment!.create({ id: threadId, resolved: false })).doc;
      next.check();
    } catch {
      throw invalid("A comment cannot be anchored on that selection.");
    }
    if (next.eq(prose)) throw invalid("Select the text you want to comment on.");
    if (doc.share.has("comments") && doc.getMap("comments").size >= THREADS_PER_DOCUMENT) {
      throw new HumanCommandError(429, "too_many_threads", "This document has reached its limit of comment threads. Resolve and delete old threads first.");
    }
    commentBudget(doc, text);
    if (Buffer.byteLength(proseToHtml(next)) > MAX_DOCUMENT_BYTES) {
      throw new HumanCommandError(413, "document_too_large", "This document is too large to anchor another comment.");
    }
    const quote = prose.textBetween(command.from, command.to, " ").slice(0, 200); // the editor's own thread quote
    return {
      result: { requestId: command.requestId, kind: "comment", threadId, commentId },
      nextProse: next,
      commit: (d) => {
        const t = new Y.Map<unknown>();
        t.set("id", threadId);
        t.set("quote", quote);
        t.set("resolved", false);
        const arr = new Y.Array<unknown>();
        arr.push([item(text, commentId)]);
        t.set("comments", arr);
        d.getMap("comments").set(threadId, t);
      },
    };
  }

  const thread = doc.share.has("comments") ? getThread(doc, command.threadId) : undefined;
  if (!thread) throw new HumanCommandError(409, "thread_missing", "This comment thread no longer exists.");
  const items = thread.get("comments") as Y.Array<StoredComment> | undefined;

  if (command.kind === "reply") {
    const text = command.text.trim();
    if (!text) throw invalid("Enter a reply.");
    if (!items) throw new HumanCommandError(409, "thread_missing", "This comment thread no longer exists.");
    if (items.length >= COMMENTS_PER_THREAD) {
      throw new HumanCommandError(409, "thread_full", "This thread has reached its limit of comments. Start a new thread.");
    }
    commentBudget(doc, text);
    const commentId = randomUUID();
    return {
      result: { requestId: command.requestId, kind: "reply", threadId: command.threadId, commentId },
      nextProse: null,
      commit: () => items.push([item(text, commentId)]),
    };
  }

  if (command.kind === "resolve") {
    // Same rule as the shipped editor and the MCP tools: whoever may comment may
    // resolve or reopen ANY thread (it is reversible and removes nothing).
    return {
      result: { requestId: command.requestId, kind: "resolve", threadId: command.threadId, resolved: command.resolved },
      nextProse: null,
      commit: (d, origin) => setThreadResolved(d, command.threadId, command.resolved, origin),
    };
  }

  // delete-comment. Editors may delete any thread (as in the editor). A suggest
  // actor may delete only a thread that is entirely its own: EVERY comment in it
  // carries this actor's server-stamped id. That is narrower than the shipped
  // editor (where a suggest user could delete any thread, including other
  // people's replies) and it means a thread written by a pre-enforcement client
  // (no `actorId`) can be removed only by an editor.
  if (!atLeast(ctx.level, "edit")) {
    const all = items?.toArray() ?? [];
    if (all.length === 0 || !all.every((c) => c && c.actorId === ctx.author.actorId)) {
      throw new HumanCommandError(403, "not_author", "You can delete only comment threads that contain your own comments and nobody else's. Ask an editor to remove this one.");
    }
  }
  const threadId = command.threadId;
  let next: PMNode | null = null;
  try {
    const tr = new Transform(prose);
    prose.descendants((node, pos) => {
      for (const mark of node.marks) if (mark.type.name === "comment" && mark.attrs.id === threadId) tr.removeMark(pos, pos + node.nodeSize, mark);
    });
    if (tr.docChanged) next = tr.doc;
  } catch {
    next = null;
  }
  return {
    result: { requestId: command.requestId, kind: "delete-comment", threadId },
    nextProse: next,
    commit: (d) => d.getMap("comments").delete(threadId),
  };
}

/**
 * Apply one command to a live document. Synchronous: no awaits, so the caller's
 * authorization check and this mutation cannot be interleaved with anything.
 * Returns the existing outcome for a known request id (no mutation).
 */
export function executeHumanCommand(doc: Y.Doc, ctx: HumanCommandContext, command: HumanCollabCommand): HumanCommandOutcome {
  const existing = findReceipt(ctx, command);
  if (existing) return existing;

  const now = ctx.now ?? Date.now();
  if (command.createdAt > now + FUTURE_SKEW_MS || command.createdAt < now - HUMAN_COLLAB_LIMITS.maxAgeMs) {
    throw new HumanCommandError(409, "expired", "This request is too old to submit. Review the current document and prepare the change again.");
  }
  if (!atLeast(ctx.level, "suggest")) throw new HumanCommandError(403, "forbidden", "Suggest access is required for this document.");
  if (humanRevision(doc) !== command.revision) {
    throw new HumanCommandError(409, "stale_revision", "The document or its comments changed. Your draft is kept; select the current passage and review it before submitting again.");
  }

  const prose = proseOf(doc);
  const plan = command.kind === "suggest" ? planSuggest(doc, prose, command, ctx) : planComment(prose, command, ctx, doc, now);

  pruneCollabReceipts(now - RECEIPT_RETENTION_MS, ctx.vaultId, ctx.noteId);
  if (countCollabReceipts(ctx.vaultId, ctx.noteId, ctx.actor) >= RECEIPTS_PER_ACTOR) {
    throw new HumanCommandError(429, "actor_request_limit", "You have made too many changes to this document in the last day. Try again later.");
  }
  if (countCollabReceipts(ctx.vaultId, ctx.noteId) >= RECEIPTS_PER_DOCUMENT) {
    throw new HumanCommandError(429, "document_request_limit", "This document has reached its limit of recent collaboration requests. Try again later.");
  }

  const origin = `human:${ctx.actor}`;
  // Receipt + mutation: one SQLite transaction around one Yjs transaction, all
  // in this tick. If the mutation throws, the receipt is rolled back.
  db.transaction(() => {
    insertCollabReceipt({
      vault_id: ctx.vaultId,
      note_id: ctx.noteId,
      doc_name: ctx.docName,
      actor: ctx.actor,
      request_id: command.requestId,
      command_hash: commandHash(command),
      kind: command.kind,
      result: JSON.stringify(plan.result),
      created_at: now,
    });
    doc.transact(() => {
      if (plan.nextProse) editFragment(doc, () => plan.nextProse);
      plan.commit(doc, origin);
    }, origin);
  })();
  return { result: plan.result, replayed: false, state: "applied" };
}

let lastGlobalPrune = 0;
/** Opportunistic retention sweep across all documents (at most hourly). */
export function pruneReceiptsIfDue(now = Date.now()): void {
  if (now - lastGlobalPrune < 60 * 60 * 1000) return;
  lastGlobalPrune = now;
  pruneCollabReceipts(now - RECEIPT_RETENTION_MS);
}

/**
 * Remove what forgotten (never confirmed) commands left in a snapshot that was
 * just restored (collab.ts `loadDocumentState`). The body has usually been put
 * back by the vault fold already; this covers what the fold does not touch (the
 * `comments` map) and the no-fold cases, so the document is the PRE-command
 * state again and the client's retry — same request, same revision — applies.
 *   suggest         reject that suggestion id (if its marks are still there)
 *   comment         delete the thread and its anchor
 *   reply           remove that one comment item
 *   delete-comment  the thread cannot be brought back: finish the body side
 *                   (strip the orphan anchor) so map and body agree
 *   resolve         re-stamp the anchor to the thread's flag so they agree
 * Idempotent; newest first so replies go before their thread.
 */
export function undoLostCommands(doc: Y.Doc, lost: UnconfirmedCollabReceipt[]): void {
  const origin = "human:lost-command-cleanup";
  const stripAnchor = (threadId: string) =>
    editFragment(doc, (d) => {
      const tr = new Transform(d);
      d.descendants((node, pos) => {
        for (const mark of node.marks) if (mark.type.name === "comment" && mark.attrs.id === threadId) tr.removeMark(pos, pos + node.nodeSize, mark);
      });
      return tr.docChanged ? tr.doc : null;
    });
  doc.transact(() => {
    for (const row of [...lost].reverse()) {
      let r: HumanCollabResult;
      try {
        r = JSON.parse(row.result) as HumanCollabResult;
      } catch {
        continue;
      }
      const threads = doc.share.has("comments") ? doc.getMap<Y.Map<unknown>>("comments") : null;
      if (row.kind === "suggest" && r.suggestionId) {
        const id = r.suggestionId;
        editFragment(doc, (d) => resolveOne(d, id, "reject"));
      } else if (row.kind === "comment" && r.threadId) {
        threads?.delete(r.threadId);
        stripAnchor(r.threadId);
      } else if (row.kind === "reply" && r.threadId && r.commentId) {
        const items = threads?.get(r.threadId)?.get("comments") as Y.Array<StoredComment> | undefined;
        const at = items ? items.toArray().findIndex((c) => c?.id === r.commentId) : -1;
        if (items && at >= 0) items.delete(at, 1);
      } else if (row.kind === "delete-comment" && r.threadId) {
        if (!threads?.has(r.threadId)) stripAnchor(r.threadId);
      } else if (row.kind === "resolve" && r.threadId) {
        const t = threads?.get(r.threadId);
        if (t) setThreadResolved(doc, r.threadId, !!t.get("resolved"), origin);
      }
    }
  }, origin);
}
setLostCommandCleanup(undoLostCommands);
