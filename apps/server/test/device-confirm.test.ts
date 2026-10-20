/**
 * One-door review R2-1 (controller ruling): once the owner has a live device, a NEW device
 * sign-in needs an existing device's approval in Omni (`device-sign-in`); a magic-link
 * session alone cannot mint a `pd_` token. Bootstrap (no device yet) is unchanged; a session
 * cannot revoke devices; legacy session rows are rehashed at startup; Prism sign-in mail is
 * never copied into the vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

process.env.OMNI_SERVICE_TOKEN = "omni-service-token-0123456789";

import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, rehashLegacySessions, getSession, setAccount, getUser, DEVICE_BOOTSTRAP_COOLDOWN_MS } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { matchCodeFor, requestHints, CONFIRM_TTL_MS } from "../src/auth/device-confirm";
import { issueDeviceToken } from "../src/auth/device";
import { resetDeviceConfirmationsForTests } from "../src/auth/device-confirm";
import { setOmniPusherForTests } from "../src/omni/bus";
import { resetOmniStoreForTests, auditRows } from "../src/omni/store";
import { isPrismSignInMail } from "../src/worker/proton";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const OWNER = config.ownerEmail;
const REDIRECT = "prism://auth/callback";
const J = { "content-type": "application/json" };
const FORM_H = { "content-type": "application/x-www-form-urlencoded" };
let app: ReturnType<typeof createApp>;
let fv: FakeVault;
let ip: string;

beforeEach(() => {
  process.env.OMNI_ENABLED = "true";
  resetDb();
  resetOmniStoreForTests();
  resetDeviceConfirmationsForTests();
  setOmniPusherForTests(async () => {});
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
});
afterEach(() => {
  fv.restore();
  setOmniPusherForTests(null);
  delete process.env.OMNI_ENABLED;
});

const tunnel = () => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip, "user-agent": "curl/8.7.1" });
const cookieVal = (h: string | null, name: string) => h?.match(new RegExp(`${name}=([^;]*)`))?.[1] ?? null;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** A magic-link-style browser session asks to sign in a new app and presses Approve. */
async function consent(decision = "approve") {
  const { verifier, challenge } = pkce();
  const sid = makeSession(OWNER);
  const q = new URLSearchParams({ client_id: "prism-native", redirect_uri: REDIRECT, code_challenge_method: "S256", code_challenge: challenge, state: "st", label: "Evil Laptop" });
  const a = await app.request(`/auth/device/authorize?${q}`, { headers: { cookie: sessionCookie(sid), ...tunnel() } });
  assert.equal(a.status, 200);
  const html = await a.text();
  const reqCookie = cookieVal(a.headers.get("set-cookie"), "prism_device_req")!;
  const req = html.match(/name="req" value="([^"]+)"/)![1]!;
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
  const cookie = `${sessionCookie(sid)}; prism_device_req=${reqCookie}`;
  const r = await app.request("/auth/device/approve", { method: "POST", headers: { ...FORM_H, cookie, ...tunnel() }, body: new URLSearchParams({ req, csrf, decision }).toString() });
  return { r, cookie, verifier };
}
const wait = (cookie: string) => app.request("/auth/device/wait", { headers: { cookie, ...tunnel() } });
const pendingSignIns = async (dev: string) =>
  ((await (await app.request("/api/omni/approvals?status=pending", { headers: bearer(dev) })).json()) as { approvals: Array<{ id: string; kind: string; digest: string; payload: Record<string, unknown> }> }).approvals.filter((a) => a.kind === "device-sign-in");
const decide = (id: string, digest: string, decision: string, headers: Record<string, string>) =>
  app.request(`/api/omni/approvals/${id}/decision`, { method: "POST", headers: { ...J, ...headers, "idempotency-key": `k-${randomBytes(6).toString("hex")}` }, body: JSON.stringify({ decision, digest }) });

test("bootstrap: with no live device, the consent page signs the first device in as before", async () => {
  const { r } = await consent();
  assert.equal(r.status, 302);
  assert.ok(new URL(r.headers.get("location")!).searchParams.get("code"), "a code is minted");
});

