/**
 * Shared test helpers: an in-memory fake Parachute vault (installed by stubbing
 * global.fetch), plus factories for sessions, grants, and capability links so
 * the gateway/acl/collab tests can exercise the REAL authorization pipeline
 * (resolveActor → effectiveLevel → proxy/filter) without a live vault.
 *
 * Why stub fetch rather than mock the `vault` module? The route handlers call
 * `vault.*`, which calls `fetch` at request time. Replacing global.fetch lets us
 * drive the full stack — including the owner's transparent proxyToVault — and
 * assert on the exact requests the server makes to the vault (e.g. that it sends
 * `Authorization: Bearer test-vault-token`, and never leaks it to the client).
 */
import { db, createSession, addGrant, type ResourceType } from "../src/db";
import type { Level } from "../src/permissions";
import { signCapability } from "../src/auth/capability";
import { randomBytes } from "node:crypto";
import { config } from "../src/config";
import { TRANSCRIPT_LINK_TABLES } from "../src/transcript-links-store";
import "../src/identity-store"; // creates identity_candidates (reset below)
import "../src/people-agent-store"; // creates people_agent_decisions + people_merge_recommendations (reset below)
import "../src/pages"; // creates page_preferences (reset below)

// SAFETY GUARD (load-time): the test harness TRUNCATES tables (resetDb). It must
// NEVER run against a real on-disk database. Tests are meant to run with
// `--env-file=.env.test` (DB_PATH=:memory:); if that flag is forgotten, DB_PATH
// falls through to the prod default (./prism-server.db) and resetDb would WIPE
// production. Fail HARD at import instead — a mis-invoked `node --test test/*.ts`
// aborts before touching any data. (Incident 2026-07-01: a missing --env-file
// wiped the prod ACL db; recovered from backup. This guard makes it impossible.)
if (config.dbPath !== ":memory:") {
  throw new Error(
    `REFUSING TO RUN TESTS: DB_PATH is "${config.dbPath}", not ":memory:". ` +
      `Run tests via \`npm test\` (uses --env-file=.env.test). The harness truncates ` +
      `tables and must never touch a real database.`,
  );
}

export interface FakeNote {
  links?: Array<{sourceId:string;targetId:string;relationship:string}>;
  id: string;
  content: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
  tags: string[] | null;
}

export interface VaultCall {
  method: string;
  path: string; // pathname only, e.g. "/vault/default/api/notes/abc"
  search: string;
  body: unknown;
  authorization: string | null;
}

const realFetch = globalThis.fetch;

export interface FakeVault {
  notes: Map<string, FakeNote>;
  tags: Array<{ name: string; count: number }>;
  calls: VaultCall[];
  healthy: boolean;
  /** Force the next note write to 409 (optimistic-concurrency conflict). */
  conflictOnNextWrite: boolean;
  /** Vault ≥0.7.9 note history: prior states captured on every PATCH, newest
   *  last. Set `historySupported = false` to emulate a 0.6.x vault (404s). */
  versions: Map<string, FakeVersion[]>;
  historySupported: boolean;
  put(note: Partial<FakeNote> & { id: string }): FakeNote;
  /** Serve an ADDITIONAL vault name at /vault/<name>/api with its own note
   *  store (multi-vault tests). The primary store (`notes`) keeps serving
   *  /vault/default/api unchanged; vault names never registered here still 404
   *  ("unreachable"), which some tests assert. Returns the store. */
  addVault(name: string): Map<string, FakeNote>;
  /** Seed a note into an additional vault's store (auto-registers the vault). */
  putIn(vault: string, note: Partial<FakeNote> & { id: string }): FakeNote;
  restore(): void;
}

export interface FakeVersion {
  note_id: string;
  version_ix: number;
  content: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  superseded_at: string;
  op: string;
  content_len: number;
  actor: string | null;
  via: string | null;
}

let seq = 0;
export function fakeNote(p: Partial<FakeNote> & { id: string }): FakeNote {
  return {
    content: "",
    path: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    ...p,
  };
}

