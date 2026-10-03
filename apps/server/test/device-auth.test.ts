/**
 * Native sign-in (WP2.1): OAuth-for-native-apps + PKCE S256 → revocable `pd_`
 * device tokens. Full-stack through createApp() (CORS, rate limits, /auth,
 * gateway) against the fake vault. Pins:
 *  - the PKCE round trip, state echo, and the consent/CSRF/cookie binding;
 *  - redirect_uri allowlisting BEFORE any login (no open redirect);
 *  - code single-use / expiry / verifier / redirect binding (+ replay revokes);
 *  - tokens stored only hashed; revoked/expired tokens are dead;
 *  - a device token works over tunnel headers where COLLAB_TOKEN does not;
 *  - a device actor has exactly the user's grants (owner → passthrough);
 *  - collab resolveLevel with a device token;
 *  - /auth/device/token rate limit; devices list/revoke authz; native CORS.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, setAccount, storeMagicLink, getUser, getMcpToken } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { issueDeviceToken, isAllowedRedirectUri, consentCsrf } from "../src/auth/device";
import { setMemberVaultTokensEnabled } from "../src/routes/mcp";
import { setTokenMinter, setTokenRevoker } from "../src/mcp-token";
import { authorizeConnection } from "../src/collab";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const OTHER = "other@test.local";
const REDIRECT = "prism://auth/callback";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let ip: string;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  app = createApp();
  // Fresh client IP per test so the (module-global) rate-limit buckets never
  // bleed between tests.
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
});
afterEach(() => fv.restore());

/** Tunnel-style headers: what every request over the public entrypoint carries. */
const tunnel = () => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip });

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeUrl(p: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  const all: Record<string, string | undefined> = {
    client_id: "prism-native",
    redirect_uri: REDIRECT,
    code_challenge_method: "S256",
    state: "st-123",
    label: "Test iPhone",
    ...p,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, v);
  return `/auth/device/authorize?${q.toString()}`;
}

const cookieVal = (setCookie: string | null, name: string): string | null =>
  setCookie?.match(new RegExp(`${name}=([^;]*)`))?.[1] ?? null;

