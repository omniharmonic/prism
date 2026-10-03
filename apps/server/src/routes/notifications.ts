/**
 * Notifications inbox, reminders and access requests (wave 2A) — mounted inside
 * the gateway (`routes/api.ts`) BEFORE the owner short-circuit, like /tree and the
 * pages API, so owners and members alike reach these handlers.
 *
 *   GET    /api/notifications?box=inbox|archived&type=&limit=&before=   own items, paged, per user × vault
 *   GET    /api/notifications/unread                                    { unread }
 *   POST   /api/notifications/read      { ids?: string[] | all: true }  → { ok, unread }
 *   POST   /api/notifications/archive   { ids: string[], archived }     → { ok, unread }
 *   GET    /api/notifications/settings                                  → { settings, available }
 *   PUT    /api/notifications/settings  { settings }                    → { settings, available }
 *   GET    /api/reminders                                               → { items }
 *   POST   /api/reminders   { noteId, at, tz, uid?, dateOnly? }         → 201 { reminder }
 *   PATCH  /api/reminders/:id { at, tz, dateOnly? }                     → { reminder }
 *   DELETE /api/reminders/:id                                           → { ok }
 *   POST   /api/access-requests { noteId, level?, message? }            → 202 { ok }   (always — never an oracle)
 *   GET    /api/access-requests                                         → { items } (requests the caller may decide)
 *   POST   /api/access-requests/:id { decision: approve|deny, level? }  → { ok, status }
 *
 * Signed-in USERS only (session cookie or device token): capability links and
 * anon get 401 — a link holder has no inbox. Every write passes `csrfRefusal`;
 * bodies are capped; ids are strict; a note the caller can't view is
 * indistinguishable from a missing one (404 `not_found`), and the access-request
 * POST answers 202 for both before any lookup runs.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { resolveVaultEntry } from "../db";
import { roleAtLeast, workspaceRole } from "../roles";
import { config, emailEnabled } from "../config";
import { pushEnabled } from "../push";
import { apnsEnabled } from "../apns";
import { consumeRateLimit } from "../middleware/ratelimit";
import { csrfRefusal } from "./actions";
import { isNoteId } from "../collab";
import type { ParsedMention } from "@prism/core/mentions";
import { vaultClient } from "../parachute";
import {
  TYPE_GROUPS,
  isNotificationType,
  listNotifications,
  unreadCount,
  markRead,
  setArchived,
  getSettings,
  putSettings,
  sanitizeSettings,
  noteInfo,
  userCanView,
  isTimeZone,
  parseReminderAt,
  insertReminder,
  getReminder,
  updateReminder,
  cancelReminder,
  listReminderRows,
  countLiveReminders,
  MAX_LIVE_REMINDERS,
  recordAccessRequest,
  decideAccessRequest,
  pendingAccessRequests,
  canDecide,
  displayName,
  REQUEST_LEVELS,
  noteContentStored,
  cachedChips,
  type NotificationType,
  type ReminderRow,
  type RequestLevel,
} from "../notifications";

export const notificationsRoutes = new Hono();

type UserActor = Extract<Actor, { kind: "user" }>;
interface Who {
  actor: UserActor;
  email: string;
  vaultId: string;
}

/** Admins choose the vault per request (X-Prism-Vault); everyone else is bound to theirs. */
function who(c: Context): Who | null {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return null;
  const vaultId = roleAtLeast(actor.role, "admin") ? resolveVaultEntry(c.req.header("x-prism-vault")).id : actor.vaultId;
  return { actor, email: actor.email.toLowerCase(), vaultId };
}
const unauthorized = (c: Context) => c.json({ error: "unauthorized" }, 401);
const notFound = (c: Context) => c.json({ error: "not_found" }, 404);
const limited = (c: Context, retry: number) => {
  c.header("Retry-After", String(retry));
  return c.json({ error: "rate_limited", retryAfter: retry }, 429);
};
const SMALL = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) });

/** CSRF for a body-less DELETE: same origin rules as csrfRefusal, no content-type requirement. */
function originRefusal(c: Context): Response | null {
  if (requestVia(c) === "device") return null;
  const site = (c.req.header("sec-fetch-site") ?? "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return c.json({ error: "csrf_refused" }, 403);
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    const o = origin.replace(/\/+$/, "");
    if (o !== config.appOrigin && !config.nativeOrigins.includes(o)) return c.json({ error: "csrf_refused" }, 403);
  }
  return null;
}

async function json(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const strIds = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && ID.test(x)) ? (v as string[]) : null;

