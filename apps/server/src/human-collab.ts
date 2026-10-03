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
 * Independently of receipts, a command cannot apply while its first effect is
 * still present: applying requires the document's revision to equal the one the
 * client saw BEFORE the command, and every effect changes the revision. (After a
 * lost command is cleaned up, the retry applies once for suggest / comment /
 * reply; a lost resolve or delete-comment cannot be undone and its retry gets 409.)
 *
 * ── Cost ──────────────────────────────────────────────────────────────────────
 * Per command the whole-document work is: one ProseMirror view of the Y fragment
 * and one revision hash (both cached per document until it changes) and one
 * Yjs diff of the new body. Validation, the fail-closed post-condition and the
 * size delta run on the touched blocks only; the rendered size is the last
 * store's exact figure plus this command's delta.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import * as Y from "yjs";
import { Slice, type Node as PMNode, type Mark as PMMark } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import {
  canonicalCollabState,
  humanCollabRevisionInput,
  HUMAN_COLLAB_LIMITS,
  type HumanCollabCommand,
  type HumanCollabErrorCode,
  type HumanCollabResult,
} from "@prism/core/collab-commands";
import { config } from "./config";
import { FIELD, collabSchema, proseToHtml, renderedSizeOf, setCommandEffectsCheck, setLostCommandCleanup, setRenderedSize } from "./collab";
import { editFragment, getThread, setThreadResolved } from "./collab-ops";
import { db, collabActorUsage, countCollabReceipts, deleteUnconfirmedCollabReceipts, getCollabReceipt, insertCollabReceipt, pruneCollabReceipts, type UnconfirmedCollabReceipt } from "./db";
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
/** suggest / comment / reply receipts per (document, actor) within retention. */
export const RECEIPTS_PER_ACTOR = 500;
/** resolve / delete-comment receipts per (document, actor), counted SEPARATELY so
 *  an actor at its change limit can still tidy up (what the limit message asks). */
export const HOUSEKEEPING_PER_ACTOR = 500;
/** Receipts per document across all actors (a backstop, not the working limit). */
export const RECEIPTS_PER_DOCUMENT = 20_000;
/** A command may not grow the rendered note past this (the vault refuses updates
 *  over 2,000,000 bytes while history is on; stay well clear of it). */
export const MAX_DOCUMENT_BYTES = 1_000_000;
/** …nor the comments map (JSON) past this. */
export const MAX_COMMENTS_BYTES = 1_000_000;
/** Rendered-body growth one actor may cause on one document within retention. */
export const ACTOR_BODY_BYTES = 100_000;
/** Comment data one actor may add on one document within retention. */
export const ACTOR_COMMENT_BYTES = 100_000;
/** Rendered-body growth of ONE command (a deletion across densely formatted
 *  text multiplies the attributed spans). */
export const MAX_GROWTH_PER_COMMAND = 64_000;
/** Distinct text runs (differently formatted pieces) one range may cover. */
export const MAX_RUNS_PER_RANGE = 100;
/** Unreviewed suggestions one actor may have open on one document. */
export const PENDING_SUGGESTIONS_PER_ACTOR = 100;
/** Comments (root + replies) in one thread. */
export const COMMENTS_PER_THREAD = 200;
/** Comment threads on one document. */
export const THREADS_PER_DOCUMENT = 1000;
/** Characters of a display name written into marks / comments. */
export const MAX_AUTHOR_NAME = 80;

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
const bytes = (s: string) => Buffer.byteLength(s);

// ── text hygiene ────────────────────────────────────────────────────────────

/** No lone UTF-16 surrogates: the server keeps one, a browser shows U+FFFD, and
 *  the two would then hash different revisions for the same document. */
