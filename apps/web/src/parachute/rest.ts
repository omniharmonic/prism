/**
 * Low-level Parachute REST client for the browser. The single source of HTTP
 * truth: both the typed `HttpVaultClient` (the VaultClient seam) and the
 * `invoke` shim (the long tail of direct calls in @prism/core) delegate here.
 *
 * Mirrors the Rust `ParachuteClient` (apps/desktop/src-tauri/src/clients/
 * parachute.rs). Parachute 0.5.x returns camelCase note JSON, so notes pass
 * through nearly untouched.
 */
import type {
  Note,
  NoteFilters,
  NoteTreeEntry,
  CreateNoteParams,
  UpdateNoteParams,
  TagCount,
  VaultStats,
  VaultInfo,
  VaultLink,
  VaultGraph,
  VaultNeighborhood,
  PeoplePage,
  PersonSummary,
  PersonPage,
  SemanticHit,
  NoteVersion,
  NoteVersionPage,
} from "@prism/core/shell";
import { VaultRequestError, HistoryUnavailableError, HistoryConflictError, PropertyConflictError, toNoteVersion } from "@prism/core/shell";
import type { QueryPage, QuerySpec, SchemaMap, SchemaPatch, TagSchema, PropertyWriteResult } from "@prism/core/shell";
import { filtersToParams, type SearchFilters } from "@prism/core/search";
import type { PropertyBatchItem, PropertyBatchResult, CsvImportRequest, CsvImportResponse, RemoveValuesResult } from "@prism/core/database";
import { agentScope, apiBase, DEFAULT_VAULT_NAME, capabilityHeader, contextHeaders, getMe } from "../config";
import { retainDraft, enqueue, hasPending, hasPendingFor, noteKey, currentBase, flush, localNote, resolveLocalNoteId, retrySafe, queuedCreates } from "../offline/outbox";
import { captureWriteContext, scopeKey } from "../offline/writeScope";
import { serverFetch } from "../transport";
import { readThrough, reconcileCachedNotes } from "../offline/readCache";

// Auth rides the httpOnly session cookie (PWA) or a device bearer token (native
// build) via serverFetch (../transport); the browser
// holds no vault token. Capability-link recipients (no session) additionally
// send Authorization: Capability <token>; the gateway authorizes either way.
// contextHeaders() names the active vault + workspace (owner switch; empty = default).
const jsonHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...capabilityHeader(),
  ...contextHeaders(),
});

/** GETs worth keeping for offline reads: notes (single + lists + graph), tags, vault info. */
const cacheable = (method: string, path: string): boolean =>
  method === "GET" && /^\/(notes|tags|vault|tree)(\/|\?|$)/.test(path) && !path.includes("search=");

async function req(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  // Snapshot both cache identity and request headers together. Never store an
  // old in-flight response under the newly selected account/vault's cache key.
  const context = await captureWriteContext().catch(() => null);
  const url = `${context?.scope.api ?? apiBase()}${path}`;
  const headers = { ...(context?.headers ?? jsonHeaders()), ...(init?.headers as Record<string, string>) };
  const doFetch = () => serverFetch(url, { ...init, headers });
  const resp = context && init?.cache !== "no-store" && cacheable(method, path)
    ? await readThrough(`${scopeKey(context.scope)}|${path}`, doFetch) : await doFetch();
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new VaultRequestError(resp.status, `${init?.method ?? "GET"} ${path} failed: ${resp.status} ${body}`);
  }
  return resp;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function nowISO(): string {
  return new Date().toISOString();
}

const isOffline = () => typeof navigator !== "undefined" && !navigator.onLine;

/** Audience-bound gate for workflows which must distinguish local acceptance
 * from server confirmation (for example moving a task or configuring a view). */
export async function hasPendingWrites(): Promise<boolean> {
  return hasPending(await captureWriteContext());
}
/** The same, for ONE note (e.g. "may this page be locked now?"). */
export async function hasPendingWritesFor(noteId: string): Promise<boolean> {
  return hasPendingFor(await captureWriteContext(), noteId);
}

/**
 * Mutation whose JSON response we return (create/update note). When offline or
 * the fetch fails with a network error, queue it in the outbox and resolve with
 * an optimistic copy so the editor proceeds; it replays on reconnect. HTTP
 * errors (4xx/5xx) still throw.
 */
/** A write Prism will not queue: it needs the server's answer (rename, move, delete). */
export class OfflineRefusedError extends VaultRequestError {
  constructor(message: string) {
    super(0, message);
    this.name = "OfflineRefusedError";
  }
}
/** Refuse with a clear message and a toast (shown by OfflineIndicator). Nothing is queued. */
function refuse(message: string): never {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("prism:offline-refused", { detail: { message } }));
  throw new OfflineRefusedError(message);
}
const refuseOffline = (action: string): never => refuse(`You’re offline. ${action} needs a connection — reconnect and try again.`);

