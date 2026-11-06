/** When and how a card interrupts. Content is built per device and never enters the notice bus. */
import type { ApnsNotification, NotificationPreview } from "../apns";
import type { Card } from "./cards";
import { nudgeSettings } from "./nudges";
import { attentionPreferences } from "./attention-preferences";
import { localClock, withinQuietHours } from "./nudge-policy";
import { cardAlert } from "./push-text";
import { db } from "../db";

db.exec(`
CREATE TABLE IF NOT EXISTS omni_push_log (
 id INTEGER PRIMARY KEY, owner_email TEXT, card_id TEXT, at INTEGER, sent INTEGER, failed INTEGER, pruned INTEGER, skipped TEXT
);
CREATE INDEX IF NOT EXISTS omni_push_log_at ON omni_push_log(owner_email, at);
`);

/** One row per card push attempt: the APNs result, or why nothing was attempted. */
export function logCardPush(owner: string, cardId: string, result: { sent: number; failed: number; pruned: number } | null, skipped: string | null, at: number = Date.now()): void {
  db.prepare("INSERT INTO omni_push_log (owner_email, card_id, at, sent, failed, pruned, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(owner, cardId, at, result?.sent ?? 0, result?.failed ?? 0, result?.pruned ?? 0, skipped);
}

/** The last 24h of card pushes, so "are pushes going out" can be answered from outside.
 *  `skipped` counts rows where no push was attempted; `skippedByReason` splits them, so a deliberate hold
 *  (not-allowed: off, kill switch, quiet hours) can be told apart from a broken one (apns-disabled). */
export function pushSummary(owner: string, now: number): { attempts: number; sent: number; failed: number; pruned: number; skipped: number; skippedByReason: Record<string, number>; lastSentAt: string | null } {
  const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(sent),0) sent, COALESCE(SUM(failed),0) failed, COALESCE(SUM(pruned),0) pruned, MAX(CASE WHEN sent > 0 THEN at END) last FROM omni_push_log WHERE owner_email = ? AND at > ? AND at <= ?")
    .get(owner, now - 86_400_000, now) as { n: number; sent: number; failed: number; pruned: number; last: number | null };
  const reasons = db.prepare("SELECT skipped reason, COUNT(*) n FROM omni_push_log WHERE owner_email = ? AND at > ? AND at <= ? AND skipped IS NOT NULL GROUP BY skipped ORDER BY skipped")
    .all(owner, now - 86_400_000, now) as Array<{ reason: string; n: number }>;
  const skippedByReason: Record<string, number> = {};
  for (const row of reasons) skippedByReason[row.reason] = row.n;
  const skipped = reasons.reduce((total, row) => total + row.n, 0);
  return { attempts: r.n, sent: r.sent, failed: r.failed, pruned: r.pruned, skipped, skippedByReason, lastSentAt: r.last == null ? null : new Date(r.last).toISOString() };
}

/** Off, the kill switch and quiet hours hold every card push (same owner settings as nudges). */
export function cardPushAllowed(owner: string, now: number = Date.now()): boolean {
  const s = nudgeSettings(owner);
  if (s.killed || s.dial === "off") return false;
  const quiet = attentionPreferences(owner).quiet_hours;
  return !(quiet && withinQuietHours(quiet, localClock(now)));
}

export function cardNotification(c: Card, preference: NotificationPreview, genericBody: string): ApnsNotification {
  return {
    payload: {
      aps: { alert: cardAlert(c, preference, genericBody), sound: "default", "interruption-level": "active", category: "OMNI_CARD", "thread-id": "omni-cards" },
      type: "omni", category: "OMNI_CARD", id: c.id, url: `omni://card/${encodeURIComponent(c.id)}`,
    },
    collapseId: `omni-card-${c.id}`.slice(0, 64),
  };
}
