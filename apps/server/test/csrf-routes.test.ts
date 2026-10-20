/**
 * Every state-changing route against a forged browser write (launch security review;
 * middleware/csrf.ts). The routes are ENUMERATED from the built app (`app.routes`), so a route
 * added later is covered without editing this file.
 *
 * For each POST / PUT / PATCH / DELETE, signed in as the server owner by session cookie:
 *  - a CORS-simple body (text/plain, form, multipart, an untyped body) with no Origin and no
 *    Sec-Fetch-Site → refused before the handler (415), nothing written to the vault;
 *  - a same-site attacker (Origin = a sibling subdomain of APP_ORIGIN, Sec-Fetch-Site:
 *    same-site) with a proper JSON body → 403 csrf_refused.
 * The only exceptions are the commented allowlists below (SIMPLE_BODY_EXEMPTIONS in
 * middleware/csrf.ts, and BEARER_ONLY here).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { SIMPLE_BODY_EXEMPTIONS } from "../src/middleware/csrf";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";
import { stopImportWorker } from "../src/transfer/import";
import { stopExportWorker } from "../src/transfer/export";

const APP = "https://prism.example.com";
const SIBLING = "https://blog.example.com";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const GUARDED_PREFIXES = ["/api/", "/auth/", "/acl/"];
/**
 * Mutating routes outside the guarded prefixes, each with why a cookie cannot drive it.
 * Anything else outside the prefixes fails the structural test below.
 */
const BEARER_ONLY: Record<string, string> = {
  "/mcp": "Prism MCP: bearer credentials only, session cookies are never accepted (mcp/auth.ts), plus its own Origin check",
};

let fv: FakeVault;
let savedOrigin = "";
before(() => {
  savedOrigin = config.appOrigin;
  (config as { appOrigin: string }).appOrigin = APP;
  fv = installFakeVault();
  resetDb();
});
after(async () => {
  (config as { appOrigin: string }).appOrigin = savedOrigin;
  await stopImportWorker();
  await stopExportWorker();
});

const app = createApp();
const routes = (() => {
  const seen = new Set<string>();
  const out: Array<{ method: string; path: string }> = [];
  for (const r of app.routes) {
    if (!MUTATING.has(r.method)) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
})();
const concrete = (path: string) => path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, "x0").replace(/\*/g, "x0");
const guarded = (path: string) => GUARDED_PREFIXES.some((p) => path.startsWith(p));
const remote = { incoming: { socket: { remoteAddress: "100.64.1.2" } } };

async function send(method: string, path: string, headers: Record<string, string>, body?: string | FormData) {
  const before = fv.calls.length;
  const res = await app.request(`${APP}${concrete(path)}`, { method, headers: { cookie: sessionCookie(makeSession(config.ownerEmail)), ...headers }, body }, remote);
  const text = await res.text();
  const writes = fv.calls.slice(before).filter((c) => c.method !== "GET" && c.method !== "HEAD").length;
  return { status: res.status, text, writes };
}

test("the app has the mutating routes this test is about (enumeration sanity)", () => {
  assert.ok(routes.length > 200, `found only ${routes.length} mutating routes`);
});

test("every mutating route is under a guarded prefix, or bearer-only with a stated reason", () => {
  const outside = routes.filter((r) => !guarded(r.path) && !(r.path in BEARER_ONLY));
  assert.deepEqual(outside, [], "a state-changing route outside /api, /auth, /acl needs the cross-site write guard");
});

