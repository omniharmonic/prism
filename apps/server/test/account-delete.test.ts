/**
 * Account deletion (docs/account-deletion.md) through the real /auth app and the fake vault.
 * Pinned:
 *  - only a PERSON may delete: session cookie or `pd_` device token; a PAT, the loopback owner
 *    token and a capability link → 403; nothing / a stale credential → 401;
 *  - CSRF (JSON content type, cross-site refused), the typed email must match, a password
 *    account re-enters its password (a device token alone is not enough), a password-less
 *    account only from a browser session, the SERVER OWNER never (409 owner_account);
 *  - every effect: the account's rows are gone, its private pages are in the Trash and owned
 *    by the server owner (still private), other people's pages / access are untouched, grants
 *    it made for others stay, and ONE audit row with counts only (no address anywhere);
 *  - a vault that cannot be read deletes NOTHING (503), and a second call is 401.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { auth } from "../src/routes/auth";
import { api } from "../src/routes/api";
import { db, setAccount, getUser, addGrant, grantsForUser, ensureUser } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { issueDeviceToken, verifyDeviceToken } from "../src/auth/device";
import { issuePat, verifyPat } from "../src/auth/pat";
import { setTokenRevoker } from "../src/mcp-token";
import { resetTreeForTests } from "../src/tree";
import { resetPagesForTests, trashLedger } from "../src/pages";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";
import { TRASH_TAG } from "@prism/core/pages";

const OWNER = "owner@test.local";
const ADA = "ada@test.local";
const BEA = "bea@test.local";
const PW = "correct horse battery";
const J = { "content-type": "application/json" };

let fv: FakeVault;
let revokedJtis: string[] = [];

const NOTIFICATION_TABLES = ["notifications", "notification_settings", "notification_email_log", "notification_page_levels", "reminders", "access_requests", "comment_participants"];

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetPagesForTests();
  for (const t of NOTIFICATION_TABLES) db.exec(`DELETE FROM ${t}`);
  fv = installFakeVault();
  revokedJtis = [];
  setTokenRevoker(async (jti) => { revokedJtis.push(jti); });
});
afterEach(() => {
  fv.restore();
  setTokenRevoker(null);
  resetTreeForTests();
});

function del(body: unknown, headers: Record<string, string> = {}, query = "") {
  return auth.request(`/account/delete${query}`, { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });
}
const cookieFor = (email: string) => ({ cookie: sessionCookie(makeSession(email)) });
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const audits = () => db.prepare("SELECT * FROM action_audit WHERE action = 'account.delete'").all() as Array<Record<string, unknown>>;

/** A full account with something in every table the deletion touches. */
function seedAda() {
  setAccount(ADA, "Ada", hashPassword(PW));
  setAccount(BEA, "Bea", hashPassword(PW));
  db.prepare("INSERT INTO memberships (vault_id, email, role, created_by, created_at) VALUES ('primary', ?, 'admin', ?, ?)").run(ADA, OWNER, Date.now());
  db.prepare("INSERT INTO memberships (vault_id, email, role, created_by, created_at) VALUES ('primary', ?, 'member', ?, ?)").run(BEA, OWNER, Date.now());
  // Grants TO Ada (go), a grant Ada MADE for Bea (stays).
  grantUser(ADA, "tag", "team", "edit");
  addGrant({ subject_type: "user", subject: BEA, resource_type: "note", resource: "shared", level: "edit", created_by: ADA });
  const dev = issueDeviceToken(ADA, "Ada's phone", "prism-native");
  db.prepare("INSERT INTO apns_tokens (device_id, token, environment, owner_email, vault_id, created_at, last_seen_at) VALUES (?, ?, 'production', ?, 'primary', ?, ?)").run(dev.id, "ab".repeat(32), ADA, Date.now(), Date.now());
  const devPat = issuePat({ email: ADA, vaultId: "primary", scope: "read", deviceId: dev.id });
  const pat = issuePat({ email: ADA, vaultId: "primary", scope: "write" });
  db.prepare("INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at) VALUES (?, ?, 'k', 'a', ?)").run("https://fcm.googleapis.com/x", ADA, Date.now());
  const t = Date.now();
  db.prepare("INSERT INTO notifications (id, vault_id, recipient, type, note_id, actor_email, created_at) VALUES ('n1','primary',?, 'mention','shared',?,?)").run(ADA, BEA, t);
  db.prepare("INSERT INTO notifications (id, vault_id, recipient, type, note_id, actor_email, created_at) VALUES ('n2','primary',?, 'mention','shared',?,?)").run(BEA, ADA, t);
  db.prepare("INSERT INTO notification_settings (email, json, updated_at) VALUES (?, '{}', ?)").run(ADA, t);
  db.prepare("INSERT INTO notification_email_log (email, last_at) VALUES (?, ?)").run(ADA, t);
  db.prepare("INSERT INTO notification_page_levels (email, vault_id, note_id, level, updated_at) VALUES (?, 'primary', 'shared', 'all', ?)").run(ADA, t);
  db.prepare("INSERT INTO reminders (id, vault_id, owner_email, note_id, at, tz, status, created_at) VALUES ('r1','primary',?,'shared',?, 'UTC','scheduled',?)").run(ADA, t + 9e6, t);
  db.prepare("INSERT INTO access_requests (id, vault_id, note_id, requester, level, status, created_at) VALUES ('a1','primary','x',?, 'view','pending',?)").run(ADA, t);
  db.prepare("INSERT INTO access_requests (id, vault_id, note_id, requester, level, status, created_at, decided_by) VALUES ('a2','primary','x',?, 'view','approved',?,?)").run(BEA, t, ADA);
  db.prepare("INSERT INTO comment_participants (vault_id, note_id, thread_id, email) VALUES ('primary','shared','th',?)").run(ADA);
  db.prepare("INSERT INTO invites (token_hash, email, created_by, created_at, expires_at) VALUES ('i1','new@test.local',?,?,?)").run(ADA, t, t + 9e6);
  db.prepare("INSERT INTO invites (token_hash, email, created_by, created_at, expires_at, accepted_at) VALUES ('i2',?,?,?,?,?)").run(BEA, ADA, t, t + 9e6, t);
  db.prepare("INSERT INTO page_preferences (email, vault_id, data, revision, updated_at) VALUES (?, 'primary', '{}', 1, ?)").run(ADA, t);
  db.prepare("INSERT INTO tenant_secrets (vault_id, owner_email, kind, ciphertext, iv, created_at) VALUES ('primary', ?, 'notion', x'00', x'00', ?)").run(ADA, t);
  db.prepare("INSERT INTO mcp_tokens (jti, vault_id, email, scope, expires_at, created_at) VALUES ('jti-1','primary',?, 'vault:default:write', ?, ?)").run(ADA, t + 9e6, t);
  // Pages: two of Ada's private pages (one already in the Trash), Bea's private page,
  // a shared page Ada wrote in, and Ada's NON-private page.
  fv.put({ id: "ada-private", path: "vault/Ada notes", content: "mine", metadata: { prism_creator: ADA, prism_visibility: "private" } });
  fv.put({ id: "ada-trashed", path: "vault/Ada old", content: "old", tags: [TRASH_TAG], metadata: { prism_creator: ADA, prism_visibility: "private", prism_trashed_at: "2026-10-01T00:00:00.000Z", prism_trashed_by: ADA, prism_trashed_root: "ada-trashed" } });
  fv.put({ id: "bea-private", path: "vault/Bea notes", content: "hers", metadata: { prism_creator: BEA, prism_visibility: "private" } });
  fv.put({ id: "shared", path: "vault/Shared", content: "ours", tags: ["team"], metadata: { prism_creator: ADA, prism_last_writer: "u_whatever" } });
  return { dev, devPat, pat };
}

