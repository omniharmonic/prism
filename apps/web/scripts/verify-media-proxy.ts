/**
 * Behavioral check for the native client's external-image + basemap plumbing
 * (Client parity C). No network: every fetch is a local fake.
 * Run: npm run verify:media -w @prism/web
 *
 * Covers:
 *  - isExternalImageSrc: http(s) only, our own origin excluded, data:/blob:/relative/javascript: ignored;
 *  - ImageBlobCache: requests go to /api/media/proxy?u=<encoded url> on the injected server fetch (never
 *    the image host), in-flight dedupe, concurrency cap, non-raster/SVG/error answers → null (remembered,
 *    retried after the TTL), LRU eviction revokes blob URLs;
 *  - proxyImageElement / installExternalImageProxy on a happy-dom document: external src → blob URL,
 *    original kept in data-prism-src, srcset dropped, own-origin/data: images untouched, re-render re-mapped;
 *  - mapProxy: OpenFreeMap style URL → prismmap://style/<id> only while active, protocol URL → /api/map path
 *    (traversal/foreign roots refused), the style's /api/map/ URLs localized, handler fetches through the seam.
 */
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { ImageBlobCache, isExternalImageSrc, proxyImageElement, installExternalImageProxy, proxyPath } from "../src/native/externalImages.ts";
import {
  setMapProxyFetch,
  proxiedStyle,
  protocolUrlToPath,
  localizeStyle,
  createMapProtocolHandler,
} from "../../../packages/core/src/components/map/mapProxy.ts";

const API = "https://prism.example.com";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// --- isExternalImageSrc ---
for (const s of ["https://img.example.com/a.png", "http://img.example.com/a.png", " https://cdn.example.org/x?y=1 "]) assert.ok(isExternalImageSrc(s, API), s);
for (const s of [null, "", "data:image/png;base64,AA", "blob:tauri://localhost/123", "/api/notes/x/attachment", "a.png", "javascript:alert(1)", "https://prism.example.com/api/x", "ftp://x/y.png"]) {
  assert.equal(isExternalImageSrc(s, API), false, String(s));
}
assert.equal(proxyPath("https://a.example/b c.png?x=1&y=2"), "/api/media/proxy?u=https%3A%2F%2Fa.example%2Fb%20c.png%3Fx%3D1%26y%3D2");

