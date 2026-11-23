/**
 * QR pairing (launch decision D-G, docs/native-auth.md § Pairing): a phone gets the SAME
 * `pd_` device token PKCE sign-in gives, without typing a server address or a password.
 *
 * A reversed device-authorization grant (RFC 8628, turned around):
 *
 *   Mac (signed-in owner)                 Server                         Phone
 *   start ───────────────────────────────▶ pairing {codeHash, 5 min}
 *   ◀── {pairingId, code, link} ── shows the QR: prism://pair?v=1&s=<origin>&c=<code>
 *                                                                      scan → verifier
 *                                         ◀── claim {code, challenge, label, platform}
 *                                         claimed ───────────────────▶ {claimId, checkCode}
 *   status ◀── "claimed: <label>"                                      shows checkCode
 *   approve {checkCode typed from phone} ▶ approved
 *                                         ◀── token {claimId, verifier} (polled)
 *                                         issueDeviceToken ──────────▶ {access_token: pd_…}
 *
 * Rules (each pinned by test/pairing.test.ts):
 *  - only the SERVER OWNER starts, sees and decides a pairing, as a person (browser session
 *    or `pd_` device token — never an agent, a link, a PAT or the loopback token), and only
 *    for their own account; writes pass `csrfRefusal`;
 *  - only while APP_ORIGIN is an address a phone can reach (`reachableOrigin`): a QR never
 *    carries a loopback or placeholder origin;
 *  - the code is 128 bits, stored as SHA-256 only, lives 5 minutes, and is bound to ONE
 *    claim: a second claim of the same code voids the pairing (`contested`);
 *  - the claim id (returned only to the claimer) is stored as SHA-256 only; the token step is
 *    PKCE S256-bound (a wrong verifier kills the pairing) and single use — a replay after the
 *    token was issued revokes that device (the device-code rule);
 *  - approving needs the 4-digit check code the PHONE shows, typed on the Mac (3 wrong tries
 *    end the pairing) — so the owner cannot approve a phone they are not holding;
 *  - "one door" (auth/device-confirm.ts): once the owner has a live device, a browser session
 *    alone cannot add another — the approval must come from an existing device (`pd_`);
 *  - starting a pairing ends the account's earlier open ones;
 *  - the token is minted by `issueDeviceToken`, the same function `/auth/device/token` uses,
 *    so the device is an ordinary row in Signed-in devices and revokes like any other.
 *
 * The table is created here (not in db.ts) so the module is self-contained.
 */
import { randomInt } from "node:crypto";
import { db } from "../db";
import { NATIVE_CLIENT_ID, randomId, sha256hex, s256, safeEqual, sanitizeLabel } from "./device";

export const PAIR_TTL_MS = 5 * 60_000;
/** How often the phone polls the token step (seconds). */
export const PAIR_POLL_INTERVAL_S = 2;
/** Wrong check codes allowed before the pairing ends. */
export const PAIR_MAX_CHECK_TRIES = 3;
/** The link scheme the apps register (Info.plist `prism`). */
export const PAIR_LINK_PREFIX = "prism://pair";

db.exec(`
  CREATE TABLE IF NOT EXISTS device_pairings (
    id              TEXT PRIMARY KEY,
    code_hash       TEXT NOT NULL UNIQUE,
    email           TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    status          TEXT NOT NULL,      -- pending | claimed | contested | approved | denied | failed | completed | replaced
    claim_hash      TEXT UNIQUE,
    code_challenge  TEXT,
    label           TEXT,
    platform        TEXT,
    check_code      TEXT,
    check_tries     INTEGER NOT NULL DEFAULT 0,
    claimed_at      INTEGER,
    decided_at      INTEGER,
    device_id       TEXT
  );
  CREATE INDEX IF NOT EXISTS device_pairings_email ON device_pairings(email);
`);

export type PairingStatus = "pending" | "claimed" | "contested" | "approved" | "denied" | "failed" | "completed" | "replaced" | "expired";

interface Row {
  id: string;
  code_hash: string;
  email: string;
  created_at: number;
  expires_at: number;
  status: Exclude<PairingStatus, "expired">;
  claim_hash: string | null;
  code_challenge: string | null;
  label: string | null;
  platform: string | null;
  check_code: string | null;
  check_tries: number;
  claimed_at: number | null;
  decided_at: number | null;
  device_id: string | null;
}

let clock: () => number = () => Date.now();
/** Tests move time instead of waiting (no wall-clock assertions). */
export function setPairingClock(f: (() => number) | null): void {
  clock = f ?? (() => Date.now());
}

