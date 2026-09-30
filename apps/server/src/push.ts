/**
 * Web Push for agent turns (Arch v2 WP3.3).
 *
 * WHY `web-push` (not hand-rolled node:crypto): RFC 8291 payload encryption
 * (aes128gcm + ECDH) and RFC 8292 VAPID JWTs are easy to get subtly wrong, and
 * each push service (FCM, Mozilla, Apple) has quirks. `web-push` is the de-facto
 * maintained implementation (3.6.x). It is imported LAZILY inside the default
 * sender so a deploy without VAPID keys never loads it, and tests inject a fake
 * sender so nothing ever reaches a real push service.
 *
 * PRIVACY: the payload is IDS ONLY — `{type, sessionId, turnId, status}`. No
 * prompt, answer, title or note content ever goes through Apple/Google/Mozilla.
 * The service worker renders a generic, content-free notification text.
 *
 * SECURITY: subscriptions are owner-only (routes mirror /api/agent). An endpoint
 * is a bearer capability to ping the owner's browser, so rows are keyed by
 * endpoint and pruned on 404/410 from the push service.
 *
 * BACKOFF: a transient failure increments `failures`; at MAX_FAILURES the row is
 * dropped (the browser re-subscribes next time the toggle/app runs). A success
 * resets it. 404/410 prune immediately.
 */
import { db } from "./db";
import { config } from "./config";

export type PushTurnStatus = "done" | "error" | "interrupted" | "cancelled" | "queued" | "running";

export interface PushPayload {
  type: "agent-turn" | "test";
  sessionId?: string;
  turnId?: string;
  status?: string;
}

export interface PushSubscriptionRow {
  endpoint: string;
  email: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_ok_at: number | null;
  failures: number;
}

/** Result of one send: a 404/410 statusCode means the subscription is gone. */
export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<{ statusCode: number }>;

export const MAX_FAILURES = 5;

interface Keys {
  publicKey: string;
  privateKey: string;
  subject: string;
}
let sender: PushSender | null = null;
let keyOverride: Keys | null = null;

/** Test/deploy seam: inject a sender (and/or keys). */
export function configurePush(o: { sender?: PushSender | null; keys?: Keys | null }): void {
  if (o.sender !== undefined) sender = o.sender;
  if (o.keys !== undefined) keyOverride = o.keys;
}

const keys = (): Keys =>
  keyOverride ?? { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject };

export const pushEnabled = (): boolean => {
  const k = keys();
  return !!(k.publicKey && k.privateKey && k.subject);
};
export const vapidPublicKey = (): string => keys().publicKey;

async function defaultSender(): Promise<PushSender> {
  const webpush = (await import("web-push")).default;
  const k = keys();
  webpush.setVapidDetails(k.subject, k.publicKey, k.privateKey);
  return async (sub, payload) => {
    try {
      const r = await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24, urgency: "high" });
      return { statusCode: r.statusCode };
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode;
      if (typeof sc === "number") return { statusCode: sc };
      throw e;
    }
  };
}

// ── subscriptions ────────────────────────────────────────────────────────────
const q = {
  upsert: db.prepare(
    `INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, user_agent, created_at, failures)
     VALUES (@endpoint, @email, @p256dh, @auth, @user_agent, @created_at, 0)
     ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh,
       auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`,
  ),
  del: db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND email = ?"),
  delAny: db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?"),
  forEmail: db.prepare("SELECT * FROM push_subscriptions WHERE email = ?"),
  ok: db.prepare("UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?"),
  fail: db.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?"),
  failures: db.prepare("SELECT failures FROM push_subscriptions WHERE endpoint = ?"),
  owner: db.prepare("SELECT owner_email FROM agent_sessions WHERE id = ?"),
};

export function saveSubscription(p: { email: string; endpoint: string; p256dh: string; auth: string; userAgent?: string | null }): void {
  q.upsert.run({
    endpoint: p.endpoint,
    email: p.email.toLowerCase(),
    p256dh: p.p256dh,
    auth: p.auth,
    user_agent: p.userAgent ? p.userAgent.slice(0, 200) : null,
    created_at: Date.now(),
  });
}
export const removeSubscription = (email: string, endpoint: string): boolean =>
  q.del.run(endpoint, email.toLowerCase()).changes > 0;
export const listSubscriptions = (email: string): PushSubscriptionRow[] =>
  q.forEmail.all(email.toLowerCase()) as PushSubscriptionRow[];

// ── sending ──────────────────────────────────────────────────────────────────
/** Send one payload to every subscription of `email`. Never throws. */
export async function sendPush(email: string, payload: PushPayload): Promise<{ sent: number; pruned: number; failed: number }> {
  const out = { sent: 0, pruned: 0, failed: 0 };
  if (!pushEnabled() && !sender) return out;
  const subs = listSubscriptions(email);
  if (!subs.length) return out;
  let send: PushSender;
  try {
    send = sender ?? (await defaultSender());
  } catch (e) {
    console.error(`[push] sender init failed: ${(e as Error).message}`);
    return out;
  }
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        const r = await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
        if (r.statusCode === 404 || r.statusCode === 410) {
          q.delAny.run(s.endpoint);
          out.pruned++;
        } else if (r.statusCode >= 200 && r.statusCode < 300) {
          q.ok.run(Date.now(), s.endpoint);
          out.sent++;
        } else {
          throw new Error(`push service answered ${r.statusCode}`);
        }
      } catch (e) {
        out.failed++;
        q.fail.run(s.endpoint);
        const f = (q.failures.get(s.endpoint) as { failures: number } | undefined)?.failures ?? 0;
        if (f >= MAX_FAILURES) q.delAny.run(s.endpoint);
        console.error(`[push] send failed (${f}/${MAX_FAILURES}): ${(e as Error).message}`);
      }
    }),
  );
  return out;
}

/**
 * The turn-end seam (called from agent-sessions). Fire-and-forget: synchronous
 * return, never throws, never blocks the turn. Cancelled (the user's own action)
 * and non-terminal statuses don't notify.
 */
export function notifyTurnEnd(sessionId: string, turnId: string, status: PushTurnStatus): void {
  if (status !== "done" && status !== "error" && status !== "interrupted") return;
  try {
    if (!pushEnabled() && !sender) return;
    const row = q.owner.get(sessionId) as { owner_email: string } | undefined;
    if (!row) return;
    void sendPush(row.owner_email, { type: "agent-turn", sessionId, turnId, status }).catch((e) =>
      console.error(`[push] notify failed: ${(e as Error).message}`),
    );
  } catch (e) {
    console.error(`[push] notify failed: ${(e as Error).message}`);
  }
}

export function _resetPush(): void {
  sender = null;
  keyOverride = null;
}
