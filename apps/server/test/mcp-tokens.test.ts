/**
 * Member self-serve MCP tokens (/api/mcp) — the trust boundary is the whole
 * point: a token grants direct whole-vault hub access, so ONLY member+ roles on
 * the TARGET vault may mint; guests, links, and anon never can. The CLI minter/
 * revoker are injected (mcp-token.ts seams), so these tests cover the real
 * route auth + audit-registry behavior without a hub.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mcp } from "../src/routes/mcp";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { addVaultEntry, setMembership, listMcpTokens, getMcpToken } from "../src/db";
import { setTokenMinter, setTokenRevoker, decodeJwtPayload } from "../src/mcp-token";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

/** A structurally valid JWT with the given payload (unsigned — decode only). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

let minted: Array<{ vaultName: string; verb: string; expiresInSeconds: number; sub: string }> = [];
let revoked: string[] = [];
let jtiSeq = 0;

beforeEach(() => {
  resetDb();
  minted = [];
  revoked = [];
  addVaultEntry({ id: "commons", label: "Front Range Commons", url: "http://vault.test", vault: "front-range-commons", token: "t" });
  setTokenMinter(async (opts) => {
    minted.push(opts);
    const jti = `jti-${++jtiSeq}`;
    const exp = Math.floor(Date.now() / 1000) + opts.expiresInSeconds;
    return {
      token: fakeJwt({ jti, exp, scope: `vault:${opts.vaultName}:${opts.verb}` }),
      jti,
      expiresAt: exp * 1000,
      scope: `vault:${opts.vaultName}:${opts.verb}`,
    };
  });
  setTokenRevoker(async (jti) => {
    revoked.push(jti);
  });
});
afterEach(() => {
  setTokenMinter(null);
  setTokenRevoker(null);
});

const postToken = (cookie: string | null, body: Record<string, unknown>, vaultHeader?: string) => {
  const headers: Record<string, string> = { ...J };
  if (cookie) headers.cookie = cookie;
  if (vaultHeader) headers["X-Prism-Vault"] = vaultHeader;
  return mcp.request("/token", { method: "POST", headers, body: JSON.stringify(body) });
};

test("anon and capability actors can never mint", async () => {
  assert.equal((await postToken(null, { vaultId: "commons" })).status, 403);
  assert.equal(minted.length, 0);
});

test("a signed-in user with NO membership on the vault is a guest → 403", async () => {
  const rando = sessionCookie(makeSession("rando@example.com"));
  assert.equal((await postToken(rando, { vaultId: "commons" })).status, 403);
  assert.equal(minted.length, 0);
});

test("a member of vault A cannot mint for vault B (cross-vault gate)", async () => {
  setMembership("primary", "amember@example.com", "member", "test");
  const cookie = sessionCookie(makeSession("amember@example.com"));
  assert.equal((await postToken(cookie, { vaultId: "commons" })).status, 403);
  assert.equal(minted.length, 0);
});

test("a vault member mints a scoped token and gets paste-ready config", async () => {
  setMembership("commons", "cameron@example.com", "owner", "test");
  const cookie = sessionCookie(makeSession("cameron@example.com"));
  const r = await postToken(cookie, { vaultId: "commons", label: "Cameron's agent" });
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    url: string;
    token: string;
    jti: string;
    scope: string;
    mcpJson: { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> };
    claudeCommand: string;
  };
  assert.equal(body.scope, "vault:front-range-commons:write", "defaults to write, scoped to the PARACHUTE vault name");
  assert.ok(body.url.endsWith("/vault/front-range-commons/mcp"));
  assert.equal(decodeJwtPayload(body.token).jti, body.jti);
  const server = body.mcpJson.mcpServers["parachute-front-range-commons"]!;
  assert.equal(server.url, body.url);
  assert.equal(server.headers.Authorization, `Bearer ${body.token}`);
  assert.ok(body.claudeCommand.includes(body.url));

  // Minter got the right shape: 90d default, self-describing sub.
  assert.deepEqual(minted, [{ vaultName: "front-range-commons", verb: "write", expiresInSeconds: 90 * 86_400, sub: "mcp:cameron@example.com" }]);

  // Audit row exists and NEVER stores the token itself.
  const rows = listMcpTokens("commons");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.email, "cameron@example.com");
  assert.equal(rows[0]!.label, "Cameron's agent");
  assert.ok(!JSON.stringify(rows[0]).includes(body.token.slice(0, 25)), "token material is not persisted");
});

test("scope/expiry validation: read scope honored; bad scope and bad days rejected", async () => {
  setMembership("commons", "m@example.com", "member", "test");
  const cookie = sessionCookie(makeSession("m@example.com"));
  const read = await postToken(cookie, { vaultId: "commons", scope: "read", expiresInDays: 7 });
  assert.equal(read.status, 200);
  assert.equal(minted[0]!.verb, "read");
  assert.equal(minted[0]!.expiresInSeconds, 7 * 86_400);
  assert.equal((await postToken(cookie, { vaultId: "commons", scope: "admin" })).status, 400);
  assert.equal((await postToken(cookie, { vaultId: "commons", expiresInDays: 0 })).status, 400);
  assert.equal((await postToken(cookie, { vaultId: "commons", expiresInDays: 9999 })).status, 400);
});

test("unknown vault id 400s strictly — it must NOT fall back to primary", async () => {
  const cookie = ownerCookie();
  assert.equal((await postToken(cookie, { vaultId: "ghost" })).status, 400);
  assert.equal(minted.length, 0, "no token minted against the fallback vault");
});

test("the server owner can mint for any vault; default vault comes from the header", async () => {
  const cookie = ownerCookie();
  const r = await postToken(cookie, {}, "commons");
  assert.equal(r.status, 200);
  assert.equal(minted[0]!.vaultName, "front-range-commons", "X-Prism-Vault selected the target");
});

test("GET /tokens: members see their own; admins see everyone's", async () => {
  setMembership("commons", "a@example.com", "member", "test");
  setMembership("commons", "b@example.com", "admin", "test");
  const aCookie = sessionCookie(makeSession("a@example.com"));
  const bCookie = sessionCookie(makeSession("b@example.com"));
  await postToken(aCookie, { vaultId: "commons" });
  await postToken(bCookie, { vaultId: "commons" });

  const aList = (await (await mcp.request("/tokens?vaultId=commons", { headers: { cookie: aCookie } })).json()) as Array<{ email: string; token?: string }>;
  assert.deepEqual(aList.map((t) => t.email), ["a@example.com"], "member sees only their own");
  assert.ok(aList.every((t) => !("token" in t)), "listing never exposes token material");

  const bList = (await (await mcp.request("/tokens?vaultId=commons", { headers: { cookie: bCookie } })).json()) as Array<{ email: string }>;
  assert.equal(bList.length, 2, "admin sees all");
});

test("revoke: the minter or an admin may; another member may not; hub revoker is called", async () => {
  setMembership("commons", "a@example.com", "member", "test");
  setMembership("commons", "c@example.com", "member", "test");
  const aCookie = sessionCookie(makeSession("a@example.com"));
  const { jti } = (await (await postToken(aCookie, { vaultId: "commons" })).json()) as { jti: string };

  const cCookie = sessionCookie(makeSession("c@example.com"));
  assert.equal((await mcp.request(`/tokens/${jti}`, { method: "DELETE", headers: { cookie: cCookie } })).status, 403, "another member cannot revoke");
  assert.deepEqual(revoked, []);

  assert.equal((await mcp.request(`/tokens/${jti}`, { method: "DELETE", headers: { cookie: aCookie } })).status, 200, "the minter can revoke");
  assert.deepEqual(revoked, [jti]);
  assert.ok(getMcpToken(jti)!.revoked_at, "audit row marked revoked");

  assert.equal((await mcp.request("/tokens/nope", { method: "DELETE", headers: { cookie: aCookie } })).status, 404);
});

test("a failed hub revoke does NOT mark the row revoked (fail closed on the audit)", async () => {
  setMembership("commons", "a@example.com", "member", "test");
  const aCookie = sessionCookie(makeSession("a@example.com"));
  const { jti } = (await (await postToken(aCookie, { vaultId: "commons" })).json()) as { jti: string };
  setTokenRevoker(async () => {
    throw new Error("hub down");
  });
  assert.equal((await mcp.request(`/tokens/${jti}`, { method: "DELETE", headers: { cookie: aCookie } })).status, 502);
  assert.equal(getMcpToken(jti)!.revoked_at, null, "not falsely marked revoked while the hub still honors it");
});

test("GET /api/mcp info reports the URL and mintability", async () => {
  setMembership("commons", "m@example.com", "member", "test");
  const cookie = sessionCookie(makeSession("m@example.com"));
  const info = (await (await mcp.request("/", { headers: { cookie, "X-Prism-Vault": "commons" } })).json()) as {
    vaultId: string; url: string; canMint: boolean;
  };
  assert.equal(info.vaultId, "commons");
  assert.ok(info.url.endsWith("/vault/front-range-commons/mcp"));
  assert.equal(info.canMint, true);

  const anon = (await (await mcp.request("/", {})).json()) as { canMint: boolean };
  assert.equal(anon.canMint, false);
});
