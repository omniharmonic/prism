// The reviewer demo server's seed and wipe, over the demo Prism Server's own HTTP API.
// Dependency-free; every network call goes through an injected `fetch`, so
// apps/server/test/demo-server.test.ts runs it against the real app over the fake vault.
//
// How it signs in: exactly like `prism signin` — the host key the demo server wrote into its
// own data folder (readable only by the demo macOS user) buys a one-time owner sign-in link on
// loopback, and the link is spent on loopback for an owner session. No token is copied, nothing
// is enabled on the server for this (TRUST_LOCAL stays off), and nothing secret is printed except
// the reviewer's new password, once.
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SAMPLE_TAG, sampleNotes } from "./content.mjs";

/** The production Parachute hub, vault and Prism Server ports. The demo never talks to them. */
export const PRODUCTION_PORTS = Object.freeze([1939, 1940, 8787]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why `base` is not a demo server address this script may talk to — or null. */
export function baseProblem(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    return `${base} is not a URL`;
  }
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) return `${base}: the seed talks only to the demo server on loopback (http://127.0.0.1:<port>)`;
  const port = Number(u.port || 80);
  if (PRODUCTION_PORTS.includes(port)) return `port ${port} is a PRODUCTION port (${PRODUCTION_PORTS.join(", ")}); the demo server must run on its own port`;
  return null;
}

/** Why a demo install's settings are unsafe — or null. `env` = the demo install's config/.env. */
export function demoEnvProblem(env) {
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1024) return "PORT is not set in the demo install's .env";
  if (PRODUCTION_PORTS.includes(port)) return `the demo server's PORT ${port} is a production port`;
  for (const key of ["PARACHUTE_URL", "PARACHUTE_HUB_ORIGIN"]) {
    if (!env[key]) return `${key} is not set in the demo install's .env (the demo runs its own Parachute)`;
    let u;
    try {
      u = new URL(env[key]);
    } catch {
      return `${key} is not a URL`;
    }
    const p = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (PRODUCTION_PORTS.includes(p)) return `${key} points at port ${p}, a PRODUCTION Parachute/Prism port`;
  }
  if (!env.PARACHUTE_HOME) return "PARACHUTE_HOME is not set in the demo install's .env";
  return null;
}

/** Where the demo server keeps its host key (the server's own rule, scripts/lib/local-signin-client.ts). */
export function hostKeyFile(env, configDir) {
  const abs = (p) => (isAbsolute(p) ? p : resolve(configDir, p));
  if (env.HOST_KEY_FILE !== undefined) return env.HOST_KEY_FILE.trim() ? abs(env.HOST_KEY_FILE.trim()) : null;
  const db = env.DB_PATH ?? "./prism-server.db";
  if (!db || db === ":memory:" || db.startsWith("file:")) return null;
  return join(dirname(abs(db)), "host-signin.key");
}

/** A reviewer password: 24 characters from 18 random bytes (the server needs ≥ 10). */
export function generatePassword() {
  return randomBytes(18).toString("base64url");
}

export function isEmail(s) {
  return typeof s === "string" && /^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s) && s.length <= 254;
}

function client(fetchFn, base, cookie) {
  return async (method, path, body) => {
    const r = await fetchFn(`${base}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    let json = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    return { status: r.status, json, headers: r.headers };
  };
}

/** Is the demo server up? `{live, vault}` from /health?live=1 and /health. */
export async function health({ fetch: fetchFn, base }) {
  const call = client(fetchFn, base);
  const live = await call("GET", "/health?live=1").catch(() => ({ status: 0 }));
  const full = await call("GET", "/health").catch(() => ({ status: 0 }));
  return { live: live.status === 200, vault: full.status === 200 };
}

/** An owner session on loopback, through the host key (the `prism signin` path). Returns a Cookie header. */
export async function ownerSession({ fetch: fetchFn, base, hostKey }) {
  const mint = await fetchFn(`${base}/auth/local/link`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostKey}` },
    body: "{}",
    redirect: "manual",
  });
  const body = await mint.json().catch(() => ({}));
  if (mint.status !== 201 || typeof body.url !== "string") throw new Error(`the demo server refused a sign-in link (HTTP ${mint.status}${body.error ? `, ${body.error}` : ""})`);
  // Spend it at OUR base (the same server), never at whatever host the link names.
  const token = new URL(body.url).searchParams.get("token") ?? "";
  const spent = await fetchFn(`${base}/auth/local/signin?token=${encodeURIComponent(token)}`, { redirect: "manual" });
  const setCookie = typeof spent.headers.getSetCookie === "function" ? spent.headers.getSetCookie().join("\n") : (spent.headers.get("set-cookie") ?? "");
  const sid = /prism_session=([^;\s]+)/.exec(setCookie)?.[1];
  if (!sid) throw new Error(`the sign-in link did not give a session (HTTP ${spent.status})`);
  return `prism_session=${sid}`;
}

