/**
 * Owner sign-in without email: POST /auth/local/link (host CLI) + GET /auth/local/signin
 * (src/auth/local-signin.ts, src/routes/local-signin.ts). Loopback only, host proof required,
 * single use, ten minutes, OWNER_EMAIL only, hashes stored, audited with ids only.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, setUserPassword, ensureUser } from "../src/db";
import { hostKeyPath, initLocalSignin, isHostKey, isLoopbackAddress, setHostKeyForTests, setLocalSigninClock, LOCAL_LINK_TTL_MS } from "../src/auth/local-signin";
import { localSigninLimits, resetLocalSigninLimitsForTests } from "../src/routes/local-signin";
import { hashPassword } from "../src/auth/password";
import { listActionAudit } from "../src/actions/store";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";
import { hostKeyFileFor } from "../scripts/lib/local-signin-client";

const KEY = "test-host-key-0123456789abcdefghijklmnopqrstuv";
const BASE = `http://127.0.0.1:${config.port}`;
const loop = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const remote = { incoming: { socket: { remoteAddress: "100.101.102.103" } } };

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let now = 1_800_000_000_000;
beforeEach(() => {
  resetDb();
  db.exec("DELETE FROM local_signin_links");
  fv = installFakeVault();
  app = createApp();
  setHostKeyForTests(KEY);
  now = 1_800_000_000_000;
  setLocalSigninClock(() => now);
  resetLocalSigninLimitsForTests();
});
afterEach(() => {
  fv.restore();
  setLocalSigninClock(null);
});
after(() => setHostKeyForTests(null));

const mint = (opts: { headers?: Record<string, string>; env?: object; url?: string; body?: string } = {}) =>
  app.request(
    opts.url ?? `${BASE}/auth/local/link`,
    { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...opts.headers }, body: opts.body ?? "{}" },
    opts.env ?? loop,
  );
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;
const spend = (token: string, opts: { headers?: Record<string, string>; env?: object } = {}) =>
  app.request(`${BASE}/auth/local/signin?token=${encodeURIComponent(token)}`, { headers: opts.headers ?? {} }, opts.env ?? loop);
const sessionFrom = (r: Response) => /prism_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? null;

test("the CLI's request on loopback with the host key gets a one-time link; only its hash is stored; the audit names an id", async () => {
  const r = await mint();
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = (await r.json()) as { url: string; expiresAt: string; expiresInSeconds: number; email: string };
  assert.match(body.url, new RegExp(`^http://localhost:${config.port}/auth/local/signin\\?token=[A-Za-z0-9_-]{43}$`));
  assert.equal(body.expiresInSeconds, 600);
  assert.equal(new Date(body.expiresAt).getTime(), now + LOCAL_LINK_TTL_MS);
  assert.equal(body.email, config.ownerEmail);
  const token = tokenOf(body.url);
  const rows = db.prepare("SELECT * FROM local_signin_links").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(token), "the raw token is never stored");
  const audit = listActionAudit({ action: ["auth.local-link"] });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.status, "ok");
  assert.match(String((audit[0]!.target as { link?: string }).link), /^ls_/);
  assert.ok(!JSON.stringify(audit).includes(token) && !JSON.stringify(audit).includes(KEY));
});

test("minting answers only a direct loopback connection: remote peers, proxies, other Host names and ports, in-process dispatch → 404", async () => {
  assert.equal((await mint({ env: remote })).status, 404, "a peer that is not loopback (the socket, not a header)");
  assert.equal((await mint({ env: {} })).status, 404, "no socket at all (an in-process / MCP dispatch)");
  for (const h of ["x-forwarded-for", "cf-connecting-ip", "x-real-ip", "forwarded", "tailscale-user-login", "x-forwarded-host", "via"]) {
    assert.equal((await mint({ headers: { [h]: "1.2.3.4" } })).status, 404, `forwarded (${h})`);
  }
  assert.equal((await mint({ url: `http://mac.tail1234.ts.net:${config.port}/auth/local/link` })).status, 404, "a proxy that keeps the public Host");
  assert.equal((await mint({ url: `http://attacker.example:${config.port}/auth/local/link` })).status, 404, "DNS rebinding");
  assert.equal((await mint({ url: `http://127.0.0.1:${config.port + 1}/auth/local/link` })).status, 404, "another port");
  assert.equal((db.prepare("SELECT count(*) AS n FROM local_signin_links").get() as { n: number }).n, 0);
});

test("host proof is required: no key, a wrong key, a device token, COLLAB_TOKEN, the vault token, a capability → 401; a browser → 403", async () => {
  for (const auth of [undefined, "Bearer wrong", "Bearer pd_abcdef", `Bearer ${config.collabToken}`, `Bearer ${config.parachuteToken}`, "Capability abc"]) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = auth;
    const r = await app.request(`${BASE}/auth/local/link`, { method: "POST", headers, body: "{}" }, loop);
    assert.equal(r.status, 401, String(auth));
  }
  // A page in a browser — even one served by this server, even signed in as the owner — never mints.
  const owner = sessionCookie(makeSession(config.ownerEmail));
  assert.equal((await mint({ headers: { cookie: owner } })).status, 403);
  assert.equal((await mint({ headers: { origin: config.appOrigin } })).status, 403);
  assert.equal((await mint({ headers: { "sec-fetch-site": "same-origin" } })).status, 403);
  assert.equal((await mint({ headers: { "content-type": "text/plain" } })).status, 415);
  // The request names nobody: there is no field to ask for another account.
  assert.equal((await mint({ body: JSON.stringify({ email: "someone@else.test" }) })).status, 400);
  assert.equal((db.prepare("SELECT count(*) AS n FROM local_signin_links").get() as { n: number }).n, 0);
  assert.ok(listActionAudit({ action: ["auth.local-link"] }).every((a) => a.status === "refused"));
});

test("no host key (in-memory database) → 503, after the loopback check", async () => {
  setHostKeyForTests(null);
  assert.equal((await mint()).status, 503);
  assert.equal((await mint({ env: remote })).status, 404);
  setHostKeyForTests(KEY);
});

test("spending the link starts the owner's ordinary session (no Secure flag on loopback http) and lands on the checklist; once only", async () => {
  const { url } = (await (await mint()).json()) as { url: string };
  const r = await spend(tokenOf(url));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/set-password?next=%2Fsetup", "no password yet: set one, then the checklist");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/i);
  assert.doesNotMatch(cookie, /Secure/i);
  const sid = sessionFrom(r)!;
  const me = await app.request(`${BASE}/auth/me`, { headers: { cookie: `prism_session=${sid}` } }, loop);
  assert.equal(((await me.json()) as { email: string; isOwner: boolean }).isOwner, true);
  // Single use.
  const again = await spend(tokenOf(url));
  assert.equal(again.headers.get("location"), "/?login=local-expired");
  assert.equal(sessionFrom(again), null);
  const audit = listActionAudit({ action: ["auth.local-signin"] }).map((a) => a.status).sort();
  assert.deepEqual(audit, ["ok", "refused"]);
});

test("an owner who has a password lands on the setup checklist while setup is unfinished", async () => {
  ensureUser(config.ownerEmail);
  setUserPassword(config.ownerEmail, hashPassword("a-long-enough-password"));
  const { url } = (await (await mint()).json()) as { url: string };
  const r = await spend(tokenOf(url));
  assert.equal(r.headers.get("location"), "/setup", "no agent token and no device yet: the checklist");
});

test("expiry by the clock: the last millisecond works, ten minutes is too late", async () => {
  const a = tokenOf(((await (await mint()).json()) as { url: string }).url);
  now += LOCAL_LINK_TTL_MS;
  assert.equal((await spend(a)).headers.get("location"), "/?login=local-expired");
  const b = tokenOf(((await (await mint()).json()) as { url: string }).url);
  now += LOCAL_LINK_TTL_MS - 1;
  assert.notEqual((await spend(b)).headers.get("location"), "/?login=local-expired");
});

test("a new link retires the one before it", async () => {
  const first = tokenOf(((await (await mint()).json()) as { url: string }).url);
  const second = tokenOf(((await (await mint()).json()) as { url: string }).url);
  assert.equal((await spend(first)).headers.get("location"), "/?login=local-expired");
  assert.notEqual((await spend(second)).headers.get("location"), "/?login=local-expired");
});

test("a link signs in OWNER_EMAIL as it is now: minted before the owner changed, it signs in nobody", async () => {
  const token = tokenOf(((await (await mint()).json()) as { url: string }).url);
  const was = config.ownerEmail;
  (config as { ownerEmail: string }).ownerEmail = "new-owner@test.local";
  try {
    const r = await spend(token);
    assert.equal(r.headers.get("location"), "/?login=local-expired");
    assert.equal(sessionFrom(r), null);
  } finally {
    (config as { ownerEmail: string }).ownerEmail = was;
  }
});

test("off loopback (tunnel, Tailscale, LAN) a link is not even looked at, and stays usable here", async () => {
  const token = tokenOf(((await (await mint()).json()) as { url: string }).url);
  assert.equal((await spend(token, { env: remote })).status, 404);
  assert.equal((await spend(token, { headers: { "x-forwarded-for": "9.9.9.9" } })).status, 404);
  assert.equal((await spend(token, { headers: { "sec-fetch-site": "cross-site" } })).headers.get("location"), "/?login=local-expired", "a page on another site cannot spend it");
  assert.equal(sessionFrom(await spend(token)) !== null, true, "the link was not consumed by the refused attempts");
});

test("rate limits: mints per window, and failed host proofs lock minting for the window", async () => {
  const before = { ...localSigninLimits };
  try {
    localSigninLimits.mints = 2;
    assert.equal((await mint()).status, 201);
    assert.equal((await mint()).status, 201);
    const r = await mint();
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    resetLocalSigninLimitsForTests();
    localSigninLimits.proofFailures = 2;
    await mint({ headers: { authorization: "Bearer nope" } });
    await mint({ headers: { authorization: "Bearer nope" } });
    assert.equal((await mint()).status, 429, "even the right key waits after repeated wrong ones");
  } finally {
    Object.assign(localSigninLimits, before);
  }
});

test("the host key file: written 0600, replaced at every start, refused in a folder others can write; the CLI finds the same path", () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-hostkey-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "host-signin.key");
    assert.deepEqual(initLocalSignin(file), { enabled: true });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const k1 = readFileSync(file, "utf8").trim();
    assert.equal(isHostKey(k1), true);
    initLocalSignin(file);
    const k2 = readFileSync(file, "utf8").trim();
    assert.notEqual(k1, k2);
    assert.equal(isHostKey(k1), false, "the previous start's key is dead");
    assert.equal(isHostKey(k2), true);
    chmodSync(dir, 0o777);
    assert.equal(initLocalSignin(file).enabled, false);
    assert.equal(isHostKey(k2), false);
    chmodSync(dir, 0o700);
    // Server and CLI agree on where the key is.
    const db1 = join(dir, "prism-server.db");
    assert.equal(hostKeyPath({}, db1), hostKeyFileFor({ DB_PATH: db1 }, "/elsewhere"));
    assert.equal(hostKeyPath({ HOST_KEY_FILE: file }, ":memory:"), hostKeyFileFor({ HOST_KEY_FILE: file }, "/x"));
    assert.equal(hostKeyPath({}, ":memory:"), null);
    assert.equal(hostKeyFileFor({ DB_PATH: ":memory:" }, "/x"), null);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
    setHostKeyForTests(KEY);
  }
});

test("loopback addresses", () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["10.0.0.1", "100.64.0.1", "::ffff:10.0.0.1", "fe80::1", "", null, "localhost"]) assert.equal(isLoopbackAddress(a), false, String(a));
});