export function isWellFormed(s: string): boolean {
  const native = (s as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (native) return native.call(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
// C0 (except where allowed), DEL, C1.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * Why a piece of user text is not acceptable, or null.
 *  - every field: well-formed UTF-16, no NUL / control characters;
 *  - suggested text (it becomes document HTML, and the document is re-seeded
 *    from that HTML after an external edit): no line breaks, no tabs, not only
 *    whitespace, no run of two whitespace characters — HTML collapses those, so
 *    the stored text would differ from what was suggested;
 *  - comment / reply text (stored as data, not HTML): line breaks and tabs ok.
 */
export function textProblem(text: string, kind: "suggest" | "comment" | "quote" | "id"): string | null {
  if (!isWellFormed(text)) return "The text contains an invalid character.";
  if (kind === "quote") return text.includes("\u0000") ? "The text contains an invalid character." : null;
  if (CONTROL.test(text)) return "The text contains a control character.";
  if (kind === "suggest") {
    if (LINE_BREAK.test(text)) return "A suggestion cannot contain a line break. Suggest each line separately.";
    if (text.includes("\t")) return "A suggestion cannot contain a tab.";
    if (text && !text.trim()) return "A suggestion cannot consist only of spaces.";
    if (/\s\s/.test(text)) return "Use single spaces in a suggestion.";
  }
  return null;
}

/** A display name as it may be written into the document. */
export function safeAuthorName(name: string): string {
  const clean = (isWellFormed(name) ? name : [...name].filter((ch) => isWellFormed(ch)).join("")).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return [...clean].slice(0, MAX_AUTHOR_NAME).join("") || "Someone";
}

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

/** The comments root as JSON, without creating the root on a doc that has none. */
const commentsOf = (doc: Y.Doc): Record<string, unknown> => (doc.share.has("comments") ? doc.getMap("comments").toJSON() : {});

// ── per-document snapshot cache ─────────────────────────────────────────────

interface Snapshot {
  prose: PMNode;
  meta: unknown;
  revision: string;
  commentsBytes: number;
  pending?: Map<string, number>;
}
const snapshots = new WeakMap<Y.Doc, { snap: Snapshot | null }>();
/** The document as ProseMirror + its revision, computed once per document state. */
function snapshotOf(doc: Y.Doc): Snapshot {
  let entry = snapshots.get(doc);
  if (!entry) {
    const e: { snap: Snapshot | null } = { snap: null };
    doc.on("update", () => {
      e.snap = null;
    });
    snapshots.set(doc, e);
    entry = e;
  }
  if (!entry.snap) {
    const { doc: prose, meta } = initProseMirrorDoc(doc.getXmlFragment(FIELD), collabSchema());
    const comments = commentsOf(doc);
    entry.snap = {
      prose,
      meta,
      revision: sha256(humanCollabRevisionInput(prose.toJSON(), comments)),
      commentsBytes: bytes(JSON.stringify(comments)),
    };
  }
  return entry.snap;
}
const proseOf = (doc: Y.Doc): PMNode => snapshotOf(doc).prose;

/** The revision of a live document — same input as the browser's `humanCollabRevision`. */
export function humanRevision(doc: Y.Doc): string {
  return snapshotOf(doc).revision;
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
  /** Rendered-body growth (bytes) and comment data (bytes) this command adds. */
  bodyBytes: number;
  commentBytes: number;
}

/** Validate a range against the current body and its quote (cost ∝ the range). */
function checkRange(prose: PMNode, from: number, to: number, quote: string): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > prose.content.size) {
    throw invalid("That selection is outside the document.");
  }
  let text: string;
  try {
    prose.resolve(from);
    prose.resolve(to);
    text = prose.textBetween(from, to, "\n", "\ufffc");
  } catch {
    throw invalid("That selection is outside the document.");
  }
  if (text !== quote) {
    throw new HumanCommandError(409, "quote_changed", "The selected passage changed. Your draft is kept; select the passage again before submitting.");
  }
}

/** The top-level blocks a range touches, as a small document of their own. */
interface Window {
  offset: number;
  end: number;
  mini: PMNode;
}
function windowOf(prose: PMNode, from: number, to: number): Window {
  const $from = prose.resolve(from);
  const $to = prose.resolve(to);
  if ($from.depth < 1 || $to.depth < 1) throw invalid("Select text, or place the cursor inside a paragraph.");
  const offset = $from.before(1);
  const end = $to.after(1);
  return { offset, end, mini: prose.type.create(prose.attrs, prose.content.cut(offset, end)) };
}

/** A small document as Yjs will hold it (marks a shared type cannot carry, e.g. on a line break, are gone). */
function throughYjs(mini: PMNode): PMNode {
  const y = new Y.Doc();
  try {
    const frag = y.getXmlFragment(FIELD);
    y.transact(() => updateYFragment(y, frag, mini, { mapping: new Map(), isOMark: new Map() } as never));
    return initProseMirrorDoc(frag, collabSchema()).doc;
  } finally {
    y.destroy();
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

/** Open suggestions per actor id in the document (cached with the snapshot). */
function pendingSuggestionsOf(doc: Y.Doc, actorId: string): number {
  const snap = snapshotOf(doc);
  if (!snap.pending) {
    const sets = new Map<string, Set<string>>();
    snap.prose.descendants((node) => {
      for (const m of node.marks) {
        if (!REVIEW_MARKS.has(m.type.name) || typeof m.attrs.actorId !== "string") continue;
        let set = sets.get(m.attrs.actorId);
        if (!set) sets.set(m.attrs.actorId, (set = new Set()));
        set.add(String(m.attrs.suggestionId ?? ""));
      }
    });
    snap.pending = new Map([...sets].map(([k, v]) => [k, v.size]));
  }
  return snap.pending.get(actorId) ?? 0;
}

/** The document's rendered size: the last store's exact figure (+ deltas since), else computed once. */
function renderedSize(doc: Y.Doc, prose: PMNode): number {
  let size = renderedSizeOf(doc);
  if (size === undefined) {
    size = bytes(proseToHtml(prose));
    setRenderedSize(doc, size);
  }
  return size;
}

/** Body-growth budgets: per command, per actor, and the document as a whole. */
function bodyBudget(doc: Y.Doc, prose: PMNode, growth: number, usedByActor: number): void {
  if (growth <= 0) return;
  if (growth > MAX_GROWTH_PER_COMMAND) {
    throw new HumanCommandError(413, "document_too_large", "This change would add too much to the document at once. Select a smaller passage.");
  }
  if (usedByActor + growth > ACTOR_BODY_BYTES) {
    throw new HumanCommandError(429, "actor_growth_limit", "You have added as much to this document as one person can in a day. An editor can review your pending suggestions, or try again later.");
  }
  if (renderedSize(doc, prose) + growth > MAX_DOCUMENT_BYTES) {
    throw new HumanCommandError(413, "document_too_large", "This document is too large to take this change. An editor needs to review pending suggestions or split the document first.");
  }
}

const UNMARKABLE = "That selection includes content a suggestion cannot cover (inline code, a line break or an embedded item). Select plain text within one paragraph.";

function planSuggest(doc: Y.Doc, prose: PMNode, command: Extract<HumanCollabCommand, { kind: "suggest" }>, ctx: HumanCommandContext, usage: ActorUsage): Planned {
  const schema = collabSchema();
  const { from, to, text } = command;
  // A line break is a node, not text: the shared Yjs types keep no mark on it,
  // so it could be neither attributed nor rejected — refused with the other
  // text the stored HTML could not reproduce (textProblem).
  const problem = textProblem(text, "suggest");
  if (problem) throw invalid(problem);
  checkRange(prose, from, to, command.quote);
  const $from = prose.resolve(from);
  const $to = prose.resolve(to);
  const insertion = schema.marks.insertion!;
  const deletion = schema.marks.deletion!;
  if (!$from.parent.isTextblock || !$to.parent.isTextblock) throw invalid("Select text, or place the cursor inside a paragraph.");
  if (!$from.sameParent($to)) throw invalid("A suggestion has to stay within one paragraph. Suggest each paragraph separately.");
  if (from === to && !text) throw invalid("Enter text to insert, or select text to remove.");
  if (!$to.parent.type.allowsMarkType(insertion) || !$to.parent.type.allowsMarkType(deletion)) throw invalid("Suggested edits are not available in this kind of block.");
  if (text) {
    // A space at a paragraph edge or next to another space collapses in HTML.
    const before = to > $to.start() ? prose.textBetween(to - 1, to, "\n", "\ufffc") : "";
    const after = to < $to.end() ? prose.textBetween(to, to + 1, "\n", "\ufffc") : "";
    if ((/^\s/.test(text) && (!before || /\s/.test(before))) || (/\s$/.test(text) && (!after || /\s/.test(after)))) {
      throw invalid("A suggestion cannot start or end with a space at the edge of a paragraph or next to another space.");
    }
  }

  // One open suggestion per passage: a second one over (or touching) it would
  // make accept/reject ambiguous. The reviewer resolves the first one first.
  let overlap = from === to && (hasReviewMark($from.marks()) || hasReviewMark($from.nodeBefore?.marks) || hasReviewMark($from.nodeAfter?.marks));
  let runs = 0;
  prose.nodesBetween(from, to, (node) => {
    if (!node.isInline) return true;
    runs++;
    if (hasReviewMark(node.marks)) overlap = true;
    return false;
  });
  if (overlap) {
    throw new HumanCommandError(409, "suggestion_overlap", "This passage already has a pending suggestion. It has to be reviewed before another change can be proposed here.");
  }
  if (runs > MAX_RUNS_PER_RANGE) throw invalid("That selection covers too many differently formatted pieces of text. Select a shorter passage.");
  if (pendingSuggestionsOf(doc, ctx.author.actorId) >= PENDING_SUGGESTIONS_PER_ACTOR) {
    throw new HumanCommandError(429, "too_many_pending_suggestions", "You have too many suggestions waiting for review on this document. Wait until an editor has reviewed some of them.");
  }

  // Everything from here works on the touched paragraph's top-level block only.
  const w = windowOf(prose, from, to);
  const lf = from - w.offset;
  const lt = to - w.offset;
  const suggestionId = randomUUID();
  const attrs = { user: ctx.author.name, color: ctx.author.color, suggestionId, actorId: ctx.author.actorId, turnId: null };
  // Keep the surrounding formatting (bold, link…), never another review/comment mark.
  const around = (from !== to ? $to.nodeBefore?.marks : $to.marks()) ?? [];
  const keep = around.filter((m) => !REVIEW_MARKS.has(m.type.name) && m.type.name !== "comment");
  let miniNext: PMNode;
  let miniAccepted: PMNode;
  try {
    const tr = new Transform(w.mini);
    if (from !== to) tr.addMark(lf, lt, deletion.create(attrs));
    if (text) tr.insert(lt, schema.text(text, [...keep, insertion.create(attrs)]));
    miniNext = tr.doc;
    miniNext.check();
    // What accepting the suggestion must produce: the plain edit, nothing else.
    const plain = new Transform(w.mini);
    if (text) plain.replaceWith(lf, lt, schema.text(text, keep));
    else plain.delete(lf, lt);
    miniAccepted = plain.doc;
  } catch {
    throw invalid("That change cannot be placed at this position.");
  }
  // FAIL-CLOSED post-condition, on what Yjs will actually hold: rejecting this
  // suggestion gives back EXACTLY the block as it is, and accepting it gives
  // EXACTLY the plain edit. So every node the command adds carries the insertion
  // mark, every node in the range carries the deletion mark, and nothing else
  // changed. A range that can be marked only in part (inline code excludes other
  // marks; a line break or image carries none) fails here; nothing is mutated.
  let stored: PMNode;
  try {
    stored = throughYjs(miniNext);
  } catch {
    throw invalid("That change cannot be placed at this position.");
  }
  if (stored.eq(w.mini) || !resolveOne(stored, suggestionId, "reject").eq(w.mini) || !resolveOne(stored, suggestionId, "accept").eq(miniAccepted)) {
    throw invalid(UNMARKABLE);
  }
  const growth = bytes(proseToHtml(stored)) - bytes(proseToHtml(w.mini));
  bodyBudget(doc, prose, growth, usage.body);
  return {
    result: { requestId: command.requestId, kind: "suggest", suggestionId },
    nextProse: prose.replace(w.offset, w.end, new Slice(miniNext.content, 0, 0)),
    commit: () => {},
    bodyBytes: Math.max(0, growth),
    commentBytes: 0,
  };
}

interface StoredComment {
  id?: string;
  actorId?: string;
  author?: string;
}

/** Comment-data budgets: per actor and the document as a whole. */
function commentBudget(doc: Y.Doc, added: number, usedByActor: number): void {
  if (usedByActor + added > ACTOR_COMMENT_BYTES) {
    throw new HumanCommandError(429, "actor_growth_limit", "You have added as many comments to this document as one person can in a day. Try again later.");
  }
  if (snapshotOf(doc).commentsBytes + added > MAX_COMMENTS_BYTES) {
    throw new HumanCommandError(413, "document_too_large", "This document's comments have reached their size limit. Resolve and delete old threads first.");
  }
}

function planComment(prose: PMNode, command: Exclude<HumanCollabCommand, { kind: "suggest" }>, ctx: HumanCommandContext, doc: Y.Doc, now: number, usage: ActorUsage): Planned {
  const schema = collabSchema();
  const item = (text: string, id: string) => ({ id, author: ctx.author.name, actorId: ctx.author.actorId, color: ctx.author.color, text, createdAt: now, agent: false });

  if (command.kind === "comment") {
    const text = command.text.trim();
    if (!text) throw invalid("Enter a comment.");
    const problem = textProblem(text, "comment");
    if (problem) throw invalid(problem);
    checkRange(prose, command.from, command.to, command.quote);
    if (command.from === command.to) throw invalid("Select the text you want to comment on.");
    if (doc.share.has("comments") && doc.getMap("comments").size >= THREADS_PER_DOCUMENT) {
      throw new HumanCommandError(429, "too_many_threads", "This document has reached its limit of comment threads. Resolve and delete old threads first.");
    }
    let runs = 0;
    prose.nodesBetween(command.from, command.to, (node) => {
      if (node.isInline) runs++;
      return !node.isInline;
    });
    if (runs > MAX_RUNS_PER_RANGE) throw invalid("That selection covers too many differently formatted pieces of text. Select a shorter passage.");
    const threadId = `c-${randomUUID()}`;
    const commentId = randomUUID();
    const w = windowOf(prose, command.from, command.to);
    let miniNext: PMNode;
    try {
      miniNext = new Transform(w.mini).addMark(command.from - w.offset, command.to - w.offset, schema.marks.comment!.create({ id: threadId, resolved: false })).doc;
      miniNext.check();
    } catch {
      throw invalid("A comment cannot be anchored on that selection.");
    }
    if (miniNext.eq(w.mini)) throw invalid("Select the text you want to comment on.");
    const quote = prose.textBetween(command.from, command.to, " ").slice(0, 200); // the editor's own thread quote
    const entry = item(text, commentId);
    const added = bytes(JSON.stringify({ id: threadId, quote, resolved: false, comments: [entry] })) + 16;
    commentBudget(doc, added, usage.comments);
    const growth = bytes(proseToHtml(miniNext)) - bytes(proseToHtml(w.mini));
    bodyBudget(doc, prose, growth, usage.body);
    return {
      result: { requestId: command.requestId, kind: "comment", threadId, commentId },
      nextProse: prose.replace(w.offset, w.end, new Slice(miniNext.content, 0, 0)),
      commit: (d) => {
        const t = new Y.Map<unknown>();
        t.set("id", threadId);
        t.set("quote", quote);
        t.set("resolved", false);
        const arr = new Y.Array<unknown>();
        arr.push([entry]);
        t.set("comments", arr);
        d.getMap("comments").set(threadId, t);
      },
      bodyBytes: Math.max(0, growth),
      commentBytes: added,
    };
  }

  // NP-CO-02: a page-level thread. Data only — a `comments` map entry marked
  // `page: true` with an empty quote; the body (and so the editor schema) is
  // untouched. Same budgets as an anchored thread.
  if (command.kind === "page-comment") {
    const text = command.text.trim();
    if (!text) throw invalid("Enter a comment.");
    const problem = textProblem(text, "comment");
    if (problem) throw invalid(problem);
    if (doc.share.has("comments") && doc.getMap("comments").size >= THREADS_PER_DOCUMENT) {
      throw new HumanCommandError(429, "too_many_threads", "This document has reached its limit of comment threads. Resolve and delete old threads first.");
    }
    const threadId = `c-${randomUUID()}`;
    const commentId = randomUUID();
    const entry = item(text, commentId);
    const added = bytes(JSON.stringify({ id: threadId, quote: "", page: true, resolved: false, comments: [entry] })) + 16;
    commentBudget(doc, added, usage.comments);
    return {
      result: { requestId: command.requestId, kind: "page-comment", threadId, commentId },
      nextProse: null,
      commit: (d) => {
        const t = new Y.Map<unknown>();
        t.set("id", threadId);
        t.set("quote", "");
        t.set("page", true);
        t.set("resolved", false);
        const arr = new Y.Array<unknown>();
        arr.push([entry]);
        t.set("comments", arr);
        d.getMap("comments").set(threadId, t);
      },
      bodyBytes: 0,
      commentBytes: added,
    };
  }

  const thread = doc.share.has("comments") ? getThread(doc, command.threadId) : undefined;
  if (!thread) throw new HumanCommandError(409, "thread_missing", "This comment thread no longer exists.");
  const items = thread.get("comments") as Y.Array<StoredComment> | undefined;

  if (command.kind === "reply") {
    const text = command.text.trim();
    if (!text) throw invalid("Enter a reply.");
    const problem = textProblem(text, "comment");
    if (problem) throw invalid(problem);
    if (!items) throw new HumanCommandError(409, "thread_missing", "This comment thread no longer exists.");
    if (items.length >= COMMENTS_PER_THREAD) {
      throw new HumanCommandError(409, "thread_full", "This thread has reached its limit of comments. Start a new thread.");
    }
    const commentId = randomUUID();
    const entry = item(text, commentId);
    const added = bytes(JSON.stringify(entry)) + 2;
    commentBudget(doc, added, usage.comments);
    return {
      result: { requestId: command.requestId, kind: "reply", threadId: command.threadId, commentId },
      nextProse: null,
      commit: () => items.push([entry]),
      bodyBytes: 0,
      commentBytes: added,
    };
  }

  if (command.kind === "resolve") {
    // Same rule as the shipped editor and the MCP tools: whoever may comment may
    // resolve or reopen ANY thread (it is reversible and removes nothing).
    return {
      result: { requestId: command.requestId, kind: "resolve", threadId: command.threadId, resolved: command.resolved },
      nextProse: null,
      commit: (d, origin) => setThreadResolved(d, command.threadId, command.resolved, origin),
      bodyBytes: 0,
      commentBytes: 0,
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
    bodyBytes: 0,
    commentBytes: 0,
  };
}

type ActorUsage = ReturnType<typeof collabActorUsage>;
const HOUSEKEEPING = new Set(["resolve", "delete-comment"]);

/**
 * Apply one command to a live document. Synchronous: no awaits, so the caller's
 * authorization check and this mutation cannot be interleaved with anything.
 * Returns the existing outcome for a known request id (no mutation).
 * Order: receipt → expiry → access → cheap limits (SQL counters) → revision
 * (cached hash) → planning (proportional to the touched blocks) → mutation.
 */
export function executeHumanCommand(doc: Y.Doc, ctx: HumanCommandContext, command: HumanCollabCommand): HumanCommandOutcome {
  const existing = findReceipt(ctx, command);
  if (existing) return existing;

  const now = ctx.now ?? Date.now();
  if (command.createdAt > now + FUTURE_SKEW_MS || command.createdAt < now - HUMAN_COLLAB_LIMITS.maxAgeMs) {
    throw new HumanCommandError(409, "expired", "This request is too old to submit. Review the current document and prepare the change again.");
  }
  if (!atLeast(ctx.level, "suggest")) throw new HumanCommandError(403, "forbidden", "Suggest access is required for this document.");

  pruneCollabReceipts(now - RECEIPT_RETENTION_MS, ctx.vaultId, ctx.noteId);
  const usage = collabActorUsage(ctx.vaultId, ctx.noteId, ctx.actor);
  if (HOUSEKEEPING.has(command.kind) ? usage.housekeeping >= HOUSEKEEPING_PER_ACTOR : usage.growing >= RECEIPTS_PER_ACTOR) {
    throw new HumanCommandError(429, "actor_request_limit", "You have made too many changes to this document in the last day. Try again later.");
  }
  if (countCollabReceipts(ctx.vaultId, ctx.noteId) >= RECEIPTS_PER_DOCUMENT) {
    throw new HumanCommandError(429, "document_request_limit", "This document has reached its limit of recent collaboration requests. Try again later.");
  }

  const snap = snapshotOf(doc);
  if (snap.revision !== command.revision) {
    throw new HumanCommandError(409, "stale_revision", "The document or its comments changed. Your draft is kept; select the current passage and review it before submitting again.");
  }
  const prose = snap.prose;
  const plan = command.kind === "suggest" ? planSuggest(doc, prose, command, ctx, usage) : planComment(prose, command, ctx, doc, now, usage);
  const sizeBefore = plan.bodyBytes > 0 ? renderedSize(doc, prose) : renderedSizeOf(doc);

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
      body_bytes: plan.bodyBytes,
      comment_bytes: plan.commentBytes,
    });
    doc.transact(() => {
      if (plan.nextProse) updateYFragment(doc, doc.getXmlFragment(FIELD), plan.nextProse, snap.meta as never);
      plan.commit(doc, origin);
    }, origin);
  })();
  if (sizeBefore !== undefined) setRenderedSize(doc, sizeBefore + plan.bodyBytes);
  return { result: plan.result, replayed: false, state: "applied" };
}

