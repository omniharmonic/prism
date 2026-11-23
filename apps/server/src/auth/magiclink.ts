/**
 * Magic-link sign-in. We email a one-time link; clicking it proves control of
 * the address and starts a session. Only the SHA-256 hash of the token is
 * stored (so a db leak can't be replayed), single-use, 15-min TTL. If no email
 * provider (Resend) is configured, the link is logged to the server console —
 * a dev-only fallback so local sign-in works without sending mail.
 */
import { randomBytes, createHash } from "node:crypto";
import { config } from "../config";
import { storeMagicLink, consumeMagicLink } from "../db";
import { sendEmail } from "./email";

const TTL_MS = 1000 * 60 * 15; // 15 minutes

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export async function requestMagicLink(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const token = randomBytes(32).toString("base64url");
  storeMagicLink(hash(token), normalized, TTL_MS);
  const url = `${config.appOrigin}/auth/callback?token=${encodeURIComponent(token)}`;
  await sendEmail(
    normalized,
    "Your Prism sign-in link",
    `<p>Click to sign in to Prism:</p><p><a href="${url}">${url}</a></p>` +
      `<p>This link expires in 15 minutes and can be used once.</p>`,
    url,
  );
}

/** Redeem a token: returns the email if valid + unused + unexpired, else null. */
export function redeemMagicLink(token: string): string | null {
  return consumeMagicLink(hash(token));
}
