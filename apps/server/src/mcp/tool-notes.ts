/**
 * Core note tools (Architecture v2 WP6.2) + the `prism://note/{id}` resource.
 *
 * EVERYTHING goes through `ctx.dispatch("/api/…")` — the gateway's own route
 * handlers, run in-process as the caller's actor — so caps, anti-escalation,
 * private-note rules and `_caps` annotation are the web app's, never
 * re-implemented here. Nothing in this file touches `vaultClient`.
 *
 * `access()` is the EARLY, cosmetic gate (hide tools the principal could never
 * use): "does any grant/role give this cap somewhere?". The per-note decision is
 * always the gateway's.
 *
 * Two gateway shapes differ and are bridged here (not in the gateway):
 *  - OWNER/ADMIN requests are a transparent vault passthrough: the vault's own
 *    PATCH takes `tags: {add, remove}`, its list ignores nothing, and there is no
 *    `_caps` on the response. Non-owners hit the allowlisted handlers: PATCH takes
 *    `add_tags`/`remove_tags`, lists ignore `tag`/`path_prefix`/`limit` (so they
 *    are applied here), and notes carry `_caps`.
 *  - Text search is `GET /api/search` for non-owners but `GET /api/notes?search=`
 *    for the passthrough (the vault has no /search route).
 */
import { shapeMetadata } from "../vault-shapes";
import * as z from "zod/v4";
import { ConversionError, htmlToMarkdown } from "../convert/service";
import { CAPS, atLeast, effectiveCaps, type Cap } from "../permissions";
import { roleFloor } from "../roles";
import { hasLiveState, isDocLive, noteKind, settleUnsaved, unsavedPermanentReason, unsavedReasonText, type CollabKind } from "../collab";
import type { Note } from "../parachute";
import { canView, hasCapAnywhere, isAdmin } from "./access";
import { jsonOrToolError } from "./dispatch";
import { ToolError, isStaleConflict } from "./errors";
import { afterLiveMetaWrite, collabAccess, liveContentWrite } from "./tool-collab";
import { settleKeyForUser, takeUnsavedSettle } from "../unsaved-settle";
import { isTrashed } from "@prism/core/pages";
import { defineTool, type PrismResource, type PrismTool, type ToolContext } from "./tools";

// ── bounds ──────────────────────────────────────────────────────────────────
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
/** include_content in a LIST is a preview, never the whole body. */
const LIST_CONTENT_CHARS = 2_000;
/** Single-note reads are bounded too; `contentTruncated` says so. */
const NOTE_CONTENT_CHARS = 100_000;
const TAGS_MAX = 1_000;

// ── shared helpers ──────────────────────────────────────────────────────────
const enc = encodeURIComponent;
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

type NoteOut = Note & { _caps?: Cap[] };

async function getJson<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  return jsonOrToolError<T>(await ctx.dispatch(path, init));
}

/** The caps the caller holds on a fetched note (the gateway stamps `_caps` for non-owners; the owner passthrough does not). */
function capsOf(ctx: ToolContext, note: NoteOut): Cap[] {
  if (Array.isArray(note._caps)) return note._caps;
  const { actor } = ctx.principal;
  const meta = note.metadata ?? {};
  const caps = effectiveCaps(
    actor.grants,
    {
      id: note.id,
      tags: note.tags ?? [],
      creator: (meta.prism_creator as string | undefined) ?? null,
      visibility: meta.prism_visibility === "private" ? "private" : "workspace",
      path: note.path ?? null,
    },
    roleFloor(actor.role),
    actor.email,
  );
  return CAPS.filter((c) => caps.has(c));
}

const clip = (s: string | null | undefined, max: number) => {
  const str = typeof s === "string" ? s : "";
  return str.length > max ? { text: str.slice(0, max), truncated: true, length: str.length } : { text: str, truncated: false, length: str.length };
};

/** A lean list row; content only when asked, and then only a preview. */
function listRow(n: NoteOut, includeContent: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: n.id,
    path: n.path ?? null,
    tags: n.tags ?? [],
    createdAt: n.createdAt,
    updatedAt: n.updatedAt ?? null,
  };
  if (n._caps) row._caps = n._caps;
  if (includeContent) {
    const c = clip(n.content, LIST_CONTENT_CHARS);
    row.content = c.text;
    row.contentLength = c.length;
    if (c.truncated) row.contentTruncated = true;
  }
  return row;
}