function consentFields(html: string): { req: string; csrf: string } {
  const req = html.match(/name="req" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(req && csrf, "consent page carries req + csrf");
  return { req: req!, csrf: csrf! };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM_H = { "content-type": "application/x-www-form-urlencoded" };

/** Browser leg: signed-in user opens authorize → consent → approve. Returns the redirect. */
async function approveAs(email: string, challenge: string, extra: Record<string, string | undefined> = {}, decision = "approve") {
  const sid = makeSession(email);
  const a = await app.request(authorizeUrl({ code_challenge: challenge, ...extra }), { headers: { cookie: sessionCookie(sid), ...tunnel() } });
  assert.equal(a.status, 200, "signed-in user sees the consent page");
  const html = await a.text();
  assert.match(html, /An app calling itself “Test iPhone” wants to sign in/);
  const reqCookie = cookieVal(a.headers.get("set-cookie"), "prism_device_req");
  assert.ok(reqCookie);
  const { req, csrf } = consentFields(html);
  const r = await app.request("/auth/device/approve", {
    method: "POST",
    headers: { ...FORM_H, cookie: `${sessionCookie(sid)}; prism_device_req=${reqCookie}`, ...tunnel() },
    body: form({ req, csrf, decision }),
  });
  assert.equal(r.status, 302);
  return new URL(r.headers.get("location")!);
}

async function exchange(body: Record<string, string>) {
  return app.request("/auth/device/token", {
    method: "POST",
    headers: { ...FORM_H, ...tunnel() },
    body: form({ grant_type: "authorization_code", client_id: "prism-native", redirect_uri: REDIRECT, ...body }),
  });
}

async function fullFlow(email: string): Promise<{ token: string; deviceId: string }> {
  const { verifier, challenge } = pkce();
  const loc = await approveAs(email, challenge);
  const code = loc.searchParams.get("code")!;
  const r = await exchange({ code, code_verifier: verifier });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { access_token: string; device_id: string };
  return { token: j.access_token, deviceId: j.device_id };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
// Unique per call: the owner passthrough coalesces/caches identical GETs for a
// few seconds (routes/api.ts), which would bleed one test's vault into the next.
const notesPath = () => `/api/notes?nocache=${randomBytes(6).toString("hex")}`;

// ------------------------------------------------------------- round trip

test("full PKCE round trip: consent → code (state echoed) → token → authenticated API use over the tunnel", async () => {
  fv.put({ id: "n1", content: "a", tags: ["x"] });
  fv.put({ id: "n2", content: "b", tags: ["y"] });
  const { verifier, challenge } = pkce();
  const loc = await approveAs(OWNER, challenge);
  assert.equal(`${loc.protocol}//${loc.host}${loc.pathname}`, REDIRECT);
  assert.equal(loc.searchParams.get("state"), "st-123", "state is echoed");
  const code = loc.searchParams.get("code");
  assert.ok(code && code.length >= 40);

  const r = await exchange({ code: code!, code_verifier: verifier });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const j = (await r.json()) as { access_token: string; token_type: string; expires_in: number; device_id: string };
  assert.match(j.access_token, /^pd_[A-Za-z0-9_-]{43}$/);
  assert.equal(j.token_type, "Bearer");
  assert.equal(j.expires_in, 90 * 24 * 3600);
  assert.match(j.device_id, /^dev_/);

  // Owner device token → the owner's transparent passthrough, over tunnel headers.
  const notes = await app.request(notesPath(), { headers: { ...bearer(j.access_token), ...tunnel() } });
  assert.equal(notes.status, 200);
  assert.equal(((await notes.json()) as unknown[]).length, 2);

  const me = (await (await app.request("/auth/me", { headers: { ...bearer(j.access_token), ...tunnel() } })).json()) as { email: string; role: string };
  assert.equal(me.email, OWNER);
  assert.equal(me.role, "owner");
});

test("tokens and codes are stored ONLY hashed", async () => {
  const { verifier, challenge } = pkce();
  const loc = await approveAs(MEMBER, challenge);
  const code = loc.searchParams.get("code")!;
  const r = await exchange({ code, code_verifier: verifier });
  const { access_token } = (await r.json()) as { access_token: string };
  const dump = JSON.stringify([
    db.prepare("SELECT * FROM device_tokens").all(),
    db.prepare("SELECT * FROM device_auth_codes").all(),
    db.prepare("SELECT * FROM device_auth_requests").all(),
  ]);
  assert.ok(!dump.includes(access_token), "plaintext token never stored");
  assert.ok(!dump.includes(access_token.slice(3)), "not even without its prefix");
  assert.ok(!dump.includes(code), "plaintext code never stored");
  const row = db.prepare("SELECT token_hash FROM device_tokens").get() as { token_hash: string };
  assert.equal(row.token_hash, createHash("sha256").update(access_token).digest("hex"));
});

// ------------------------------------------------------------- authorize validation

test("redirect_uri not allowlisted → error page BEFORE any login; never redirected to, nothing parked", async () => {
  const { challenge } = pkce();
  for (const bad of ["https://evil.example/cb", "prism://evil/callback", "http://localhost:5000/cb", "http://127.0.0.1.evil.example/cb", "http://user@127.0.0.1:5000/cb", "javascript:alert(1)"]) {
    const r = await app.request(authorizeUrl({ code_challenge: challenge, redirect_uri: bad }), { headers: tunnel() });
    assert.equal(r.status, 400, bad);
    assert.equal(r.headers.get("location"), null, `no redirect for ${bad}`);
    assert.equal(cookieVal(r.headers.get("set-cookie"), "prism_device_req"), null);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM device_auth_requests").get() as { n: number }).n, 0);
  // An unknown client is refused the same way.
  const r = await app.request(authorizeUrl({ code_challenge: challenge, client_id: "evil" }), { headers: tunnel() });
  assert.equal(r.status, 400);
});

test("RFC 8252 loopback redirects: IP literal, port ≥ 1024, path /callback or /, no query (L1)", () => {
  assert.equal(isAllowedRedirectUri("http://127.0.0.1:53123/callback"), true);
  assert.equal(isAllowedRedirectUri("http://127.0.0.1:53123/"), true);
  assert.equal(isAllowedRedirectUri("http://[::1]:53123/callback"), true);
  assert.equal(isAllowedRedirectUri(REDIRECT), true);
  for (const bad of [
    "https://127.0.0.1:53123/callback",
    "http://localhost:53123/callback",
    "http://127.0.0.1:53123/cb#frag",
    "http://127.0.0.1:53123/cb", // other paths
    "http://127.0.0.1:53123/callback/extra",
    "http://127.0.0.1:53123/./callback", // parser-normalized
    "http://127.0.0.1:53123/callback?x=1", // any query
    "http://127.0.0.1:53123/?next=evil",
    "http://127.0.0.1:53123/callback?",
    "http://127.0.0.1:80/callback", // privileged ports
    "http://127.0.0.1:1023/callback",
    "http://127.0.0.1/callback", // implicit port 80
    "prism://auth/callback?x=1", // custom scheme: exact match only
    "prism://auth/callback/",
  ]) {
    assert.equal(isAllowedRedirectUri(bad), false, bad);
  }
});

test("pre-consent errors (plain PKCE, missing challenge, bad response_type, long state) render a 400 page — NO redirect (L1)", async () => {
  const { challenge } = pkce();
  const cases = [
    authorizeUrl({ code_challenge: challenge, code_challenge_method: "plain" }),
    authorizeUrl({}),
    authorizeUrl({ code_challenge: challenge, response_type: "token" }),
    authorizeUrl({ code_challenge: challenge, state: "s".repeat(600) }),
    authorizeUrl({ code_challenge: challenge, redirect_uri: "http://127.0.0.1:53123/callback?evil=1" }),
  ];
  for (const u of cases) {
    const r = await app.request(u, { headers: tunnel() });
    assert.equal(r.status, 400, u);
    assert.equal(r.headers.get("location"), null, `no redirect for ${u}`);
    assert.equal(cookieVal(r.headers.get("set-cookie"), "prism_device_req"), null);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM device_auth_requests").get() as { n: number }).n, 0);
});

test("consent page presents the label as a CLAIM and shows the redirect target prominently (L4)", async () => {
  const { challenge } = pkce();
  const sid = makeSession(MEMBER);
  const a = await app.request(authorizeUrl({ code_challenge: challenge, label: "Owner's <b>Laptop</b>" }), { headers: { cookie: sessionCookie(sid), ...tunnel() } });
  const html = await a.text();
  assert.ok(html.includes("An app calling itself “Owner&#39;s &lt;b&gt;Laptop&lt;/b&gt;” wants to sign in to Prism as <strong>member@test.local</strong>"), html);
  assert.match(html, /<code[^>]*>prism:\/\/auth\/callback<\/code>/);
  const loop = await app.request(authorizeUrl({ code_challenge: challenge, redirect_uri: "http://127.0.0.1:53123/callback" }), { headers: { cookie: sessionCookie(sid), ...tunnel() } });
  assert.match(await loop.text(), /<code[^>]*>127\.0\.0\.1:53123\/callback<\/code> — an app on this computer/);
});

test("signed out → bounced to the web login with a FIXED return path; password login → /continue → consent", async () => {
  setAccount(MEMBER, "Member", hashPassword("correct horse battery"));
  const { challenge } = pkce();
  const a = await app.request(authorizeUrl({ code_challenge: challenge }), { headers: tunnel() });
  assert.equal(a.status, 302);
  assert.equal(a.headers.get("location"), "/?next=%2Fauth%2Fdevice%2Fcontinue");
  const reqCookie = cookieVal(a.headers.get("set-cookie"), "prism_device_req");
  assert.ok(reqCookie);
  assert.match(a.headers.get("set-cookie")!, /HttpOnly/i);

  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...tunnel() },
    body: JSON.stringify({ email: MEMBER, password: "correct horse battery" }),
  });
  assert.equal(login.status, 200);
  const sid = cookieVal(login.headers.get("set-cookie"), "prism_session");
  const cont = await app.request("/auth/device/continue", { headers: { cookie: `prism_session=${sid}; prism_device_req=${reqCookie}`, ...tunnel() } });
  assert.equal(cont.status, 200);
  assert.match(await cont.text(), new RegExp(MEMBER.replace(".", "\\.")));
});

test("owner magic link with a parked device request resumes the consent page", async () => {
  const { challenge } = pkce();
  const a = await app.request(authorizeUrl({ code_challenge: challenge }), { headers: tunnel() });
  const reqCookie = cookieVal(a.headers.get("set-cookie"), "prism_device_req");
  const token = randomBytes(32).toString("base64url");
  storeMagicLink(createHash("sha256").update(token).digest("hex"), OWNER, 60_000);
  const cb = await app.request(`/auth/callback?token=${token}`, { headers: { cookie: `prism_device_req=${reqCookie}`, ...tunnel() } });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/auth/device/continue");
});

test("deny → redirect with error=access_denied and state; no code minted", async () => {
  const { challenge } = pkce();
  const loc = await approveAs(MEMBER, challenge, {}, "deny");
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("state"), "st-123");
  assert.equal(loc.searchParams.get("code"), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM device_auth_codes").get() as { n: number }).n, 0);
});

test("consent is CSRF-protected: bad csrf, missing request cookie, or another session's csrf → 403", async () => {
  const { challenge } = pkce();
  const sid = makeSession(MEMBER);
  const a = await app.request(authorizeUrl({ code_challenge: challenge }), { headers: { cookie: sessionCookie(sid), ...tunnel() } });
  const reqCookie = cookieVal(a.headers.get("set-cookie"), "prism_device_req")!;
  const { req, csrf } = consentFields(await a.text());
  const post = (cookie: string, body: Record<string, string>) =>
    app.request("/auth/device/approve", { method: "POST", headers: { ...FORM_H, cookie, ...tunnel() }, body: form(body) });

  assert.equal((await post(`${sessionCookie(sid)}; prism_device_req=${reqCookie}`, { req, csrf: "forged", decision: "approve" })).status, 403);
  assert.equal((await post(sessionCookie(sid), { req, csrf, decision: "approve" })).status, 403, "form without the parking browser's cookie");
  const attacker = makeSession(OTHER);
  assert.equal(
    (await post(`${sessionCookie(attacker)}; prism_device_req=${reqCookie}`, { req, csrf, decision: "approve" })).status,
    403,
    "csrf is bound to the session that saw the consent page",
  );
  assert.equal((await post(`prism_device_req=${reqCookie}`, { req, csrf, decision: "approve" })).status, 401, "no session");
  // The legit approval still works afterwards.
  const ok = await post(`${sessionCookie(sid)}; prism_device_req=${reqCookie}`, { req, csrf, decision: "approve" });
  assert.equal(ok.status, 302);
  assert.ok(new URL(ok.headers.get("location")!).searchParams.get("code"));
});

// ------------------------------------------------------------- token endpoint

test("wrong verifier → invalid_grant, and the code is burned (no retry with the right one)", async () => {
  const { verifier, challenge } = pkce();
  const code = (await approveAs(MEMBER, challenge)).searchParams.get("code")!;
  const bad = await exchange({ code, code_verifier: pkce().verifier });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "invalid_grant");
  const retry = await exchange({ code, code_verifier: verifier });
  assert.equal(retry.status, 400);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM device_tokens").get() as { n: number }).n, 0);
});

test("code reuse → rejected, AND the token it already minted is revoked", async () => {
  const { verifier, challenge } = pkce();
  const code = (await approveAs(MEMBER, challenge)).searchParams.get("code")!;
  const first = await exchange({ code, code_verifier: verifier });
  assert.equal(first.status, 200);
  const { access_token } = (await first.json()) as { access_token: string };
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(access_token), ...tunnel() } })).status, 200);

  const replay = await exchange({ code, code_verifier: verifier });
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(access_token), ...tunnel() } })).status, 401);
});

