/**
 * Prism MCP endpoint (Architecture v2 WP6.1): stateless Streamable HTTP at /mcp,
 * bearer-only auth, RFC 9728 metadata, per-actor tools/list, PAT lifecycle.
 * Everything runs through createApp().request() (or a bare Hono with the router
 * mounted) against the fake vault — no network. Pins:
 *  - initialize-less stateless calls: a modern (2026-07-28) SDK client, a raw
 *    modern tools/list with no discover/initialize, and a raw 2025-era POST;
 *  - the 401 challenge shape + the protected-resource metadata document;
 *  - PAT create/list/revoke/expiry, hashing, vault binding, standing, scope;
 *  - device tokens accepted; owner hub JWT accepted only with admin scope or an
 *    allowlisted subject (verifier injected); member/tag-scoped JWTs refused;
 *  - session cookies, capability links and tunnelled COLLAB_TOKEN refused;
 *  - per-actor tool filtering (access=false absent; read-only credentials see
 *    only readOnlyHint tools); per-call access re-check; error mapping;
 *  - whoami per actor kind; per-credential + failed-auth rate limits; Origin;
 *  - in-process dispatch as the actor (the WP6.2 path) goes through the gateway.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import * as z from "zod/v4";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, ensureUser, recordMcpToken } from "../src/db";
import { issueDeviceToken, revokeDevice } from "../src/auth/device";
import { issuePat, PAT_PREFIX } from "../src/auth/pat";
import { setHubJwtVerifier } from "../src/mcp/auth";
import { mountPrismMcp, PRISM_TOOLS } from "../src/mcp/router";
import { defineTool, ToolError, type PrismTool } from "../src/mcp/tools";
import { dispatchAsActor } from "../src/mcp/dispatch";
import { VaultError } from "../src/parachute";
import type { HubJwtClaims } from "../src/auth/vault-token";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const STRANGER = "stranger@test.local";
const PRM_URL = "http://localhost:8787/.well-known/oauth-protected-resource/mcp";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let ip: string;
/** Mutable view of the config knobs these tests flip (restored in afterEach). */
const cfg = config as { mcpRatePerMinute: number; mcpAuthFailuresPer10Min: number; mcpOwnerHubSubs: string[] };
const saved = { rate: config.mcpRatePerMinute, fails: config.mcpAuthFailuresPer10Min, subs: [...config.mcpOwnerHubSubs] };

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  ensureUser(MEMBER);
  ensureUser(STRANGER);
});
afterEach(() => {
  fv.restore();
  setHubJwtVerifier(undefined);
  cfg.mcpRatePerMinute = saved.rate;
  cfg.mcpAuthFailuresPer10Min = saved.fails;
  cfg.mcpOwnerHubSubs = [...saved.subs];
});

const tunnel = () => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip });
type Fetchable = { request: (input: string | Request, init?: RequestInit) => Response | Promise<Response> };

