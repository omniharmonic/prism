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
} from "@prism/core";
import { VaultRequestError, HistoryUnavailableError, HistoryConflictError, PropertyConflictError, toNoteVersion } from "@prism/core";
import type { QueryPage, QuerySpec, SchemaMap, SchemaPatch, TagSchema, PropertyWriteResult } from "@prism/core";
import { filtersToParams, type SearchFilters } from "@prism/core/search";
import type { PropertyBatchItem, PropertyBatchResult, CsvImportRequest, CsvImportResponse } from "@prism/core/database";
import { agentScope, apiBase, DEFAULT_VAULT_NAME, capabilityHeader, contextHeaders } from "../config";
import { retainDraft, enqueue, hasPending, flush, localNote, resolveLocalNoteId } from "../offline/outbox";
import { captureWriteContext, scopeKey } from "../offline/writeScope";
import { serverFetch } from "../transport";
import { readThrough } from "../offline/readCache";

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

/**
 * Mutation whose JSON response we return (create/update note). When offline or
 * the fetch fails with a network error, queue it in the outbox and resolve with
 * an optimistic copy so the editor proceeds; it replays on reconnect. HTTP
 * errors (4xx/5xx) still throw.
 */
async function writeJson<T>(method: string, path: string, body: unknown, optimistic: () => T, temporaryId?: string, expectedScope?: string): Promise<T> {
  const assertAudience = () => { if (expectedScope !== undefined && agentScope() !== expectedScope) throw new VaultRequestError(403, "Workspace changed before this draft could be sent."); };
  assertAudience();
  const context = await captureWriteContext();
  assertAudience();
  const bodyStr = JSON.stringify(body);
  if (isOffline() || path.includes("/offline-") || await hasPending(context)) {
    await enqueue(method, path, bodyStr, context, { temporaryId });
    if (!isOffline()) void flush();
    return optimistic();
  }
  let resp: Response;
  try {
    resp = await serverFetch(`${context.scope.api}${path}`, { method, headers: context.headers, body: bodyStr });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await enqueue(method, path, bodyStr, context, { unknown: true, temporaryId });
    return optimistic();
  }
  if (!resp.ok) {
    if (resp.status >= 500) {
      await enqueue(method, path, bodyStr, context, { unknown: true, temporaryId });
      return optimistic();
    }
    throw new VaultRequestError(resp.status, `${method} ${path} failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  }
  try {
    const text = await resp.text();
    return text ? JSON.parse(text) as T : optimistic();
  } catch {
    await enqueue(method, path, bodyStr, context, { unknown: true, temporaryId });
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
}

/**
 * The file tree. Served by the gateway's in-memory projection (`/tree`: a few
 * hundred KB gzipped, ETag-revalidated by the browser) instead of a ~16 MB
 * full-vault list. Falls back to the legacy list against an older server that
 * predates the endpoint (404 via the vault, or 403 from the old catch-all).
 */
export async function listTree(): Promise<NoteTreeEntry[]> {
  try {
    const rows = (await (await req(`/tree`)).json()) as TreeRow[];
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      tags: r.tags,
      // Only the two keys the tree's type/icon inference reads.
      metadata: r.type || r.prismType || r.order !== undefined ? { ...(r.type ? { type: r.type } : {}), ...(r.prismType ? { prism_type: r.prismType } : {}), ...(r.order !== undefined ? { prism_order: r.order } : {}) } : null,
    }));
  } catch (e) {
    if (!/ failed: (404|403) /.test((e as Error).message)) throw e;
    return (await req(`/notes${qs({ limit: 50000, sort: "desc" })}`)).json();
  }
}

export async function getNote(id: string, options?: { fresh?: boolean }): Promise<Note> {
  const resolved = await resolveLocalNoteId(id);
  if (resolved.startsWith("offline-")) {
    const draft = await localNote(resolved);
    if (!draft) throw new Error("This local draft is unavailable in the current workspace.");
    return draft;
  }
  const note = await (await req(`/notes/${encodeURIComponent(resolved)}`, options?.fresh ? { cache: "no-store" } : undefined)).json() as Note;
  return await localNote(resolved, note).catch(() => note) ?? note;
}

export async function createNote(params: CreateNoteParams): Promise<Note> {
  const temporaryId = `offline-${crypto.randomUUID()}`;
  return writeJson("POST", `/notes`, params, () => ({
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
  if (body.if_updated_at === undefined) body.force = true;
  return writeJson("PATCH", `/notes/${encodeURIComponent(id)}`, body, () => ({
    id,
    content: params.content ?? "",
    path: params.path ?? null,
    metadata: params.metadata ?? null,
    tags: null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }), undefined, options?.expectedScope);
}

export async function preserveDraft(id: string, content: string, audience: string): Promise<void> {
  const value: unknown = JSON.parse(audience);
  if (!Array.isArray(value) || value.length !== 4 || !value.every(part => typeof part === "string" && part.length > 0 && part.length < 4096)) throw Error("Draft audience unavailable");
  const [api, workspace, vault, email] = value as string[];
  const url = new URL(api);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw Error("Draft server unavailable");
  await retainDraft(id, content, { api, workspace, vault, actor: `user:${email}` });
}

export async function deleteNote(id: string): Promise<void> {
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
  const sp = filtersToParams(filters, new URLSearchParams({ q: query, limit: String(limit), lean: "1" }));
  try {
    return await (await req(`/search?${sp.toString()}`)).json();
  } catch (error) {
    if (error instanceof VaultRequestError && [404, 405, 501].includes(error.status)) return null;
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
    await req(`/notes/${encodeURIComponent(noteId)}${qs({ include_links: true })}`)
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

export async function queryNotes(spec: QuerySpec): Promise<QueryPage> {
  return (await req(`/query`, { method: "POST", body: JSON.stringify(spec), cache: "no-store" })).json();
}

/**
 * Metadata-only property write with per-field compare-and-set. Offline, the
 * write is queued through the outbox as a plain metadata merge (it replays on
 * reconnect) — the same path every other offline edit takes.
 */
export async function updateProperties(id: string, set: Record<string, unknown>, expect?: Record<string, unknown>): Promise<PropertyWriteResult> {
  if (isOffline()) {
    const n = await updateNote(id, { metadata: set });
    return { id: n.id, updatedAt: n.updatedAt, metadata: n.metadata ?? {} };
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

/** Bulk property writes: one CAS result per row (200 all written, 207 partial). Never queued offline. */
export async function updatePropertiesBatch(items: PropertyBatchItem[]): Promise<PropertyBatchResult[]> {
  const body = (await (await req(`/properties/batch`, { method: "POST", body: JSON.stringify({ items }), cache: "no-store" })).json()) as { results?: PropertyBatchResult[] };
  return body.results ?? [];
}

/** Owner/admin CSV import (dry-run by default). A 207 still carries the plan + result. */
export async function importCsv(request: CsvImportRequest): Promise<CsvImportResponse> {
  return (await req(`/databases/import/csv`, { method: "POST", body: JSON.stringify(request), cache: "no-store" })).json();
}