test("expired code → invalid_grant", async () => {
  const { verifier, challenge } = pkce();
  const code = (await approveAs(MEMBER, challenge)).searchParams.get("code")!;
  db.prepare("UPDATE device_auth_codes SET expires_at = ?").run(Date.now() - 1);
  const r = await exchange({ code, code_verifier: verifier });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "invalid_grant");
});

test("redirect_uri / client_id / grant_type must match", async () => {
  const { verifier, challenge } = pkce();
  const code = (await approveAs(MEMBER, challenge)).searchParams.get("code")!;
  assert.equal((await exchange({ code, code_verifier: verifier, grant_type: "password" })).status, 400);
  assert.equal((await exchange({ code, code_verifier: verifier, client_id: "evil" })).status, 401);
  const mismatch = await exchange({ code, code_verifier: verifier, redirect_uri: "http://127.0.0.1:9999/callback" });
  assert.equal(mismatch.status, 400);
  assert.equal(((await mismatch.json()) as { error: string }).error, "invalid_grant");
});

test("JSON bodies are accepted at /auth/device/token too", async () => {
  const { verifier, challenge } = pkce();
  const code = (await approveAs(MEMBER, challenge)).searchParams.get("code")!;
  const r = await app.request("/auth/device/token", {
    method: "POST",
    headers: { "content-type": "application/json", ...tunnel() },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: "prism-native", redirect_uri: REDIRECT, code, code_verifier: verifier }),
  });
  assert.equal(r.status, 200);
});

