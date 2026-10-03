/**
 * Notifications, reminders and access requests (wave 2A) — the client half of
 * `apps/server/src/routes/notifications.ts`. Reaches the Prism Server through the
 * `serverFetch` seam, so the PWA (cookie) and the native client (device bearer)
 * both work and the desktop (no server) simply sees the feature as unavailable.
 *
 * Wire contract (server is the source of truth):
 *   GET  /api/notifications?box=inbox|archived&type=&limit=&before=   → NotificationPage
 *   GET  /api/notifications/unread                                    → { unread }
 *   POST /api/notifications/read      { ids?: string[], all?: true }  → { ok, unread }
 *   POST /api/notifications/archive   { ids: string[], archived }     → { ok, unread }
 *   GET  /api/notifications/settings                                  → NotificationSettingsResponse
 *   PUT  /api/notifications/settings  { settings }                    → NotificationSettingsResponse
 *   GET  /api/reminders                                               → { items: Reminder[] }
 *   POST /api/reminders   { noteId, at, tz, uid?, dateOnly? }         → { reminder }
 *   PATCH /api/reminders/:id { at, tz, dateOnly? }                    → { reminder }
 *   DELETE /api/reminders/:id                                         → { ok }
 *   POST /api/access-requests { noteId, level?, message? }            → 202 { ok }   (never an oracle)
 *   GET  /api/access-requests                                         → { items: AccessRequest[] }
 *   POST /api/access-requests/:id { decision, level? }                → { ok, status }
 */
import { serverFetch } from "../transport/serverFetch";

export type NotificationType =
  | "mention"
  | "comment_reply"
  | "comment_mention"
  | "reminder"
  | "share"
  | "access_request"
  | "access_granted"
  | "access_denied"
  | "suggestion_accepted"
  | "suggestion_rejected"
  | "suggestion_resolved";

export interface NotificationItem {
  id: string;
  type: NotificationType;
  /** The page it is about (always one the reader can currently view, except access outcomes). */
  noteId: string | null;
  /** Live title of that page (resolved at read time through the reader's permissions). */
  title: string | null;
  /** Display name of whoever caused it (never an email). */
  actor: { name: string } | null;
  /** Deep-link anchor: a mention chip uid, a comment thread id, or a reminder id. */
  anchor: { mention?: string; thread?: string; reminder?: string } | null;
  /** Short, already-safe preview (comment text; never page content). */
  preview: string | null;
  /** access_request only: the request to decide. */
  requestId?: string | null;
  createdAt: number;
  readAt: number | null;
  archivedAt: number | null;
}

export interface NotificationPage {
  items: NotificationItem[];
  next: string | null;
  unread: number;
}

export type NotificationChannel = { push: boolean; email: boolean };
export interface NotificationSettings {
  mention: NotificationChannel;
  comment: NotificationChannel;
  reminder: NotificationChannel;
  access: NotificationChannel;
}
export interface NotificationSettingsResponse {
  settings: NotificationSettings;
  /** What delivery is available on this server (not per device). */
  available: { webPush: boolean; apns: boolean; email: boolean };
}

export interface Reminder {
  id: string;
  noteId: string;
  title: string | null;
  /** Epoch ms when it fires. */
  at: number;
  tz: string;
  dateOnly: boolean;
  uid: string | null;
  status: "scheduled" | "fired" | "cancelled";
}

export type AccessLevel = "view" | "comment" | "suggest" | "edit";
export interface AccessRequest {
  id: string;
  noteId: string;
  title: string | null;
  /** `email` only for workspace owners/admins; a share-holder sees the name. */
  requester: { name: string; email?: string };
  level: AccessLevel;
  message: string | null;
  createdAt: number;
  status: "pending" | "approved" | "denied";
}

export class NotificationsError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const res = await serverFetch(path, { ...init, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new NotificationsError(res.status, (body as { error?: string } | null)?.error ?? `http_${res.status}`);
  return body as T;
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const notificationsApi = {
  list: (o: { box?: "inbox" | "archived"; type?: NotificationType; limit?: number; before?: string | null } = {}) =>
    call<NotificationPage>(`/api/notifications${qs({ box: o.box, type: o.type, limit: o.limit, before: o.before })}`),
  unread: () => call<{ unread: number }>("/api/notifications/unread"),
  markRead: (o: { ids?: string[]; all?: boolean }) =>
    call<{ ok: true; unread: number }>("/api/notifications/read", { method: "POST", body: JSON.stringify(o) }),
  archive: (ids: string[], archived = true) =>
    call<{ ok: true; unread: number }>("/api/notifications/archive", { method: "POST", body: JSON.stringify({ ids, archived }) }),
  /** Workspace members the caller may @-mention by account (opaque id + name; never an email).
   *  Empty on any failure (older server, desktop, guest). */
  mentionMembers: (q: string) =>
    call<{ members: Array<{ id: string; name: string }> }>(`/api/mentions/members${qs({ q })}`).then((r) => r.members ?? [], () => [] as Array<{ id: string; name: string }>),
  getSettings: () => call<NotificationSettingsResponse>("/api/notifications/settings"),
  putSettings: (settings: NotificationSettings) =>
    call<NotificationSettingsResponse>("/api/notifications/settings", { method: "PUT", body: JSON.stringify({ settings }) }),

  listReminders: () => call<{ items: Reminder[] }>("/api/reminders"),
  createReminder: (o: { noteId: string; at: string; tz: string; uid?: string | null; dateOnly?: boolean }) =>
    call<{ reminder: Reminder }>("/api/reminders", { method: "POST", body: JSON.stringify(o) }),
  updateReminder: (id: string, o: { at: string; tz: string; dateOnly?: boolean }) =>
    call<{ reminder: Reminder }>(`/api/reminders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(o) }),
  cancelReminder: (id: string) => call<{ ok: true }>(`/api/reminders/${encodeURIComponent(id)}`, { method: "DELETE" }),

  requestAccess: (o: { noteId: string; level?: AccessLevel; message?: string }) =>
    call<{ ok: true }>("/api/access-requests", { method: "POST", body: JSON.stringify(o) }),
  listAccessRequests: () => call<{ items: AccessRequest[] }>("/api/access-requests"),
  decideAccessRequest: (id: string, decision: "approve" | "deny", level?: AccessLevel) =>
    call<{ ok: true; status: AccessRequest["status"] }>(`/api/access-requests/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision, level }),
    }),
};

/** The viewer's IANA time zone (falls back to UTC). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
