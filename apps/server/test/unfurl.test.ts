/**
 * GET /api/unfurl (bookmark link previews): auth, the media proxy's SSRF
 * policy, the bounded HTML scan, limits. DNS and the transport are injected —
 * nothing here touches the internet.
 */
// Timed in CPU time of this thread (./probe), never on the wall clock: the figure is the work, not the machine's load.
import { threadCpuMs } from "./probe";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { setResolver, clearDnsNegativeCache } from "../src/media/netguard";
import type { Transport, TransportRequest } from "../src/media/fetcher";
import { configureAttachments } from "../src/routes/attachments";
import { configureMedia } from "../src/routes/media";
import { parseUnfurl, decodeEntities } from "../src/media/unfurl-parse";
import { resetDb, makeSession, sessionCookie, makeCapability, installFakeVault, type FakeVault } from "./helpers";
import { issueDeviceToken } from "../src/auth/device";

interface Canned { status?: number; headers?: Record<string, string>; body?: Buffer }
let routes = new Map<string, Canned>();
const dials: TransportRequest[] = [];
const transport: Transport = async (req) => {
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
const dns = new Map<string, string[]>();
let fv: FakeVault;

before(() => {
  setResolver(async (h) => {
    const a = dns.get(h);
    if (!a) throw new Error("NXDOMAIN");
    return a;
  });
});
after(() => setResolver(null));
beforeEach(() => {
  resetDb();
  fv?.restore();
  fv = installFakeVault();
  routes = new Map();
  dials.length = 0;
  dns.clear();
  clearDnsNegativeCache();
  configureAttachments({ transport });
  dns.set("example.com", ["93.184.216.34"]);
  dns.set("internal.example.com", ["10.0.0.5"]);
});

const html = (s: string): Canned => ({ headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(s) });
let n = 0;
const signedIn = () => sessionCookie(makeSession(`u${++n}@test.local`));
const unfurl = (u: string, headers: Record<string, string> = {}) => api.request(`/unfurl?u=${encodeURIComponent(u)}`, { headers });

const PAGE = `<!doctype html><html><head>
<meta charset="utf-8"><title>Fallback &amp; title</title>
<!-- <meta property="og:title" content="commented out"> -->
<meta property="og:title" content="  The   Real &quot;Title&quot; ">
<meta name="description" content="Plain description">
<meta property="og:description" content='OG &#8212; description &#x2713;'>
<meta property="og:site_name" content="Example">
<meta property="og:image" content="/img/cover.png">
<link rel="shortcut icon" href="favicon.ico">
<script>document.title = "never run"</script>
</head><body><meta property="og:title" content="in body, ignored"></body></html>`;

test("signed-in only: anon and capability links get 401; a device token works", async () => {
  routes.set("example.com/a", html(PAGE));
  assert.equal((await unfurl("https://example.com/a")).status, 401);
  const cap = makeCapability("note", "n1", "edit");
  assert.equal((await unfurl("https://example.com/a", { authorization: `Capability ${cap}` })).status, 401);
  const { token } = issueDeviceToken("dev@test.local", "Mac", "prism-client");
  assert.equal((await unfurl("https://example.com/a", { authorization: `Bearer ${token}` })).status, 200);
});

test("parses og/title/description/site/image/favicon, resolving relative URLs against the final URL", async () => {
  routes.set("example.com/a", { status: 301, headers: { location: "https://example.com/dir/page" } });
  routes.set("example.com/dir/page", html(PAGE));
  const r = await unfurl("https://example.com/a", { cookie: signedIn() });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, max-age=600");
  assert.deepEqual(await r.json(), {
    url: "https://example.com/dir/page",
    title: 'The Real "Title"',
    description: "OG — description ✓",
    siteName: "Example",
    // Same-origin proxied paths — never a raw third-party URL.
    image: `/api/media/proxy?u=${encodeURIComponent("https://example.com/img/cover.png")}`,
    favicon: `/api/media/proxy?u=${encodeURIComponent("https://example.com/dir/favicon.ico")}`,
  });
  // Cached: a second call does not dial again.
  const before = dials.length;
  assert.equal((await unfurl("https://example.com/a", { cookie: signedIn() })).status, 200);
  assert.equal(dials.length, before);
});

test("refusals: IP literal (pre-network, with reason), private-resolving host (generic), non-HTML 415, oversize 413", async () => {
  const c = signedIn();
  const ip = await unfurl("https://127.0.0.1/x", { cookie: c });
  assert.equal(ip.status, 400);
  assert.equal(((await ip.json()) as { error: string }).error, "refused");
  const priv = await unfurl("https://internal.example.com/x", { cookie: c });
  assert.equal(priv.status, 400);
  assert.deepEqual(await priv.json(), { error: "refused", reason: "refused" });
  const nx = await unfurl("https://nowhere.example.com/x", { cookie: c });
  assert.deepEqual(await nx.json(), { error: "refused", reason: "refused" });
  routes.set("example.com/img", { headers: { "content-type": "image/png" }, body: Buffer.from("x") });
  assert.equal((await unfurl("https://example.com/img", { cookie: c })).status, 415);
  configureAttachments({ transport, unfurlMaxBytes: 100 });
  routes.set("example.com/big", html(`<html><head><title>${"x".repeat(500)}</title></head></html>`));
  assert.equal((await unfurl("https://example.com/big", { cookie: c })).status, 413);
  assert.equal((await unfurl("javascript:alert(1)", { cookie: c })).status, 400);
});

test("rate limit → 429", async () => {
  configureAttachments({ transport, unfurlPerMinute: 2 });
  routes.set("example.com/a", html(PAGE));
  const c = signedIn();
  assert.equal((await unfurl("https://example.com/a", { cookie: c })).status, 200);
  assert.equal((await unfurl("https://example.com/a", { cookie: c })).status, 200);
  assert.equal((await unfurl("https://example.com/a", { cookie: c })).status, 429);
});

test("the scanner is linear on pathological input and ignores unsafe URLs", () => {
  const cases = [
    "<".repeat(1024 * 1024),
    "<meta ".repeat(200_000),
    `<meta content="${"a".repeat(1024 * 1024)}`,
    "<title>".repeat(150_000),
    "<!--".repeat(250_000),
    "&".repeat(1024 * 1024),
  ];
  for (const s of cases) {
    const t0 = threadCpuMs();
    parseUnfurl(s, "https://example.com/");
    assert.ok(threadCpuMs() - t0 < 500, `took ${threadCpuMs() - t0} ms`);
  }
  const m = parseUnfurl(
    `<head><title>${"t".repeat(1000)}</title><meta property="og:image" content="javascript:alert(1)"><link rel="icon" href="data:image/png;base64,AAAA"><meta name="description" content="${"d".repeat(2000)}">`,
    "https://example.com/",
  );
  assert.equal(m.image, null);
  assert.equal(m.favicon, null);
  assert.equal([...m.title!].length, 300);
  assert.equal([...m.description!].length, 600);
  assert.equal(decodeEntities("&lt;b&gt; &#0; &#x110000; &bogus; &amp"), "<b> &#0; &#x110000; &bogus; &amp");
});

test("M2: image/favicon the media proxy would refuse are omitted; nothing third-party leaks", async () => {
  routes.set("example.com/p", html(`<head><title>T</title><meta property="og:image" content="http://example.com/plain-http.png"><link rel="icon" href="https://127.0.0.1/f.ico"></head>`));
  const r = await unfurl("https://example.com/p", { cookie: signedIn() });
  const body = (await r.json()) as Record<string, unknown>;
  assert.equal(body.image, null, "plain http is not proxyable by default");
  assert.equal(body.favicon, null, "IP literal refused");
  assert.equal(JSON.stringify(body).includes("http://example.com/plain"), false);
});

test("M2: entity decoding is linear — 250k '&' in a title and in a meta value", () => {
  const amps = "&".repeat(250_000);
  for (const doc of [`<head><title>${amps}</title></head>`, `<head><meta property="og:description" content="${amps}"></head>`, `<head><title>x</title><meta property="og:image" content="${amps}"></head>`]) {
    const t0 = threadCpuMs();
    parseUnfurl(doc, "https://example.com/");
    assert.ok(threadCpuMs() - t0 < 200, `took ${threadCpuMs() - t0} ms`);
  }
  const t0 = threadCpuMs();
  decodeEntities(amps);
  assert.ok(threadCpuMs() - t0 < 200, `decodeEntities took ${threadCpuMs() - t0} ms`);
  assert.equal(decodeEntities("a &amp; b &#39;c&#39; &amp;amp; &verylongnotanentityname; &"), "a & b 'c' &amp; &verylongnotanentityname; &");
});

test("M2: unfurl fetches run inside the media proxy's in-flight pool → 503 busy past the wait", async () => {
  configureMedia({ mediaPerUser: 1, queueWaitMs: 30 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: Transport = async (req) => {
    await gate;
    return transport(req);
  };
  configureAttachments({ transport: slow });
  routes.set("example.com/s1", html(PAGE));
  routes.set("example.com/s2", html(PAGE));
  const c = signedIn();
  const first = unfurl("https://example.com/s1", { cookie: c });
  await new Promise((r) => setTimeout(r, 10));
  const second = await unfurl("https://example.com/s2", { cookie: c });
  assert.equal(second.status, 503);
  assert.deepEqual(await second.json(), { error: "busy" });
  release();
  assert.equal((await first).status, 200);
  configureMedia(null);
});