test("/auth/device/token is rate-limited per client", async () => {
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await exchange({ code: "nope", code_verifier: "x".repeat(43) })).status;
  assert.equal(last, 429);
});

// ------------------------------------------------------------- token use

test("revoked or expired device tokens → 401 on /auth/me and no access on /api", async () => {
  fv.put({ id: "n1", content: "a", tags: ["x"] });
  const { token, deviceId } = await fullFlow(OWNER);
  db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), deviceId);
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(token), ...tunnel() } })).status, 401);
  const notes = await app.request(notesPath(), { headers: { ...bearer(token), ...tunnel() } });
  assert.deepEqual(await notes.json(), [], "a revoked owner token is anon, not the passthrough");

  const t2 = issueDeviceToken(OWNER, "x", "prism-native");
  db.prepare("UPDATE device_tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1, t2.id);
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(t2.token), ...tunnel() } })).status, 401);
  // Past the absolute cap even with a live idle window.
  const t3 = issueDeviceToken(OWNER, "x", "prism-native");
  db.prepare("UPDATE device_tokens SET max_expires_at = ? WHERE id = ?").run(Date.now() - 1, t3.id);
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(t3.token), ...tunnel() } })).status, 401);
  // A made-up pd_ token is nothing.
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(`pd_${"A".repeat(43)}`), ...tunnel() } })).status, 401);
});