/** Parachute PATCH uses JSON Merge Patch; omitted keys survive, null deletes. */
function mergeMetadata(target: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target)
    ? { ...target as Record<string, unknown> } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else Object.defineProperty(out, key, { value: value && typeof value === "object" && !Array.isArray(value)
      ? mergeMetadata(out[key], value as Record<string, unknown>) : value, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Install a fake vault by overriding global.fetch. Routes requests to
 * http://vault.test/vault/default/api/* and /health. Returns a handle to seed
 * notes/tags and inspect the calls made.
 */
export function installFakeVault(): FakeVault {
  // Per-vault-name note stores. "default" is the primary store (fv.notes); the
  // handler only serves vault names present here, so an unregistered vault name
  // stays unreachable (404) exactly as before.
  const stores = new Map<string, Map<string, FakeNote>>();
  const fv: FakeVault = {
    notes: new Map(),
    tags: [],
    calls: [],
    healthy: true,
    conflictOnNextWrite: false,
    versions: new Map(),
    historySupported: true,
    put(note) {
      const n = fakeNote(note);
      fv.notes.set(n.id, n);
      return n;
    },
    addVault(name) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      return store;
    },
    putIn(vault, note) {
      const n = fakeNote(note);
      fv.addVault(vault).set(n.id, n);
      return n;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
  stores.set("default", fv.notes);

  function captureVersion(n: FakeNote, op: string): void {
    const list = fv.versions.get(n.id) ?? [];
    list.push({
      note_id: n.id,
      version_ix: list.length,
      content: n.content,
      path: n.path,
      metadata: n.metadata,
      superseded_at: new Date(2026, 5, 1, 0, 0, seq++).toISOString(),
      op,
      content_len: n.content.length,
      actor: "hub-user-owner",
      via: "token:prism",
    });
    fv.versions.set(n.id, list);
  }

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlStr);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string" && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fv.calls.push({
      method,
      path: url.pathname,
      search: url.search,
      body,
      authorization: headers["Authorization"] ?? headers["authorization"] ?? null,
    });

    if (url.pathname === "/health") {
      return fv.healthy ? json({ ok: true }) : new Response("down", { status: 503 });
    }

    const apiMatch = url.pathname.match(/^\/vault\/([^/]+)\/api(\/.*)$/);
    if (!apiMatch) return new Response("not found", { status: 404 });
    const store = stores.get(decodeURIComponent(apiMatch[1]!));
    if (!store) return new Response("not found", { status: 404 }); // unregistered vault → unreachable
    const sub = apiMatch[2]!; // "/notes", "/notes/:id", "/tags", ...

    // GET /tags
    if (sub === "/tags" && method === "GET") {
      return json(fv.tags);
    }

    // /notes collection
    if (sub === "/notes") {
      if (method === "GET") {
        const q = url.searchParams;
        const tagFilters = q.getAll("tag");
        const search = q.get("search");
        let list = [...store.values()];
        if (tagFilters.length) list = list.filter((n) => tagFilters.every((t) => (n.tags ?? []).includes(t)));
        if (search) list = list.filter((n) => n.content.toLowerCase().includes(search.toLowerCase()));
        // Like the vault: `include_metadata=a,b` returns ONLY those metadata keys.
        const only = q.get("include_metadata");
        if (only) {
          const keep = only.split(",").filter(Boolean);
          return json(list.map((n) => ({ ...n, metadata: n.metadata ? Object.fromEntries(keep.filter((k) => k in n.metadata!).map((k) => [k, n.metadata![k]])) : n.metadata })));
        }
        return json(list);
      }
      if (method === "POST") {
        const b = (body ?? {}) as Partial<FakeNote>;
        const id = `new-${++seq}`;
        const n = fakeNote({ id, content: b.content ?? "", path: b.path ?? null, metadata: b.metadata ?? null, tags: b.tags ?? [] });
        store.set(n.id, n);
        return json(n);
      }
    }

    // /notes/:id/versions[/:ix] and /restore (vault ≥0.7.9 history)
    const h = sub.match(/^\/notes\/([^/]+)\/(versions|restore)(?:\/(\d+))?$/);
    if (h) {
      if (!fv.historySupported) return json({ error: "Not found" }, 404);
      const id = decodeURIComponent(h[1]!);
      const existing = store.get(id);
      if (!existing) return json({ error: "Not found", error_type: "not_found" }, 404);
      const list = fv.versions.get(id) ?? [];
      if (h[2] === "versions" && h[3] === undefined && method === "GET") {
        const rows = [...list].reverse().map(({ content: _c, ...row }) => row);
        return json({ versions: rows, total: rows.length });
      }
      if (h[2] === "versions" && h[3] !== undefined && method === "GET") {
        const v = list.find((x) => x.version_ix === Number(h[3]));
        return v ? json(v) : json({ error: "Not found", error_type: "not_found" }, 404);
      }
      if (h[2] === "restore" && method === "POST") {
        const b = (body ?? {}) as { version_ix?: number; if_updated_at?: string };
        if (!b.if_updated_at) return json({ error: "precondition_required" }, 428);
        if (b.if_updated_at !== existing.updatedAt) return json({ error: "conflict", error_type: "conflict" }, 409);
        const v = list.find((x) => x.version_ix === b.version_ix);
        if (!v) return json({ error: "Not found", error_type: "not_found" }, 404);
        captureVersion(existing, "restore");
        existing.content = v.content;
        existing.metadata = v.metadata;
        existing.updatedAt = new Date(2026, 5, 1, 0, 0, seq++).toISOString();
        return json({ ...existing, restored_from: v.version_ix, recreated: false });
      }
    }

    // /notes/:id item
    const m = sub.match(/^\/notes\/([^/]+)$/);
    if (m) {
      const asked = decodeURIComponent(m[1]!);
      // Like the real vault: by id, then by (case-insensitive) path, then by a UNIQUE title.
      const titled = [...store.values()].filter((n) => typeof n.metadata?.title === "string" && (n.metadata.title as string).toLowerCase() === asked.toLowerCase());
      const existing = store.get(asked) ?? [...store.values()].find((n) => !!n.path && n.path.toLowerCase() === asked.toLowerCase()) ?? (titled.length === 1 ? titled[0] : undefined);
      const id = existing?.id ?? asked;
      if (method === "GET") {
        return existing ? json(existing) : new Response("not found", { status: 404 });
      }
      if (method === "PATCH") {
        if (!existing) return new Response("not found", { status: 404 });
        if (fv.conflictOnNextWrite) {
          fv.conflictOnNextWrite = false;
          return new Response("conflict", { status: 409 });
        }
        const b = (body ?? {}) as Record<string, unknown>;
        if (b.if_updated_at !== undefined && b.if_updated_at !== existing.updatedAt) return json({error:"conflict"},409);
        captureVersion(existing, "update");
        const linkOps = b.links as {add?: Array<{target:string;relationship:string}>;remove?: Array<{target:string;relationship:string}>} | undefined;
        if (linkOps) {
          const links = [...(existing.links ?? [])];
          for (const link of linkOps.remove ?? []) {
            const index = links.findIndex(e=>e.sourceId===id && e.targetId===link.target && e.relationship===link.relationship);
            if(index>=0)links.splice(index,1);
          }
          for (const link of linkOps.add ?? []) {
            if(!links.some(e=>e.sourceId===id && e.targetId===link.target && e.relationship===link.relationship))links.push({sourceId:id,targetId:link.target,relationship:link.relationship});
          }
          existing.links=links;
        }
        // tag add/remove form
        const tagsOp = b.tags as { add?: string[]; remove?: string[] } | undefined;
        if (tagsOp) {
          const set = new Set(existing.tags ?? []);
          for (const t of tagsOp.add ?? []) set.add(t);
          for (const t of tagsOp.remove ?? []) set.delete(t);
          existing.tags = [...set];
        }
        if (typeof b.content === "string") existing.content = b.content;
        if (b.metadata && typeof b.metadata === "object") existing.metadata = mergeMetadata(existing.metadata, b.metadata as Record<string, unknown>);
        if (typeof b.path === "string") existing.path = b.path;
        existing.updatedAt = new Date(2026, 5, 1, 0, 0, seq++).toISOString();
        return json(existing);
      }
      if (method === "DELETE") {
        if (!existing) return new Response("not found", { status: 404 });
        store.delete(id);
        return json({ ok: true });
      }
    }

    // Anything else under /api — used to prove the OWNER passthrough reaches
    // arbitrary vault paths (non-owners never get here; they 403 at the gateway).
    return json({ passthrough: sub, method });
  }) as typeof fetch;

  return fv;
}