/**
 * WHAT QUEUES, WHAT RETRIES, WHAT REFUSES (wave 2E re-review):
 *  - QUEUED offline and RETRIED automatically (backoff) when the server does not
 *    answer or answers 5xx/429: content saves guarded by a base revision (one
 *    row per note), metadata merges (`kind: "meta"`, per-key with the pre-edit
 *    value), tag/link deltas, and creates (idempotent through
 *    `metadata.prism_client_op`). A duplicate delivery of any of them is
 *    recognised, never applied twice.
 *  - QUEUED FOR REVIEW, never re-sent blindly: a content save with NO base
 *    revision (the text is kept; nothing is overwritten).
 *  - REFUSED (an error + toast, nothing queued, never an optimistic success):
 *    rename/move, delete, and every other write — whether the browser is
 *    offline or the server is unreachable / answering 5xx.
 *  - A stuck row holds back only its own note; a write to a note with rows
 *    waiting queues behind them.
 */
function queueable(method: string, path: string, body: unknown): boolean {
  if (method === "POST" && path === "/notes") return true;
  if (method !== "PATCH" || !/^\/notes\/[^/?]+$/.test(path)) return false;
  const patch = (body ?? {}) as Record<string, unknown>;
  if ("path" in patch) return false;
  if ("content" in patch) return true; // text is never dropped: guarded → retried, unguarded → kept for review
  if ("metadata" in patch) return typeof patch.if_updated_at === "string";
  return true; // tag / link deltas
}
/** May a write the server did not acknowledge be sent again automatically? */
function retryable(method: string, path: string, bodyStr: string): boolean {
  return retrySafe({ method, path, body: bodyStr });
}