const readsPerMinute = () => Number(process.env.NOTIFY_READS_PER_MINUTE ?? 240);
// Reads are memory/SQLite (plus the tree projection); still bounded per user.
notificationsRoutes.use("/notifications/*", async (c, next) => {
  const w = who(c);
  if (!w) return unauthorized(c);
  const retry = consumeRateLimit(`notifications:${w.email}`, readsPerMinute(), 60_000);
  if (retry !== null) return limited(c, retry);
  await next();
});
notificationsRoutes.use("/notifications", async (c, next) => {
  const w = who(c);
  if (!w) return unauthorized(c);
  const retry = consumeRateLimit(`notifications:${w.email}`, readsPerMinute(), 60_000);
  if (retry !== null) return limited(c, retry);
  await next();
});

notificationsRoutes.get("/notifications", async (c) => {
  const w = who(c)!;
  const box = c.req.query("box") === "archived" ? "archived" : "inbox";
  const rawType = c.req.query("type") ?? "";
  let types: NotificationType[] | null = null;
  if (rawType) {
    if (TYPE_GROUPS[rawType]) types = TYPE_GROUPS[rawType]!;
    else if (isNotificationType(rawType)) types = [rawType];
    else return c.json({ error: "bad_request" }, 400);
  }
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const rawBefore = c.req.query("before") ?? "";
  let before: { at: number; id: string } | null = null;
  if (rawBefore) {
    const m = /^(\d{1,15}):([A-Za-z0-9-]{1,64})$/.exec(rawBefore);
    if (!m) return c.json({ error: "bad_request" }, 400);
    before = { at: Number(m[1]), id: m[2]! };
  }
  const page = await listNotifications(w.email, w.vaultId, { box, types, limit, before });
  c.header("Cache-Control", "private, no-store");
  return c.json({ ...page, unread: await unreadCount(w.email, w.vaultId) });
});

notificationsRoutes.get("/notifications/unread", async (c) => {
  const w = who(c)!;
  c.header("Cache-Control", "private, no-store");
  return c.json({ unread: await unreadCount(w.email, w.vaultId) });
});

notificationsRoutes.post("/notifications/read", SMALL, async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const w = who(c)!;
  const b = await json(c);
  if (!b) return c.json({ error: "bad_request" }, 400);
  if (b.all === true) markRead(w.email, w.vaultId, { all: true });
  else {
    const ids = strIds(b.ids);
    if (!ids) return c.json({ error: "bad_request" }, 400);
    markRead(w.email, w.vaultId, { ids });
  }
  return c.json({ ok: true, unread: await unreadCount(w.email, w.vaultId) });
});

notificationsRoutes.post("/notifications/archive", SMALL, async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const w = who(c)!;
  const b = await json(c);
  const ids = b ? strIds(b.ids) : null;
  if (!b || !ids || (b.archived !== undefined && typeof b.archived !== "boolean")) return c.json({ error: "bad_request" }, 400);
  setArchived(w.email, w.vaultId, ids, b.archived !== false);
  return c.json({ ok: true, unread: await unreadCount(w.email, w.vaultId) });
});

const available = () => ({ webPush: pushEnabled(), apns: apnsEnabled(), email: emailEnabled() });
notificationsRoutes.get("/notifications/settings", (c) => {
  const w = who(c)!;
  return c.json({ settings: getSettings(w.email), available: available() });
});
notificationsRoutes.put("/notifications/settings", SMALL, async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const w = who(c)!;
  const b = await json(c);
  const s = b ? sanitizeSettings(b.settings) : null;
  if (!s) return c.json({ error: "bad_request" }, 400);
  putSettings(w.email, s);
  return c.json({ settings: s, available: available() });
});

// ── reminders ────────────────────────────────────────────────────────────────
const MAX_AHEAD_MS = 5 * 366 * 86_400_000;
async function reminderView(r: ReminderRow) {
  const info = await noteInfo(r.vault_id, r.note_id);
  if (!userCanView(r.owner_email, r.vault_id, info)) return null;
  return { id: r.id, noteId: r.note_id, title: info!.title, at: r.at, tz: r.tz, dateOnly: !!r.date_only, uid: r.uid, status: r.status };
}
function ownReminder(c: Context, w: Who): ReminderRow | null {
  const id = c.req.param("id") ?? "";
  if (!ID.test(id)) return null;
  const r = getReminder(id);
  return r && r.owner_email === w.email && r.vault_id === w.vaultId ? r : null;
}
function readTime(b: Record<string, unknown>): { at: number; tz: string; dateOnly: boolean } | "bad" {
  if (!isTimeZone(b.tz)) return "bad";
  if (b.dateOnly !== undefined && typeof b.dateOnly !== "boolean") return "bad";
  const dateOnly = b.dateOnly === true;
  const at = parseReminderAt(b.at, b.tz, dateOnly);
  if (at === null) return "bad";
  const now = Date.now();
  if (at < now - 60_000 || at > now + MAX_AHEAD_MS) return "bad";
  return { at, tz: b.tz, dateOnly };
}