test("device token is honored over tunnel headers; COLLAB_TOKEN over tunnel headers is NOT (loopback-only path unchanged)", async () => {
  fv.put({ id: "n1", content: "a", tags: ["x"] });
  const { token } = issueDeviceToken(OWNER, "laptop", "prism-native");
  const viaDevice = await app.request(notesPath(), { headers: { ...bearer(token), ...tunnel() } });
  const devIds = ((await viaDevice.json()) as Array<{ id: string }>).map((n) => n.id);
  assert.deepEqual(devIds, ["n1"], JSON.stringify(devIds));

  const viaCollabTunnel = await app.request(notesPath(), { headers: { ...bearer(config.collabToken), ...tunnel() } });
  assert.deepEqual(await viaCollabTunnel.json(), [], "COLLAB_TOKEN over the tunnel is ignored (anon)");
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(config.collabToken), ...tunnel() } })).status, 401);
  const viaVaultTokenTunnel = await app.request(notesPath(), { headers: { ...bearer(config.parachuteToken), ...tunnel() } });
  assert.deepEqual(await viaVaultTokenTunnel.json(), []);

  // Sanity: the loopback owner path itself still works exactly as before.
  const viaCollabLocal = await app.request(notesPath(), { headers: bearer(config.collabToken) });
  const localIds = ((await viaCollabLocal.json()) as Array<{ id: string }>).map((n) => n.id);
  assert.deepEqual(localIds, ["n1"], JSON.stringify(localIds));
});

