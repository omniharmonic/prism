/**
 * Client parity C: the external-image proxy (/api/media/proxy) and the
 * OpenFreeMap basemap proxy (/api/map/*). SSRF matrix, pinning, redirects,
 * content checks, limits, auth, cache and the map allowlist/rewrite.
 *
 * NOTHING here touches the internet: the DNS resolver is stubbed (setResolver)
 * and the pinned connection goes either to a canned in-memory transport or,
 * for real-socket behaviour (Host header, slow drip, abort), to a local
 * http.Server through the REAL node transport with the dialled address
 * recorded — so the test proves which IP the server would have connected to.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { issueDeviceToken } from "../src/auth/device";
import { isPublicAddress, parseIPv6, parseTarget, resolvePublic, setResolver, clearDnsNegativeCache, createCaresResolver, GuardError, type CaresResolverLike } from "../src/media/netguard";
import { guardedFetch, nodeTransport, cacheSeconds, FetchError, type Transport, type TransportRequest } from "../src/media/fetcher";
import { sniffRaster } from "../src/media/sniff";
import { DiskCache } from "../src/media/cache";
import { configureMedia, classifyMapPath, rewriteOfmUrls, mediaCache, assertStyleLocal } from "../src/routes/media";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><title>x</title>");

// ---------------------------------------------------------------------------
// Canned transport: host+path → response. Records every dial.
// ---------------------------------------------------------------------------
interface Canned {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
}
const dials: TransportRequest[] = [];
let routes = new Map<string, Canned>();
const cannedTransport: Transport = async (req) => {
  dials.push(req);
  const r = routes.get(`${req.host}${req.path}`) ?? { status: 404, body: Buffer.from("nope") };
  const body = r.body ?? Buffer.alloc(0);
  return {
    status: r.status ?? 200,
    headers: { "content-length": String(body.length), ...(r.headers ?? {}) },
    body: (async function* () {
      yield body;
    })(),
    destroy() {},
  };
};

const PUBLIC_V4 = "93.184.216.34";
const dns = new Map<string, string[]>();
let dnsCalls: string[] = [];
let cacheDir = "";

before(() => {
  setResolver(async (h) => {
    dnsCalls.push(h);
    const a = dns.get(h);
    if (!a) throw new Error("NXDOMAIN");
    return a;
  });
});
after(() => {
  setResolver(null);
  configureMedia(null);
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});
beforeEach(() => {
  resetDb();
  dials.length = 0;
  dnsCalls = [];
  routes = new Map();
  dns.clear();
  dns.set("img.example.com", [PUBLIC_V4]);
  dns.set("tiles.openfreemap.org", ["104.21.0.1"]);
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  cacheDir = mkdtempSync(join(tmpdir(), "prism-media-test-"));
  configureMedia({ cacheDir, transport: cannedTransport, timeoutMs: 2000 });
  clearDnsNegativeCache();
});

// ---------------------------------------------------------------------------
// netguard: address classification
// ---------------------------------------------------------------------------
test("isPublicAddress: every non-public IPv4/IPv6 class is refused", () => {
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.255",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.88.99.1", "192.168.1.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1",
    "64:ff9b::7f00:1", "64:ff9b::808:808", "fe80::1", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "100::1",
    "2001::1", "2001:0:4136:e378::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1",
    // unparseable / non-canonical spellings never count as public
    "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "1.2.3", "01.2.3.4", "fe80::1%en0", "", "example.com",
  ];
  for (const a of blocked) assert.equal(isPublicAddress(a), false, `${a} must be refused`);
  for (const a of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2a00:1450:4001::200e"]) {
    assert.equal(isPublicAddress(a), true, `${a} is public`);
  }
  assert.equal(parseIPv6("::ffff:127.0.0.1"), parseIPv6("::ffff:7f00:1"));
  assert.equal(parseIPv6("1:2:3:4:5:6:7:8:9"), null);
});

test("parseTarget: only https DNS names on 443; every IP-literal spelling, userinfo and local name refused", () => {
  const refused: Array<[string, string]> = [
    ["http://img.example.com/a.png", "bad_scheme"],
    ["ftp://img.example.com/a.png", "bad_scheme"],
    ["file:///etc/passwd", "bad_scheme"],
    ["data:image/png;base64,AAAA", "bad_scheme"],
    ["https://127.0.0.1/a.png", "ip_literal"],
    ["https://2130706433/a.png", "ip_literal"], // decimal
    ["https://0x7f000001/a.png", "ip_literal"], // hex
    ["https://0177.0.0.1/a.png", "ip_literal"], // octal
    ["https://127.1/a.png", "ip_literal"], // short form
    ["https://[::1]/a.png", "ip_literal"],
    ["https://[::ffff:127.0.0.1]/a.png", "ip_literal"],
    ["https://[::ffff:a9fe:a9fe]/latest", "ip_literal"], // mapped metadata IP
    ["https://169.254.169.254/latest/meta-data", "ip_literal"],
    ["https://user:pw@img.example.com/a.png", "bad_url"],
    ["https://img.example.com:8443/a.png", "bad_port"],
    ["https://img.example.com:22/a.png", "bad_port"],
    ["https://localhost/a.png", "bad_host"],
    ["https://intranet/a.png", "bad_host"],
    ["https://printer.local/a.png", "bad_host"],
    ["https://metadata.google.internal/x", "bad_host"],
    ["not a url", "bad_url"],
    ["/relative.png", "bad_url"],
  ];
  for (const [u, code] of refused) {
    assert.throws(() => parseTarget(u), (e: unknown) => e instanceof GuardError && e.code === code, `${u} → ${code}`);
  }
  assert.equal(parseTarget("https://IMG.example.com./a.png").host, "img.example.com");
  assert.equal(parseTarget("http://img.example.com/a.png", { httpHosts: ["img.example.com"] }).port, 80);
  assert.equal(parseTarget("https://img.example.com:8443/a.png", { extraPorts: [8443] }).port, 8443);
  assert.throws(() => parseTarget("https://evil.example.com/x", { hostAllowlist: ["tiles.openfreemap.org"] }), /allowlist/);
  assert.throws(() => parseTarget("https://prism.example.com/api/notes", { forbiddenHosts: ["prism.example.com"] }), /never proxied/);
});

test("resolvePublic: private, mixed and non-canonical answers refuse the host", async () => {
  const cases: Record<string, string[]> = {
    "a.test.example": ["127.0.0.1"],
    "b.test.example": ["10.1.2.3"],
    "c.test.example": [PUBLIC_V4, "192.168.0.10"], // split answer = attack
    "d.test.example": ["::ffff:169.254.169.254"],
    "e.test.example": ["2130706433"], // resolver handing back a decimal form
    "f.test.example": ["0x7f.0.0.1"],
    "g.test.example": ["fd00::1"],
    "h.test.example": ["100.64.1.1"],
    "i.test.example": [],
  };
  for (const [h, a] of Object.entries(cases)) dns.set(h, a);
  for (const h of Object.keys(cases)) {
    await assert.rejects(resolvePublic(h), (e: unknown) => e instanceof GuardError && (e.code === "private_address" || e.code === "dns_failed"), h);
  }
  dns.set("v6.test.example", ["2606:4700::1111", PUBLIC_V4]);
  assert.equal(await resolvePublic("v6.test.example"), PUBLIC_V4, "IPv4 preferred");
  await assert.rejects(resolvePublic("nxdomain.example"), /resolve/);
});

// ---------------------------------------------------------------------------
// guardedFetch over a REAL socket (local server), dial address recorded
// ---------------------------------------------------------------------------
async function withServer(handler: http.RequestListener, fn: (port: number) => Promise<void>): Promise<void> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    await fn(port);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
}
/** Real node transport, but the pinned public IP is swapped for the local server (recorded first). */
const viaLocal = (port: number, seen: TransportRequest[]): Transport => (req) => {
  seen.push(req);
  return nodeTransport({ ...req, ip: "127.0.0.1", port, protocol: "http:" });
};

