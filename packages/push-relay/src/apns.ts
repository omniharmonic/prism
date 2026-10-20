/**
 * APNs from the relay: the provider token, the FIXED payloads, one request.
 *
 * PAYLOADS. The relay writes every byte of the APNs body. The copy is the Prism
 * Server's own generic copy (apps/server/src/apns.ts) and the custom keys are the
 * ones the iOS app reads (PrismIosPlugin.swift: `sessionId` / `notificationId` /
 * `url`). Nothing a server sends can change a word of it.
 *
 * PROVIDER TOKEN (ES256 JWT, `kid` = APNS_KEY_ID, `iss` = APNS_TEAM_ID). Apple
 * rejects a token older than 60 min and answers TooManyProviderTokenUpdates when a
 * provider refreshes more often than every 20 min. A Worker runs in many isolates
 * that share nothing, so instead of a per-isolate "mint when old" rule every
 * isolate mints with the SAME `iat`: the start of the current 30-minute bucket.
 * Every isolate's token therefore changes at the same moment, once per 30 min, and
 * is never older than 30 min when used. (Within a bucket each isolate signs its own
 * copy — ECDSA signatures differ — but the claims, and the refresh cadence Apple
 * sees, are identical.)
 *
 * TRANSPORT. `fetch()` to https://api.push.apple.com (or the sandbox host). APNs
 * accepts HTTP/2 only. Cloudflare does not document which HTTP version a Worker's
 * outbound `fetch()` negotiates; this has NOT been verified against Apple from a
 * deployed Worker (no test here reaches Apple). The deploy checklist in README.md
 * ends with a real test notification for exactly this reason. The fetch function
 * is injected so the tests use a fake APNs.
 */
import { b64url, fromB64url, sha256Hex } from "./auth";
import type { Environment, Kind } from "./schema";

export const APNS_ORIGINS: Record<Environment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
export const TOKEN_BUCKET_MS = 30 * 60_000;
/** Same 24 h as the server's notifications. */
export const EXPIRATION_S = 24 * 60 * 60;
export const REQUEST_TIMEOUT_MS = 10_000;

export interface ApnsConfig {
  /** The .p8 file's contents (PEM, PKCS#8, EC P-256). */
  keyP8: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
}

const APPLE_ID = /^[A-Z0-9]{10}$/;
const TOPIC = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;

/** Why the APNs secrets cannot be used, or null. Never quotes key material. */
export function apnsConfigProblem(c: Partial<ApnsConfig>): string | null {
  const missing = [!c.keyP8 && "APNS_KEY_P8", !c.keyId && "APNS_KEY_ID", !c.teamId && "APNS_TEAM_ID", !c.topic && "APNS_TOPIC"].filter(Boolean);
  if (missing.length) return `missing ${missing.join(", ")}`;
  if (!APPLE_ID.test(c.keyId!)) return "APNS_KEY_ID must be the 10-character key id";
  if (!APPLE_ID.test(c.teamId!)) return "APNS_TEAM_ID must be the 10-character team id";
  if (!TOPIC.test(c.topic!)) return "APNS_TOPIC is not a bundle id";
  return null;
}

