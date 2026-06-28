/**
 * Shared e2e helpers: env loading + the two trusted API seams the specs drive
 * over localhost.
 *
 *  - `vault.*`  — direct Parachute REST (Bearer PARACHUTE_TOKEN) to provision and
 *                 tear down throwaway `_e2e*` notes. This is the same surface the
 *                 server's own verify-* scripts use.
 *  - `acl.*`    — the owner-only Prism Server /acl endpoints (Bearer
 *                 COLLAB_TOKEN || PARACHUTE_TOKEN, the desktop-owner path in
 *                 actor.ts) to publish/unpublish a tag and mint capability links.
 *
 * The browser under test (Playwright) holds NO token; it only ever sees the
 * public /api/p/* surface or a `?t=` capability link, exactly like a real
 * recipient. The tokens here live only in the test process.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Parse a dotenv file into a flat record (KEY=VALUE, # comments, quotes stripped). */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = parseEnvFile(resolve(__dirname, "../../server/.env"));
// process.env wins over the file so CI / overrides work.
const env = (k: string, fallback = ""): string => process.env[k] ?? fileEnv[k] ?? fallback;

export const PARACHUTE_URL = env("PARACHUTE_URL", "http://localhost:1940").replace(/\/+$/, "");
export const PARACHUTE_VAULT = env("PARACHUTE_VAULT", "default");
export const PARACHUTE_TOKEN = env("PARACHUTE_TOKEN");
/** Owner Bearer for /acl — matches actor.ts (`collabToken || parachuteToken`). */
export const OWNER_TOKEN = env("COLLAB_TOKEN") || PARACHUTE_TOKEN;
export const APP_ORIGIN = env("APP_ORIGIN", "http://localhost:8787");
export const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${env("PORT", "8787")}`;

/** True when the server issues `secure` unlock cookies (APP_ORIGIN is https) or
 *  the run is explicitly flagged https. Used to gate the password-unlock cookie
 *  assertion (a `secure` cookie may not stick on a plain-http origin). */
export const E2E_HTTPS = process.env.E2E_HTTPS === "1" || APP_ORIGIN.startsWith("https");

/** Assert a vault token is present — called LAZILY by the live helpers, not at
 *  module load. Playwright collects (imports) every spec before `--grep-invert
 *  @live` filters, so a top-level throw would break the no-vault CI job even
 *  though all specs are @live. The @live tests that actually hit the vault call
 *  this; the no-vault CI run never does. */
function requireToken(): void {
  if (!PARACHUTE_TOKEN) {
    throw new Error(
      "e2e: PARACHUTE_TOKEN missing — could not read apps/server/.env (run from a configured server, or set PARACHUTE_TOKEN).",
    );
  }
}

interface Note {
  id: string;
  content: string;
  path: string | null;
  tags: string[] | null;
}

async function vaultReq(path: string, init?: RequestInit): Promise<Response> {
  requireToken();
  const r = await fetch(`${PARACHUTE_URL}/vault/${PARACHUTE_VAULT}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PARACHUTE_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!r.ok) throw new Error(`vault ${init?.method ?? "GET"} ${path}: ${r.status} ${await r.text().catch(() => "")}`);
  return r;
}

export const vault = {
  async createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note> {
    return (await vaultReq("/notes", { method: "POST", body: JSON.stringify(p) })).json() as Promise<Note>;
  },
  async addTags(id: string, tags: string[]): Promise<void> {
    await vaultReq(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ tags: { add: tags }, force: true }) });
  },
  async removeTags(id: string, tags: string[]): Promise<void> {
    await vaultReq(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ tags: { remove: tags }, force: true }) });
  },
  async deleteNote(id: string): Promise<void> {
    await vaultReq(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async listByTag(tag: string): Promise<Note[]> {
    return (await vaultReq(`/notes?tag=${encodeURIComponent(tag)}&limit=1000`)).json() as Promise<Note[]>;
  },
};

async function aclReq(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  requireToken();
  const r = await fetch(`${BASE_URL}/acl${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

export const acl = {
  /** Publish a tag as a public site. Returns the slug. */
  async publishTag(tag: string, opts: { title?: string; password?: string; homeNoteId?: string } = {}): Promise<string> {
    const r = await aclReq(`/tags/${encodeURIComponent(tag)}/publish`, { method: "POST", body: JSON.stringify(opts) });
    if (r.status !== 200 || !r.body?.slug) throw new Error(`publish ${tag} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.slug as string;
  },
  /** Unpublish a tag (idempotent). Best-effort. */
  async unpublishTag(tag: string): Promise<void> {
    await aclReq(`/tags/${encodeURIComponent(tag)}/publish`, { method: "DELETE" });
  },
  /** List publications (owner view). */
  async publications(): Promise<Array<{ slug: string; tag: string; passwordRequired: boolean }>> {
    const r = await aclReq("/publications");
    return Array.isArray(r.body) ? r.body : [];
  },
  /** Mint a capability link for a note; returns the bare `?t=` token + its cap id. */
  async createLink(noteId: string, level: string): Promise<{ token: string; capId: string }> {
    const r = await aclReq(`/notes/${encodeURIComponent(noteId)}/links`, { method: "POST", body: JSON.stringify({ level }) });
    if (r.status !== 200 || !r.body?.url || !r.body?.id) throw new Error(`createLink ${noteId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const t = new URL(r.body.url as string).searchParams.get("t");
    if (!t) throw new Error(`createLink ${noteId}: no ?t= in ${r.body.url}`);
    return { token: t, capId: r.body.id as string };
  },
  /** Full sharing picture for a note (used to verify a link was removed). */
  async noteShare(noteId: string): Promise<{ links: Array<{ id: string }> }> {
    const r = await aclReq(`/notes/${encodeURIComponent(noteId)}`);
    return r.body ?? { links: [] };
  },
  /** Remove a capability link by its id. */
  async deleteLink(noteId: string, capId: string): Promise<void> {
    await aclReq(`/notes/${encodeURIComponent(noteId)}/links/${encodeURIComponent(capId)}`, { method: "DELETE" });
  },
};

/** Anonymous public publication API (no token) — what the browser actually hits. */
export const pub = {
  async manifest(slug: string): Promise<{ status: number; body: any }> {
    const r = await fetch(`${BASE_URL}/api/p/${encodeURIComponent(slug)}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  },
  async graph(slug: string): Promise<{ status: number; body: any }> {
    const r = await fetch(`${BASE_URL}/api/p/${encodeURIComponent(slug)}/graph`);
    return { status: r.status, body: await r.json().catch(() => null) };
  },
  async note(slug: string, id: string): Promise<{ status: number; body: any }> {
    const r = await fetch(`${BASE_URL}/api/p/${encodeURIComponent(slug)}/notes/${encodeURIComponent(id)}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  },
};
