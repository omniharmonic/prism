/**
 * External media + basemap proxies (Client parity C, docs/client-app.md).
 *
 * The Prism Client's CSP lets the page load images and open connections ONLY
 * to the configured Prism Server (page script can read the device token, so an
 * arbitrary image URL would be an exfiltration channel). These two routes let
 * it show external images in notes and the OpenFreeMap basemap anyway, by
 * having the server fetch them under strict SSRF rules (media/netguard.ts,
 * media/fetcher.ts):
 *
 *   GET /api/media/proxy?u=<https url>   one raster image (sniffed; SVG refused)
 *   GET /api/map/style/:id               an OpenFreeMap style, TileJSON inlined,
 *                                        every asset URL rewritten to /api/map/ofm/…
 *   GET /api/map/ofm/<path>              tiles / glyphs / sprites, path-allowlisted,
 *                                        upstream host fixed to tiles.openfreemap.org
 *
 * SIGNED-IN USERS ONLY: a browser session or a native device token (or the
 * loopback owner token). Capability links and anon get 401 — a share link must
 * not turn this server into an open fetcher for whoever holds the URL, and the
 * PWA (the only place capability viewers live) loads images directly anyway.
 * MCP in-process dispatches are refused too (agents have no use for pixels).
 *
 * Responses are rebuilt from scratch (no upstream header passes through):
 * sniffed Content-Type, nosniff, a sandbox CSP, inline Content-Disposition,
 * no-referrer, CORP same-origin, and a private max-age. Per-user rate limits,
 * a global in-flight cap, in-flight coalescing, and an on-disk LRU (media/cache.ts).
 */
import { Hono, type Context } from "hono";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "../config";
import { requestVia, resolveActor } from "../auth/actor";
import { consumeRateLimit } from "../middleware/ratelimit";
import { DiskCache } from "../media/cache";
import { cacheSeconds, FetchError, guardedFetch, type Transport } from "../media/fetcher";
import { GuardError, parseTarget, type TargetPolicy } from "../media/netguard";
import { BusyError, KeyedSemaphore, Semaphore } from "../media/limits";
import { RASTER_EXT, sniffRaster, upstreamTypeAllowed, type RasterType } from "../media/sniff";

// ---------------------------------------------------------------------------
// Configuration (env, overridable in tests)
// ---------------------------------------------------------------------------

const envNum = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== "" ? v : d;
};
const envList = (k: string): string[] =>
  (process.env[k] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function defaultCacheDir(): string {
  if (process.env.MEDIA_CACHE_DIR) return resolve(process.env.MEDIA_CACHE_DIR);
  // In-memory DB (tests) → a per-process temp dir; else next to the server DB.
  if (config.dbPath === ":memory:") return join(tmpdir(), `prism-media-cache-${process.pid}`);
  return join(dirname(resolve(config.dbPath)), "media-cache");
}

export interface MediaConfig {
  mediaEnabled: boolean;
  mapEnabled: boolean;
  maxImageBytes: number;
  maxMapBytes: number;
  timeoutMs: number;
  /** Hosts allowed over plain http (MEDIA_PROXY_HTTP_HOSTS). Default none. */
  httpHosts: string[];
  /** Ports allowed besides 443 (MEDIA_PROXY_PORTS). Default none. */
  extraPorts: number[];
  imagesPerMinute: number;
  mapPerMinute: number;
  /** Upstream fetches in flight, images pool: global / per user. */
  mediaInflight: number;
  mediaPerUser: number;
  /** Upstream fetches in flight, map pool: global / per user. */
  mapInflight: number;
  mapPerUser: number;
  /** How long a request may wait for a slot before 503. */
  queueWaitMs: number;
  cacheDir: string;
  cacheMaxBytes: number;
  transport?: Transport;
}

function envConfig(): MediaConfig {
  return {
    mediaEnabled: process.env.MEDIA_PROXY_ENABLED !== "false",
    mapEnabled: process.env.MAP_PROXY_ENABLED !== "false",
    maxImageBytes: envNum("MEDIA_PROXY_MAX_BYTES", 5 * 1024 * 1024),
    maxMapBytes: 4 * 1024 * 1024,
    timeoutMs: envNum("MEDIA_PROXY_TIMEOUT_MS", 15_000),
    httpHosts: envList("MEDIA_PROXY_HTTP_HOSTS"),
    extraPorts: envList("MEDIA_PROXY_PORTS")
      .map(Number)
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536),
    imagesPerMinute: envNum("MEDIA_PROXY_PER_MINUTE", 240),
    mapPerMinute: envNum("MAP_PROXY_PER_MINUTE", 1500),
    mediaInflight: envNum("MEDIA_PROXY_MAX_INFLIGHT", 12),
    mediaPerUser: envNum("MEDIA_PROXY_PER_USER_INFLIGHT", 3),
    mapInflight: envNum("MAP_PROXY_MAX_INFLIGHT", 16),
    mapPerUser: envNum("MAP_PROXY_PER_USER_INFLIGHT", 4),
    queueWaitMs: envNum("MEDIA_PROXY_QUEUE_WAIT_MS", 5_000),
    cacheDir: defaultCacheDir(),
    cacheMaxBytes: envNum("MEDIA_CACHE_MAX_BYTES", 512 * 1024 * 1024),
  };
}

