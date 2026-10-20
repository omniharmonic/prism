/**
 * APNs — native iOS push for agent turns (WP5, server side).
 *
 * The iOS Prism Client registers its APNs device token here (routes/push.ts,
 * `POST /api/push/apns`) while authenticated by its `pd_` DEVICE token; the row
 * is bound to that device and dies with it (auth/device.ts `revokeDevice`).
 * `notifyTurnEnd()` (push.ts) fans out to APNs next to Web Push.
 *
 * AUTH: token-based provider auth — an ES256 JWT (`alg ES256`, `kid` = key id,
 * claims `iss` = team id, `iat`), signed with the Apple .p8 key through
 * `crypto.sign` (no dependency). Apple rejects a token older than 60 min and
 * refreshes more often than every 20 min (TooManyProviderTokenUpdates), so the
 * JWT is cached and re-minted after JWT_REFRESH_MS (50 min); a 403
 * ExpiredProviderToken re-mints at most once per send and never sooner than
 * JWT_MIN_REMINT_MS after the previous mint.
 *
 * TRANSPORT: one long-lived HTTP/2 session per APNs origin (production /
 * sandbox), reopened after close/goaway/error; per-request timeout; sends are
 * bounded by a small semaphore. Tests inject a fake `ApnsTransport` — nothing in
 * the test suite ever reaches Apple.
 *
 * RESPONSES: 200 ok · 410 (Unregistered) / 400 BadDeviceToken /
 * 400 DeviceTokenNotForTopic → the row is deleted · 403 ExpiredProviderToken →
 * re-mint once (above) · 429 / 5xx / network error / timeout → bounded retry
 * with exponential backoff · anything else → failed, logged.
 *
 * RELAY (decision D-I, push-relay.ts): with NO direct APNs value set and a push
 * relay configured, Prism notifications go to the relay as `{token, environment,
 * kind, id}` (`ApnsNotification.relay`) and the relay writes the alert itself.
 * Direct APNs, when configured, always wins. Omni never uses the relay.
 *
 * PRIVACY: Prism payloads contain ids and generic text. Omni includes a bounded headline
 * and plain summary per each device's preview setting (`title_preview` by default since
 * Omni Phase 1; `generic` stays selectable). Notification payloads are never logged. The device token
 * value is never logged: logs carry `tokenRef()` (a sha256 prefix) only. The key
 * file's contents are never logged.
 */
import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import http2 from "node:http2";
import { config } from "./config";
import { db } from "./db";
import { pushRelayEnabled, relayCall, relayKey, relaySendBody, validRelayMessage, type RelayMessage } from "./push-relay";

export type ApnsApplication = "prism" | "omni";
/** The bundle id a row's notifications are addressed to ("" = not configured: nothing is sent). */
export const apnsTopicForApplication = (application: ApnsApplication): string => application === "omni" ? omniApnsTopic() : apnsTopic();
export type ApnsEnvironment = "sandbox" | "production";
export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

export const JWT_REFRESH_MS = 50 * 60_000;
export const JWT_MIN_REMINT_MS = 20 * 60_000;
export const MAX_RETRIES = 2; // → at most 3 attempts per notification
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_CONCURRENT = 4;
/** APNs expiration for agent-turn notifications (same 24 h as the web push TTL). */
export const EXPIRATION_S = 24 * 60 * 60;

// ── transport seam ───────────────────────────────────────────────────────────
export interface ApnsRequest {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}
export interface ApnsResponse {
  status: number;
  body: string;
}
export interface ApnsTransport {
  send(req: ApnsRequest): Promise<ApnsResponse>;
  close(): void;
}