for (const [label, type, body] of [
  ["text/plain", "text/plain", "{}"],
  ["form", "application/x-www-form-urlencoded", "a=1"],
  ["multipart", "multipart/form-data; boundary=x", "--x--\r\n"],
] as const) {
  test(`a ${label} body with an owner session cookie, no Origin, no Sec-Fetch-Site → refused before every handler`, async () => {
    const accepted: string[] = [];
    for (const r of routes.filter((r) => guarded(r.path))) {
      const media = type.split(";")[0]!;
      const allowed = SIMPLE_BODY_EXEMPTIONS.some((e) => e.method === r.method && e.type === media && e.path.test(concrete(r.path)) && !e.when);
      const res = await send(r.method, r.path, { "content-type": type }, body);
      if (res.writes > 0) accepted.push(`${r.method} ${r.path} → wrote to the vault`);
      if (allowed) {
        // An allowlisted form route still answers with its own refusal (no code / token / form token).
        if (res.status < 400 || res.status >= 500) accepted.push(`${r.method} ${r.path} → ${res.status} (allowlisted, but accepted the forged body)`);
      } else if (res.status !== 415) {
        accepted.push(`${r.method} ${r.path} → ${res.status} ${res.text.slice(0, 60)}`);
      }
    }
    assert.deepEqual(accepted, []);
  });
}

test("an untyped body (fetch with a Blob) is refused too; a bodiless, untyped DELETE reaches the route", async () => {
  const blob = await send("POST", "/api/notes", {}, "{}");
  assert.equal(blob.status, 415);
  assert.equal(blob.writes, 0);
  // No body, no Content-Type, no Origin: what curl / a script sends — passes the guard.
  const r = await send("DELETE", "/auth/devices/:id", {});
  assert.notEqual(r.status, 415);
});

test("a same-site attacker (sibling subdomain Origin, Sec-Fetch-Site: same-site) with a JSON body → 403 on every mutating route", async () => {
  const accepted: string[] = [];
  for (const r of routes.filter((r) => guarded(r.path))) {
    const res = await send(r.method, r.path, { "content-type": "application/json", origin: SIBLING, "sec-fetch-site": "same-site" }, "{}");
    if (res.status !== 403 || res.writes > 0) accepted.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepEqual(accepted, []);
});

test("a foreign Origin alone (older browser, no Sec-Fetch-Site) is refused; APP_ORIGIN with JSON reaches the route", async () => {
  const evil = await send("POST", "/api/notes", { "content-type": "application/json", origin: SIBLING }, JSON.stringify({ content: "x", path: "csrf-probe" }));
  assert.equal(evil.status, 403);
  assert.equal(evil.writes, 0);
  const own = await send("POST", "/api/notes", { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin" }, JSON.stringify({ content: "x", path: "csrf-probe" }));
  assert.equal(own.status, 200);
  assert.equal(own.writes, 1);
});

test("allowlisted simple bodies: the attachment upload needs X-Prism-Upload, and every exemption still refuses a same-site Origin", async () => {
  const noHeader = await send("POST", "/api/notes/:id/attachments", { "content-type": "multipart/form-data; boundary=x" }, "--x--\r\n");
  assert.equal(noHeader.status, 415, "multipart without X-Prism-Upload is not exempt");
  const withHeader = await send("POST", "/api/notes/:id/attachments", { "content-type": "multipart/form-data; boundary=x", "x-prism-upload": "1" }, "--x--\r\n");
  assert.notEqual(withHeader.status, 415, "the upload route itself decides");
  for (const e of SIMPLE_BODY_EXEMPTIONS) {
    const path = e.path.source.replace(/^\^|\$$/g, "").replace(/\\\//g, "/").replace("[^/]+", "x0");
    const res = await send(e.method, path, { "content-type": e.type, origin: SIBLING, "sec-fetch-site": "same-site", "x-prism-upload": "1" }, "a=1");
    assert.equal(res.status, 403, `${e.method} ${path}`);
    assert.ok(e.why.length > 20, "every exemption says why");
  }
});

test("bearer requests are untouched by the guard (a browser cannot attach one cross-origin without a preflight)", async () => {
  const res = await app.request(`${APP}/api/notes`, { method: "POST", headers: { authorization: "Bearer pd_not-a-real-token", "content-type": "text/plain" }, body: "{}" }, remote);
  assert.notEqual(res.status, 415);
});