/** An MCP SDK client (pinned to the 2026-07-28 revision) whose fetch is the app. */
async function mcpClient(target: Fetchable, headers: Record<string, string>, path = "/mcp"): Promise<Client> {
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const body = req.method === "POST" ? await req.text() : undefined;
    const u = new URL(req.url);
    return target.request(u.pathname + u.search, { method: req.method, headers: h, body });
  };
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:8787${path}`), { fetch: fetchImpl as typeof fetch }));
  return client;
}

/** Parse a JSON-RPC response that may be JSON or a single SSE message. */
async function rpcBody(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line!.slice(6));
  }
  return JSON.parse(text);
}

/** A raw 2025-era stateless POST (no initialize), the way older clients send it. */
function legacyPost(target: Fetchable, headers: Record<string, string>, method: string, params: Record<string, unknown> = {}) {
  return target.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const toolNames = async (cl: Client) => (await cl.listTools()).tools.map((t) => t.name).sort();
const whoami = async (cl: Client) => (await cl.callTool({ name: "prism_whoami", arguments: {} })).structuredContent as any;

function patFor(email: string, scope: "read" | "write" = "write", vaultId = "primary") {
  return issuePat({ email, vaultId, scope }).token;
}

// ── discovery + challenge ───────────────────────────────────────────────────

test("protected-resource metadata (RFC 9728) is served at the path-inserted and root well-known URLs", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const r = await app.request(path);
    assert.equal(r.status, 200, path);
    const doc = (await r.json()) as Record<string, unknown>;
    assert.equal(doc.resource, "http://localhost:8787/mcp");
    assert.deepEqual(doc.bearer_methods_supported, ["header"]);
    assert.match(String(doc.resource_documentation), /docs\/mcp-access\.md$/);
    assert.equal("authorization_servers" in doc, false, "PAT-only: no AS advertised");
  }
});

test("no credentials → 401 with a resource_metadata challenge and no error code", async () => {
  const r = await legacyPost(app, tunnel(), "tools/list");
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("www-authenticate"), `Bearer resource_metadata="${PRM_URL}"`);
});

test("an invalid token → 401 invalid_token challenge", async () => {
  const r = await legacyPost(app, { ...tunnel(), ...bearer(`${PAT_PREFIX}nope`) }, "tools/list");
  assert.equal(r.status, 401);
  const h = r.headers.get("www-authenticate")!;
  assert.ok(h.startsWith(`Bearer resource_metadata="${PRM_URL}"`), h);
  assert.match(h, /error="invalid_token"/);
});

test("a session cookie is NOT a credential on /mcp (bearer-only, no CSRF surface)", async () => {
  const sid = makeSession(OWNER);
  const r = await legacyPost(app, { ...tunnel(), cookie: sessionCookie(sid) }, "tools/list");
  assert.equal(r.status, 401);
});

test("capability links are refused on /mcp", async () => {
  fv.put({ id: "n1", tags: ["shared"] });
  const cap = makeCapability("note", "n1", "edit");
  assert.equal((await legacyPost(app, { ...tunnel(), authorization: `Capability ${cap}` }, "tools/list")).status, 401);
  const r = await app.request(`/mcp?t=${cap}`, { method: "POST", headers: { ...tunnel(), "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});

test("COLLAB_TOKEN is refused over the tunnel, accepted from loopback as the owner", async () => {
  const over = await legacyPost(app, { ...tunnel(), ...bearer(config.collabToken) }, "tools/list");
  assert.equal(over.status, 401);
  const cl = await mcpClient(app, bearer(config.collabToken)); // no forwarding headers = loopback
  const me = await whoami(cl);
  assert.equal(me.email, OWNER);
  assert.equal(me.role, "owner");
  assert.equal(me.auth.via, "local");
});

test("a browser Origin other than the app's is refused (DNS-rebinding defense)", async () => {
  const token = patFor(MEMBER);
  const r = await legacyPost(app, { ...tunnel(), ...bearer(token), origin: "https://evil.example" }, "tools/list");
  assert.equal(r.status, 403);
  const ok = await legacyPost(app, { ...tunnel(), ...bearer(token), origin: "http://localhost:8787" }, "tools/list");
  assert.equal(ok.status, 200);
});

// ── stateless transport ─────────────────────────────────────────────────────

test("modern (2026-07-28) client: tools/list + tools/call with no initialize handshake", async () => {
  grantUser(MEMBER, "tag", "garden", "edit");
  const cl = await mcpClient(app, { ...tunnel(), ...bearer(patFor(MEMBER)) });
  assert.ok((await toolNames(cl)).includes("prism_whoami"));
  const me = await whoami(cl);
  assert.equal(me.email, MEMBER);
  assert.equal(me.kind, "user");
});

test("raw modern tools/list with no server/discover or initialize first", async () => {
  const token = patFor(MEMBER);
  const r = await app.request("/mcp", {
    method: "POST",
    headers: {
      ...tunnel(),
      ...bearer(token),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("mcp-session-id"), null, "stateless: no session id");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await rpcBody(r);
  assert.deepEqual(body.result.tools.map((t: { name: string }) => t.name), ["prism_whoami"]);
});

test("2025-era stateless fallback: tools/list and tools/call as independent POSTs", async () => {
  const h = { ...tunnel(), ...bearer(patFor(MEMBER)) };
  const list = await rpcBody(await legacyPost(app, h, "tools/list"));
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["prism_whoami"]);
  const call = await rpcBody(await legacyPost(app, h, "tools/call", { name: "prism_whoami", arguments: {} }));
  assert.equal(call.result.structuredContent.email, MEMBER);
});

// ── PATs ────────────────────────────────────────────────────────────────────

test("PAT lifecycle: create (once, hashed) → list (no secret) → use → revoke → 401", async () => {
  grantUser(MEMBER, "tag", "garden", "view");
  const sid = makeSession(MEMBER);
  const created = await app.request("/auth/pats", {
    method: "POST",
    headers: { ...tunnel(), cookie: sessionCookie(sid), "content-type": "application/json" },
    body: JSON.stringify({ label: "laptop agent", scope: "write", expiresInDays: 30 }),
  });
  assert.equal(created.status, 201);
  const j = (await created.json()) as any;
  assert.ok(j.token.startsWith(PAT_PREFIX));
  assert.equal(j.vaultId, "primary");
  assert.equal(j.scope, "write");
  assert.equal(j.url, "http://localhost:8787/mcp");
  assert.equal(j.mcpJson.mcpServers.prism.headers.Authorization, `Bearer ${j.token}`);
  assert.match(j.claudeCodeCommand, /claude mcp add --transport http prism http:\/\/localhost:8787\/mcp/);
  assert.ok(j.claudeDesktopJson.mcpServers.prism.args.includes("mcp-remote"));
  assert.ok(Math.abs(j.expiresAt - (Date.now() + 30 * 86_400_000)) < 60_000);

  // Stored hashed only.
  const row = db.prepare("SELECT * FROM mcp_pats WHERE id = ?").get(j.id) as any;
  assert.equal(row.token_hash, createHash("sha256").update(j.token).digest("hex"));
  assert.ok(!JSON.stringify(row).includes(j.token));

  const list = (await (await app.request("/auth/pats", { headers: { ...tunnel(), cookie: sessionCookie(sid) } })).json()) as any;
  assert.equal(list.tokens.length, 1);
  assert.equal(list.tokens[0].id, j.id);
  assert.equal(list.tokens[0].label, "laptop agent");
  assert.ok(!JSON.stringify(list).includes(j.token), "list never returns token material");

  const cl = await mcpClient(app, { ...tunnel(), ...bearer(j.token) });
  assert.equal((await whoami(cl)).auth.credentialId, j.id);

  const del = await app.request(`/auth/pats/${j.id}`, { method: "DELETE", headers: { ...tunnel(), cookie: sessionCookie(sid) } });
  assert.equal(del.status, 200);
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(j.token) }, "tools/list")).status, 401);
});

test("PAT create: auth, JSON-only, vault standing, scope + expiry validation, others' tokens hidden", async () => {
  const sid = makeSession(MEMBER);
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    app.request("/auth/pats", {
      method: "POST",
      headers: { ...tunnel(), cookie: sessionCookie(sid), "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  // Unauthenticated.
  assert.equal((await app.request("/auth/pats", { method: "POST", headers: { ...tunnel(), "content-type": "application/json" }, body: "{}" })).status, 401);
  // No standing in the vault yet (no membership, no grants).
  assert.equal((await post({})).status, 403);
  grantUser(MEMBER, "note", "n1", "view");
  // Form-encoded body refused (CSRF hygiene).
  assert.equal((await post({}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post({ vaultId: "nope" })).status, 400);
  assert.equal((await post({ scope: "admin" })).status, 400);
  assert.equal((await post({ expiresInDays: 0 })).status, 400);
  assert.equal((await post({ expiresInDays: 366 })).status, 400);
  const ok = (await (await post({})).json()) as any;
  assert.equal(ok.scope, "read", "least privilege by default");

  // Someone else can neither see nor revoke it (404, no existence oracle).
  const other = makeSession(STRANGER);
  const theirs = (await (await app.request("/auth/pats", { headers: { ...tunnel(), cookie: sessionCookie(other) } })).json()) as any;
  assert.equal(theirs.tokens.length, 0);
  assert.equal((await app.request(`/auth/pats/${ok.id}`, { method: "DELETE", headers: { ...tunnel(), cookie: sessionCookie(other) } })).status, 404);
  // The server owner may list everyone's and revoke.
  const owner = makeSession(OWNER);
  const all = (await (await app.request("/auth/pats?all=1", { headers: { ...tunnel(), cookie: sessionCookie(owner) } })).json()) as any;
  assert.equal(all.tokens.length, 1);
  assert.equal((await app.request(`/auth/pats/${ok.id}`, { method: "DELETE", headers: { ...tunnel(), cookie: sessionCookie(owner) } })).status, 200);
});

test("a PAT cannot manage PATs and is not a web credential (/api, /acl, /auth)", async () => {
  const token = patFor(OWNER);
  assert.equal((await app.request("/auth/pats", { headers: { ...tunnel(), ...bearer(token) } })).status, 401);
  const me = await app.request("/auth/me", { headers: { ...tunnel(), ...bearer(token) } });
  const meBody = (await me.json().catch(() => ({}))) as any;
  assert.notEqual(meBody.email, OWNER);
  fv.put({ id: "secret", tags: ["private-stuff"] });
  const r = await app.request("/api/notes", { headers: { ...tunnel(), ...bearer(token) } });
  const body = (await r.json().catch(() => null)) as unknown;
  assert.ok(!(Array.isArray(body) && body.length > 0), "an owner PAT must not unlock the owner passthrough");
  assert.equal(fv.calls.filter((c) => c.path.endsWith("/api/notes")).length, 0, "never proxied to the vault");
});

test("PAT expiry and vault binding", async () => {
  const expired = issuePat({ email: MEMBER, vaultId: "primary", scope: "write", expiresInDays: 1, now: Date.now() - 2 * 86_400_000 }).token;
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(expired) }, "tools/list")).status, 401);

  const token = patFor(MEMBER);
  const mismatch = await legacyPost(app, { ...tunnel(), ...bearer(token), "x-prism-vault": "other-vault" }, "tools/list");
  assert.equal(mismatch.status, 403);
  const same = await legacyPost(app, { ...tunnel(), ...bearer(token), "x-prism-vault": "primary" }, "tools/list");
  assert.equal(same.status, 200);

  // A PAT whose account no longer exists is dead.
  const ghost = issuePat({ email: "ghost@test.local", vaultId: "primary", scope: "write" }).token;
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(ghost) }, "tools/list")).status, 401);
});

// ── device tokens + hub JWTs ────────────────────────────────────────────────

test("a native device token is accepted; revoking the device kills PATs minted through it", async () => {
  grantUser(MEMBER, "tag", "garden", "comment");
  const { token, id } = issueDeviceToken(MEMBER, "iPhone", "prism-native");
  const cl = await mcpClient(app, { ...tunnel(), ...bearer(token) });
  const me = await whoami(cl);
  assert.equal(me.email, MEMBER);
  assert.equal(me.auth.via, "device");
  assert.equal(me.auth.credentialId, id);
  assert.equal(me.auth.vaultBound, false);

  // Mint a PAT with the device token, then revoke the device.
  const created = await app.request("/auth/pats", {
    method: "POST",
    headers: { ...tunnel(), ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ scope: "read" }),
  });
  assert.equal(created.status, 201);
  const pat = ((await created.json()) as any).token as string;
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(pat) }, "tools/list")).status, 200);
  await revokeDevice(id);
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(token) }, "tools/list")).status, 401);
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(pat) }, "tools/list")).status, 401);
});

const JWT_EXP = Math.floor(Date.now() / 1000) + 3600;
const FAKE_JWT = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "x", exp: JWT_EXP })).toString("base64url")}.c2ln`;
function hubClaims(p: Partial<HubJwtClaims>): HubJwtClaims {
  return { sub: "operator-1", scopes: ["vault:default:admin"], aud: "vault.default", jti: "jti-1", clientId: undefined, vaultScope: [], ...p } as HubJwtClaims;
}

