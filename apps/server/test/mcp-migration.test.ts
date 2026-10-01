/**
 * WP6.5 — migrating members to Prism MCP:
 *  - "Connect your agent": PAT mint → rendered client config → tools/list with that PAT;
 *    a member sees through /mcp exactly their Prism-visible notes (tag grant only,
 *    private notes hidden);
 *  - owner-only admin surface for LEGACY whole-vault member tokens: list, dry-run
 *    (default; revokes nothing), revoke-all + notify (injected revoker + sender),
 *    idempotency, partial failure, audit rows, non-owner → 403.
 * No hub, no mail: revoker and notifier are injected.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { addGrant, addVaultEntry, ensureUser, recordMcpToken, listMcpTokens, listMcpTokenRevocations, setMembership } from "../src/db";
import { setTokenRevoker } from "../src/mcp-token";
import { setLegacyTokenNotifier } from "../src/routes/mcp";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const OWNER = config.ownerEmail;
const MEMBER = "member@test.local";
const ADMIN = "admin@test.local";
const OTHER = "other@test.local";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let ip: string;
let revoked: string[];
let failJtis: Set<string>;
let sent: Array<{ to: string; subject: string; html: string }>;

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  for (const e of [MEMBER, ADMIN, OTHER]) ensureUser(e);
  revoked = [];
  failJtis = new Set();
  sent = [];
  setTokenRevoker(async (jti) => {
    if (failJtis.has(jti)) throw new Error("hub down");
    revoked.push(jti);
  });
  setLegacyTokenNotifier(async (to, subject, html) => {
    sent.push({ to, subject, html });
    return true;
  });
});
afterEach(() => {
  fv.restore();
  setTokenRevoker(null);
  setLegacyTokenNotifier(null);
});

const tunnel = () => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip });
const J = { "content-type": "application/json" };
const cookie = (email: string) => ({ cookie: sessionCookie(makeSession(email)) });

async function connect(token: string): Promise<Client> {
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    for (const [k, v] of Object.entries({ ...tunnel(), authorization: `Bearer ${token}` })) h.set(k, v);
    const body = req.method === "POST" ? await req.text() : undefined;
    const u = new URL(req.url);
    return app.request(u.pathname + u.search, { method: req.method, headers: h, body });
  };
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  return client;
}

// ── Connect your agent ──────────────────────────────────────────────────────

test("mint a PAT, render config, and tools/list with it (what 'Test connection' does)", async () => {
  addGrant({ subject_type: "user", subject: MEMBER, resource_type: "tag", resource: "garden", level: "view", caps: ["view"] as never, created_by: "test", vault_id: "primary" });
  fv.tags = [{ name: "garden", count: 2 }];
  fv.put({ id: "g1", tags: ["garden"], path: "garden/a", content: "hello garden" });
  fv.put({ id: "g2", tags: ["garden"], path: "garden/b", content: "second" });
  fv.put({ id: "s1", tags: ["secret"], content: "hidden" });
  fv.put({ id: "p1", tags: ["garden"], content: "private", metadata: { prism_creator: OTHER, prism_visibility: "private" } });

  const r = await app.request("/auth/pats", { method: "POST", headers: { ...tunnel(), ...cookie(MEMBER), ...J }, body: JSON.stringify({ label: "connect", scope: "read", expiresInDays: 30 }) });
  assert.equal(r.status, 201);
  const j = (await r.json()) as any;
  assert.equal(j.claudeCodeCommand, `claude mcp add --transport http prism ${j.url} --header "Authorization: Bearer ${j.token}"`);
  assert.equal(j.mcpJson.mcpServers.prism.url, j.url);
  assert.deepEqual(j.claudeDesktopJson.mcpServers.prism.args.slice(0, 3), ["-y", "mcp-remote", j.url]);

  // tools/list with the new PAT (modern raw request, as the browser button sends).
  const raw = await app.request("/mcp", {
    method: "POST",
    headers: { ...tunnel(), authorization: `Bearer ${j.token}`, ...J, accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
  });
  assert.equal(raw.status, 200);
  const text = await raw.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text);
  assert.ok(body.result.tools.length >= 1);

  // The member sees exactly their Prism-visible notes: garden yes, secret no, someone else's private no.
  const cl = await connect(j.token);
  const q = (await cl.callTool({ name: "prism_query_notes", arguments: {} })).structuredContent as any;
  assert.deepEqual(q.notes.map((n: any) => n.id).sort(), ["g1", "g2"]);
});

// ── Legacy whole-vault tokens ───────────────────────────────────────────────

function seedLegacy() {
  addVaultEntry({ id: "commons", label: "Commons", url: "http://vault.test", vault: "commons-v", token: "t" });
  recordMcpToken({ jti: "j1", vault_id: "primary", email: MEMBER, scope: "vault:default:write", label: null, expires_at: Date.now() + 86_400_000 });
  recordMcpToken({ jti: "j2", vault_id: "commons", email: MEMBER, scope: "vault:commons-v:read", label: null, expires_at: Date.now() + 86_400_000 });
  recordMcpToken({ jti: "j3", vault_id: "primary", email: OTHER, scope: "vault:default:write", label: null, expires_at: Date.now() + 86_400_000 });
  recordMcpToken({ jti: "old", vault_id: "primary", email: OTHER, scope: "vault:default:write", label: null, expires_at: Date.now() - 1000 }); // expired: not "active"
}
const post = (who: string, body: unknown, ct = true) =>
  app.request("/api/mcp/legacy-tokens/revoke", { method: "POST", headers: { ...tunnel(), ...cookie(who), ...(ct ? J : {}) }, body: JSON.stringify(body) });
const listActive = async () => ((await (await app.request("/api/mcp/legacy-tokens", { headers: { ...tunnel(), ...cookie(OWNER) } })).json()) as any).tokens as any[];

test("non-owner (admin, member, anon) gets 403 on list and revoke; nothing happens", async () => {
  seedLegacy();
  setMembership("primary", ADMIN, "admin", "test");
  for (const who of [ADMIN, MEMBER]) {
    assert.equal((await app.request("/api/mcp/legacy-tokens", { headers: { ...tunnel(), ...cookie(who) } })).status, 403);
    assert.equal((await post(who, { dryRun: false })).status, 403);
  }
  assert.equal((await app.request("/api/mcp/legacy-tokens", { headers: tunnel() })).status, 403);
  assert.deepEqual(revoked, []);
  assert.equal(sent.length, 0);
});

test("list shows active tokens (who/vault/created/expires) and never token material", async () => {
  seedLegacy();
  const tokens = await listActive();
  assert.deepEqual(tokens.map((t) => t.jti).sort(), ["j1", "j2", "j3"]);
  assert.equal(tokens.find((t) => t.jti === "j2").vaultLabel, "Commons");
  assert.ok(tokens.every((t) => t.email && t.createdAt && t.expiresAt && !("token" in t)));
});

test("dry run is the default: lists who would be affected, revokes and emails nothing", async () => {
  seedLegacy();
  for (const body of [{}, { notify: true }, { dryRun: true, notify: true }]) {
    const r = await post(OWNER, body);
    assert.equal(r.status, 200);
    const j = (await r.json()) as any;
    assert.equal(j.dryRun, true);
    assert.equal(j.wouldRevoke, 3);
    assert.deepEqual(j.affected.map((a: any) => a.email).sort(), [MEMBER, OTHER]);
  }
  assert.deepEqual(revoked, []);
  assert.equal(sent.length, 0);
  assert.equal(listMcpTokens("primary").filter((t) => t.revoked_at).length, 0);
  assert.equal(listMcpTokenRevocations().length, 0);
});

test("revoke all + notify: injected revoker per token, ONE email per member, audited; repeat is a no-op", async () => {
  seedLegacy();
  const r = await post(OWNER, { dryRun: false, notify: true });
  assert.equal(r.status, 200);
  const j = (await r.json()) as any;
  assert.deepEqual(j.revoked.sort(), ["j1", "j2", "j3"]);
  assert.deepEqual(revoked.sort(), ["j1", "j2", "j3"]);
  assert.deepEqual(j.notified.sort(), [MEMBER, OTHER]);
  assert.equal(sent.length, 2, "one mail per member, not per token");
  const toMember = sent.find((m) => m.to === MEMBER)!;
  assert.match(toMember.html, /Connect your agent/);
  assert.match(toMember.html, /Commons/);
  assert.ok(!/j1|j2/.test(toMember.html), "no token ids in mail");

  const audit = listMcpTokenRevocations();
  assert.equal(audit.length, 3);
  assert.ok(audit.every((a) => a.actor === OWNER && a.outcome === "revoked" && a.notified === 1));
  assert.deepEqual(await listActive(), []);

  const again = (await (await post(OWNER, { dryRun: false, notify: true })).json()) as any;
  assert.deepEqual(again.revoked, []);
  assert.equal(sent.length, 2);
  assert.equal(revoked.length, 3);
});

test("a failed hub revoke stays active (retryable), is audited, and does not notify that member", async () => {
  seedLegacy();
  failJtis.add("j3");
  const j = (await (await post(OWNER, { dryRun: false, notify: true })).json()) as any;
  assert.deepEqual(j.revoked.sort(), ["j1", "j2"]);
  assert.equal(j.failed[0].jti, "j3");
  assert.deepEqual(j.notified, [MEMBER]);
  assert.deepEqual(sent.map((m) => m.to), [MEMBER]);
  assert.deepEqual((await listActive()).map((t) => t.jti), ["j3"]);
  assert.ok(listMcpTokenRevocations().some((a) => a.jti === "j3" && a.outcome === "failed"));
  failJtis.clear();
  const retry = (await (await post(OWNER, { dryRun: false, notify: true })).json()) as any;
  assert.deepEqual(retry.revoked, ["j3"]);
  assert.deepEqual(sent.map((m) => m.to), [MEMBER, OTHER]);
});

test("revoke one token by jti without notifying; mail failure never undoes a revoke; JSON-only", async () => {
  seedLegacy();
  const one = (await (await post(OWNER, { dryRun: false, jtis: ["j1"] })).json()) as any;
  assert.deepEqual(one.revoked, ["j1"]);
  assert.equal(sent.length, 0);
  setLegacyTokenNotifier(async () => {
    throw new Error("smtp down");
  });
  const all = (await (await post(OWNER, { dryRun: false, notify: true })).json()) as any;
  assert.deepEqual(all.revoked.sort(), ["j2", "j3"]);
  assert.deepEqual(all.notifyFailed.sort(), [MEMBER, OTHER]);
  assert.equal((await post(OWNER, { dryRun: false }, false)).status, 415);
  assert.equal((await post(OWNER, { jtis: "j1" })).status, 400);
});