test("only a person may delete: PAT, loopback owner token and capability link → 403; nothing → 401", async () => {
  seedAda();
  const pat = issuePat({ email: ADA, vaultId: "primary", scope: "write" }).token;
  assert.equal((await del({ confirm: ADA, password: PW }, { authorization: `Bearer ${pat}` })).status, 403);
  const local = await del({ confirm: ADA, password: PW }, { authorization: "Bearer test-collab-token-xyz" });
  assert.equal(local.status, 403);
  assert.equal(((await local.json()) as { error: string }).error, "human_origin_required");
  const cap = makeCapability("note", "shared", "edit");
  assert.equal((await del({ confirm: ADA, password: PW }, {}, `?t=${encodeURIComponent(cap)}`)).status, 403);
  assert.equal((await del({ confirm: ADA, password: PW })).status, 401);
  assert.ok(getUser(ADA), "nothing was deleted");
  assert.equal(audits().length, 0);
});

test("CSRF: JSON only, cross-site refused (session); a device token skips the site checks", async () => {
  seedAda();
  const c = cookieFor(ADA);
  const form = await auth.request("/account/delete", { method: "POST", headers: { ...c, "content-type": "text/plain" }, body: JSON.stringify({ confirm: ADA, password: PW }) });
  assert.equal(form.status, 415);
  assert.equal((await del({ confirm: ADA, password: PW }, { ...c, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await del({ confirm: ADA, password: PW }, { ...c, origin: "https://evil.example" })).status, 403);
  assert.ok(getUser(ADA));
});

test("the server owner cannot delete their account (409 owner_account)", async () => {
  ensureUser(OWNER);
  setAccount(OWNER, "Owner", hashPassword(PW));
  const r = await del({ confirm: OWNER, password: PW }, cookieFor(OWNER));
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, "owner_account");
  assert.ok(getUser(OWNER));
});

test("the typed email must match, and the password is re-checked — also from a device", async () => {
  const { dev } = seedAda();
  const c = cookieFor(ADA);
  const wrongEmail = await del({ confirm: BEA, password: PW }, c);
  assert.equal(wrongEmail.status, 400);
  assert.equal(((await wrongEmail.json()) as { error: string }).error, "confirm_mismatch");
  assert.equal((await del({ password: PW }, c)).status, 400);
  const wrongPw = await del({ confirm: ADA, password: "nope nope nope" }, c);
  assert.equal(wrongPw.status, 403);
  assert.equal(((await wrongPw.json()) as { error: string }).error, "wrong_password");
  // A device token alone is not enough.
  const devOnly = await del({ confirm: ADA }, { authorization: `Bearer ${dev.token}` });
  assert.equal(devOnly.status, 403);
  assert.equal(((await devOnly.json()) as { error: string }).error, "wrong_password");
  assert.ok(getUser(ADA));
  assert.ok(verifyDeviceToken(dev.token));
});

test("an account with no password: a browser session may delete it, a device token may not", async () => {
  ensureUser("nopw@test.local");
  const dev = issueDeviceToken("nopw@test.local", "Phone", "prism-native");
  const r = await del({ confirm: "nopw@test.local" }, { authorization: `Bearer ${dev.token}` });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, "browser_session_required");
  assert.equal((await del({ confirm: " NoPw@test.local " }, cookieFor("nopw@test.local"))).status, 200);
  assert.equal(getUser("nopw@test.local"), null);
});

