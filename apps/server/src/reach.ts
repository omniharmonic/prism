/**
 * Is APP_ORIGIN really reachable? (launch plan Phase 2 "Reachability": the checklist's
 * `reachable` step is ticked only by a real request from outside this machine.)
 *
 * The server cannot ask the network whether a phone can open it. What it CAN see is the
 * requests that arrive through the proxy in front of it, and the proxy says where each one
 * came from:
 *
 *  - Tailscale serve / Funnel (tailscaled on this machine, connecting from loopback) sets
 *    `X-Forwarded-For` to the CLIENT's tailnet address, `X-Forwarded-Host` to the name it was
 *    asked for, `X-Forwarded-Proto: https`, and `Tailscale-Funnel-Request: ?1` for a request
 *    that came in from the internet through Funnel (it strips a client-sent copy of that one).
 *  - A Cloudflare tunnel (cloudflared on this machine) sets `CF-Connecting-IP`.
 *
 * So, for a request on a LOOPBACK socket whose forwarded host is APP_ORIGIN's host:
 *
 *   Funnel header                       → outside ("funnel": it came in from the internet)
 *   CF-Connecting-IP                    → outside ("cloudflare": it went through Cloudflare's
 *                                         edge — even a request from this machine crossed the
 *                                         public internet to get here)
 *   X-Forwarded-For = this machine      → self (the `prism reach` check from this computer: it
 *                                         proves the name, the certificate and the proxy, NOT
 *                                         that another device can get in)
 *   X-Forwarded-For = another tailnet
 *   address (100.64.0.0/10, fd7a:115c:a1e0::/48) → outside ("tailnet": another device)
 *
 * "This machine's addresses" are what `prism reach` read from `tailscale status` and recorded
 * through the host-key route (routes/local-reach.ts); without that record a tailnet request
 * is not judged at all (it could be this machine). Anything else is ignored. A local process
 * running as the install's user can forge these headers — the same boundary as `.env` and the
 * database it can read anyway. A LAN client cannot: the socket must be loopback.
 *
 * Stored in `settings` (`reach:v1`): the expectation `prism reach` recorded and, per origin, the
 * first time each kind of request was seen. Never an address of a client — only of this machine.
 */
import { isIP } from "node:net";
import type { Context } from "hono";
import { config } from "./config";
import { getReachSetting, setReachSetting } from "./db";
import { isLoopbackAddress } from "./auth/local-signin";

export type OutsideVia = "tailnet" | "funnel" | "cloudflare";
export type ReachMode = "serve" | "funnel";

export interface ReachSeen {
  /** First request through the proxy from this machine (the CLI's check). ISO time. */
  self?: string;
  /** First request from outside this machine. ISO time. */
  outside?: string;
  outsideVia?: OutsideVia;
}

export interface ReachExpect {
  origin: string;
  mode: ReachMode;
  /** This machine's tailnet addresses (from `tailscale status --json`). */
  selfAddresses: string[];
  at: string;
}

interface ReachState {
  expect: ReachExpect | null;
  seen: Record<string, ReachSeen>;
}

const MAX_ORIGINS = 5;
let clock: () => number = Date.now;
/** Tests move the clock; production = Date.now. */
export function setReachClock(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

function load(): ReachState {
  const raw = getReachSetting();
  if (!raw) return { expect: null, seen: {} };
  try {
    const v = JSON.parse(raw) as Partial<ReachState>;
    return { expect: v.expect ?? null, seen: v.seen && typeof v.seen === "object" ? v.seen : {} };
  } catch {
    return { expect: null, seen: {} };
  }
}

function save(s: ReachState): void {
  const origins = Object.keys(s.seen);
  // Keep the current origin and the newest few others.
  if (origins.length > MAX_ORIGINS) {
    const keep = new Set([config.appOrigin, ...origins.slice(-(MAX_ORIGINS - 1))]);
    for (const o of origins) if (!keep.has(o)) delete s.seen[o];
  }
  setReachSetting(JSON.stringify(s));
}

/** What has been seen for `origin` (APP_ORIGIN by default). */
export function reachSeen(origin = config.appOrigin): ReachSeen {
  return { ...(load().seen[origin] ?? {}) };
}

export function reachExpectation(): ReachExpect | null {
  return load().expect;
}

/** Record (or, with null, clear) what `prism reach` set up. Seen times are kept per origin. */
export function setReachExpectation(e: Omit<ReachExpect, "at"> | null): void {
  const s = load();
  s.expect = e ? { ...e, at: new Date(clock()).toISOString() } : null;
  // The check from this machine is earned again by every run (so a stale one never passes);
  // what was seen from outside is kept.
  if (e && s.seen[e.origin]) delete s.seen[e.origin]!.self;
  save(s);
}

/** Forget what was seen for an origin (`prism reach off`). */
export function clearReachSeen(origin: string): void {
  const s = load();
  delete s.seen[origin];
  save(s);
}

/** The forms `X-Forwarded-For` takes for one address; mapped IPv4 is unmapped. */
function normalizeIp(raw: string): string | null {
  let a = raw.trim();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(a)) a = a.slice(7);
  if (!isIP(a)) return null;
  return a.toLowerCase();
}

