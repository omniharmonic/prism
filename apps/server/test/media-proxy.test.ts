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
import { isPublicAddress, parseIPv6, parseTarget, resolvePublic, setResolver, GuardError } from "../src/media/netguard";
import { guardedFetch, nodeTransport, cacheSeconds, FetchError, type Transport, type TransportRequest } from "../src/media/fetcher";
import { sniffRaster } from "../src/media/sniff";
import { DiskCache } from "../src/media/cache";
import { configureMedia, classifyMapPath, rewriteOfmUrls, mediaCache } from "../src/routes/media";
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
      assert.ok(Date.now() - started < 2500, "the deadline covers the body, not just the headers");
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
    ["https://evil.example.com/a.png", "private_address"],
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
  assert.equal(((await r.json()) as { reason: string }).reason, "host_not_allowed");
  assert.ok(!dials.some((d) => d.host === "cdn.example.com"));
});

test("rewriteOfmUrls only touches strings that START with the OpenFreeMap origin", () => {
  assert.deepEqual(rewriteOfmUrls({ a: ["https://tiles.openfreemap.org/x", "see https://tiles.openfreemap.org/x"], b: 1 }), {
    a: ["/api/map/ofm/x", "see https://tiles.openfreemap.org/x"],
    b: 1,
  });
});
