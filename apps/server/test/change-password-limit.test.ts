/**
 * /auth/change-password: wrong CURRENT passwords are rate-limited per account and per client
 * (launch security follow-up), so a lifted session or device token is not a password-guessing
 * oracle. Only failures count; while a budget is spent even the right password answers 429.
 * No clock is read here: the windows are 10 minutes and every assertion is about counts.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { auth, CHANGE_PASSWORD_FAILURES } from "../src/routes/auth";
import { getUser, setAccount } from "../src/db";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { clearRateLimitsForTests } from "../src/middleware/ratelimit";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const change = (cookie: string, ip: string, currentPassword: string, newPassword = "a brand new passphrase") =>
  auth.request("/change-password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "cf-connecting-ip": ip },
    body: JSON.stringify({ currentPassword, newPassword }),
  });

beforeEach(() => {
  resetDb();
  clearRateLimitsForTests("auth-change-password");
});

test("per account: after the failure budget, even the right password is refused (from any address)", async () => {
  setAccount("cp1@x.co", "CP", hashPassword("the old passphrase"));
  const cookie = sessionCookie(makeSession("cp1@x.co"));
  for (let i = 0; i < CHANGE_PASSWORD_FAILURES.account; i++) {
    // A new address each time: the per-account budget is what stops this.
    assert.equal((await change(cookie, `198.51.100.${i + 1}`, `guess ${i}`)).status, 403);
  }
  const locked = await change(cookie, "203.0.113.50", "the old passphrase");
  assert.equal(locked.status, 429);
  assert.equal(((await locked.json()) as { error: string }).error, "rate_limited");
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.ok(verifyPassword("the old passphrase", getUser("cp1@x.co")!.password_hash!), "nothing changed");
  // Another account is not affected.
  setAccount("cp2@x.co", "CP2", hashPassword("second passphrase"));
  assert.equal((await change(sessionCookie(makeSession("cp2@x.co")), "203.0.113.50", "second passphrase")).status, 200);
});

test("per client: one address cannot spread guesses over many accounts", async () => {
  const ip = "192.0.2.77";
  let n = 0;
  for (let a = 0; n < CHANGE_PASSWORD_FAILURES.client; a++) {
    const email = `spread${a}@x.co`;
    setAccount(email, "S", hashPassword("right passphrase"));
    const cookie = sessionCookie(makeSession(email));
    for (let i = 0; i < 2 && n < CHANGE_PASSWORD_FAILURES.client; i++, n++) assert.equal((await change(cookie, ip, "wrong")).status, 403);
  }
  setAccount("fresh@x.co", "F", hashPassword("right passphrase"));
  const fresh = sessionCookie(makeSession("fresh@x.co"));
  assert.equal((await change(fresh, ip, "right passphrase")).status, 429, "this address spent its budget");
  assert.equal((await change(fresh, "192.0.2.78", "right passphrase")).status, 200, "another address is fine");
});

test("successes are not counted", async () => {
  setAccount("ok@x.co", "OK", hashPassword("passphrase number 0"));
  const cookie = sessionCookie(makeSession("ok@x.co"));
  for (let i = 0; i < CHANGE_PASSWORD_FAILURES.account + 3; i++) {
    assert.equal((await change(cookie, "198.51.100.200", `passphrase number ${i}`, `passphrase number ${i + 1}`)).status, 200, `change ${i}`);
  }
});