/** Delete EVERY note in the demo vault (the reviewer's pages too). Returns the count. */
export async function wipeVault({ fetch: fetchFn, base, cookie, log = () => {} }) {
  const call = client(fetchFn, base, cookie);
  let deleted = 0;
  for (let pass = 0; pass < 20; pass++) {
    const list = await call("GET", "/api/notes?include_content=false&limit=1000");
    if (list.status !== 200 || !Array.isArray(list.json)) throw new Error(`could not list the demo vault (HTTP ${list.status})`);
    if (!list.json.length) return deleted;
    for (const n of list.json) {
      const r = await call("DELETE", `/api/notes/${encodeURIComponent(n.id)}`);
      if (r.status >= 300 && r.status !== 404) throw new Error(`could not delete a note (HTTP ${r.status}${r.json?.error ? `, ${r.json.error}` : ""})`);
      deleted++;
    }
    log(`  deleted ${deleted} note(s)`);
  }
  throw new Error("the demo vault still lists notes after 20 passes");
}

/** Create (or bring back) the sample notes. Idempotent: an existing page at the path is updated in place. */
export async function seedContent({ fetch: fetchFn, base, cookie, notes = sampleNotes(), log = () => {} }) {
  const call = client(fetchFn, base, cookie);
  let n = 0;
  for (const note of notes) {
    const r = await call("POST", "/api/notes", { ...note, if_exists: "update" });
    if (r.status >= 300) throw new Error(`could not write "${note.path}" (HTTP ${r.status}${r.json?.error ? `, ${r.json.error}` : ""})`);
    n++;
  }
  log(`  ${n} sample page(s) written (tag ${SAMPLE_TAG})`);
  return n;
}

/**
 * The reviewer: a workspace MEMBER (not an admin, not the owner — so App Review can try
 * Settings → Account → Delete account) with edit access to the whole demo vault. A new
 * account gets `password`; an existing account is left alone (its password unchanged).
 */
export async function ensureReviewer({ fetch: fetchFn, base, cookie, email, name, password }) {
  if (!isEmail(email)) throw new Error(`reviewer email "${email}" is not an email address`);
  const call = client(fetchFn, base, cookie);
  const member = await call("PUT", "/acl/workspace/members", { email, vaultId: "primary", role: "member" });
  if (member.status !== 200) throw new Error(`could not make the reviewer a member (HTTP ${member.status}${member.json?.error ? `, ${member.json.error}` : ""})`);
  const access = await call("PUT", "/acl/workspace/access", { email, vaultId: "primary", level: "edit" });
  if (access.status !== 200) throw new Error(`could not give the reviewer access (HTTP ${access.status}${access.json?.error ? `, ${access.json.error}` : ""})`);
  if (!member.json?.inviteUrl) return { created: false };
  const token = new URL(member.json.inviteUrl).searchParams.get("token") ?? "";
  const reg = await client(fetchFn, base)("POST", "/auth/register", { token, name, password });
  if (reg.status !== 200) throw new Error(`could not register the reviewer account (HTTP ${reg.status}${reg.json?.error ? `, ${reg.json.error}` : ""})`);
  return { created: true };
}

/** The whole seed. `wipe` first deletes every note (the reset path). Returns what was done; the password only when an account was created. */
export async function seedDemo({ fetch: fetchFn, base, hostKey, reviewer, wipe = false, wipeOnly = false, dryRun = false, log = () => {} }) {
  if (wipeOnly) wipe = true;
  const problem = baseProblem(base);
  if (problem) throw new Error(problem);
  const h = await health({ fetch: fetchFn, base });
  if (!h.live) throw new Error(`the demo server does not answer at ${base} (prism start --prefix <demo prefix>)`);
  if (!h.vault) throw new Error("the demo server answers, but its vault does not (check the demo Parachute agent)");
  const notes = sampleNotes();
  if (dryRun) {
    log(`dry run: ${base} is up (vault reachable). The real run would:`);
    log("  sign in as the demo owner with the demo server's host key (loopback, one-time link)");
    if (wipe) log("  delete EVERY note in the demo vault");
    if (wipeOnly) return { dryRun: true, notes: 0 };
    for (const n of notes) log(`  write ${n.path}${n.metadata?.prism_type === "database" ? " (database)" : ""}`);
    log(`  reviewer ${reviewer.email}: workspace member + edit on the demo vault; a NEW account gets a generated password, printed once`);
    return { dryRun: true, notes: notes.length };
  }
  const cookie = await ownerSession({ fetch: fetchFn, base, hostKey });
  const wiped = wipe ? await wipeVault({ fetch: fetchFn, base, cookie, log }) : 0;
  if (wipeOnly) return { dryRun: false, wiped, written: 0, reviewerCreated: false };
  const written = await seedContent({ fetch: fetchFn, base, cookie, notes, log });
  const password = generatePassword();
  const r = await ensureReviewer({ fetch: fetchFn, base, cookie, email: reviewer.email, name: reviewer.name, password });
  return { dryRun: false, wiped, written, reviewerCreated: r.created, ...(r.created ? { password } : {}) };
}