// --- ImageBlobCache ---
let created = 0;
const revoked: string[] = [];
const calls: string[] = [];
let inflight = 0;
let maxInflight = 0;
const answers = new Map<string, () => Response>();
const fakeFetch = async (input: string): Promise<Response> => {
  calls.push(input);
  inflight++;
  maxInflight = Math.max(maxInflight, inflight);
  await new Promise((r) => setTimeout(r, 5));
  inflight--;
  const u = new URL(input, API).searchParams.get("u") ?? "";
  return (answers.get(u) ?? (() => new Response(PNG, { headers: { "content-type": "image/png" } })))();
};
let now = 0;
const cache = new ImageBlobCache(fakeFetch, {
  maxEntries: 3,
  concurrency: 2,
  failureTtlMs: 1000,
  now: () => now,
  createObjectURL: () => `blob:tauri://localhost/${++created}`,
  revokeObjectURL: (u) => revoked.push(u),
});
const [a1, a2] = await Promise.all([cache.get("https://img.example.com/a.png"), cache.get("https://img.example.com/a.png")]);
assert.equal(a1, a2, "in-flight dedupe");
assert.equal(calls.length, 1);
assert.ok(calls[0]!.startsWith("/api/media/proxy?u="), "always the server proxy path, relative (serverFetch adds origin + bearer)");
await Promise.all(["b", "c", "d", "e"].map((x) => cache.get(`https://img.example.com/${x}.png`)));
assert.ok(maxInflight <= 2, `concurrency cap held (${maxInflight})`);
assert.equal(cache.stats().entries, 3, "LRU bounded");
assert.ok(revoked.length >= 2, "evicted blob URLs are revoked");
answers.set("https://img.example.com/svg", () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
answers.set("https://img.example.com/err", () => new Response("{}", { status: 415, headers: { "content-type": "application/json" } }));
answers.set("https://img.example.com/html", () => new Response("<html>", { headers: { "content-type": "text/html" } }));
for (const x of ["svg", "err", "html"]) assert.equal(await cache.get(`https://img.example.com/${x}`), null, x);
const before = calls.length;
assert.equal(await cache.get("https://img.example.com/err"), null);
assert.equal(calls.length, before, "a failure is remembered");
now += 2000;
answers.delete("https://img.example.com/err");
assert.ok(await cache.get("https://img.example.com/err"), "retried after the failure TTL");

// --- DOM wiring (happy-dom) ---
const win = new Window({ url: "tauri://localhost/" });
const doc = win.document as unknown as Document;
(globalThis as unknown as { MutationObserver: unknown }).MutationObserver = win.MutationObserver;
const domCache = new ImageBlobCache(fakeFetch, { createObjectURL: () => `blob:tauri://localhost/dom-${++created}`, revokeObjectURL: () => {} });
const img = doc.createElement("img");
img.setAttribute("src", "https://img.example.com/dom.png");
img.setAttribute("srcset", "https://img.example.com/dom@2x.png 2x");
proxyImageElement(img, domCache, API);
assert.equal(img.getAttribute("data-prism-src"), "https://img.example.com/dom.png");
assert.equal(img.hasAttribute("srcset"), false);
await new Promise((r) => setTimeout(r, 30));
assert.match(img.getAttribute("src") ?? "", /^blob:tauri:\/\/localhost\/dom-/);
const own = doc.createElement("img");
own.setAttribute("src", `${API}/api/x.png`);
proxyImageElement(own, domCache, API);
assert.equal(own.getAttribute("src"), `${API}/api/x.png`, "own-origin image untouched");

const stop = installExternalImageProxy({ fetch: fakeFetch, apiOrigin: () => API, root: doc, cache: domCache });
const div = doc.createElement("div");
div.innerHTML = '<p><img src="https://img.example.com/added.png" alt="x"><img src="data:image/png;base64,AA"></p>';
doc.body.appendChild(div);
await new Promise((r) => setTimeout(r, 40));
const [added, dataImg] = Array.from(div.querySelectorAll("img"));
assert.match(added!.getAttribute("src") ?? "", /^blob:/, "observer proxies newly added images");
assert.equal(dataImg!.getAttribute("src"), "data:image/png;base64,AA");
added!.setAttribute("src", "https://img.example.com/added.png"); // a re-render restoring the original
await new Promise((r) => setTimeout(r, 40));
assert.match(added!.getAttribute("src") ?? "", /^blob:/, "re-render is re-mapped");
stop();

// --- map proxy seam ---
const OFM = "https://tiles.openfreemap.org/styles/liberty";
assert.equal(proxiedStyle(OFM), OFM, "inactive: untouched (PWA)");
const mapCalls: string[] = [];
const mapFetch = async (input: string): Promise<Response> => {
  mapCalls.push(input);
  if (input === "/api/map/style/liberty") {
    return new Response(JSON.stringify({ version: 8, sprite: "/api/map/ofm/sprites/ofm_f384/ofm", glyphs: "/api/map/ofm/fonts/{fontstack}/{range}.pbf", sources: { o: { type: "vector", tiles: ["/api/map/ofm/planet/20260927_080001_pt/{z}/{x}/{y}.pbf"] } }, layers: [] }), { headers: { "content-type": "application/json" } });
  }
  return new Response(new Uint8Array([1, 2, 3]));
};
setMapProxyFetch(mapFetch);
assert.equal(proxiedStyle(OFM), "prismmap://style/liberty");
assert.equal(proxiedStyle("https://tiles.openfreemap.org/styles/evil"), "https://tiles.openfreemap.org/styles/evil");
assert.equal(proxiedStyle("https://other.example/style.json"), "https://other.example/style.json", "custom styles are not proxied");
assert.equal(protocolUrlToPath("prismmap://ofm/planet/x/1/2/3.pbf"), "/api/map/ofm/planet/x/1/2/3.pbf");
assert.equal(protocolUrlToPath("prismmap://ofm/fonts/Noto Sans Regular/0-255.pbf"), "/api/map/ofm/fonts/Noto Sans Regular/0-255.pbf");
for (const bad of [
  "prismmap://ofm/../acl/x",
  "prismmap://other/x",
  "https://tiles.openfreemap.org/x",
  "prismmap://ofm/a?x=1",
  "prismmap://ofm//x",
  // encoded traversal: URL normalisation would turn these into /api/acl/workers (with the bearer)
  "prismmap://ofm/%2e%2e/%2e%2e/acl/workers",
  "prismmap://ofm/%2E%2E/%2E%2E/acl/workers",
  "prismmap://style/%2e%2e/%2e%2e/notes",
  "prismmap://ofm/.%2e/x",
  "prismmap://ofm/a%2fb",
  "prismmap://ofm/a%5Cb",
]) {
  assert.equal(protocolUrlToPath(bad), null, bad);
}
assert.equal(protocolUrlToPath("prismmap://ofm/fonts/Noto%20Sans/0-255.pbf"), "/api/map/ofm/fonts/Noto%20Sans/0-255.pbf", "ordinary escapes still fine");
assert.deepEqual(localizeStyle({ a: "/api/map/ofm/x", b: ["/api/notes", 1] }), { a: "prismmap://ofm/x", b: ["/api/notes", 1] });
const handler = createMapProtocolHandler(mapFetch);
const style = (await handler({ url: "prismmap://style/liberty", type: "json" }, new AbortController())).data as Record<string, unknown>;
assert.equal(style.sprite, "prismmap://ofm/sprites/ofm_f384/ofm");
assert.equal(style.glyphs, "prismmap://ofm/fonts/{fontstack}/{range}.pbf");
assert.deepEqual((style.sources as Record<string, { tiles: string[] }>).o!.tiles, ["prismmap://ofm/planet/20260927_080001_pt/{z}/{x}/{y}.pbf"]);
const tile = (await handler({ url: "prismmap://ofm/planet/20260927_080001_pt/1/2/3.pbf", type: "arrayBuffer" }, new AbortController())).data as ArrayBuffer;
assert.equal(tile.byteLength, 3);
assert.deepEqual(mapCalls, ["/api/map/style/liberty", "/api/map/ofm/planet/20260927_080001_pt/1/2/3.pbf"]);
await assert.rejects(handler({ url: "prismmap://ofm/../../acl", type: "json" }, new AbortController()), /refused/);
setMapProxyFetch(null);

await win.happyDOM.close();
console.log("verify-media-proxy: all checks passed");
