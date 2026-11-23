/**
 * The relay's HTTP API (the Worker's fetch handler, minus the Cloudflare glue so
 * the tests can drive it directly).
 *
 *   GET    /health                          → {ok, apns}
 *   POST   /v1/servers          signed      → 201 {serverId}         register (idempotent)
 *   GET    /v1/servers/self     signed      → {serverId, createdAt, revoked}
 *   DELETE /v1/servers/self     signed      → {serverId, revoked: true}
 *   POST   /v1/send             signed      → {result: sent|pruned|failed}
 *   GET    /v1/admin/servers/:id            → status          (Bearer ADMIN_TOKEN)
 *   POST   /v1/admin/servers/:id/revoke     → revoke          (Bearer ADMIN_TOKEN)
 *   POST   /v1/admin/servers/:id/restore    → undo a revoke   (Bearer ADMIN_TOKEN)
 *
 * Send outcomes: 200 sent · 200 pruned (the token is dead — drop it) · 200 failed
 * (permanent) · 503 unavailable + Retry-After (APNs busy / down: retry later) ·
 * 429 rate_limited + Retry-After · 401 unauthorized (one answer for unknown
 * server, bad signature, stale timestamp, replayed nonce) · 403 revoked ·
 * 400 bad_request · 413 too_large · 503 paused.
 *
 * Logs carry the server id, the kind and the outcome — never a device token,
 * an id, or anything from a request body.
 */
import { canonicalString, HEADER, serverIdFor, sha256Hex, signedParts, SKEW_MS, verifySignature } from "./auth";
import { apnsConfigProblem, sendToApns, type ApnsConfig, type FetchLike } from "./apns";
import { MAX_BODY_BYTES, parseRegisterRequest, parseSendRequest } from "./schema";
import type { Limit, ShardOp, ShardResult } from "./shard";

export interface RelayEnv {
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  /** Bearer for /v1/admin/*. Unset → the admin routes answer 404. */
  ADMIN_TOKEN?: string;
  /** Set → registering needs `Authorization: Bearer <this>` (invite-only relay). */
  REGISTRATION_SECRET?: string;
  /** "true" → every send answers 503 paused (the kill switch). */
  RELAY_PAUSED?: string;
  SERVER_SENDS_PER_MINUTE?: string;
  SERVER_SENDS_PER_DAY?: string;
  DEVICE_SENDS_PER_MINUTE?: string;
  DEVICE_SENDS_PER_HOUR?: string;
  /** One server's share of a device token's budget (default: half of the device's, at least 1). */
  DEVICE_SERVER_SENDS_PER_MINUTE?: string;
  DEVICE_SERVER_SENDS_PER_HOUR?: string;
  REGISTRATIONS_PER_IP_PER_DAY?: string;
}

export interface RelayDeps {
  env: RelayEnv;
  /** Run one operation on the shard with this name (a Durable Object in production). */
  shard: (name: string, op: ShardOp) => Promise<ShardResult>;
  fetch: FetchLike;
  now?: () => number;
  log?: (line: string) => void;
}

export const DEFAULT_LIMITS = {
  serverPerMinute: 120,
  serverPerDay: 20_000,
  devicePerMinute: 10,
  devicePerHour: 120,
  registrationsPerIpPerDay: 5,
};

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n > 0 ? n : d;
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

/** Equal-time comparison of two secrets (both hashed first, so length leaks nothing). */
async function secretEquals(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0 && x.length === y.length;
}
const bearer = (req: Request): string | null => {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
};

/**
 * The body, read as a stream with a byte cap: a declared length over the cap is refused before
 * anything is read, and a chunked body is cancelled as soon as it passes the cap (never
 * buffered whole). null = too large.
 */