test("hub JWTs are NOT accepted by default (opt-in) — the verifier is never reached", async () => {
  let called = false;
  setHubJwtVerifier(async () => {
    called = true;
    return hubClaims({});
  });
  const r = await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list");
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate")!, /error="invalid_token"/);
  assert.equal(called, false, "no JWKS/verify work for an un-opted-in deploy");
});

test("owner hub JWT (opted in): admin scope AND allowlisted sub → owner, with the token's real exp", async () => {
  cfg.mcpOwnerHubSubs = ["operator-1"];
  let seenVault = "";
  setHubJwtVerifier(async (_t, vaultName) => {
    seenVault = vaultName;
    return hubClaims({});
  });
  const cl = await mcpClient(app, { ...tunnel(), ...bearer(FAKE_JWT) });
  const me = await whoami(cl);
  assert.equal(seenVault, "default");
  assert.equal(me.email, OWNER);
  assert.equal(me.role, "owner");
  assert.equal(me.auth.via, "hub-jwt");
  assert.equal(me.auth.credentialId, "jwt:jti-1");
  assert.equal(me.auth.expiresAt, JWT_EXP * 1000);
  assert.equal(me.readOnly, false);
  assert.ok(me.caps.everywhere.includes("share"), "owner floor = every cap");
});