notificationsRoutes.use("/reminders/*", async (c, next) => (who(c) ? next() : unauthorized(c)));
notificationsRoutes.use("/reminders", async (c, next) => (who(c) ? next() : unauthorized(c)));

notificationsRoutes.get("/reminders", async (c) => {
  const w = who(c)!;
  const items = [];
  for (const r of listReminderRows(w.email, w.vaultId)) {
    const v = await reminderView(r);
    if (v) items.push(v);
  }
  c.header("Cache-Control", "private, no-store");
  return c.json({ items });
});

notificationsRoutes.post("/reminders", SMALL, async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const w = who(c)!;
  const retry = consumeRateLimit(`reminders:${w.email}`, 60, 60_000);
  if (retry !== null) return limited(c, retry);
  const b = await json(c);
  if (!b || typeof b.noteId !== "string" || !isNoteId(b.noteId)) return c.json({ error: "bad_request" }, 400);
  if (b.uid !== undefined && b.uid !== null && (typeof b.uid !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(b.uid))) return c.json({ error: "bad_request" }, 400);
  const t = readTime(b);
  if (t === "bad") return c.json({ error: "bad_request", reason: "at must be a date (dateOnly) or an ISO time with an offset, within 5 years; tz an IANA zone" }, 400);
  const info = await noteInfo(w.vaultId, b.noteId, { fresh: true });
  if (!userCanView(w.email, w.vaultId, info)) return notFound(c);
  if (countLiveReminders(w.email) >= MAX_LIVE_REMINDERS) return c.json({ error: "too_many_reminders" }, 429);
  const row = insertReminder({ id: randomUUID(), vault_id: w.vaultId, owner_email: w.email, note_id: b.noteId, at: t.at, tz: t.tz, date_only: t.dateOnly ? 1 : 0, uid: (b.uid as string | undefined) ?? null });
  return c.json({ reminder: await reminderView(row) }, 201);
});

notificationsRoutes.patch("/reminders/:id", SMALL, async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const w = who(c)!;
  const r = ownReminder(c, w);
  if (!r || r.status === "cancelled") return notFound(c);
  const b = await json(c);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const t = readTime(b);
  if (t === "bad") return c.json({ error: "bad_request" }, 400);
  if (!updateReminder(r.id, t.at, t.tz, t.dateOnly)) return notFound(c);
  const v = await reminderView(getReminder(r.id)!);
  return v ? c.json({ reminder: v }) : notFound(c);
});

notificationsRoutes.delete("/reminders/:id", async (c) => {
  const csrf = originRefusal(c);
  if (csrf) return csrf;
  const w = who(c)!;
  const r = ownReminder(c, w);
  if (!r) return notFound(c);
  cancelReminder(r.id);
  return c.json({ ok: true });
});

// ── access requests ──────────────────────────────────────────────────────────
notificationsRoutes.use("/access-requests/*", async (c, next) => (who(c) ? next() : unauthorized(c)));
notificationsRoutes.use("/access-requests", async (c, next) => (who(c) ? next() : unauthorized(c)));

notificationsRoutes.post("/access-requests", SMALL, async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const w = who(c)!;
  const b = await json(c);
  if (!b || typeof b.noteId !== "string") return c.json({ error: "bad_request" }, 400);
  const level = (b.level ?? "view") as RequestLevel;
  if (!(REQUEST_LEVELS as readonly string[]).includes(level)) return c.json({ error: "bad_request" }, 400);
  if (b.message !== undefined && b.message !== null && (typeof b.message !== "string" || b.message.length > 500 || /[\u0000-\u0008\u000b-\u001f]/.test(b.message))) {
    return c.json({ error: "bad_request" }, 400);
  }
  const retry = consumeRateLimit(`access-requests:${w.email}`, 20, 3_600_000);
  if (retry !== null) return limited(c, retry);
  // Everything after this line is invisible to the caller: same 202 whether the
  // note exists, is viewable, or was already requested (no existence oracle; the
  // lookup runs after the response so timing doesn't tell either).
  if (isNoteId(b.noteId)) {
    const o = { vaultId: w.vaultId, noteId: b.noteId, requester: w.email, level, message: typeof b.message === "string" ? b.message.trim() || null : null };
    setTimeout(() => void recordAccessRequest(o).catch((e) => console.error(`[access-requests] ${(e as Error).message}`)), 0);
  }
  return c.json({ ok: true }, 202);
});