const hasTag = (n: Note, tag: string) => (n.tags ?? []).some((t) => t === tag || t.startsWith(`${tag}/`));
const byUpdatedDesc = (a: Note, b: Note) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "");

/**
 * A page whose live-editor changes can NEVER be written as they are (a permanent
 * `collab_unsaved` row). Not "wait a few seconds": no amount of retrying changes
 * it, and the agent must be told so (detail.retry === false).
 */
function unsavedForGood(reason: string): ToolError {
  return new ToolError(
    "conflict",
    `this page has changes from the live editor that cannot be saved to the stored note (${unsavedReasonText(reason)}), so its content cannot be changed from here. ` +
      "Do NOT retry: waiting will not help. Someone has to open the page and make it smaller, or the workspace owner has to discard the unsaved live changes; tell the user.",
    { live: true, retry: false, permanent: true, reason },
  );
}

/** Fetch the note (view gate) and refuse a CONTENT write while its Yjs doc is live. */
async function assertNotLive(ctx: ToolContext, id: string, verb: string): Promise<void> {
  const note = await getJson<NoteOut>(ctx, `/api/notes/${enc(id)}`); // 403/404 here first: liveness is never an oracle for non-viewers
  const forGood = unsavedPermanentReason(ctx.principal.actor.vaultId, note.id);
  if (forGood) throw unsavedForGood(forGood);
  // Live = loaded, or holding live-editor changes that have not reached the vault yet.
  if (hasLiveState(ctx.principal.actor.vaultId, note.id)) {
    throw new ToolError(
      "conflict",
      `this note is open in live collaborative editing (or still saving changes from it), so ${verb} is refused to avoid racing the live document. ` +
        "Wait until no one has it open and retry — or read the version (prism_get_version) and write its content with " +
        "prism_update_note, which merges into the live document.",
      { live: true },
    );
  }
}