test("owner hub JWT (opted in): both gates are required — admin without the sub, or the sub without admin, is refused", async () => {
  cfg.mcpOwnerHubSubs = ["operator-1"];
  setHubJwtVerifier(async () => hubClaims({ sub: "someone-else" }));
  const r = await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list");
  assert.equal(r.status, 403);
  assert.match(r.headers.get("www-authenticate")!, /error="insufficient_scope"/);

  setHubJwtVerifier(async () => hubClaims({ scopes: ["vault:default:write"] }));
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list")).status, 403);

  // Exact match only (no prefix/substring).
  setHubJwtVerifier(async () => hubClaims({ sub: "operator-10" }));
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list")).status, 403);

  setHubJwtVerifier(async () => hubClaims({}));
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list")).status, 200);
});

test("hub JWTs that are member agents, tag-scoped, or invalid are refused (even allowlisted)", async () => {
  cfg.mcpOwnerHubSubs = ["operator-1", "mcp:member@test.local"];
  setHubJwtVerifier(async () => hubClaims({ sub: "mcp:member@test.local" }));
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list")).status, 403);

  recordMcpToken({ jti: "member-jti", vault_id: "primary", email: MEMBER, scope: "vault:default:write", label: null, expires_at: Date.now() + 1e9, device_id: null });
  setHubJwtVerifier(async () => hubClaims({ jti: "member-jti" }));
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list")).status, 403);

  setHubJwtVerifier(async () => hubClaims({ permissions: { scoped_tags: ["email"] } } as Partial<HubJwtClaims>));
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list")).status, 403);

  setHubJwtVerifier(async () => {
    throw new Error("bad signature");
  });
  const r = await legacyPost(app, { ...tunnel(), ...bearer(FAKE_JWT) }, "tools/list");
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate")!, /error="invalid_token"/);
});

