// Comms notifications (Sprint Task 1, D18, PRD §5.10): new messages → APNs on the owner's Comms
// devices, only for threads that matter.
//
// SOURCE: the comms_events log (store.onCommsEvent / eventsAfter) — the same feed as the SSE stream,
// so Matrix-bridged networks and iMessage/SMS (BlueBubbles) are covered alike. The cursor starts at
// "now" when the notifier starts: nothing older is ever notified.
//
// DECISION, per incoming message (not the owner's own, not Omni, not deleted, not a system line).
// Precedence: thread Mute > owner-folder "none" > owner-folder "all" > status / network rules.
//   never  — COMMS_NOTIFY_ENABLED off · the owner's master switch off · thread muted (Hide alerts)
//            · archived (incl. the message that un-archives it: Messages brings it back quietly)
//            · system folder spam · one of the thread's owner folders says "none" · (unless a
//            folder says "all") system folder unknown (strangers) / low (unless "low" is on), or the network switched
//            off · already read · already notified (comms_notify_log).
//   now    — one of the thread's owner folders says "all"; OR the thread's verdict (its status, or
//            the last verdict before ingest stripped the tags) is a status the owner notifies for
//            (default urgent + action-required); OR it has no verdict and "Not yet sorted" is on;
//            OR it has no verdict and is a DM with a known person (person note) and
//            knownPeopleImmediately.
//   wait   — everything else waits for the classifier: when the thread's status next CHANGES to a
//            verdict, it notifies then if that verdict qualifies, else drops. Waiting expires after
//            PENDING_TTL_MS. low / social never qualify (they are not settable).
// QUIET: the owner looking at the thread on any device (read-state.ts isViewing) → no push.
// COALESCE: messages of one thread arriving within COALESCE_MS go out as ONE notification (the
// newest message; with hidden previews "N new messages").
//
// PRIVACY: with hidePreviews the payload holds no sender and no text — "New message" only. The
// payload is never logged; logs carry counts only (no ids, names or text).
import { config } from "../config";
import { db } from "../db";
import { sendApnsResult, liveCommsApnsTokens, apnsEnabled, tokenRef, type ApnsNotification, type ApnsResult, type CommsApnsTokenRow } from "../apns";
import { eventBounds, eventsAfter, getThread, onCommsEvent, unreadSummary } from "./store";
import { folderRuleOf, getNotifySettings, NOTIFIABLE_STATUSES, type CommsNotifySettings, type NotifiableStatus } from "./notify-settings";
import { isViewing, readMarker } from "./read-state";
import { previewText } from "./naming";
import type { Message, Thread } from "./types";
import type { CommsStatus } from "./triage";

export const COALESCE_MS = 2_000;
export const PENDING_TTL_MS = 3 * 60 * 60_000;
const LOG_RETENTION_MS = 7 * 86_400_000;
/** Strangers never notify unless an owner folder says "all" (spam: never at all). The Low Priority
 *  folder follows the owner's "low" status switch (default off). */
const quietFolder = (s: CommsNotifySettings, folder: Thread["folder"]): boolean =>
  folder === "unknown" || (folder === "low" && !s.statuses.low);
const NO_VERDICT = new Set<CommsStatus>(["unclassified", "triage-failed"]);
const BODY_MAX = 180;
/** A message older than this at arrival (a backfill, a catch-up after downtime) never notifies. */
export const MAX_AGE_MS = 15 * 60_000;

export type Decision = "never" | "now" | "wait";

/** The verdict a thread carries for this decision: its status, or its last verdict. */
export function verdictOf(thread: Thread): CommsStatus | null {
  if (!NO_VERDICT.has(thread.status)) return thread.status;
  const r = db.prepare(`SELECT status FROM comms_thread_verdicts WHERE thread_id = ?`).get(thread.id) as { status: CommsStatus } | undefined;
  return r?.status ?? null;
}

const qualifies = (s: CommsNotifySettings, status: CommsStatus | null): boolean =>
  !!status && (NOTIFIABLE_STATUSES as readonly string[]).includes(status) && s.statuses[status as NotifiableStatus];

/** The gates that hold whatever the verdict (pure, apart from the read marker). */
export function blocked(s: CommsNotifySettings, thread: Thread, m: Pick<Message, "sentAt">): boolean {
  // Archived never pushes (a message that brings a chat back is logged as handled by
  // store.unarchiveOnArrival; this covers source archives and backfills that stay archived).
  if (!s.enabled || thread.muted || thread.folder === "spam" || thread.folder === "archived") return true;
  const rule = folderRuleOf(s, thread.folderIds);
  if (rule === "none") return true;
  if (rule !== "all") {
    if (quietFolder(s, thread.folder)) return true;
    const network = thread.networks[0];
    if (network && s.networks[network] === false) return true;
  }
  const mk = readMarker(thread.id);
  if (!!mk && !mk.manualUnread && mk.readAt !== "" && mk.readAt >= m.sentAt) return true;
  // A forum topic read on its own (fix round 1, I-4) past this message.
  const topic = (m as Partial<Pick<Message, "topic">>).topic?.id;
  if (topic && !mk?.manualUnread) {
    const tr = db.prepare(`SELECT read_at FROM comms_topic_read_markers WHERE cache_id = ?`).get(`th_${topic}`) as { read_at: string } | undefined;
    if (tr && tr.read_at >= m.sentAt) return true;
  }
  return false;
}

