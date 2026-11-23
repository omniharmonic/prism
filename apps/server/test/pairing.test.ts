/**
 * QR pairing (D-G): start on the Mac → claim on the phone → approve on the Mac with the
 * phone's check code → the phone redeems a normal `pd_` device token. Full stack through
 * createApp(). Time is moved with `setPairingClock`, never waited for.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db } from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { PAIR_TTL_MS, setPairingClock } from "../src/auth/pairing";
import { clearRateLimitsForTests } from "../src/middleware/ratelimit";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const ORIGIN = "https://prism.tail1234.ts.net";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let ip: string;
let savedOrigin: string;
let now: number;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  savedOrigin = config.appOrigin;
  (config as { appOrigin: string }).appOrigin = ORIGIN;
  now = 1_900_000_000_000;
  setPairingClock(() => now);
  clearRateLimitsForTests("pair-");
});
afterEach(() => {
  fv.restore();
  (config as { appOrigin: string }).appOrigin = savedOrigin;
  setPairingClock(null);
});

const tunnel = () => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip });
const J = { "content-type": "application/json" };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

type Who = { cookie: string } | { bearer: string };
const owner = (): Who => ({ cookie: sessionCookie(makeSession(OWNER)) });
const auth = (w: Who): Record<string, string> => ("cookie" in w ? { cookie: w.cookie } : { authorization: `Bearer ${w.bearer}` });

async function start(w: Who, headers: Record<string, string> = {}) {
  return app.request("/auth/pair/start", { method: "POST", headers: { ...J, ...auth(w), ...tunnel(), ...headers }, body: "{}" });
}
async function started(w: Who = owner()) {
  const r = await start(w);
  assert.equal(r.status, 200);
  const j = (await r.json()) as { pairingId: string; link: string; origin: string; expiresAt: number };
  const u = new URL(j.link);
  return { ...j, code: u.searchParams.get("c")!, url: u };
}
async function claim(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request("/auth/pair/claim", { method: "POST", headers: { ...J, ...tunnel(), ...headers }, body: JSON.stringify(body) });
}
async function claimed(code: string, label = "Sam's iPhone") {
  const p = pkce();
  const r = await claim({ code, code_challenge: p.challenge, label, platform: "ios" });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { claimId: string; checkCode: string; interval: number };
  return { ...p, ...j };
}
async function status(w: Who, id: string) {
  return app.request(`/auth/pair/${id}`, { headers: { ...auth(w), ...tunnel() } });
}
async function decide(w: Who, id: string, decision: "approve" | "deny", body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.request(`/auth/pair/${id}/${decision}`, { method: "POST", headers: { ...J, ...auth(w), ...tunnel(), ...headers }, body: JSON.stringify(body) });
}
async function token(claimId: string, verifier: string) {
  return app.request("/auth/pair/token", { method: "POST", headers: { ...J, ...tunnel() }, body: JSON.stringify({ claim_id: claimId, code_verifier: verifier }) });
}
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;

test("the whole pairing: QR link → claim → approve with the check code → a normal device token", async () => {
  const w = owner();
  const s = await started(w);
  // The QR carries the reachable origin and a one-time code — nothing else.
  assert.equal(s.url.protocol, "prism:");
  assert.equal(s.url.host, "pair");
  assert.deepEqual([...s.url.searchParams.keys()].sort(), ["c", "s", "v"]);
  assert.equal(s.url.searchParams.get("s"), ORIGIN);
  assert.equal(s.url.searchParams.get("v"), "1");
  assert.match(s.code, /^[A-Za-z0-9_-]{22}$/);
  // Only the hash of the code is stored.
  const stored = db.prepare("SELECT * FROM device_pairings WHERE id = ?").get(s.pairingId) as Record<string, unknown>;
  assert.ok(!JSON.stringify(stored).includes(s.code));

  const before = (await (await status(w, s.pairingId)).json()) as { status: string; label?: string };
  assert.equal(before.status, "pending");
  assert.equal(before.label, undefined);

  const phone = await claimed(s.code);
  assert.match(phone.checkCode, /^\d{4}$/);
  assert.equal(phone.interval, 2);
  const after = (await (await status(w, s.pairingId)).json()) as { status: string; label: string; platform: string };
  assert.deepEqual([after.status, after.label, after.platform], ["claimed", "Sam's iPhone", "ios"]);
  assert.ok(!JSON.stringify(after).includes(phone.checkCode), "the Mac is never told the check code");
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM device_pairings").all()).includes(phone.claimId), "the claim id is stored hashed");

  // The phone polls before the decision.
  assert.equal(await errorOf(await token(phone.claimId, phone.verifier)), "authorization_pending");
  const ok = await decide(w, s.pairingId, "approve", { checkCode: phone.checkCode });
  assert.equal(ok.status, 200);

  const t = await token(phone.claimId, phone.verifier);
  assert.equal(t.status, 200);
  assert.equal(t.headers.get("cache-control"), "no-store");
  const j = (await t.json()) as { access_token: string; token_type: string; device_id: string; expires_in: number };
  assert.match(j.access_token, /^pd_/);
  assert.equal(j.token_type, "Bearer");
  assert.ok(j.expires_in > 0);

  // It is an ordinary device: in Signed-in devices, usable, revocable.
  const me = await app.request("/auth/me", { headers: { authorization: `Bearer ${j.access_token}`, ...tunnel() } });
  assert.equal(me.status, 200);
  const list = (await (await app.request("/auth/devices", { headers: { authorization: `Bearer ${j.access_token}`, ...tunnel() } })).json()) as {
    devices: Array<{ id: string; label: string; clientId: string; current: boolean }>;
  };
  assert.deepEqual(list.devices.map((d) => [d.id, d.label, d.clientId, d.current]), [[j.device_id, "Sam's iPhone", "prism-native", true]]);
  const del = await app.request(`/auth/devices/${j.device_id}`, { method: "DELETE", headers: { authorization: `Bearer ${j.access_token}`, ...tunnel() } });
  assert.equal(del.status, 200);
  assert.equal((await app.request("/auth/me", { headers: { authorization: `Bearer ${j.access_token}`, ...tunnel() } })).status, 401);
  assert.equal(((await (await status(w, s.pairingId)).json()) as { status: string }).status, "completed");

  // Audited with ids only.
  const rows = db.prepare("SELECT action, target, status FROM action_audit WHERE action LIKE 'auth.pair.%' ORDER BY id").all() as Array<{ action: string; target: string; status: string }>;
  assert.deepEqual(rows.map((r) => r.action), ["auth.pair.start", "auth.pair.claim", "auth.pair.approve", "auth.pair.token"]);
  for (const r of rows) for (const secret of [s.code, phone.claimId, phone.verifier, phone.challenge, phone.checkCode, j.access_token]) assert.ok(!r.target.includes(secret));
});

test("the token step is single use: a replay revokes the device it issued", async () => {
  const w = owner();
  const s = await started(w);
  const phone = await claimed(s.code);
  await decide(w, s.pairingId, "approve", { checkCode: phone.checkCode });
  const j = (await (await token(phone.claimId, phone.verifier)).json()) as { access_token: string };
  const again = await token(phone.claimId, phone.verifier);
  assert.equal(again.status, 400);
  assert.equal(await errorOf(again), "invalid_grant");
  assert.equal((await app.request("/auth/me", { headers: { authorization: `Bearer ${j.access_token}`, ...tunnel() } })).status, 401, "the replayed pairing's device is dead");
});

test("a code is bound to one claim: a second claim voids the pairing for both", async () => {
  const w = owner();
  const s = await started(w);
  const first = await claimed(s.code, "Attacker phone");
  const p2 = pkce();
  const second = await claim({ code: s.code, code_challenge: p2.challenge, label: "My iPhone", platform: "ios" });
  assert.equal(second.status, 409);
  assert.equal(await errorOf(second), "already_used");
  assert.equal(((await (await status(w, s.pairingId)).json()) as { status: string }).status, "contested");
  // Nothing can be approved or redeemed any more.
  assert.equal(await errorOf(await decide(w, s.pairingId, "approve", { checkCode: first.checkCode })), "not_claimed");
  assert.equal(await errorOf(await token(first.claimId, first.verifier)), "access_denied");
});

test("approving needs the code the phone shows; three wrong tries end the pairing", async () => {
  const w = owner();
  const s = await started(w);
  const phone = await claimed(s.code);
  const wrong = phone.checkCode === "0000" ? "1111" : "0000";
  for (const left of [2, 1]) {
    const r = await decide(w, s.pairingId, "approve", { checkCode: wrong });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "wrong_check_code", triesLeft: left });
  }
  assert.equal(await errorOf(await decide(w, s.pairingId, "approve", {})), "too_many_tries");
  assert.equal(await errorOf(await decide(w, s.pairingId, "approve", { checkCode: phone.checkCode })), "not_claimed");
  assert.equal(await errorOf(await token(phone.claimId, phone.verifier)), "access_denied");
});

test("denial and a wrong verifier both end the pairing", async () => {
  const w = owner();
  const a = await started(w);
  const pa = await claimed(a.code);
  assert.equal((await decide(w, a.pairingId, "deny")).status, 200);
  assert.equal(await errorOf(await token(pa.claimId, pa.verifier)), "access_denied");
  assert.equal(((await (await status(w, a.pairingId)).json()) as { status: string }).status, "denied");

  const b = await started(w);
  const pb = await claimed(b.code);
  await decide(w, b.pairingId, "approve", { checkCode: pb.checkCode });
  // The claim id alone is not enough, and one wrong verifier is the end.
  assert.equal(await errorOf(await token(pb.claimId, pkce().verifier)), "invalid_grant");
  assert.equal(await errorOf(await token(pb.claimId, pb.verifier)), "access_denied");
  assert.equal(await errorOf(await token(randomBytes(32).toString("base64url"), pb.verifier)), "invalid_grant");
});

test("five minutes: an unclaimed code, an undecided claim and an approved, unredeemed pairing all expire", async () => {
  const w = owner();
  const a = await started(w);
  now += PAIR_TTL_MS - 1;
  const pa = await claimed(a.code); // the last millisecond still claims
  now += 1;
  assert.equal(((await (await status(w, a.pairingId)).json()) as { status: string }).status, "expired");
  assert.equal(await errorOf(await decide(w, a.pairingId, "approve", { checkCode: pa.checkCode })), "expired");
  assert.equal(await errorOf(await token(pa.claimId, pa.verifier)), "expired_token");

  const b = await started(w);
  now += PAIR_TTL_MS;
  const late = await claim({ code: b.code, code_challenge: pkce().challenge, label: "x", platform: "ios" });
  assert.equal(await errorOf(late), "expired");

  const c = await started(w);
  const pc = await claimed(c.code);
  await decide(w, c.pairingId, "approve", { checkCode: pc.checkCode });
  now += PAIR_TTL_MS;
  assert.equal(await errorOf(await token(pc.claimId, pc.verifier)), "expired_token");
});

test("starting a new pairing ends the earlier open one", async () => {
  const w = owner();
  const a = await started(w);
  const pa = await claimed(a.code);
  await started(w);
  assert.equal(((await (await status(w, a.pairingId)).json()) as { status: string }).status, "replaced");
  assert.equal(await errorOf(await token(pa.claimId, pa.verifier)), "access_denied");
});

test("only the server owner, as a person, starts, sees and decides a pairing", async () => {
  const s = await started();
  const phone = await claimed(s.code);
  // A member (session or device), anon, and the owner's loopback token are refused.
  const member: Who = { cookie: sessionCookie(makeSession(MEMBER)) };
  const memberDevice: Who = { bearer: issueDeviceToken(MEMBER, "m", "prism-native").token };
  for (const w of [member, memberDevice, { bearer: config.collabToken }, { bearer: "pd_nope" }] as Who[]) {
    assert.equal((await start(w)).status, 403);
    assert.equal((await status(w, s.pairingId)).status, 403);
    assert.equal((await decide(w, s.pairingId, "approve", { checkCode: phone.checkCode })).status, 403);
    assert.equal((await decide(w, s.pairingId, "deny")).status, 403);
  }
  assert.equal((await app.request("/auth/pair/start", { method: "POST", headers: { ...J, ...tunnel() }, body: "{}" })).status, 403);
  // Still claimed: nothing above touched it.
  assert.equal(((await (await status(owner(), s.pairingId)).json()) as { status: string }).status, "claimed");
  // An unknown pairing id is a plain 404.
  assert.equal((await status(owner(), "pair_nope")).status, 404);
});

test("owner writes pass the CSRF guard", async () => {
  const w = owner();
  assert.equal((await app.request("/auth/pair/start", { method: "POST", headers: { "content-type": "text/plain", ...auth(w), ...tunnel() }, body: "{}" })).status, 415);
  assert.equal((await start(w, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await start(w, { origin: "https://evil.example" })).status, 403);
  assert.equal((await start(w, { origin: ORIGIN, "sec-fetch-site": "same-origin" })).status, 200);
  const s = await started(w);
  const phone = await claimed(s.code);
  assert.equal((await decide(w, s.pairingId, "approve", { checkCode: phone.checkCode }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await decide(w, s.pairingId, "deny", {}, { "sec-fetch-site": "same-site" })).status, 403);
  assert.equal(((await (await status(w, s.pairingId)).json()) as { status: string }).status, "claimed");
});

test("a server only this computer can reach refuses to make a QR", async () => {
  for (const o of ["http://localhost:8787", "https://127.0.0.1:8787", "https://prism.example.com", "https://prism.example.test", "http://prism.tail1234.ts.net"]) {
    (config as { appOrigin: string }).appOrigin = o;
    const r = await start(owner());
    assert.equal(r.status, 409, o);
    assert.equal(await errorOf(r), "not_reachable");
  }
});

test("one door: once the owner has a device, only an existing device approves a new one", async () => {
  const mac = issueDeviceToken(OWNER, "Mac", "prism-native");
  const w = owner();
  const s = await started(w);
  const startBody = (await (await status(w, s.pairingId)).json()) as { approveNeedsDevice: boolean };
  assert.equal(startBody.approveNeedsDevice, true);
  const phone = await claimed(s.code);
  const refused = await decide(w, s.pairingId, "approve", { checkCode: phone.checkCode });
  assert.equal(refused.status, 403);
  assert.equal(await errorOf(refused), "device_required");
  // A session may still deny.
  // The Mac's own device approves (no CSRF origin checks for a bearer device token).
  const dev: Who = { bearer: mac.token };
  assert.equal(((await (await status(dev, s.pairingId)).json()) as { approveNeedsDevice: boolean }).approveNeedsDevice, false);
  assert.equal((await decide(dev, s.pairingId, "approve", { checkCode: phone.checkCode })).status, 200);
  assert.equal((await token(phone.claimId, phone.verifier)).status, 200);
});

test("claims are rate-limited: wrong codes shut a client out, and malformed bodies are refused", async () => {
  assert.equal((await claim({ code: "short", code_challenge: pkce().challenge })).status, 400);
  // A CORS-simple body never reaches the route (the cross-site write guard, middleware/csrf.ts): not a counted failure.
  assert.equal((await app.request("/auth/pair/claim", { method: "POST", headers: { "content-type": "text/plain", ...tunnel() }, body: "{}" })).status, 415);
  const s = await started();
  for (let i = 0; i < 9; i++) {
    const r = await claim({ code: randomBytes(16).toString("base64url"), code_challenge: pkce().challenge });
    assert.equal(r.status, 400);
    assert.equal(await errorOf(r), "invalid_code");
  }
  // Ten failures from this client: even the right code is refused now.
  const shut = await claim({ code: s.code, code_challenge: pkce().challenge });
  assert.equal(shut.status, 429);
  assert.ok(shut.headers.get("retry-after"));
  // Another client still can.
  ip = "10.200.200.200";
  assert.equal((await claim({ code: s.code, code_challenge: pkce().challenge, label: "x", platform: "ios" })).status, 200);
});

test("starting is rate-limited per account", async () => {
  const w = owner();
  for (let i = 0; i < 10; i++) assert.equal((await start(w)).status, 200);
  const r = await start(w);
  assert.equal(r.status, 429);
});