let lastGlobalPrune = 0;
/** Opportunistic retention sweep across all documents (at most hourly). */
export function pruneReceiptsIfDue(now = Date.now()): void {
  if (now - lastGlobalPrune < 60 * 60 * 1000) return;
  lastGlobalPrune = now;
  pruneCollabReceipts(now - RECEIPT_RETENTION_MS);
}

// ── lost and superseded commands ────────────────────────────────────────────

const parseResult = (row: UnconfirmedCollabReceipt): HumanCollabResult | null => {
  try {
    return JSON.parse(row.result) as HumanCollabResult;
  } catch {
    return null;
  }
};

/**
 * Is an unconfirmed command's change still in the document? Checked by
 * `storeDocumentState` right before it renders what it writes; a change a vault
 * fold has removed must not be confirmed.
 */
export function confirmableCommands(doc: Y.Doc, pending: UnconfirmedCollabReceipt[]): number[] {
  const prose = initProseMirrorDoc(doc.getXmlFragment(FIELD), collabSchema()).doc;
  const suggestions = new Set<string>();
  const anchors = new Set<string>();
  prose.descendants((node) => {
    for (const m of node.marks) {
      if (REVIEW_MARKS.has(m.type.name) && m.attrs.suggestionId) suggestions.add(String(m.attrs.suggestionId));
      if (m.type.name === "comment" && m.attrs.id) anchors.add(String(m.attrs.id));
    }
  });
  const threads = doc.share.has("comments") ? doc.getMap<Y.Map<unknown>>("comments") : null;
  const keep: number[] = [];
  const gone: UnconfirmedCollabReceipt[] = [];
  for (const row of pending) {
    const r = parseResult(row);
    const t = r?.threadId ? threads?.get(r.threadId) : undefined;
    const items = () => ((t?.get("comments") as Y.Array<StoredComment> | undefined)?.toArray() ?? []);
    const present =
      !r ? false
      : row.kind === "suggest" ? !!r.suggestionId && suggestions.has(r.suggestionId)
      : row.kind === "comment" ? !!t && anchors.has(r.threadId!) && items().some((c) => c?.id === r.commentId)
      : row.kind === "page-comment" ? !!t && items().some((c) => c?.id === r.commentId)
      : row.kind === "reply" ? !!t && items().some((c) => c?.id === r.commentId)
      : row.kind === "resolve" ? !!t && !!t.get("resolved") === !!r.resolved
      : row.kind === "delete-comment" ? !t && !anchors.has(r.threadId!)
      : false;
    if (present) keep.push(row.rowid);
    else gone.push(row);
  }
  if (gone.length) {
    undoLostCommands(doc, gone);
    deleteUnconfirmedCollabReceipts(gone.map((g) => g.rowid));
  }
  return keep;
}