function pemToPkcs8(pem: string): Uint8Array | null {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) return null;
  return fromB64url(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

const enc = new TextEncoder();
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keyCache = new Map<string, Promise<SigningKey>>();
const tokenCache = new Map<string, { bucket: number; token: string }>();

async function signingKey(pem: string): Promise<SigningKey> {
  let p = keyCache.get(pem);
  if (!p) {
    const der = pemToPkcs8(pem);
    p = der
      ? crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
      : Promise.reject(new Error("APNS_KEY_P8 is not a PEM private key"));
    keyCache.set(pem, p);
    p.catch(() => keyCache.delete(pem));
  }
  return p;
}

/** The provider token for `now`'s 30-minute bucket (cached per isolate). */
export async function providerToken(c: ApnsConfig, now: number): Promise<string> {
  const bucket = Math.floor(now / TOKEN_BUCKET_MS) * TOKEN_BUCKET_MS;
  const cacheKey = `${c.keyId}:${c.teamId}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.bucket === bucket) return hit.token;
  const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: c.keyId })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: c.teamId, iat: Math.floor(bucket / 1000) })));
  const key = await signingKey(c.keyP8);
  // WebCrypto ECDSA already returns IEEE P1363 (r || s), which is what JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  const token = `${header}.${claims}.${b64url(sig)}`;
  tokenCache.set(cacheKey, { bucket, token });
  return token;
}
export function _resetApnsCaches(): void {
  keyCache.clear();
  tokenCache.clear();
}

export interface BuiltNotification {
  body: string;
  collapseId?: string;
}

/** apns-collapse-id is limited to 64 bytes (same rule as the server). */
async function collapseId(s: string): Promise<string> {
  return s.length <= 64 ? s : `h-${(await sha256Hex(s)).slice(0, 40)}`;
}

/** The ENTIRE APNs body for a kind + id. Fixed copy; ids only. */
export async function buildNotification(kind: Kind, id: string | undefined): Promise<BuiltNotification> {
  switch (kind) {
    case "agent":
    case "agent-attention":
      return {
        body: JSON.stringify({
          aps: {
            alert: { title: "Prism", body: kind === "agent" ? "Your agent finished" : "Agent needs attention" },
            sound: "default",
            "thread-id": id,
          },
          type: "agent-turn",
          sessionId: id,
          url: `/agent/${id}`,
        }),
        collapseId: await collapseId(`agent-${id}`),
      };
    case "notification":
      return {
        body: JSON.stringify({
          aps: { alert: { title: "Prism", body: "You have a new notification" }, sound: "default", "thread-id": "prism-inbox" },
          type: "notification",
          notificationId: id,
          url: `/inbox/${id}`,
        }),
        collapseId: await collapseId(`notification-${id}`),
      };
    case "test":
      return {
        body: JSON.stringify({ aps: { alert: { title: "Prism", body: "Notifications are working" }, sound: "default" }, type: "test" }),
        collapseId: "prism-test",
      };
  }
}

export type ApnsResult =
  | { result: "sent" }
  /** The token is dead (410, BadDeviceToken, DeviceTokenNotForTopic): the server drops its row. */
  | { result: "pruned"; reason: string }
  /** Permanent for this request; retrying will not help. */
  | { result: "failed"; reason: string }
  /** 429 / 5xx / network / timeout / provider-token trouble: the server may retry later. */
  | { result: "unavailable"; reason: string };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: "manual" | "error" | "follow" }) => Promise<{ status: number; text(): Promise<string> }>;

const PRUNE_400 = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);
const reasonOf = (body: string): string => {
  try {
    const r = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof r === "string" ? r.slice(0, 64).replace(/[^A-Za-z0-9]/g, "") : "";
  } catch {
    return "";
  }
};

/** One request to APNs. Never throws; never logs the token or the body. */
export async function sendToApns(
  c: ApnsConfig,
  req: { deviceToken: string; environment: Environment; kind: Kind; id?: string },
  deps: { fetch: FetchLike; now: number; timeoutMs?: number },
): Promise<ApnsResult> {
  let jwt: string;
  try {
    jwt = await providerToken(c, deps.now);
  } catch {
    return { result: "unavailable", reason: "ProviderKey" };
  }
  const n = await buildNotification(req.kind, req.id);
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": c.topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(deps.now / 1000) + EXPIRATION_S),
    "content-type": "application/json",
  };
  if (n.collapseId) headers["apns-collapse-id"] = n.collapseId;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await deps.fetch(`${APNS_ORIGINS[req.environment]}/3/device/${req.deviceToken}`, {
      method: "POST",
      headers,
      body: n.body,
      signal: ctl.signal,
      redirect: "manual",
    });
    const reason = reasonOf(await res.text().catch(() => ""));
    if (res.status === 200) return { result: "sent" };
    if (res.status === 410 || (res.status === 400 && PRUNE_400.has(reason))) return { result: "pruned", reason: reason || "Unregistered" };
    // An expired / invalid provider token is the relay's problem, never the server's.
    if (res.status === 429 || res.status >= 500 || res.status === 403) return { result: "unavailable", reason: `${res.status}${reason ? ` ${reason}` : ""}` };
    return { result: "failed", reason: `${res.status}${reason ? ` ${reason}` : ""}` };
  } catch {
    return { result: "unavailable", reason: ctl.signal.aborted ? "Timeout" : "Network" };
  } finally {
    clearTimeout(timer);
  }
}
