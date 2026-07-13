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
  put(note: Partial<FakeNote> & { id: string }): FakeNote;
  restore(): void;
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
  const fv: FakeVault = {
    notes: new Map(),
    tags: [],
    calls: [],
    healthy: true,
    conflictOnNextWrite: false,
    put(note) {
      const n = fakeNote(note);
      fv.notes.set(n.id, n);
      return n;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };

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

    const API = "/vault/default/api";
    if (!url.pathname.startsWith(API)) return new Response("not found", { status: 404 });
    const sub = url.pathname.slice(API.length); // "/notes", "/notes/:id", "/tags", ...

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
        let list = [...fv.notes.values()];
        if (tagFilters.length) list = list.filter((n) => tagFilters.every((t) => (n.tags ?? []).includes(t)));
        if (search) list = list.filter((n) => n.content.toLowerCase().includes(search.toLowerCase()));
        return json(list);
      }
      if (method === "POST") {
        const b = (body ?? {}) as Partial<FakeNote>;
        const id = `new-${++seq}`;
        const n = fv.put({ id, content: b.content ?? "", path: b.path ?? null, metadata: b.metadata ?? null, tags: b.tags ?? [] });
        return json(n);
      }
    }

    // /notes/:id item
    const m = sub.match(/^\/notes\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const existing = fv.notes.get(id);
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
        // tag add/remove form
        const tagsOp = b.tags as { add?: string[]; remove?: string[] } | undefined;
        if (tagsOp) {
          const set = new Set(existing.tags ?? []);
          for (const t of tagsOp.add ?? []) set.add(t);
          for (const t of tagsOp.remove ?? []) set.delete(t);
          existing.tags = [...set];
        }
        if (typeof b.content === "string") existing.content = b.content;
        if (b.metadata && typeof b.metadata === "object") existing.metadata = b.metadata as Record<string, unknown>;
        if (typeof b.path === "string") existing.path = b.path;
        existing.updatedAt = new Date(2026, 5, 1, 0, 0, seq++).toISOString();
        return json(existing);
      }
      if (method === "DELETE") {
        if (!existing) return new Response("not found", { status: 404 });
        fv.notes.delete(id);
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
    "DELETE FROM grants; DELETE FROM sessions; DELETE FROM users; DELETE FROM magic_links; DELETE FROM capabilities; DELETE FROM collab_docs; DELETE FROM invites; DELETE FROM memberships; DELETE FROM tenant_secrets;" +
      // Horizon B/C tables — kept in sync so every test file starts from a clean db.
      "DELETE FROM publications; DELETE FROM peers; DELETE FROM peer_pairings; DELETE FROM spaces; DELETE FROM federated_notes; DELETE FROM federation_outbox; DELETE FROM pending_suggestions; DELETE FROM federation_mirror_requests; DELETE FROM settings; DELETE FROM prism_vaults; DELETE FROM workspaces; DELETE FROM vault_workspaces; DELETE FROM vault_mirrors; DELETE FROM mcp_tokens;",
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
