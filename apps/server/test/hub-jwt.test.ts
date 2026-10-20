/**
 * auth/hub-jwt.ts — Prism's own validator for hub-issued JWTs (it replaced the
 * AGPL scope-guard library). Real RS256 tokens signed with a throwaway key;
 * keys and the revocation list are injected, so nothing reaches a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createHubJwtVerifier, HubJwtError, type HubJwtVerifierOptions } from "../src/auth/hub-jwt";

const HUB = "https://hub.test";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
const keys = createLocalJWKSet({ keys: [jwk] });

async function token(claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; kid?: string; exp?: string | number } = {}) {
  const jwt = new SignJWT({ scope: "vault:default:read", vault_scope: [], ...claims })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setIssuer((claims.iss as string) ?? HUB)
    .setAudience((claims.aud as string) ?? "vault.default")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h");
  if (claims.jti !== null) jwt.setJti((claims.jti as string) ?? "j1");
  return jwt.sign(opts.key ?? privateKey);
}

function verifier(over: Partial<HubJwtVerifierOptions> = {}) {
  return createHubJwtVerifier({
    hubOrigin: () => HUB,
    jwksOrigin: () => "http://127.0.0.1:1",
    allowedIssuers: () => ["https://alias.hub.test/"],
    keys,
    fetchRevoked: async () => [],
    ...over,
  });
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof HubJwtError && e.code === code);
}

test("a valid token returns its claims with scopes split and the vault pin", async () => {
  const c = await verifier().validate(await token({ scope: "vault:default:read vault:x:write", vault_scope: ["default"] }), {
    expectedAudience: "vault.default",
  });
  assert.deepEqual(c.scopes, ["vault:default:read", "vault:x:write"]);
  assert.deepEqual(c.vaultScope, ["default"]);
  assert.equal(c.jti, "j1");
});

test("issuer: the hub origin and the configured aliases only (trailing slash tolerated)", async () => {
  const v = verifier();
  await v.validate(await token({ iss: "https://alias.hub.test" }), { expectedAudience: "vault.default" });
  await v.validate(await token({ iss: `${HUB}/` }), { expectedAudience: "vault.default" });
  await rejects(v.validate(await token({ iss: "https://evil.test" }), { expectedAudience: "vault.default" }), "issuer");
});

test("audience must be the expected vault", async () => {
  await rejects(verifier().validate(await token({ aud: "vault.other" }), { expectedAudience: "vault.default" }), "audience");
});

test("expired, unsigned-by-hub, unknown key and malformed tokens are refused", async () => {
  const v = verifier();
  const aud = { expectedAudience: "vault.default" };
  await rejects(v.validate(await token({}, { exp: Math.floor(Date.now() / 1000) - 120 }), aud), "expired");
  await rejects(v.validate(await token({}, { key: other.privateKey }), aud), "signature");
  await rejects(v.validate(await token({}, { kid: "nope" }), aud), "signature");
  await rejects(v.validate("not-a-jwt", aud), "shape");
  const [h, p] = (await token()).split(".");
  await rejects(v.validate(`${h}.${p}.`, aud), "signature");
});

test("alg none is refused", async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const none = `${b64({ alg: "none" })}.${b64({ iss: HUB, aud: "vault.default", jti: "j", exp: 9e9 })}.`;
  await assert.rejects(verifier().validate(none, { expectedAudience: "vault.default" }), HubJwtError);
});

test("a token without a jti is refused", async () => {
  await rejects(verifier().validate(await token({ jti: null }), { expectedAudience: "vault.default" }), "shape");
});

test("a malformed vault_scope is refused", async () => {
  await rejects(verifier().validate(await token({ vault_scope: "default" }), { expectedAudience: "vault.default" }), "shape");
});

test("revocation: a listed jti is refused; the list is cached for 60 s", async () => {
  let calls = 0;
  let list = ["gone"];
  let t = 0;
  const v = verifier({ fetchRevoked: async () => (calls++, list), now: () => t });
  const aud = { expectedAudience: "vault.default" };
  await rejects(v.validate(await token({ jti: "gone" }), aud), "revoked");
  await v.validate(await token({ jti: "ok" }), aud);
  assert.equal(calls, 1);
  list = ["ok"];
  t = 59_999;
  await v.validate(await token({ jti: "ok" }), aud); // still the cached list
  t = 60_000;
  await rejects(v.validate(await token({ jti: "ok" }), aud), "revoked");
  assert.equal(calls, 2);
});

test("revocation: an unreachable hub keeps a recent list, then fails closed", async () => {
  let fail = false;
  let t = 0;
  const v = verifier({
    fetchRevoked: async () => {
      if (fail) throw new Error("down");
      return [];
    },
    now: () => t,
  });
  const aud = { expectedAudience: "vault.default" };
  await v.validate(await token(), aud);
  fail = true;
  t = 5 * 60_000;
  await v.validate(await token(), aud); // last good list is under 10 minutes old
  t = 10 * 60_000;
  await rejects(v.validate(await token(), aud), "unavailable");
});
