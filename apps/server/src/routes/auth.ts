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
import { config, emailEnabled } from "../config";
import { startSession, endSession, readSession } from "../auth/session";
import { requestMagicLink, redeemMagicLink } from "../auth/magiclink";
import { createInvite, inviteForToken, consumeInvite } from "../auth/invite";
import { hashPassword, verifyPassword, passwordProblem } from "../auth/password";
import { getUser, setAccount, setUserPassword, ensureUser, setUserProfile, resolveWorkspaceId, getWorkspace } from "../db";
import { resolveActor } from "../auth/actor";
import { DEVICE_TOKEN_PREFIX, bearerFromHeader, verifyDeviceToken, revokeOtherDevices } from "../auth/device";
import { deviceAuth, pendingDeviceRequest, DEVICE_CONTINUE_PATH } from "./device";
import type { Context } from "hono";

export const auth = new Hono();

// Native sign-in (WP2.1): /auth/device/* + /auth/devices — see routes/device.ts.
auth.route("/", deviceAuth);

/** The signed-in email from a browser session, else from a native device token
 *  (`Authorization: Bearer pd_…`). Used by the self-service account routes a
 *  native client needs; bootstrap-only routes (/set-password) stay session-only. */
function accountIdentity(c: Context): { email: string; deviceId: string | null } | null {
  const s = readSession(c);
  if (s) return { email: s.email, deviceId: null };
  const b = bearerFromHeader(c.req.header("authorization"));
  const dev = b?.startsWith(DEVICE_TOKEN_PREFIX) ? verifyDeviceToken(b) : null;
  return dev ? { email: dev.email, deviceId: dev.id } : null;
}
const accountEmail = (c: Context): string | null => accountIdentity(c)?.email ?? null;

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

// ---- account settings: update your own profile (name + avatar) ----
// Session-gated; anyone signed in manages their OWN account. Email is the account
// identity (primary key) and is NOT changed here. Same endpoint for owner + members.
const MAX_AVATAR_CHARS = 350_000; // ~256KB as a data: URL (client resizes small)
auth.put("/profile", async (c) => {
  const email = accountEmail(c);
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const s = { email };
  const { name, avatar } = await c.req.json<{ name?: string; avatar?: string | null }>().catch(() => ({}) as { name?: string; avatar?: string | null });
  const patch: { name?: string; avatar?: string | null } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.length > 120) return c.json({ error: "invalid_name" }, 400);
    patch.name = name.trim();
  }
  if (avatar !== undefined) {
    if (avatar === null || avatar === "") {
      patch.avatar = null;
    } else if (typeof avatar !== "string" || !avatar.startsWith("data:image/") || avatar.length > MAX_AVATAR_CHARS) {
      return c.json({ error: "invalid_avatar", detail: "avatar must be a small data:image/ URL" }, 400);
    } else {
      patch.avatar = avatar;
    }
  }
  if (patch.name === undefined && patch.avatar === undefined) return c.json({ error: "nothing_to_update" }, 400);
  setUserProfile(s.email, patch);
  const u = getUser(s.email);
  return c.json({ ok: true, name: u?.name ?? null, avatar: u?.avatar ?? null });
});

// ---- change your password (verifies the current one) ----
// Distinct from /set-password (owner/first-run bootstrap, no current password):
// this requires the existing password, so a hijacked session can't silently
// change it. If the account has no password yet, a browser SESSION may set the
// first one; a native device token may NOT (WP2.1 L2 — a stolen device token must
// never be able to mint a password, i.e. a new login method). On success every
// OTHER device token of the account is revoked (the calling device, if any, is
// kept), so a password change also evicts devices a thief may hold.
auth.post("/change-password", async (c) => {
  const who = accountIdentity(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const s = { email: who.email };
  const { currentPassword, newPassword } = await c.req.json<{ currentPassword?: string; newPassword?: string }>().catch(() => ({}) as { currentPassword?: string; newPassword?: string });
  const pwErr = passwordProblem(newPassword ?? "");
  if (pwErr) return c.json({ error: pwErr }, 400);
  const u = getUser(s.email);
  if (!u?.password_hash && who.deviceId) {
    return c.json({ error: "password_setup_requires_browser", detail: "Set your first password from a signed-in browser." }, 403);
  }
  if (u?.password_hash && !verifyPassword(currentPassword ?? "", u.password_hash)) {
    return c.json({ error: "wrong_password" }, 403);
  }
  setUserPassword(s.email, hashPassword(newPassword!));
  const revokedDevices = await revokeOtherDevices(s.email, who.deviceId);
  return c.json({ ok: true, revokedDevices });
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
  // `emailDelivery` is a server-wide config fact (is Resend set?), NOT per-user —
  // so it leaks nothing about who's allowed, but lets the UI tell a no-Resend
  // operator to read the link from the server console instead of waiting on email.
  return c.json({ ok: true, emailDelivery: emailEnabled() }); // never reveal who is allowed
});

auth.get("/callback", (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect("/?login=error");
  const email = redeemMagicLink(token);
  // Defense in depth: even a valid magic link only authenticates the owner.
  if (!email || norm(email) !== config.ownerEmail) return c.redirect("/?login=expired");
  ensureUser(email);
  startSession(c, email);
  // Native sign-in in progress in this browser (WP2.1)? Resume its consent page.
  if (pendingDeviceRequest(c)) return c.redirect(DEVICE_CONTINUE_PATH);
  // First-time owner (no password yet) → nudge them to set one for password login.
  return c.redirect(getUser(email)?.password_hash ? "/" : "/set-password");
});

auth.post("/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});

auth.get("/me", (c) => {
  const email = accountEmail(c);
  if (!email) return c.json({ authenticated: false }, 401);
  const s = { email };
  const u = getUser(s.email);
  // The viewer's role is PER-VAULT (the X-Prism-Vault header, resolved by
  // resolveActor). `isOwner` stays the global server-owner flag; `role` is what
  // the active workspace grants them (owner/admin/member/guest) — this is what
  // the frontend gates its management surfaces on, so a member never fires
  // admin-only /acl/* calls (and gets 403 noise) for a vault they can't manage.
  const actor = resolveActor(c);
  // The active workspace (X-Prism-Workspace header → Host subdomain → default),
  // so the UI can show which workspace is in context + drive the switcher.
  const workspaceId = resolveWorkspaceId({ workspaceHeader: c.req.header("x-prism-workspace"), hostHeader: c.req.header("host") });
  const ws = getWorkspace(workspaceId);
  return c.json({
    authenticated: true,
    email: s.email,
    name: u?.name ?? null,
    avatar: u?.avatar ?? null,
    isOwner: s.email === config.ownerEmail,
    role: actor.kind === "user" ? actor.role : "guest",
    vaultId: actor.vaultId,
    workspace: ws ? { id: ws.id, name: ws.name } : { id: workspaceId, name: workspaceId },
    hasPassword: !!u?.password_hash,
  });
});
