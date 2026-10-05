/**
 * Server-side Parachute REST client. Holds the vault token (from config) and is
 * the ONLY component that talks to the vault. Every public route authorizes the
 * request first, then calls these helpers. The token is never sent to a client.
 *
 * Mirrors the shapes in apps/web/src/parachute/rest.ts (Parachute 0.5.x returns
 * camelCase notes; PATCH needs if_updated_at or force).
 */
import { canonicalTagsStrict } from "./tags";
import { config, type VaultEntry } from "./config";
import { resolveVaultEntry } from "./db";

export interface Note {
  id: string;
  content: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
  tags: string[] | null;
  /** Present only on list reads with `includeLinks` (see NoteLink). */
  links?: NoteLink[];
  /** Lean (no-content) list reads carry the title the vault derived from the body. */
  displayTitle?: string | null;
}

/** One captured prior state of a note (vault 0.7.9 note history). */
export interface VersionRow {
  note_id: string;
  version_ix: number;
  path: string | null;
  metadata: Record<string, unknown> | null;
  superseded_at: string;
  op: string;
  content_len: number;
  actor?: string | null;
  via?: string | null;
  created_at?: string | null;
  encoding?: string | null;
}

/** A typed link in a write payload: `target` is a note id or path. */
export interface NoteLinkInput {
  target: string;
  relationship: string;
}

/** Path-conflict mode for `createNote` (vault#555). */
export type IfExists = "error" | "ignore" | "update" | "replace";

/** A hydrated link as `include_links` returns it (extra summary fields ignored). */
export interface NoteLink {
  sourceId: string;
  targetId: string;
  relationship: string;
}

export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Optimistic-concurrency failure from the vault. The canonical contract: a
 * mutating write must carry `if_updated_at` (or `force:true`); the vault returns
 * 428 (Precondition Required) when neither is present, and 409 (Conflict) when
 * the note changed since the supplied `if_updated_at`. We surface these as a
 * typed error carrying the vault's response body (which includes the current
 * state) so a caller can let the client rebase instead of silently overwriting.
 */
export class VaultConflictError extends VaultError {
  constructor(
    status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(status, message);
  }
}

/**
 * Tags at the SINK (defence in depth): every tag this client sends is the canonical
 * form the vault would store (`canonicalTag`), and a tag that canonicalises to
 * nothing is refused instead of silently vanishing. Callers canonicalise before
 * their permission checks; this makes sure nothing un-canonical leaves the process.
 */