/** The real transport: one reusable HTTP/2 session per origin, reconnect on loss. */
export function http2Transport(): ApnsTransport {
  const sessions = new Map<string, http2.ClientHttp2Session>();
  const session = (origin: string): http2.ClientHttp2Session => {
    const live = sessions.get(origin);
    if (live && !live.closed && !live.destroyed) return live;
    const s = http2.connect(origin);
    const drop = () => {
      if (sessions.get(origin) === s) sessions.delete(origin);
    };
    s.on("error", (e) => {
      drop();
      console.error(`[apns] connection error (${origin}): ${(e as Error).message}`);
    });
    s.on("close", drop);
    s.on("goaway", drop);
    // Apple keeps idle connections a long while; ours is closed if idle for an hour.
    s.setTimeout(60 * 60_000, () => s.close());
    s.unref();
    sessions.set(origin, s);
    return s;
  };
  return {
    send: (r) =>
      new Promise<ApnsResponse>((resolve, reject) => {
        let s: http2.ClientHttp2Session;
        try {
          s = session(r.origin);
        } catch (e) {
          reject(e);
          return;
        }
        let status = 0;
        let body = "";
        let settled = false;
        const done = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };
        const req = s.request({ ":method": "POST", ":path": r.path, "content-type": "application/json", ...r.headers });
        req.setEncoding("utf8");
        req.setTimeout(r.timeoutMs, () => {
          req.close(http2.constants.NGHTTP2_CANCEL);
          done(() => reject(new Error("apns request timed out")));
        });
        req.on("response", (h) => {
          status = Number(h[":status"]) || 0;
        });
        req.on("data", (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        req.on("end", () => done(() => resolve({ status, body })));
        req.on("error", (e) => done(() => reject(e)));
        req.end(r.body);
      }),
    close: () => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}

// ── configuration ────────────────────────────────────────────────────────────
interface Overrides {
  transport?: ApnsTransport | null;
  keyPath?: string;
  keyId?: string;
  teamId?: string;
  topic?: string;
  /** The Omni app's bundle id (`OMNI_APNS_TOPIC`). */
  omniTopic?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
let o: Overrides = {};
let transport: ApnsTransport | null = null;

/** Test/deploy seam. Any change drops the cached key + JWT. */
export function configureApns(next: Overrides): void {
  o = { ...o, ...next };
  if (next.transport !== undefined) transport = next.transport;
  loaded = null;
  jwt = null;
}
export function _resetApns(): void {
  transport?.close();
  transport = null;
  o = {};
  loaded = null;
  jwt = null;
  active = 0;
  waiters.length = 0;
}

const now = () => (o.now ?? Date.now)();
const sleep = (ms: number) => (o.sleep ? o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms).unref?.()));
const keyPath = () => o.keyPath ?? config.apnsKeyPath;
const keyId = () => o.keyId ?? config.apnsKeyId;
const teamId = () => o.teamId ?? config.apnsTeamId;
export const apnsTopic = (): string => o.topic ?? config.apnsTopic;
const omniApnsTopic = (): string => o.omniTopic ?? config.omniApnsTopic;

type Loaded = { ok: true; key: KeyObject } | { ok: false; reason: string; configured: boolean };
let loaded: Loaded | null = null;

const APPLE_ID = /^[A-Z0-9]{10}$/;
const TOPIC = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;

/**
 * Load + validate the provider key once. Refuses (APNs stays OFF) when: any of
 * the three required values is unset (silently — that is "not configured"), a
 * key/team id is malformed, the file is group/world accessible (must be 0600 or
 * stricter), it is not a regular file, or it is not an EC P-256 private key.
 * Reasons never include the file's contents.
 */
function load(): Loaded {
  if (loaded) return loaded;
  const p = keyPath();
  const kid = keyId();
  const iss = teamId();
  if (!p && !kid && !iss) return (loaded = { ok: false, configured: false, reason: "not configured" });
  const missing = [!p && "APNS_KEY_PATH", !kid && "APNS_KEY_ID", !iss && "APNS_TEAM_ID", !apnsTopic() && "APNS_TOPIC"].filter(Boolean);
  if (missing.length) return (loaded = { ok: false, configured: true, reason: `missing ${missing.join(", ")}` });
  if (!APPLE_ID.test(kid)) return (loaded = { ok: false, configured: true, reason: "APNS_KEY_ID must be the 10-character key id" });
  if (!APPLE_ID.test(iss)) return (loaded = { ok: false, configured: true, reason: "APNS_TEAM_ID must be the 10-character team id" });
  if (!TOPIC.test(apnsTopic())) return (loaded = { ok: false, configured: true, reason: "APNS_TOPIC is not a bundle id" });
  try {
    const st = statSync(p);
    if (!st.isFile()) return (loaded = { ok: false, configured: true, reason: "APNS_KEY_PATH is not a regular file" });
    if ((st.mode & 0o077) !== 0) {
      const mode = (st.mode & 0o777).toString(8).padStart(4, "0");
      return (loaded = {
        ok: false,
        configured: true,
        reason: `APNS_KEY_PATH permissions ${mode} are too open — run chmod 600 on the key file`,
      });
    }
    const key = createPrivateKey(readFileSync(p));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      return (loaded = { ok: false, configured: true, reason: "APNS_KEY_PATH is not an EC P-256 (.p8) private key" });
    }
    return (loaded = { ok: true, key });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return (loaded = {
      ok: false,
      configured: true,
      // Never echo a parser message (could quote key material); errno codes are safe.
      reason: code ? `APNS_KEY_PATH unreadable (${code})` : "APNS_KEY_PATH could not be parsed as a private key",
    });
  }
}