/** A pairing whose time ran out reads as `expired`, whatever it was (except finished ones). */
function effective(r: Row): PairingStatus {
  if (r.status === "completed" || r.status === "denied" || r.status === "contested" || r.status === "failed" || r.status === "replaced") return r.status;
  return r.expires_at <= clock() ? "expired" : r.status;
}

const get = (id: string): Row | undefined => db.prepare("SELECT * FROM device_pairings WHERE id = ?").get(id) as Row | undefined;
const setStatus = (id: string, from: string, to: string, extra = ""): boolean =>
  db.prepare(`UPDATE device_pairings SET status = ?, decided_at = ?${extra} WHERE id = ? AND status = ?`).run(to, clock(), id, from).changes > 0;

/** The QR payload. `origin` must already be a reachable https origin (checked by the route). */
export function pairingLink(origin: string, code: string): string {
  return `${PAIR_LINK_PREFIX}?v=1&s=${encodeURIComponent(origin)}&c=${code}`;
}

/** Start a pairing for `email`. Ends the account's earlier open pairings. The code is returned once. */
export function startPairing(email: string): { id: string; code: string; expiresAt: number } {
  const t = clock();
  db.prepare("DELETE FROM device_pairings WHERE expires_at < ?").run(t - 24 * 60 * 60_000);
  db.prepare("UPDATE device_pairings SET status = 'replaced', decided_at = ? WHERE email = ? AND status IN ('pending','claimed','approved')").run(t, email);
  const code = randomId(16); // 128 bits → 22 base64url chars
  const id = `pair_${randomId(12)}`;
  db.prepare("INSERT INTO device_pairings (id, code_hash, email, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'pending')").run(
    id,
    sha256hex(code),
    email,
    t,
    t + PAIR_TTL_MS,
  );
  return { id, code, expiresAt: t + PAIR_TTL_MS };
}

/** A pairing code has exactly the shape `startPairing` mints. */
export const isPairingCode = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v);
const isClaimId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const PLATFORMS = new Set(["ios", "ipados", "macos"]);

export type ClaimResult =
  | { ok: true; pairingId: string; email: string; claimId: string; checkCode: string; expiresIn: number }
  | { ok: false; error: "invalid_code" | "already_used" | "expired"; pairingId?: string; email?: string };

/** The phone claims the code it scanned. The FIRST valid claim wins; a second one voids it. */
export function claimPairing(code: string, challenge: string, label: unknown, platform: unknown): ClaimResult {
  const r = db.prepare("SELECT * FROM device_pairings WHERE code_hash = ?").get(sha256hex(code)) as Row | undefined;
  if (!r) return { ok: false, error: "invalid_code" };
  const st = effective(r);
  if (st === "expired") return { ok: false, error: "expired", pairingId: r.id, email: r.email };
  if (st !== "pending") {
    // Bound to one claim: anyone else using the same code ends a pairing still in progress.
    if (st === "claimed" || st === "approved") setStatus(r.id, r.status, "contested");
    return { ok: false, error: "already_used", pairingId: r.id, email: r.email };
  }
  const claimId = randomId(32);
  const checkCode = String(randomInt(0, 10_000)).padStart(4, "0");
  const plat = typeof platform === "string" && PLATFORMS.has(platform) ? platform : "unknown";
  const changed = db
    .prepare(
      "UPDATE device_pairings SET status = 'claimed', claim_hash = ?, code_challenge = ?, label = ?, platform = ?, check_code = ?, claimed_at = ? WHERE id = ? AND status = 'pending'",
    )
    .run(sha256hex(claimId), challenge, sanitizeLabel(label, "Prism app"), plat, checkCode, clock(), r.id).changes;
  if (!changed) return { ok: false, error: "already_used", pairingId: r.id, email: r.email };
  return { ok: true, pairingId: r.id, email: r.email, claimId, checkCode, expiresIn: Math.max(0, Math.floor((r.expires_at - clock()) / 1000)) };
}

export interface PairingView {
  id: string;
  status: PairingStatus;
  expiresAt: number;
  /** The phone's claim — a CLAIM made by whoever scanned, never a fact. */
  label?: string;
  platform?: string;
}

/** The creator's view (no code, no check code: the owner reads that from the phone). */
export function pairingFor(email: string, id: string): PairingView | null {
  const r = get(id);
  if (!r || r.email !== email) return null;
  const status = effective(r);
  return {
    id: r.id,
    status,
    expiresAt: r.expires_at,
    ...(r.label && status !== "pending" ? { label: r.label, platform: r.platform ?? "unknown" } : {}),
  };
}

