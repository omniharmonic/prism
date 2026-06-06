/**
 * Auth routes: request a magic link, redeem it (→ session), log out, and report
 * the current identity. Redemption is a GET (the emailed link) that sets the
 * session cookie and redirects into the app; everything else is JSON.
 */
import { Hono } from "hono";
import { config } from "../config";
import { startSession, endSession, readSession } from "../auth/session";
import { requestMagicLink, redeemMagicLink } from "../auth/magiclink";

export const auth = new Hono();

auth.post("/request", async (c) => {
  const { email } = await c.req.json<{ email?: string }>();
  if (!email || !/.+@.+\..+/.test(email)) return c.json({ error: "invalid_email" }, 400);
  // Always 200 (don't reveal whether an address is known).
  await requestMagicLink(email);
  return c.json({ ok: true });
});

auth.get("/callback", (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect("/?login=error");
  const email = redeemMagicLink(token);
  if (!email) return c.redirect("/?login=expired");
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
  return c.json({ authenticated: true, email: s.email, isOwner: s.email === config.ownerEmail });
});