export type ApnsMode = "direct" | "relay" | "off";
/**
 * How this server reaches APNs: `direct` with its own key (always preferred);
 * `relay` only when NO direct value is set and the push relay is configured
 * (key file + URL); else `off`. A direct key that is set but refused (bad mode,
 * bad id) is `off` — it never silently falls back to the relay.
 */
export function apnsMode(): ApnsMode {
  const l = load();
  if (l.ok) return "direct";
  if (!l.configured && pushRelayEnabled()) return "relay";
  return "off";
}
/**
 * Whether notifications for `application` can be delivered. The relay carries
 * only the Prism app's fixed, content-free notifications, so Omni needs direct.
 */
export const apnsEnabled = (application: ApnsApplication = "prism"): boolean => {
  const m = apnsMode();
  return m === "direct" || (m === "relay" && application === "prism");
};
export function apnsStatus(): { enabled: boolean; configured: boolean; mode: ApnsMode; reason?: string } {
  const l = load();
  if (l.ok) return { enabled: true, configured: true, mode: "direct" };
  if (!l.configured) {
    const r = relayKey();
    if (r.ok) return { enabled: true, configured: true, mode: "relay" };
    if (r.configured) return { enabled: false, configured: true, mode: "off", reason: `push relay: ${r.reason}` };
  }
  return { enabled: false, configured: l.configured, mode: "off", reason: l.reason };
}

/** Startup line (index.ts). A configured-but-refused key is a loud warning. */
export function reportApns(): void {
  const s = apnsStatus();
  const r = relayKey();
  if (s.mode === "direct") console.log(`  apns:   ON (topic ${apnsTopic()})`);
  else if (s.mode === "relay" && r.ok) console.log(`  apns:   ON via the push relay (server ${r.serverId}; Prism app only, ids only)`);
  else if (!s.configured) console.log("  apns:   off (APNS_KEY_PATH / APNS_KEY_ID / APNS_TEAM_ID / APNS_TOPIC unset; no PUSH_RELAY_URL)");
  else console.warn(`[apns] WARNING: APNs is DISABLED — ${s.reason}. Web push is unaffected.`);
}

// ── provider token (ES256 JWT) ───────────────────────────────────────────────
let jwt: { token: string; mintedAt: number } | null = null;
const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");

function mint(key: KeyObject): string {
  const t = now();
  const header = b64u(JSON.stringify({ alg: "ES256", kid: keyId() }));
  const claims = b64u(JSON.stringify({ iss: teamId(), iat: Math.floor(t / 1000) }));
  const sig = cryptoSign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  jwt = { token: `${header}.${claims}.${b64u(sig)}`, mintedAt: t };
  return jwt.token;
}

/** The cached provider token; re-minted once it is JWT_REFRESH_MS old. */
export function providerToken(): string | null {
  const l = load();
  if (!l.ok) return null;
  if (jwt && now() - jwt.mintedAt < JWT_REFRESH_MS) return jwt.token;
  return mint(l.key);
}

/**
 * After a 403 ExpiredProviderToken for `used`: the token to retry with, or null.
 * If another send already re-minted, use that; else re-mint only if the last
 * mint is old enough for Apple to accept an update (never a mint storm).
 */
function tokenAfterExpiry(used: string): string | null {
  const l = load();
  if (!l.ok) return null;
  if (jwt && jwt.token !== used) return jwt.token;
  if (jwt && now() - jwt.mintedAt < JWT_MIN_REMINT_MS) return null;
  return mint(l.key);
}

// ── storage ──────────────────────────────────────────────────────────────────
export type NotificationPreview = "generic" | "title" | "title_preview";
export const isNotificationPreview = (v: unknown): v is NotificationPreview => v === "generic" || v === "title" || v === "title_preview";
/** A registration that names no preview: Omni shows a headline and a short summary; Prism stays generic. */
export const defaultNotificationPreview = (application: ApnsApplication): NotificationPreview => (application === "omni" ? "title_preview" : "generic");