test("a device actor has exactly the user's grants (non-owner sees only granted notes)", async () => {
  fv.put({ id: "n1", content: "shared", tags: ["team"] });
  fv.put({ id: "n2", content: "secret", tags: ["private"] });
  grantUser(MEMBER, "tag", "team", "view");
  const { token } = issueDeviceToken(MEMBER, "phone", "prism-native");
  const h = { ...bearer(token), ...tunnel() };
  const list = (await (await app.request(notesPath(), { headers: h })).json()) as Array<{ id: string }>;
  assert.deepEqual(list.map((n) => n.id), ["n1"]);
  assert.equal((await app.request("/api/notes/n1", { headers: h })).status, 200);
  assert.equal((await app.request("/api/notes/n2", { headers: h })).status, 404);
  assert.equal((await app.request("/api/notes/n1", { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) })).status, 403);
  const me = (await (await app.request("/auth/me", { headers: h })).json()) as { email: string; role: string; isOwner: boolean };
  assert.equal(me.email, MEMBER);
  assert.equal(me.isOwner, false);
});

test("last_seen_at + sliding expiry are stamped on use", async () => {
  const t = issueDeviceToken(MEMBER, "phone", "prism-native");
  db.prepare("UPDATE device_tokens SET last_seen_at = 0, expires_at = ? WHERE id = ?").run(Date.now() + 1000, t.id);
  await app.request("/auth/me", { headers: { ...bearer(t.token), ...tunnel() } });
  const row = db.prepare("SELECT last_seen_at, expires_at FROM device_tokens WHERE id = ?").get(t.id) as { last_seen_at: number; expires_at: number };
  assert.ok(row.last_seen_at > Date.now() - 5000);
  assert.ok(row.expires_at > Date.now() + 89 * 24 * 3600_000, "idle window slid forward");
});

// ------------------------------------------------------------- collab

test("collab: a device token authorizes a live-doc connection with session semantics", async () => {
  fv.put({ id: "n1", content: "x", tags: ["team"] });
  fv.put({ id: "n2", content: "y", tags: ["private"] });
  grantUser(MEMBER, "tag", "team", "edit");
  const { token, id } = issueDeviceToken(MEMBER, "phone", "prism-native");
  const cc = { readOnly: false };
  assert.equal(await authorizeConnection("n1", token, null, cc), "edit");
  assert.equal(cc.readOnly, false);
  await assert.rejects(() => authorizeConnection("n2", token, null, { readOnly: false }), /Forbidden/);

  grantUser(OTHER, "tag", "team", "view");
  const viewer = issueDeviceToken(OTHER, "phone", "prism-native");
  const cv = { readOnly: false };
  assert.equal(await authorizeConnection("n1", viewer.token, null, cv), "view");
  assert.equal(cv.readOnly, true);

  const owner = issueDeviceToken(OWNER, "laptop", "prism-native");
  assert.equal(await authorizeConnection("n2", owner.token, null, { readOnly: false }, false), "own", "owner device (not local) is owner");

  db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
  await assert.rejects(() => authorizeConnection("n1", token, null, { readOnly: false }), /Forbidden/);
  // COLLAB_TOKEN from a non-local connection still grants nothing.
  await assert.rejects(() => authorizeConnection("n1", config.collabToken, null, { readOnly: false }, false), /Forbidden/);
});

// ------------------------------------------------------------- device management

test("devices: list own; can't see or revoke another user's device; owner may list all + revoke any", async () => {
  const a = issueDeviceToken(MEMBER, "A phone", "prism-native");
  const b = issueDeviceToken(OTHER, "B phone", "prism-native");
  const ha = { ...bearer(a.token), ...tunnel() };

  const mine = (await (await app.request("/auth/devices", { headers: ha })).json()) as { devices: Array<{ id: string; current: boolean }> };
  assert.deepEqual(mine.devices.map((d) => d.id), [a.id]);
  assert.equal(mine.devices[0]!.current, true);
  // ?all=1 is owner-only — a member just gets their own.
  const allAsMember = (await (await app.request("/auth/devices?all=1", { headers: ha })).json()) as { devices: unknown[] };
  assert.equal(allAsMember.devices.length, 1);

  assert.equal((await app.request(`/auth/devices/${b.id}`, { method: "DELETE", headers: ha })).status, 404);
  const byId = await app.request("/auth/device/revoke", { method: "POST", headers: { ...ha, "content-type": "application/json" }, body: JSON.stringify({ device_id: b.id }) });
  assert.equal(byId.status, 404);
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(b.token), ...tunnel() } })).status, 200, "B's device survives");

  // Session-authenticated listing works too.
  const viaSession = (await (await app.request("/auth/devices", { headers: { cookie: sessionCookie(makeSession(OTHER)), ...tunnel() } })).json()) as { devices: Array<{ id: string }> };
  assert.deepEqual(viaSession.devices.map((d) => d.id), [b.id]);
  assert.equal((await app.request("/auth/devices", { headers: tunnel() })).status, 401);

  const ownerH = { cookie: sessionCookie(makeSession(OWNER)), ...tunnel() };
  const all = (await (await app.request("/auth/devices?all=1", { headers: ownerH })).json()) as { devices: unknown[] };
  assert.equal(all.devices.length, 2);
  assert.equal((await app.request(`/auth/devices/${b.id}`, { method: "DELETE", headers: ownerH })).status, 200);
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(b.token), ...tunnel() } })).status, 401);

  // Own device revoke via DELETE.
  assert.equal((await app.request(`/auth/devices/${a.id}`, { method: "DELETE", headers: ha })).status, 200);
  assert.equal((await app.request("/auth/me", { headers: ha })).status, 401);
});