/** Arrival-time decision (D18 open point: fast path for known people and urgent threads). */
export function decideOnArrival(s: CommsNotifySettings, thread: Thread, m: Pick<Message, "sentAt">): Decision {
  if (blocked(s, thread, m)) return "never";
  if (folderRuleOf(s, thread.folderIds) === "all") return "now";
  const verdict = verdictOf(thread);
  if (qualifies(s, verdict)) return "now";
  if (!verdict && s.statuses.unclassified) return "now";
  if (!verdict && thread.kind === "dm" && thread.personId && s.knownPeopleImmediately) return "now";
  return "wait";
}

/** The APNs payload. With hidePreviews: no sender, no text, no title. */
export function buildCommsNotification(thread: Thread, m: Message, count: number, s: CommsNotifySettings, badge: number): ApnsNotification {
  // The verdict, not the stripped status: an urgent thread stays time-sensitive (review M1).
  const status = verdictOf(thread);
  const aps: Record<string, unknown> = {
    sound: "default",
    "thread-id": thread.id,
    badge,
    category: "COMMS_MESSAGE",
    "interruption-level": status === "urgent" ? "time-sensitive" : status === "informational" ? "passive" : "active",
  };
  if (s.hidePreviews) {
    aps.alert = { body: count > 1 ? `${count} new messages` : "New message" };
  } else {
    const sender = m.sender.name || thread.title;
    const text = previewText(m, "", false).replace(/\s+/g, " ").trim();
    const body = text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
    // A Telegram forum: the topic names where it was said ("General · Ann").
    const subtitle = m.topic?.title ? `${m.topic.title} · ${sender}` : sender;
    aps.alert = thread.kind === "group"
      ? { title: thread.title, subtitle, body: body || "New message" }
      : { title: sender, body: body || "New message" };
  }
  return {
    payload: { aps, type: "comms.message", threadId: thread.id },
    // One live notification per message burst; a newer burst of the same thread stacks under it.
    threadId: thread.id,
  };
}

// ── delivery seam ──────────────────────────────────────────────────────────────
export type NotifyDevice = Pick<CommsApnsTokenRow, "token" | "environment"> & Partial<Pick<CommsApnsTokenRow, "device_id" | "platform">> & { application: "comms" };
export interface NotifyDeps {
  devices(email: string): NotifyDevice[];
  send(row: NotifyDevice, n: ApnsNotification): Promise<ApnsResult>;
  enabled(): boolean;
}
const realDeps: NotifyDeps = {
  devices: (email) => liveCommsApnsTokens(email),
  send: (row, n) => sendApnsResult(row, n),
  enabled: () => apnsEnabled("comms"),
};

// ── delivery record (owner-testing round 4) ────────────────────────────────────
// What APNs last answered for each Comms device, in memory (a restart forgets). Shown to the owner
// in Notification settings (GET /notifications/settings `devices`) so "the iPhone gets nothing"
// can be told apart from "Apple refused the sandbox token". Status + reason only, never content.
export interface DeliveryRecord { status: number | null; reason: string; outcome: ApnsResult["outcome"]; at: number }
const deliveries = new Map<string, DeliveryRecord>();
const deliveryKey = (row: NotifyDevice) => row.device_id ?? `token:${tokenRef(row.token)}`;
export const lastDelivery = (deviceId: string): DeliveryRecord | null => deliveries.get(deviceId) ?? null;

/** Send one notification to every live Comms device of the owner; logs ONE line per push with
 *  each device's platform, APNs environment and answer (no ids, names or text). */
export async function deliverToOwner(n: ApnsNotification, label: string): Promise<Array<{ row: NotifyDevice; result: ApnsResult }>> {
  if (!config.ownerEmail) return [];
  const rows = deps.devices(config.ownerEmail);
  const results = await Promise.all(rows.map(async (row) => {
    let result: ApnsResult;
    try {
      result = await deps.send(row, n);
    } catch {
      result = { outcome: "failed", status: null, reason: "Error" };
    }
    deliveries.set(deliveryKey(row), { status: result.status, reason: result.reason, outcome: result.outcome, at: now() });
    return { row, result };
  }));
  const parts = results.map(({ row, result }) => `${row.platform ?? "?"}/${row.environment} ${result.status ?? "-"}${result.reason ? ` ${result.reason}` : ""}`);
  console.log(`[comms-notify] ${label}: ${rows.length ? parts.join(", ") : "no registered devices"}`);
  return results;
}
let deps: NotifyDeps = realDeps;
export function setNotifyDepsForTests(d: NotifyDeps | null): void {
  deps = d ?? realDeps;
}