export interface ApnsTokenRow {
  preview: NotificationPreview;
  device_id: string;
  application: ApnsApplication;
  token: string;
  environment: ApnsEnvironment;
  owner_email: string;
  vault_id: string;
  created_at: number;
  last_seen_at: number;
}

/** APNs device tokens are hex (32 bytes today; Apple says the length may grow). */
export const isApnsToken = (t: unknown): t is string => typeof t === "string" && /^[0-9a-fA-F]{64,200}$/.test(t) && t.length % 2 === 0;
export const isApnsEnvironment = (e: unknown): e is ApnsEnvironment => e === "sandbox" || e === "production";
/** The only form of a device token that may appear in a log line. */
export const tokenRef = (token: string): string => createHash("sha256").update(token.toLowerCase()).digest("hex").slice(0, 8);

const st = {
  upsert: db.prepare(
    `INSERT INTO apns_tokens (device_id, token, environment, owner_email, vault_id, application, preview, created_at, last_seen_at)
     VALUES (@device_id, @token, @environment, @owner_email, @vault_id, @application, @preview, @t, @t)
     ON CONFLICT(device_id) DO UPDATE SET application = excluded.application, token = excluded.token, environment = excluded.environment,
       owner_email = excluded.owner_email, vault_id = excluded.vault_id, preview = excluded.preview, last_seen_at = excluded.last_seen_at,
       created_at = CASE WHEN apns_tokens.token = excluded.token THEN apns_tokens.created_at ELSE excluded.created_at END`,
  ),
  dropTokenElsewhere: db.prepare("DELETE FROM apns_tokens WHERE token = ? AND application = ? AND environment = ? AND device_id <> ?"),
  delDevice: db.prepare("DELETE FROM apns_tokens WHERE device_id = ?"),
  delToken: db.prepare("DELETE FROM apns_tokens WHERE token = ? AND environment = ? AND application = ?"),
  forDevice: db.prepare("SELECT * FROM apns_tokens WHERE device_id = ?"),
  // Only rows whose registering device is still live AND still belongs to the
  // same account — a revoked/expired device is never pushed to.
  liveForOwner: db.prepare(
    `SELECT a.* FROM apns_tokens a JOIN device_tokens d ON d.id = a.device_id
     WHERE a.owner_email = ? AND a.application = ? AND d.email = a.owner_email AND d.revoked_at IS NULL AND d.expires_at > ? AND d.max_expires_at > ?`,
  ),
  countLive: db.prepare(
    `SELECT count(*) AS n FROM apns_tokens a JOIN device_tokens d ON d.id = a.device_id
     WHERE a.owner_email = ? AND a.application = ? AND d.email = a.owner_email AND d.revoked_at IS NULL AND d.expires_at > ? AND d.max_expires_at > ?`,
  ),
};

/** Register (or replace) the APNs token of one native device. One row per device. */
export const saveApnsToken = db.transaction(
  (p: { deviceId: string; token: string; environment: ApnsEnvironment; email: string; vaultId: string; application?: ApnsApplication; preview?: NotificationPreview }): void => {
    const token = p.token.toLowerCase();
    // The same APNs token re-registered by a NEW device credential (re-sign-in)
    // moves; it never lives on two rows (that would double every notification).
    st.dropTokenElsewhere.run(token, p.application ?? "prism", p.environment, p.deviceId);
    st.upsert.run({
      device_id: p.deviceId,
      token,
      environment: p.environment,
      owner_email: p.email.toLowerCase(),
      vault_id: p.vaultId,
      application: p.application ?? "prism",
      // Unsaid → keep this device's earlier choice, else the application's default
      // (Omni: headline + summary, the owner's Phase 1 choice; Prism: generic).
      preview: p.preview ?? apnsTokenForDevice(p.deviceId)?.preview ?? defaultNotificationPreview(p.application ?? "prism"),
      t: Date.now(),
    });
  },
);
export const removeApnsTokenForDevice = (deviceId: string): boolean => st.delDevice.run(deviceId).changes > 0;
export const apnsTokenForDevice = (deviceId: string): ApnsTokenRow | null =>
  (st.forDevice.get(deviceId) as ApnsTokenRow | undefined) ?? null;
export function liveApnsTokens(email: string, application: ApnsApplication = "prism"): ApnsTokenRow[] {
  const t = Date.now();
  return st.liveForOwner.all(email.toLowerCase(), application, t, t) as ApnsTokenRow[];
}
export function countLiveApnsTokens(email: string, application: ApnsApplication = "prism"): number {
  const t = Date.now();
  return (st.countLive.get(email.toLowerCase(), application, t, t) as { n: number }).n;
}