test("every effect: rows gone, private pages trashed to the server owner, others untouched, audit counts only", async () => {
  const { dev, devPat, pat } = seedAda();
  const beaSession = makeSession(BEA);
  const r = await del({ confirm: ADA, password: PW }, cookieFor(ADA));
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; deleted: boolean; privatePagesTrashed: number };
  assert.deepEqual(body, { ok: true, deleted: true, privatePagesTrashed: 2 });
  assert.match(r.headers.get("set-cookie") ?? "", /prism_session=;/);

  // Credentials.
  assert.equal(getUser(ADA), null);
  assert.equal(count("SELECT count(*) n FROM sessions WHERE email = ?", ADA), 0);
  assert.equal(verifyDeviceToken(dev.token), null);
  assert.equal(verifyPat(devPat.token), null);
  assert.equal(verifyPat(pat.token), null);
  assert.equal(count("SELECT count(*) n FROM device_tokens WHERE email = ?", ADA), 0);
  assert.equal(count("SELECT count(*) n FROM device_account_history WHERE email = ?", ADA), 0);
  assert.equal(count("SELECT count(*) n FROM mcp_pats WHERE email = ?", ADA), 0);
  assert.equal(count("SELECT count(*) n FROM mcp_tokens WHERE email = ?", ADA), 0);
  assert.deepEqual(revokedJtis, ["jti-1"]);
  assert.equal(count("SELECT count(*) n FROM apns_tokens"), 0);
  assert.equal(count("SELECT count(*) n FROM push_subscriptions WHERE email = ?", ADA), 0);
  // Notifications, reminders, requests, invites, preferences, secrets.
  for (const [table, col] of [["notifications", "recipient"], ["notification_settings", "email"], ["notification_email_log", "email"], ["notification_page_levels", "email"], ["reminders", "owner_email"], ["access_requests", "requester"], ["comment_participants", "email"], ["page_preferences", "email"], ["tenant_secrets", "owner_email"], ["memberships", "email"]]) {
    assert.equal(count(`SELECT count(*) n FROM ${table} WHERE ${col} = ?`, ADA), 0, table);
  }
  assert.equal(count("SELECT count(*) n FROM invites WHERE token_hash = 'i1'"), 0, "an unused invite Ada sent is gone");
  assert.equal(count("SELECT count(*) n FROM invites WHERE token_hash = 'i2'"), 1, "a used invite stays");
  // What Ada did for others stays, without her address.
  const n2 = db.prepare("SELECT actor_email FROM notifications WHERE id = 'n2'").get() as { actor_email: string | null };
  assert.equal(n2.actor_email, null);
  assert.equal((db.prepare("SELECT decided_by FROM access_requests WHERE id = 'a2'").get() as { decided_by: string | null }).decided_by, null);
  assert.equal(grantsForUser(ADA).length, 0, "grants TO Ada are gone");
  const beaGrants = grantsForUser(BEA);
  assert.equal(beaGrants.length, 1, "the grant Ada made for Bea stays");
  assert.equal(beaGrants[0]!.created_by, ADA);
  assert.equal(count("SELECT count(*) n FROM memberships WHERE email = ?", BEA), 1);
  assert.ok(getUser(BEA));

  // Pages.
  const priv = fv.notes.get("ada-private")!;
  assert.ok(priv.tags?.includes(TRASH_TAG), "Ada's private page is in the Trash");
  assert.equal(priv.metadata?.prism_creator, OWNER);
  assert.equal(priv.metadata?.prism_visibility, "private");
  assert.equal(priv.metadata?.prism_trashed_by, "deleted-account");
  assert.equal(priv.content, "mine", "never deleted");
  assert.ok(trashLedger("primary").some((l) => l.note_id === "ada-private" && l.trashed_by === "deleted-account"), "the purge worker's ledger has it");
  const old = fv.notes.get("ada-trashed")!;
  assert.equal(old.metadata?.prism_creator, OWNER);
  assert.equal(old.metadata?.prism_trashed_at, "2026-10-01T00:00:00.000Z", "an already-trashed page keeps its stamp");
  assert.deepEqual(fv.notes.get("bea-private")!.metadata, { prism_creator: BEA, prism_visibility: "private" });
  assert.ok(!fv.notes.get("shared")!.tags?.includes(TRASH_TAG), "Ada's shared page stays");
  assert.ok(fv.notes.get("shared")!.metadata?.prism_creator === ADA);
  assert.equal(fv.calls.filter((c) => c.method === "DELETE").length, 0, "nothing is deleted from the vault");

  // The server owner sees both in the Trash; Bea sees neither, and keeps her own access.
  const ownerTrash = (await (await api.request("/trash", { headers: { cookie: sessionCookie(makeSession(OWNER)) } })).json()) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
  const ownerIds = (Array.isArray(ownerTrash) ? ownerTrash : ownerTrash.items ?? []).map((x) => x.id);
  assert.ok(ownerIds.includes("ada-private") && ownerIds.includes("ada-trashed"), `owner trash: ${ownerIds}`);
  const beaTrash = (await (await api.request("/trash", { headers: { cookie: sessionCookie(beaSession) } })).json()) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
  const beaIds = (Array.isArray(beaTrash) ? beaTrash : beaTrash.items ?? []).map((x) => x.id);
  assert.ok(!beaIds.includes("ada-private") && !beaIds.includes("ada-trashed"));
  assert.equal((await api.request("/notes/bea-private", { headers: { cookie: sessionCookie(beaSession) } })).status, 200);

  // One audit row, counts only.
  const rows = audits();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "ok");
  assert.equal(rows[0]!.origin, "human");
  assert.ok(!JSON.stringify(rows[0]).includes("ada@"), "no address in the audit row");
  const target = JSON.parse(String(rows[0]!.target)) as Record<string, number>;
  assert.equal(target.privatePagesTrashed, 1);
  assert.equal(target.privatePagesReassigned, 1);
  assert.equal(target.user, 1);
  for (const v of Object.values(target)) assert.equal(typeof v, "number");

  // Idempotency: the session is gone, a second call is 401.
  const again = await del({ confirm: ADA, password: PW }, { cookie: sessionCookie("whatever") });
  assert.equal(again.status, 401);
  assert.equal((await del({ confirm: ADA, password: PW }, { authorization: `Bearer ${dev.token}` })).status, 401);
});

