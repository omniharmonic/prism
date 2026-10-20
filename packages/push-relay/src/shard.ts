/**
 * The relay's only state, kept in Durable Objects (one instance per name):
 *
 *   srv:<server id>  the server's record (public key, created, revoked) + its
 *                    recent nonces + its send counters
 *   dev:<sha256 of the device token>  that token's send counters (across servers) +
 *                    one set of counters per sending server (its share of that budget)
 *   ip:<sha256 of the client IP>      registration counters
 *
 * Why Durable Objects and not KV: a rate limit is a read-modify-write counter that
 * must be exact under concurrency; KV is eventually consistent (another colo can
 * read a stale count for up to a minute) and allows ~1 write per second per key.
 * A Durable Object runs one request at a time per name, so a check-and-increment
 * is atomic, and a nonce is used exactly once.
 *
 * The device token itself is never stored — only its SHA-256 is used, and only as
 * the shard's NAME (counters live inside it; nothing maps the hash back).
 *
 * This file is pure logic over a tiny storage interface, so the tests run it with
 * a Map and the Worker runs it in `RelayShard` (index.ts) over DO storage.
 */
import { NONCE_TTL_MS, SKEW_MS, verifySignature } from "./auth";

export interface ShardStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export type Window = "minute" | "hour" | "day";
export interface Limit {
  window: Window;
  max: number;
}
const WINDOW_MS: Record<Window, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

export interface ServerRecord {
  publicKey: string;
  createdAt: number;
  revokedAt: number | null;
  revokedBy: "admin" | "self" | null;
}

export type ShardOp =
  | { op: "register"; publicKey: string; now: number }
  | { op: "authorize"; message: string; signature: string; nonce: string; timestamp: number; now: number; limits: Limit[] }
  | { op: "revoke"; by: "admin" | "self"; now: number }
  | { op: "restore"; now: number }
  | { op: "status" }
  | { op: "consume"; limits: Limit[]; now: number }
  /**
   * A device token's budget: `limits` across every server, and `perServer.limits` for the one
   * sending server inside it, so one server cannot use up the budget another server's
   * notifications to the same device need. All-or-nothing over both.
   */
  | { op: "consumeDevice"; limits: Limit[]; perServer: { serverId: string; limits: Limit[] }; now: number };

export type ShardResult =
  | { ok: true; record?: ServerRecord }
  | { ok: false; error: "unknown" | "unauthorized" | "revoked" | "conflict" | "rate_limited"; retryAfterS?: number; record?: ServerRecord; scope?: "device" | "device_server" };

type Counters = Partial<Record<Window, { start: number; n: number }>>;
type Nonces = Array<[string, number]>; // [nonce, expires at]
/** Live nonces one server may hold. Full → refuse (never evict a live nonce: that re-opens its replay window). */
export const MAX_NONCES = 5000;

/** Distinct servers whose share one device shard tracks at a time (live windows only). */
export const MAX_SERVERS_PER_DEVICE = 64;

/** Seconds until the tightest exhausted window of `c` rolls over, or null when every limit has room. */
function exhausted(c: Counters, limits: Limit[], now: number): number | null {
  let retry: number | null = null;
  for (const l of limits) {
    const ms = WINDOW_MS[l.window];
    const start = Math.floor(now / ms) * ms;
    const cur = c[l.window]?.start === start ? c[l.window]!.n : 0;
    if (cur >= l.max) retry = Math.max(retry ?? 0, Math.ceil((start + ms - now) / 1000));
  }
  return retry;
}
function bump(c: Counters, limits: Limit[], now: number): void {
  for (const l of limits) {
    const ms = WINDOW_MS[l.window];
    const start = Math.floor(now / ms) * ms;
    const cur = c[l.window]?.start === start ? c[l.window]!.n : 0;
    c[l.window] = { start, n: cur + 1 };
  }
}
const live = (c: Counters, now: number): boolean => (Object.entries(c) as Array<[Window, { start: number; n: number }]>).some(([w, v]) => v.start + WINDOW_MS[w] > now);

/**
 * All-or-nothing: every limit is checked first, then every counter is increased.
 * Returns the seconds until the tightest exhausted window rolls over, or null.
 */
async function consume(s: ShardStorage, limits: Limit[], now: number): Promise<number | null> {
  const c = (await s.get<Counters>("rate")) ?? {};
  const retry = exhausted(c, limits, now);
  if (retry !== null) return retry;
  bump(c, limits, now);
  await s.put("rate", c);
  return null;
}