export async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(/^\d{1,15}$/.test(declared) && Number(declared) <= max)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export function createRelay(deps: RelayDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  const e = deps.env;
  const L = {
    server: [
      { window: "minute", max: num(e.SERVER_SENDS_PER_MINUTE, DEFAULT_LIMITS.serverPerMinute) },
      { window: "day", max: num(e.SERVER_SENDS_PER_DAY, DEFAULT_LIMITS.serverPerDay) },
    ] as Limit[],
    device: [
      { window: "minute", max: num(e.DEVICE_SENDS_PER_MINUTE, DEFAULT_LIMITS.devicePerMinute) },
      { window: "hour", max: num(e.DEVICE_SENDS_PER_HOUR, DEFAULT_LIMITS.devicePerHour) },
    ] as Limit[],
    registration: [{ window: "day", max: num(e.REGISTRATIONS_PER_IP_PER_DAY, DEFAULT_LIMITS.registrationsPerIpPerDay) }] as Limit[],
  };
  // A server's share of each device window: configured, else half the device's (≥ 1), never above it.
  const deviceServer: Limit[] = L.device.map((l) => {
    const configured = l.window === "minute" ? e.DEVICE_SERVER_SENDS_PER_MINUTE : e.DEVICE_SERVER_SENDS_PER_HOUR;
    return { window: l.window, max: Math.min(l.max, num(configured, Math.max(1, Math.ceil(l.max / 2)))) };
  });
  const apnsConfig = (): ApnsConfig | null =>
    apnsConfigProblem({ keyP8: e.APNS_KEY_P8, keyId: e.APNS_KEY_ID, teamId: e.APNS_TEAM_ID, topic: e.APNS_TOPIC }) === null
      ? { keyP8: e.APNS_KEY_P8!, keyId: e.APNS_KEY_ID!, teamId: e.APNS_TEAM_ID!, topic: e.APNS_TOPIC! }
      : null;

  const unauthorized = () => json(401, { error: "unauthorized" });
  const limited = (scope: string, retryAfterS = 60) =>
    json(429, { error: "rate_limited", scope, retryAfter: retryAfterS }, { "retry-after": String(retryAfterS) });

  /** Verify a signed request against the server's stored key (+ nonce + server budget). */
  async function authorize(req: Request, path: string, body: string): Promise<{ ok: true; serverId: string } | { ok: false; res: Response }> {
    const parts = signedParts(req.headers);
    // Stateless checks first (malformed headers, a stale timestamp): no Durable Object is
    // touched for them. The shard checks the timestamp again (its own clock).
    if (!parts || Math.abs(now() - parts.timestamp) > SKEW_MS) return { ok: false, res: unauthorized() };
    const message = await canonicalString(req.method, path, String(parts.timestamp), parts.nonce, body);
    const r = await deps.shard(`srv:${parts.serverId}`, {
      op: "authorize",
      message,
      signature: parts.signature,
      nonce: parts.nonce,
      timestamp: parts.timestamp,
      now: now(),
      limits: L.server,
    });
    if (r.ok) return { ok: true, serverId: parts.serverId };
    if (r.error === "revoked") return { ok: false, res: json(403, { error: "revoked" }) };
    if (r.error === "rate_limited") return { ok: false, res: limited("server", r.retryAfterS) };
    return { ok: false, res: unauthorized() };
  }

  async function register(req: Request, path: string): Promise<Response> {
    if (e.REGISTRATION_SECRET) {
      const b = bearer(req);
      if (!b || !(await secretEquals(b, e.REGISTRATION_SECRET))) return json(401, { error: "registration_closed" });
    }
    // Malformed signing headers are refused before the body is read.
    const parts = signedParts(req.headers);
    if (!parts || Math.abs(now() - parts.timestamp) > SKEW_MS) return unauthorized();
    const body = await readBody(req);
    if (body === null) return json(413, { error: "too_large" });
    const parsed = parseRegisterRequest(body);
    if (!parsed.ok) return json(400, { error: "bad_request", detail: parsed.detail });
    const id = await serverIdFor(parsed.publicKey);
    // Proof of possession: the request is signed by the key being registered.
    if (!id || parts.serverId !== id) return unauthorized();
    const message = await canonicalString(req.method, path, String(parts.timestamp), parts.nonce, body);
    if (!(await verifySignature(parsed.publicKey, message, parts.signature))) return unauthorized();
    // The per-IP budget is charged only for a request that proved its key (security review):
    // unsigned junk from a shared address (NAT, a carrier) no longer uses up its registrations.
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    const ipLimit = await deps.shard(`ip:${await sha256Hex(`ip:${ip}`)}`, { op: "consume", limits: L.registration, now: now() });
    if (!ipLimit.ok) return limited("registration", ipLimit.retryAfterS);
    const r = await deps.shard(`srv:${id}`, { op: "register", publicKey: parsed.publicKey, now: now() });
    if (!r.ok) return r.error === "revoked" ? json(403, { error: "revoked" }) : json(409, { error: "conflict" });
    log(`[relay] register ${id}`);
    return json(201, { serverId: id, createdAt: r.record?.createdAt });
  }

  async function send(req: Request, path: string): Promise<Response> {
    if (e.RELAY_PAUSED === "true") return json(503, { error: "paused" }, { "retry-after": "300" });
    const body = await readBody(req);
    if (body === null) return json(413, { error: "too_large" });
    const parsed = parseSendRequest(body);
    if (!parsed.ok) return json(400, { error: "bad_request", detail: parsed.detail });
    const auth = await authorize(req, path, body);
    if (!auth.ok) return auth.res;
    const cfg = apnsConfig();
    if (!cfg) return json(503, { error: "apns_unconfigured" }, { "retry-after": "300" });
    const dev = await deps.shard(`dev:${await sha256Hex(`device:${parsed.value.deviceToken}`)}`, {
      op: "consumeDevice",
      limits: L.device,
      perServer: { serverId: auth.serverId, limits: deviceServer },
      now: now(),
    });
    if (!dev.ok) return limited(dev.scope ?? "device", dev.retryAfterS);
    const r = await sendToApns(cfg, parsed.value, { fetch: deps.fetch, now: now() });
    log(`[relay] send ${auth.serverId} ${parsed.value.kind} ${r.result}${r.result === "sent" ? "" : ` ${r.reason}`}`);
    if (r.result === "unavailable") return json(503, { error: "unavailable", reason: r.reason }, { "retry-after": "30" });
    return json(200, r.result === "sent" ? { result: "sent" } : { result: r.result, reason: r.reason });
  }

  async function self(req: Request, path: string): Promise<Response> {
    const auth = await authorize(req, path, "");
    if (!auth.ok) {
      if (req.method === "DELETE" && auth.res.status === 403) return json(200, { revoked: true });
      return auth.res;
    }
    const name = `srv:${auth.serverId}`;
    if (req.method === "DELETE") {
      await deps.shard(name, { op: "revoke", by: "self", now: now() });
      log(`[relay] revoke ${auth.serverId} (self)`);
      return json(200, { serverId: auth.serverId, revoked: true });
    }
    const s = await deps.shard(name, { op: "status" });
    return json(200, { serverId: auth.serverId, createdAt: s.record?.createdAt ?? null, revoked: false });
  }

  async function admin(req: Request, path: string): Promise<Response> {
    if (!e.ADMIN_TOKEN) return json(404, { error: "not_found" });
    const b = bearer(req);
    if (!b || !(await secretEquals(b, e.ADMIN_TOKEN))) return json(401, { error: "unauthorized" });
    const m = /^\/v1\/admin\/servers\/([A-Za-z0-9_-]{22})(?:\/(revoke|restore))?$/.exec(path);
    if (!m) return json(404, { error: "not_found" });
    const id = m[1]!;
    const action = m[2];
    if (!action && req.method !== "GET") return json(405, { error: "method_not_allowed" });
    if (action && req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const op: ShardOp = action === "revoke" ? { op: "revoke", by: "admin", now: now() } : action === "restore" ? { op: "restore", now: now() } : { op: "status" };
    const r = await deps.shard(`srv:${id}`, op);
    if (!r.ok || !r.record) return json(404, { error: "unknown_server" });
    if (action) log(`[relay] ${action} ${id} (admin)`);
    return json(200, { serverId: id, createdAt: r.record.createdAt, revokedAt: r.record.revokedAt, revokedBy: r.record.revokedBy });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    // A query string is never part of the API (and never signed).
    if (url.search) return json(400, { error: "bad_request", detail: "no query strings" });
    try {
      if (path === "/health" && req.method === "GET") return json(200, { ok: true, apns: apnsConfig() !== null });
      if (path === "/v1/servers" && req.method === "POST") return await register(req, path);
      if (path === "/v1/servers/self" && (req.method === "GET" || req.method === "DELETE")) return await self(req, path);
      if (path === "/v1/send" && req.method === "POST") return await send(req, path);
      if (path.startsWith("/v1/admin/")) return await admin(req, path);
      return json(404, { error: "not_found" });
    } catch {
      log("[relay] internal error");
      return json(500, { error: "internal_error" });
    }
  };
}

export { HEADER };
