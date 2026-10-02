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
import { FIELD, collabSchema } from "./collab";
import { editFragment, getThread, setThreadResolved } from "./collab-ops";
import { db, countCollabReceipts, getCollabReceipt, insertCollabReceipt, pruneCollabReceipts } from "./db";
import { atLeast, type Level } from "./permissions";

/** Receipts are kept this long. Must exceed the command max age + clock skew, so
 *  a request whose receipt was pruned is always refused as `expired`. */
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How far in the future a command's `createdAt` may be (client clock skew). */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Retained receipts per document; above it new commands get 429 until old ones age out. */
export const RECEIPTS_PER_DOCUMENT = 5000;

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

function planSuggest(prose: PMNode, command: Extract<HumanCollabCommand, { kind: "suggest" }>, ctx: HumanCommandContext): Planned {
  const schema = collabSchema();
  const { from, to } = command;
  const text = command.text.replace(/\r\n?/g, "\n");
  checkRange(prose, from, to, command.quote);
  const $from = prose.resolve(from);
  const $to = prose.resolve(to);
  const insertion = schema.marks.insertion!;
  const deletion = schema.marks.deletion!;
  if (!$from.parent.isTextblock || !$to.parent.isTextblock) throw invalid("Select text, or place the cursor inside a paragraph.");
  if (from === to && !text) throw invalid("Enter text to insert, or select text to remove.");
  if (text && !$to.parent.type.allowsMarkType(insertion)) throw invalid("Suggested edits are not available in this kind of block.");

  // One open suggestion per passage: a second one over (or touching) it would
  // make accept/reject ambiguous. The reviewer resolves the first one first.
  let overlap = from === to && (hasReviewMark($from.marks()) || hasReviewMark($from.nodeBefore?.marks) || hasReviewMark($from.nodeAfter?.marks));
  let unmarkable = false;
  let inline = 0;
  prose.nodesBetween(from, to, (node, _pos, parent) => {
    if (!node.isInline) return true;
    inline++;
    if (hasReviewMark(node.marks)) overlap = true;
    if (parent && !parent.type.allowsMarkType(deletion)) unmarkable = true;
    return false;
  });
  if (overlap) {
    throw new HumanCommandError(409, "suggestion_overlap", "This passage already has a pending suggestion. It has to be reviewed before another change can be proposed here.");
  }
  if (from !== to && unmarkable) throw invalid("Suggested edits are not available in this kind of block.");
  if (from !== to && inline === 0) throw invalid("That selection contains no text to change.");

  const suggestionId = randomUUID();
  const attrs = { user: ctx.author.name, color: ctx.author.color, suggestionId, actorId: ctx.author.actorId, turnId: null };
  let next: PMNode;
  try {
    const tr = new Transform(prose);
    if (from !== to) tr.addMark(from, to, deletion.create(attrs));
    if (text) {
      // Keep the surrounding formatting (bold, link…), never another review/comment mark.
      const around = (from !== to ? $to.nodeBefore?.marks : $to.marks()) ?? [];
      const keep = around.filter((m) => !REVIEW_MARKS.has(m.type.name) && m.type.name !== "comment");
      const mark = insertion.create(attrs);
      const hardBreak = schema.nodes.hardBreak;
      const nodes: PMNode[] = [];
      text.split("\n").forEach((part, i) => {
        if (i > 0) nodes.push(hardBreak ? hardBreak.create(null, null, [mark]) : schema.text(" ", [...keep, mark]));
        if (part) nodes.push(schema.text(part, [...keep, mark]));
      });
      tr.insert(to, nodes);
    }
    next = tr.doc;
    next.check();
  } catch {
    throw invalid("That change cannot be placed at this position.");
  }
  // A suggestion only ever adds marks and inline content; it never restructures.
  if (next.childCount !== prose.childCount || next.eq(prose)) throw invalid("That change cannot be placed at this position.");
  return { result: { requestId: command.requestId, kind: "suggest", suggestionId }, nextProse: next, commit: () => {} };
}

interface StoredComment {
  id?: string;
  actorId?: string;
  author?: string;
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
  const plan = command.kind === "suggest" ? planSuggest(prose, command, ctx) : planComment(prose, command, ctx, doc, now);

  pruneCollabReceipts(now - RECEIPT_RETENTION_MS, ctx.vaultId, ctx.noteId);
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
