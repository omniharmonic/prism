/**
 * What an Omni nudge / approval notification SAYS, per device preview setting
 * (`apns_tokens.preview`, chosen in Omni Settings → Notifications):
 *
 *  - `generic`        — no content: "Omni" + a fixed sentence (attention-preferences.ts).
 *  - `title`          — a concise headline ("Reply owed: Alice Chen") + the fixed sentence.
 *  - `title_preview`  — the headline + a plain-text summary (markdown stripped, ≤180 chars).
 *
 * Every string goes through `notificationText` (bus.ts): plain, bounded, no code, links or
 * local paths. Content is built per device inside `sendApnsToOwner`'s callback and never
 * enters the owner-wide notice bus or a log line.
 */
import type { NotificationPreview } from "../apns";
import type { Approval } from "./approvals";
import { notificationText } from "./bus";
import type { Nudge } from "./nudges";

export const HEADLINE_MAX = 80;
export const BODY_MAX = 180;

const named = (s: string | null | undefined): string => (s ? notificationText(s, 60) : "");

/** "Reply owed: Alice Chen", "Meeting in 15 min: Ops sync", "Task due today: File taxes"… */
export function nudgeHeadline(n: Pick<Nudge, "candidate" | "deadline">, senderName: string | null, now = Date.now()): string {
  const c = n.candidate;
  const title = named(c.title);
  const about = (prefix: string, what: string) => notificationText(what ? `${prefix}: ${what}` : prefix, HEADLINE_MAX);
  switch (c.kind) {
    case "reply-owed":
      return about("Reply owed", named(senderName) || title);
    case "unprocessed":
      return about("Waiting on you", named(senderName) || title);
    case "meeting": {
      const start = n.deadline ?? c.deadline;
      if (start !== null && start > now && start - now <= 2 * 3_600_000) {
        const min = Math.max(1, Math.round((start - now) / 60_000));
        return about(`Meeting in ${min} min`, title);
      }
      return about("Meeting", title);
    }
    case "task":
      return about(dueWord("Task", n.deadline ?? c.deadline, now), title);
    case "commitment":
      return about(dueWord("Commitment", n.deadline ?? c.deadline, now), title);
    case "job":
    case "freshness":
      return notificationText(c.title, HEADLINE_MAX);
  }
}

function dueWord(what: string, deadline: number | null, now: number): string {
  if (deadline === null) return what;
  if (deadline <= now) return `${what} overdue`;
  return deadline - now <= 24 * 3_600_000 ? `${what} due soon` : what;
}

/** The plain summary line, or "" when there is nothing beyond the headline. */
export function nudgeBody(n: Pick<Nudge, "candidate">): string {
  const c = n.candidate;
  const body = notificationText(c.summary, BODY_MAX);
  if (body && body.toLowerCase() !== notificationText(c.title, BODY_MAX).toLowerCase()) return body;
  const reason = c.reasons.find((r) => r.trim());
  return reason ? notificationText(reason, BODY_MAX) : "";
}

/** One device's alert for one nudge. `generic` is the privacy floor (and the fallback). */
export function nudgeAlert(n: Nudge, preference: NotificationPreview, genericBody: string, senderName: string | null, now = Date.now()): { title: string; body: string } {
  if (preference === "generic") return { title: "Omni", body: genericBody };
  const headline = nudgeHeadline(n, senderName, now);
  if (!headline) return { title: "Omni", body: genericBody };
  if (preference === "title") return { title: headline, body: genericBody };
  return { title: headline, body: nudgeBody(n) || genericBody };
}

/** The digest: "3 items need you" + the top item ("Reply owed: Alice Chen — …"). */
export function digestAlert(count: number, top: Nudge | null, preference: NotificationPreview, genericBody: string, senderName: string | null, now = Date.now()): { title: string; body: string } {
  if (preference === "generic") return { title: "Omni", body: genericBody };
  const title = count === 1 ? "1 item needs you" : `${count} items need you`;
  if (!top) return { title, body: genericBody };
  const headline = nudgeHeadline(top, senderName, now);
  if (preference === "title") return { title, body: notificationText(`Top: ${headline}`, BODY_MAX) };
  const body = nudgeBody(top);
  return { title, body: notificationText(body ? `Top: ${headline} — ${body}` : `Top: ${headline}`, BODY_MAX) };
}

/** A person's name from a recipient as written: `Alice Chen <a@x>` → "Alice Chen", `alice@x` → "alice". */
function recipientName(v: unknown): string {
  const first = Array.isArray(v) ? v.find((x) => typeof x === "string") : v;
  if (typeof first !== "string" || !first.trim()) return "";
  const angle = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(first);
  if (angle?.[1]) return angle[1].trim();
  return first.trim().split("@")[0] ?? "";
}

/** "Tweet ready to approve", "Draft reply to Alice is ready", "Command waiting: Deploy"… */
export function approvalHeadline(a: Pick<Approval, "kind" | "payload">): string {
  const p = a.payload;
  const s = (v: unknown) => (typeof v === "string" ? notificationText(v, 60) : "");
  const h = (t: string) => notificationText(t, HEADLINE_MAX);
  switch (a.kind) {
    case "email": {
      const to = notificationText(recipientName(p.to), 40);
      return h(to ? `Email to ${to} is ready` : "Email draft is ready");
    }
    case "email-reply": {
      const to = notificationText(recipientName(p.expectTo), 40);
      return h(to ? `Draft reply to ${to} is ready` : "Draft reply is ready");
    }
    case "message":
      return h("Message draft is ready");
    case "device-sign-in":
      return h("A new device wants to sign in");
    case "calendar-rsvp":
      return h(s(p.response) ? `RSVP (${s(p.response)}) ready to send` : "RSVP ready to send");
    case "calendar-invite":
      return h(s(p.title) ? `Invite ready: ${s(p.title)}` : "Calendar invite is ready");
    case "tweet":
      return h("Tweet ready to approve");
    case "wallet-proposal":
      return h("Wallet proposal to review");
    case "command":
      return h(s(p.title) ? `Approve: ${s(p.title)}` : s(p.tool) ? `Approve a ${s(p.tool)} call` : "A command needs approval");
  }
}

/** The plain preview of what would be sent, or "" (then the fixed sentence stands). */
export function approvalBody(a: Pick<Approval, "kind" | "payload" | "summary">): string {
  const p = a.payload;
  const pick = (...vs: unknown[]) => vs.find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? "";
  const raw =
    a.kind === "tweet" ? pick(p.text, a.summary)
    : a.kind === "email" ? pick(a.summary, p.subject, p.body)
    : a.kind === "email-reply" || a.kind === "message" ? pick(a.summary, p.body)
    : a.kind === "calendar-invite" ? pick(a.summary, p.start)
    : a.kind === "command" ? pick(a.summary, p.reason)
    : pick(a.summary, p.purpose);
  return raw ? notificationText(raw, BODY_MAX) : "";
}
