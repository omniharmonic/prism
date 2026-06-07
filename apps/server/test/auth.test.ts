/**
 * End-to-end magic-link sign-in through the real /auth Hono app:
 * request → (capture emailed token) → callback sets a session cookie →
 * /auth/me reflects identity → logout clears it. Also pins the security
 * properties: single-use tokens, bad/expired tokens redirect without a session,
 * no session means 401, and /auth/request never reveals whether an address is
 * known (always 200).
 *
 * With no RESEND_API_KEY (the test env), requestMagicLink logs the link to the
 * console — we intercept that to obtain the one-time token a real user would
 * click in their email.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { auth } from "../src/routes/auth";
import { resetDb } from "./helpers";

const OWNER = "owner@test.local";

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

/** Drive POST /auth/request and pull the one-time token out of the dev log line. */
async function requestAndCaptureToken(email: string): Promise<string> {
  const r = await auth.request("/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const line = logs.find((l) => l.includes("/auth/callback?token="));
  assert.ok(line, "expected a magic-link log line");
  return new URL(line!.split(" → ")[1]!).searchParams.get("token")!;
}

const sessionFromSetCookie = (h: string | null): string | null =>
  h?.match(/prism_session=([^;]+)/)?.[1] ?? null;

test("full flow: request → callback → me → logout", async () => {
  const token = await requestAndCaptureToken(OWNER);

  // Callback redeems the token and sets the session cookie.
  const cb = await auth.request(`/callback?token=${encodeURIComponent(token)}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/");
  const sid = sessionFromSetCookie(cb.headers.get("set-cookie"));
  assert.ok(sid, "callback should set a session cookie");

  // /auth/me reflects the signed-in identity (and owner flag).
  const me = await auth.request("/me", { headers: { cookie: `prism_session=${sid}` } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { authenticated: true, email: OWNER, isOwner: true });

  // Logout destroys the session; /auth/me is now 401.
  const out = await auth.request("/logout", { method: "POST", headers: { cookie: `prism_session=${sid}` } });
  assert.equal(out.status, 200);
  const after = await auth.request("/me", { headers: { cookie: `prism_session=${sid}` } });
  assert.equal(after.status, 401);
});

test("a non-owner who signs in is not flagged as owner", async () => {
  const token = await requestAndCaptureToken("someone@test.local");
  const cb = await auth.request(`/callback?token=${encodeURIComponent(token)}`);
  const sid = sessionFromSetCookie(cb.headers.get("set-cookie"))!;
  const me = (await (await auth.request("/me", { headers: { cookie: `prism_session=${sid}` } })).json()) as { isOwner: boolean };
  assert.equal(me.isOwner, false);
});

test("magic-link tokens are single-use: the second callback fails", async () => {
  const token = await requestAndCaptureToken(OWNER);
  const first = await auth.request(`/callback?token=${encodeURIComponent(token)}`);
  assert.equal(first.headers.get("location"), "/"); // success
  const second = await auth.request(`/callback?token=${encodeURIComponent(token)}`);
  assert.equal(second.headers.get("location"), "/?login=expired"); // reuse rejected
});

test("a bogus token redirects to the expired/error page without a session", async () => {
  const r = await auth.request("/callback?token=not-a-real-token");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/?login=expired");
  assert.equal(sessionFromSetCookie(r.headers.get("set-cookie")), null);
});

test("callback with no token redirects to the error page", async () => {
  const r = await auth.request("/callback");
  assert.equal(r.headers.get("location"), "/?login=error");
});

test("/auth/me with no cookie is 401", async () => {
  const r = await auth.request("/me");
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { authenticated: false });
});

test("invalid email is rejected with 400", async () => {
  const r = await auth.request("/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  assert.equal(r.status, 400);
});

test("/auth/request always returns 200 (no account enumeration)", async () => {
  // Two different addresses — known or not, the response is identical.
  for (const email of ["owner@test.local", "stranger@nowhere.test"]) {
    const r = await auth.request("/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  }
});