test("with a live device: a session's consent only WAITS; an existing device approves the exact request in Omni", async () => {
  const phone = issueDeviceToken(OWNER, "Owner's iPhone", "omni-native").token;
  const { r, cookie, verifier } = await consent();
  assert.equal(r.status, 200, "no redirect, no code");
  assert.match(await r.text(), /Approve this sign-in on a device you already use/);
  assert.equal((db.prepare("SELECT count(*) n FROM device_auth_codes").get() as { n: number }).n, 0);
  assert.equal((await wait(cookie)).status, 200, "still waiting");

  const [a] = await pendingSignIns(phone);
  assert.ok(a, "the request is in Needs you");
  assert.deepEqual(Object.keys(a!.payload).sort(), ["clientId", "ipHint", "label", "matchCode", "redirectUri", "requestedAt", "userAgentHint"]);
  assert.equal(a!.payload.label, "Evil Laptop");
  assert.equal(a!.payload.redirectUri, REDIRECT);
  assert.equal(a!.payload.ipHint, "reported from this Mac or the local network (unverified)", "a forged client-IP header off the tunnel host is not believed");

  // The session that asked cannot approve its own request; nor can it be edited or proposed.
  const bySession = await decide(a!.id, a!.digest, "send", { cookie: cookie.split(";")[0]!, origin: config.appOrigin, "sec-fetch-site": "same-origin" });
  assert.equal(bySession.status, 403);
  assert.equal((await app.request("/api/omni/hooks/propose", { method: "POST", headers: { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` }, body: JSON.stringify({ kind: "device-sign-in", payload: a!.payload }) })).status, 400);
  assert.equal((await app.request(`/api/omni/approvals/${a!.id}`, { method: "PUT", headers: { ...J, ...bearer(phone) }, body: JSON.stringify({ digest: a!.digest, payload: a!.payload }) })).status, 400);
  assert.equal((await decide(a!.id, "0".repeat(64), "send", bearer(phone))).status, 409, "the exact digest");

  // The existing device approves → the waiting browser gets its code → token.
  const ok = await decide(a!.id, a!.digest, "approve", bearer(phone));
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { approval: { status: string } }).approval.status, "sent");
  const w = await wait(cookie);
  assert.equal(w.status, 302);
  const code = new URL(w.headers.get("location")!).searchParams.get("code")!;
  const t = await app.request("/auth/device/token", { method: "POST", headers: { ...FORM_H, ...tunnel() }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: "prism-native", redirect_uri: REDIRECT, code, code_verifier: verifier }).toString() });
  assert.equal(t.status, 200);
  assert.ok(auditRows().some((x) => x.action === "approval.approve"));
});

test("denied in Omni, or expired: the waiting browser is refused; nothing minted", async () => {
  const phone = issueDeviceToken(OWNER, "phone", "omni-native").token;
  const { cookie } = await consent();
  const [a] = await pendingSignIns(phone);
  assert.equal((await decide(a!.id, a!.digest, "cancel", bearer(phone))).status, 200);
  const w = await wait(cookie);
  assert.equal(w.status, 302);
  assert.equal(new URL(w.headers.get("location")!).searchParams.get("error"), "access_denied");

  const second = await consent();
  const [b] = await pendingSignIns(phone);
  db.prepare("UPDATE omni_approvals SET expires_at = ? WHERE id = ?").run(Date.now() - 1, b!.id);
  const w2 = await wait(second.cookie);
  assert.equal(new URL(w2.headers.get("location")!).searchParams.get("error"), "access_denied");
  assert.equal((db.prepare("SELECT count(*) n FROM device_auth_codes").get() as { n: number }).n, 0);
});

test("a browser session cannot revoke devices (which would reopen bootstrap); a device can", async () => {
  const phone = issueDeviceToken(OWNER, "phone", "omni-native");
  const s = { cookie: sessionCookie(makeSession(OWNER)), ...tunnel() };
  assert.equal((await app.request(`/auth/devices/${phone.id}`, { method: "DELETE", headers: s })).status, 403);
  assert.equal((await app.request("/auth/device/revoke", { method: "POST", headers: { ...s, ...J }, body: JSON.stringify({ device_id: phone.id }) })).status, 403);
  const { r } = await consent();
  assert.equal(r.status, 200, "still a live device → still needs its approval");
  assert.equal((await app.request(`/auth/devices/${phone.id}`, { method: "DELETE", headers: { ...bearer(phone.token), ...tunnel() } })).status, 200);
});

test("startup rehash: every plaintext session row becomes hashed, idempotently", () => {
  db.prepare("INSERT INTO sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)").run("dormant-legacy-id", OWNER, Date.now(), Date.now() + 60_000);
  assert.equal(rehashLegacySessions(), 1);
  assert.equal(rehashLegacySessions(), 0);
  const ids = (db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>).map((x) => x.id);
  assert.ok(ids.every((id) => id.startsWith("h:")));
  assert.equal(getSession("dormant-legacy-id")?.email, OWNER, "the cookie still works");
});

test("Prism sign-in mail is recognised (never copied into the vault)", () => {
  const ours = config.magicFrom;
  assert.equal(isPrismSignInMail({ from: ours, subject: "Your Prism sign-in link", body: "Click" }), true);
  assert.equal(isPrismSignInMail({ from: "x@y.z", subject: "fwd", body: `see ${config.appOrigin}/auth/callback?token=abc` }), true);
  assert.equal(isPrismSignInMail({ from: "x@y.z", subject: "fwd", body: "https://h/auth/device/approve?code=abc" }), true);
  assert.equal(isPrismSignInMail({ from: "dana@example.org", subject: "Sign in to the meetup?", body: "lunch?" }), false);
});


// ── review round 3 ───────────────────────────────────────────────────────────

test("C1: a session alone cannot empty the account of devices (set-password / change-password / revoke) — no code is minted", async () => {
  setAccount(OWNER, "Owner", hashPassword("the owners passphrase"));
  const phone = issueDeviceToken(OWNER, "phone", "omni-native");
  const s = { ...J, cookie: sessionCookie(makeSession(OWNER)), origin: config.appOrigin, ...tunnel() };
  const set = await app.request("/auth/set-password", { method: "POST", headers: s, body: JSON.stringify({ password: "attacker passphrase 1" }) });
  assert.equal(set.status, 409, "set-password refuses once a password exists");
  assert.ok(getUser(OWNER)?.password_hash && !(await import("../src/auth/password")).verifyPassword("attacker passphrase 1", getUser(OWNER)!.password_hash!));
  const chg = await app.request("/auth/change-password", { method: "POST", headers: s, body: JSON.stringify({ currentPassword: "the owners passphrase", newPassword: "another passphrase 2" }) });
  assert.equal(chg.status, 200);
  assert.equal(((await chg.json()) as { revokedDevices: number }).revokedDevices, 0, "a session's password change revokes no device");
  assert.equal((await app.request("/auth/me", { headers: { ...bearer(phone.token), ...tunnel() } })).status, 200);
  const { r } = await consent();
  assert.equal(r.status, 200, "still waits for the existing device");
  assert.equal((db.prepare("SELECT count(*) n FROM device_auth_codes").get() as { n: number }).n, 0);
});

test("C1: after the last device is gone, bootstrap reopens only after a 24 h cool-down", async () => {
  const phone = issueDeviceToken(OWNER, "phone", "omni-native");
  await app.request(`/auth/devices/${phone.id}`, { method: "DELETE", headers: { ...bearer(phone.token), ...tunnel() } });
  const first = await consent();
  assert.equal(first.r.status, 200, "revoked just now: still needs an approval (none possible) — no code");
  assert.equal((db.prepare("SELECT count(*) n FROM device_auth_codes").get() as { n: number }).n, 0);
  resetDeviceConfirmationsForTests();
  db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = ?").run(Date.now() - DEVICE_BOOTSTRAP_COOLDOWN_MS - 1000, phone.id);
  db.prepare("UPDATE device_account_history SET last_live_until = ? WHERE email = ?").run(Date.now() - DEVICE_BOOTSTRAP_COOLDOWN_MS - 1000, OWNER);
  const later = await consent();
  assert.equal(later.r.status, 302, "after the cool-down the owner can sign a device in again");
  // A session-ended history keeps the door shut for good.
  db.prepare("UPDATE device_account_history SET last_end_via = 'session' WHERE email = ?").run(OWNER);
  db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE email = ?").run(Date.now() - 2 * DEVICE_BOOTSTRAP_COOLDOWN_MS, OWNER);
  db.prepare("UPDATE device_tokens SET revoked_at = COALESCE(revoked_at, ?)").run(Date.now() - 2 * DEVICE_BOOTSTRAP_COOLDOWN_MS);
  resetDeviceConfirmationsForTests();
  assert.equal((await consent()).r.status, 200);
});

test("I1: the waiting page and the Omni card show the same matching code; one pending sign-in at a time", async () => {
  const phone = issueDeviceToken(OWNER, "phone", "omni-native").token;
  const { r } = await consent();
  const html = await r.text();
  const [a] = await pendingSignIns(phone);
  const code = String(a!.payload.matchCode);
  assert.match(code, /^\d{3} \d{3}$/);
  assert.ok(html.includes(code), "the waiting page shows the card's code");
  assert.match(html, /only if it shows this same code/);
  const second = await consent();
  assert.equal(second.r.status, 403, "a second concurrent sign-in is refused");
  const page2 = await second.r.text();
  assert.match(page2, /Another sign-in is already waiting/);
  assert.match(page2, /The waiting request is NOT this one/);
  assert.equal((await pendingSignIns(phone)).length, 1);
  assert.notEqual(matchCodeFor("req-a"), matchCodeFor("req-b"));
  assert.equal(matchCodeFor("req-a"), matchCodeFor("req-a"));
});

test("I1: the client IP is believed only for the tunnel's public host", () => {
  const host = new URL(config.appOrigin).host;
  const h = (o: Record<string, string>) => (k: string) => o[k];
  assert.equal(requestHints(h({ "cf-connecting-ip": "203.0.113.9", host: "127.0.0.1:8787" })).ipHint, "reported from this Mac or the local network (unverified)");
  const viaPublic = requestHints(h({ "cf-connecting-ip": "203.0.113.9", host })).ipHint;
  // In tests APP_ORIGIN is localhost, which is never treated as the tunnel.
  assert.equal(viaPublic, /^(localhost|127\.)/.test(host) ? "reported from this Mac or the local network (unverified)" : "reported from 203.0.x.x (unverified)");
});

test("M1 + M2: the approval never outlives the parked request; a session cannot deny the owner's sign-in", async () => {
  const phone = issueDeviceToken(OWNER, "phone", "omni-native").token;
  const { cookie } = await consent();
  const [a] = await pendingSignIns(phone);
  const row = db.prepare("SELECT expires_at, created_at FROM omni_approvals WHERE id = ?").get(a!.id) as { expires_at: number; created_at: number };
  const req = db.prepare("SELECT expires_at FROM device_auth_requests").get() as { expires_at: number };
  assert.ok(row.expires_at <= req.expires_at, "approval expiry ≤ request expiry");
  assert.ok(row.expires_at - row.created_at <= CONFIRM_TTL_MS);
  const deny = await decide(a!.id, a!.digest, "cancel", { cookie: cookie.split(";")[0]!, origin: config.appOrigin, "sec-fetch-site": "same-origin" });
  assert.equal(deny.status, 403);
  assert.equal((await pendingSignIns(phone)).length, 1, "still pending");
});

test("with Omni off and a live device, a session's consent is refused (no fallback to session consent)", async () => {
  issueDeviceToken(OWNER, "phone", "omni-native");
  delete process.env.OMNI_ENABLED;
  const { r } = await consent();
  assert.equal(r.status, 403);
  assert.equal((db.prepare("SELECT count(*) n FROM device_auth_codes").get() as { n: number }).n, 0);
});


// ── review round 4 ───────────────────────────────────────────────────────────

test("R4 I-a: invite/register can never replace an existing password; nothing changes", async () => {
  const { verifyPassword } = await import("../src/auth/password");
  setAccount(OWNER, "Owner", hashPassword("the owners passphrase"));
  const s = { ...J, cookie: sessionCookie(makeSession(OWNER)), origin: config.appOrigin, ...tunnel() };
  const inv = await app.request("/auth/invite", { method: "POST", headers: s, body: JSON.stringify({ email: OWNER }) });
  assert.equal(inv.status, 409, "no invite for the owner's own address");
  // An existing member with a password: no invite either.
  setAccount("member@test.local", "M", hashPassword("member passphrase one"));
  assert.equal((await app.request("/auth/invite", { method: "POST", headers: s, body: JSON.stringify({ email: "member@test.local" }) })).status, 409);
  // A stale invite issued before the account got its password cannot overwrite it either.
  const fresh = await app.request("/auth/invite", { method: "POST", headers: s, body: JSON.stringify({ email: "later@test.local" }) });
  assert.equal(fresh.status, 200);
  const token = new URL(((await fresh.json()) as { url: string }).url).searchParams.get("token")!;
  setAccount("later@test.local", "L", hashPassword("their own passphrase"));
  const reg = await app.request("/auth/register", { method: "POST", headers: { ...J, ...tunnel() }, body: JSON.stringify({ token, name: "x", password: "attacker passphrase" }) });
  assert.equal(reg.status, 409);
  assert.ok(verifyPassword("their own passphrase", getUser("later@test.local")!.password_hash!), "the password is unchanged");
  assert.ok(verifyPassword("the owners passphrase", getUser(OWNER)!.password_hash!));
});

test("R4 M-a: a request with under a minute left is not parked for approval; the approval never outlives it", async () => {
  issueDeviceToken(OWNER, "phone", "omni-native");
  const { verifier: _v } = pkce();
  const sid = makeSession(OWNER);
  const q = new URLSearchParams({ client_id: "prism-native", redirect_uri: REDIRECT, code_challenge_method: "S256", code_challenge: pkce().challenge, state: "st", label: "L" });
  const a = await app.request(`/auth/device/authorize?${q}`, { headers: { cookie: sessionCookie(sid), ...tunnel() } });
  const html = await a.text();
  const reqCookie = cookieVal(a.headers.get("set-cookie"), "prism_device_req")!;
  db.prepare("UPDATE device_auth_requests SET expires_at = ?").run(Date.now() + 30_000);
  const r = await app.request("/auth/device/approve", { method: "POST", headers: { ...FORM_H, cookie: `${sessionCookie(sid)}; prism_device_req=${reqCookie}`, ...tunnel() },
    body: new URLSearchParams({ req: html.match(/name="req" value="([^"]+)"/)![1]!, csrf: html.match(/name="csrf" value="([^"]+)"/)![1]!, decision: "approve" }).toString() });
  assert.equal(r.status, 400);
  assert.equal((db.prepare("SELECT count(*) n FROM omni_approvals WHERE kind = 'device-sign-in'").get() as { n: number }).n, 0);
});

test("R4 M-d: a revocation without a device credential (used-code replay, token-possession revoke) never starts the 24 h clock", async () => {
  const dev = issueDeviceToken(OWNER, "phone", "omni-native");
  // Token possession (RFC 7009 style) revokes it, tagged "token".
  await app.request("/auth/device/revoke", { method: "POST", headers: { ...J, ...tunnel() }, body: JSON.stringify({ token: dev.token }) });
  const h = db.prepare("SELECT last_end_via FROM device_account_history WHERE email = ?").get(OWNER) as { last_end_via: string };
  assert.equal(h.last_end_via, "token");
  db.prepare("UPDATE device_tokens SET revoked_at = ?").run(Date.now() - 2 * DEVICE_BOOTSTRAP_COOLDOWN_MS);
  db.prepare("UPDATE device_account_history SET last_live_until = ?").run(Date.now() - 2 * DEVICE_BOOTSTRAP_COOLDOWN_MS);
  const late = await consent();
  assert.equal(late.r.status, 200, "even 48 h later: no bootstrap — it waits for a device approval");
  assert.match(await late.r.text(), /Approve this sign-in on a device you already use/);
  assert.equal((db.prepare("SELECT count(*) n FROM device_auth_codes").get() as { n: number }).n, 0);
});
