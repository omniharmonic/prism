/**
 * The one origin rule (src/auth/origin.ts): APP_ORIGIN, NATIVE_ORIGINS, or — only for a
 * strict-loopback request (socket peer loopback, no proxy header, Host = a loopback name on
 * this port) — this server's own loopback origin on its own port. Plus the cookie `Secure`
 * flag that follows a strict-loopback http request. And every migrated call site: a
 * cross-origin request is still refused there, the local origin is now accepted.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { allowedOrigin, cookieSecure, loopbackSelfOrigins } from "../src/auth/origin";
import { setUserPassword, ensureUser } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { stopImportWorker } from "../src/transfer/import";
import { stopExportWorker } from "../src/transfer/export";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const REMOTE_ORIGIN = "https://prism.example.ts.net";
const PORT = config.port;
const LOCAL = `http://localhost:${PORT}`;
const loop = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const loop6 = { incoming: { socket: { remoteAddress: "::1" } } };
const remote = { incoming: { socket: { remoteAddress: "100.101.102.103" } } };

let savedOrigin = "";
before(() => {
  savedOrigin = config.appOrigin;
  (config as { appOrigin: string }).appOrigin = REMOTE_ORIGIN;
});
after(async () => {
  (config as { appOrigin: string }).appOrigin = savedOrigin;
  await stopImportWorker();
  await stopExportWorker();
});

// ── the helper ───────────────────────────────────────────────────────────────

const probe = new Hono();
probe.all("/probe", (c) => c.json({ allowed: allowedOrigin(c, c.req.header("x-test-origin") ?? ""), secure: cookieSecure(c) }));
const ask = async (url: string, origin: string, env: object = loop, headers: Record<string, string> = {}) =>
  (await (await probe.request(url, { headers: { "x-test-origin": origin, ...headers } }, env)).json()) as { allowed: boolean; secure: boolean };

test("APP_ORIGIN and NATIVE_ORIGINS are accepted from anywhere (a trailing slash tolerated)", async () => {
  assert.equal((await ask(`${REMOTE_ORIGIN}/probe`, REMOTE_ORIGIN, remote)).allowed, true);
  assert.equal((await ask(`${REMOTE_ORIGIN}/probe`, `${REMOTE_ORIGIN}/`, remote)).allowed, true);
  for (const n of config.nativeOrigins) assert.equal((await ask(`${REMOTE_ORIGIN}/probe`, n, remote)).allowed, true, n);
});

test("this server's own loopback origin on its port is accepted only from a direct loopback request to that same origin", async () => {
  assert.deepEqual(loopbackSelfOrigins(), [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`]);
  for (const o of loopbackSelfOrigins()) {
    assert.equal((await ask(`${o}/probe`, o, loop)).allowed, true, `${o} from 127.0.0.1`);
    assert.equal((await ask(`${o}/probe`, o, loop6)).allowed, true, `${o} from ::1`);
  }
});

test("another localhost port, another loopback name, a forwarded request, a remote peer or a Host mismatch → refused", async () => {
  assert.equal((await ask(`${LOCAL}/probe`, "http://localhost:5173")).allowed, false, "a page on another localhost port");
  assert.equal((await ask(`${LOCAL}/probe`, `http://localhost:${PORT + 1}`)).allowed, false, "port + 1");
  assert.equal((await ask(`http://localhost:${PORT + 1}/probe`, `http://localhost:${PORT + 1}`)).allowed, false, "a request to another port is not this server's own origin");
  assert.equal((await ask(`${LOCAL}/probe`, `https://localhost:${PORT}`)).allowed, false, "https on the loopback port");
  assert.equal((await ask(`http://127.0.0.1:${PORT}/probe`, LOCAL)).allowed, false, "localhost page → 127.0.0.1 request is another origin");
  for (const h of ["x-forwarded-for", "cf-connecting-ip", "forwarded", "x-forwarded-host", "tailscale-user-login", "via", "x-real-ip"]) {
    assert.equal((await ask(`${LOCAL}/probe`, LOCAL, loop, { [h]: "1.2.3.4" })).allowed, false, `forwarded (${h})`);
  }
  assert.equal((await ask(`${LOCAL}/probe`, LOCAL, remote)).allowed, false, "a remote socket peer");
  assert.equal((await ask(`${LOCAL}/probe`, LOCAL, {})).allowed, false, "no socket (in-process dispatch)");
  assert.equal((await ask(`${LOCAL}/probe`, LOCAL, loop, { host: "evil.example" })).allowed, false, "Host mismatch");
  assert.equal((await ask(`http://evil.example:${PORT}/probe`, `http://evil.example:${PORT}`)).allowed, false, "a rebinding name on our port");
  assert.equal((await ask(`${LOCAL}/probe`, "null")).allowed, false, "opaque origin");
  assert.equal((await ask(`${LOCAL}/probe`, "")).allowed, false, "empty");
});

test("cookieSecure: false only for a strict-loopback http request; otherwise follows APP_ORIGIN", async () => {
  assert.equal((await ask(`${LOCAL}/probe`, LOCAL, loop)).secure, false);
  assert.equal((await ask(`${LOCAL}/probe`, LOCAL, remote)).secure, true, "remote peer");
  assert.equal((await ask(`${LOCAL}/probe`, LOCAL, loop, { "x-forwarded-for": "1.2.3.4" })).secure, true, "forwarded");
  assert.equal((await ask(`${REMOTE_ORIGIN}/probe`, REMOTE_ORIGIN, remote)).secure, true, "the public origin");
  (config as { appOrigin: string }).appOrigin = "http://localhost:8787";
  try {
    assert.equal((await ask(`${LOCAL}/probe`, LOCAL, remote)).secure, false, "an http APP_ORIGIN: unchanged");
  } finally {
    (config as { appOrigin: string }).appOrigin = REMOTE_ORIGIN;
  }
});

// ── every migrated call site ─────────────────────────────────────────────────

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let owner = "";
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  app = createApp();
  owner = makeSession(config.ownerEmail);
});
afterEach(() => fv.restore());

const BAD = ["http://localhost:5173", "https://evil.example"];
const call = (path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit }, origin: string, env: object = loop, base = LOCAL) =>
  app.request(`${base}${path}`, { method: init.method, headers: { cookie: sessionCookie(owner), origin, ...init.headers }, body: init.body }, env);

const json = (method: string, body: unknown = {}) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function errorOf(r: Response): Promise<string | undefined> {
  return ((await r.clone().json().catch(() => ({}))) as { error?: string }).error;
}

test("csrfRefusal (routes/actions.ts, shared by notifications/acl/auth/push/…): cross-origin refused, the local origin accepted", async () => {
  const req = json("PUT", { settings: { mention: { push: false, email: false } } });
  for (const o of BAD) {
    const r = await call("/api/notifications/settings", req, o);
    assert.equal(r.status, 403, o);
    assert.equal(await errorOf(r), "csrf_refused");
  }
  const forwarded = await call("/api/notifications/settings", { ...req, headers: { ...req.headers, "x-forwarded-for": "1.2.3.4" } }, LOCAL);
  assert.equal(forwarded.status, 403, "a proxied request naming the local origin");
  assert.equal((await call("/api/notifications/settings", req, LOCAL)).status, 200);
  assert.equal((await call("/api/notifications/settings", req, REMOTE_ORIGIN, remote, REMOTE_ORIGIN)).status, 200, "APP_ORIGIN unchanged");
});

test("notifications originRefusal (DELETE /api/reminders/:id): cross-origin refused, the local origin passes", async () => {
  for (const o of BAD) assert.equal(await errorOf(await call("/api/reminders/r_missing", { method: "DELETE" }, o)), "csrf_refused", o);
  const r = await call("/api/reminders/r_missing", { method: "DELETE" }, LOCAL);
  assert.notEqual(r.status, 403);
});

test("export originRefusal (DELETE /api/export/:id) and the import that reuses it: cross-origin refused, the local origin passes", async () => {
  for (const o of BAD) assert.equal(await errorOf(await call("/api/export/nope", { method: "DELETE" }, o)), "csrf_refused", o);
  assert.notEqual(await errorOf(await call("/api/export/nope", { method: "DELETE" }, LOCAL)), "csrf_refused");
  const imp = { method: "POST", headers: { "x-prism-import": "1", "content-type": "text/markdown" }, body: "# Hi" };
  for (const o of BAD) assert.equal(await errorOf(await call("/api/import?dryRun=1&name=a.md", imp, o)), "csrf_refused", o);
  assert.notEqual(await errorOf(await call("/api/import?dryRun=1&name=a.md", imp, LOCAL)), "csrf_refused");
});

test("attachment upload gate: cross-origin refused, the local origin passes the gate", async () => {
  const form = () => {
    const f = new FormData();
    f.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "a.png");
    return f;
  };
  for (const o of BAD) assert.equal(await errorOf(await call("/api/notes/n1/attachments?kind=image", { method: "POST", headers: { "x-prism-upload": "1" }, body: form() }, o)), "csrf_refused", o);
  assert.notEqual(await errorOf(await call("/api/notes/n1/attachments?kind=image", { method: "POST", headers: { "x-prism-upload": "1" }, body: form() }, LOCAL)), "csrf_refused");
});

test("MCP endpoint Origin check: a foreign origin is refused, the local origin reaches authentication", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const mcp = (origin: string, env: object = loop) =>
    app.request(`${LOCAL}/mcp`, { method: "POST", headers: { origin, "content-type": "application/json", accept: "application/json, text/event-stream" }, body }, env);
  for (const o of BAD) {
    const r = await mcp(o);
    assert.equal(r.status, 403, o);
    assert.equal(await errorOf(r), "forbidden_origin");
  }
  assert.equal(await errorOf(await mcp(LOCAL, remote)), "forbidden_origin", "a remote peer naming the local origin");
  const ok = await mcp(LOCAL);
  assert.equal(ok.status, 401, "no bearer: the ordinary 401, not the origin refusal");
});

test("session cookie: Secure follows the request scheme for a strict-loopback http sign-in only", async () => {
  ensureUser(config.ownerEmail);
  setUserPassword(config.ownerEmail, hashPassword("a-long-enough-password"));
  const login = (env: object, base: string) =>
    app.request(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: config.ownerEmail, password: "a-long-enough-password" }) }, env);
  const local = await login(loop, LOCAL);
  assert.equal(local.status, 200);
  assert.match(local.headers.get("set-cookie") ?? "", /prism_session=/);
  assert.doesNotMatch(local.headers.get("set-cookie") ?? "", /;\s*Secure/i, "http://localhost would drop a Secure cookie");
  const pub = await login(remote, REMOTE_ORIGIN);
  assert.match(pub.headers.get("set-cookie") ?? "", /;\s*Secure/i, "the public https origin keeps Secure");
});

test("device-flow parking cookie: Secure follows the request scheme for a strict-loopback http request only", async () => {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: "prism-native",
    redirect_uri: "http://127.0.0.1:43123/callback",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "state-0123456789",
  });
  const authorize = (env: object, base: string) => app.request(`${base}/auth/device/authorize?${q}`, {}, env);
  const local = (await authorize(loop, LOCAL)).headers.get("set-cookie") ?? "";
  const pub = (await authorize(remote, REMOTE_ORIGIN)).headers.get("set-cookie") ?? "";
  assert.match(local, /prism_device_req=/, "the request is parked");
  assert.doesNotMatch(local, /;\s*Secure/i);
  assert.match(pub, /prism_device_req=.*;\s*Secure/i);
});
