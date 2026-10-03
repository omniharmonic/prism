/**
 * Collab-safe MCP tools (Architecture v2 WP6.3): comments, suggested edits,
 * spreadsheet ranges, and the live-document path of `prism_update_note`.
 *
 * These touch the shared Y.Doc directly (Hocuspocus `openDirectConnection`),
 * which the in-process gateway dispatch cannot reach — so they compute
 * permissions EXPLICITLY with `collabAccess`, a line-for-line mirror of the
 * collab socket's `resolveLevel` (effectiveLevel + effectiveCaps, role floor,
 * private-to-creator). Tests pin parity with `resolveLevel`. Every Yjs path ALSO
 * first reads the note through the gateway (`GET /api/notes/:id`), so an
 * unviewable or nonexistent note fails identically to every other tool, and
 * nothing about a doc (liveness, comments) leaks to a non-viewer.
 *
 * Permission rules — the socket's and the editor's (@prism/core collabAffordances):
 *  - read comments / read a sheet → view;
 *  - add / reply / resolve a comment, suggest an edit → the socket's WRITE level,
 *    i.e. ≥ suggest. COMMENT-LEVEL ACTORS MAY NOT COMMENT VIA MCP either: WP0.2
 *    made comments need suggest for humans (a comment is a Y.Doc write — its
 *    anchor is a mark in the body), and an agent must never be able to do what
 *    its own account cannot do in the editor. Resolve mirrors the editor too:
 *    anyone who may comment may resolve/reopen any thread.
 *  - content edits (update_note on a live doc, sheet_update) → edit.
 *
 * Writes use the transaction origin `mcp:<email>` and are persisted by the
 * normal Hocuspocus store path (disconnect() stores immediately), after which
 * the doc unloads if nobody else has it open.
 */
import * as z from "zod/v4";
import * as Y from "yjs";
import { effectiveCaps, effectiveLevel, atLeast, maxLevel, type Cap, type Level } from "../permissions";
import { roleFloor } from "../roles";
import {
  docNameFor,
  hocuspocus,
  isDocLive,
  noteKind,
  parseCsv,
  serializeCsv,
  SHEET_FIELD,
  markReconciled,
  type CollabKind,
} from "../collab";
import {
  CollabOpError,
  CollabConflictError,
  addCommentThread,
  colorFor,
  formatA1,
  getThread,
  gridOfRows,
  isAncestorState,
  listThreads,
  mergeContentIntoLive,
  parseA1,
  readGridRange,
  replyToThread,
  setGridCells,
  setThreadResolved,
  setYCells,
  suggestReplace,
  writeExtent,
  type CollabAuthor,
  type ThreadOut,
} from "../collab-ops";
import { getDocState, getUser } from "../db";
import { vaultClient, type Note } from "../parachute";
import type { UserActor } from "./auth";
import { canView, hasCapAnywhere } from "./access";
import { jsonOrToolError } from "./dispatch";
import { ToolError } from "./errors";
import { defineTool, type PrismTool, type ToolContext } from "./tools";

const enc = encodeURIComponent;
type NoteOut = Note & { _caps?: Cap[] };
const toMs = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

async function getJson<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  return jsonOrToolError<T>(await ctx.dispatch(path, init));
}

// ── permissions ─────────────────────────────────────────────────────────────

export interface CollabAccess {
  /** The level the collab SOCKET would grant this actor (null = no access). */
  level: Level | null;
  caps: Set<Cap>;
}

/**
 * The actor's standing on a note for Yjs writes — EXACTLY resolveLevel's rule
 * (collab.ts) for a signed-in user: effectiveLevel/effectiveCaps over the
 * actor's grants with its per-vault role floor and the private-to-creator
 * visibility check, projected onto the socket ladder.
 */