/** Tailscale's address ranges: 100.64.0.0/10 (CGNAT) and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(raw: string): boolean {
  const a = normalizeIp(raw);
  if (!a) return false;
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number) as [number, number];
    return x === 100 && y >= 64 && y <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(a);
}

export function sameAddress(a: string, b: string): boolean {
  const x = normalizeIp(a);
  const y = normalizeIp(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Compare IPv6 by value (one side may be written with ::, the other not).
  if (isIP(x) === 6 && isIP(y) === 6) return expand6(x) === expand6(y);
  return false;
}

function expand6(a: string): string {
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = a.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((p) => p.padStart(4, "0")).join(":");
}

function socketAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined;
  const a = env && typeof env === "object" ? env.incoming?.socket?.remoteAddress : undefined;
  return typeof a === "string" ? a : null;
}

/** How this request reached the server, by the rules above, or null (not judged). */
export function classifyReachRequest(
  c: Context,
  appOrigin = config.appOrigin,
  expect: ReachExpect | null = null,
): { kind: "self" } | { kind: "outside"; via: OutsideVia } | null {
  const xff = c.req.header("x-forwarded-for");
  const cf = c.req.header("cf-connecting-ip");
  if (xff === undefined && cf === undefined) return null;
  if (!isLoopbackAddress(socketAddress(c))) return null;
  let host: string;
  try {
    host = new URL(appOrigin).host.toLowerCase();
    if (!appOrigin.startsWith("https://")) return null;
  } catch {
    return null;
  }
  const asked = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").toLowerCase().replace(/:443$/, "");
  if (asked !== host) return null;
  if (c.req.header("tailscale-funnel-request") === "?1") return { kind: "outside", via: "funnel" };
  if (cf !== undefined) return { kind: "outside", via: "cloudflare" };
  if ((c.req.header("x-forwarded-proto") ?? "").toLowerCase() !== "https") return null;
  // Tailscale sets exactly one address; anything else is not its header.
  const client = xff!.split(",").map((s) => s.trim());
  if (client.length !== 1) return null;
  if (!expect || expect.origin !== appOrigin) return null;
  if (expect.selfAddresses.some((a) => sameAddress(a, client[0]!))) return { kind: "self" };
  if (isTailnetAddress(client[0]!)) return { kind: "outside", via: "tailnet" };
  return null;
}

/**
 * Middleware body: note the first request of each kind for APP_ORIGIN. Cheap for ordinary
 * traffic (two header reads); one settings read for a proxied request; a write only the first
 * time a kind is seen.
 */
export function observeReach(c: Context): void {
  if (c.req.header("x-forwarded-for") === undefined && c.req.header("cf-connecting-ip") === undefined) return;
  try {
    const s = load();
    const seen = s.seen[config.appOrigin] ?? {};
    if (seen.outside && seen.self) return;
    const k = classifyReachRequest(c, config.appOrigin, s.expect);
    if (!k) return;
    const at = new Date(clock()).toISOString();
    if (k.kind === "self") {
      if (seen.self) return;
      seen.self = at;
    } else {
      if (seen.outside) return;
      seen.outside = at;
      seen.outsideVia = k.via;
    }
    s.seen[config.appOrigin] = seen;
    save(s);
  } catch {
    /* never fails a request */
  }
}