async function writeJson<T>(method: string, path: string, body: unknown, optimistic: () => T, temporaryId?: string, expectedScope?: string): Promise<T> {
  const assertAudience = () => { if (expectedScope !== undefined && agentScope() !== expectedScope) throw new VaultRequestError(403, "Workspace changed before this draft could be sent."); };
  assertAudience();
  const context = await captureWriteContext();
  assertAudience();
  const bodyStr = JSON.stringify(body);
  const canQueue = queueable(method, path, body);
  if (!canQueue && isOffline()) refuseOffline("This change");
  if (canQueue && (isOffline() || path.includes("/offline-") || await hasPendingFor(context, noteKey({ method, path, temporaryId })))) {
    await enqueue(method, path, bodyStr, context, { temporaryId });
    if (!isOffline()) void flush();
    return optimistic();
  }
  // The server did not answer, or answered 5xx/429: a retry-safe write waits in
  // the outbox and is re-sent with backoff; an unguarded content save is kept
  // for review; everything else FAILS — it is never reported as done.
  const unanswered = async (status: number): Promise<T> => {
    if (canQueue && retryable(method, path, bodyStr)) {
      await enqueue(method, path, bodyStr, context, { temporaryId, retry: true });
      return optimistic();
    }
    if (canQueue) {
      await enqueue(method, path, bodyStr, context, { unknown: true, temporaryId });
      return optimistic();
    }
    throw new VaultRequestError(status, status ? `${method} ${path} failed: ${status}` : "The server could not be reached. Nothing was changed — try again in a moment.");
  };
  let resp: Response;
  try {
    resp = await serverFetch(`${context.scope.api}${path}`, { method, headers: context.headers, body: bodyStr });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return unanswered(0);
  }
  if (!resp.ok) {
    if (resp.status >= 500 || resp.status === 429) return unanswered(resp.status);
    throw new VaultRequestError(resp.status, `${method} ${path} failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  }
  try {
    const text = await resp.text();
    return text ? JSON.parse(text) as T : optimistic();
  } catch {
    // The write landed; only its body was unreadable.
    return optimistic();
  }
}

/** Online failures with an uncertain outcome are kept for review, never retried blindly. */
async function mutate<T>(method: string, path: string, body: unknown, result: () => T): Promise<T> {
  return writeJson(method, path, body, result);
}

// ---- notes ----------------------------------------------------------------

export async function listNotes(filters?: NoteFilters): Promise<Note[]> {
  const query = qs({
    limit: filters?.limit ?? 50000,
    sort: "desc",
    tag: filters?.tag,
    path: filters?.path,
    offset: filters?.offset,
  });
  return (await req(`/notes${query}`)).json();
}

export async function resolveWikilink(target: string): Promise<{kind:"match"|"ambiguous"|"none";candidates:Array<{id:string;path:string|null;title:string}>}> {
  return (await req(`/wikilinks/resolve${qs({target})}`)).json();
}

/** The lean row `GET /api/tree` returns (server projection, WP7.1). */
interface TreeRow {
  id: string;
  path: string | null;
  tags: string[];
  updatedAt: string | null;
  type?: string;
  prismType?: string;
  order?: number;
  icon?: string;
  title?: string;
  aliases?: string[];
}

/** The metadata keys a tree row carries (null when it has none). */
function treeMetadata(r: TreeRow): Record<string, unknown> | null {
  const m: Record<string, unknown> = {};
  if (r.type) m.type = r.type;
  if (r.prismType) m.prism_type = r.prismType;
  if (r.order !== undefined) m.prism_order = r.order;
  if (r.icon) m.icon = r.icon;
  // What `[[` / `@` page suggestions match besides the path name.
  if (r.title) m.title = r.title;
  if (r.aliases?.length) m.aliases = r.aliases;
  return Object.keys(m).length ? m : null;
}

/**
 * The file tree. Served by the gateway's in-memory projection (`/tree`: a few
 * hundred KB gzipped, ETag-revalidated by the browser) instead of a ~16 MB
 * full-vault list. Falls back to the legacy list against an older server that
 * predates the endpoint (404 via the vault, or 403 from the old catch-all).
 */
/** Last fresh tree for the offline prefetcher: note id → server `updatedAt`. */
export const treeStamps: { scope: string | null; rows: Map<string, string> } = { scope: null, rows: new Map() };

export async function listTree(): Promise<NoteTreeEntry[]> {
  try {
    const context = await captureWriteContext().catch(() => null);
    const resp = await req(`/tree`);
    const rows = (await resp.json()) as TreeRow[];
    // A FRESH tree is the server's current statement of what this account can
    // see: evict cached pages it no longer lists (review M4) and remember each
    // page's revision so the offline prefetcher only re-reads what changed.
    if (context && resp.headers.get("x-prism-cache") !== "hit") {
      treeStamps.scope = scopeKey(context.scope);
      treeStamps.rows = new Map(rows.map((r) => [r.id, r.updatedAt ?? ""]));
      void reconcileCachedNotes(treeStamps.scope, new Set(rows.map((r) => r.id)));
    }
    const entries: NoteTreeEntry[] = rows.map((r) => ({
      id: r.id,
      path: r.path,
      tags: r.tags,
      updatedAt: r.updatedAt,
      // Only the keys the tree reads: type inference, sibling order, the page's emoji,
      // and the title + aliases page suggestions match.
      metadata: treeMetadata(r),
    }));
    // Pages created on this device and not yet confirmed are part of the tree:
    // they show in the sidebar and their paths are taken (a second offline
    // "New page" becomes "Untitled (2)", not a colliding create).
    if (context) {
      const known = new Set(entries.map((e) => e.path));
      for (const draft of await queuedCreates(context.scope).catch(() => [])) if (!known.has(draft.path)) entries.push(draft);
    }
    return entries;
  } catch (e) {
    if (!/ failed: (404|403) /.test((e as Error).message)) throw e;
    return (await req(`/notes${qs({ limit: 50000, sort: "desc" })}`)).json();
  }
}

export async function getNote(id: string, options?: { fresh?: boolean; latest?: boolean }): Promise<Note> {
  const resolved = await resolveLocalNoteId(id);
  if (resolved.startsWith("offline-")) {
    const draft = await localNote(resolved);
    if (!draft) throw new Error("This local draft is unavailable in the current workspace.");
    return draft;
  }
  // `reload` sends `Cache-Control: no-cache` (the gateway then skips its reuse window) and,
  // unlike `no-store`, still goes through the device read cache (written on success, used offline).
  const resp = await req(`/notes/${encodeURIComponent(resolved)}`, options?.fresh ? { cache: "no-store" } : options?.latest ? { cache: "reload" } : undefined);
  const note = await resp.json() as Note;
  const merged = await localNote(resolved, note).catch(() => note) ?? note;
  // Served from this device's copy (no connection): say so, with when it was saved (NP-OF-02).
  if (resp.headers.get("x-prism-cache") === "hit") {
    const stored = Number(resp.headers.get("x-prism-cache-stored"));
    return { ...merged, _offlineCopyAt: Number.isFinite(stored) && stored > 0 ? new Date(stored).toISOString() : (merged.updatedAt ?? null) } as Note;
  }
  return merged;
}

export async function createNote(params: CreateNoteParams): Promise<Note> {
  const temporaryId = `offline-${crypto.randomUUID()}`;
  // Named fields only: the gateway refuses any other key on a non-owner create
  // (strict schema), and callers reach this through untyped shims (`vault_create_note`).
  // Every create carries a client operation id (a plain metadata key the server
  // stores like any other). If the acknowledgement is lost, the outbox finds the
  // page by path + this id and adopts it instead of creating a second one.
  const body: CreateNoteParams = {
    content: params.content ?? "",
    metadata: { ...(params.metadata ?? {}), prism_client_op: crypto.randomUUID() },
  };
  if (params.path != null) body.path = params.path;
  if (params.tags != null) body.tags = params.tags;
  params = body;
  return writeJson("POST", `/notes`, body, () => ({
    id: temporaryId,
    content: params.content,
    path: params.path ?? null,
    metadata: params.metadata ?? null,
    tags: params.tags ?? null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }), temporaryId);
}

export async function updateNote(id: string, params: UpdateNoteParams, options?: { expectedScope?: string }): Promise<Note> {
  // Translate camelCase ifUpdatedAt → the API's snake_case contract, and inject
  // force:true when no precondition is supplied (vault 0.4.0+ requires one).
  const body: Record<string, unknown> = {};
  if (params.content !== undefined) body.content = params.content;
  if (params.path !== undefined) body.path = params.path;
  if (params.metadata !== undefined) body.metadata = params.metadata;
  if (params.ifUpdatedAt !== undefined) body.if_updated_at = params.ifUpdatedAt;
  if (params.path !== undefined) {
    if (isOffline()) refuseOffline("Renaming or moving a page");
    // Unsent changes for this page go first; a rename is never queued behind them
    // and never answered optimistically.
    const context = await captureWriteContext();
    if (await hasPendingFor(context, id)) {
      await flush();
      if (await hasPendingFor(context, id)) refuse("This page has changes that haven’t reached the server yet. Rename or move it once they’re saved.");
    }
  }
  if (typeof body.if_updated_at === "string") {
    const context = await captureWriteContext().catch(() => null);
    if (context) body.if_updated_at = currentBase(context.scope, id, body.if_updated_at);
  }
  // A metadata-only write with no base revision is a per-key MERGE. Online it
  // goes out as before; offline (or behind queued rows for this note) it is
  // queued as a mergeable row — never as `force`, which used to park it as a
  // conflict and block the queue (review H3).
  const metaMerge = body.if_updated_at === undefined && params.metadata !== undefined && params.content === undefined && params.path === undefined;
  if (body.if_updated_at === undefined) body.force = true;
  if (metaMerge) {
    const context = await captureWriteContext();
    if (isOffline() || id.startsWith("offline-") || await hasPendingFor(context, id)) {
      if (options?.expectedScope !== undefined && agentScope() !== options.expectedScope) throw new VaultRequestError(403, "Workspace changed before this draft could be sent.");
      await queueMetadata(id, params.metadata!, context);
      if (!isOffline()) void flush();
      const local = await getNote(id).catch(() => null);
      return local ?? { id, content: "", path: null, metadata: params.metadata ?? null, tags: null, createdAt: nowISO(), updatedAt: nowISO() };
    }
  }
  return writeJson("PATCH", `/notes/${encodeURIComponent(id)}`, body, () => ({
    id,
    content: params.content ?? "",
    path: params.path ?? null,
    metadata: params.metadata ?? null,
    tags: null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    // Not a server revision: the write is queued. Editors keep their own base (H1).
    _queued: true,
  } as Note), undefined, options?.expectedScope);
}

/**
 * Queue a metadata merge with each key's PRE-EDIT value, so the replay is a
 * per-key compare-and-set: a value someone changed meanwhile goes to review
 * instead of being overwritten (review M3). A nested value (a database's views,
 * a dashboard layout, a board's config) is one object to the vault — replaying
 * an offline snapshot of it would replace other people's changes wholesale, so
 * those edits need a connection.
 */
async function queueMetadata(id: string, set: Record<string, unknown>, context: Awaited<ReturnType<typeof captureWriteContext>>, expect?: Record<string, unknown>): Promise<void> {
  if (Object.values(set).some((v) => v !== null && typeof v === "object" && !Array.isArray(v))) refuseOffline("Changing this view or layout");
  const before = expect ? null : await getNote(id).catch(() => null);
  const pre = expect ?? Object.fromEntries(Object.keys(set).map((k) => [k, before?.metadata?.[k] ?? null]));
  await enqueue("PATCH", `/notes/${encodeURIComponent(id)}`, JSON.stringify({ metadata: set }), context, { kind: "meta", expect: before || expect ? pre : undefined });
}

export async function preserveDraft(id: string, content: string, audience: string, reason: "access" | "conflict" = "access"): Promise<void> {
  const value: unknown = JSON.parse(audience);
  if (!Array.isArray(value) || value.length !== 4 || !value.every(part => typeof part === "string" && part.length > 0 && part.length < 4096)) throw Error("Draft audience unavailable");
  const [api, workspace, vault, email] = value as string[];
  const url = new URL(api);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw Error("Draft server unavailable");
  await retainDraft(id, content, { api, workspace, vault, actor: `user:${email}` }, reason);
}

export async function deleteNote(id: string): Promise<void> {
  // Never queue a delete: the tree would keep showing a page that is "gone".
  // (An unreachable server or a 5xx is a failure too — writeJson never queues or fakes a DELETE.)
  if (isOffline()) refuseOffline("Deleting a page");
  await mutate("DELETE", `/notes/${encodeURIComponent(id)}`, undefined, () => {});
}

export async function batchDelete(
  ids: string[],
): Promise<{ deleted: number; failed: number; total: number }> {
  let deleted = 0;
  let failed = 0;
  // Bounded concurrency to avoid hammering the vault.
  const CHUNK = 20;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const results = await Promise.allSettled(ids.slice(i, i + CHUNK).map((id) => deleteNote(id)));
    for (const r of results) r.status === "fulfilled" ? deleted++ : failed++;
  }
  return { deleted, failed, total: ids.length };
}

export async function search(query: string, tags?: string[], limit = 50): Promise<Note[]> {
  const sp = new URLSearchParams({ search: query, limit: String(limit), include_content: "true" });
  for (const t of tags ?? []) sp.append("tag", t);
  return (await req(`/notes?${sp.toString()}`)).json();
}

/** Filtered full-text search with match offsets (`GET /api/search`, wave 2E).
 *  Lean rows: no bodies, a server-built snippet instead. An older server that
 *  has no such route for this actor answers 404/405/501 → `null` (caller falls back). */
export async function searchNotes(query: string, filters: SearchFilters = {}, limit = 50): Promise<Note[] | null> {
  const sp = filtersToParams(filters, new URLSearchParams({ q: query.slice(0, 200), limit: String(limit), lean: "1" }));
  try {
    // Vault scope (NP-SR-04): another vault is named by header; the server
    // re-resolves the caller's role and grants for THAT vault. Never cached.
    const rows = (await (await req(`/search?${sp.toString()}`, filters.vault ? { headers: { "X-Prism-Vault": filters.vault }, cache: "no-store" } : undefined)).json()) as Note[];
    return filters.vault ? rows.map((n) => ({ ...n, _vault: filters.vault })) : rows;
  } catch (error) {
    if (error instanceof VaultRequestError && [404, 405, 501].includes(error.status)) return null;
    throw error;
  }
}

/**
 * Which identity filters ("Created by me" / "Edited by me") the search can answer for THIS
 * viewer. The server does both filters (`author=me` = creator, `editor=me` = last editor; the
 * client never narrows rows itself — after the server's 100-row cap that would drop results).
 * A share-link viewer has no "me": neither. An older server (no `/search/filters`) knows no
 * `editor=` and would silently ignore it: "Edited by me" is not offered.
 */
export async function searchFilterSupport(): Promise<{ createdBy: boolean; editedBy: boolean }> {
  if (Object.keys(capabilityHeader()).length || !getMe()) return { createdBy: false, editedBy: false };
  try {
    const body = (await (await req("/search/filters", { cache: "no-store" })).json()) as { filters?: unknown; identity?: unknown };
    const filters = Array.isArray(body.filters) ? body.filters : [];
    const identity = body.identity === true;
    return { createdBy: identity && filters.includes("author"), editedBy: identity && filters.includes("editor") };
  } catch (error) {
    if (error instanceof VaultRequestError && [401, 403, 404, 405, 501].includes(error.status)) return { createdBy: true, editedBy: false };
    throw error;
  }
}

/** Hybrid semantic search via the server's RAG service (dense + full-text,
 *  fused). Returns notes enriched with `_score` and a `_snippet`. */
export async function semanticSearch(query: string, limit = 20): Promise<SemanticHit[]> {
  const sp = new URLSearchParams({ q: query, limit: String(limit) });
  return (await req(`/search/semantic?${sp.toString()}`)).json();
}

// ---- version history (vault ≥ 0.7.9) ---------------------------------------
// Straight through for the owner; the gateway authorizes everyone else (view to
// read, edit to restore). No offline queueing — a restore must never be replayed
// later against a note that moved on.

async function historyReq(path: string, init?: RequestInit): Promise<Response> {
  const resp = await serverFetch(`${apiBase()}${path}`, {
    ...init,
   
    headers: { ...jsonHeaders(), ...(init?.headers as Record<string, string>) },
  });
  if (resp.ok) return resp;
  // A 0.6.x vault has no /versions route: it 404s even for a note that exists.
  if (resp.status === 404 && path.endsWith("/versions")) throw new HistoryUnavailableError();
  if (resp.status === 409 || resp.status === 428) throw new HistoryConflictError();
  const body = await resp.text().catch(() => "");
  throw new VaultRequestError(resp.status, `${init?.method ?? "GET"} ${path} failed: ${resp.status} ${body}`);
}

export async function listNoteVersions(
  noteId: string,
  opts?: { limit?: number; offset?: number },
): Promise<NoteVersionPage> {
  const page = await (
    await historyReq(`/notes/${encodeURIComponent(noteId)}/versions${qs({ limit: opts?.limit, offset: opts?.offset })}`)
  ).json();
  return { versions: (page.versions ?? []).map(toNoteVersion), total: page.total ?? 0 };
}

export async function getNoteVersion(noteId: string, versionIx: number): Promise<NoteVersion> {
  return toNoteVersion(await (await historyReq(`/notes/${encodeURIComponent(noteId)}/versions/${versionIx}`)).json());
}

export async function restoreNoteVersion(noteId: string, versionIx: number, ifUpdatedAt: string): Promise<Note> {
  const resp = await historyReq(`/notes/${encodeURIComponent(noteId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ version_ix: versionIx, if_updated_at: ifUpdatedAt }),
  });
  return resp.json();
}

// ---- tags -----------------------------------------------------------------

export async function getTags(): Promise<TagCount[]> {
  const raw: Array<{ name?: string; tag?: string; count: number }> = await (
    await req(`/tags`)
  ).json();
  return raw.map((t) => ({ tag: t.tag ?? t.name ?? "", count: t.count }));
}

export async function addTags(id: string, tags: string[]): Promise<void> {
  await mutate("PATCH", `/notes/${encodeURIComponent(id)}`, { tags: { add: tags }, force: true }, () => {});
}

export async function removeTags(id: string, tags: string[]): Promise<void> {
  await mutate("PATCH", `/notes/${encodeURIComponent(id)}`, { tags: { remove: tags }, force: true }, () => {});
}

// ---- links ----------------------------------------------------------------

export async function getLinks(noteId?: string, relationship?: string): Promise<VaultLink[]> {
  if (!noteId) return [];
  const note = await (
    // Lean: the links, not a second copy of the body (an older vault ignores the flag).
    await req(`/notes/${encodeURIComponent(noteId)}${qs({ include_links: true, include_content: false })}`)
  ).json();
  const links: VaultLink[] = Array.isArray(note?.links) ? note.links : [];
  return relationship ? links.filter((l) => l.relationship === relationship) : links;
}

export async function createLink(
  sourceId: string,
  targetId: string,
  relationship: string,
  metadata?: unknown,
): Promise<VaultLink> {
  return mutate(
    "PATCH",
    `/notes/${encodeURIComponent(sourceId)}`,
    { links: { add: [{ target: targetId, relationship }] }, force: true },
    () => ({ sourceId, targetId, relationship, metadata, createdAt: nowISO() }),
  );
}

export async function deleteLink(
  sourceId: string,
  targetId: string,
  relationship: string,
): Promise<void> {
  await mutate(
    "PATCH",
    `/notes/${encodeURIComponent(sourceId)}`,
    { links: { remove: [{ target: targetId, relationship }] }, force: true },
    () => {},
  );
}

// ---- graph / vault --------------------------------------------------------

export async function getNeighborhood(centerId: string, depth: number, limit = 150): Promise<VaultNeighborhood> {
  return (await req(`/graph/neighborhood${qs({ center: centerId, depth, limit })}`)).json();
}

export async function getGraph(depth?: number, centerId?: string): Promise<VaultGraph> {
  const sp = new URLSearchParams({ format: "graph", include_links: "true", limit: "10000" });
  if (centerId) {
    sp.append("near[note_id]", centerId);
    if (depth !== undefined) sp.append("near[depth]", String(depth));
  }
  return (await req(`/notes?${sp.toString()}`)).json();
}

export async function getStats(): Promise<VaultStats> {
  const full = await (await req(`/vault${qs({ include_stats: true })}`)).json();
  return (full?.stats ?? {}) as VaultStats;
}

export async function getVaultInfo(): Promise<VaultInfo> {
  return (await req(`/vault`)).json();
}

export async function updateVaultDescription(description: string): Promise<VaultInfo> {
  return writeJson("PATCH", `/vault`, { description }, () => ({
    name: DEFAULT_VAULT_NAME,
    description,
  }));
}

// ---- derived --------------------------------------------------------------

/** Unique directory paths across the vault (desktop computes this server-side). */
export async function getPaths(): Promise<string[]> {
  const entries = await listTree();
  const dirs = new Set<string>();
  for (const e of entries) {
    const p = e.path;
    if (!p) continue;
    const segments = p.split("/").slice(0, -1); // drop the filename
    let acc = "";
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      dirs.add(acc);
    }
  }
  return Array.from(dirs).sort();
}

export async function listPeople(query = "", after?: string): Promise<PeoplePage> {
  return (await req(`/people${qs({ q: query, after })}`)).json();
}
export async function getPerson(id: string, after?: string): Promise<PersonPage> {
  return (await req(`/people/${encodeURIComponent(id)}${qs({ after })}`)).json();
}

export async function changePersonIdentity(id: string, change: { kind: "email" | "matrix"; value: string; action: "add" | "remove"; ifUpdatedAt: string }): Promise<{ person: PersonSummary }> {
  // Deliberate identity decisions need a current review. Never queue or force
  // them after an uncertain write; a refreshed person record resolves it.
  const context = await captureWriteContext();
  const response = await serverFetch(`${context.scope.api}/people/${encodeURIComponent(id)}/identities`, { method: "POST", headers: context.headers, body: JSON.stringify(change) });
  if (!response.ok) throw new Error(response.status === 409 ? "This identity or person changed. Reload the profile before trying again." : "The account could not be changed. Reload the profile to check its current state.");
  return response.json();
}

/** Do not put projections in the generic outbox: the current canvas is authority. */
export async function reconcileCanvasRelations(id: string, fingerprint: string): Promise<{synced:number;retained:boolean}> {
  const context = await captureWriteContext();
  const response = await serverFetch(`${context.scope.api}/canvas/${encodeURIComponent(id)}/relationships`, {method:"POST",headers:context.headers,body:JSON.stringify({fingerprint})});
  if(!response.ok)throw new Error(response.status===409 ? "canvas_scene_changed" : "canvas_relationships_unavailable");
  return response.json();
}


/** Explicit owner-only live source read; a shared transcript is not a room credential. */
export async function getThreadMessages(noteId: string, before?: string): Promise<import("@prism/core").MessageBatch> {
  return (await req(`/threads/${encodeURIComponent(noteId)}/live${qs({ before })}`, { cache: "no-store" })).json();
}

// ---- typed properties + database views (routes/databases.ts) ---------------
// Live, never read-through cached: a view must reflect permission changes now.

export async function getSchemas(tags?: string[]): Promise<{ schemas: SchemaMap; canEdit?: boolean }> {
  const body = (await (await req(`/schemas${qs({ tags: tags?.length ? tags.join(",") : undefined })}`, { cache: "no-store" })).json()) as { schemas?: SchemaMap; canEdit?: boolean };
  return { schemas: body.schemas ?? {}, canEdit: body.canEdit === true };
}

export async function updateSchema(tag: string, patch: SchemaPatch): Promise<TagSchema> {
  const resp = await req(`/schemas/${encodeURIComponent(tag)}`, { method: "PUT", body: JSON.stringify(patch) });
  return ((await resp.json()) as { schema: TagSchema }).schema;
}

/** Owner-only: clear a deleted property's values (dry-run by default). Never queued offline. */
export async function removePropertyValues(tag: string, field: string, opts: { dryRun?: boolean; limit?: number } = {}): Promise<RemoveValuesResult> {
  return (await req(`/schemas/${encodeURIComponent(tag)}/fields/${encodeURIComponent(field)}/remove-values`, { method: "POST", body: JSON.stringify({ dryRun: opts.dryRun !== false, ...(opts.limit ? { limit: opts.limit } : {}) }), cache: "no-store" })).json();
}

/** Owner-only: can this tag start a new database? (The schema write with `requireNew` enforces it again.) */
export async function checkNewTag(tag: string): Promise<{ tag: string; available: boolean; reason?: string; detail?: string }> {
  return (await req(`/schemas/${encodeURIComponent(tag)}/availability`, { cache: "no-store" })).json();
}

export async function queryNotes(spec: QuerySpec): Promise<QueryPage> {
  return (await req(`/query`, { method: "POST", body: JSON.stringify(spec), cache: "no-store" })).json();
}

/**
 * Metadata-only property write with per-field compare-and-set. Offline, it is
 * queued as a mergeable metadata row (`kind: "meta"`): on reconnect the outbox
 * replays it through this same route as a per-key merge WITHOUT `expect` (the
 * per-field CAS only applies online), never as a forced write.
 */
export async function updateProperties(id: string, set: Record<string, unknown>, expect?: Record<string, unknown>): Promise<PropertyWriteResult> {
  const context = await captureWriteContext();
  if (isOffline() || await hasPendingFor(context, id)) {
    await queueMetadata(id, set, context, expect);
    if (!isOffline()) void flush();
    const n = await getNote(id).catch(() => null);
    return { id, updatedAt: n?.updatedAt ?? nowISO(), metadata: n?.metadata ?? set };
  }
  try {
    return (await (await req(`/properties/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ set, expect }), cache: "no-store" })).json()) as PropertyWriteResult;
  } catch (e) {
    if (e instanceof VaultRequestError && e.status === 409) {
      const raw = e.message.slice(e.message.indexOf("{"));
      let fields: string[] = [];
      let current: Record<string, unknown> = {};
      try {
        const b = JSON.parse(raw) as { fields?: string[]; current?: Record<string, unknown> };
        fields = b.fields ?? [];
        current = b.current ?? {};
      } catch {
        /* keep the generic conflict */
      }
      throw new PropertyConflictError(fields, current);
    }
    throw e;
  }
}

// ---- attachments + link previews (routes/attachments.ts) --------------------

/** Server refusals → a short reason the editor can show ("too large", "not supported"). */
function uploadReason(status: number, body: string): string | undefined {
  if (status === 413) return "the file is too large";
  if (status === 415) return /svg|active|blocked/i.test(body) ? "web pages, scripts and SVG files aren't allowed" : "that file type isn't supported here";
  if (status === 403) return "you can't add files to this page";
  if (status === 409) return /locked/.test(body) ? "this page is locked" : undefined;
  if (status === 429) return "too many uploads — try again in a minute";
  return undefined;
}

/**
 * Store a file as an attachment of `noteId` (multipart, POST /api/notes/:id/attachments).
 * Never queued offline: the editor inserts the block only after the server answers.
 * `X-Prism-Upload` forces a CORS preflight (the server's CSRF guard for multipart).
 */
export async function uploadAttachment(noteId: string, file: File, opts?: { kind?: "image" | "file" }): Promise<import("@prism/core").UploadedAttachment> {
  if (isOffline()) throw Object.assign(new Error("offline"), { userMessage: "you're offline" });
  const context = await captureWriteContext().catch(() => null);
  const url = `${context?.scope.api ?? apiBase()}/notes/${encodeURIComponent(noteId)}/attachments${qs({ kind: opts?.kind })}`;
  const headers: Record<string, string> = { ...(context?.headers ?? jsonHeaders()), "X-Prism-Upload": "1" };
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-type") delete headers[k]; // the browser sets the multipart boundary
  const form = new FormData();
  form.append("file", file, file.name);
  const resp = await serverFetch(url, { method: "POST", body: form, headers, cache: "no-store" });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw Object.assign(new VaultRequestError(resp.status, `upload failed: ${resp.status} ${body.slice(0, 200)}`), { userMessage: uploadReason(resp.status, body) });
  }
  return (await resp.json()) as import("@prism/core").UploadedAttachment;
}

/** Copy the files a duplicated page references into the copy (POST /api/notes/:id/attachments/copy). */
export async function copyAttachments(noteId: string): Promise<{ copied: number; failed: number; skipped: number; errors: number; more: boolean }> {
  if (isOffline()) throw Object.assign(new Error("offline"), { userMessage: "you're offline" });
  const total = { copied: 0, failed: 0, skipped: 0, errors: 0, more: false };
  // The server copies up to 50 files (and a byte/time budget) per call and only
  // counts work still to do, so every round either makes progress or we stop.
  // `more` still true at exit = some files were NOT copied (the caller says so).
  for (let round = 0; round < 40; round++) {
    const r = (await (await req(`/notes/${encodeURIComponent(noteId)}/attachments/copy`, { method: "POST", body: "{}", cache: "no-store" })).json()) as Partial<typeof total>;
    total.copied += r.copied ?? 0;
    total.failed += r.failed ?? 0;
    total.skipped = r.skipped ?? 0;
    total.errors = r.errors ?? 0;
    total.more = !!r.more;
    if (!r.more || (r.copied ?? 0) + (r.failed ?? 0) === 0) break;
  }
  return total;
}

/** Link preview for a bookmark (GET /api/unfurl, signed-in only, SSRF-guarded server-side). */
export async function unfurl(url: string): Promise<{ url: string; title?: string | null; description?: string | null; siteName?: string | null; image?: string | null; favicon?: string | null }> {
  return (await req(`/unfurl${qs({ u: url })}`, { cache: "no-store" })).json();
}

/** Bulk property writes: one CAS result per row (200 all written, 207 partial). Never queued offline. */
export async function updatePropertiesBatch(items: PropertyBatchItem[]): Promise<PropertyBatchResult[]> {
  const body = (await (await req(`/properties/batch`, { method: "POST", body: JSON.stringify({ items }), cache: "no-store" })).json()) as { results?: PropertyBatchResult[] };
  return body.results ?? [];
}

/** Owner/admin CSV import (dry-run by default). A 207 still carries the plan + result. */
export async function importCsv(request: CsvImportRequest): Promise<CsvImportResponse> {
  return (await req(`/databases/import/csv`, { method: "POST", body: JSON.stringify(request), cache: "no-store" })).json();
}