function sinkTags(tags: readonly string[]): string[] {
  const out = canonicalTagsStrict(tags);
  if (!out) throw new VaultError(400, "refused before sending: an empty or invalid tag");
  return out;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.append(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export type VaultHelper = ReturnType<typeof vaultClient>;

/**
 * Build a vault-shaped helper bound to a specific registry entry's url/vault/
 * token. `vaultClient()` (no id) resolves the primary entry — which is exactly
 * the single configured vault in the default (no-PRISM_VAULTS) case — so the
 * exported `vault` singleton below is byte-for-byte the old behavior, and every
 * existing call site (`vault.*`) is unchanged. Pass a vault id (Phase 1, owner
 * passthrough only) to bind a request to a different vault.
 */
export function vaultClient(vaultId?: string, opts: { /** Abort any single vault call after this long (no timeout when unset). */ timeoutMs?: number } = {}) {
  const entry: VaultEntry = resolveVaultEntry(vaultId);
  const apiBase = () => `${entry.url}/vault/${entry.vault}/api`;
  const authHeaders = () => ({
    Authorization: `Bearer ${entry.token}`,
    "Content-Type": "application/json",
  });

  async function req(path: string, init?: RequestInit): Promise<Response> {
    const t0 = Date.now();
    const resp = await fetch(`${apiBase()}${path}`, {
      ...init,
      ...(opts.timeoutMs && !init?.signal ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
    });
    if (process.env.PRISM_VAULT_TRACE === "1") {
      // Which server subsystem is calling: first app frame outside this file.
      const caller = (new Error().stack ?? "").split("\n").find((l) => l.includes("/src/") && !l.includes("parachute.ts"))?.trim().replace(/^at /, "").replace(/\(?\/.*\/src\//, "").replace(/\)$/, "") ?? "?";
      console.log(`[trace] worker ${init?.method ?? "GET"} ${entry.vault}${path} → ${resp.status} ${Date.now() - t0}ms from ${caller}`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 409 || resp.status === 428) {
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep the raw text */
        }
        throw new VaultConflictError(resp.status, parsed, `${init?.method ?? "GET"} ${path}: ${resp.status}`);
      }
      throw new VaultError(resp.status, `${init?.method ?? "GET"} ${path}: ${resp.status} ${text}`);
    }
    return resp;
  }

  return {
  async listNotes(opts: { tags?: string[]; pathPrefix?: string; limit?: number; includeContent?: boolean; includeLinks?: boolean; orderBy?: "updated_at" | "created_at"; includeMetadata?: string[] } = {}): Promise<Note[]> {
    const sp = new URLSearchParams({ limit: String(opts.limit ?? 50000), sort: "desc" });
    if (opts.orderBy) sp.set("order_by", opts.orderBy);
    if (opts.includeContent) sp.set("include_content", "true");
    // Each note then carries `links` ({sourceId,targetId,relationship}[]), hydrated
    // in a constant number of vault queries per page (vault ≥0.7.x).
    if (opts.includeLinks) sp.set("include_links", "true");
    // Field-filtered metadata (vault ≥0.7.x `include_metadata=a,b`): the tree projection
    // needs ~4 keys, not every note's full metadata blob.
    if (opts.includeMetadata?.length) sp.set("include_metadata", opts.includeMetadata.join(","));
    if (opts.pathPrefix) sp.set("path_prefix", opts.pathPrefix);
    for (const t of sinkTags(opts.tags ?? [])) sp.append("tag", t);
    return (await req(`/notes?${sp.toString()}`)).json() as Promise<Note[]>;
  },

  async getNote(id: string, opts?: { includeLinks?: boolean; /** false = a lean read: no body (and, with `includeMetadata`, only those metadata keys). */ includeContent?: boolean; includeMetadata?: string[] }): Promise<Note> {
    const sp = new URLSearchParams();
    if (opts?.includeLinks) sp.set("include_links", "true");
    if (opts?.includeContent === false) sp.set("include_content", "false");
    if (opts?.includeMetadata?.length) sp.set("include_metadata", opts.includeMetadata.join(","));
    const q = sp.toString();
    return (await req(`/notes/${encodeURIComponent(id)}${q ? `?${q}` : ""}`)).json() as Promise<Note>;
  },

  /**
   * `ifExists` (vault ≥0.7.9, vault#555) decides what happens when `path` already
   * names a note: "error" (the vault default — 409 path_conflict), "ignore"
   * (return the existing note untouched), "update" (content replaces, metadata
   * RFC-7386-merges, tags/links union) or "replace". With any non-error mode the
   * response carries `existed`. Ingesters use it so a create can never 409.
   * `links` are resolved by note id or path, idempotently (INSERT OR IGNORE).
   */
  async createNote(params: {
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    links?: NoteLinkInput[];
    ifExists?: IfExists;
  }): Promise<Note & { existed?: boolean }> {
    // Built key by key, never spread: the vault's POST also honours `notes` (batch),
    // `id`, `created_at`, `extension` — a caller that hands over an object with more
    // on it than the type says (a request body) must not be able to send them.
    const body: Record<string, unknown> = { content: params.content };
    if (params.path !== undefined) body.path = params.path;
    if (params.metadata !== undefined) body.metadata = params.metadata;
    if (params.tags !== undefined) body.tags = sinkTags(params.tags);
    if (params.links !== undefined) body.links = params.links;
    if (params.ifExists !== undefined) body.if_exists = params.ifExists;
    return (await req(`/notes`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<Note & { existed?: boolean }>;
  },

  async updateNote(
    id: string,
    params: {
      content?: string;
      path?: string;
      metadata?: Record<string, unknown>;
      ifUpdatedAt?: string;
      /** Typed links to add/remove in the same write (add is idempotent). */
      links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] };
      /** Tags to add/remove in the same write (one history version, not two). */
      tags?: { add?: string[]; remove?: string[] };
    },
  ): Promise<Note> {
    const body: Record<string, unknown> = {};
    if (params.content !== undefined) body.content = params.content;
    if (params.path !== undefined) body.path = params.path;
    if (params.metadata !== undefined) body.metadata = params.metadata;
    if (params.links !== undefined) body.links = params.links;
    if (params.tags !== undefined) {
      body.tags = { ...(params.tags.add ? { add: sinkTags(params.tags.add) } : {}), ...(params.tags.remove ? { remove: sinkTags(params.tags.remove) } : {}) };
    }
    if (params.ifUpdatedAt !== undefined) body.if_updated_at = params.ifUpdatedAt;
    if (body.if_updated_at === undefined) body.force = true;
    return (await req(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) })).json() as Promise<Note>;
  },

  async addTags(id: string, tags: string[]): Promise<void> {
    await req(`/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ tags: { add: sinkTags(tags) }, force: true }),
    });
  },

  async removeTags(id: string, tags: string[]): Promise<void> {
    await req(`/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ tags: { remove: sinkTags(tags) }, force: true }),
    });
  },

  async deleteNote(id: string): Promise<void> {
    await req(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // ---- version history (vault ≥ 0.7.9; a 0.6.x vault 404s these) ----------
  // Rows are the vault's raw snake_case shape — the gateway forwards them.

  async listVersions(id: string, limit = 50, offset = 0): Promise<{ versions: VersionRow[]; total: number }> {
    const q = qs({ limit, offset });
    return (await req(`/notes/${encodeURIComponent(id)}/versions${q}`)).json() as Promise<{ versions: VersionRow[]; total: number }>;
  },

  async getVersion(id: string, versionIx: number): Promise<VersionRow & { content: string | null }> {
    return (await req(`/notes/${encodeURIComponent(id)}/versions/${versionIx}`)).json() as Promise<VersionRow & { content: string | null }>;
  },

  /** Restore requires the reviewed `if_updated_at` (the vault refuses `force`). */
  async restoreVersion(id: string, versionIx: number, ifUpdatedAt: string): Promise<Note> {
    return (
      await req(`/notes/${encodeURIComponent(id)}/restore`, {
        method: "POST",
        body: JSON.stringify({ version_ix: versionIx, if_updated_at: ifUpdatedAt }),
      })
    ).json() as Promise<Note>;
  },

  async search(query: string, tags: string[] = [], limit = 50): Promise<Note[]> {
    const sp = new URLSearchParams({ search: query, limit: String(limit), include_content: "true" });
    for (const t of sinkTags(tags)) sp.append("tag", t);
    return (await req(`/notes?${sp.toString()}`)).json() as Promise<Note[]>;
  },

  async getTags(): Promise<Array<{ tag: string; count: number }>> {
    const raw = (await req(`/tags`)).json() as Promise<Array<{ name?: string; tag?: string; count: number }>>;
    return (await raw).map((t) => ({ tag: t.tag ?? t.name ?? "", count: t.count }));
  },

  /** Vault reachability. BOUNDED: a vault that does not answer within
   *  `VAULT_HEALTH_TIMEOUT_MS` (2 s) reads as down — the fetch used to have no
   *  timeout, so a paged-out vault made `GET /health` hang with it. */
  async health(): Promise<boolean> {
    try {
      const ms = config.vaultHealthTimeoutMs;
      const r = await fetch(`${entry.url}/health`, ms > 0 ? { signal: AbortSignal.timeout(ms) } : undefined);
      return r.ok;
    } catch {
      return false;
    }
  },

  qs,
  };
}

/**
 * The default vault client, bound to the primary registry entry. Unchanged
 * behavior vs. the pre-multi-vault server; the canonical import for all
 * existing call sites.
 */
export const vault = vaultClient();