/**
 * Remove what forgotten (never confirmed) commands left in a document — after a
 * reload from a half-saved snapshot (`loadDocumentState`), or when a store finds
 * a command's change partly removed by a vault fold (`confirmableCommands`). The
 * vault fold restores the body but not the `comments` map; this makes the two
 * agree again and returns the document to the PRE-command state where it can:
 *   suggest         reject that suggestion id (if its marks are still there)
 *   comment         remove the comment item it created; the thread (and its
 *                   anchor) go only if nobody else has replied — a thread that
 *                   holds other people's replies is kept, unanchored if the
 *                   fold removed the anchor (the sidebar shows it as such)
 *   page-comment    remove the comment item; the (unanchored) thread goes only
 *                   if nobody else has replied
 *   reply           remove that one comment item
 *   delete-comment  cannot be undone (the thread data is gone): strip the orphan
 *                   anchor so body and comments agree; the retry gets 409
 *   resolve         re-stamp the anchor to the thread's flag; the retry gets 409
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
  const removeItem = (items: Y.Array<StoredComment> | undefined, commentId: string | undefined) => {
    if (!items || !commentId) return;
    const at = items.toArray().findIndex((c) => c?.id === commentId);
    if (at >= 0) items.delete(at, 1);
  };
  doc.transact(() => {
    for (const row of [...lost].reverse()) {
      const r = parseResult(row);
      if (!r) continue;
      const threads = doc.share.has("comments") ? doc.getMap<Y.Map<unknown>>("comments") : null;
      if (row.kind === "suggest" && r.suggestionId) {
        const id = r.suggestionId;
        editFragment(doc, (d) => resolveOne(d, id, "reject"));
      } else if (row.kind === "comment" && r.threadId) {
        const t = threads?.get(r.threadId);
        const items = t?.get("comments") as Y.Array<StoredComment> | undefined;
        removeItem(items, r.commentId);
        if (!t || !items || items.length === 0) {
          threads?.delete(r.threadId);
          stripAnchor(r.threadId);
        }
      } else if (row.kind === "page-comment" && r.threadId) {
        // No anchor to strip: remove the item; the thread goes unless someone else replied.
        const t = threads?.get(r.threadId);
        const items = t?.get("comments") as Y.Array<StoredComment> | undefined;
        removeItem(items, r.commentId);
        if (!t || !items || items.length === 0) threads?.delete(r.threadId);
      } else if (row.kind === "reply" && r.threadId) {
        removeItem(threads?.get(r.threadId)?.get("comments") as Y.Array<StoredComment> | undefined, r.commentId);
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
setCommandEffectsCheck(confirmableCommands);