export type DecideResult = { ok: true } | { ok: false; error: "not_found" | "not_claimed" | "expired" | "wrong_check_code" | "too_many_tries"; triesLeft?: number };

/** Approve (with the check code the phone shows) or deny a claimed pairing. */
export function decidePairing(email: string, id: string, decision: "approve" | "deny", checkCode?: unknown): DecideResult {
  const r = get(id);
  if (!r || r.email !== email) return { ok: false, error: "not_found" };
  const st = effective(r);
  if (st === "expired") return { ok: false, error: "expired" };
  if (decision === "deny") {
    if (st !== "pending" && st !== "claimed" && st !== "approved") return { ok: false, error: "not_claimed" };
    return setStatus(r.id, r.status, "denied") ? { ok: true } : { ok: false, error: "not_claimed" };
  }
  if (st !== "claimed") return { ok: false, error: "not_claimed" };
  const typed = typeof checkCode === "string" ? checkCode.replace(/\s+/g, "") : "";
  if (!r.check_code || !/^\d{4}$/.test(typed) || !safeEqual(typed, r.check_code)) {
    const tries = r.check_tries + 1;
    if (tries >= PAIR_MAX_CHECK_TRIES) {
      db.prepare("UPDATE device_pairings SET check_tries = ?, status = 'failed', decided_at = ? WHERE id = ? AND status = 'claimed'").run(tries, clock(), r.id);
      return { ok: false, error: "too_many_tries" };
    }
    db.prepare("UPDATE device_pairings SET check_tries = ? WHERE id = ?").run(tries, r.id);
    return { ok: false, error: "wrong_check_code", triesLeft: PAIR_MAX_CHECK_TRIES - tries };
  }
  return setStatus(r.id, "claimed", "approved") ? { ok: true } : { ok: false, error: "not_claimed" };
}

export type TokenStep =
  | { kind: "pending" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "invalid" }
  /** Approved and not yet redeemed: mint now, through `issueDeviceTokenClaimed` with `completePairingClaim`. */
  | { kind: "issue"; pairingId: string; email: string; label: string; clientId: string }
  /** The token was already issued: whoever presents the claim again may hold a copy. */
  | { kind: "replay"; pairingId: string; email: string; deviceId: string | null };

/** The phone's poll: `{claimId, code_verifier}`. Claims the right to mint ATOMICALLY. */
export function redeemPairing(claimId: unknown, verifier: string): TokenStep {
  if (!isClaimId(claimId)) return { kind: "invalid" };
  const r = db.prepare("SELECT * FROM device_pairings WHERE claim_hash = ?").get(sha256hex(claimId)) as Row | undefined;
  if (!r || !r.code_challenge) return { kind: "invalid" };
  // PKCE: the claim id alone is not enough. A wrong verifier ends the pairing (no retries).
  if (!safeEqual(s256(verifier), r.code_challenge)) {
    if (r.status === "claimed" || r.status === "approved") setStatus(r.id, r.status, "failed");
    return { kind: "invalid" };
  }
  // Claim + verifier presented again after the token was issued: the device-code rule.
  if (r.status === "completed") return { kind: "replay", pairingId: r.id, email: r.email, deviceId: r.device_id };
  const st = effective(r);
  if (st === "claimed") return { kind: "pending" };
  if (st === "expired") return { kind: "expired" };
  if (st !== "approved") return { kind: "denied" };
  // Only one poll may mint (two concurrent polls must not make two devices): the claim is
  // `completePairingClaim`, run inside the mint's transaction.
  return { kind: "issue", pairingId: r.id, email: r.email, label: r.label ?? "Prism app", clientId: NATIVE_CLIENT_ID };
}

/**
 * The single-use claim of an approved pairing AND the device it minted, in ONE statement: the
 * pairing never reads "completed" without naming its device, so a replay at any point
 * revokes it. False = another poll won (or it is no longer approved).
 */
export function completePairingClaim(id: string, deviceId: string): boolean {
  return db.prepare("UPDATE device_pairings SET status = 'completed', decided_at = ?, device_id = ? WHERE id = ? AND status = 'approved'").run(clock(), deviceId, id).changes > 0;
}

/** The device a completed pairing minted (after a lost claim: the winner's). */
export function pairingDevice(id: string): string | null {
  return get(id)?.device_id ?? null;
}

export function resetPairingsForTests(): void {
  db.exec("DELETE FROM device_pairings");
}
