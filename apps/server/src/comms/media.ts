/**
 * Comms media + avatar tokens (Task 10). The Comms client never sees Matrix
 * credentials or a raw mxc:// URL: the projection hands it an opaque, short-lived
 * token minted here, and `GET /api/comms/media/:token` (comms/media-route.ts)
 * streams the bytes from the homeserver's authenticated media.
 *
 * Token = base64url(JSON {v, m: mxc, t: thumb|null, d: deviceId|"session", x: exp ms})
 *         + "." + base64url(HMAC-SHA256(payload bytes)), keyed by a key derived
 *         from SECRETS_KEY with the label "comms-media". A token is bound to ONE
 *         credential: the device it was minted for, or "session" for a browser
 *         cookie session; any other credential is refused (403). The owner
 *         binding is the route's `requireCommsOwner`, so no email rides along.
 *
 * Expiry is BUCKETED: exp = the next hour boundary + ttl, so the same (mxc,
 * thumb, credential) mints the SAME token for an hour — the URL is stable and
 * the client's `max-age` cache actually hits across projection fetches.
 */
import crypto from "node:crypto";
import { deriveSecretKey } from "../secrets";
import { parseMxc, type MatrixClient, type MatrixCreds } from "../worker/matrix";

// ── media refs ──────────────────────────────────────────────────────────────
// A token names ONE piece of source media by a ref: a Matrix `mxc://server/id`, or a
// BlueBubbles ref (`bb://attachment/<b64url guid>` | `bb://contact/<b64url address>`) that
// the media route streams from the local BlueBubbles Server. Strictly parsed both ways, so a
// ref can never steer a request anywhere else.
const BB_REF_RE = /^bb:\/\/(attachment|contact)\/([A-Za-z0-9_-]{1,400})$/;
export type BbRef = { kind: "attachment" | "contact"; value: string };
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
function bbRef(kind: BbRef["kind"], value: string): string | null {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return `bb://${kind}/${b64(value)}`;
}
export const bbAttachmentRef = (guid: string): string | null => bbRef("attachment", guid);
export const bbContactRef = (address: string): string | null => bbRef("contact", address);
export function parseBbRef(ref: unknown): BbRef | null {
  if (typeof ref !== "string" || ref.length > 512) return null;
  const m = BB_REF_RE.exec(ref);
  if (!m) return null;
  const value = Buffer.from(m[2]!, "base64url").toString("utf8");
  // Round-trip exact (no lenient base64 aliases) and the same value rules as minting.
  return bbRef(m[1] as BbRef["kind"], value) === ref ? { kind: m[1] as BbRef["kind"], value } : null;
}
/** A ref a media token may carry. */
export const isMediaRef = (ref: unknown): ref is string => !!parseMxc(ref) || !!parseBbRef(ref);

export const MEDIA_TOKEN_TTL_MS = 6 * 60 * 60_000;
export const MEDIA_TOKEN_BUCKET_MS = 60 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_TOKEN_CHARS = 2048;
export const THUMB_SIZES = [64, 128, 256, 512, 1024] as const;

export type Thumb = { w: number; h: number };
export type MediaClaims = { mxc: string; thumb: Thumb | null; device: string; exp: number };

/** Round one dimension UP to the next allowed size (64…1024); junk → 64. */
function clampDim(n: number): number {
  if (!Number.isFinite(n) || n <= 64) return 64;
  return THUMB_SIZES.find((s) => s >= n) ?? 1024;
}
export const clampThumb = (t: Thumb): Thumb => ({ w: clampDim(t.w), h: clampDim(t.h) });
const isAllowedThumb = (t: unknown): t is Thumb =>
  !!t && typeof t === "object" &&
  (THUMB_SIZES as readonly number[]).includes((t as Thumb).w) &&
  (THUMB_SIZES as readonly number[]).includes((t as Thumb).h);

const key = (): Buffer => deriveSecretKey("comms-media");
const sign = (payload: string): Buffer => crypto.createHmac("sha256", key()).update(payload).digest();

/** The binding a request's credential carries: its device id, else "session". */
export const credentialBinding = (actor: { deviceId?: string }): string => actor.deviceId ?? "session";

