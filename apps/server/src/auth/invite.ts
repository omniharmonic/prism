/**
 * Invitations — the only way (besides the owner) to get an account. The owner
 * issues an invite for an email; we email a one-time link to /accept-invite,
 * where the recipient sets a name + password. Only the SHA-256 hash of the token
 * is stored; single-use, 7-day TTL. Registration is gated to a valid invite, so
 * no stranger can self-provision an account.
 */
import { randomBytes, createHash } from "node:crypto";
import { config } from "../config";
import { storeInvite, getValidInvite, acceptInvite, type Invite } from "../db";
import { sendEmail } from "./email";

const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Create + email an invite. Returns the accept URL (handy for owner UX/tests). */
export async function createInvite(email: string, name: string | null, createdBy: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const token = randomBytes(32).toString("base64url");
  storeInvite(hash(token), normalized, name, createdBy, TTL_MS);
  const url = `${config.appOrigin}/accept-invite?token=${encodeURIComponent(token)}`;
  await sendEmail(
    normalized,
    "You're invited to Prism",
    `<p>${createdBy} invited you to collaborate in Prism.</p>` +
      `<p><a href="${url}">Create your account</a> to access what they've shared with you.</p>` +
      `<p>This invite expires in 7 days.</p>`,
    url,
  );
  return url;
}

/** Peek at an invite by token (for the registration screen to show the email). */
export function inviteForToken(token: string): Invite | null {
  return getValidInvite(hash(token));
}

/** Consume an invite (marks it accepted). Returns it, or null if invalid. */
export function consumeInvite(token: string): Invite | null {
  const inv = getValidInvite(hash(token));
  if (!inv) return null;
  acceptInvite(inv.token_hash);
  return inv;
}