export function collabAccess(actor: Pick<UserActor, "grants" | "role" | "email">, note: Pick<Note, "id" | "tags" | "metadata">): CollabAccess {
  const noteRef = {
    id: note.id,
    tags: note.tags ?? [],
    creator: (note.metadata?.prism_creator as string | undefined) ?? null,
    visibility: (note.metadata?.prism_visibility === "private" ? "private" : "workspace") as "private" | "workspace",
  };
  const floor = roleFloor(actor.role);
  const lvl = effectiveLevel(actor.grants, noteRef, floor, actor.email);
  const caps = effectiveCaps(actor.grants, noteRef, floor, actor.email);
  if (lvl === "own") return { level: "own", caps };
  if (!caps.has("view")) return { level: null, caps };
  const level: Level = caps.has("edit")
    ? maxLevel(lvl, "edit")!
    : caps.has("suggest")
      ? maxLevel(lvl, "suggest")!
      : caps.has("comment")
        ? maxLevel(lvl, "comment")!
        : (lvl ?? "view");
  return { level, caps };
}

type Need = "view" | "suggest" | "edit";
const NEED_MESSAGE: Record<Need, string> = {
  view: "you do not have access to that",
  suggest: "this needs suggest access or higher on the note (comments and suggested edits are writes to the shared document — the same rule as the editor)",
  edit: "this needs edit access on the note",
};

interface Target {
  note: NoteOut;
  kind: CollabKind;
  docName: string;
  access: CollabAccess;
}

/** Gateway view gate first (uniform forbidden/not_found), then the explicit socket-level check. */
async function target(ctx: ToolContext, id: string, need: Need, contentChange = need === "edit"): Promise<Target> {
  const note = await getJson<NoteOut>(ctx, `/api/notes/${enc(id)}`);
  const access = collabAccess(ctx.principal.actor, note);
  if (!atLeast(access.level, need)) throw new ToolError("forbidden", NEED_MESSAGE[need]);
  // A locked page: comments stay open, content changes (cells, suggested edits) do not.
  if (contentChange && note.metadata?.prism_locked === true) throw new ToolError("conflict", "this page is locked — unlock it before changing its content", { locked: true });
  const kind = noteKind({ path: note.path ?? null, tags: note.tags ?? null, metadata: note.metadata ?? null, content: note.content });
  return { note, kind, docName: docNameFor(ctx.principal.actor.vaultId, note.id), access };
}

const originOf = (ctx: ToolContext) => `mcp:${ctx.principal.actor.email}`;

/** Attribution in the editor's own vocabulary: display name (or email) + " (agent)". */
function authorOf(ctx: ToolContext): CollabAuthor {
  const email = ctx.principal.actor.email;
  const name = getUser(email)?.name?.trim() || email;
  return { name: `${name} (agent)`, color: colorFor(email), actorId: email, turnId: ctx.principal.agentTurnId };
}

/**
 * Open (loading/seeding if needed) the note's shared doc, run `fn`, then
 * disconnect — which stores immediately through the normal onStoreDocument path
 * and unloads the doc if no one else has it open.
 */
async function withDoc<T>(ctx: ToolContext, docName: string, fn: (doc: Y.Doc) => T | Promise<T>): Promise<T> {
  const conn = await hocuspocus.openDirectConnection(docName, { mcp: ctx.principal.actor.email });
  try {
    if (!conn.document) throw new ToolError("upstream_error", "the document could not be opened");
    return await fn(conn.document);
  } finally {
    await conn.disconnect();
  }
}

const requireDocument = (t: Target) => {
  if (t.kind !== "document") throw new ToolError("invalid_request", `comments and suggested edits exist only on document notes (this note is a ${t.kind})`);
};

const opError = (e: unknown): never => {
  if (e instanceof CollabConflictError) throw new ToolError("conflict", e.message);
  if (e instanceof CollabOpError) throw new ToolError("invalid_request", e.message);
  throw e;
};

// ── live content write (prism_update_note's collab path) ───────────────────

