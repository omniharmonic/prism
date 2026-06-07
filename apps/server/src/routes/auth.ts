/**
 * Auth routes — invite-only accounts with passwords.
 *
 *  - /login            email + password → session
 *  - /register         accept an invite (token) → set name + password → session
 *  - /invite-info      look up an invite token (so the register screen shows the email)
 *  - /invite           OWNER only: invite an email (creates + emails an invite)
 *  - /set-password     signed-in user sets/changes their password (owner bootstrap)
 *  - /request,/callback OWNER-only magic link, for first-run bootstrap + recovery
 *  - /logout, /me
 *
 * Self-signup is impossible: registration requires a valid owner-issued invite,
 * and the magic link only works for the owner email. Strangers can't authenticate.
 */
import { Hono } from "hono";
import { config } from "../config";
import { startSession, endSession, readSession } from "../auth/session";
import { requestMagicLink, redeemMagicLink } from "../auth/magiclink";
import { createInvite, inviteForToken, consumeInvite } from "../auth/invite";
import { hashPassword, verifyPassword, passwordProblem } from "../auth/password";
import { getUser, setAccount, setUserPassword, ensureUser } from "../db";

export const auth = new Hono();

const norm = (e: string) => e.trim().toLowerCase();
const validEmail = (e?: string): e is string => !!e && /.+@.+\..+/.test(e);

// ---- password login ----
auth.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  if (!validEmail(email) || !password) return c.json({ error: "invalid_credentials" }, 401);
  const u = getUser(norm(email));
  // Constant-ish path + generic error: never reveal whether the account exists.
  if (!u || !verifyPassword(password, u.password_hash)) return c.json({ error: "invalid_credentials" }, 401);
  startSession(c, u.email);
  return c.json({ ok: true, email: u.email, isOwner: u.email === config.ownerEmail });
});

// ---- registration via invite ----
auth.get("/invite-info", (c) => {
  const token = c.req.query("token");
  const inv = token ? inviteForToken(token) : null;
  if (!inv) return c.json({ valid: false }, 404);
  return c.json({ valid: true, email: inv.email, name: inv.name });
});

auth.post("/register", async (c) => {
  const { token, name, password } = await c.req.json<{ token?: string; name?: string; password?: string }>();
  if (!token || !name?.trim()) return c.json({ error: "bad_request" }, 400);
  const pwErr = passwordProblem(password ?? "");
  if (pwErr) return c.json({ error: pwErr }, 400);
  const inv = consumeInvite(token);
  if (!inv) return c.json({ error: "invalid_or_expired_invite" }, 400);
  setAccount(inv.email, name.trim(), hashPassword(password!));
  startSession(c, inv.email);
  return c.json({ ok: true, email: inv.email });
});

// ---- owner bootstrap: set/replace your password while signed in ----
auth.post("/set-password", async (c) => {
  const s = readSession(c);
  if (!s) return c.json({ error: "unauthorized" }, 401);
  const { password, name } = await c.req.json<{ password?: string; name?: string }>();
  const pwErr = passwordProblem(password ?? "");
  if (pwErr) return c.json({ error: pwErr }, 400);
  if (name?.trim()) setAccount(s.email, name.trim(), hashPassword(password!));
  else setUserPassword(s.email, hashPassword(password!));
  return c.json({ ok: true });
});

// ---- owner issues an invite ----
auth.post("/invite", async (c) => {
  const s = readSession(c);
  if (!s || s.email !== config.ownerEmail) return c.json({ error: "forbidden" }, 403);
  const { email, name } = await c.req.json<{ email?: string; name?: string }>();
  if (!validEmail(email)) return c.json({ error: "invalid_email" }, 400);
  const url = await createInvite(norm(email), name?.trim() ?? null, s.email);
  return c.json({ ok: true, url });
});

// ---- owner-only magic link (first-run bootstrap + recovery) ----
auth.post("/request", async (c) => {
  const { email } = await c.req.json<{ email?: string }>();
  if (!validEmail(email)) return c.json({ error: "invalid_email" }, 400);
  if (norm(email) === config.ownerEmail) await requestMagicLink(email);
  return c.json({ ok: true }); // never reveal who is allowed
});

auth.get("/callback", (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect("/?login=error");
  const email = redeemMagicLink(token);
  // Defense in depth: even a valid magic link only authenticates the owner.
  if (!email || norm(email) !== config.ownerEmail) return c.redirect("/?login=expired");
  ensureUser(email);
  startSession(c, email);
  return c.redirect("/");
});

auth.post("/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});

auth.get("/me", (c) => {
  const s = readSession(c);
  if (!s) return c.json({ authenticated: false }, 401);
  const u = getUser(s.email);
  return c.json({
    authenticated: true,
    email: s.email,
    name: u?.name ?? null,
    isOwner: s.email === config.ownerEmail,
    hasPassword: !!u?.password_hash,
  });
});