/** On a stale-`if_updated_at` conflict, hand the agent the note's CURRENT timestamp (never the body). */
async function withConflictHint<T>(ctx: ToolContext, id: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    // Only a STALE-token conflict gets the re-read hint — a path conflict (etc.) keeps its own message.
    if (isStaleConflict(e)) {
      let current: unknown = undefined;
      try {
        const n = await getJson<NoteOut>(ctx, `/api/notes/${enc(id)}`);
        current = { id: n.id, updatedAt: n.updatedAt ?? null };
      } catch {
        /* the hint is best-effort */
      }
      throw new ToolError("conflict", "the note changed since you read it — re-read it (prism_get_note), re-apply your change, and retry with the new updatedAt as if_updated_at", current);
    }
    throw e;
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

const idField = z.string().min(1).max(200).describe("Note id (as returned by prism_query_notes / prism_get_note)");
const ifUpdatedAt = z.string().min(1).describe("REQUIRED optimistic-concurrency token: the note's `updatedAt` from your latest prism_get_note. Stale → conflict error; re-read and retry.");

export const queryNotesTool = defineTool({
  name: "prism_query_notes",
  scope: "read",
  title: "List or search notes",
  description:
    "List or search the notes YOU may see (your Prism permissions apply; notes you cannot view never appear). Filter by tag " +
    "(includes child tags), path prefix, and/or a full-text `search`. Rows are lean (id, path, tags, timestamps, your `_caps` " +
    "when known); set include_content=true for a 2,000-char content preview per row — fetch the whole note with prism_get_note. " +
    "Newest first, limit ≤ 200 (default 50).",
  inputSchema: z.object({
    tag: z.string().min(1).optional().describe("Only notes carrying this tag (or a child tag)"),
    search: z.string().min(1).optional().describe("Full-text search"),
    path_prefix: z.string().min(1).optional().describe("Only notes whose path starts with this"),
    limit: z.number().int().min(1).max(LIST_MAX).optional(),
    include_content: z.boolean().optional().describe("Include a truncated content preview (default false)"),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canView,
  async handler(args, ctx) {
    const limit = args.limit ?? LIST_DEFAULT;
    const includeContent = args.include_content === true;
    let notes: NoteOut[];
    if (isAdmin(ctx.principal)) {
      // Transparent vault passthrough: the vault applies every filter itself.
      const sp = new URLSearchParams({ limit: String(limit) });
      if (includeContent) sp.set("include_content", "true");
      if (args.tag) sp.set("tag", args.tag);
      if (args.search) sp.set("search", args.search);
      if (args.path_prefix) sp.set("path_prefix", args.path_prefix);
      notes = await getJson<NoteOut[]>(ctx, `/api/notes?${sp}`);
    } else {
      // The gateway returns everything the actor may view (no server-side filters) — narrow here.
      notes = args.search
        // /api/search (wave 2E) takes q ≤ 200 chars and returns ≤ 100 rows per call.
        ? await getJson<NoteOut[]>(ctx, `/api/search?${new URLSearchParams({ q: args.search.slice(0, 200), limit: String(Math.min(100, limit * 4)) })}`)
        : await getJson<NoteOut[]>(ctx, `/api/notes?include_content=${includeContent}`);
      if (args.tag) notes = notes.filter((n) => hasTag(n, args.tag!));
      if (args.path_prefix) notes = notes.filter((n) => (n.path ?? "").startsWith(args.path_prefix!));
      if (!args.search) notes.sort(byUpdatedDesc);
    }
    // Trashed pages are hidden unless the caller asks for the trash tag explicitly.
    if (args.tag !== "prism-trashed") notes = notes.filter((n) => !(n.tags ?? []).includes("prism-trashed"));
    const total = notes.length;
    const page = notes.slice(0, limit);
    return {
      notes: page.map((n) => listRow(n, includeContent)),
      count: page.length,
      truncated: total > page.length,
    };
  },
});

export const getNoteTool = defineTool({
  name: "prism_get_note",
  scope: "read",
  title: "Read a note",
  description:
    "Read one note by id: content, metadata, tags, path, your capabilities on it (`_caps`), and `collab: {kind, live}` — " +
    "its editor kind (document|code|spreadsheet|canvas) and whether someone has it open for live editing right now. " +
    "Use the returned `updatedAt` as `if_updated_at` for prism_update_note / prism_restore_version. LONG NOTES: read the " +
    "body in pages — pass `content_length` (characters per call, e.g. 24000) and, on later calls, `content_offset` = the " +
    "`contentNextOffset` you were given, until `contentNextOffset` is null; `contentLength` is the whole body's size. " +
    "Without `content_length`, content over 100,000 characters is truncated (`contentTruncated`). Needs view on the note.",
  inputSchema: z.object({
    id: idField,
    content_offset: z.number().int().min(0).optional().describe("Start of the content page, in characters (default 0). Use the previous call's contentNextOffset."),
    content_length: z.number().int().min(1000).max(NOTE_CONTENT_CHARS).optional().describe("Characters of content to return in this call. Use 24000 for long notes and follow contentNextOffset."),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canView,
  async handler({ id, content_offset, content_length }, ctx) {
    const note = await getJson<NoteOut>(ctx, `/api/notes/${enc(id)}`);
    const paged = content_offset !== undefined || content_length !== undefined;
    return shapeNote(ctx, note, paged ? { offset: content_offset ?? 0, length: content_length ?? NOTE_PAGE_CHARS } : undefined);
  },
});

/** Default page when a caller pages without saying how much: small enough that the whole tool
 *  result stays under the ~50 KB above which the Claude CLI saves a result to a file the
 *  agent (no Read tool) cannot open. */
const NOTE_PAGE_CHARS = 24_000;

/** One page of a body. Never splits a surrogate pair; `next` is null on the last page. */
export function contentPage(content: string | null | undefined, offset: number, length: number): { text: string; offset: number; next: number | null; total: number } {
  const body = content ?? "";
  let start = Math.min(Math.max(0, offset), body.length);
  if (start > 0 && start < body.length && isLowSurrogate(body.charCodeAt(start))) start--;
  let end = Math.min(body.length, start + length);
  if (end < body.length && isLowSurrogate(body.charCodeAt(end))) end--;
  return { text: body.slice(start, end), offset: start, next: end < body.length ? end : null, total: body.length };
}
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

function shapeNote(ctx: ToolContext, note: NoteOut, page?: { offset: number; length: number }): Record<string, unknown> {
  const kind: CollabKind = noteKind({ path: note.path ?? null, tags: note.tags ?? null, metadata: note.metadata ?? null, content: note.content });
  if (page) {
    const pg = contentPage(note.content, page.offset, page.length);
    return {
      id: note.id,
      path: note.path ?? null,
      tags: note.tags ?? [],
      // Metadata rides only with the first page: it does not change between pages.
      ...(pg.offset === 0 ? { metadata: note.metadata ?? {} } : {}),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt ?? null,
      content: pg.text,
      contentLength: pg.total,
      contentOffset: pg.offset,
      contentNextOffset: pg.next,
      _caps: capsOf(ctx, note),
      collab: { kind, live: isDocLive(ctx.principal.actor.vaultId, note.id) },
    };
  }
  const c = clip(note.content, NOTE_CONTENT_CHARS);
  return {
    id: note.id,
    path: note.path ?? null,
    tags: note.tags ?? [],
    metadata: note.metadata ?? {},
    createdAt: note.createdAt,
    updatedAt: note.updatedAt ?? null,
    content: c.text,
    contentLength: c.length,
    ...(c.truncated ? { contentTruncated: true } : {}),
    _caps: capsOf(ctx, note),
    collab: { kind, live: isDocLive(ctx.principal.actor.vaultId, note.id) },
  };
}

export const semanticSearchTool = defineTool({
  name: "prism_semantic_search",
  scope: "read",
  title: "Semantic search",
  description:
    "Meaning-based (embedding + full-text fusion) search over notes you may view; results carry a score and snippet. " +
    "Search is isolated to this credential’s vault and your current note permissions. limit ≤ 50 (default 20).",
  inputSchema: z.object({ query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(50).optional() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canView,
  async handler({ query, limit }, ctx) {
    const res = await ctx.dispatch(`/api/search/semantic?${new URLSearchParams({ q: query, limit: String(limit ?? 20) })}`);
    if (res.status === 409) {
      throw new ToolError("invalid_request", "semantic search is unavailable for this credential’s vault; reconnect to an available vault");
    }
    if (res.status === 502) throw new ToolError("upstream_error", "semantic search is temporarily unavailable — use prism_query_notes with `search`");
    const hits = await jsonOrToolError<Array<NoteOut & { _score?: number; _snippet?: string }>>(res);
    return {
      results: hits.map((h) => ({ ...listRow(h, false), score: h._score ?? null, snippet: clip(h._snippet, 500).text })),
      count: hits.length,
    };
  },
});

export const createNoteTool = defineTool({
  name: "prism_create_note",
  scope: "write",
  title: "Create a note",
  description:
    "Create a note. You need the `create` capability on the note's tags (an editor of a tag may create inside it); a tagless " +
    "note needs a whole-vault grant. `tags` decide who can see the note, so choose them deliberately — you cannot place a note " +
    "in an area you have no standing in. Returns the created note (with its id and updatedAt).",
  inputSchema: z.object({
    content: z.string().describe("Note body (Markdown or plain text)"),
    path: z.string().min(1).optional().describe("Optional vault path, e.g. projects/foo/notes"),
    tags: z.array(z.string().min(1)).describe("Tags for the note (may be empty only if you hold a whole-vault create grant)"),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  access: (p) => hasCapAnywhere(p, "create"),
  async handler({ content, path, tags, metadata }, ctx) {
    // Shape guard (vault-shapes.ts) HERE, not only at the vault client: an owner/admin
    // principal's write leaves through the passthrough, which forwards bodies untouched.
    // This body is built by the tool, so shaping it changes no client's bytes.
    const shaped = metadata === undefined ? undefined : shapeMetadata(metadata, tags, "create");
    const created = await getJson<NoteOut>(ctx, "/api/notes", { method: "POST", ...json({ content, path, tags, metadata: shaped }) });
    return { ...listRow(created, false), metadata: created.metadata ?? {} };
  },
});

export const updateNoteTool = defineTool({
  name: "prism_update_note",
  scope: "write",
  title: "Update a note",
  description:
    "Update a note. `if_updated_at` is REQUIRED (the `updatedAt` from your latest prism_get_note); if the note changed since, " +
    "the call fails with `conflict` — re-read, re-apply, retry. Give any of: content (replaces the body; needs edit), metadata " +
    "(merged; needs edit), path and add_tags/remove_tags (need organize). If the note is open in live collaborative editing " +
    "(prism_get_note collab.live), a content change is MERGED into the live document (only what you changed is applied, so " +
    "edits people are typing elsewhere survive; spreadsheets change cell by cell, canvases element by element). A live " +
    "document may briefly answer `conflict` with detail.retry while it absorbs a very recent change — wait, re-read, retry. " +
    "Previous states stay in version history (prism_list_versions).",
  inputSchema: z.object({
    id: idField,
    if_updated_at: ifUpdatedAt,
    content: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional().describe("Keys to merge into metadata (null deletes a key)"),
    add_tags: z.array(z.string().min(1)).optional(),
    remove_tags: z.array(z.string().min(1)).optional(),
    path: z.string().min(1).optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  access: (p) => hasCapAnywhere(p, "edit", "organize"),
  async handler(a, ctx) {
    const hasTags = (a.add_tags?.length ?? 0) > 0 || (a.remove_tags?.length ?? 0) > 0;
    if (a.content === undefined && a.metadata === undefined && a.path === undefined && !hasTags) {
      throw new ToolError("invalid_request", "nothing to update — provide content, metadata, path, add_tags or remove_tags");
    }
    let ifUpdatedAt = a.if_updated_at;
    let noteId = a.id;
    let merged: { live: true; changed: boolean } | undefined;
    /** The note's stored tags, when this call happened to read the note (content writes). */
    let knownTags: string[] | undefined;
    if (a.content !== undefined) {
      const note = await getJson<NoteOut>(ctx, `/api/notes/${enc(a.id)}`); // view gate first: liveness is never an oracle
      noteId = note.id;
      knownTags = note.tags ?? undefined;
      // A locked page refuses content for EVERY principal (owners unlock it first).
      if (note.metadata?.prism_locked === true) throw new ToolError("conflict", "this page is locked — unlock it before editing its content", { locked: true });
      // A note that is not loaded but holds unsaved live state is first given the chance to be
      // written; one that cannot be opened live at all is fixed over REST (the only way).
      const { vaultId } = ctx.principal.actor;
      // …and one whose live changes can never be written is not merged into either: the merge
      // would land in a document the stored note will never reflect (the agent would be told
      // "merged" and read back an unchanged note, forever).
      // Settling LOADS the document and STORES it (a conversion, a vault write). Only someone
      // who could make this write may set that off — `edit` on THIS note (the tool's own gate
      // is "edit somewhere"; a viewer of this page gets the gateway's refusal below with
      // nothing loaded and nothing said about its unsaved state) — and only within the same
      // per-account bucket as the gateway's body writes (review M-1).
      const mayEdit = atLeast(collabAccess(ctx.principal.actor, note).level, "edit") && !isTrashed(note);
      let settled: Awaited<ReturnType<typeof settleUnsaved>> | null = null;
      if (mayEdit && !isDocLive(vaultId, note.id) && hasLiveState(vaultId, note.id)) {
        const forGoodAlready = unsavedPermanentReason(vaultId, note.id);
        if (forGoodAlready) throw unsavedForGood(forGoodAlready);
        if (takeUnsavedSettle(settleKeyForUser(ctx.principal.actor.email)) !== null) {
          throw new ToolError("conflict", "this page has changes that are still being saved from the live editor — wait a minute, re-read the note and try again", { live: true, retry: true });
        }
        settled = await settleUnsaved(vaultId, note.id);
      }
      const forGood = mayEdit ? unsavedPermanentReason(vaultId, note.id) : null;
      if (forGood) throw unsavedForGood(forGood);
      const viaLive = mayEdit && (isDocLive(vaultId, note.id) || settled === "pending");
      if (viaLive) {
        // WP6.3: a live doc takes the change through Yjs (three-way merge), never a vault overwrite.
        // The same goes for a note whose live changes have not reached the vault yet: its stored
        // body is stale, so the write goes through the document (which is loaded for it).
        const r = await liveContentWrite(ctx, note.id, a.content, a.if_updated_at);
        merged = { live: true, changed: r.changed };
        const rest = a.metadata !== undefined || a.path !== undefined || hasTags;
        if (!rest) return { ...listRow(r.note, false), metadata: r.note.metadata ?? {}, collab: merged };
        // The rest (metadata/path/tags) goes through the gateway against the version our merge produced.
        ifUpdatedAt = r.note.updatedAt ?? a.if_updated_at;
      }
    }
    const content = merged ? undefined : a.content;
    // A path change is a MOVE (security review C1): it goes through the pages route
    // (POST /api/notes/:id/move), which checks the destination, the whole subtree and
    // page-share exposure — never a bare PATCH. Everything else is PATCHed first.
    const wantsOther = content !== undefined || a.metadata !== undefined || hasTags;
    // The owner/admin passthrough speaks the vault's PATCH dialect; everyone else the gateway's.
    // Metadata passes the shape guard here as well (see prism_create_note): the note's own
    // tags when this call read it, plus the tags being added — else the by-name rules only.
    const shapeTags = knownTags || a.add_tags?.length ? [...(knownTags ?? []), ...(a.add_tags ?? [])] : undefined;
    const metadata = a.metadata === undefined ? undefined : shapeMetadata(a.metadata, shapeTags, "update");
    const body: Record<string, unknown> = { content, metadata, if_updated_at: ifUpdatedAt };
    if (isAdmin(ctx.principal)) {
      if (hasTags) body.tags = { add: a.add_tags ?? [], remove: a.remove_tags ?? [] };
    } else {
      body.add_tags = a.add_tags;
      body.remove_tags = a.remove_tags;
    }
    let updated: NoteOut | null = null;
    if (wantsOther || a.path === undefined) {
      updated = await withConflictHint(ctx, a.id, () => getJson<NoteOut>(ctx, `/api/notes/${enc(a.id)}`, { method: "PATCH", ...json(body) }));
      // A metadata/tag-only write to a LIVE note: keep the reconciler from folding
      // the (content-unchanged) vault copy back over unsaved human typing.
      if (content === undefined) afterLiveMetaWrite(ctx, updated.id ?? noteId, ifUpdatedAt, updated.updatedAt);
    }
    if (a.path !== undefined) {
      const current = updated ?? (await getJson<NoteOut>(ctx, `/api/notes/${enc(a.id)}`));
      if (current.path !== a.path) {
        const res = await getJson<{ ok?: boolean; error?: string; reason?: string }>(ctx, `/api/notes/${enc(current.id ?? a.id)}/move`, {
          method: "POST",
          ...json({ newPath: a.path, if_updated_at: updated ? updated.updatedAt : ifUpdatedAt }),
        });
        if (res.ok !== true) throw new ToolError("conflict", res.reason ?? "the move did not complete — re-read the note and retry");
        updated = await getJson<NoteOut>(ctx, `/api/notes/${enc(current.id ?? a.id)}`);
      } else updated = current;
    }
    const final = updated!;
    return { ...listRow(final, false), metadata: final.metadata ?? {}, ...(merged ? { collab: merged } : {}) };
  },
});

export const deleteNoteTool = defineTool({
  name: "prism_delete_note",
  scope: "write",
  title: "Delete a note",
  description:
    "Permanently delete a note. Allowed only for the note's creator with edit access, or holders of the `delete` capability " +
    "(owners/admins always). Not undoable from here — confirm with the user first.",
  inputSchema: z.object({ id: idField }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  access: (p) => hasCapAnywhere(p, "delete", "edit"),
  async handler({ id }, ctx) {
    await getJson(ctx, `/api/notes/${enc(id)}`, { method: "DELETE" });
    return { ok: true, id };
  },
});

export const listTagsTool = defineTool({
  name: "prism_list_tags",
  scope: "read",
  title: "List tags",
  description: "List the tags (with note counts) you may see. Non-admins see only tags they hold a grant on.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canView,
  async handler(_a, ctx) {
    const raw = await getJson<Array<{ tag?: string; name?: string; count: number }>>(ctx, "/api/tags");
    const tags = raw.map((t) => ({ tag: t.tag ?? t.name ?? "", count: t.count }));
    return { tags: tags.slice(0, TAGS_MAX), count: Math.min(tags.length, TAGS_MAX), truncated: tags.length > TAGS_MAX };
  },
});

export const listVersionsTool = defineTool({
  name: "prism_list_versions",
  scope: "read",
  title: "List a note's versions",
  description:
    "List prior versions of a note, newest first (version_ix, timestamp, op, size — no content). Needs view on the live note. " +
    "Read one with prism_get_version; roll back with prism_restore_version.",
  inputSchema: z.object({ id: idField, limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canView,
  async handler({ id, limit, offset }, ctx) {
    const sp = new URLSearchParams({ limit: String(limit ?? 50), offset: String(offset ?? 0) });
    return { ...(await getJson<Record<string, unknown>>(ctx, `/api/notes/${enc(id)}/versions?${sp}`)) };
  },
});

export const getVersionTool = defineTool({
  name: "prism_get_version",
  scope: "read",
  title: "Read a note version",
  description: "Read one prior version of a note (content + metadata as they were). Content over 100,000 characters is truncated. Needs view on the live note.",
  inputSchema: z.object({ id: idField, version_ix: z.number().int().min(0) }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canView,
  async handler({ id, version_ix }, ctx) {
    const v = await getJson<Record<string, unknown> & { content?: string | null }>(ctx, `/api/notes/${enc(id)}/versions/${version_ix}`);
    const c = clip(v.content, NOTE_CONTENT_CHARS);
    return { ...v, content: c.text, contentLength: c.length, ...(c.truncated ? { contentTruncated: true } : {}) };
  },
});

export const restoreVersionTool = defineTool({
  name: "prism_restore_version",
  scope: "write",
  title: "Restore a note version",
  description:
    "Roll a note back to a prior version (the current state is kept in history). Needs edit on the note and REQUIRES " +
    "`if_updated_at` (the note's current updatedAt). Refused if the version would change who can see the note, and — like content " +
    "updates — while the note is open in live collaborative editing.",
  inputSchema: z.object({ id: idField, version_ix: z.number().int().min(0), if_updated_at: ifUpdatedAt }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  access: (p) => hasCapAnywhere(p, "edit"),
  async handler({ id, version_ix, if_updated_at }, ctx) {
    await assertNotLive(ctx, id, "a restore");
    const restored = await withConflictHint(ctx, id, () =>
      getJson<NoteOut>(ctx, `/api/notes/${enc(id)}/restore`, { method: "POST", ...json({ version_ix, if_updated_at }) }),
    );
    return { ...listRow(restored, false), restoredFrom: version_ix };
  },
});

/** The v1 core note tools (WP6.2), in catalog order. */
export const NOTE_TOOLS = [
  queryNotesTool,
  getNoteTool,
  semanticSearchTool,
  createNoteTool,
  updateNoteTool,
  deleteNoteTool,
  listTagsTool,
  listVersionsTool,
  getVersionTool,
  restoreVersionTool,
] as unknown as PrismTool[];

// ── resource: prism://note/{id} ─────────────────────────────────────────────

/** Collab persists document notes as HTML; vault-native ones are already Markdown. */
const looksLikeHtml = (s: string) => /^\s*<[a-z][a-z0-9-]*[\s>/]/i.test(s);

export const noteResource: PrismResource = {
  name: "prism-note",
  uriTemplate: "prism://note/{id}",
  title: "Prism note",
  description:
    "A note you may view: Markdown for document notes (HTML converted), raw content for code/spreadsheet/canvas notes. " +
    "The second content block is JSON metadata: id, path, tags, updatedAt, your `_caps`, and the collab kind.",
  mimeType: "text/markdown",
  cacheHint: { ttlMs: 0, cacheScope: "private" },
  access: canView,
  async read(uri, vars, ctx) {
    const raw = Array.isArray(vars.id) ? vars.id[0] : vars.id;
    if (!raw || raw.length > 200) throw new ToolError("not_found", "not found");
    const id = decodeURIComponent(raw);
    const note = await getJson<NoteOut>(ctx, `/api/notes/${enc(id)}`);
    const shaped = shapeNote(ctx, note);
    const kind = (shaped.collab as { kind: CollabKind }).kind;
    // `shaped.content` is ALREADY capped (NOTE_CONTENT_CHARS): only that much is
    // ever converted, and the conversion runs in the worker under a time limit.
    const body = String(shaped.content);
    const isDoc = kind === "document";
    let text = body;
    let unconverted: string | null = null;
    if (isDoc && looksLikeHtml(body)) {
      try {
        text = await htmlToMarkdown(body, { actor: `user:${ctx.principal.actor.email.toLowerCase()}` });
      } catch (e) {
        if (!(e instanceof ConversionError)) throw e;
        // Deterministic fallback: the stored body as it is, and a note saying so.
        unconverted = e.reason;
        text = `<!-- prism: this note's HTML could not be converted to Markdown (${e.reason}); the stored HTML follows unchanged -->\n${body}`;
      }
    }
    const { content: _c, ...rest } = shaped;
    const meta = unconverted ? { ...rest, contentFormat: "html", contentUnconverted: unconverted } : rest;
    return [
      { uri: uri.href, mimeType: unconverted ? "text/html" : isDoc ? "text/markdown" : "text/plain", text },
      { uri: `${uri.href}#metadata`, mimeType: "application/json", text: JSON.stringify(meta, null, 2) },
    ];
  },
};

export const NOTE_RESOURCES: PrismResource[] = [noteResource];