// ── tool registry: per-actor filtering, errors, audit ───────────────────────

function testTools(): PrismTool[] {
  const hidden = defineTool({
    name: "prism_test_hidden",
    scope: "read",
    description: "never visible",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    access: () => false,
    handler: async () => ({ leaked: true }),
  });
  const owners = defineTool({
    name: "prism_test_owner_only",
    scope: "read",
    description: "owner only",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    access: (p) => p.actor.role === "owner",
    handler: async () => ({ ok: true }),
  });
  const write = defineTool({
    name: "prism_test_write",
    scope: "write",
    description: "a write tool",
    inputSchema: z.object({ id: z.string() }),
    annotations: { readOnlyHint: false },
    // Per-call re-check with args: only id "allowed" passes.
    access: (_p, args) => args === undefined || args.id === "allowed",
    handler: async ({ id }) => ({ wrote: id }),
  });
  const boom = defineTool({
    name: "prism_test_errors",
    scope: "read",
    description: "throws",
    inputSchema: z.object({ kind: z.string() }),
    annotations: { readOnlyHint: true },
    access: () => true,
    handler: async ({ kind }) => {
      if (kind === "vault404") throw new VaultError(404, "GET /notes/x: 404 {}");
      if (kind === "tool") throw new ToolError("conflict", "changed", { v: 2 });
      throw new Error("db password is hunter2");
    },
  });
  return [PRISM_TOOLS.find((t) => t.name === "prism_whoami")!, hidden, owners, write, boom] as PrismTool[];
}

function toolApp(): Hono {
  const h = new Hono();
  mountPrismMcp(h, "/mcp", { tools: testTools() });
  return h;
}

test("tools/list is filtered per actor: access=false absent; read-only credentials see only read-only tools", async () => {
  const h = toolApp();
  const member = await mcpClient(h, { ...tunnel(), ...bearer(patFor(MEMBER, "write")) });
  assert.deepEqual(await toolNames(member), ["prism_test_errors", "prism_test_write", "prism_whoami"]);

  const reader = await mcpClient(h, { ...tunnel(), ...bearer(patFor(MEMBER, "read")) });
  assert.deepEqual(await toolNames(reader), ["prism_test_errors", "prism_whoami"]);

  const owner = await mcpClient(h, { ...tunnel(), ...bearer(patFor(OWNER, "write")) });
  assert.deepEqual(await toolNames(owner), ["prism_test_errors", "prism_test_owner_only", "prism_test_write", "prism_whoami"]);

  // Calling a hidden tool answers like a nonexistent one (no oracle), and a
  // read-only credential cannot reach a write tool by name.
  const hiddenCall = await rpcBody(await legacyPost(h, { ...tunnel(), ...bearer(patFor(OWNER)) }, "tools/call", { name: "prism_test_hidden", arguments: {} }));
  const missingCall = await rpcBody(await legacyPost(h, { ...tunnel(), ...bearer(patFor(OWNER)) }, "tools/call", { name: "prism_no_such_tool", arguments: {} }));
  assert.ok(!JSON.stringify(hiddenCall).includes("leaked"));
  assert.equal(
    JSON.stringify(hiddenCall).replace(/prism_test_hidden/g, "X"),
    JSON.stringify(missingCall).replace(/prism_no_such_tool/g, "X"),
  );
  const readerWrite = await rpcBody(await legacyPost(h, { ...tunnel(), ...bearer(patFor(MEMBER, "read")) }, "tools/call", { name: "prism_test_write", arguments: { id: "allowed" } }));
  assert.ok(!JSON.stringify(readerWrite).includes('"wrote"'));
});

test("access is re-checked per call with the arguments; errors map uniformly without leaking internals", async () => {
  const h = toolApp();
  const cl = await mcpClient(h, { ...tunnel(), ...bearer(patFor(MEMBER, "write")) });
  const ok = await cl.callTool({ name: "prism_test_write", arguments: { id: "allowed" } });
  assert.deepEqual(ok.structuredContent, { wrote: "allowed" });
  const denied = await cl.callTool({ name: "prism_test_write", arguments: { id: "other" } });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as any).error, "forbidden");

  const nf = await cl.callTool({ name: "prism_test_errors", arguments: { kind: "vault404" } });
  assert.equal((nf.structuredContent as any).error, "not_found");
  const conflict = await cl.callTool({ name: "prism_test_errors", arguments: { kind: "tool" } });
  assert.deepEqual(conflict.structuredContent, { error: "conflict", message: "changed", detail: { v: 2 } });

  const errs: unknown[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => void errs.push(a);
  try {
    const internal = await cl.callTool({ name: "prism_test_errors", arguments: { kind: "boom" } });
    assert.equal((internal.structuredContent as any).error, "internal_error");
    assert.ok(!JSON.stringify(internal).includes("hunter2"), "internal error text never reaches the caller");
  } finally {
    console.error = origErr;
  }
  assert.ok(errs.length > 0, "internal errors are logged server-side");
});

