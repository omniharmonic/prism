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
import { db, rehashLegacySessions, getSession } from "../src/db";
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
  const phone = issueDeviceToken(OWNER, "Benjamin's iPhone", "omni-native").token;
  const { r, cookie, verifier } = await consent();
  assert.equal(r.status, 200, "no redirect, no code");
  assert.match(await r.text(), /Approve this sign-in on a device you already use/);
  assert.equal((db.prepare("SELECT count(*) n FROM device_auth_codes").get() as { n: number }).n, 0);
  assert.equal((await wait(cookie)).status, 200, "still waiting");

  const [a] = await pendingSignIns(phone);
  assert.ok(a, "the request is in Needs you");
  assert.deepEqual(Object.keys(a!.payload).sort(), ["clientId", "ipHint", "label", "redirectUri", "requestedAt", "userAgentHint"]);
  assert.equal(a!.payload.label, "Evil Laptop");
  assert.equal(a!.payload.redirectUri, REDIRECT);
  assert.equal(a!.payload.ipHint, ip.split(".").slice(0, 2).join(".") + ".x.x", "coarse, not the full address");

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
