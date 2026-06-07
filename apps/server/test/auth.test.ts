/**
 * Auth is invite-only with passwords. These tests pin the security model
 * through the real /auth Hono app:
 *  - owner-only magic link (bootstrap/recovery): a stranger's request sends
 *    nothing; the owner's callback sets a session.
 *  - invite → register (name + password) → session; then password login.
 *  - registration is impossible without a valid owner-issued invite.
 *  - login is generic-401 for wrong password AND unknown account (no enumeration).
 *  - /auth/invite is owner-only.
 *
 * With no RESEND_API_KEY (test env), emails are logged to the console; we
 * intercept that to obtain the one-time tokens a real user would click.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { auth } from "../src/routes/auth";
import { createInvite } from "../src/auth/invite";
import { resetDb } from "./helpers";

const OWNER = "owner@test.local";
const JSON_H = { "content-type": "application/json" };

let logs: string[] = [];
const realLog = console.log;
beforeEach(() => {
  resetDb();
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});
afterEach(() => {
  console.log = realLog;
});

const post = (path: string, body: unknown) =>
  auth.request(path, { method: "POST", headers: JSON_H, body: JSON.stringify(body) });
const sessionFromSetCookie = (h: string | null): string | null =>
  h?.match(/prism_session=([^;]+)/)?.[1] ?? null;
const tokenFromLog = (): string => {
  const line = logs.find((l) => l.includes("token="));
  assert.ok(line, "expected an emailed link in the dev log");
  return new URL(line!.split(" :: ")[1]!.trim()).searchParams.get("token")!;
};

// ---- owner magic link (bootstrap / recovery) ----
test("owner magic link: request → callback → me → logout", async () => {
  const r = await post("/request", { email: OWNER });
  assert.equal(r.status, 200);
  const token = tokenFromLog();

  const cb = await auth.request(`/callback?token=${encodeURIComponent(token)}`);
  assert.equal(cb.headers.get("location"), "/");
  const sid = sessionFromSetCookie(cb.headers.get("set-cookie"));
  assert.ok(sid, "callback sets a session cookie");

  const me = (await (await auth.request("/me", { headers: { cookie: `prism_session=${sid}` } })).json()) as {
    authenticated: boolean;
    email: string;
    isOwner: boolean;
  };
  assert.equal(me.authenticated, true);
  assert.equal(me.email, OWNER);
  assert.equal(me.isOwner, true);

  await auth.request("/logout", { method: "POST", headers: { cookie: `prism_session=${sid}` } });
  const after = await auth.request("/me", { headers: { cookie: `prism_session=${sid}` } });
  assert.equal(after.status, 401);
});

test("a stranger CANNOT get a magic link (owner-only), but the response is still 200", async () => {
  const r = await post("/request", { email: "stranger@nowhere.test" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(
    logs.some((l) => l.includes("token=")),
    false,
    "no sign-in link should be issued to a non-owner",
  );
});

test("magic-link tokens are single-use", async () => {
  await post("/request", { email: OWNER });
  const token = tokenFromLog();
  const first = await auth.request(`/callback?token=${encodeURIComponent(token)}`);
  assert.equal(first.headers.get("location"), "/");
  const second = await auth.request(`/callback?token=${encodeURIComponent(token)}`);
  assert.equal(second.headers.get("location"), "/?login=expired");
});

// ---- invite → register → login ----
test("invite → register (name+password) → session → password login", async () => {
  const url = await createInvite("aaron@test.local", "Aaron", OWNER);
  const token = new URL(url).searchParams.get("token")!;

  const reg = await post("/register", { token, name: "Aaron G", password: "correct horse battery" });
  assert.equal(reg.status, 200);
  const sid = sessionFromSetCookie(reg.headers.get("set-cookie"));
  assert.ok(sid, "register starts a session");

  const me = (await (await auth.request("/me", { headers: { cookie: `prism_session=${sid}` } })).json()) as {
    email: string;
    isOwner: boolean;
    hasPassword: boolean;
  };
  assert.equal(me.email, "aaron@test.local");
  assert.equal(me.isOwner, false, "an invited user is never the owner");
  assert.equal(me.hasPassword, true);

  // The same credentials now log in.
  const login = await post("/login", { email: "aaron@test.local", password: "correct horse battery" });
  assert.equal(login.status, 200);
  assert.ok(sessionFromSetCookie(login.headers.get("set-cookie")));
});

test("registration is impossible without a valid invite", async () => {
  const r = await post("/register", { token: "not-a-real-invite", name: "Mallory", password: "longenoughpassword" });
  assert.equal(r.status, 400);
});

test("an invite is single-use", async () => {
  const url = await createInvite("once@test.local", null, OWNER);
  const token = new URL(url).searchParams.get("token")!;
  const a = await post("/register", { token, name: "Once", password: "longenoughpassword" });
  assert.equal(a.status, 200);
  const b = await post("/register", { token, name: "Twice", password: "longenoughpassword" });
  assert.equal(b.status, 400, "the invite cannot be reused");
});

test("weak passwords are rejected at registration", async () => {
  const url = await createInvite("weak@test.local", null, OWNER);
  const token = new URL(url).searchParams.get("token")!;
  const r = await post("/register", { token, name: "Weak", password: "short" });
  assert.equal(r.status, 400);
});

// ---- login security ----
test("login with the wrong password is a generic 401", async () => {
  const url = await createInvite("bob@test.local", null, OWNER);
  await post("/register", { token: new URL(url).searchParams.get("token")!, name: "Bob", password: "bob's real password" });
  const bad = await post("/login", { email: "bob@test.local", password: "guessing" });
  assert.equal(bad.status, 401);
});

test("login for an unknown account is a generic 401 (no enumeration)", async () => {
  const r = await post("/login", { email: "ghost@test.local", password: "whateverlong" });
  assert.equal(r.status, 401);
});

// ---- invite endpoint is owner-only ----
test("/auth/invite requires an owner session", async () => {
  const anon = await post("/invite", { email: "x@test.local" });
  assert.equal(anon.status, 403);
});

// ---- misc hardening ----
test("callback with a bogus token sets no session", async () => {
  const r = await auth.request("/callback?token=nope");
  assert.equal(r.headers.get("location"), "/?login=expired");
  assert.equal(sessionFromSetCookie(r.headers.get("set-cookie")), null);
});

test("/auth/me with no cookie is 401", async () => {
  const r = await auth.request("/me");
  assert.equal(r.status, 401);
});

test("invalid email is rejected with 400", async () => {
  const r = await post("/request", { email: "not-an-email" });
  assert.equal(r.status, 400);
});