test("guardedFetch: dials the pinned address with Host = the name; forwards no client credentials", async () => {
  let gotHost = "";
  let gotHeaders: http.IncomingHttpHeaders = {};
  await withServer(
    (req, res) => {
      gotHost = req.headers.host ?? "";
      gotHeaders = req.headers;
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=600" }).end(PNG);
    },
    async (port) => {
      const seen: TransportRequest[] = [];
      const r = await guardedFetch("https://img.example.com/a.png?x=1", { policy: {}, maxBytes: 1024, timeoutMs: 2000, accept: "image/*", transport: viaLocal(port, seen) });
      assert.equal(r.body.equals(PNG), true);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.ip, PUBLIC_V4, "connects to the address WE resolved");
      assert.equal(seen[0]!.host, "img.example.com");
      assert.equal(seen[0]!.path, "/a.png?x=1");
      assert.equal(gotHost, `img.example.com:${port}`, "Host is the NAME (port = the local stand-in), never the IP");
      assert.equal(gotHeaders.cookie, undefined);
      assert.equal(gotHeaders.authorization, undefined);
      assert.equal(cacheSeconds(r.cacheControl, { min: 1, max: 9999, fallback: 5 }), 600);
    },
  );
});

test("guardedFetch: DNS rebinding — a redirect back to the same name re-resolves and is refused when it turns private", async () => {
  let n = 0;
  setResolver(async (h) => {
    if (h !== "rebind.example.com") throw new Error("NXDOMAIN");
    return ++n === 1 ? [PUBLIC_V4] : ["127.0.0.1"];
  });
  try {
    await withServer(
      (_req, res) => res.writeHead(302, { location: "/again.png" }).end(),
      async (port) => {
        const seen: TransportRequest[] = [];
        await assert.rejects(
          guardedFetch("https://rebind.example.com/a.png", { policy: {}, maxBytes: 1024, timeoutMs: 2000, accept: "image/*", transport: viaLocal(port, seen) }),
          (e: unknown) => e instanceof GuardError && e.code === "private_address",
        );
        assert.equal(seen.length, 1, "the private answer was never dialled");
      },
    );
  } finally {
    setResolver(async (h) => {
      dnsCalls.push(h);
      const a = dns.get(h);
      if (!a) throw new Error("NXDOMAIN");
      return a;
    });
  }
});