test("from the native app: device token + password deletes, and that device is signed out", async () => {
  const { dev } = seedAda();
  const r = await del({ confirm: ADA, password: PW }, { authorization: `Bearer ${dev.token}` });
  assert.equal(r.status, 200);
  assert.equal(verifyDeviceToken(dev.token), null);
  assert.equal(getUser(ADA), null);
  assert.equal(audits()[0]!.via, "device");
});

test("a vault that cannot be read deletes NOTHING (503), and a retry then finishes", async () => {
  const { dev } = seedAda();
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => (String(u).includes("/notes?") ? new Response("down", { status: 500 }) : real(u, init))) as typeof fetch;
  const session = cookieFor(ADA);
  const r = await del({ confirm: ADA, password: PW }, session);
  globalThis.fetch = real;
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, "vault_unavailable");
  assert.ok(getUser(ADA));
  assert.ok(verifyDeviceToken(dev.token));
  assert.equal(grantsForUser(ADA).length, 1);
  assert.equal(audits()[0]!.status, "failed");
  assert.ok(!fv.notes.get("ada-private")!.tags?.includes(TRASH_TAG));
  assert.equal((await del({ confirm: ADA, password: PW }, session)).status, 200);
  assert.equal(getUser(ADA), null);
});

test("a deleted writer's name resolves to nothing", async () => {
  seedAda();
  const { writerNames, writerIdFor } = await import("../src/writer-stamp");
  assert.equal(writerNames(false).get(writerIdFor(ADA)), "Ada");
  assert.equal((await del({ confirm: ADA, password: PW }, cookieFor(ADA))).status, 200);
  assert.equal(writerNames(true).get(writerIdFor(ADA)), undefined);
});