/**
 * Apply a full-content replace to a note that is LIVE in the collab server.
 *
 * `if_updated_at` semantics on a live doc (documented in docs/mcp-access.md):
 *  1. It must equal the vault's current updatedAt — exactly as on the REST path
 *     (someone persisted a change since your read → `conflict`, re-read).
 *  2. The live doc's persisted snapshot must correspond to that same vault
 *     version (it is the merge BASE — the state your read reflects). If the live
 *     doc is still folding in a very recent external change, the call is refused
 *     with `conflict` + `detail.retry` rather than guessing a base.
 *  3. Edits people typed in the live doc AFTER that snapshot (not yet saved) are
 *     NOT a conflict: your change is merged three-way against the base, so their
 *     edits survive and yours lands next to them (same-span overlaps merge as two
 *     concurrent editors would).
 */
export async function liveContentWrite(ctx: ToolContext, id: string, content: string, ifUpdatedAt: string): Promise<{ note: NoteOut; changed: boolean }> {
  const t = await target(ctx, id, "edit");
  const { vaultId } = ctx.principal.actor;
  let changed = false;
  await withDoc(ctx, t.docName, async (live) => {
    // Fresh vault read AFTER the doc is pinned open (not the gateway's cached copy).
    const cur = await vaultClient(vaultId).getNote(t.note.id);
    if (toMs(cur.updatedAt) !== toMs(ifUpdatedAt) || !toMs(ifUpdatedAt)) {
      throw new ToolError("conflict", "the note changed since you read it — re-read it (prism_get_note), re-apply your change, and retry with the new updatedAt as if_updated_at", {
        id: cur.id,
        updatedAt: cur.updatedAt ?? null,
      });
    }
    // ── synchronous from here: no store can interleave with the merge ──
    const snap = getDocState(t.note.id, vaultId);
    if (!snap || snap.sourceUpdatedAt !== toMs(cur.updatedAt) || !isAncestorState(snap.state, live)) {
      throw new ToolError(
        "conflict",
        "the live document is still absorbing a very recent change, so there is no safe merge base for your edit yet — wait a few seconds, re-read, and retry",
        { live: true, retry: true },
      );
    }
    try {
      changed = mergeContentIntoLive(live, snap.state, t.kind, content, originOf(ctx));
    } catch (e) {
      opError(e);
    }
  });
  const note = await getJson<NoteOut>(ctx, `/api/notes/${enc(t.note.id)}`);
  return { note, changed };
}

/**
 * After a metadata/tag/path-only write to a LIVE note: tell the reconciler the
 * new vault version carries no new content, so it does not fold the (content-
 * stale) vault copy back over unsaved human typing. Safe no-op otherwise.
 */
export function afterLiveMetaWrite(ctx: ToolContext, noteId: string, prevUpdatedAt: string, nextUpdatedAt: string | null | undefined): void {
  const { vaultId } = ctx.principal.actor;
  if (!isDocLive(vaultId, noteId)) return;
  markReconciled(docNameFor(vaultId, noteId), toMs(prevUpdatedAt), toMs(nextUpdatedAt));
}

// ── tools ───────────────────────────────────────────────────────────────────

const idField = z.string().min(1).max(200).describe("Note id (as returned by prism_query_notes / prism_get_note)");
const TEXT_MAX = 10_000;
const CELLS_MAX = 10_000;
const canWriteShared = (p: Parameters<typeof hasCapAnywhere>[0]) => hasCapAnywhere(p, "suggest", "edit");