// ── payloads ─────────────────────────────────────────────────────────────────
export interface ApnsNotification {
  /** The full APNs JSON body (aps + custom keys). */
  payload: Record<string, unknown>;
  collapseId?: string;
  threadId?: string;
  /** The same notification in the push relay's vocabulary (kind + id only). Absent → never relayed. */
  relay?: RelayMessage;
}

/** Content-free agent-turn notification (mirrors apps/web/public/push-sw.js). */
export function agentTurnNotification(sessionId: string, turnId: string, status: string): ApnsNotification {
  const failed = status !== "done";
  return {
    payload: {
      aps: {
        alert: { title: "Prism", body: failed ? "Agent needs attention" : "Your agent finished" },
        sound: "default",
        "thread-id": sessionId,
      },
      type: "agent-turn",
      sessionId,
      turnId,
      status,
      url: `/agent/${encodeURIComponent(sessionId)}`,
    },
    // A newer turn of the same session replaces the older notification.
    collapseId: collapseId(`agent-${sessionId}`),
    relay: { kind: failed ? "agent-attention" : "agent", id: sessionId },
  };
}
/** Content-free inbox notification (wave 2A): the id only; the app fetches the rest. */
export function notificationAlert(id: string): ApnsNotification {
  return {
    payload: {
      aps: { alert: { title: "Prism", body: "You have a new notification" }, sound: "default", "thread-id": "prism-inbox" },
      type: "notification",
      notificationId: id,
      url: `/inbox/${encodeURIComponent(id)}`,
    },
    collapseId: collapseId(`notification-${id}`),
    relay: { kind: "notification", id },
  };
}
export function testNotification(): ApnsNotification {
  return {
    payload: { aps: { alert: { title: "Prism", body: "Notifications are working" }, sound: "default" }, type: "test" },
    collapseId: "prism-test",
    relay: { kind: "test" },
  };
}
/** apns-collapse-id is limited to 64 bytes. */
const collapseId = (s: string) =>
  Buffer.byteLength(s) <= 64 ? s : `h-${createHash("sha256").update(s).digest("hex").slice(0, 40)}`;