notificationsRoutes.get("/access-requests", async (c) => {
  const w = who(c)!;
  const admin = roleAtLeast(workspaceRole(w.email, w.vaultId), "admin");
  const items = [];
  for (const r of pendingAccessRequests(w.vaultId)) {
    const info = await noteInfo(r.vault_id, r.note_id);
    if (!canDecide(w.email, w.vaultId, info)) continue;
    items.push({
      id: r.id,
      noteId: r.note_id,
      title: info!.title,
      // L7: workspace owners/admins see who is asking by email; a page's
      // share-holder sees a display name only.
      requester: admin ? { email: r.requester, name: displayName(r.requester) } : { name: displayName(r.requester) },
      level: r.level,
      message: r.message,
      createdAt: r.created_at,
      status: r.status,
    });
    if (items.length >= 100) break;
  }
  c.header("Cache-Control", "private, no-store");
  return c.json({ items });
});

notificationsRoutes.post("/access-requests/:id", SMALL, async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const w = who(c)!;
  const id = c.req.param("id");
  if (!ID.test(id)) return notFound(c);
  const b = await json(c);
  if (!b || (b.decision !== "approve" && b.decision !== "deny")) return c.json({ error: "bad_request" }, 400);
  if (b.level !== undefined && !(REQUEST_LEVELS as readonly string[]).includes(b.level as string)) return c.json({ error: "bad_request" }, 400);
  const r = await decideAccessRequest({ id, vaultId: w.vaultId, decider: w.email, decision: b.decision, level: b.level as RequestLevel | undefined });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, status: r.status });
});

// ── REST content writes → mention processing (owner passthrough + member route) ──
/**
 * Mounted in routes/api.ts on `/notes` and `/notes/:id` BEFORE the owner
 * short-circuit, so both the passthrough and the member route are covered. Only a
 * successful content write whose body carries a mention chip does any work, and
 * never changes the response.
 *
 * Review M4: the server remembers each note's last-seen chip set
 * (`cachedChips`), so an autosave of a page whose chips are all known reads
 * nothing. Only a body with an unknown chip (and no cache) pre-reads the stored
 * content. Over the per-user pre-read budget the work is DEFERRED, not dropped:
 * after the write, the previous body comes from the note's version history.
 */
export const restMentionHook: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  const id = c.req.param("id");
  const isCreate = method === "POST" && !id;
  if (!isCreate && method !== "PATCH" && method !== "PUT") return next();
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return next();
  }
  if (raw.length > 4_000_000 || raw.indexOf("mention") < 0) return next();
  let content: string | null = null;
  try {
    const b = JSON.parse(raw) as { content?: unknown };
    content = typeof b?.content === "string" ? b.content : null;
  } catch {
    return next();
  }
  if (!content || content.indexOf('data-type="mention"') < 0) return next();
  const actor = resolveActor(c);
  if (actor.kind !== "user") return next();
  const vaultId = roleAtLeast(actor.role, "admin") ? resolveVaultEntry(c.req.header("x-prism-vault")).id : actor.vaultId;
  let prev: string | null = "";
  let prevMentions: ParsedMention[] | null = null;
  let deferred = false;
  if (!isCreate) {
    if (!id || !isNoteId(id)) return next();
    prevMentions = cachedChips(vaultId, id);
    if (!prevMentions) {
      prev = null;
      if (consumeRateLimit(`mention-hook:${actor.email}`, 120, 60_000) !== null) deferred = true;
      else {
        try {
          const n = await vaultClient(vaultId, { timeoutMs: 10_000 }).getNote(id);
          if (n.id !== id) return next();
          prev = n.content ?? "";
        } catch {
          return next();
        }
      }
    } else {
      // Known chips only (incl. removals): nothing to notify; links still diff.
      prev = null;
    }
  }
  await next();
  const status = c.res.status;
  if (status < 200 || status >= 300) return;
  let body: { id?: unknown; updatedAt?: unknown } = {};
  try {
    body = (await c.res.clone().json()) as typeof body;
  } catch {
    /* no JSON body */
  }
  const noteId = isCreate ? (typeof body.id === "string" ? body.id : null) : id!;
  if (!noteId || !isNoteId(noteId)) return;
  const updatedAt = typeof body.updatedAt === "string" ? body.updatedAt : null;
  const run = (p: string | null) =>
    void noteContentStored({ vaultId, noteId, prev: p, prevMentions, next: content!, authors: [actor.email], updatedAt });
  if (!deferred) return run(prev);
  // Deferred: the version captured by THIS write is the body it replaced.
  setTimeout(() => {
    void (async () => {
      try {
        const v = vaultClient(vaultId, { timeoutMs: 10_000 });
        const { versions } = await v.listVersions(noteId, 1);
        const row = versions[0];
        if (!row) return;
        const old = await v.getVersion(noteId, row.version_ix);
        run(old.content ?? "");
      } catch {
        /* history unavailable: this batch's chips are not diffed (logged nowhere, no content) */
      }
    })();
  }, 1000);
};
