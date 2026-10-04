/**
 * Universal links (NP-NA-04): the Apple App Site Association file served by the
 * real app (createApp), above the SPA fallback.
 *
 *  - shape: one applinks detail, the app id, an ALLOWLIST of content routes and
 *    explicit exclusions first (first match wins) — sign-in, invite, API, MCP,
 *    published sites and capability links never open in the app;
 *  - no auth, no redirect, application/json, cacheable, no cookie;
 *  - 404 (never the SPA shell) when no app id is configured;
 *  - nothing else answers under the association name.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { appLinkComponents, appSiteAssociation, parseAppIds, APP_LINK_ROUTES } from "../src/routes/app-links";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

let fv: FakeVault;
const original = config.appleAppId;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  (config as { appleAppId: string }).appleAppId = "83Y42N33H8.com.benjaminlife.prism.client";
});
afterEach(() => {
  fv.restore();
  (config as { appleAppId: string }).appleAppId = original;
});

const PATHS = ["/.well-known/apple-app-site-association", "/apple-app-site-association"];

/** Apple's matching: the first component whose path (and query, when given) matches decides. */
function decide(url: string): "app" | "browser" {
  const u = new URL(url, "https://prism.example.com");
  const glob = (pattern: string, value: string): boolean => {
    const re = new RegExp("^" + pattern.split("").map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("") + "$");
    return re.test(value);
  };
  for (const c of appLinkComponents()) {
    if (!glob(c["/"], u.pathname)) continue;
    if (c["?"]) {
      const all = Object.entries(c["?"]).every(([k, v]) => u.searchParams.has(k) && glob(v, u.searchParams.get(k)!));
      if (!all) continue;
    }
    return c.exclude ? "browser" : "app";
  }
  return "browser";
}

test("AASA: served at both locations as JSON, without auth, redirect or cookie, cacheable", async () => {
  const app = createApp();
  for (const path of PATHS) {
    const r = await app.request(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("content-type"), "application/json", "exactly application/json");
    assert.equal(r.headers.get("location"), null, "no redirect");
    assert.equal(r.headers.get("set-cookie"), null);
    assert.match(r.headers.get("cache-control") ?? "", /^public, max-age=\d+$/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const body = await r.json() as { applinks: { details: Array<{ appIDs: string[]; components: unknown[] }> }; webcredentials?: unknown };
    assert.deepEqual(Object.keys(body), ["applinks"], "applinks only — no webcredentials (no shared credentials)");
    assert.equal(body.applinks.details.length, 1);
    assert.deepEqual(body.applinks.details[0]!.appIDs, ["83Y42N33H8.com.benjaminlife.prism.client"]);
    assert.deepEqual(body.applinks.details[0]!.components, appLinkComponents());
  }
  // A cookie or a bearer changes nothing (the file is public and identical for everyone).
  const withCreds = await app.request(PATHS[0]!, { headers: { cookie: "prism_session=x", authorization: "Bearer pd_x" } });
  assert.equal(withCreds.status, 200);
  assert.deepEqual(await withCreds.json(), appSiteAssociation());
});

test("AASA: only content routes open in the app; sign-in, invite, API, MCP, published sites and capability links stay in the browser", () => {
  for (const url of ["/page/abc123", "/page/abc/", "/collab/abc123", "/inbox", "/inbox/n_1", "/agent", "/agent/0b0e0c9e-2f0e-4c59-9a55-0a5b3d5f1a11"]) {
    assert.equal(decide(url), "app", url);
  }
  for (const url of [
    "/", "/home", "/map", "/governance",
    "/auth/device/authorize?client=x&redirect_uri=prism%3A%2F%2Fauth%2Fcallback", "/auth/device/continue", "/auth/callback?token=x", "/auth/login", "/auth/logout",
    "/accept-invite?token=x", "/accept-invite",
    "/api/notes", "/api/p/site/notes/1", "/acl/workers", "/mcp", "/mcp/x", "/health", "/health?live=1",
    "/.well-known/apple-app-site-association", "/.well-known/oauth-protected-resource/mcp",
    "/p/site", "/p/site/notes/abc",
    // A share link with a capability token: the app would drop the token and with it the access.
    "/collab/abc123?t=cap.token", "/collab/a/b?t=x",
    // Look-alikes of the allowed prefixes.
    "/pages/abc", "/pagex", "/inboxes", "/agents/x", "/collaborate/x",
  ]) {
    assert.equal(decide(url), "browser", url);
  }
  // Every exclusion precedes every inclusion (first match wins).
  const comps = appLinkComponents();
  const firstInclude = comps.findIndex((c) => !c.exclude);
  assert.ok(firstInclude > 0 && comps.slice(firstInclude).every((c) => !c.exclude), "exclusions first");
  assert.deepEqual([...APP_LINK_ROUTES], ["page", "collab", "inbox", "agent"]);
  // No catch-all and no wildcard-only path.
  assert.ok(comps.filter((c) => !c.exclude).every((c) => /^\/(page|collab|inbox|agent)(\/\*)?$/.test(c["/"])));
});

test("AASA: no configured app id → 404 JSON at both locations, never the SPA shell", async () => {
  for (const value of ["", "   ", "not-an-app-id", "83Y42N33H8", "lowercase1.com.example.app", "83Y42N33H8.com.example.app/../x"]) {
    (config as { appleAppId: string }).appleAppId = value;
    const app = createApp();
    for (const path of PATHS) {
      const r = await app.request(path);
      assert.equal(r.status, 404, `${JSON.stringify(value)} ${path}`);
      assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(await r.json(), { error: "not_found" });
    }
  }
  assert.equal(appSiteAssociation([]), null);
});

test("AASA: several app ids, ill-formed ones dropped, duplicates collapsed", () => {
  assert.deepEqual(
    parseAppIds(" 83Y42N33H8.com.benjaminlife.prism.client , ABCDE12345.org.example.app ,bad, 83Y42N33H8.com.benjaminlife.prism.client "),
    ["83Y42N33H8.com.benjaminlife.prism.client", "ABCDE12345.org.example.app"],
  );
  assert.deepEqual(parseAppIds(undefined), []);
  assert.deepEqual(parseAppIds(`83Y42N33H8.${"a".repeat(200)}.b`), [], "absurd length refused");
});

test("AASA: nothing else answers under the association name, and no other path serves it", async () => {
  const app = createApp();
  // A query string does not change the file (and cannot turn it into something else).
  const q = await app.request("/.well-known/apple-app-site-association?x=/auth/login&redirect=https://evil.example");
  assert.equal(q.status, 200);
  assert.deepEqual(await q.json(), appSiteAssociation());
  assert.equal(q.headers.get("location"), null);
  // Sub-paths: 404, not the SPA shell.
  for (const path of ["/.well-known/apple-app-site-association/x", "/.well-known/apple-app-site-association/", "/apple-app-site-association/x"]) {
    const r = await app.request(path);
    assert.equal(r.status, 404, path);
    assert.deepEqual(await r.json(), { error: "not_found" });
  }
  // The file's name in a QUERY of another route is just that route.
  for (const path of ["/auth/me?/.well-known/apple-app-site-association", "/api/health?next=/apple-app-site-association"]) {
    const r = await app.request(path);
    const text = await r.text();
    assert.ok(!text.includes("applinks"), path);
  }
  // Only GET (and HEAD) — a POST is not the file.
  const post = await app.request("/.well-known/apple-app-site-association", { method: "POST" });
  assert.notEqual(post.status, 200);
  const head = await app.request("/.well-known/apple-app-site-association", { method: "HEAD" });
  assert.equal(head.status, 200);
});