async function consumeDevice(s: ShardStorage, op: Extract<ShardOp, { op: "consumeDevice" }>): Promise<ShardResult> {
  const total = (await s.get<Counters>("rate")) ?? {};
  const all = (await s.get<Record<string, Counters>>("servers")) ?? {};
  // Forget servers whose every window has rolled over (bounds the map by recent senders).
  const servers: Record<string, Counters> = {};
  for (const [id, c] of Object.entries(all)) if (live(c, op.now)) servers[id] = c;
  const mine = Object.hasOwn(servers, op.perServer.serverId) ? servers[op.perServer.serverId]! : {};
  const totalRetry = exhausted(total, op.limits, op.now);
  if (totalRetry !== null) return { ok: false, error: "rate_limited", retryAfterS: totalRetry, scope: "device" };
  const mineRetry = exhausted(mine, op.perServer.limits, op.now);
  if (mineRetry !== null) return { ok: false, error: "rate_limited", retryAfterS: mineRetry, scope: "device_server" };
  if (!Object.hasOwn(servers, op.perServer.serverId) && Object.keys(servers).length >= MAX_SERVERS_PER_DEVICE) {
    return { ok: false, error: "rate_limited", retryAfterS: 60, scope: "device" };
  }
  bump(total, op.limits, op.now);
  bump(mine, op.perServer.limits, op.now);
  servers[op.perServer.serverId] = mine;
  await s.put("rate", total);
  await s.put("servers", servers);
  return { ok: true };
}

export async function runShard(s: ShardStorage, op: ShardOp): Promise<ShardResult> {
  switch (op.op) {
    case "consume": {
      const retry = await consume(s, op.limits, op.now);
      return retry === null ? { ok: true } : { ok: false, error: "rate_limited", retryAfterS: retry };
    }
    case "consumeDevice":
      return consumeDevice(s, op);
    case "register": {
      const rec = await s.get<ServerRecord>("server");
      if (rec) {
        if (rec.publicKey !== op.publicKey) return { ok: false, error: "conflict" };
        if (rec.revokedAt !== null) return { ok: false, error: "revoked", record: rec };
        return { ok: true, record: rec }; // idempotent re-registration
      }
      const created: ServerRecord = { publicKey: op.publicKey, createdAt: op.now, revokedAt: null, revokedBy: null };
      await s.put("server", created);
      return { ok: true, record: created };
    }
    case "status": {
      const rec = await s.get<ServerRecord>("server");
      return rec ? { ok: true, record: rec } : { ok: false, error: "unknown" };
    }
    case "revoke": {
      const rec = await s.get<ServerRecord>("server");
      if (!rec) return { ok: false, error: "unknown" };
      if (rec.revokedAt === null) {
        rec.revokedAt = op.now;
        rec.revokedBy = op.by;
        await s.put("server", rec);
      }
      return { ok: true, record: rec };
    }
    case "restore": {
      const rec = await s.get<ServerRecord>("server");
      if (!rec) return { ok: false, error: "unknown" };
      rec.revokedAt = null;
      rec.revokedBy = null;
      await s.put("server", rec);
      return { ok: true, record: rec };
    }
    case "authorize": {
      const rec = await s.get<ServerRecord>("server");
      // Unknown server, stale timestamp, bad signature, replayed nonce: ONE answer.
      if (!rec) return { ok: false, error: "unauthorized" };
      if (Math.abs(op.now - op.timestamp) > SKEW_MS) return { ok: false, error: "unauthorized" };
      if (!(await verifySignature(rec.publicKey, op.message, op.signature))) return { ok: false, error: "unauthorized" };
      // Signature verified: the caller holds the key, so it may learn it is revoked.
      if (rec.revokedAt !== null) return { ok: false, error: "revoked" };
      const nonces = ((await s.get<Nonces>("nonces")) ?? []).filter(([, exp]) => exp > op.now);
      if (nonces.some(([n]) => n === op.nonce)) return { ok: false, error: "unauthorized" };
      // A replayed request must not spend the budget, so the nonce is checked first;
      // a rate-limited request still burns its nonce (it was a real, signed attempt).
      // Full of LIVE nonces: refuse rather than drop the oldest — a dropped nonce whose
      // timestamp is still inside the skew window could be replayed (security review).
      if (nonces.length >= MAX_NONCES) return { ok: false, error: "rate_limited", retryAfterS: 60 };
      nonces.push([op.nonce, op.now + NONCE_TTL_MS]);
      await s.put("nonces", nonces);
      const retry = await consume(s, op.limits, op.now);
      return retry === null ? { ok: true, record: rec } : { ok: false, error: "rate_limited", retryAfterS: retry };
    }
  }
}

/** In-memory storage (tests, and nothing else). */
export function memoryStorage(): ShardStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(k: string) => structuredClone(map.get(k)) as T | undefined,
    put: async <T>(k: string, v: T) => {
      map.set(k, structuredClone(v));
    },
    delete: async (k: string) => map.delete(k),
  };
}
