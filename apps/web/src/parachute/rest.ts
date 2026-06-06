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
} from "@prism/core";
import { apiBase, getConnection } from "../config";

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getConnection().token}`,
    "Content-Type": "application/json",
  };
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  const resp = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string>) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${resp.status} ${body}`);
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

export async function listTree(): Promise<NoteTreeEntry[]> {
  // Same endpoint; the response carries extra fields the lean type ignores.
  return (await req(`/notes${qs({ limit: 50000, sort: "desc" })}`)).json();
}

export async function getNote(id: string): Promise<Note> {
  return (await req(`/notes/${encodeURIComponent(id)}`)).json();
}

export async function createNote(params: CreateNoteParams): Promise<Note> {
  return (await req(`/notes`, { method: "POST", body: JSON.stringify(params) })).json();
}

export async function updateNote(id: string, params: UpdateNoteParams): Promise<Note> {
  // Translate camelCase ifUpdatedAt → the API's snake_case contract, and inject
  // force:true when no precondition is supplied (vault 0.4.0+ requires one).
  const body: Record<string, unknown> = {};
  if (params.content !== undefined) body.content = params.content;
  if (params.path !== undefined) body.path = params.path;
  if (params.metadata !== undefined) body.metadata = params.metadata;
  if (params.ifUpdatedAt !== undefined) body.if_updated_at = params.ifUpdatedAt;
  if (body.if_updated_at === undefined) body.force = true;
  return (
    await req(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) })
  ).json();
}

export async function deleteNote(id: string): Promise<void> {
  await req(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
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

// ---- tags -----------------------------------------------------------------

export async function getTags(): Promise<TagCount[]> {
  const raw: Array<{ name?: string; tag?: string; count: number }> = await (
    await req(`/tags`)
  ).json();
  return raw.map((t) => ({ tag: t.tag ?? t.name ?? "", count: t.count }));
}

export async function addTags(id: string, tags: string[]): Promise<void> {
  await req(`/notes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ tags: { add: tags }, force: true }),
  });
}

export async function removeTags(id: string, tags: string[]): Promise<void> {
  await req(`/notes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ tags: { remove: tags }, force: true }),
  });
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
  await req(`/notes/${encodeURIComponent(sourceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ links: { add: [{ target: targetId, relationship }] }, force: true }),
  });
  return { sourceId, targetId, relationship, metadata, createdAt: new Date().toISOString() };
}

export async function deleteLink(
  sourceId: string,
  targetId: string,
  relationship: string,
): Promise<void> {
  await req(`/notes/${encodeURIComponent(sourceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ links: { remove: [{ target: targetId, relationship }] }, force: true }),
  });
}

// ---- graph / vault --------------------------------------------------------

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
  return (
    await req(`/vault`, { method: "PATCH", body: JSON.stringify({ description }) })
  ).json();
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