test("guardedFetch: redirects to private/literal/http/foreign-port targets are refused; >3 hops refused", async () => {
  dns.set("internal.example.com", ["10.0.0.5"]);
  const go = (loc: string) => {
    routes.set("img.example.com/r", { status: 302, headers: { location: loc } });
    return guardedFetch("https://img.example.com/r", { policy: {}, maxBytes: 1024, timeoutMs: 2000, accept: "image/*", transport: cannedTransport });
  };
  await assert.rejects(go("https://127.0.0.1/x"), /IP-address/);
  await assert.rejects(go("https://[::1]/x"), /IP-address/);
  await assert.rejects(go("https://internal.example.com/x"), /non-public/);
  await assert.rejects(go("http://img.example.com/x"), /only https/);
  await assert.rejects(go("https://img.example.com:6379/x"), /port/);
  await assert.rejects(go("file:///etc/passwd"), /only https/);
  // 4 hops
  for (let i = 0; i < 5; i++) routes.set(`img.example.com/h${i}`, { status: 301, headers: { location: `/h${i + 1}` } });
  await assert.rejects(
    guardedFetch("https://img.example.com/h0", { policy: {}, maxBytes: 1024, timeoutMs: 2000, accept: "image/*", transport: cannedTransport }),
    (e: unknown) => e instanceof FetchError && e.code === "too_many_redirects",
  );
  // 3 hops is fine
  routes.set("img.example.com/h3", { status: 200, headers: { "content-type": "image/png" }, body: PNG });
  const ok = await guardedFetch("https://img.example.com/h0", { policy: {}, maxBytes: 1024, timeoutMs: 2000, accept: "image/*", transport: cannedTransport });
  assert.equal(ok.url, "https://img.example.com/h3");
});

test("guardedFetch: size cap (declared and streamed) and a slow-drip server time out", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/declared") return res.writeHead(200, { "content-length": "999999" }).end();
      if (req.url === "/streamed") {
        res.writeHead(200, { "content-type": "image/png" }); // chunked, no length
        res.write(Buffer.alloc(800));
        res.end(Buffer.alloc(800));
        return;
      }
      // slowloris: headers, then one byte every 200 ms forever
      res.writeHead(200, { "content-type": "image/png" });
      const t = setInterval(() => res.write("x"), 200);
      res.on("close", () => clearInterval(t));
    },
    async (port) => {
      const t = viaLocal(port, []);
      const opts = { policy: {}, maxBytes: 1000, timeoutMs: 700, accept: "image/*", transport: t };
      await assert.rejects(guardedFetch("https://img.example.com/declared", opts), (e: unknown) => e instanceof FetchError && e.code === "too_large");
      await assert.rejects(guardedFetch("https://img.example.com/streamed", opts), (e: unknown) => e instanceof FetchError && e.code === "too_large");
      const started = Date.now();
      await assert.rejects(guardedFetch("https://img.example.com/drip", opts), (e: unknown) => e instanceof FetchError && e.code === "timeout");
      // (No duration is asserted: the dependency here NEVER answers, so finishing at all is the proof that the deadline ended it — and a wall-clock bound fails on a busy machine without anything being wrong.)
    },
  );
});