// ── state ──────────────────────────────────────────────────────────────────────
interface Burst { messages: Message[]; timer: ReturnType<typeof setTimeout> | null }
interface Waiting { messages: Message[]; since: number; statusAtArrival: CommsStatus; sawNoVerdict: boolean }
const bursts = new Map<string, Burst>();
const waiting = new Map<string, Waiting>();
let cursor = 0;
let unsubscribe: (() => void) | null = null;
let processing = false;
let again = false;
let now: () => number = Date.now;
let coalesceMs = COALESCE_MS;
const stats = { pushed: 0, sent: 0, failed: 0 };
export const notifyStats = (): Readonly<typeof stats> => ({ ...stats });
export function setNotifyTuningForTests(t: { now?: () => number; coalesceMs?: number } | null): void {
  now = t?.now ?? Date.now;
  coalesceMs = t?.coalesceMs ?? COALESCE_MS;
}

const logStmt = db.prepare(`INSERT OR IGNORE INTO comms_notify_log (thread_id, message_id, at) VALUES (?, ?, ?)`);
const seenStmt = db.prepare(`SELECT 1 FROM comms_notify_log WHERE thread_id = ? AND message_id = ?`);
const verdictStmt = db.prepare(`INSERT INTO comms_thread_verdicts (thread_id, status, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(thread_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at WHERE comms_thread_verdicts.status != excluded.status`);

const incoming = (m: unknown): m is Message => {
  const x = m as Message | null;
  return !!x && typeof x === "object" && typeof x.id === "string" && !!x.sender && !x.sender.isSelf && !x.sender.isOmni && !x.redacted && !x.system;
};

function recordVerdict(thread: Thread): void {
  if (!NO_VERDICT.has(thread.status)) verdictStmt.run(thread.id, thread.status, now());
}

function queueNow(threadId: string, msgs: Message[]): void {
  let b = bursts.get(threadId);
  if (!b) bursts.set(threadId, (b = { messages: [], timer: null }));
  b.messages.push(...msgs);
  if (!b.timer) {
    b.timer = setTimeout(() => void flush(threadId), coalesceMs);
    b.timer.unref?.();
  }
}

/** Send one thread's burst now (tests call it directly). */
export async function flush(threadId: string): Promise<number> {
  const b = bursts.get(threadId);
  bursts.delete(threadId);
  if (b?.timer) clearTimeout(b.timer);
  const thread = getThread(threadId);
  if (!b || !thread || !b.messages.length) return 0;
  const s = getNotifySettings();
  const fresh = b.messages.filter((m) => !seenStmt.get(threadId, m.id) && !blocked(s, thread, m));
  if (!fresh.length) return 0;
  for (const m of fresh) logStmt.run(threadId, m.id, now());
  // The owner is reading this thread somewhere: logged as handled, nothing pushed.
  if (isViewing(threadId)) return 0;
  if (!config.commsNotifyEnabled || !deps.enabled() || !config.ownerEmail) return 0;
  const newest = fresh.reduce((a, m) => (m.sentAt >= a.sentAt ? m : a));
  const n = buildCommsNotification(thread, newest, fresh.length, s, unreadSummary().attention);
  const results = await deliverToOwner(n, "push");
  stats.pushed++;
  for (const { result } of results) if (result.outcome === "sent") stats.sent++; else if (result.outcome === "failed") stats.failed++;
  return results.length;
}

function onMessage(threadId: string, m: Message): void {
  const thread = getThread(threadId);
  if (!thread || seenStmt.get(threadId, m.id)) return;
  const sent = Date.parse(m.sentAt);
  if (!Number.isFinite(sent) || now() - sent > MAX_AGE_MS) return;
  const d = decideOnArrival(getNotifySettings(), thread, m);
  if (d === "now") return queueNow(threadId, [m]);
  if (d === "never") return;
  const w = waiting.get(threadId);
  if (w) w.messages.push(m);
  else waiting.set(threadId, { messages: [m], since: now(), statusAtArrival: thread.status, sawNoVerdict: NO_VERDICT.has(thread.status) });
}

function onThreadChanged(threadId: string): void {
  const thread = getThread(threadId);
  if (!thread) {
    waiting.delete(threadId);
    return;
  }
  recordVerdict(thread);
  const w = waiting.get(threadId);
  if (!w) return;
  if (NO_VERDICT.has(thread.status)) {
    w.sawNoVerdict = true;
    return;
  }
  // Only a FRESH verdict decides: the status moved since the message arrived (the classifier ran).
  if (thread.status === w.statusAtArrival && !w.sawNoVerdict) return;
  waiting.delete(threadId);
  const s = getNotifySettings();
  if (qualifies(s, thread.status)) queueNow(threadId, w.messages);
}