test("revoke by token (RFC 7009 style) always 200; self sign-out with bearer and no body", async () => {
  const a = issueDeviceToken(MEMBER, "phone", "prism-native");
  const r = await app.request("/auth/device/revoke", { method: "POST", headers: { ...FORM_H, ...tunnel() }, body: form({ token: a.token }) });
  assert.equal(r.status, 200);
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(a.token), ...tunnel() } })).status, 401);
  const unknown = await app.request("/auth/device/revoke", { method: "POST", headers: { ...FORM_H, ...tunnel() }, body: form({ token: "pd_nope" }) });
  assert.equal(unknown.status, 200, "no validity oracle");

  const b = issueDeviceToken(MEMBER, "laptop", "prism-native");
  const self = await app.request("/auth/device/revoke", { method: "POST", headers: { ...bearer(b.token), ...FORM_H, ...tunnel() }, body: "" });
  assert.equal(self.status, 200);
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(b.token), ...tunnel() } })).status, 401);
});

// ------------------------------------------------------------- CORS

test("CORS: native origins get NON-credentialed CORS; APP_ORIGIN keeps credentials; others get nothing", async () => {
  const pre = (origin: string) =>
    app.request(notesPath(), {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
  for (const o of ["tauri://localhost", "http://tauri.localhost"]) {
    const r = await pre(o);
    assert.equal(r.headers.get("access-control-allow-origin"), o);
    assert.equal(r.headers.get("access-control-allow-credentials"), null, `${o}: no credentials`);
  }
  const app0 = await pre(config.appOrigin);
  assert.equal(app0.headers.get("access-control-allow-origin"), config.appOrigin);
  assert.equal(app0.headers.get("access-control-allow-credentials"), "true");
  const evil = await pre("https://evil.example");
  assert.notEqual(evil.headers.get("access-control-allow-origin"), "https://evil.example");
  // Actual request from a native origin with a device token.
  const { token } = issueDeviceToken(MEMBER, "phone", "prism-native");
  const me = await app.request("/auth/me", { headers: { origin: "tauri://localhost", ...bearer(token), ...tunnel() } });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.equal(me.headers.get("access-control-allow-credentials"), null);
});

// ------------------------------------------------------------- L2: passwords

const changePw = (headers: Record<string, string>, body: Record<string, string>) =>
  app.request("/auth/change-password", { method: "POST", headers: { "content-type": "application/json", ...headers, ...tunnel() }, body: JSON.stringify(body) });

test("L2: a device token can NOT set a first password (magic-link-only account); a session still can", async () => {
  const dev = issueDeviceToken(OWNER, "phone", "prism-native");
  const r = await changePw(bearer(dev.token), { newPassword: "a brand new passphrase" });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, "password_setup_requires_browser");
  assert.equal(getUser(OWNER)?.password_hash ?? null, null, "no password was set");

  const viaSession = await changePw({ cookie: sessionCookie(makeSession(OWNER)) }, { newPassword: "a brand new passphrase" });
  assert.equal(viaSession.status, 200);
  assert.ok(getUser(OWNER)?.password_hash);
});

test("L2: a device token must supply the current password; success revokes the account's OTHER devices, keeps the caller", async () => {
  setAccount(MEMBER, "Member", hashPassword("old passphrase here"));
  const caller = issueDeviceToken(MEMBER, "phone", "prism-native");
  const other = issueDeviceToken(MEMBER, "laptop", "prism-native");
  const stranger = issueDeviceToken(OTHER, "theirs", "prism-native");

  assert.equal((await changePw(bearer(caller.token), { newPassword: "new passphrase here" })).status, 403, "missing current");
  assert.equal((await changePw(bearer(caller.token), { currentPassword: "wrong", newPassword: "new passphrase here" })).status, 403);
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(other.token), ...tunnel() } })).status, 200, "failed attempts revoke nothing");

  const ok = await changePw(bearer(caller.token), { currentPassword: "old passphrase here", newPassword: "new passphrase here" });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { revokedDevices: number }).revokedDevices, 1);
  const me = (h: Record<string, string>) => app.request("/auth/me", { headers: { ...h, ...tunnel() } });
  assert.equal((await me(bearer(caller.token))).status, 200, "the calling device stays signed in");
  assert.equal((await me(bearer(other.token))).status, 401, "other devices are evicted");
  assert.equal((await me(bearer(stranger.token))).status, 200, "another account's devices are untouched");

  // A browser-session password change evicts every device of the account.
  const third = issueDeviceToken(MEMBER, "tablet", "prism-native");
  const viaSession = await changePw({ cookie: sessionCookie(makeSession(MEMBER)) }, { currentPassword: "new passphrase here", newPassword: "third passphrase here" });
  assert.equal(viaSession.status, 200);
  assert.equal((await me(bearer(caller.token))).status, 401);
  assert.equal((await me(bearer(third.token))).status, 401);
});