export const listCommentsTool = defineTool({
  name: "prism_list_comments",
  scope: "read",
  title: "List comment threads",
  description:
    "List the comment threads on a document note (the same threads the editor's sidebar shows): id, quoted text, resolved, " +
    "whether the anchor text still exists, and each comment's author/text/time. Unresolved only unless include_resolved=true. Needs view.",
  inputSchema: z.object({ id: idField, include_resolved: z.boolean().optional() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canView,
  async handler({ id, include_resolved }, ctx) {
    const t = await target(ctx, id, "view");
    requireDocument(t);
    const includeResolved = include_resolved === true;
    // Read-only: use the live doc if loaded, else the persisted CRDT snapshot — never load/seed a doc to read it.
    const live = hocuspocus.documents.get(t.docName) as Y.Doc | undefined;
    let threads: ThreadOut[];
    if (live) {
      threads = listThreads(live, includeResolved);
    } else {
      const snap = getDocState(t.note.id, ctx.principal.actor.vaultId);
      if (!snap) {
        threads = [];
      } else {
        const scratch = new Y.Doc();
        Y.applyUpdate(scratch, snap.state);
        threads = listThreads(scratch, includeResolved);
        scratch.destroy();
      }
    }
    return { threads, count: threads.length };
  },
});

export const addCommentTool = defineTool({
  name: "prism_add_comment",
  scope: "write",
  title: "Comment on a document",
  description:
    "Add a comment to a document note, exactly as a person would in the editor. Either `quote` (start a NEW thread anchored on " +
    "the first occurrence of that exact text — within one paragraph) or `thread_id` (reply to an existing, unresolved thread). " +
    "Attributed to your account, marked as an agent. Needs suggest access or higher (the editor's rule: comment-only access " +
    "cannot write to the shared document). Works whether or not anyone has the document open.",
  inputSchema: z.object({
    id: idField,
    text: z.string().min(1).max(TEXT_MAX).describe("The comment"),
    quote: z.string().min(1).max(1000).optional().describe("Exact text to anchor a new thread on (first occurrence)"),
    thread_id: z.string().min(1).max(200).optional().describe("Reply to this thread instead (from prism_list_comments)"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  access: canWriteShared,
  async handler({ id, text, quote, thread_id }, ctx) {
    if ((quote === undefined) === (thread_id === undefined)) throw new ToolError("invalid_request", "give exactly one of `quote` (new thread) or `thread_id` (reply)");
    const t = await target(ctx, id, "suggest");
    requireDocument(t);
    const who = authorOf(ctx);
    const threadId = await withDoc(ctx, t.docName, (doc) => {
      try {
        if (thread_id !== undefined) {
          const th = getThread(doc, thread_id);
          if (!th) throw new ToolError("not_found", "no such comment thread on this note");
          if (th.get("resolved")) throw new ToolError("invalid_request", "that thread is resolved — reopen it with prism_resolve_comment first");
          replyToThread(doc, thread_id, text, who, originOf(ctx));
          return thread_id;
        }
        const r = addCommentThread(doc, quote!, text, who, originOf(ctx));
        if (!r) throw new ToolError("invalid_request", "the quoted text was not found in the document (it must match exactly, within one paragraph)");
        return r.threadId;
      } catch (e) {
        return opError(e);
      }
    });
    return { ok: true, id: t.note.id, thread_id: threadId, reply: thread_id !== undefined };
  },
});

export const resolveCommentTool = defineTool({
  name: "prism_resolve_comment",
  scope: "write",
  title: "Resolve or reopen a comment thread",
  description:
    "Resolve (resolved=true, default) or reopen (resolved=false) a comment thread on a document note — clears or restores its " +
    "highlight for everyone, as the editor's Resolve button does. Needs suggest access or higher (anyone who may comment may resolve).",
  inputSchema: z.object({ id: idField, thread_id: z.string().min(1).max(200), resolved: z.boolean().optional() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: canWriteShared,
  async handler({ id, thread_id, resolved }, ctx) {
    const t = await target(ctx, id, "suggest");
    requireDocument(t);
    const want = resolved !== false;
    await withDoc(ctx, t.docName, (doc) => {
      if (!getThread(doc, thread_id)) throw new ToolError("not_found", "no such comment thread on this note");
      try {
        setThreadResolved(doc, thread_id, want, originOf(ctx));
      } catch (e) {
        opError(e);
      }
    });
    return { ok: true, id: t.note.id, thread_id, resolved: want };
  },
});

export const suggestEditTool = defineTool({
  name: "prism_suggest_edit",
  scope: "write",
  title: "Suggest an edit (tracked change)",
  description:
    "Propose a change to a document note as a tracked suggestion, the way a suggester does in the editor: a unique occurrence " +
    "of `find` (exact text, within one paragraph) is marked for deletion and `replace` is inserted after it, both attributed to " +
    "your account (as an agent). Nothing changes until a reviewer accepts it. Empty `replace` suggests a pure deletion. Needs " +
    "suggest access or higher. Repeated quotes and overlaps with pending suggestions return a conflict; reread before retrying. Prefer this over prism_update_note when you only hold suggest, or on a busy shared document.",
  inputSchema: z.object({
    id: idField,
    find: z.string().min(1).max(TEXT_MAX).describe("Exact unique existing text to replace; include enough context to identify one passage"),
    replace: z.string().max(TEXT_MAX).describe("Replacement text (may be empty)"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  access: canWriteShared,
  async handler({ id, find, replace }, ctx) {
    const t = await target(ctx, id, "suggest", true);
    requireDocument(t);
    const who = authorOf(ctx);
    let suggestionId: string | undefined;
    await withDoc(ctx, t.docName, (doc) => {
      let r;
      try {
        r = suggestReplace(doc, find, replace, who, originOf(ctx));
      } catch (e) {
        opError(e);
      }
      if (!r) throw new ToolError("invalid_request", "`find` was not found in the document (it must match exactly, within one paragraph)");
      suggestionId = r.suggestionId;
    });
    return { ok: true, id: t.note.id, suggestion_id: suggestionId, suggested_by: who.name };
  },
});

const requireSheet = (t: Target) => {
  if (t.kind !== "spreadsheet") throw new ToolError("invalid_request", `this note is a ${t.kind}, not a spreadsheet`);
};

const rangeField = z.string().min(2).max(20).describe('A1 notation: a cell ("B2") or a rectangle ("A1:C3")');

export const sheetReadTool = defineTool({
  name: "prism_sheet_read",
  scope: "read",
  title: "Read spreadsheet cells",
  description:
    "Read cells from a spreadsheet note. `range` in A1 notation (\"B2\", \"A1:C3\"); omit it for the whole sheet. Cells beyond " +
    "the data read as \"\". Reads the live document when someone has it open, else the saved note. At most 10,000 cells. Needs view.",
  inputSchema: z.object({ id: idField, range: rangeField.optional() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canView,
  async handler({ id, range }, ctx) {
    const t = await target(ctx, id, "view");
    requireSheet(t);
    const live = hocuspocus.documents.get(t.docName) as Y.Doc | undefined;
    const grid = live ? gridOfRows(live.getArray<Y.Array<string>>(SHEET_FIELD)) : parseCsv(t.note.content ?? "");
    const rows = grid.length;
    const cols = Math.max(0, ...grid.map((r) => r.length));
    let r;
    try {
      r = range ? parseA1(range) : { r1: 0, c1: 0, r2: Math.max(0, rows - 1), c2: Math.max(0, cols - 1), anchor: false };
    } catch (e) {
      return opError(e);
    }
    let truncated = false;
    const width = r.c2 - r.c1 + 1;
    if (width > CELLS_MAX) throw new ToolError("invalid_request", `range too wide (max ${CELLS_MAX} cells)`);
    if ((r.r2 - r.r1 + 1) * width > CELLS_MAX) {
      r = { ...r, r2: r.r1 + Math.floor(CELLS_MAX / width) - 1 };
      truncated = true;
    }
    return {
      id: t.note.id,
      range: formatA1(r.r1, r.c1, r.r2, r.c2),
      values: readGridRange(grid, r),
      sheet: { rows, cols },
      live: !!live,
      updatedAt: t.note.updatedAt ?? null,
      ...(truncated ? { truncated: true } : {}),
    };
  },
});

export const sheetUpdateTool = defineTool({
  name: "prism_sheet_update",
  scope: "write",
  title: "Write spreadsheet cells",
  description:
    "Write cells in a spreadsheet note. `range` is A1: a single cell (\"B2\") anchors `values` at its top-left, a rectangle " +
    "(\"A1:C3\") must match `values`' shape exactly. The sheet grows as needed. Cell-level: other cells — including ones people " +
    "are editing right now in the live document — are untouched. Cells cannot contain commas or line breaks (simple CSV). " +
    "`if_updated_at` is optional: pass it to refuse the write if the note changed since your read. Needs edit.",
  inputSchema: z.object({
    id: idField,
    range: rangeField,
    values: z.array(z.array(z.string().max(TEXT_MAX)).min(1)).min(1).describe("Rows of cell strings"),
    if_updated_at: z.string().min(1).optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: (p) => hasCapAnywhere(p, "edit"),
  async handler({ id, range, values, if_updated_at }, ctx) {
    const cellCount = values.reduce((n, r) => n + r.length, 0);
    if (cellCount > CELLS_MAX) throw new ToolError("invalid_request", `too many cells (max ${CELLS_MAX})`);
    const t = await target(ctx, id, "edit");
    requireSheet(t);
    let ext;
    try {
      ext = writeExtent(parseA1(range), values);
    } catch (e) {
      return opError(e);
    }
    const written = formatA1(ext.r1, ext.c1, ext.r2, ext.c2);
    const stale = (cur: string | null | undefined) =>
      new ToolError("conflict", "the note changed since you read it — re-read it and retry with the new updatedAt as if_updated_at", { id: t.note.id, updatedAt: cur ?? null });

    if (isDocLive(ctx.principal.actor.vaultId, t.note.id)) {
      let changed = 0;
      await withDoc(ctx, t.docName, async (doc) => {
        if (if_updated_at !== undefined) {
          const cur = await vaultClient(ctx.principal.actor.vaultId).getNote(t.note.id);
          if (toMs(cur.updatedAt) !== toMs(if_updated_at)) throw stale(cur.updatedAt);
        }
        doc.transact(() => {
          changed = setYCells(doc.getArray<Y.Array<string>>(SHEET_FIELD), ext.r1, ext.c1, values);
        }, originOf(ctx));
      });
      const after = await getJson<NoteOut>(ctx, `/api/notes/${enc(t.note.id)}`);
      return { ok: true, id: t.note.id, range: written, cellsChanged: changed, live: true, updatedAt: after.updatedAt ?? null };
    }

    // Not live: read-modify-write the CSV through the gateway, guarded by if_updated_at
    // (the caller's, else the version we just read — so a concurrent write is never lost).
    if (if_updated_at !== undefined && toMs(t.note.updatedAt) !== toMs(if_updated_at)) throw stale(t.note.updatedAt);
    const grid = setGridCells(parseCsv(t.note.content ?? ""), ext.r1, ext.c1, values);
    const guard = if_updated_at ?? t.note.updatedAt;
    if (!guard) throw new ToolError("upstream_error", "the note has no updatedAt to guard the write with");
    let updated: NoteOut;
    try {
      updated = await getJson<NoteOut>(ctx, `/api/notes/${enc(t.note.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ content: serializeCsv(grid), if_updated_at: guard }),
      });
    } catch (e) {
      if (e instanceof ToolError && e.code === "conflict" && !(e.detail && typeof e.detail === "object" && "reason" in e.detail)) throw stale(null);
      throw e;
    }
    return { ok: true, id: t.note.id, range: written, live: false, updatedAt: updated.updatedAt ?? null };
  },
});

/** The WP6.3 collab tools, in catalog order. */
export const COLLAB_TOOLS = [
  listCommentsTool,
  addCommentTool,
  resolveCommentTool,
  suggestEditTool,
  sheetReadTool,
  sheetUpdateTool,
] as unknown as PrismTool[];