let cfg: MediaConfig = envConfig();
let cache = new DiskCache(cfg.cacheDir, cfg.cacheMaxBytes);

/** Test seam: override parts of the config (a new cache is built if its dir/size changed). */
export function configureMedia(over: Partial<MediaConfig> | null): void {
  cfg = over ? { ...envConfig(), ...over } : envConfig();
  cache = new DiskCache(cfg.cacheDir, cfg.cacheMaxBytes);
  inflight.clear();
  failures.clear();
  pools = makePools();
}
export const mediaCache = (): DiskCache => cache;

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Never proxy ourselves, the vault or the hub (by name; their IPs are private anyway). */
function forbiddenHosts(): string[] {
  const out: string[] = [];
  for (const u of [config.appOrigin, config.parachuteUrl, config.hubOrigin, config.hubJwksOrigin, ...config.hubAllowedIssuers]) {
    try {
      out.push(new URL(u).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** A signed-in person (session / device token / loopback owner), never a link, anon or MCP. */
function signedInKey(c: Context): string | null {
  const via = requestVia(c);
  if (via !== "session" && via !== "device" && via !== "local-token") return null;
  const actor = resolveActor(c);
  return actor.kind === "user" ? actor.email.toLowerCase() : null;
}

interface CachedAsset {
  contentType: string;
  body: Buffer;
  /** Seconds the client may keep it. */
  maxAge: number;
}

/**
 * Upstream concurrency, in two SEPARATE pools (images can never starve the
 * basemap, nor the reverse), each with a global cap AND a per-user cap — so one
 * user parking slow-drip / slow-DNS URLs fills only their own few slots.
 * Waiting is bounded (queue length + `queueWaitMs`); past that → 503 busy.
 */
interface Pool {
  global: Semaphore;
  perUser: KeyedSemaphore;
}
function makePools(): Record<"media" | "map", Pool> {
  return {
    media: { global: new Semaphore(cfg.mediaInflight, 64), perUser: new KeyedSemaphore(cfg.mediaPerUser, 32) },
    map: { global: new Semaphore(cfg.mapInflight, 128), perUser: new KeyedSemaphore(cfg.mapPerUser, 64) },
  };
}
let pools = makePools();
const inflight = new Map<string, Promise<CachedAsset>>();

/** Upstream failures (policy refusals, dead hosts, non-images) are remembered per URL for NEGATIVE_MS. */
const NEGATIVE_MS = 60_000;
const failures = new Map<string, { err: unknown; until: number }>();
function rememberFailure(key: string, err: unknown): void {
  if (!(err instanceof GuardError || err instanceof FetchError)) return;
  if (failures.size > 10_000) failures.clear(); // bound memory
  failures.set(key, { err, until: Date.now() + NEGATIVE_MS });
}

/** Cache → recent failure → coalesced in-flight → per-user + global slot → bounded upstream fetch. */
async function cached(pool: "media" | "map", user: string, namespace: string, url: string, produce: () => Promise<{ asset: CachedAsset; ttl: number }>): Promise<CachedAsset> {
  const key = DiskCache.key(namespace, url);
  const hit = await cache.get(key);
  if (hit) {
    return { contentType: hit.meta.contentType, body: hit.body, maxAge: Math.max(0, Math.floor((hit.meta.expiresAt - Date.now()) / 1000)) };
  }
  const failed = failures.get(key);
  if (failed) {
    if (failed.until > Date.now()) throw failed.err;
    failures.delete(key);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = pools[pool];
  const releaseUser = await p.perUser.acquire(user, cfg.queueWaitMs);
  let releaseGlobal: () => void;
  try {
    releaseGlobal = await p.global.acquire(cfg.queueWaitMs);
  } catch (e) {
    releaseUser();
    throw e;
  }
  const again = inflight.get(key); // someone started it while we waited
  if (again) {
    releaseGlobal();
    releaseUser();
    return again;
  }
  const run = (async () => {
    try {
      const { asset, ttl } = await produce();
      await cache.put(key, asset.contentType, asset.body, ttl);
      return asset;
    } catch (e) {
      rememberFailure(key, e);
      throw e;
    } finally {
      releaseGlobal();
      releaseUser();
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

function errorResponse(c: Context, e: unknown): Response {
  if (e instanceof GuardError) {
    // ONE generic code for every refusal found after the pre-network URL check
    // (DNS failure vs. private answer vs. a bad redirect hop): the client must not
    // learn which internal names exist. The detail stays in the server log.
    console.warn(`[media] refused: ${e.code}`);
    return c.json({ error: "refused", reason: "refused" }, 400);
  }
  if (e instanceof FetchError) {
    const status = e.status === 404 ? 404 : e.status === 413 ? 413 : e.status === 415 ? 415 : e.status === 504 ? 504 : 502;
    return c.json({ error: "upstream", reason: e.code }, status);
  }
  if (e instanceof BusyError) {
    c.header("Retry-After", "2");
    return c.json({ error: "busy" }, 503);
  }
  console.warn("[media] unexpected proxy error:", (e as Error)?.message ?? e);
  return c.json({ error: "upstream", reason: "internal" }, 502);
}

function assetResponse(c: Context, a: CachedAsset, filename: string): Response {
  return new Response(new Uint8Array(a.body), {
    status: 200,
    headers: {
      "Content-Type": a.contentType,
      "Content-Length": String(a.body.length),
      "Cache-Control": `private, max-age=${a.maxAge}`,
      "X-Content-Type-Options": "nosniff",
      // Even opened directly, a proxied response can never run anything.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

function gate(c: Context, bucket: "media" | "map", perMinute: number): { key: string } | Response {
  const who = signedInKey(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const retry = consumeRateLimit(`${bucket}-proxy:${who}`, perMinute, 60_000);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate_limited", retryAfter: retry }, 429);
  }
  return { key: who };
}

// ---------------------------------------------------------------------------
// /api/media
// ---------------------------------------------------------------------------

export const media = new Hono();

media.get("/proxy", async (c) => {
  if (!cfg.mediaEnabled) return c.json({ error: "disabled" }, 404);
  const g = gate(c, "media", cfg.imagesPerMinute);
  if (g instanceof Response) return g;
  const raw = c.req.query("u") ?? "";
  const policy: TargetPolicy = { httpHosts: cfg.httpHosts, extraPorts: cfg.extraPorts, forbiddenHosts: forbiddenHosts() };
  // Pre-network check of the URL the CLIENT supplied: its reason is safe to echo
  // (it says nothing about our network). Everything after it is collapsed.
  try {
    parseTarget(raw, policy);
  } catch (e) {
    if (e instanceof GuardError) return c.json({ error: "refused", reason: e.code }, 400);
    throw e;
  }
  try {
    const asset = await cached("media", g.key, "img", raw, async () => {
      const r = await guardedFetch(raw, {
        policy,
        maxBytes: cfg.maxImageBytes,
        timeoutMs: cfg.timeoutMs,
        accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
        transport: cfg.transport,
      });
      if (!upstreamTypeAllowed(r.contentType)) throw new FetchError("not_image", 415, "upstream is not a raster image");
      const type = sniffRaster(r.body);
      if (!type) throw new FetchError("not_image", 415, "upstream is not a raster image");
      const ttl = cacheSeconds(r.cacheControl, { min: 300, max: 7 * 86_400, fallback: 86_400 });
      return { asset: { contentType: type, body: r.body, maxAge: ttl || 300 }, ttl };
    });
    return assetResponse(c, asset, `image.${RASTER_EXT[asset.contentType as RasterType] ?? "img"}`);
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// /api/map — OpenFreeMap only
// ---------------------------------------------------------------------------

export const OFM_HOST = "tiles.openfreemap.org";
const OFM_ORIGIN = `https://${OFM_HOST}/`;
export const MAP_STYLES = ["liberty", "positron", "bright"] as const;
const MAP_POLICY: TargetPolicy = { hostAllowlist: [OFM_HOST] };
/** The local prefix every OpenFreeMap URL is rewritten to. */
export const MAP_PREFIX = "/api/map/ofm/";

type MapKind = "pbf" | "png" | "json";
/** The ONLY upstream paths the map proxy fetches (raw, still percent-encoded). */
export function classifyMapPath(path: string): { kind: MapKind; upstream: string } | null {
  if (path.length > 512 || path.includes("..") || path.includes("//") || /[?#\\]/.test(path)) return null;
  let m: RegExpExecArray | null;
  // Vector tiles: planet/<build>/<z>/<x>/<y>.pbf
  if ((m = /^planet\/(\d{8}_\d{6}_pt)\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.pbf$/.exec(path))) return { kind: "pbf", upstream: path };
  // Natural Earth shaded relief raster
  if (/^natural_earth\/ne2sr\/\d{1,2}\/\d{1,5}\/\d{1,5}\.png$/.test(path)) return { kind: "png", upstream: path };
  // Sprites
  if ((m = /^sprites\/([a-z0-9_]{1,40})\/([a-z0-9_]{1,40})(@2x)?\.(json|png)$/.exec(path))) return { kind: m[4] as MapKind, upstream: path };
  // Glyphs: fonts/<fontstack>/<start>-<end>.pbf (fontstack percent-encoded, may list several fonts)
  if ((m = /^fonts\/([A-Za-z0-9%,_ -]{1,200})\/(\d{1,5})-(\d{1,5})\.pbf$/.exec(path))) {
    let stack: string;
    try {
      stack = decodeURIComponent(m[1] ?? "");
    } catch {
      return null;
    }
    if (!/^[A-Za-z0-9 ,_-]{1,200}$/.test(stack)) return null;
    return { kind: "pbf", upstream: `fonts/${encodeURI(stack)}/${m[2]}-${m[3]}.pbf` };
  }
  return null;
}

/** Rewrite every OpenFreeMap URL in a JSON value to the local proxy prefix. */
export function rewriteOfmUrls<T>(v: T): T {
  if (typeof v === "string") return (v.startsWith(OFM_ORIGIN) ? MAP_PREFIX + v.slice(OFM_ORIGIN.length) : v) as T;
  if (Array.isArray(v)) return v.map(rewriteOfmUrls) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewriteOfmUrls(x)])) as T;
  return v;
}

const isAbsUrl = (s: unknown): boolean => typeof s === "string" && /^[a-z][a-z0-9+.-]*:/i.test(s);

/**
 * After rewriting, every asset URL in the style must be a LOCAL template whose
 * concrete form our own path allowlist would serve (fail closed). This is what
 * keeps a tampered or surprising upstream style from steering the client's map
 * protocol anywhere but /api/map/ofm/<allowlisted shape>.
 */
export function assertStyleLocal(style: Record<string, unknown>): void {
  const refuse = (): never => {
    throw new FetchError("style_foreign_url", 502, "style references a non-allowlisted URL");
  };
  const local = (u: unknown, samples: string[]) => {
    if (typeof u !== "string" || !u.startsWith(MAP_PREFIX) || isAbsUrl(u)) refuse();
    const rest = (u as string).slice(MAP_PREFIX.length);
    for (const sample of samples) {
      const concrete = rest
        .replace(/\{z\}/g, "3")
        .replace(/\{x\}/g, "1")
        .replace(/\{y\}/g, "2")
        .replace(/\{fontstack\}/g, "Noto Sans Regular")
        .replace(/\{range\}/g, "0-255") + sample;
      if (/[{}]/.test(concrete) || !classifyMapPath(concrete)) refuse();
    }
  };
  if (style.glyphs !== undefined) local(style.glyphs, [""]);
  const sprite = style.sprite;
  const spriteSamples = [".json", ".png", "@2x.json", "@2x.png"];
  if (Array.isArray(sprite)) sprite.forEach((s) => local((s as { url?: unknown })?.url, spriteSamples));
  else if (sprite !== undefined) local(sprite, spriteSamples);
  for (const src of Object.values((style.sources ?? {}) as Record<string, Record<string, unknown>>)) {
    if (src?.url !== undefined) refuse(); // TileJSON is always inlined server-side
    if (src?.data !== undefined && typeof src.data !== "object") refuse(); // no remote GeoJSON
    for (const t of (src?.tiles as unknown[]) ?? []) local(t, [""]);
  }
}

async function fetchOfm(path: string, kind: MapKind): Promise<{ body: Buffer; contentType: string; ttl: number }> {
  const r = await guardedFetch(OFM_ORIGIN + path, {
    policy: MAP_POLICY,
    maxBytes: cfg.maxMapBytes,
    timeoutMs: cfg.timeoutMs,
    accept: kind === "json" ? "application/json" : kind === "png" ? "image/png" : "application/x-protobuf,*/*;q=0.5",
    transport: cfg.transport,
  });
  // Tiles + glyphs under a versioned path are immutable-ish; keep them long.
  const ttl = cacheSeconds(r.cacheControl, { min: 3600, max: 30 * 86_400, fallback: 7 * 86_400 });
  if (kind === "png") {
    if (sniffRaster(r.body) !== "image/png") throw new FetchError("not_image", 415, "expected a PNG");
    return { body: r.body, contentType: "image/png", ttl };
  }
  if (kind === "json") {
    try {
      JSON.parse(r.body.toString("utf8"));
    } catch {
      throw new FetchError("bad_json", 502, "expected JSON");
    }
    return { body: r.body, contentType: "application/json", ttl };
  }
  return { body: r.body, contentType: "application/x-protobuf", ttl };
}

export const map = new Hono();

map.get("/style/:id", async (c) => {
  if (!cfg.mapEnabled) return c.json({ error: "disabled" }, 404);
  const g = gate(c, "map", cfg.mapPerMinute);
  if (g instanceof Response) return g;
  const id = c.req.param("id");
  if (!(MAP_STYLES as readonly string[]).includes(id)) return c.json({ error: "refused", reason: "unknown_style" }, 400);
  try {
    const asset = await cached("map", g.key, "map-style", id, async () => {
      const s = await fetchOfm(`styles/${id}`, "json");
      const style = JSON.parse(s.body.toString("utf8")) as Record<string, unknown>;
      // Inline each source's TileJSON so the client never resolves a relative
      // tile template itself (and the style is the only thing it needs to map).
      const sources = (style.sources ?? {}) as Record<string, Record<string, unknown>>;
      for (const src of Object.values(sources)) {
        const u = src?.url;
        if (typeof u !== "string") continue;
        if (!u.startsWith(OFM_ORIGIN) || !/^planet$/.test(u.slice(OFM_ORIGIN.length))) {
          throw new FetchError("style_foreign_url", 502, "style references an unexpected TileJSON");
        }
        const tj = JSON.parse((await fetchOfm("planet", "json")).body.toString("utf8")) as Record<string, unknown>;
        delete src.url;
        for (const k of ["tiles", "minzoom", "maxzoom", "bounds", "attribution", "scheme"]) if (tj[k] !== undefined) src[k] = tj[k];
      }
      const out = rewriteOfmUrls(style);
      assertStyleLocal(out);
      // Tile paths in the TileJSON point at one dated build, so re-check hourly.
      const body = Buffer.from(JSON.stringify(out));
      return { asset: { contentType: "application/json", body, maxAge: 3600 }, ttl: 3600 };
    });
    return assetResponse(c, asset, `${id}.json`);
  } catch (e) {
    return errorResponse(c, e);
  }
});

map.get("/ofm/*", async (c) => {
  if (!cfg.mapEnabled) return c.json({ error: "disabled" }, 404);
  const g = gate(c, "map", cfg.mapPerMinute);
  if (g instanceof Response) return g;
  const rawPath = new URL(c.req.url).pathname;
  const idx = rawPath.indexOf(MAP_PREFIX);
  const rest = idx >= 0 ? rawPath.slice(idx + MAP_PREFIX.length) : "";
  const cls = classifyMapPath(rest);
  if (!cls) return c.json({ error: "refused", reason: "path_not_allowed" }, 400);
  try {
    const asset = await cached("map", g.key, "map", cls.upstream, async () => {
      const r = await fetchOfm(cls.upstream, cls.kind);
      return { asset: { contentType: r.contentType, body: r.body, maxAge: r.ttl }, ttl: r.ttl };
    });
    const name = cls.upstream.split("/").pop() ?? "asset";
    return assetResponse(c, asset, name.replace(/[^A-Za-z0-9._@-]/g, "_"));
  } catch (e) {
    return errorResponse(c, e);
  }
});