// ------------------------------------------------------------- L3: minted credentials die with the device

test("L3: MCP tokens minted via a device token are recorded with it and revoked (via the revoker seam) when the device is revoked", async () => {
  const revoked: string[] = [];
  let seq = 0;
  setMemberVaultTokensEnabled(true);
  setTokenMinter(async (opts) => {
    const jti = `jti-dev-${++seq}`;
    return { token: `fake.${jti}.sig`, jti, expiresAt: Date.now() + 86_400_000, scope: `vault:${opts.vaultName}:${opts.verb}` };
  });
  setTokenRevoker(async (jti) => {
    revoked.push(jti);
  });
  try {
    const dev = issueDeviceToken(OWNER, "phone", "prism-native");
    const viaDevice = await app.request("/api/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(dev.token), ...tunnel() },
      body: JSON.stringify({ scope: "read" }),
    });
    assert.equal(viaDevice.status, 200);
    const { jti } = (await viaDevice.json()) as { jti: string };
    assert.equal(getMcpToken(jti)?.device_id, dev.id);

    // One minted from a browser session is NOT tied to any device.
    const viaSession = await app.request("/api/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie(makeSession(OWNER)), ...tunnel() },
      body: JSON.stringify({ scope: "read" }),
    });
    const sessionJti = ((await viaSession.json()) as { jti: string }).jti;
    assert.equal(getMcpToken(sessionJti)?.device_id ?? null, null);

    const del = await app.request(`/auth/devices/${dev.id}`, { method: "DELETE", headers: { cookie: sessionCookie(makeSession(OWNER)), ...tunnel() } });
    assert.equal(del.status, 200);
    assert.deepEqual(revoked, [jti], "only the device's token is revoked at the hub");
    assert.ok(getMcpToken(jti)?.revoked_at);
    assert.equal(getMcpToken(sessionJti)?.revoked_at, null);
  } finally {
    setMemberVaultTokensEnabled(undefined);
    setTokenMinter(null);
    setTokenRevoker(null);
  }
});

// ------------------------------------------------------------- Info-3

test("consent CSRF refuses to run without SESSION_SECRET (no constant fallback key)", () => {
  const saved = config.sessionSecret;
  (config as { sessionSecret: string }).sessionSecret = "";
  try {
    assert.throws(() => consentCsrf("req", "sid"), /SESSION_SECRET/);
  } finally {
    (config as { sessionSecret: string }).sessionSecret = saved;
  }
});
