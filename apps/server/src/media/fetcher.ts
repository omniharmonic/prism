/**
 * Pinned, bounded outbound GET for the media + map proxies (Client parity C).
 *
 * Every hop: `parseTarget` (scheme/port/host policy) → `resolvePublic` (our own
 * DNS lookup, every answer must be public) → connect to THAT address with
 * SNI + Host = the original name (TLS is still verified against the name).
 * Redirects are followed manually (max 3), each hop re-validated from scratch.
 * No cookies, no auth, no client headers are forwarded — the request carries
 * only Accept / Accept-Encoding / a fixed User-Agent. The whole exchange
 * (connect + headers + body) runs under ONE deadline, so a slow-drip server
 * cannot hold a slot open; the body is capped while streaming.
 *
 * The transport is injectable so tests never touch the internet: they stub the
 * resolver with public-looking addresses and route the pinned connection to a
 * local server, asserting WHICH address was dialled.
 */
import http from "node:http";
import https from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { GuardError, parseTarget, resolvePublic, type Target, type TargetPolicy } from "./netguard";

export interface TransportRequest {
  /** The pinned, already-validated address to dial. */
  ip: string;
  port: number;
  protocol: "https:" | "http:";
  /** The original DNS name: TLS SNI + certificate check + Host header. */
  host: string;
  /** Path + query, as sent on the wire. */
  path: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | Uint8Array | string>;
  /** Abort the underlying socket (redirect, oversize, error). */
  destroy(): void;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** The real transport: node http(s) dialled at the pinned IP, no agent reuse, no proxy env. */
export const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const mod = req.protocol === "https:" ? https : http;
    const hostHeader = (req.protocol === "https:" && req.port === 443) || (req.protocol === "http:" && req.port === 80) ? req.host : `${req.host}:${req.port}`;
    const r = mod.request(
      {
        host: req.ip, // dial the validated address — never re-resolve the name
        port: req.port,
        path: req.path,
        method: "GET",
        headers: { ...req.headers, Host: hostHeader },
        servername: req.protocol === "https:" ? req.host : undefined, // SNI + cert check against the NAME
        // agent:false = a fresh, non-pooled Agent built from THESE options. It is
        // load-bearing for the pin: the global agents are where Node applies
        // NODE_USE_ENV_PROXY + HTTP(S)_PROXY, and a proxy would re-resolve the
        // NAME itself (undoing the IP check). Pinned by media-proxy.test.ts
        // ("env proxy is bypassed").
        agent: false,
        signal: req.signal,
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    r.on("error", reject);
    r.end();
  });

export interface GuardedFetchOptions {
  policy: TargetPolicy;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  accept: string;
  transport?: Transport;
}

export interface GuardedResponse {
  /** The final URL after redirects. */
  url: string;
  contentType: string;
  cacheControl: string;
  body: Buffer;
}

export class FetchError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const UA = "PrismMediaProxy/1 (+https://github.com/omniharmonic/prism)";

const first = (h: string | string[] | undefined): string => (Array.isArray(h) ? (h[0] ?? "") : (h ?? ""));

async function readCapped(res: TransportResponse, maxBytes: number): Promise<Buffer> {
  const declared = Number(first(res.headers["content-length"]));
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw new FetchError("too_large", 413, "response exceeds the size cap");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of res.body) {
    const b = typeof c === "string" ? Buffer.from(c) : Buffer.from(c);
    total += b.length;
    if (total > maxBytes) {
      res.destroy();
      throw new FetchError("too_large", 413, "response exceeds the size cap");
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

function decode(body: Buffer, encoding: string, maxBytes: number): Buffer {
  const enc = encoding.trim().toLowerCase();
  if (!enc || enc === "identity") return body;
  try {
    // maxOutputLength bounds a decompression bomb at the same cap as the wire size.
    if (enc === "gzip" || enc === "x-gzip") return gunzipSync(body, { maxOutputLength: maxBytes });
    if (enc === "deflate") return inflateSync(body, { maxOutputLength: maxBytes });
    if (enc === "br") return brotliDecompressSync(body, { maxOutputLength: maxBytes });
  } catch {
    throw new FetchError("bad_encoding", 502, "could not decode the upstream response");
  }
  throw new FetchError("bad_encoding", 502, "unsupported content-encoding");
}

/**
 * GET `rawUrl` under the SSRF policy. Throws GuardError (policy refusal) or
 * FetchError (upstream failure / limits). Only a 200 is a success.
 */
export async function guardedFetch(rawUrl: string, opts: GuardedFetchOptions): Promise<GuardedResponse> {
  const transport = opts.transport ?? nodeTransport;
  const maxRedirects = opts.maxRedirects ?? 3;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs);
  let current: Target = parseTarget(rawUrl, opts.policy);
  let live: TransportResponse | null = null;
  try {
    for (let hop = 0; ; hop++) {
      const ip = await resolvePublic(current.host, ctl.signal);
      if (ctl.signal.aborted) throw new FetchError("timeout", 504, "upstream timed out");
      const res = await transport({
        ip,
        port: current.port,
        protocol: current.protocol,
        host: current.host,
        path: `${current.url.pathname}${current.url.search}`,
        headers: { Accept: opts.accept, "Accept-Encoding": "gzip, deflate, br", "User-Agent": UA },
        signal: ctl.signal,
      });
      live = res;
      if (REDIRECTS.has(res.status)) {
        res.destroy();
        live = null;
        const loc = first(res.headers.location);
        if (!loc) throw new FetchError("bad_redirect", 502, "redirect without a location");
        if (hop + 1 > maxRedirects) throw new FetchError("too_many_redirects", 502, "too many redirects");
        let next: string;
        try {
          next = new URL(loc, current.url).href;
        } catch {
          throw new FetchError("bad_redirect", 502, "unparseable redirect");
        }
        current = parseTarget(next, opts.policy); // full re-validation; DNS re-checked next loop
        continue;
      }
      if (res.status !== 200) {
        res.destroy();
        live = null;
        throw new FetchError("upstream_status", res.status === 404 ? 404 : 502, `upstream answered ${res.status}`);
      }
      const raw = await readCapped(res, opts.maxBytes);
      live = null;
      const body = decode(raw, first(res.headers["content-encoding"]), opts.maxBytes);
      return {
        url: current.url.href,
        contentType: first(res.headers["content-type"]).toLowerCase(),
        cacheControl: first(res.headers["cache-control"]),
        body,
      };
    }
  } catch (e) {
    live?.destroy();
    // A refusal (incl. DNS that did not answer before the deadline) stays a refusal.
    if (e instanceof GuardError) throw e;
    if (timedOut) throw new FetchError("timeout", 504, "upstream timed out");
    if (e instanceof GuardError || e instanceof FetchError) throw e;
    throw new FetchError("upstream_error", 502, "upstream fetch failed");
  } finally {
    clearTimeout(timer);
  }
}

/** Upstream `Cache-Control` → seconds to keep, clamped. `no-store` → 0 (serve, don't persist). */
export function cacheSeconds(cacheControl: string, opts: { min: number; max: number; fallback: number }): number {
  const cc = cacheControl.toLowerCase();
  if (/\bno-store\b/.test(cc)) return 0;
  const m = /\b(?:s-maxage|max-age)\s*=\s*(\d+)/.exec(cc);
  const v = m ? Number(m[1]) : opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, v));
}