// ── concurrency ──────────────────────────────────────────────────────────────
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Not unref'd: it is bounded and always cleared, and an in-flight send should
    // be allowed to finish (or time out) rather than be cut off by an empty loop.
    const t = setTimeout(() => reject(new Error("apns request timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ── sending ──────────────────────────────────────────────────────────────────
export type ApnsOutcome = "sent" | "pruned" | "failed";
const PRUNE_400 = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);
const reasonOf = (body: string): string => {
  try {
    const r = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof r === "string" ? r.slice(0, 64).replace(/[^A-Za-z0-9]/g, "") : "";
  } catch {
    return "";
  }
};
const backoff = (attempt: number) => {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
};

/** Send one notification to one device token. Never throws. */
export async function sendApns(row: Pick<ApnsTokenRow, "token" | "environment"> & Partial<Pick<ApnsTokenRow, "application">>, n: ApnsNotification): Promise<ApnsOutcome> {
  const ref = tokenRef(row.token);
  if (apnsMode() === "relay") return sendViaRelay(row, n, ref);
  const topic = apnsTopicForApplication(row.application ?? "prism");
  if (!TOPIC.test(topic)) return "failed"; // that app's bundle id is not configured
  let token = providerToken();
  if (!token) return "failed";
  const tx = (transport ??= http2Transport());
  const body = JSON.stringify(n.payload);
  let reminted = false;
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = {
      authorization: `bearer ${token}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(now() / 1000) + EXPIRATION_S),
    };
    if (n.collapseId) headers["apns-collapse-id"] = n.collapseId;
    let res: ApnsResponse | null = null;
    let err = "";
    try {
      const timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS;
      res = await withSlot(() =>
        withTimeout(
          tx.send({ origin: APNS_ORIGINS[row.environment], path: `/3/device/${row.token}`, headers, body, timeoutMs }),
          timeoutMs + 1_000,
        ),
      );
    } catch (e) {
      // Transport errors can quote the request body. Never log notification content.
      err = e instanceof Error && e.message === "apns request timed out" ? "request timed out" : "transport error";
    }
    if (res) {
      const reason = reasonOf(res.body);
      if (res.status === 200) return "sent";
      if (res.status === 410 || (res.status === 400 && PRUNE_400.has(reason))) {
        st.delToken.run(row.token, row.environment, row.application ?? "prism");
        console.log(`[apns] ${ref}: ${res.status} ${reason || "Unregistered"} — token removed`);
        return "pruned";
      }
      if (res.status === 403 && reason === "ExpiredProviderToken" && !reminted) {
        reminted = true;
        const next = tokenAfterExpiry(token);
        if (next) {
          token = next;
          attempt--; // the refresh retry does not count against the backoff budget
          continue;
        }
      }
      if (res.status !== 429 && res.status < 500) {
        console.error(`[apns] ${ref}: send failed ${res.status} ${reason}`);
        return "failed";
      }
      err = `${res.status} ${reason}`;
    }
    if (attempt >= MAX_RETRIES) {
      console.error(`[apns] ${ref}: send failed after ${attempt + 1} attempts (${err})`);
      return "failed";
    }
    await sleep(backoff(attempt));
  }
}

/**
 * Relay mode: the notification's kind + id go to the push relay, which writes
 * the alert itself. Prism only; a notification without a relay form (Omni,
 * anything with text) is never sent. Same retry budget as a direct send.
 */
async function sendViaRelay(row: Pick<ApnsTokenRow, "token" | "environment"> & Partial<Pick<ApnsTokenRow, "application">>, n: ApnsNotification, ref: string): Promise<ApnsOutcome> {
  if ((row.application ?? "prism") !== "prism" || !n.relay || !validRelayMessage(n.relay)) return "failed";
  const body = relaySendBody(row, n.relay);
  for (let attempt = 0; ; attempt++) {
    let err = "";
    let wait = 0;
    try {
      const res = await withSlot(() => relayCall("POST", "/v1/send", body, { timeoutMs: o.timeoutMs ?? REQUEST_TIMEOUT_MS }));
      if (res.status === 200) {
        let result: unknown;
        try {
          result = (JSON.parse(res.body) as { result?: unknown }).result;
        } catch {
          result = undefined;
        }
        if (result === "sent") return "sent";
        if (result === "pruned") {
          st.delToken.run(row.token, row.environment, row.application ?? "prism");
          console.log(`[apns] ${ref}: the push relay reports the token is no longer valid — token removed`);
          return "pruned";
        }
        console.error(`[apns] ${ref}: the push relay could not deliver (${reasonOf(res.body) || "failed"})`);
        return "failed";
      }
      if (res.status === 401) {
        console.error("[apns] the push relay does not know this server — run npm run push-relay:register -w @prism/server");
        return "failed";
      }
      if (res.status === 403) {
        console.error("[apns] the push relay has revoked this server's registration");
        return "failed";
      }
      if (res.status !== 429 && res.status < 500) {
        console.error(`[apns] ${ref}: the push relay refused the request (${res.status})`);
        return "failed";
      }
      err = `relay ${res.status}`;
      wait = (res.retryAfterS ?? 0) * 1000;
    } catch {
      err = "relay unreachable";
    }
    if (attempt >= MAX_RETRIES || wait > BACKOFF_MAX_MS) {
      console.error(`[apns] ${ref}: send via the push relay failed after ${attempt + 1} attempts (${err})`);
      return "failed";
    }
    await sleep(Math.max(wait, backoff(attempt)));
  }
}

/** Fan out to every live device of `email`. Never throws. */
export async function sendApnsToOwner(email: string, n: ApnsNotification | ((row: ApnsTokenRow) => ApnsNotification), application: ApnsApplication = "prism"): Promise<{ sent: number; pruned: number; failed: number }> {
  const out = { sent: 0, pruned: 0, failed: 0 };
  if (!apnsEnabled(application)) return out;
  const rows = liveApnsTokens(email, application);
  const results = await Promise.all(rows.map((r) => sendApns(r, typeof n === "function" ? n(r) : n).catch(() => "failed" as const)));
  for (const r of results) out[r]++;
  return out;
}

/** A registration may only address the app that minted this live device credential. */
export function apnsApplicationForDevice(deviceId: string): ApnsApplication | null {
  const row = db.prepare("SELECT client_id FROM device_tokens WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND max_expires_at > ?").get(deviceId, Date.now(), Date.now()) as { client_id: string } | undefined;
  return row?.client_id === "omni-native" ? "omni" : row?.client_id === "prism-native" ? "prism" : null;
}
