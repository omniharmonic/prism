/**
 * Push relay client (decision D-I; the relay itself is packages/push-relay).
 *
 * The App Store build of the Prism Client takes APNs only from the publisher's
 * key. A self-hosted server cannot hold that key, so when NO direct APNs value is
 * set (APNS_KEY_PATH / APNS_KEY_ID / APNS_TEAM_ID all empty) and PUSH_RELAY_URL is
 * set, `sendApns` (apns.ts) hands each Prism notification to the relay as
 * `{deviceToken, environment, kind, id}` — never text: the relay writes the
 * notification itself with the same generic copy this server uses. A server with
 * its own APNs key (the owner's) keeps sending directly and never calls the relay.
 * Omni notifications carry a headline and summary, so they never go through the
 * relay (`apnsEnabled("omni")` is false in relay mode).
 *
 * IDENTITY: an Ed25519 keypair in PUSH_RELAY_KEY_PATH (PKCS#8 PEM, must be 0600),
 * created by `npm run push-relay:register -w @prism/server`, which also registers
 * the public key. Every request is signed (see packages/push-relay/src/auth.ts for
 * the canonical string); the relay remembers the public key only.
 *
 * OUTCOMES: sent · pruned (the relay says the token is dead: the row is dropped,
 * like a direct 410) · failed. 503 / 429 / network errors are retried like direct
 * sends (MAX_RETRIES, capped backoff); a Retry-After longer than the backoff cap
 * gives up for this notification.
 *
 * PRIVACY: the device token and ids are never logged (logs use `tokenRef`).
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config";

export const SIGNING_CONTEXT = "prism-push-relay-v1";
export const RELAY_TIMEOUT_MS = 10_000;

export type RelayKind = "notification" | "agent" | "agent-attention" | "test";
/** What a notification is, in the relay's vocabulary: a kind and an opaque id. Nothing else. */
export interface RelayMessage {
  kind: RelayKind;
  id?: string;
}

