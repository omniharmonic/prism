/**
 * Task 12: the `comms-native` client and its restricted device token. The Comms app signs
 * in with its own client id + `comms://` redirect, and its `pd_` token reaches only the
 * messaging prefixes (middleware/client-scope.ts); everything else is 403 client_scope.
 * Other clients are unaffected. Synthetic fixtures only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

process.env.OMNI_SERVICE_TOKEN = "omni-service-token-0123456789";

import { createApp } from "../src/app";
import { config } from "../src/config";
import { db } from "../src/db";
import { issueDeviceToken, deviceEmail, redirectAllowedForClient } from "../src/auth/device";
import { resetDeviceConfirmationsForTests } from "../src/auth/device-confirm";
import { setClientLookupForTests, commsPathAllowed } from "../src/middleware/client-scope";
import { setOmniPusherForTests } from "../src/omni/bus";
import { resetOmniStoreForTests } from "../src/omni/store";
import { createApproval, getApproval, approvalDigest } from "../src/omni/approvals";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const OWNER = config.ownerEmail;
const COMMS_REDIRECT = "comms://auth/callback";
const J = { "content-type": "application/json" };
const FORM_H = { "content-type": "application/x-www-form-urlencoded" };
const prev = { comms: process.env.COMMS_ENABLED, omni: process.env.OMNI_ENABLED };
let app: ReturnType<typeof createApp>;
let fv: FakeVault;

beforeEach(() => {
  process.env.COMMS_ENABLED = "true";
  process.env.OMNI_ENABLED = "true";
  resetDb();
  resetOmniStoreForTests();
  resetDeviceConfirmationsForTests();
  setOmniPusherForTests(async () => {});
  fv = installFakeVault();
  app = createApp();
});
afterEach(() => {
  fv.restore();
  setOmniPusherForTests(null);
  setClientLookupForTests(null);
  for (const [k, v] of [["COMMS_ENABLED", prev.comms], ["OMNI_ENABLED", prev.omni]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const comms = () => issueDeviceToken(OWNER, "Comms (test)", "comms-native");
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const authorize = (clientId: string, redirect: string, headers: Record<string, string> = {}) => {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, code_challenge_method: "S256", code_challenge: pkce().challenge, state: "st" });
  return app.request(`/auth/device/authorize?${q}`, { headers });
};
async function refused(r: Response, what: string) {
  assert.equal(r.status, 403, `${what}: status`);
  assert.deepEqual(await r.json(), { error: "client_scope" }, `${what}: body`);
}

test("comms-native authorize accepted only with comms redirect", async () => {
  const ok = await authorize("comms-native", COMMS_REDIRECT);
  assert.equal(ok.status, 302, "signed-out browser is sent to the login, i.e. the request was accepted");
  assert.match(ok.headers.get("location") ?? "", /next=%2Fauth%2Fdevice%2Fcontinue/);
  for (const r of ["omni://auth/callback", "prism://auth/callback", "http://127.0.0.1:53111/callback"]) {
    assert.equal((await authorize("comms-native", r)).status, 400, `comms-native → ${r} refused`);
  }
  assert.equal((await authorize("prism-native", COMMS_REDIRECT)).status, 400, "comms:// refused for prism-native");
  assert.equal((await authorize("omni-native", COMMS_REDIRECT)).status, 400, "comms:// refused for omni-native");
  assert.equal(redirectAllowedForClient("comms-native", "COMMS://auth/callback"), false, "exact match only");
});

test("client disabled when COMMS_ENABLED=false", async () => {
  process.env.COMMS_ENABLED = "false";
  const a = await authorize("comms-native", COMMS_REDIRECT);
  assert.equal(a.status, 400, "refused before any login, never redirected");
  assert.equal(a.headers.get("location"), null);
  assert.match(await a.text(), /Can't sign in this app/);
  const t = await app.request("/auth/device/token", {
    method: "POST",
    headers: FORM_H,
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: "comms-native", redirect_uri: COMMS_REDIRECT, code: "x".repeat(43), code_verifier: pkce().verifier }).toString(),
  });
  assert.equal(t.status, 401);
  assert.equal(((await t.json()) as { error: string }).error, "invalid_client");
});

test("comms-native token reads /api/comms/threads", async () => {
  const t = comms().token;
  const r = await app.request("/api/comms/threads", { headers: bearer(t) });
  assert.notEqual(r.status, 403, "passes client scope AND the owner guard");
  const body = (await r.json()) as { error?: string };
  assert.notEqual(body.error, "client_scope");
  const caps = await app.request("/api/integrations/comms/capabilities", { headers: bearer(t) });
  assert.equal(caps.status, 200);
});

test("comms-native token refused on /api/notes, /api/mcp, /api/actions/matrix/send, /api/admin, /api/comms/admin/rebuild", async () => {
  const t = comms().token;
  for (const [method, path] of [
    ["GET", "/api/notes"],
    ["GET", "/api/notes/n1"],
    ["GET", "/api/mcp"],
    ["POST", "/api/actions/matrix/send"],
    ["GET", "/api/admin"],
    ["POST", "/api/comms/admin/rebuild"],
    ["GET", "/api/comms/admin/owner-ids"],
    ["POST", "/api/comms/admin/owner-ids/reset"],
    ["POST", "/mcp"],
    ["GET", "/api/events"],
    ["GET", "/api/media/proxy?u=https://example.com/a.png"],
    ["GET", "/api/tree"],
    ["GET", "/acl/workers"],
    ["GET", "/auth/me"],
    ["GET", "/auth/devices"],
    ["POST", "/auth/pats"],
    ["POST", "/auth/pair/start"],
    ["GET", "/api/omni/threads"],
    ["GET", "/"],
  ] as const) {
    await refused(await app.request(path, { method, headers: { ...J, ...bearer(t) }, body: method === "POST" ? "{}" : undefined }), `${method} ${path}`);
  }
});

test("path tricks never widen the scope", async () => {
  const t = comms().token;
  for (const path of [
    "/api/comms/../notes",
    "/api/comms/%2e%2e/notes",
    "/api/comms/.%2E/notes",
    "/api/comms/..%2fnotes",
    "/api/comms/%2fnotes",
    "/api//notes",
    "/api/comms//admin/rebuild",
    "/API/notes",
    "/api/COMMS/admin/rebuild",
    "/api/comms/ADMIN/rebuild",
    "/api/comms/Admin/rebuild",
    "/api/comms/admin./rebuild",
    "/api/omni/approvalsX",
    "/api/omni/approvals-admin",
    "/api/omni/cardsX",
    "/api/pushX",
    "/api/push",
    "/auth/devices",
    "/auth/device",
    "/api/comms\\..\\notes",
  ]) {
    const r = await app.request(path, { method: "POST", headers: { ...J, ...bearer(t) }, body: "{}" });
    // `admin.` is not the admin route; whichever way it resolves it must not run a rebuild.
    if (path === "/api/comms/admin./rebuild") {
      assert.notEqual(r.status, 202, path);
      continue;
    }
    await refused(r, path);
  }
  // Pure matcher: segment-safe, case-sensitive allow, case-insensitive deny.
  assert.equal(commsPathAllowed("/api/omni/approvals"), true);
  assert.equal(commsPathAllowed("/api/omni/approvals/ap_1/decision"), true);
  assert.equal(commsPathAllowed("/api/omni/approvalsX"), false);
  assert.equal(commsPathAllowed("/api/comms/admin"), false);
  assert.equal(commsPathAllowed("/api/comms/aDmIn/x"), false);
  assert.equal(commsPathAllowed("/api/comms/administrator"), true, "segment-safe deny too");
  assert.equal(commsPathAllowed("/api/comms"), false, "the listed prefix is /api/comms/");
});

test("Authorization header variants are all scoped", async () => {
  const t = comms().token;
  for (const h of [`Bearer ${t}`, `Bearer ${t} `, `Bearer  ${t}`, `bearer ${t}`, `BEARER\t${t}`]) {
    await refused(await app.request("/api/notes", { headers: { authorization: h } }), JSON.stringify(h));
  }
  // A session cookie alongside a Comms bearer does not lift the scope.
  await refused(await app.request("/api/notes", { headers: { cookie: sessionCookie(makeSession(OWNER)), ...bearer(t) } }), "cookie + comms bearer");
  // A revoked Comms token is still refused (it authenticates nobody anyway).
  const dead = comms();
  db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), dead.id);
  await refused(await app.request("/api/notes", { headers: bearer(dead.token) }), "revoked comms token");
});

test("fail closed: a device lookup that errors refuses the pd_ request", async () => {
  const t = issueDeviceToken(OWNER, "Prism (test)", "prism-native").token;
  setClientLookupForTests(() => {
    throw new Error("db gone");
  });
  await refused(await app.request("/api/notes", { headers: bearer(t) }), "lookup error");
  await refused(await app.request("/api/comms/threads", { headers: bearer(t) }), "lookup error, allowed path too");
  // No device bearer → not affected by the lookup at all.
  assert.notEqual((await app.request("/api/version")).status, 403);
});

test("prism-native token unaffected", async () => {
  for (const id of ["prism-native", "omni-native"]) {
    const t = issueDeviceToken(OWNER, "x", id).token;
    const r = await app.request("/api/notes", { headers: bearer(t) });
    assert.equal(r.status, 200, `${id} reaches /api/notes`);
    assert.equal((await app.request("/auth/me", { headers: bearer(t) })).status, 200, `${id} reaches /auth/me`);
  }
});

test("collab socket identity refuses a comms-native token", () => {
  assert.equal(deviceEmail(comms().token), null);
  assert.equal(deviceEmail(issueDeviceToken(OWNER, "x", "prism-native").token), OWNER);
});

test("a comms-native token revokes only itself", async () => {
  const other = issueDeviceToken(OWNER, "Mac", "prism-native");
  const me = comms();
  const r = await app.request("/auth/device/revoke", { method: "POST", headers: { ...J, ...bearer(me.token) }, body: JSON.stringify({ device_id: other.id }) });
  await refused(r, "revoke another device");
  assert.equal((await app.request("/api/notes", { headers: bearer(other.token) })).status, 200, "the other device lives");
  const self = await app.request("/auth/device/revoke", { method: "POST", headers: { ...J, ...bearer(me.token) }, body: "{}" });
  assert.equal(self.status, 200, "signs itself out");
});

test("one-door: second device sign-in for comms-native creates device-sign-in approval", async () => {
  const phone = issueDeviceToken(OWNER, "Owner's iPhone", "omni-native").token;
  const existingComms = comms().token;
  const { verifier, challenge } = pkce();
  const sid = makeSession(OWNER);
  const q = new URLSearchParams({ client_id: "comms-native", redirect_uri: COMMS_REDIRECT, code_challenge_method: "S256", code_challenge: challenge, state: "st", label: "Comms on a Mac" });
  const a = await app.request(`/auth/device/authorize?${q}`, { headers: { cookie: sessionCookie(sid) } });
  assert.equal(a.status, 200);
  const html = await a.text();
  assert.match(html, /from the Comms app yourself/);
  const reqCookie = a.headers.get("set-cookie")!.match(/prism_device_req=([^;]*)/)![1]!;
  const req = html.match(/name="req" value="([^"]+)"/)![1]!;
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
  const cookie = `${sessionCookie(sid)}; prism_device_req=${reqCookie}`;
  const r = await app.request("/auth/device/approve", { method: "POST", headers: { ...FORM_H, cookie }, body: new URLSearchParams({ req, csrf, decision: "approve" }).toString() });
  assert.equal(r.status, 200, "waits for a device; no code");
  assert.equal((db.prepare("SELECT count(*) n FROM device_auth_codes").get() as { n: number }).n, 0);

  const list = (await (await app.request("/api/omni/approvals?status=pending", { headers: bearer(phone) })).json()) as { approvals: Array<{ id: string; kind: string; digest: string; payload: Record<string, unknown> }> };
  const ap = list.approvals.find((x) => x.kind === "device-sign-in");
  assert.ok(ap, "a device-sign-in approval is in Needs you");
  assert.equal(ap!.payload.clientId, "comms-native");
  assert.equal(ap!.payload.redirectUri, COMMS_REDIRECT);

  const decide = (h: Record<string, string>) =>
    app.request(`/api/omni/approvals/${ap!.id}/decision`, { method: "POST", headers: { ...J, ...h, "idempotency-key": `k-${randomBytes(6).toString("hex")}` }, body: JSON.stringify({ decision: "send", digest: ap!.digest }) });
  // A restricted Comms token may not approve a sign-in (it would mint an unrestricted device).
  await refused(await decide(bearer(existingComms)), "comms decides device-sign-in");
  assert.equal((await decide(bearer(phone))).status, 200, "an unrestricted device approves");
  const w = await app.request("/auth/device/wait", { headers: { cookie } });
  assert.equal(w.status, 302);
  const code = new URL(w.headers.get("location")!).searchParams.get("code")!;
  const t = await app.request("/auth/device/token", { method: "POST", headers: FORM_H, body: new URLSearchParams({ grant_type: "authorization_code", client_id: "comms-native", redirect_uri: COMMS_REDIRECT, code, code_verifier: verifier }).toString() });
  assert.equal(t.status, 200);
  const minted = ((await t.json()) as { access_token: string }).access_token;
  assert.equal((db.prepare("SELECT client_id FROM device_tokens WHERE token_hash = ?").get(createHash("sha256").update(minted).digest("hex")) as { client_id: string }).client_id, "comms-native");
  await refused(await app.request("/api/notes", { headers: bearer(minted) }), "the new comms token is scoped too");
});

// ---------------------------------------------------------------- fix round 1

test("I1: unmatched sub-paths under allowed prefixes never reach the vault gateway", async () => {
  const t = comms().token;
  for (const [method, path] of [
    ["GET", "/api/omni/approvals/"],
    ["POST", "/api/omni/approvals/"],
    ["GET", "/api/omni/approvals/a/b/c/d"],
    ["POST", "/api/omni/approvals/a/b/c/d"],
    ["GET", "/api/omni/approvals/x/decision/extra"],
    ["POST", "/api/omni/approvals/x/decision/extra"],
    ["GET", "/api/omni/cards/"],
    ["GET", "/api/omni/cards/a/b/c"],
    ["GET", "/api/push/zzz"],
    ["POST", "/api/push/zzz"],
    ["GET", "/api/integrations/comms/zzz"],
    ["PUT", "/api/integrations/comms/zzz"],
  ] as const) {
    const before = fv.calls?.length;
    await refused(await app.request(path, { method, headers: { ...J, ...bearer(t) }, body: method === "GET" ? undefined : "{}" }), `${method} ${path}`);
    if (before !== undefined) assert.equal(fv.calls.length, before, `${method} ${path}: no vault call`);
  }
  // The owner's own unrestricted device still gets the passthrough for such a path.
  const mac = issueDeviceToken(OWNER, "Mac", "prism-native").token;
  assert.notEqual((await app.request("/api/push/zzz", { headers: bearer(mac) })).status, 403);
});

const tweet = () => createApproval({ owner: OWNER, threadId: null, kind: "tweet", payload: { text: "Synthetic post" }, ttlMs: 60_000 });
const decideAs = (id: string, decision: string, digest: string, h: Record<string, string>) =>
  app.request(`/api/omni/approvals/${id}/decision`, { method: "POST", headers: { ...J, ...h, "idempotency-key": `k-${randomBytes(6).toString("hex")}` }, body: JSON.stringify({ decision, digest }) });

test("R17: a comms token reads approvals and may deny; approve/send/revise/edit are refused and the approval stays pending", async () => {
  const t = comms().token;
  const a = tweet();
  const list = await app.request("/api/omni/approvals?status=pending", { headers: bearer(t) });
  assert.equal(list.status, 200, "GET list allowed");
  const row = ((await list.json()) as { approvals: Array<{ id: string; digest: string }> }).approvals.find((x) => x.id === a.id)!;
  assert.ok(row);
  assert.equal((await app.request(`/api/omni/approvals/${a.id}`, { headers: bearer(t) })).status, 200, "GET one allowed");

  for (const d of ["approve", "send", "revise", "APPROVE", "cancel "]) {
    await refused(await decideAs(a.id, d, row.digest, bearer(t)), `decision ${d}`);
  }
  await refused(await app.request(`/api/omni/approvals/${a.id}/decide`, { method: "POST", headers: { ...J, ...bearer(t), "idempotency-key": "k-dup-0001" }, body: `{"decision":"cancel","decision":"send","digest":"${row.digest}"}` }), "duplicate key: last one wins, as in the handler");
  await refused(await app.request(`/api/omni/approvals/${a.id}/decision`, { method: "POST", headers: { ...J, ...bearer(t) }, body: "not json" }), "unparseable body");
  await refused(await app.request(`/api/omni/approvals/${a.id}`, { method: "PUT", headers: { ...J, ...bearer(t) }, body: JSON.stringify({ digest: row.digest, payload: { text: "edited" } }) }), "edit");
  await refused(await app.request(`/api/omni/approvals/${a.id}/send-grant/verify`, { method: "POST", headers: { ...J, ...bearer(t) }, body: "{}" }), "send-grant");
  assert.equal(getApproval(OWNER, a.id)!.status, "pending", "never claimed");

  for (const d of ["cancel", "reject"]) {
    const b = tweet();
    const ok = await decideAs(b.id, d, approvalDigest(b.kind, b.payload), bearer(t));
    assert.equal(ok.status, 200, `deny (${d}) allowed`);
    assert.notEqual(getApproval(OWNER, b.id)!.status, "pending");
  }
});

test("R17: cards — GETs allowed, instruct and choose refused, snooze/dismiss pass the scope", async () => {
  const t = comms().token;
  assert.equal((await app.request("/api/omni/cards", { headers: bearer(t) })).status, 200);
  for (const p of ["/api/omni/cards/card_x/instruct", "/api/omni/cards/card_x/choose", "/api/omni/cards/card_x"]) {
    await refused(await app.request(p, { method: "POST", headers: { ...J, ...bearer(t), "idempotency-key": "k-card-0001" }, body: JSON.stringify({ optionId: "a", text: "x" }) }), p);
  }
  for (const p of ["/api/omni/cards/card_x/snooze", "/api/omni/cards/card_x/dismiss"]) {
    const r = await app.request(p, { method: "POST", headers: { ...J, ...bearer(t) }, body: "{}" });
    assert.notEqual(((await r.json()) as { error?: string }).error, "client_scope", p);
  }
});

test("I1: an oversized decide body is refused promptly (no hang on the cloned tee)", async () => {
  const t = comms().token;
  const a = tweet();
  const big = JSON.stringify({ decision: "cancel", digest: "x", pad: "a".repeat(20 * 1024) });
  const within = <T,>(p: T | Promise<T>, what: string) =>
    Promise.race([Promise.resolve(p), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out (hang)`)), 2000).unref())]);
  // Declared length above the cap: refused before any body is read.
  const declared = await within(
    app.request(`/api/omni/approvals/${a.id}/decision`, { method: "POST", headers: { ...J, ...bearer(t), "content-length": String(Buffer.byteLength(big)) }, body: big }),
    "declared length",
  );
  await refused(declared, "declared length over cap");
  // No declared length (a chunked stream): the peek stops at the cap and still answers.
  const enc = new TextEncoder().encode(big);
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (let i = 0; i < enc.length; i += 4096) ctl.enqueue(enc.subarray(i, i + 4096));
      ctl.close();
    },
  });
  const chunked = await within(
    app.request(`/api/omni/approvals/${a.id}/decision`, { method: "POST", headers: { ...J, ...bearer(t) }, body: stream, duplex: "half" } as RequestInit),
    "chunked body",
  );
  await refused(chunked, "chunked body over cap");
  assert.equal(getApproval(OWNER, a.id)!.status, "pending", "never claimed");
});