/**
 * The owner set this thread's status himself (the row's Status, final review M3): he has seen it,
 * so messages waiting for a classifier verdict are not pushed on the strength of his own choice.
 */
export function ownerSetStatus(threadId: string): void {
  waiting.delete(threadId);
}

function expireWaiting(): void {
  for (const [id, w] of waiting) if (now() - w.since > PENDING_TTL_MS) waiting.delete(id);
}

/** Read every comms event after the cursor. Serialized; re-runs if woken meanwhile. */
export async function processEvents(): Promise<void> {
  if (processing) {
    again = true;
    return;
  }
  processing = true;
  try {
    do {
      again = false;
      for (;;) {
        const batch = eventsAfter(cursor, 200);
        if (!batch.length) break;
        for (const e of batch) {
          cursor = e.id;
          const p = (e.payload ?? {}) as { threadId?: unknown; message?: unknown };
          const threadId = typeof p.threadId === "string" ? p.threadId : null;
          try {
            if (e.kind === "message.created" && threadId && incoming(p.message)) onMessage(threadId, p.message);
            else if (e.kind === "thread.updated") {
              if (threadId) onThreadChanged(threadId);
              else for (const id of [...waiting.keys()]) onThreadChanged(id); // a status burst
            }
          } catch {
            console.warn("[comms-notify] an event could not be handled");
          }
        }
      }
      expireWaiting();
    } while (again);
  } finally {
    processing = false;
  }
}

let lastPrune = 0;
function pruneLog(): void {
  if (now() - lastPrune < 60 * 60_000) return;
  lastPrune = now();
  db.prepare(`DELETE FROM comms_notify_log WHERE at < ?`).run(now() - LOG_RETENTION_MS);
}

/** Record every thread's current verdict once (first deploy / restart), so the arrival decision
 *  has one before the notifier saw any thread.updated (review M2). Never overwrites a newer row. */
export function seedVerdicts(): number {
  return db.prepare(`INSERT INTO comms_thread_verdicts (thread_id, status, updated_at)
    SELECT m.thread_id, c.status, ? FROM comms_thread_members m JOIN comms_conversations c ON c.id = m.conversation_id AND c.forum_id IS NULL
    WHERE c.status NOT IN ('unclassified', 'triage-failed')
    ON CONFLICT(thread_id) DO NOTHING`).run(now()).changes;
}

/** Startup hook (COMMS_ENABLED): follow the event log from now on. Idempotent. Pushes only with
 *  COMMS_NOTIFY_ENABLED (checked per push, so the flag can be flipped by a restart only). */
export function startCommsNotify(): () => void {
  if (unsubscribe) return stopCommsNotify;
  cursor = eventBounds().seq;
  seedVerdicts();
  unsubscribe = onCommsEvent(() => {
    pruneLog();
    void processEvents();
  });
  return stopCommsNotify;
}

export function stopCommsNotify(): void {
  unsubscribe?.();
  unsubscribe = null;
  for (const b of bursts.values()) if (b.timer) clearTimeout(b.timer);
  bursts.clear();
  waiting.clear();
}

/** Tests: start from the current end of the log with empty state. */
export function _resetNotifyForTests(): void {
  stopCommsNotify();
  deliveries.clear();
  cursor = eventBounds().seq;
  stats.pushed = stats.sent = stats.failed = 0;
}
export const _waitingForTests = (): string[] => [...waiting.keys()];
export const _setWaitingForTests = (threadId: string): void => {
  waiting.set(threadId, { messages: [], since: now(), statusAtArrival: "unclassified", sawNoVerdict: true });
};
export const _burstsForTests = (): string[] => [...bursts.keys()];

/** "Send a test notification" (Notification settings): a fixed, content-free alert to every Comms
 *  device of the owner, answered per device. Off switches as for real pushes. */
export async function sendTestNotification(): Promise<Array<{ deviceId: string | null; platform: string | null; environment: string; status: number | null; reason: string; outcome: ApnsResult["outcome"] }> | null> {
  if (!config.commsNotifyEnabled || !deps.enabled() || !config.ownerEmail) return null;
  const n: ApnsNotification = {
    payload: { aps: { alert: { title: "Comms", body: "Notifications are working" }, sound: "default", "thread-id": "comms-test" }, type: "comms.test" },
    collapseId: "comms-test",
  };
  const results = await deliverToOwner(n, "test");
  return results.map(({ row, result }) => ({ deviceId: row.device_id ?? null, platform: row.platform ?? null, environment: row.environment, status: result.status, reason: result.reason, outcome: result.outcome }));
}