export function mintMediaToken(
  mxc: string,
  actor: { email: string; deviceId?: string },
  opts: { thumb?: Thumb; ttlMs?: number; now?: number } = {},
): string {
  if (!isMediaRef(mxc)) throw new Error("mintMediaToken: not a media ref");
  if (!actor || typeof actor !== "object") throw new Error("mintMediaToken: actor required");
  if (actor.deviceId !== undefined && (typeof actor.deviceId !== "string" || !actor.deviceId))
    throw new Error("mintMediaToken: invalid device id");
  const ttl = Math.min(opts.ttlMs ?? MEDIA_TOKEN_TTL_MS, MAX_TTL_MS);
  const now = opts.now ?? Date.now();
  const nextHour = (Math.floor(now / MEDIA_TOKEN_BUCKET_MS) + 1) * MEDIA_TOKEN_BUCKET_MS;
  const body = {
    v: 1,
    m: mxc,
    t: opts.thumb ? clampThumb(opts.thumb) : null,
    d: credentialBinding(actor),
    x: nextHour + ttl,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload).toString("base64url")}`;
}

export type VerifyResult = { ok: true; claims: MediaClaims } | { ok: false; status: 403 | 410 };

/**
 * Check a token for THIS request's credential. Signature first (constant time),
 * then shape, then the binding (device|"session"), then expiry — so an
 * expired token only ever reads 410 to the credential it was minted for.
 */
export function verifyMediaToken(
  token: string,
  actor: { deviceId?: string },
  now = Date.now(),
  opts: { acceptExpiredForMs?: number } = {},
): VerifyResult {
  const deny = { ok: false as const, status: 403 as const };
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return deny;
  const parts = token.split(".");
  if (parts.length !== 2) return deny;
  const [payload, sig] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return deny;
  const given = Buffer.from(sig, "base64url");
  const want = sign(payload);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return deny;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return deny;
  }
  if (!body || typeof body !== "object" || body.v !== 1) return deny;
  const { m, t, d, x } = body;
  if (!isMediaRef(m) || typeof d !== "string" || typeof x !== "number" || !Number.isFinite(x)) return deny;
  if (t !== null && !isAllowedThumb(t)) return deny;
  if (d !== credentialBinding(actor)) return deny;
  if (x <= now - Math.max(0, opts.acceptExpiredForMs ?? 0)) return { ok: false, status: 410 };
  return { ok: true, claims: { mxc: m as string, thumb: t as Thumb | null, device: d, exp: x } };
}

/** How long after expiry a token can still be exchanged for a fresh one (`refreshMediaToken`). */
export const MEDIA_REFRESH_GRACE_MS = 30 * 24 * 60 * 60_000;

/**
 * A fresh token for the SAME media (same ref, same thumbnail size) for the credential an
 * expired (or live) token was minted for — so a transcript that stayed open past the TTL can
 * still open its photos without refetching every page. Signature and device binding are
 * checked exactly as for a fetch; only expiry is relaxed (up to MEDIA_REFRESH_GRACE_MS).
 * Null when the token is not one this credential may refresh.
 */
export function refreshMediaToken(token: string, actor: { email: string; deviceId?: string }, now = Date.now()): string | null {
  const v = verifyMediaToken(token, actor, now, { acceptExpiredForMs: MEDIA_REFRESH_GRACE_MS });
  if (!v.ok) return null;
  return mintMediaToken(v.claims.mxc, actor, { ...(v.claims.thumb ? { thumb: v.claims.thumb } : {}), now });
}

// ── upstream fetcher seam (tests inject; production = MatrixClient) ──────────

export type MediaFetcher = Pick<MatrixClient, "downloadMedia">;
let fetcherFactory: ((creds: MatrixCreds) => MediaFetcher) | null = null;
export function setCommsMediaFetcherForTests(value: typeof fetcherFactory): void {
  fetcherFactory = value;
}
export const mediaFetcherFor = (creds: MatrixCreds, make: (c: MatrixCreds) => MediaFetcher): MediaFetcher =>
  (fetcherFactory ?? make)(creds);