test("sniffRaster: real formats in, SVG/HTML/text out", () => {
  assert.equal(sniffRaster(PNG), "image/png");
  assert.equal(sniffRaster(GIF), "image/gif");
  assert.equal(sniffRaster(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(sniffRaster(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(sniffRaster(SVG), null);
  assert.equal(sniffRaster(HTML), null);
  assert.equal(sniffRaster(Buffer.from("<?xml version='1.0'?><svg/>")), null);
});

// ---------------------------------------------------------------------------
// /api/media/proxy route
// ---------------------------------------------------------------------------
const app = createApp();
const proxyUrl = (u: string) => `/api/media/proxy?u=${encodeURIComponent(u)}`;
const asUser = (email = "member@test.local") => ({ Cookie: sessionCookie(makeSession(email)) });

test("media proxy: signed-in session and device token get the image with hardened headers", async () => {
  routes.set("img.example.com/a.png", { headers: { "content-type": "image/png", "set-cookie": "tracker=1", "x-evil": "1" }, body: PNG });
  const res = await app.request(proxyUrl("https://img.example.com/a.png"), { headers: asUser() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox", "the app CSP does not overwrite the proxy's");
  assert.match(res.headers.get("content-disposition") ?? "", /^inline; filename="image\.png"$/);
  assert.match(res.headers.get("cache-control") ?? "", /^private, max-age=\d+$/);
  assert.equal(res.headers.get("set-cookie"), null, "no upstream header passes through");
  assert.equal(res.headers.get("x-evil"), null);
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(PNG), true);

  const { token } = issueDeviceToken("member@test.local", "Mac", "prism-client");
  routes.set("img.example.com/b.png", { headers: { "content-type": "image/png" }, body: PNG });
  const dev = await app.request(proxyUrl("https://img.example.com/b.png"), { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(dev.status, 200);
});

test("media proxy: anon, capability links and a revoked/garbage bearer are refused before any fetch", async () => {
  routes.set("img.example.com/a.png", { headers: { "content-type": "image/png" }, body: PNG });
  const u = proxyUrl("https://img.example.com/a.png");
  assert.equal((await app.request(u)).status, 401);
  const cap = makeCapability("tag", "public", "view");
  assert.equal((await app.request(`${u}&t=${encodeURIComponent(cap)}`)).status, 401);
  assert.equal((await app.request(u, { headers: { Authorization: `Capability ${cap}` } })).status, 401);
  assert.equal((await app.request(u, { headers: { Authorization: "Bearer pd_notarealtoken" } })).status, 401);
  assert.equal(dials.length, 0);
  assert.equal(dnsCalls.length, 0);
});

test("media proxy: SVG, HTML, mislabelled HTML and oversize are refused; nothing is cached", async () => {
  routes.set("img.example.com/x.svg", { headers: { "content-type": "image/svg+xml" }, body: SVG });
  routes.set("img.example.com/svg-as-png", { headers: { "content-type": "image/png" }, body: SVG });
  routes.set("img.example.com/page", { headers: { "content-type": "text/html" }, body: HTML });
  routes.set("img.example.com/html-as-png", { headers: { "content-type": "image/png" }, body: HTML });
  for (const p of ["x.svg", "svg-as-png", "page", "html-as-png"]) {
    const r = await app.request(proxyUrl(`https://img.example.com/${p}`), { headers: asUser() });
    assert.equal(r.status, 415, p);
    assert.deepEqual(await r.json(), { error: "upstream", reason: "not_image" });
  }
  configureMedia({ cacheDir, transport: cannedTransport, maxImageBytes: 10 });
  routes.set("img.example.com/big.png", { headers: { "content-type": "image/png" }, body: PNG });
  assert.equal((await app.request(proxyUrl("https://img.example.com/big.png"), { headers: asUser() })).status, 413);
  assert.equal(mediaCache().stats().entries, 0);
});

test("media proxy: SSRF refusals surface as 400 with a reason; the server's own hosts are never proxied", async () => {
  dns.set("evil.example.com", ["127.0.0.1"]);
  const cases: Array<[string, string]> = [
    ["https://evil.example.com/a.png", "refused"], // post-parse refusals are ONE generic code (no DNS oracle)
    ["https://169.254.169.254/latest/meta-data/", "ip_literal"],
    ["http://img.example.com/a.png", "bad_scheme"],
    ["https://vault.test/vault/default/api/notes", "forbidden_host"], // PARACHUTE_URL host (.env.test)
    ["", "bad_url"],
  ];
  for (const [u, reason] of cases) {
    const r = await app.request(proxyUrl(u), { headers: asUser() });
    assert.equal(r.status, 400, u);
    assert.equal(((await r.json()) as { reason: string }).reason, reason, u);
  }
  assert.equal(dials.length, 0);
});

test("media proxy: cache serves repeats without an upstream call; no-store is not persisted", async () => {
  routes.set("img.example.com/c.png", { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" }, body: PNG });
  const h = asUser();
  assert.equal((await app.request(proxyUrl("https://img.example.com/c.png"), { headers: h })).status, 200);
  assert.equal((await app.request(proxyUrl("https://img.example.com/c.png"), { headers: h })).status, 200);
  assert.equal(dials.length, 1, "second hit came from the disk cache");
  assert.equal(mediaCache().stats().entries, 1);

  routes.set("img.example.com/ns.png", { headers: { "content-type": "image/png", "cache-control": "no-store" }, body: PNG });
  await app.request(proxyUrl("https://img.example.com/ns.png"), { headers: h });
  await app.request(proxyUrl("https://img.example.com/ns.png"), { headers: h });
  assert.equal(dials.length, 3);
  assert.equal(mediaCache().stats().entries, 1);
});

test("DiskCache: LRU eviction under the byte cap, expiry, survives a reload from disk", async () => {
  let now = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), "prism-media-lru-"));
  try {
    const c = new DiskCache(dir, 250, () => now);
    await c.put("a".repeat(64), "image/png", Buffer.alloc(100), 60);
    await c.put("b".repeat(64), "image/png", Buffer.alloc(100), 60);
    assert.ok(await c.get("a".repeat(64))); // touch a → b is now LRU
    await c.put("c".repeat(64), "image/png", Buffer.alloc(100), 60);
    assert.equal(await c.get("b".repeat(64)), null, "LRU entry evicted");
    assert.ok(await c.get("a".repeat(64)));
    assert.equal(c.stats().bytes, 200);
    const reloaded = new DiskCache(dir, 250, () => now);
    await reloaded.ready();
    assert.equal(reloaded.stats().entries, 2);
    now += 61_000;
    assert.equal(await reloaded.get("a".repeat(64)), null, "expired");
    assert.equal(DiskCache.key("img", "https://x/y").length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media proxy: per-user rate limit", async () => {
  configureMedia({ cacheDir, transport: cannedTransport, imagesPerMinute: 2 });
  routes.set("img.example.com/r.png", { headers: { "content-type": "image/png" }, body: PNG });
  const h = asUser("ratelimited@test.local");
  assert.equal((await app.request(proxyUrl("https://img.example.com/r.png"), { headers: h })).status, 200);
  assert.equal((await app.request(proxyUrl("https://img.example.com/r.png"), { headers: h })).status, 200);
  const third = await app.request(proxyUrl("https://img.example.com/r.png"), { headers: h });
  assert.equal(third.status, 429);
  assert.ok(third.headers.get("retry-after"));
  // a different user has their own bucket
  assert.equal((await app.request(proxyUrl("https://img.example.com/r.png"), { headers: asUser("other@test.local") })).status, 200);
});

// ---------------------------------------------------------------------------
// /api/map
// ---------------------------------------------------------------------------
const OFM = "https://tiles.openfreemap.org";
const STYLE = {
  version: 8,
  sources: {
    openmaptiles: { type: "vector", url: `${OFM}/planet` },
    ne2_shaded: { type: "raster", tileSize: 256, maxzoom: 6, tiles: [`${OFM}/natural_earth/ne2sr/{z}/{x}/{y}.png`] },
  },
  sprite: `${OFM}/sprites/ofm_f384/ofm`,
  glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#fff" } }, { id: "label", type: "symbol", source: "openmaptiles", layout: { "text-field": "https://tiles.openfreemap.org is just text here" } }],
};
const TILEJSON = { tilejson: "3.0.0", tiles: [`${OFM}/planet/20260927_080001_pt/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14, attribution: "OpenFreeMap" };

test("map: style is fetched, TileJSON inlined, every asset URL rewritten to /api/map/ofm/", async () => {
  routes.set("tiles.openfreemap.org/styles/liberty", { headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(STYLE)) });
  routes.set("tiles.openfreemap.org/planet", { headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(TILEJSON)) });
  const res = await app.request("/api/map/style/liberty", { headers: asUser() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const s = (await res.json()) as { sources: Record<string, Record<string, unknown>>; sprite: unknown; glyphs: unknown };
  assert.equal(s.sources.openmaptiles!.url, undefined);
  assert.deepEqual(s.sources.openmaptiles!.tiles, ["/api/map/ofm/planet/20260927_080001_pt/{z}/{x}/{y}.pbf"]);
  assert.equal(s.sources.openmaptiles!.maxzoom, 14);
  assert.deepEqual(s.sources.ne2_shaded!.tiles, ["/api/map/ofm/natural_earth/ne2sr/{z}/{x}/{y}.png"]);
  assert.equal(s.sprite, "/api/map/ofm/sprites/ofm_f384/ofm");
  assert.equal(s.glyphs, "/api/map/ofm/fonts/{fontstack}/{range}.pbf");
  assert.ok(!JSON.stringify(s.sources).includes("openfreemap.org"));
  assert.ok(dials.every((d) => d.host === "tiles.openfreemap.org" && d.protocol === "https:" && d.port === 443));
  // unknown style id never reaches upstream
  const n = dials.length;
  assert.equal((await app.request("/api/map/style/evil", { headers: asUser() })).status, 400);
  assert.equal(dials.length, n);
});

test("map: a style pointing at a foreign host is refused (fail closed)", async () => {
  routes.set("tiles.openfreemap.org/styles/bright", { body: Buffer.from(JSON.stringify({ ...STYLE, sources: {}, sprite: "https://evil.example.com/sprite" })) });
  assert.equal((await app.request("/api/map/style/bright", { headers: asUser() })).status, 502);
  routes.set("tiles.openfreemap.org/styles/positron", { body: Buffer.from(JSON.stringify({ ...STYLE, sources: { x: { type: "vector", url: "https://evil.example.com/tj" } } })) });
  assert.equal((await app.request("/api/map/style/positron", { headers: asUser() })).status, 502);
  assert.ok(dials.every((d) => d.host === "tiles.openfreemap.org"));
});

test("map: tiles/glyphs/sprites on the path allowlist are proxied (and cached); everything else is refused", async () => {
  routes.set("tiles.openfreemap.org/planet/20260927_080001_pt/8/53/97.pbf", { headers: { "content-type": "application/x-protobuf" }, body: Buffer.from([0x1a, 0x02, 0x08, 0x01]) });
  routes.set("tiles.openfreemap.org/natural_earth/ne2sr/3/1/2.png", { headers: { "content-type": "image/png" }, body: PNG });
  routes.set("tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.json", { headers: { "content-type": "application/json" }, body: Buffer.from("{}") });
  routes.set("tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf", { body: Buffer.from([1, 2, 3]) });
  const h = asUser();
  const tile = await app.request("/api/map/ofm/planet/20260927_080001_pt/8/53/97.pbf", { headers: h });
  assert.equal(tile.status, 200);
  assert.equal(tile.headers.get("content-type"), "application/x-protobuf");
  assert.equal((await app.request("/api/map/ofm/planet/20260927_080001_pt/8/53/97.pbf", { headers: h })).status, 200);
  assert.equal(dials.filter((d) => d.path.endsWith("97.pbf")).length, 1, "tile cached");
  assert.equal((await app.request("/api/map/ofm/natural_earth/ne2sr/3/1/2.png", { headers: h })).headers.get("content-type"), "image/png");
  assert.equal((await app.request("/api/map/ofm/sprites/ofm_f384/ofm@2x.json", { headers: h })).status, 200);
  assert.equal((await app.request("/api/map/ofm/fonts/Noto%20Sans%20Regular/0-255.pbf", { headers: h })).status, 200);

  const before = dials.length;
  for (const p of [
    "planet",
    "styles/liberty",
    "planet/latest/1/2/3.pbf",
    "fonts/Noto%2F..%2Fx/0-255.pbf",
    "fonts/Noto%20Sans/0-255.pbf%3Fx",
    "natural_earth/ne2sr/1/2/3.svg",
    "anything/else",
  ]) {
    const r = await app.request(`/api/map/ofm/${p}`, { headers: h });
    assert.equal(r.status, 400, p);
  }
  // A literal "../" is normalised away by URL parsing before routing: it never reaches the map proxy at all.
  for (const p of ["sprites/../../etc/passwd", "sprites/%2E%2E/%2E%2E/etc/passwd"]) {
    assert.notEqual((await app.request(`/api/map/ofm/${p}`, { headers: h })).status, 200, p);
  }
  assert.equal(dials.length, before, "refused paths never reach upstream");
  assert.equal(classifyMapPath("fonts/Noto Sans Bold,Noto Sans Regular/256-511.pbf")?.upstream, "fonts/Noto%20Sans%20Bold,Noto%20Sans%20Regular/256-511.pbf");
  // the PNG kind is sniffed
  routes.set("tiles.openfreemap.org/natural_earth/ne2sr/4/1/2.png", { headers: { "content-type": "image/png" }, body: HTML });
  assert.equal((await app.request("/api/map/ofm/natural_earth/ne2sr/4/1/2.png", { headers: h })).status, 415);
});

test("map: signed-in only; host allowlist is enforced even on redirects", async () => {
  assert.equal((await app.request("/api/map/style/liberty")).status, 401);
  const cap = makeCapability("tag", "public", "view");
  assert.equal((await app.request(`/api/map/ofm/planet/20260927_080001_pt/1/1/1.pbf?t=${encodeURIComponent(cap)}`)).status, 401);
  dns.set("cdn.example.com", [PUBLIC_V4]);
  routes.set("tiles.openfreemap.org/planet/20260927_080001_pt/1/1/1.pbf", { status: 302, headers: { location: "https://cdn.example.com/x.pbf" } });
  const r = await app.request("/api/map/ofm/planet/20260927_080001_pt/1/1/1.pbf", { headers: asUser() });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { reason: string }).reason, "refused");
  assert.ok(!dials.some((d) => d.host === "cdn.example.com"));
});

test("rewriteOfmUrls only touches strings that START with the OpenFreeMap origin", () => {
  assert.deepEqual(rewriteOfmUrls({ a: ["https://tiles.openfreemap.org/x", "see https://tiles.openfreemap.org/x"], b: 1 }), {
    a: ["/api/map/ofm/x", "see https://tiles.openfreemap.org/x"],
    b: 1,
  });
});

// ---------------------------------------------------------------------------
// Security review fixes (M1, L1, L3, L4, L5, L6, env-proxy pin)
// ---------------------------------------------------------------------------

/** Canned transport + a host whose connection hangs until the request deadline aborts it. */
const hangingTransport: Transport = (req) => {
  if (req.host !== "slow.example.com") return cannedTransport(req);
  dials.push(req);
  return new Promise((_resolve, reject) => {
    req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
};

test("M1: a user saturating their in-flight cap blocks neither another user nor the map pool", async () => {
  dns.set("slow.example.com", [PUBLIC_V4]);
  configureMedia({ cacheDir, transport: hangingTransport, timeoutMs: 800, mediaPerUser: 2, mediaInflight: 4, mapPerUser: 2, mapInflight: 4, queueWaitMs: 50 });
  routes.set("img.example.com/ok.png", { headers: { "content-type": "image/png" }, body: PNG });
  routes.set("tiles.openfreemap.org/planet/20260927_080001_pt/1/1/1.pbf", { body: Buffer.from([1]) });
  const attacker = asUser("attacker@test.local");
  // Two slow-drip URLs fill the attacker's two media slots...
  const parked = [1, 2].map((i) => app.request(proxyUrl(`https://slow.example.com/${i}.png`), { headers: attacker }));
  await new Promise((r) => setTimeout(r, 20));
  // ...a third unique URL waits queueWaitMs for the attacker's OWN slot, then 503.
  const third = await app.request(proxyUrl("https://slow.example.com/3.png"), { headers: attacker });
  assert.equal(third.status, 503);
  // Another user is unaffected (their own per-user slots; the global pool still has room).
  assert.equal((await app.request(proxyUrl("https://img.example.com/ok.png"), { headers: asUser("victim@test.local") })).status, 200);
  // The map is a SEPARATE pool: even the attacker's own basemap still loads.
  assert.equal((await app.request("/api/map/ofm/planet/20260927_080001_pt/1/1/1.pbf", { headers: attacker })).status, 200);
  // The parked requests end at the deadline (504), freeing the slots.
  for (const p of parked) assert.equal((await p).status, 504);
});

test("M1: the global pool still caps total upstream fetches across users", async () => {
  dns.set("slow.example.com", [PUBLIC_V4]);
  configureMedia({ cacheDir, transport: hangingTransport, timeoutMs: 600, mediaPerUser: 3, mediaInflight: 2, queueWaitMs: 50 });
  const parked = ["u1@test.local", "u2@test.local"].map((u, i) => app.request(proxyUrl(`https://slow.example.com/g${i}.png`), { headers: asUser(u) }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await app.request(proxyUrl("https://slow.example.com/g9.png"), { headers: asUser("u3@test.local") })).status, 503);
  for (const p of parked) assert.equal((await p).status, 504);
});

test("M1: a hung resolver is cut off at the deadline (signal aborted) and the host is negative-cached", async () => {
  let calls = 0;
  let sawAbort = false;
  setResolver((_host, signal) => {
    calls++;
    return new Promise((_r, reject) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        reject(new Error("cancelled"));
      });
    });
  });
  try {
    configureMedia({ cacheDir, transport: cannedTransport, timeoutMs: 300 });
    const started = Date.now();
    const r = await app.request(proxyUrl("https://blackhole.example.com/a.png"), { headers: asUser() });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "refused", reason: "refused" });
    // (No duration is asserted: the dependency here NEVER answers, so finishing at all is the proof that the deadline ended it — and a wall-clock bound fails on a busy machine without anything being wrong.)
    assert.equal(sawAbort, true, "the resolver was told to cancel");
    // Within the negative TTL: no new DNS query for that host, even for another URL.
    assert.equal((await app.request(proxyUrl("https://blackhole.example.com/other.png"), { headers: asUser() })).status, 400);
    assert.equal(calls, 1);
    assert.equal(dials.length, 0);
  } finally {
    setResolver(async (h) => {
      dnsCalls.push(h);
      const a = dns.get(h);
      if (!a) throw new Error("NXDOMAIN");
      return a;
    });
  }
});

test("M1: the production resolver is c-ares (dns.promises.Resolver) with timeout/tries, cancelled on abort — never getaddrinfo", async () => {
  const made: Array<{ opts: { timeout: number; tries: number }; cancelled: boolean }> = [];
  class FakeResolver implements CaresResolverLike {
    rec: { opts: { timeout: number; tries: number }; cancelled: boolean };
    constructor(opts: { timeout: number; tries: number }) {
      this.rec = { opts, cancelled: false };
      made.push(this.rec);
    }
    resolve4(): Promise<string[]> {
      return new Promise(() => {}); // hangs forever
    }
    resolve6(): Promise<string[]> {
      return new Promise(() => {});
    }
    cancel(): void {
      this.rec.cancelled = true;
    }
  }
  const resolve = createCaresResolver(FakeResolver);
  const ctl = new AbortController();
  const p = resolve("hang.example.com", ctl.signal);
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(p, /aborted/);
  assert.equal(made.length, 1);
  assert.equal(made[0]!.cancelled, true);
  assert.ok(made[0]!.opts.timeout > 0 && made[0]!.opts.timeout <= 5000 && made[0]!.opts.tries >= 1);
  // A normal answer merges A + AAAA.
  class OkResolver extends FakeResolver {
    override resolve4() {
      return Promise.resolve([PUBLIC_V4]);
    }
    override resolve6() {
      return Promise.reject(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
    }
  }
  assert.deepEqual(await createCaresResolver(OkResolver)("ok.example.com", new AbortController().signal), [PUBLIC_V4]);
  // And the module never calls getaddrinfo (dns.lookup) — it would block libuv's threadpool.
  const src = readFileSync(new URL("../src/media/netguard.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, ""); // code only, not comments
  assert.ok(/import \{ Resolver as DnsResolver \} from "node:dns\/promises"/.test(src));
  assert.ok(!/\blookup\b\s*\(/.test(src) && !/import\s*\{[^}]*\blookup\b/.test(src), "no dns.lookup");
});

test("negative cache: an upstream failure is remembered per URL (no re-fetch within the TTL)", async () => {
  routes.set("img.example.com/gone.png", { status: 404, body: Buffer.from("x") });
  const h = asUser();
  assert.equal((await app.request(proxyUrl("https://img.example.com/gone.png"), { headers: h })).status, 404);
  assert.equal((await app.request(proxyUrl("https://img.example.com/gone.png"), { headers: h })).status, 404);
  assert.equal(dials.length, 1);
});

test("L3: DNS failure, private answer and a refused redirect hop all look the same to the client", async () => {
  dns.set("internal-only.example.com", ["10.1.1.1"]);
  dns.set("redir.example.com", [PUBLIC_V4]);
  routes.set("redir.example.com/r", { status: 302, headers: { location: "https://127.0.0.1/x" } });
  const bodies = [];
  for (const u of ["https://nxdomain.example.com/a.png", "https://internal-only.example.com/a.png", "https://redir.example.com/r"]) {
    const r = await app.request(proxyUrl(u), { headers: asUser() });
    bodies.push([r.status, await r.json()]);
  }
  for (const b of bodies) assert.deepEqual(b, [400, { error: "refused", reason: "refused" }]);
});

test("L4: trailing dots stripped; empty and hyphen-edged labels refused", () => {
  assert.equal(parseTarget("https://img.example.com../a.png").host, "img.example.com");
  for (const u of ["https://a..example.com/x", "https://-a.example.com/x", "https://a-.example.com/x", "https://img.-example.com/x", `https://${"a".repeat(64)}.example.com/x`]) {
    assert.throws(() => parseTarget(u), (e: unknown) => e instanceof GuardError && e.code === "bad_host", u);
  }
});

test("L5: BMP/ICO need valid header fields, not just magic bytes", () => {
  const bmp = Buffer.alloc(80);
  bmp.write("BM", 0, "latin1");
  bmp.writeUInt32LE(80, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  assert.equal(sniffRaster(bmp), "image/bmp");
  assert.equal(sniffRaster(Buffer.concat([Buffer.from("BM", "latin1"), Buffer.from("<html><script>x</script></html>........")])), null);
  const ico = Buffer.alloc(6 + 16 + 8);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt32LE(8, 6 + 8);
  ico.writeUInt32LE(22, 6 + 12);
  assert.equal(sniffRaster(ico), "image/x-icon");
  assert.equal(sniffRaster(Buffer.from([0, 0, 1, 0, 0, 0, 0x3c, 0x68])), null, "zero entries");
  const badIco = Buffer.from(ico);
  badIco.writeUInt32LE(9999, 6 + 12);
  assert.equal(sniffRaster(badIco), null, "image data outside the file");
});

test("L6: cache load removes stray temp files and orphaned bodies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-media-stray-"));
  try {
    const c = new DiskCache(dir, 10_000);
    await c.put("d".repeat(64), "image/png", Buffer.alloc(10), 60);
    writeFileSync(join(dir, `${"e".repeat(64)}.bin.tmp-abc123`), "half");
    writeFileSync(join(dir, `${"f".repeat(64)}.bin`), "orphan");
    writeFileSync(join(dir, `${"0".repeat(64)}.json`), "{not json");
    const fresh = new DiskCache(dir, 10_000);
    await fresh.ready();
    assert.deepEqual(readdirSync(dir).sort(), [`${"d".repeat(64)}.bin`, `${"d".repeat(64)}.json`]);
    assert.equal(fresh.stats().entries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L1 (server): every rewritten tile/glyph/sprite template must match the path allowlist (fail closed)", async () => {
  const good = { version: 8, sprite: "/api/map/ofm/sprites/ofm_f384/ofm", glyphs: "/api/map/ofm/fonts/{fontstack}/{range}.pbf", sources: { o: { type: "vector", tiles: ["/api/map/ofm/planet/20260927_080001_pt/{z}/{x}/{y}.pbf"] }, r: { type: "raster", tiles: ["/api/map/ofm/natural_earth/ne2sr/{z}/{x}/{y}.png"] } } };
  assertStyleLocal(good);
  const bad: Array<Record<string, unknown>> = [
    { ...good, sprite: "/api/map/ofm/planet" },
    { ...good, sprite: "/api/map/ofm/%2e%2e/%2e%2e/acl/workers" },
    { ...good, glyphs: "/api/map/ofm/fonts/{fontstack}/x.pbf" },
    { ...good, glyphs: "/api/acl/workers" },
    { ...good, sources: { o: { type: "vector", tiles: ["/api/map/ofm/%2e%2e/%2e%2e/acl/{z}/{x}/{y}"] } } },
    { ...good, sources: { o: { type: "vector", tiles: ["/api/map/ofm/planet/20260927_080001_pt/{z}/{x}/{y}.pbf?x={q}"] } } },
    { ...good, sources: { o: { type: "vector", url: "/api/map/ofm/planet" } } },
    { ...good, sources: { o: { type: "geojson", data: "https://evil.example.com/x.json" } } },
  ];
  for (const s of bad) assert.throws(() => assertStyleLocal(s), /non-allowlisted/, JSON.stringify(s).slice(0, 120));
  // End to end: an upstream style whose sprite rewrites to a non-sprite path is refused.
  routes.set("tiles.openfreemap.org/styles/liberty", { body: Buffer.from(JSON.stringify({ ...STYLE, sources: {}, sprite: `${OFM}/planet` })) });
  assert.equal((await app.request("/api/map/style/liberty", { headers: asUser() })).status, 502);
});

test("env proxy is bypassed: with NODE_USE_ENV_PROXY + HTTP(S)_PROXY set, the pinned transport still dials the checked IP directly", async () => {
  const proxyHits: string[] = [];
  const targetHits: string[] = [];
  const proxy = http.createServer((req, res) => {
    proxyHits.push(req.url ?? "");
    res.writeHead(502).end();
  });
  const target = http.createServer((req, res) => {
    targetHits.push(req.headers.host ?? "");
    res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  });
  await Promise.all([new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r)), new Promise<void>((r) => target.listen(0, "127.0.0.1", r))]);
  const pPort = (proxy.address() as { port: number }).port;
  const tPort = (target.address() as { port: number }).port;
  const fetcher = new URL("../src/media/fetcher.ts", import.meta.url).href;
  // Child process: the proxy env must be present at startup for Node to honour it.
  const code = `
    import http from "node:http";
    const { nodeTransport } = await import(${JSON.stringify(fetcher)});
    const ctl = new AbortController();
    const res = await nodeTransport({ ip: "127.0.0.1", port: ${tPort}, protocol: "http:", host: "img.example.com", path: "/pinned.png", headers: {}, signal: ctl.signal });
    for await (const _ of res.body) {}
    // Control: a default-agent request in the same process (goes via the env proxy when Node supports it).
    await new Promise((resolve) => { const r = http.get("http://127.0.0.1:${tPort}/control", (x) => { x.resume(); x.on("end", resolve); }); r.on("error", resolve); });
    console.log("status=" + res.status);
  `;
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${pPort}`, HTTPS_PROXY: `http://127.0.0.1:${pPort}`, http_proxy: `http://127.0.0.1:${pPort}`, https_proxy: `http://127.0.0.1:${pPort}`, NO_PROXY: "", no_proxy: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "";
    let e = "";
    child.stdout.on("data", (d) => (o += d));
    child.stderr.on("data", (d) => (e += d));
    child.on("error", reject);
    child.on("close", () => resolve(o + e));
  });
  proxy.close();
  target.close();
  assert.match(out, /status=200/, out);
  assert.ok(targetHits.includes(`img.example.com:${tPort}`), "the pinned request reached the target directly");
  assert.ok(!proxyHits.some((u) => u.includes("/pinned.png")), "the pinned request never went through the env proxy");
  if (!proxyHits.some((u) => u.includes("/control"))) {
    console.log("# note: this Node did not route the control request via NODE_USE_ENV_PROXY; the bypass assertion still holds");
  }
});