// ---- identity / grant factories (operate on the in-memory db) ----

export function resetDb(): void {
  db.exec(
    "DELETE FROM canvas_relation_vaults; DELETE FROM canvas_assertions; DELETE FROM canvas_relations; DELETE FROM canvas_relation_sources; DELETE FROM canvas_relation_jobs; DELETE FROM canvas_relation_receipts; DELETE FROM grants; DELETE FROM sessions; DELETE FROM users; DELETE FROM magic_links; DELETE FROM capabilities; DELETE FROM collab_docs; DELETE FROM invites; DELETE FROM memberships; DELETE FROM tenant_secrets;" +
      // Horizon B/C tables — kept in sync so every test file starts from a clean db.
      "DELETE FROM publication_presentations; DELETE FROM publication_presentation_history; DELETE FROM publications; DELETE FROM peers; DELETE FROM peer_pairings; DELETE FROM spaces; DELETE FROM federated_notes; DELETE FROM federation_outbox; DELETE FROM pending_suggestions; DELETE FROM federation_mirror_requests; DELETE FROM settings; DELETE FROM prism_vaults; DELETE FROM workspaces; DELETE FROM vault_workspaces; DELETE FROM vault_mirrors; DELETE FROM mcp_tokens; DELETE FROM mcp_token_revocations; DELETE FROM governance_sig_ledger;" +
      "DELETE FROM device_tokens; DELETE FROM device_auth_codes; DELETE FROM device_auth_requests;" +
      "DELETE FROM push_subscriptions; DELETE FROM apns_tokens; DELETE FROM agent_policy_audit; DELETE FROM agent_followups; DELETE FROM agent_events; DELETE FROM agent_turns; DELETE FROM agent_cost_log; DELETE FROM agent_sessions;" +
      "DELETE FROM mcp_pats; DELETE FROM action_audit; DELETE FROM action_idempotency; DELETE FROM collab_command_receipts;" +
      "DELETE FROM github_sync_configs; DELETE FROM notion_db_sync_configs; DELETE FROM sync_audit;" +
      "DELETE FROM identity_candidates;" + // created by src/identity-store.ts (imported above)
      "DELETE FROM people_agent_decisions; DELETE FROM people_merge_recommendations;" + // src/people-agent-store.ts
      "DELETE FROM page_preferences;" + // src/pages.ts
      TRANSCRIPT_LINK_TABLES.map((t) => `DELETE FROM ${t};`).join(" "),
  );
}

/** Create a session row and return its id (the cookie value). */
export function makeSession(email: string): string {
  const id = randomBytes(16).toString("base64url");
  createSession(id, email, 60 * 60 * 1000);
  return id;
}

export const sessionCookie = (id: string): string => `prism_session=${id}`;

/** Grant a signed-in user a level on a note or tag. */
export function grantUser(email: string, resourceType: ResourceType, resource: string, level: Level): void {
  addGrant({ subject_type: "user", subject: email.toLowerCase(), resource_type: resourceType, resource, level, created_by: "test" });
}

/** Create a capability link (db grant + signed token) and return the token. */
export function makeCapability(resourceType: ResourceType, resource: string, level: Level, expMs = Date.now() + 3_600_000): string {
  const id = `cap-${randomBytes(6).toString("hex")}`;
  addGrant({ subject_type: "link", subject: id, resource_type: resourceType, resource, level, created_by: "test" });
  return signCapability({ id, exp: expMs });
}