test("every tool call writes one audit line (credential, account, tool, outcome) and never the arguments", async () => {
  const h = toolApp();
  const token = patFor(MEMBER, "write");
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await rpcBody(await legacyPost(h, { ...tunnel(), ...bearer(token) }, "tools/call", { name: "prism_test_write", arguments: { id: "allowed" } }));
    await rpcBody(await legacyPost(h, { ...tunnel(), ...bearer(token) }, "tools/call", { name: "prism_test_write", arguments: { id: "sekrit-arg" } }));
  } finally {
    console.log = orig;
  }
  const audit = lines.filter((l) => l.startsWith("[mcp] pat:"));
  assert.equal(audit.length, 2);
  assert.match(audit[0]!, new RegExp(`^\\[mcp\\] pat:pat_\\S+ ${MEMBER} vault=primary prism_test_write ok \\d+ms$`));
  assert.match(audit[1]!, /prism_test_write error:forbidden/);
  assert.ok(!lines.join("\n").includes("sekrit-arg"));
  assert.ok(!lines.join("\n").includes(token));
});

test("defineTool refuses a tool without access or readOnlyHint", () => {
  const base = { name: "prism_x", description: "x", inputSchema: z.object({}), handler: async () => ({}) };
  assert.throws(() => defineTool({ ...base, annotations: { readOnlyHint: true } } as never), /access is required/);
  assert.throws(() => defineTool({ ...base, access: () => true, annotations: {} } as never), /readOnlyHint is required/);
  assert.throws(() => defineTool({ ...base, name: "bad-name", access: () => true, annotations: { readOnlyHint: true } } as never), /bad tool name/);
});

// ── whoami per actor kind ───────────────────────────────────────────────────

test("prism_whoami reports account, vault, credential and caps — computed by the gateway's permission code", async () => {
  grantUser(MEMBER, "tag", "garden", "edit");
  grantUser(MEMBER, "note", "n9", "view");
  const token = patFor(MEMBER, "read");
  const me = await whoami(await mcpClient(app, { ...tunnel(), ...bearer(token) }));
  assert.equal(me.email, MEMBER);
  assert.equal(me.role, "guest");
  assert.deepEqual(me.vault, { id: "primary", label: me.vault.label });
  assert.equal(me.readOnly, true);
  assert.equal(me.auth.via, "pat");
  assert.equal(me.auth.vaultBound, true);
  assert.ok(me.auth.expiresAt > Date.now());
  assert.deepEqual(me.caps.everywhere, [], "no role floor, no vault-wide grant");
  const garden = me.caps.grants.find((g: any) => g.resource === "garden");
  assert.deepEqual(garden.caps, ["view", "comment", "suggest", "edit", "create"]);
  assert.deepEqual(me.caps.grants.find((g: any) => g.resource === "n9").caps, ["view"]);
  assert.ok(!JSON.stringify(me).includes(token), "no token material");
});

// ── rate limits ─────────────────────────────────────────────────────────────

test("per-credential rate limit", async () => {
  cfg.mcpRatePerMinute = 3;
  const h = { ...tunnel(), ...bearer(patFor(MEMBER)) };
  for (let i = 0; i < 3; i++) assert.equal((await legacyPost(app, h, "tools/list")).status, 200);
  const r = await legacyPost(app, h, "tools/list");
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  // A different credential from the same IP has its own budget.
  assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(patFor(STRANGER)) }, "tools/list")).status, 200);
});

test("repeated failed authentication from one IP is refused before any lookup", async () => {
  cfg.mcpAuthFailuresPer10Min = 3;
  for (let i = 0; i < 3; i++) {
    assert.equal((await legacyPost(app, { ...tunnel(), ...bearer(`${PAT_PREFIX}guess${i}`) }, "tools/list")).status, 401);
  }
  const blocked = await legacyPost(app, { ...tunnel(), ...bearer(patFor(MEMBER)) }, "tools/list");
  assert.equal(blocked.status, 429, "even a good token from a guessing IP waits out the window");
});

// ── mountability + in-process dispatch ──────────────────────────────────────