export interface RelayRequest {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface RelayResponse {
  status: number;
  body: string;
  retryAfterS?: number;
}
export interface RelayTransport {
  send(req: RelayRequest): Promise<RelayResponse>;
}

/** The first `max` bytes of a body, then the stream is cancelled (a relay cannot make us buffer more). */
async function readAtMost(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/** The real transport: fetch, no redirects, a timeout, a bounded body read. */
export const fetchTransport: RelayTransport = {
  async send(r) {
    const res = await fetch(r.url, {
      method: r.method,
      headers: r.headers,
      body: r.body,
      redirect: "error",
      signal: AbortSignal.timeout(r.timeoutMs),
    });
    const text = await readAtMost(res, 4096);
    const ra = Number(res.headers.get("retry-after"));
    return { status: res.status, body: text, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : undefined };
  },
};

interface Overrides {
  url?: string;
  keyPath?: string;
  transport?: RelayTransport;
  now?: () => number;
}
let o: Overrides = {};
let loaded: RelayKey | null = null;

export function configurePushRelay(next: Overrides): void {
  o = { ...o, ...next };
  loaded = null;
}
export function _resetPushRelay(): void {
  o = {};
  loaded = null;
}

const now = () => (o.now ?? Date.now)();
export const relayTransport = (): RelayTransport => o.transport ?? fetchTransport;

/** Default key file: beside the database (none for an in-memory database). */
export function relayKeyPath(): string {
  if (o.keyPath !== undefined) return o.keyPath;
  if (config.pushRelayKeyPath) return config.pushRelayKeyPath;
  return config.dbPath && config.dbPath !== ":memory:" ? join(dirname(config.dbPath), "push-relay.key") : "";
}

/** The relay's origin: https (or http on a loopback host), no path, credentials, query or fragment. */
export function relayBaseUrl(raw = o.url ?? config.pushRelayUrl): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  // An origin only: the relay's routes are fixed (/v1/…).
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return u.origin;
}

export type RelayKey =
  | { ok: true; privateKey: KeyObject; publicKey: string; serverId: string }
  | { ok: false; configured: boolean; reason: string };

/** Raw Ed25519 public key (32 bytes) as base64url. */
export const rawPublicKey = (k: KeyObject): string => (createPublicKey(k).export({ format: "jwk" }) as { x: string }).x;
/** Same derivation as the relay (auth.ts serverIdFor). */
export const serverIdFor = (publicKeyB64url: string): string =>
  createHash("sha256").update(Buffer.from(publicKeyB64url, "base64url")).digest("base64url").slice(0, 22);

/** Load + validate the relay key once. Reasons never quote the file. */
export function relayKey(): RelayKey {
  if (loaded) return loaded;
  const url = o.url ?? config.pushRelayUrl;
  if (!url) return (loaded = { ok: false, configured: false, reason: "PUSH_RELAY_URL unset" });
  if (!relayBaseUrl(url)) return (loaded = { ok: false, configured: true, reason: "PUSH_RELAY_URL must be an https origin (no path, credentials, query or fragment)" });
  const p = relayKeyPath();
  if (!p) return (loaded = { ok: false, configured: true, reason: "no relay key file (set PUSH_RELAY_KEY_PATH)" });
  try {
    const st = statSync(p);
    if (!st.isFile()) return (loaded = { ok: false, configured: true, reason: "the relay key is not a regular file" });
    if ((st.mode & 0o077) !== 0) return (loaded = { ok: false, configured: true, reason: "the relay key file must be chmod 600" });
    const privateKey = createPrivateKey(readFileSync(p));
    if (privateKey.asymmetricKeyType !== "ed25519") return (loaded = { ok: false, configured: true, reason: "the relay key is not an Ed25519 private key" });
    const publicKey = rawPublicKey(privateKey);
    return (loaded = { ok: true, privateKey, publicKey, serverId: serverIdFor(publicKey) });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return (loaded = {
      ok: false,
      configured: true,
      reason: code === "ENOENT" ? "no relay key yet — run npm run push-relay:register -w @prism/server" : code ? `the relay key is unreadable (${code})` : "the relay key could not be parsed",
    });
  }
}

export const pushRelayEnabled = (): boolean => relayKey().ok;

/** Build the four signing headers for one request. */
export function signRelayRequest(key: { privateKey: KeyObject; serverId: string }, method: string, path: string, body: string, at = now()): Record<string, string> {
  const ts = String(at);
  const nonce = randomBytes(16).toString("base64url");
  const msg = [SIGNING_CONTEXT, method.toUpperCase(), path, ts, nonce, createHash("sha256").update(body).digest("hex")].join("\n");
  return {
    "x-relay-server": key.serverId,
    "x-relay-timestamp": ts,
    "x-relay-nonce": nonce,
    "x-relay-signature": cryptoSign(null, Buffer.from(msg), key.privateKey).toString("base64url"),
  };
}

/** One signed request to the relay. `path` is the relay's own path (e.g. /v1/send). */
export async function relayCall(
  method: RelayRequest["method"],
  path: string,
  body: string | undefined,
  opts: { key?: RelayKey; url?: string; extraHeaders?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RelayResponse> {
  const key = opts.key ?? relayKey();
  if (!key.ok) throw new Error(key.reason);
  const base = relayBaseUrl(opts.url ?? o.url ?? config.pushRelayUrl);
  if (!base) throw new Error("PUSH_RELAY_URL is not a valid relay URL");
  const headers: Record<string, string> = { ...signRelayRequest(key, method, path, body ?? ""), ...(opts.extraHeaders ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  return relayTransport().send({ url: `${base}${path}`, method, headers, body, timeoutMs: opts.timeoutMs ?? RELAY_TIMEOUT_MS });
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The relay refuses anything else; checking first keeps a bad id from spending budget. */
export function validRelayMessage(m: RelayMessage): boolean {
  if (m.kind === "test") return m.id === undefined;
  if (m.kind === "notification") return typeof m.id === "string" && NOTIFICATION_ID.test(m.id);
  return (m.kind === "agent" || m.kind === "agent-attention") && typeof m.id === "string" && UUID.test(m.id);
}

/** The exact body sent for one notification: the relay's strict schema, nothing more. */
export function relaySendBody(row: { token: string; environment: "sandbox" | "production" }, m: RelayMessage): string {
  return JSON.stringify(m.kind === "test"
    ? { deviceToken: row.token, environment: row.environment, kind: m.kind }
    : { deviceToken: row.token, environment: row.environment, kind: m.kind, id: m.id });
}
