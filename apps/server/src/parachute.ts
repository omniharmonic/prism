/**
 * Server-side Parachute REST client. Holds the vault token (from config) and is
 * the ONLY component that talks to the vault. Every public route authorizes the
 * request first, then calls these helpers. The token is never sent to a client.
 *
 * Mirrors the shapes in apps/web/src/parachute/rest.ts (Parachute 0.5.x returns
 * camelCase notes; PATCH needs if_updated_at or force).
 */
import { config } from "./config";

export interface Note {
  id: string;
  content: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
  tags: string[] | null;
}

const apiBase = () => `${config.parachuteUrl}/vault/${config.parachuteVault}/api`;
const authHeaders = () => ({
  Authorization: `Bearer ${config.parachuteToken}`,
  "Content-Type": "application/json",
});

async function req(path: string, init?: RequestInit): Promise<Response> {
  const resp = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new VaultError(resp.status, `${init?.method ?? "GET"} ${path}: ${resp.status} ${body}`);
  }
  return resp;
}

export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.append(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const vault = {
  async listNotes(opts: { tags?: string[]; limit?: number; includeContent?: boolean } = {}): Promise<Note[]> {
    const sp = new URLSearchParams({ limit: String(opts.limit ?? 50000), sort: "desc" });
    if (opts.includeContent) sp.set("include_content", "true");
    for (const t of opts.tags ?? []) sp.append("tag", t);
    return (await req(`/notes?${sp.toString()}`)).json() as Promise<Note[]>;
  },

  async getNote(id: string): Promise<Note> {
    return (await req(`/notes/${encodeURIComponent(id)}`)).json() as Promise<Note>;
  },

  async createNote(params: {
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): Promise<Note> {
    return (await req(`/notes`, { method: "POST", body: JSON.stringify(params) })).json() as Promise<Note>;
  },

  async updateNote(
    id: string,
    params: { content?: string; path?: string; metadata?: Record<string, unknown>; ifUpdatedAt?: string },
  ): Promise<Note> {
    const body: Record<string, unknown> = {};
    if (params.content !== undefined) body.content = params.content;
    if (params.path !== undefined) body.path = params.path;
    if (params.metadata !== undefined) body.metadata = params.metadata;
    if (params.ifUpdatedAt !== undefined) body.if_updated_at = params.ifUpdatedAt;
    if (body.if_updated_at === undefined) body.force = true;
    return (await req(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) })).json() as Promise<Note>;
  },

  async addTags(id: string, tags: string[]): Promise<void> {
    await req(`/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ tags: { add: tags }, force: true }),
    });
  },

  async removeTags(id: string, tags: string[]): Promise<void> {
    await req(`/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ tags: { remove: tags }, force: true }),
    });
  },

  async deleteNote(id: string): Promise<void> {
    await req(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async search(query: string, tags: string[] = [], limit = 50): Promise<Note[]> {
    const sp = new URLSearchParams({ search: query, limit: String(limit), include_content: "true" });
    for (const t of tags) sp.append("tag", t);
    return (await req(`/notes?${sp.toString()}`)).json() as Promise<Note[]>;
  },

  async getTags(): Promise<Array<{ tag: string; count: number }>> {
    const raw = (await req(`/tags`)).json() as Promise<Array<{ name?: string; tag?: string; count: number }>>;
    return (await raw).map((t) => ({ tag: t.tag ?? t.name ?? "", count: t.count }));
  },

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${config.parachuteUrl}/health`);
      return r.ok;
    } catch {
      return false;
    }
  },

  qs,
};