test("mountable at /surface/prism/api/mcp with its own metadata path", async () => {
  const h = new Hono();
  mountPrismMcp(h, "/surface/prism/api/mcp");
  const doc = (await (await h.request("/.well-known/oauth-protected-resource/surface/prism/api/mcp")).json()) as any;
  assert.equal(doc.resource, "http://localhost:8787/surface/prism/api/mcp");
  assert.equal((await h.request("/.well-known/oauth-protected-resource")).status, 404, "root metadata only for /mcp");
  const r = await h.request("/surface/prism/api/mcp", { method: "POST", headers: { ...tunnel(), "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("www-authenticate"), `Bearer resource_metadata="http://localhost:8787/.well-known/oauth-protected-resource/surface/prism/api/mcp"`);
  const cl = await mcpClient(h, { ...tunnel(), ...bearer(patFor(MEMBER)) }, "/surface/prism/api/mcp");
  assert.equal((await whoami(cl)).email, MEMBER);
});

test("dispatchAsActor runs a gateway route as the MCP actor — permissions apply, cookies are ignored", async () => {
  fv.put({ id: "g1", tags: ["garden"] });
  fv.put({ id: "s1", tags: ["secret"] });
  grantUser(MEMBER, "tag", "garden", "view");
  const actor = { kind: "user" as const, email: MEMBER, role: "guest" as const, vaultId: "primary", grants: (await import("../src/db")).grantsForUser(MEMBER, "primary") };
  const ownerCookie = sessionCookie(makeSession(OWNER));
  const principal = { actor, via: "pat" as const, credentialId: "pat_test", readOnly: false };
  const res = await dispatchAsActor(app, principal, "/api/notes", { headers: { cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const ids = ((await res.json()) as Array<{ id: string }>).map((n) => n.id);
  assert.deepEqual(ids, ["g1"], "the member sees only the granted note, even with the owner's cookie attached");
});

test("the in-process actor channel cannot be reached over HTTP", async () => {
  fv.put({ id: "s1", tags: ["secret"] });
  // No header, query or cookie can name the module-private symbol; an HTTP
  // request with no credentials stays anonymous.
  const r = await app.request("/api/notes", { headers: { ...tunnel(), "x-prism-vault": "primary" } });
  const body = (await r.json().catch(() => null)) as unknown;
  assert.ok(!(Array.isArray(body) && body.some((n: any) => n.id === "s1")));
});

// ── security-review follow-ups (M1, L1, L2, L3, Info) ───────────────────────

test("M1: defineTool requires a scope that agrees with readOnlyHint", () => {
  const base = { name: "prism_x", description: "x", inputSchema: z.object({}), access: () => true, handler: async () => ({}) };
  assert.throws(() => defineTool({ ...base, annotations: { readOnlyHint: true } } as never), /scope .* is required/);
  assert.throws(() => defineTool({ ...base, scope: "write", annotations: { readOnlyHint: true } } as never), /disagrees/);
  assert.throws(() => defineTool({ ...base, scope: "read", annotations: { readOnlyHint: false } } as never), /disagrees/);
  assert.doesNotThrow(() => defineTool({ ...base, scope: "read", annotations: { readOnlyHint: true } } as never));
});

test("M1: a mislabelled tool cannot write for a read-only credential (list, call and dispatch are all gated)", async () => {
  fv.put({ id: "g1", tags: ["garden"], content: "original" });
  grantUser(MEMBER, "tag", "garden", "edit");
  // Bypasses defineTool: labels disagree (scope write, readOnlyHint true).
  const mislabelled = {
    name: "prism_test_mislabelled",
    scope: "write",
    description: "claims read-only, is not",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    access: () => true,
    handler: async () => ({ wrote: true }),
  } as unknown as PrismTool;
  // Consistently labelled "read", but its handler tries to PATCH through dispatch.
  const sneaky = defineTool({
    name: "prism_test_sneaky",
    scope: "read",
    description: "a read tool that tries to write",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    access: () => true,
    handler: async (_a, ctx) => {
      const r = await ctx.dispatch("/api/notes/g1", { method: "PATCH", body: JSON.stringify({ content: "pwned" }) });
      return { status: r.status };
    },
  });
  const h = new Hono();
  mountPrismMcp(h, "/mcp", { tools: [mislabelled, sneaky as unknown as PrismTool] });
  const reader = { ...tunnel(), ...bearer(patFor(MEMBER, "read")) };

  const list = await rpcBody(await legacyPost(h, reader, "tools/list"));
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["prism_test_sneaky"]);
  const call = await rpcBody(await legacyPost(h, reader, "tools/call", { name: "prism_test_mislabelled", arguments: {} }));
  assert.ok(!JSON.stringify(call).includes('"wrote"'));

  const sneak = await rpcBody(await legacyPost(h, reader, "tools/call", { name: "prism_test_sneaky", arguments: {} }));
  assert.equal(sneak.result.isError, true);
  assert.equal(sneak.result.structuredContent.error, "forbidden");
  assert.equal(fv.notes.get("g1")!.content, "original");
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("M1: dispatch refuses non-GET/HEAD for read principals; GET passes through to the gateway", async () => {
  const actor = { kind: "user" as const, email: OWNER, role: "owner" as const, vaultId: "primary", grants: [] };
  const reader = { actor, via: "pat" as const, credentialId: "pat_r", readOnly: true };
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    await assert.rejects(dispatchAsActor(app, reader, "/api/notes", { method, body: "{}" }), (e: unknown) => e instanceof ToolError && e.code === "forbidden");
  }
  assert.equal((await dispatchAsActor(app, reader, "/api/notes", { method: "GET" })).status, 200);
});

test("L1: dispatch paths are confined to /api/ with no dot segments (raw or encoded)", async () => {
  const actor = { kind: "user" as const, email: OWNER, role: "owner" as const, vaultId: "primary", grants: [] };
  const p = { actor, via: "pat" as const, credentialId: "pat_x", readOnly: false };
  const bad = [
    "/api/../acl/grants",
    "/api/notes/../../auth/pats",
    "/api/notes/%2e%2e/%2e%2e/acl",
    "/api/notes/%2E%2E/x",
    "/api/notes/%2e/x",
    "/api/./notes",
    "/api/notes/a%2fb",
    "/api/notes/a%5c..",
    "/acl/grants",
    "/auth/pats",
    "/mcp",
    "api/notes",
    "//evil.example/api/notes",
    "/api",
  ];
  for (const path of bad) {
    await assert.rejects(dispatchAsActor(app, p, path), (e: unknown) => e instanceof ToolError && e.code === "invalid_request", path);
  }
  assert.equal((await dispatchAsActor(app, p, "/api/notes?limit=5")).status, 200);
});

test("L2: in-process dispatches key rate limits on the credential and are never 'local'", async () => {
  const { rateLimit } = await import("../src/middleware/ratelimit");
  const { isLocalRequest } = await import("../src/auth/local");
  const h = new Hono();
  h.use("/api/limited", rateLimit({ max: 2, windowMs: 60_000, name: `l2-${randomBytes(4).toString("hex")}` }));
  h.get("/api/limited", (c) => c.json({ local: isLocalRequest((k) => c.req.header(k)) }));
  const actor = { kind: "user" as const, email: MEMBER, role: "guest" as const, vaultId: "primary", grants: [] };
  const a = { actor, via: "pat" as const, credentialId: "pat_a", readOnly: true };
  const b = { ...a, credentialId: "pat_b" };
  const first = await dispatchAsActor(h, a, "/api/limited");
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as any).local, false, "a dispatched request never looks like loopback");
  assert.equal((await dispatchAsActor(h, a, "/api/limited")).status, 200);
  assert.equal((await dispatchAsActor(h, a, "/api/limited")).status, 429, "credential A has its own bucket");
  assert.equal((await dispatchAsActor(h, b, "/api/limited")).status, 200, "credential B does not share it");
  // A plain headerless request keys on "unknown" and is unaffected by A's bucket.
  assert.equal((await h.request("/api/limited")).status, 200);
});

test("L3: /auth/pats/:id (revoke) shares the /auth/pats rate limit", async () => {
  const sid = makeSession(MEMBER);
  let last = 0;
  for (let i = 0; i < 31; i++) {
    last = (await app.request(`/auth/pats/pat_nope${i}`, { method: "DELETE", headers: { ...tunnel(), cookie: sessionCookie(sid) } })).status;
  }
  assert.equal(last, 429);
  assert.equal((await app.request("/auth/pats", { headers: { ...tunnel(), cookie: sessionCookie(sid) } })).status, 429);
});

test("Info: owner/admin WRITE tokens are capped at 90 days; read tokens keep the long cap", async () => {
  const sid = makeSession(OWNER);
  const post = (cookie: string, body: unknown) =>
    app.request("/auth/pats", {
      method: "POST",
      headers: { ...tunnel(), cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post(sessionCookie(sid), { scope: "write", expiresInDays: 91 })).status, 400);
  assert.equal((await post(sessionCookie(sid), { scope: "write", expiresInDays: 90 })).status, 201);
  assert.equal((await post(sessionCookie(sid), { scope: "read", expiresInDays: 365 })).status, 201);
  // A member's write token is not affected by the admin cap.
  grantUser(MEMBER, "tag", "garden", "edit");
  assert.equal((await post(sessionCookie(makeSession(MEMBER)), { scope: "write", expiresInDays: 365 })).status, 201);
});
