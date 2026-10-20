/**
 * The single-use claim of a device code (/auth/device/token) or an approved pairing
 * (/auth/pair/token) and the device it mints are ONE SQLite transaction, and the claim writes
 * the device id in the same statement that marks the grant used (launch security follow-up).
 * So at no point does a grant read "used" without naming its device — the moment in which a
 * replay used to find nothing to revoke — and a failure after the mint leaves no device.
 *
 * `setAfterMintHookForTests` runs inside that transaction, after the device row is written and
 * before the claim: it inspects the state a concurrent replay would see, or simulates a crash.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, getDeviceAuthCode, insertDeviceAuthCode, listLiveDeviceTokens } from "../src/db";
import { setAfterMintHookForTests } from "../src/auth/device";
import { setPairingClock } from "../src/auth/pairing";
import { clearRateLimitsForTests } from "../src/middleware/ratelimit";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const REDIRECT = "prism://auth/callback";
const ORIGIN = "https://prism.tail1234.ts.net";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let ip: string;
let savedOrigin: string;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  savedOrigin = config.appOrigin;
  (config as { appOrigin: string }).appOrigin = ORIGIN;
  setPairingClock(() => 1_900_000_000_000);
  clearRateLimitsForTests("pair-");
  clearRateLimitsForTests("auth-device-token");
});
afterEach(() => {
  setAfterMintHookForTests(null);
  setPairingClock(null);
  (config as { appOrigin: string }).appOrigin = savedOrigin;
  fv.restore();
});

const tunnel = () => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
const liveDevices = () => listLiveDeviceTokens(OWNER).length;

// ── /auth/device/token ───────────────────────────────────────────────────────

function deviceCode() {
  const code = randomBytes(32).toString("base64url");
  const p = pkce();
  const t = Date.now();
  insertDeviceAuthCode({ code_hash: sha(code), email: OWNER, client_id: "prism-native", code_challenge: p.challenge, redirect_uri: REDIRECT, label: "Phone", created_at: t, expires_at: t + 5 * 60_000 });
  return { code, ...p };
}
const exchange = (code: string, verifier: string) =>
  app.request("/auth/device/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...tunnel() },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: "prism-native", redirect_uri: REDIRECT, code, code_verifier: verifier }).toString(),
  });

test("device code: inside the mint the code is never 'used' without its device; afterwards it names it", async () => {
  const c = deviceCode();
  const seen: Array<{ used: boolean; device: string | null; devices: number }> = [];
  setAfterMintHookForTests(() => {
    const row = getDeviceAuthCode(sha(c.code))!;
    seen.push({ used: row.used_at !== null, device: row.device_id, devices: liveDevices() });
  });
  const r = await exchange(c.code, c.verifier);
  assert.equal(r.status, 200);
  const j = (await r.json()) as { access_token: string; device_id: string };
  // The state a replay would read in the middle of the mint: the code is still unused (so a
  // replay could not be told "used" with no device to revoke).
  assert.deepEqual(seen, [{ used: false, device: null, devices: 1 }]);
  const row = getDeviceAuthCode(sha(c.code))!;
  assert.ok(row.used_at !== null);
  assert.equal(row.device_id, j.device_id, "the claim recorded the device it minted");
  // And the replay revokes it.
  setAfterMintHookForTests(null);
  assert.equal((await exchange(c.code, c.verifier)).status, 400);
  assert.equal((await app.request("/auth/me", { headers: { authorization: `Bearer ${j.access_token}`, ...tunnel() } })).status, 401);
});

test("device code: a failure after the mint rolls the device back and leaves the code unused", async () => {
  const c = deviceCode();
  setAfterMintHookForTests(() => {
    throw new Error("simulated crash between mint and claim");
  });
  const r = await exchange(c.code, c.verifier);
  assert.equal(r.status, 500);
  assert.equal(liveDevices(), 0, "no device survived the failed exchange");
  assert.equal(getDeviceAuthCode(sha(c.code))!.used_at, null);
  setAfterMintHookForTests(null);
  const ok = await exchange(c.code, c.verifier);
  assert.equal(ok.status, 200);
  assert.equal(liveDevices(), 1);
});

test("device code: a wrong verifier still burns the code, mints nothing", async () => {
  const c = deviceCode();
  let minted = 0;
  setAfterMintHookForTests(() => void minted++);
  assert.equal((await exchange(c.code, pkce().verifier)).status, 400);
  assert.equal(minted, 0);
  assert.ok(getDeviceAuthCode(sha(c.code))!.used_at !== null, "burned");
  assert.equal((await exchange(c.code, c.verifier)).status, 400, "no retry with the right verifier");
  assert.equal(liveDevices(), 0);
});

// ── /auth/pair/token ─────────────────────────────────────────────────────────

const J = { "content-type": "application/json" };
async function approvedPairing() {
  const cookie = sessionCookie(makeSession(OWNER));
  const s = (await (await app.request("/auth/pair/start", { method: "POST", headers: { ...J, cookie, ...tunnel() }, body: "{}" })).json()) as { pairingId: string; link: string };
  const code = new URL(s.link).searchParams.get("c")!;
  const p = pkce();
  const cl = (await (await app.request("/auth/pair/claim", { method: "POST", headers: { ...J, ...tunnel() }, body: JSON.stringify({ code, code_challenge: p.challenge, label: "Phone", platform: "ios" }) })).json()) as { claimId: string; checkCode: string };
  const ok = await app.request(`/auth/pair/${s.pairingId}/approve`, { method: "POST", headers: { ...J, cookie, ...tunnel() }, body: JSON.stringify({ checkCode: cl.checkCode }) });
  assert.equal(ok.status, 200);
  return { pairingId: s.pairingId, claimId: cl.claimId, verifier: p.verifier };
}
const pairToken = (claimId: string, verifier: string) =>
  app.request("/auth/pair/token", { method: "POST", headers: { ...J, ...tunnel() }, body: JSON.stringify({ claim_id: claimId, code_verifier: verifier }) });
const pairingRow = (id: string) => db.prepare("SELECT status, device_id FROM device_pairings WHERE id = ?").get(id) as { status: string; device_id: string | null };

test("pairing: inside the mint the pairing is never 'completed' without its device; afterwards it names it", async () => {
  const p = await approvedPairing();
  const seen: Array<{ status: string; device: string | null }> = [];
  setAfterMintHookForTests(() => {
    const r = pairingRow(p.pairingId);
    seen.push({ status: r.status, device: r.device_id });
  });
  const t = await pairToken(p.claimId, p.verifier);
  assert.equal(t.status, 200);
  const j = (await t.json()) as { access_token: string; device_id: string };
  assert.deepEqual(seen, [{ status: "approved", device: null }]);
  assert.deepEqual(pairingRow(p.pairingId), { status: "completed", device_id: j.device_id });
  setAfterMintHookForTests(null);
  assert.equal((await pairToken(p.claimId, p.verifier)).status, 400);
  assert.equal((await app.request("/auth/me", { headers: { authorization: `Bearer ${j.access_token}`, ...tunnel() } })).status, 401, "the replay revoked it");
});

test("pairing: a failure after the mint rolls the device back and leaves the pairing approved", async () => {
  const p = await approvedPairing();
  setAfterMintHookForTests(() => {
    throw new Error("simulated crash between mint and claim");
  });
  assert.equal((await pairToken(p.claimId, p.verifier)).status, 500);
  assert.equal(liveDevices(), 0);
  assert.deepEqual(pairingRow(p.pairingId), { status: "approved", device_id: null });
  setAfterMintHookForTests(null);
  assert.equal((await pairToken(p.claimId, p.verifier)).status, 200);
  assert.equal(liveDevices(), 1);
});
