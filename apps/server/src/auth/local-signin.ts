/**
 * One-time LOCAL sign-in links for the server owner (launch plan Phase 2, "Owner sign-in
 * without email"; the smallest form of decision D-E's host-control path, docs/onboarding.md).
 *
 * `prism signin` (the host CLI) proves it runs on this computer AS the install's user by
 * presenting the HOST KEY: 32 random bytes the server writes at every start to a 0600 file in
 * its own data folder (beside `prism-server.db`, `HOST_KEY_FILE` to choose another place). Only
 * a process that can read the install's files can read it — the same boundary as `.env` and the
 * database, which such a process can read anyway. The key is never in `.env` (so the "edit
 * server config" route and every config read never see it), never sent to a browser, and is
 * replaced at every start (a copy that leaked dies with the next restart).
 *
 * The link it gets back is a credential for ten minutes: single use, only the SHA-256 of its
 * token is stored, it signs in OWNER_EMAIL and nobody else, and it is accepted only on a
 * loopback connection (the socket's own address, not a header) that carries no forwarding
 * header and names a loopback host — so neither the tunnel, Tailscale serve, the LAN nor a
 * DNS-rebinding page can use it, even holding the token.
 *
 * Why not the existing loopback COLLAB_TOKEN path: it is a header heuristic (`isLocalRequest`
 * looks only at forwarding headers, not the socket), it is switched off whenever TRUST_LOCAL is
 * off (every https APP_ORIGIN by default, and the host profile in D-E), and COLLAB_TOKEN is
 * handed to the legacy desktop's page script — not something that should mint owner sessions.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Context } from "hono";
import { config } from "../config";
import { db } from "../db";

export const LOCAL_LINK_TTL_MS = 10 * 60_000;
export const LOCAL_LINK_PATH = "/auth/local/signin";
export const LOCAL_MINT_PATH = "/auth/local/link";

db.exec(`
  CREATE TABLE IF NOT EXISTS local_signin_links (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
`);

let clock: () => number = Date.now;
/** Tests move the clock (expiry is decided by it); production = Date.now. */
export function setLocalSigninClock(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ── the host key ─────────────────────────────────────────────────────────────

let hostKeyHash: Buffer | null = null;
let hostKeyFile: string | null = null;

/** Where the host key lives: `HOST_KEY_FILE`, else beside the database; none for `:memory:`. */
export function hostKeyPath(env: NodeJS.ProcessEnv = process.env, dbPath = config.dbPath): string | null {
  const explicit = env.HOST_KEY_FILE;
  if (explicit !== undefined) return explicit.trim() ? resolve(explicit.trim()) : null;
  if (!dbPath || dbPath === ":memory:" || dbPath.startsWith("file:")) return null;
  return join(dirname(resolve(dbPath)), "host-signin.key");
}

/**
 * Write a fresh host key (0600, atomically) and keep its hash in memory. Called once when the
 * app is built. Local sign-in stays OFF (and says why) when there is no place for the key or
 * the folder could be written by someone else.
 */
export function initLocalSignin(path: string | null = hostKeyPath()): { enabled: boolean; reason?: string } {
  hostKeyHash = null;
  hostKeyFile = null;
  if (!path) return { enabled: false, reason: "no data folder (in-memory database)" };
  try {
    const dir = dirname(path);
    const st = statSync(dir);
    if (!st.isDirectory()) return { enabled: false, reason: "the key folder is not a folder" };
    if ((st.mode & 0o022) !== 0) return { enabled: false, reason: `the key folder ${dir} is writable by others` };
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { enabled: false, reason: `the key folder ${dir} belongs to another user` };
    const key = randomBytes(32).toString("base64url");
    const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, key + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    try {
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    hostKeyHash = createHash("sha256").update(key, "utf8").digest();
    hostKeyFile = path;
    return { enabled: true };
  } catch (e) {
    return { enabled: false, reason: (e as Error).message };
  }
}

/** Tests: set the key directly (no file). `null` turns local sign-in off. */
export function setHostKeyForTests(key: string | null): void {
  hostKeyHash = key ? createHash("sha256").update(key, "utf8").digest() : null;
  hostKeyFile = key ? "(test)" : null;
}

export function localSigninEnabled(): boolean {
  return hostKeyHash !== null;
}

export function localSigninKeyFile(): string | null {
  return hostKeyFile;
}

/** Constant-time: is `presented` the current host key? */
export function isHostKey(presented: string | undefined | null): boolean {
  if (!hostKeyHash || !presented) return false;
  const h = createHash("sha256").update(presented, "utf8").digest();
  return h.length === hostKeyHash.length && timingSafeEqual(h, hostKeyHash);
}

// ── the loopback-only transport ──────────────────────────────────────────────

/** Headers a proxy (Cloudflare tunnel, Tailscale serve/Funnel, nginx, …) adds. Any of them → not local. */
const FORWARDING_HEADERS = [
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "tailscale-user-login",
  "tailscale-funnel-request",
];

export function isLoopbackAddress(a: string | null | undefined): boolean {
  if (!a) return false;
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(a);
}

/** The peer address of the TCP connection (node-server's `c.env.incoming`), never a header. */
function socketAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined;
  const a = env && typeof env === "object" ? env.incoming?.socket?.remoteAddress : undefined;
  return typeof a === "string" ? a : null;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why this request is NOT a direct loopback request to this server, or null when it is:
 * the socket's peer is loopback, no proxy header is present, and the Host names a loopback
 * address on this server's port (a rebinding page or a proxy that keeps the public Host fails).
 */
export function loopbackRefusal(c: Context): string | null {
  if (!isLoopbackAddress(socketAddress(c))) return "not a loopback connection";
  for (const h of FORWARDING_HEADERS) if (c.req.header(h) !== undefined) return "forwarded by a proxy";
  let url: URL;
  try {
    url = new URL(c.req.url);
  } catch {
    return "bad request URL";
  }
  const hostHeader = c.req.header("host");
  if (hostHeader !== undefined && hostHeader.toLowerCase() !== url.host.toLowerCase()) return "host mismatch";
  if (!LOOPBACK_NAMES.has(url.hostname.toLowerCase())) return "not a loopback host name";
  if ((url.port || "80") !== String(config.port)) return "not this server's port";
  return null;
}

/** The origin a local link is made for: APP_ORIGIN when it is this machine's own address, else localhost. */
export function localOrigin(): string {
  try {
    const u = new URL(config.appOrigin);
    if (u.protocol === "http:" && LOOPBACK_NAMES.has(u.hostname.toLowerCase()) && (u.port || "80") === String(config.port)) return u.origin;
  } catch {
    /* fall through */
  }
  return `http://localhost:${config.port}`;
}

// ── links ────────────────────────────────────────────────────────────────────

export interface MintedLink {
  id: string;
  url: string;
  expiresAt: number;
}

/**
 * Mint a link for OWNER_EMAIL. Any earlier unused link is retired (one live link at a time).
 * Only the token's SHA-256 is stored.
 */
export function mintLocalLink(): MintedLink {
  const now = clock();
  db.prepare("DELETE FROM local_signin_links WHERE expires_at < ?").run(now - 24 * 60 * 60_000);
  db.prepare("UPDATE local_signin_links SET used_at = ? WHERE used_at IS NULL").run(now);
  const token = randomBytes(32).toString("base64url");
  const id = `ls_${randomBytes(9).toString("base64url")}`;
  const expiresAt = now + LOCAL_LINK_TTL_MS;
  db.prepare("INSERT INTO local_signin_links (id, token_hash, email, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)").run(id, sha256(token), config.ownerEmail, now, expiresAt);
  return { id, url: `${localOrigin()}${LOCAL_LINK_PATH}?token=${encodeURIComponent(token)}`, expiresAt };
}

/**
 * Spend a link: atomically marks it used. Returns the email it signs in (always OWNER_EMAIL
 * as it is NOW — a link minted before the owner changed signs nobody in), or null.
 */
export function redeemLocalLink(token: string): { id: string; email: string } | null {
  if (!token || token.length > 200) return null;
  const now = clock();
  const hash = sha256(token);
  const row = db.prepare("SELECT id, email, expires_at, used_at FROM local_signin_links WHERE token_hash = ?").get(hash) as
    | { id: string; email: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row || row.used_at !== null || row.expires_at <= now) return null;
  const spent = db.prepare("UPDATE local_signin_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").run(now, hash, now);
  if (spent.changes !== 1) return null;
  if (row.email !== config.ownerEmail) return null;
  return { id: row.id, email: row.email };
}
