/**
 * One-time SEND GRANTS — the "one door" (owner requirement, 2026-10-15): nothing is sent
 * to another person unless the owner approved that EXACT message from a signed-in device.
 *
 * The agent repo's send scripts (proton_send.py, omni_tweet_send.py, matrix_reader.py
 * send/send-to, twitter_post.py) refuse to send unless they hold a grant that THIS
 * process minted. A grant is minted only by an Omni executor, only after
 * `claimApproval` atomically claimed a pending, unexpired approval whose digest matched
 * what the person saw, on a human-origin (session/device) decision. It is:
 *
 *  - SHORT-LIVED: ≤ 60 s (`GRANT_TTL_MS`).
 *  - SINGLE-USE: the verify call consumes it whatever the outcome (a wrong digest burns
 *    it too — a grant can never be retried with other content).
 *  - BOUND to (approval id, send digest): the digest covers the exact fields the script
 *    is about to send (recipients, subject, body …), computed independently by the
 *    script from its own argv/stdin with the SAME encoding (`sendDigest`; the Python
 *    twin is scripts/send_grant.py). A script handed different bytes cannot verify.
 *  - LIVE ONLY WHILE THE APPROVAL IS CLAIMED: the approval must still be `approved`
 *    (claimed, not yet finished) when the grant is presented.
 *
 * The token travels to the child process in its environment (never argv, never a file)
 * and is stored here only as a SHA-256 hash. Grants live in memory: a restart revokes
 * every outstanding grant, which is the safe direction (the executor then reports the
 * send as failed/unknown, never as sent).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const GRANT_TTL_MS = 60_000;
/** Env names the executor sets on the child (the script reads exactly these). */
export const GRANT_ENV = { token: "PRISM_SEND_GRANT", approval: "PRISM_SEND_GRANT_APPROVAL" } as const;

export type SendChannel = "email" | "tweet" | "message";

/**
 * The send digest: SHA-256 (hex) over a length-prefixed, ordered encoding of the fields
 * a sender is about to put on the wire. Length prefixes (UTF-8 byte counts) make the
 * encoding unambiguous without any JSON canonicalisation that two languages could
 * disagree on. Field order is fixed per channel; an absent value is an empty list.
 *
 *   "prism-send-grant/v1\n" <channel> "\n"
 *   for each field:  <name> "\n" <count> "\n"  then for each value: <bytes> ":" <value> "\n"
 */
export function sendDigest(channel: SendChannel, fields: ReadonlyArray<readonly [string, ReadonlyArray<string>]>): string {
  const h = createHash("sha256");
  h.update(`prism-send-grant/v1\n${channel}\n`, "utf8");
  for (const [name, values] of fields) {
    h.update(`${name}\n${values.length}\n`, "utf8");
    for (const v of values) {
      h.update(`${Buffer.byteLength(v, "utf8")}:`, "utf8");
      h.update(v, "utf8");
      h.update("\n", "utf8");
    }
  }
  return h.digest("hex");
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
const one = (v: unknown): string[] => (typeof v === "string" ? [v] : []);

/** Digest of an approved email / email-reply, exactly as proton_send.py receives it. */
export function emailSendDigest(kind: "email" | "email-reply", p: Record<string, unknown>): string {
  return sendDigest("email", [
    ["to", kind === "email" ? strs(p.to) : strs(p.expectTo)],
    ["cc", strs(p.cc)],
    ["subject", kind === "email" ? one(p.subject) : []],
    ["reply_to_note", kind === "email-reply" ? one(p.noteId) : []],
    ["in_reply_to", []],
    ["references", []],
    ["body", one(p.body)],
  ]);
}
/** Digest of an approved tweet, exactly as omni_tweet_send.py receives it. */
export const tweetSendDigest = (text: string): string => sendDigest("tweet", [["text", [text]]]);
/** Digest of an approved chat message (room id as resolved by the sender, body). */
export const messageSendDigest = (roomId: string, body: string): string => sendDigest("message", [["room_id", [roomId]], ["body", [body]]]);

type Grant = { approvalId: string; digest: string; expiresAt: number };
const grants = new Map<string, Grant>();
let now: () => number = () => Date.now();
export function setGrantClockForTests(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

const hashToken = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function sweep(): void {
  const t = now();
  for (const [k, g] of grants) if (g.expiresAt <= t) grants.delete(k);
}

/** Mint a grant for a CLAIMED approval and the digest of what the executor will hand the script. */
export function mintSendGrant(approvalId: string, digest: string, ttlMs = GRANT_TTL_MS): string {
  if (!DIGEST_RE.test(digest)) throw new Error("mintSendGrant: digest must be 64 hex characters");
  sweep();
  const token = randomBytes(32).toString("base64url");
  grants.set(hashToken(token), { approvalId, digest, expiresAt: now() + Math.min(Math.max(1, ttlMs), GRANT_TTL_MS) });
  return token;
}
/** Withdraw a grant the executor no longer needs (the child exited, or never started). */
export function revokeSendGrant(token: string): void {
  if (typeof token === "string") grants.delete(hashToken(token));
}

export type GrantVerdict = { ok: true } | { ok: false; error: "invalid_grant" | "expired" | "wrong_approval" | "digest_mismatch" | "approval_not_claimed" };

/**
 * Verify AND consume. Any presentation of a known token removes it, whatever the
 * verdict: a grant is never usable twice, and never usable for other content.
 * `approvalStatus` is the approval's current status (it must still be `approved`).
 */
export function consumeSendGrant(approvalId: string, token: unknown, digest: unknown, approvalStatus: (id: string) => string | null): GrantVerdict {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, error: "invalid_grant" };
  const key = hashToken(token);
  const g = grants.get(key);
  if (!g) return { ok: false, error: "invalid_grant" };
  grants.delete(key); // single use: consumed before any other check
  if (g.expiresAt <= now()) return { ok: false, error: "expired" };
  if (g.approvalId !== approvalId) return { ok: false, error: "wrong_approval" };
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return { ok: false, error: "digest_mismatch" };
  const a = Buffer.from(g.digest);
  const b = Buffer.from(digest);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "digest_mismatch" };
  if (approvalStatus(approvalId) !== "approved") return { ok: false, error: "approval_not_claimed" };
  return { ok: true };
}

/** For tests: how many grants are outstanding. */
export const outstandingGrants = (): number => (sweep(), grants.size);
