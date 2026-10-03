/**
 * Notifications, mentions, reminders and access requests (wave 2A — NP-RF-03…07,
 * NP-CO-01/03/04/13). Routes live in routes/notifications.ts; this module is the
 * store, the producers and the delivery fan-out.
 *
 * PRODUCERS
 *  - Document mentions: `noteContentStored` runs after a document is persisted —
 *    by the collab store (collab.ts listener) or by a REST content write through
 *    the gateway (routes/api.ts middleware, owner passthrough AND non-owner
 *    route). It diffs the mention chips of the previous vs the new content
 *    (`@prism/core/mentions`), so only NEW chips notify. A person chip resolves
 *    the person note's email identities to accounts. A page/person chip also adds
 *    a vault link `mentions` (NP-RF-07 backlinks) with a CAS write.
 *  - Comments (collab only): new thread items are diffed against a per-document
 *    baseline (taken when the doc loads); participants of the thread get
 *    `comment_reply`, people @-mentioned in the text get `comment_mention`.
 *  - Reminders: a bounded, idempotent worker (`runRemindersOnce`).
 *  - Sharing: `notifyShare` (acl.ts) and access-request decisions.
 *
 * RULES (every producer)
 *  - never notify the author (every editor of the batch is an author);
 *  - only notify someone who can VIEW the note (effectiveCaps, private-note rule,
 *    Trash excluded) — checked at creation, re-checked at delivery and at read
 *    time, so a revoked grant hides the item and its title;
 *  - dedupe keys make every producer idempotent; per-recipient hourly cap;
 *  - push / APNs payloads are IDS ONLY with generic text; email is a content-free
 *    "you have unread notifications" digest for users who haven't read them.
 */
import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { db, getUser, listMemberships, listUsers, grantsForUser, resolveVaultEntry, hasAccount, upsertGrant } from "./db";
import { config, emailEnabled } from "./config";
import { effectiveCaps, expandLevel, type Cap, type NoteRef, type Level } from "./permissions";
import { workspaceRole, roleAtLeast, roleFloor } from "./roles";
import { ensureTree, rowRef } from "./tree";
import { vaultClient, VaultConflictError, type Note } from "./parachute";
import { newMentions, extractCommentMentions, COMMENT_MENTION } from "@prism/core/mentions";
import { pageTitle, TRASH_TAG } from "@prism/core/pages";
import { personSummary } from "./people-directory";
import { sendPush, pushEnabled } from "./push";
import { apnsEnabled, sendApnsToOwner, notificationAlert } from "./apns";
import { sendEmail } from "./auth/email";
import { documentActorId } from "./human-collab";
import { consumeRateLimit } from "./middleware/ratelimit";
import { docNameFor, isDocLive, markReconciled, setDocumentStoreListener, type DocumentStoredEvent } from "./collab";

// ── schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    type TEXT NOT NULL,
    note_id TEXT,
    actor_email TEXT,
    anchor TEXT,
    preview TEXT,
    request_id TEXT,
    dedupe_key TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    archived_at INTEGER,
    delivered_at INTEGER,
    emailed_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications(recipient, vault_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS notifications_inbox ON notifications(recipient, vault_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS notification_settings (
    email TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_email_log (
    email TEXT PRIMARY KEY,
    last_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    note_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    tz TEXT NOT NULL,
    date_only INTEGER NOT NULL DEFAULT 0,
    uid TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    fired_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, at);
  CREATE INDEX IF NOT EXISTS reminders_owner ON reminders(owner_email, vault_id, status, at);
  CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    requester TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    notified_at INTEGER,
    decided_at INTEGER,
    decided_by TEXT
  );
  CREATE TABLE IF NOT EXISTS comment_participants (
    vault_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    email TEXT NOT NULL,
    PRIMARY KEY (vault_id, note_id, thread_id, email)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS access_requests_pending ON access_requests(vault_id, note_id, requester) WHERE status = 'pending';
`);

export const NOTIFICATION_TABLES = ["notifications", "notification_settings", "notification_email_log", "reminders", "access_requests", "comment_participants"] as const;
/** Tests: wipe this module's tables and in-memory state. */
export function _resetNotifications(): void {
  for (const t of NOTIFICATION_TABLES) db.exec(`DELETE FROM ${t}`);
  commentBaselines.clear();
  refCache.clear();
  actorIdCache = null;
  deliveryHook = null;
}

// ── types ────────────────────────────────────────────────────────────────────
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
  | "suggestion_rejected";
const TYPES: readonly NotificationType[] = ["mention", "comment_reply", "comment_mention", "reminder", "share", "access_request", "access_granted", "access_denied", "suggestion_accepted", "suggestion_rejected"];
export const isNotificationType = (t: unknown): t is NotificationType => typeof t === "string" && (TYPES as readonly string[]).includes(t);
/** Filter groups the inbox offers (also accepts an exact type). */
export const TYPE_GROUPS: Record<string, NotificationType[]> = {
  mention: ["mention", "comment_mention"],
  comment: ["comment_reply", "comment_mention"],
  reminder: ["reminder"],
  access: ["access_request", "access_granted", "access_denied", "share"],
};

export type Category = "mention" | "comment" | "reminder" | "access";
const categoryOf = (t: NotificationType): Category =>
  t === "mention" || t === "comment_mention" ? "mention" : t === "comment_reply" ? "comment" : t === "reminder" ? "reminder" : "access";

export interface Anchor {
  mention?: string;
  thread?: string;
  reminder?: string;
}

interface Row {
  id: string;
  vault_id: string;
  recipient: string;
  type: NotificationType;
  note_id: string | null;
  actor_email: string | null;
  anchor: string | null;
  preview: string | null;
  request_id: string | null;
  dedupe_key: string | null;
  created_at: number;
  read_at: number | null;
  archived_at: number | null;
  delivered_at: number | null;
  emailed_at: number | null;
}

export interface NotificationView {
  id: string;
  type: NotificationType;
  noteId: string | null;
  title: string | null;
  actor: { name: string } | null;
  anchor: Anchor | null;
  preview: string | null;
  requestId: string | null;
  createdAt: number;
  readAt: number | null;
  archivedAt: number | null;
}

// ── settings ─────────────────────────────────────────────────────────────────
export type Channel = { push: boolean; email: boolean };
export type Settings = Record<Category, Channel>;
export const DEFAULT_SETTINGS: Settings = {
  mention: { push: true, email: true },
  comment: { push: true, email: true },
  reminder: { push: true, email: false },
  access: { push: true, email: true },
};
const CATEGORIES: readonly Category[] = ["mention", "comment", "reminder", "access"];

export function sanitizeSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(CATEGORIES as readonly string[]).includes(k)) return null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const c = v as Record<string, unknown>;
    for (const key of Object.keys(c)) if (key !== "push" && key !== "email") return null;
    if (c.push !== undefined && typeof c.push !== "boolean") return null;
    if (c.email !== undefined && typeof c.email !== "boolean") return null;
    out[k as Category] = { push: c.push ?? out[k as Category].push, email: c.email ?? out[k as Category].email };
  }
  return out;
}
const st = {
  getSettings: db.prepare("SELECT json FROM notification_settings WHERE email = ?"),
  putSettings: db.prepare(
    "INSERT INTO notification_settings (email, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
  ),
  insert: db.prepare(
    `INSERT OR IGNORE INTO notifications (id, vault_id, recipient, type, note_id, actor_email, anchor, preview, request_id, dedupe_key, created_at)
     VALUES (@id, @vault_id, @recipient, @type, @note_id, @actor_email, @anchor, @preview, @request_id, @dedupe_key, @created_at)`,
  ),
  get: db.prepare("SELECT * FROM notifications WHERE id = ?"),
  delivered: db.prepare("UPDATE notifications SET delivered_at = ? WHERE id = ?"),
  unreadRows: db.prepare(
    "SELECT * FROM notifications WHERE recipient = ? AND vault_id = ? AND read_at IS NULL AND archived_at IS NULL ORDER BY created_at DESC LIMIT 500",
  ),
  readAll: db.prepare("UPDATE notifications SET read_at = ? WHERE recipient = ? AND vault_id = ? AND read_at IS NULL"),
  readOne: db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient = ? AND vault_id = ?"),
  archiveOne: db.prepare("UPDATE notifications SET archived_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient = ? AND vault_id = ?"),
  unarchiveOne: db.prepare("UPDATE notifications SET archived_at = NULL WHERE id = ? AND recipient = ? AND vault_id = ?"),
  readForRequest: db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE request_id = ? AND type = 'access_request'"),
  pruneOld: db.prepare("DELETE FROM notifications WHERE created_at < ?"),
};

export function getSettings(email: string): Settings {
  const row = st.getSettings.get(email.toLowerCase()) as { json: string } | undefined;
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  try {
    return sanitizeSettings(JSON.parse(row.json)) ?? structuredClone(DEFAULT_SETTINGS);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
export function putSettings(email: string, s: Settings): void {
  st.putSettings.run(email.toLowerCase(), JSON.stringify(s), Date.now());
}

// ── note references (view checks, titles) ────────────────────────────────────
export interface NoteInfo {
  ref: NoteRef;
  title: string;
  trashed: boolean;
}
const refCache = new Map<string, { at: number; info: NoteInfo | null }>();
const REF_TTL_MS = 15_000;

const infoFromNote = (n: Pick<Note, "id" | "path" | "tags" | "metadata">): NoteInfo => ({
  ref: {
    id: n.id,
    tags: n.tags ?? [],
    creator: (n.metadata?.prism_creator as string | undefined) ?? null,
    visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
  },
  title: pageTitle(n.path),
  trashed: (n.tags ?? []).includes(TRASH_TAG),
});

/**
 * Where is a note, and who may see it? The in-memory tree projection first (no
 * vault call), else one lean read. Unknown vault or missing note → null.
 */
export async function noteInfo(vaultId: string, noteId: string, opts: { fresh?: boolean } = {}): Promise<NoteInfo | null> {
  const entry = resolveVaultEntry(vaultId);
  if (entry.id !== vaultId) return null;
  const key = `${vaultId}\0${noteId}`;
  const hit = refCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < REF_TTL_MS) return hit.info;
  let info: NoteInfo | null = null;
  try {
    const tree = await ensureTree(entry);
    const row = tree.state.rows.get(noteId);
    // The projection is live (vault subscribe socket + gateway write-through), so
    // `fresh` only bypasses the short TTL cache, never the tree.
    if (row) {
      info = { ref: rowRef(row), title: pageTitle(row.path), trashed: row.tags.includes(TRASH_TAG) || !!row.trashedAt };
    }
  } catch {
    /* tree unavailable: fall back to the vault */
  }
  if (!info) {
    try {
      const n = await vaultClient(vaultId, { timeoutMs: 10_000 }).getNote(noteId);
      info = n.id === noteId ? infoFromNote(n) : null;
    } catch {
      info = null;
    }
  }
  refCache.set(key, { at: Date.now(), info });
  if (refCache.size > 2000) for (const k of [...refCache.keys()].slice(0, 500)) refCache.delete(k);
  return info;
}
export const forgetNoteInfo = (vaultId: string, noteId: string) => refCache.delete(`${vaultId}\0${noteId}`);
/** Tests / access changes: drop every cached note reference. */
export const clearNoteInfoCache = (): void => refCache.clear();

/** The caps a signed-in USER holds on a note in a vault (gateway math). */
export function userCaps(email: string, vaultId: string, ref: NoteRef): Set<Cap> | "admin" {
  const role = workspaceRole(email, vaultId);
  if (roleAtLeast(role, "admin")) return "admin";
  return effectiveCaps(grantsForUser(email, vaultId), ref, roleFloor(role), email);
}
export function userCanView(email: string, vaultId: string, info: NoteInfo | null): boolean {
  if (!info || info.trashed) return false;
  const caps = userCaps(email, vaultId, info.ref);
  return caps === "admin" || caps.has("view");
}

// ── accounts ─────────────────────────────────────────────────────────────────
/** Display name for an account — never its email. */
export function displayName(email: string | null | undefined): string {
  if (!email) return "Someone";
  const n = getUser(email)?.name?.trim();
  return n || "A teammate";
}
const isAccount = (email: string) => email === config.ownerEmail || hasAccount(email);

/** Reverse of human-collab's `documentActorId` for every known account. */
let actorIdCache: { n: number; map: Map<string, string> } | null = null;
export function emailForActorId(actorId: string): string | null {
  const users = listUsers();
  if (!actorIdCache || actorIdCache.n !== users.length) {
    const map = new Map<string, string>();
    for (const u of users) map.set(documentActorId(`user:${u.email}`), u.email);
    if (config.ownerEmail) map.set(documentActorId(`user:${config.ownerEmail}`), config.ownerEmail);
    actorIdCache = { n: users.length, map };
  }
  return actorIdCache.map.get(actorId) ?? null;
}

/** Account emails behind a person note (its email identities that have an account). */
export async function accountsForPerson(vaultId: string, personId: string): Promise<string[]> {
  try {
    const n = await vaultClient(vaultId, { timeoutMs: 10_000 }).getNote(personId);
    if (n.id !== personId || !(n.tags ?? []).includes("person")) return [];
    const emails = personSummary(n).identities.filter((i) => i.kind === "email").map((i) => i.value.toLowerCase());
    return [...new Set(emails)].filter(isAccount).slice(0, 5);
  } catch {
    return [];
  }
}

// ── create + deliver ─────────────────────────────────────────────────────────
const MAX_PER_RECIPIENT_HOUR = Number(process.env.NOTIFY_MAX_PER_RECIPIENT_HOUR ?? 200);
const PREVIEW_MAX = 160;

/** Delivery seam (tests): observe or replace push delivery. */
type DeliveryHook = (n: { id: string; recipient: string; type: NotificationType }) => void;
let deliveryHook: DeliveryHook | null = null;
export function setDeliveryHook(h: DeliveryHook | null): void {
  deliveryHook = h;
}

export interface NewNotification {
  vaultId: string;
  recipient: string;
  type: NotificationType;
  noteId: string | null;
  actorEmail: string | null;
  anchor?: Anchor | null;
  preview?: string | null;
  requestId?: string | null;
  dedupe: string;
}

/** Insert (idempotent by dedupe key) and fan out. Returns the new id, or null. */
export function createNotification(n: NewNotification): string | null {
  const recipient = n.recipient.toLowerCase();
  if (n.actorEmail && recipient === n.actorEmail.toLowerCase()) return null; // never the author
  if (consumeRateLimit(`notify:${recipient}`, MAX_PER_RECIPIENT_HOUR, 3_600_000) !== null) return null;
  const id = randomUUID();
  const r = st.insert.run({
    id,
    vault_id: n.vaultId,
    recipient,
    type: n.type,
    note_id: n.noteId,
    actor_email: n.actorEmail?.toLowerCase() ?? null,
    anchor: n.anchor ? JSON.stringify(n.anchor) : null,
    preview: n.preview ? n.preview.slice(0, PREVIEW_MAX) : null,
    request_id: n.requestId ?? null,
    dedupe_key: n.dedupe.slice(0, 400),
    created_at: Date.now(),
  });
  if (r.changes !== 1) return null;
  void deliver(id).catch((e) => console.error(`[notify] deliver failed: ${(e as Error).message}`));
  return id;
}

/** Push / APNs for one notification, re-checking access at delivery time. */
export async function deliver(id: string): Promise<boolean> {
  const row = st.get.get(id) as Row | undefined;
  if (!row || row.delivered_at || row.read_at) return false;
  if (row.note_id && row.type !== "access_denied") {
    const info = await noteInfo(row.vault_id, row.note_id, { fresh: true });
    if (!userCanView(row.recipient, row.vault_id, info)) return false;
  }
  st.delivered.run(Date.now(), id);
  if (!getSettings(row.recipient)[categoryOf(row.type)].push) return false;
  deliveryHook?.({ id, recipient: row.recipient, type: row.type });
  // IDS ONLY: the notification id; the app fetches the rest with its own credentials.
  if (pushEnabled()) void sendPush(row.recipient, { type: "notification", id }).catch(() => {});
  if (apnsEnabled()) void sendApnsToOwner(row.recipient, notificationAlert(id)).catch(() => {});
  return true;
}

// ── read side ────────────────────────────────────────────────────────────────
const parseAnchor = (s: string | null): Anchor | null => {
  if (!s) return null;
  try {
    const a = JSON.parse(s) as Anchor;
    return a && typeof a === "object" ? a : null;
  } catch {
    return null;
  }
};

/** Project one row for its recipient, or null when it must stay hidden. */
async function view(row: Row): Promise<NotificationView | null> {
  let title: string | null = null;
  if (row.note_id) {
    const info = await noteInfo(row.vault_id, row.note_id);
    const visible = userCanView(row.recipient, row.vault_id, info);
    // A declined request is the only item about a page its reader can't open:
    // it shows, but never with the page's title.
    if (!visible && row.type !== "access_denied") return null;
    title = visible ? info!.title : null;
  }
  return {
    id: row.id,
    type: row.type,
    noteId: row.note_id,
    title,
    actor: row.actor_email ? { name: displayName(row.actor_email) } : null,
    anchor: parseAnchor(row.anchor),
    preview: row.preview,
    requestId: row.request_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    archivedAt: row.archived_at,
  };
}

export async function listNotifications(
  email: string,
  vaultId: string,
  o: { box: "inbox" | "archived"; types: NotificationType[] | null; limit: number; before: { at: number; id: string } | null },
): Promise<{ items: NotificationView[]; next: string | null }> {
  const where = ["recipient = ?", "vault_id = ?", o.box === "archived" ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const args: unknown[] = [email.toLowerCase(), vaultId];
  if (o.types?.length) {
    where.push(`type IN (${o.types.map(() => "?").join(",")})`);
    args.push(...o.types);
  }
  const items: NotificationView[] = [];
  let cursor = o.before;
  let last: Row | null = null;
  let exhausted = false;
  // Rows that are no longer viewable are skipped (never counted, never titled);
  // scan at most 4 pages to fill one.
  for (let page = 0; page < 4 && items.length < o.limit && !exhausted; page++) {
    const pageArgs = [...args];
    let pageWhere = where.join(" AND ");
    if (cursor) {
      pageWhere += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      pageArgs.push(cursor.at, cursor.at, cursor.id);
    }
    const rows = db
      .prepare(`SELECT * FROM notifications WHERE ${pageWhere} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...pageArgs, o.limit) as Row[];
    let consumed = 0;
    for (const r of rows) {
      last = r;
      consumed++;
      const v = await view(r);
      if (v) items.push(v);
      if (items.length >= o.limit) break;
    }
    if (rows.length < o.limit && consumed === rows.length) exhausted = true;
    if (last) cursor = { at: last.created_at, id: last.id };
  }
  const next = !exhausted && last ? `${last.created_at}:${last.id}` : null;
  return { items, next };
}

/** Unread, still-viewable, not archived (capped at 500 rows scanned). */
export async function unreadCount(email: string, vaultId: string): Promise<number> {
  const rows = st.unreadRows.all(email.toLowerCase(), vaultId) as Row[];
  let n = 0;
  for (const r of rows) if (await view(r)) n++;
  return n;
}

export function markRead(email: string, vaultId: string, o: { ids?: string[]; all?: boolean }): void {
  const now = Date.now();
  if (o.all) {
    st.readAll.run(now, email.toLowerCase(), vaultId);
    return;
  }
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) st.readOne.run(now, id, email.toLowerCase(), vaultId);
  });
  tx(o.ids ?? []);
}
export function setArchived(email: string, vaultId: string, ids: string[], archived: boolean): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const id of ids) {
      if (archived) st.archiveOne.run(now, now, id, email.toLowerCase(), vaultId);
      else st.unarchiveOne.run(id, email.toLowerCase(), vaultId);
    }
  });
  tx();
}

// ── mentions on store ────────────────────────────────────────────────────────
const MAX_MENTION_RECIPIENTS = 25;
const MAX_LINKS_PER_STORE = 50;

export interface StoredContent {
  vaultId: string;
  noteId: string;
  prev: string | null;
  next: string;
  /** Who wrote this batch (all of them are authors: none of them is notified). */
  authors: string[];
  /** The note's updatedAt after the write (CAS base for the backlink write). */
  updatedAt: string | null;
}

/**
 * Diff old vs new mention chips; notify the people newly mentioned, link the
 * newly mentioned pages/people (backlinks). Never throws.
 */
export async function noteContentStored(e: StoredContent): Promise<{ notified: number; linked: number }> {
  const out = { notified: 0, linked: 0 };
  try {
    const added = newMentions(e.prev, e.next);
    if (!added.length) return out;
    const authors = new Set(e.authors.map((a) => a.toLowerCase()));
    const info = await noteInfo(e.vaultId, e.noteId, { fresh: true });
    if (!info || info.trashed) return out;
    // A crafted chip can name any id: link/notify only for targets some author may view.
    const authorCanView = async (id: string) => {
      const t = await noteInfo(e.vaultId, id);
      for (const a of authors) if (userCanView(a, e.vaultId, t)) return true;
      return false;
    };
    const actor = authors.size === 1 ? [...authors][0]! : (e.authors[e.authors.length - 1]?.toLowerCase() ?? null);
    const people = [...new Set(added.filter((m) => m.kind === "person" && m.id).map((m) => m.id!))].slice(0, MAX_MENTION_RECIPIENTS);
    const uidFor = new Map(added.filter((m) => m.kind === "person" && m.id).map((m) => [m.id!, m.uid]));
    const notified = new Set<string>();
    for (const pid of people) {
      if (!(await authorCanView(pid))) continue;
      for (const email of await accountsForPerson(e.vaultId, pid)) {
        if (authors.has(email) || notified.has(email)) continue;
        if (!userCanView(email, e.vaultId, info)) continue;
        notified.add(email);
        const uid = uidFor.get(pid) ?? null;
        if (createNotification({
          vaultId: e.vaultId,
          recipient: email,
          type: "mention",
          noteId: e.noteId,
          actorEmail: actor,
          anchor: uid ? { mention: uid } : null,
          dedupe: `mention:${e.noteId}:${uid ?? pid}`,
        })) out.notified++;
      }
    }
    // Backlinks (NP-RF-07): one CAS links-only write for every new page/person target.
    const targets = [...new Set(added.filter((m) => (m.kind === "page" || m.kind === "person") && m.id && m.id !== e.noteId).map((m) => m.id!))].slice(0, MAX_LINKS_PER_STORE);
    const allowed: string[] = [];
    for (const t of targets) if (await authorCanView(t)) allowed.push(t);
    if (allowed.length) out.linked = await addMentionLinks(e.vaultId, e.noteId, allowed, e.updatedAt);
  } catch (err) {
    console.error(`[notify] mention processing failed: ${(err as Error).message}`);
  }
  return out;
}

async function addMentionLinks(vaultId: string, noteId: string, targets: string[], updatedAt: string | null): Promise<number> {
  const v = vaultClient(vaultId, { timeoutMs: 15_000 });
  let base = updatedAt;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!base) base = (await v.getNote(noteId)).updatedAt;
      if (!base) return 0;
      const res = await v.updateNote(noteId, { links: { add: targets.map((target) => ({ target, relationship: "mentions" })) }, ifUpdatedAt: base });
      // A links-only write to a note open in the live editor: tell the reconciler
      // this vault version carries no content change (never fold it over typing).
      if (isDocLive(vaultId, noteId)) markReconciled(docNameFor(vaultId, noteId), Date.parse(base), Date.parse(res.updatedAt ?? ""));
      return targets.length;
    } catch (err) {
      if (err instanceof VaultConflictError && attempt === 0) {
        base = null; // someone wrote in between: re-read once and retry
        continue;
      }
      console.warn(`[notify] mention links for ${noteId} not written: ${(err as Error).message.slice(0, 120)}`);
      return 0;
    }
  }
  return 0;
}

// ── comments on store (collab) ───────────────────────────────────────────────
interface StoredComment {
  id?: unknown;
  actorId?: unknown;
  author?: unknown;
  text?: unknown;
  createdAt?: unknown;
}
type ThreadJson = { id?: unknown; comments?: StoredComment[] };
const commentBaselines = new Map<string, Set<string>>();
const itemKey = (threadId: string, c: StoredComment, i: number) =>
  typeof c.id === "string" && c.id ? `${threadId}:${c.id}` : `${threadId}:${i}:${typeof c.createdAt === "number" ? c.createdAt : 0}`;

function commentsJson(doc: Y.Doc): Record<string, ThreadJson> {
  return doc.share.has("comments") ? (doc.getMap("comments").toJSON() as Record<string, ThreadJson>) : {};
}
function keysOf(json: Record<string, ThreadJson>): Set<string> {
  const s = new Set<string>();
  for (const [tid, t] of Object.entries(json)) (t.comments ?? []).forEach((c, i) => s.add(itemKey(String(t.id ?? tid), c, i)));
  return s;
}

/** Baseline a document's comment items (called when the doc loads). */
export function primeComments(docName: string, doc: Y.Doc): void {
  commentBaselines.set(docName, keysOf(commentsJson(doc)));
}

const cp = {
  list: db.prepare("SELECT email FROM comment_participants WHERE vault_id = ? AND note_id = ? AND thread_id = ? LIMIT 50"),
  add: db.prepare("INSERT OR IGNORE INTO comment_participants (vault_id, note_id, thread_id, email) VALUES (?, ?, ?, ?)"),
};
const stripTokens = (text: string) => text.replace(COMMENT_MENTION, (_m, label: string) => `@${label}`).replace(/\s+/g, " ").trim();

export async function commentsStored(docName: string, vaultId: string, noteId: string, doc: Y.Doc, editors: string[]): Promise<number> {
  const json = commentsJson(doc);
  const now = keysOf(json);
  const before = commentBaselines.get(docName);
  commentBaselines.set(docName, now);
  if (!before) return 0; // first sight of this doc: baseline only, never a backfill burst
  let sent = 0;
  const info = await noteInfo(vaultId, noteId, { fresh: true });
  if (!info || info.trashed) return 0;
  const editorSet = new Set(editors.map((e) => e.toLowerCase()));
  for (const [tid, t] of Object.entries(json)) {
    const threadId = String(t.id ?? tid);
    const items = t.comments ?? [];
    for (let i = 0; i < items.length; i++) {
      const c = items[i]!;
      const key = itemKey(threadId, c, i);
      if (before.has(key)) continue;
      const author = typeof c.actorId === "string" ? emailForActorId(c.actorId) : editorSet.size === 1 ? [...editorSet][0]! : null;
      const authors = new Set([...(author ? [author] : []), ...editorSet]);
      const text = typeof c.text === "string" ? c.text : "";
      const preview = stripTokens(text).slice(0, PREVIEW_MAX) || null;
      const mentioned = new Set<string>();
      for (const m of extractCommentMentions(text).slice(0, 10)) {
        for (const email of await accountsForPerson(vaultId, m.id)) {
          if (authors.has(email) || mentioned.has(email) || !userCanView(email, vaultId, info)) continue;
          mentioned.add(email);
          if (createNotification({ vaultId, recipient: email, type: "comment_mention", noteId, actorEmail: author, anchor: { thread: threadId }, preview, dedupe: `comment:${noteId}:${key}` })) sent++;
        }
      }
      // Earlier participants: server-attributed items (actorId) plus everyone this
      // module has attributed in the thread before (live-editor comments carry no
      // actorId, so their author is remembered when their item is first stored).
      const participants = new Set<string>(
        (cp.list.all(vaultId, noteId, threadId) as Array<{ email: string }>).map((r) => r.email),
      );
      for (let j = 0; j < i; j++) {
        const p = items[j]!;
        const e = typeof p.actorId === "string" ? emailForActorId(p.actorId) : null;
        if (e) participants.add(e);
      }
      if (author) cp.add.run(vaultId, noteId, threadId, author.toLowerCase());
      for (const email of participants) {
        if (authors.has(email) || mentioned.has(email) || !userCanView(email, vaultId, info)) continue;
        if (createNotification({ vaultId, recipient: email, type: "comment_reply", noteId, actorEmail: author, anchor: { thread: threadId }, preview, dedupe: `comment:${noteId}:${key}` })) sent++;
      }
    }
  }
  return sent;
}

// ── collab wiring ────────────────────────────────────────────────────────────
setDocumentStoreListener({
  loaded: (docName, doc) => primeComments(docName, doc),
  stored: (e: DocumentStoredEvent) => {
    void noteContentStored({ vaultId: e.vaultId, noteId: e.noteId, prev: e.prevContent, next: e.content, authors: e.editors, updatedAt: e.updatedAt });
    void commentsStored(e.docName, e.vaultId, e.noteId, e.doc, e.editors).catch((err) =>
      console.error(`[notify] comment processing failed: ${(err as Error).message}`),
    );
  },
});

// ── sharing ──────────────────────────────────────────────────────────────────
/** "X shared a page with you" (acl.ts people sharing). Fire-and-forget. */
export function notifyShare(o: { vaultId: string; noteId: string; recipient: string; actorEmail: string | null }): void {
  void (async () => {
    const info = await noteInfo(o.vaultId, o.noteId, { fresh: true });
    if (!userCanView(o.recipient, o.vaultId, info)) return;
    createNotification({ vaultId: o.vaultId, recipient: o.recipient, type: "share", noteId: o.noteId, actorEmail: o.actorEmail, dedupe: `share:${o.noteId}:${Math.floor(Date.now() / 3_600_000)}` });
  })().catch(() => {});
}

// ── reminders ────────────────────────────────────────────────────────────────
export interface ReminderRow {
  id: string;
  vault_id: string;
  owner_email: string;
  note_id: string;
  at: number;
  tz: string;
  date_only: number;
  uid: string | null;
  status: "scheduled" | "fired" | "cancelled";
  created_at: number;
  fired_at: number | null;
}
const rs = {
  insert: db.prepare(
    "INSERT INTO reminders (id, vault_id, owner_email, note_id, at, tz, date_only, uid, status, created_at) VALUES (@id, @vault_id, @owner_email, @note_id, @at, @tz, @date_only, @uid, 'scheduled', @created_at)",
  ),
  get: db.prepare("SELECT * FROM reminders WHERE id = ?"),
  update: db.prepare("UPDATE reminders SET at = ?, tz = ?, date_only = ?, status = 'scheduled', fired_at = NULL WHERE id = ? AND status != 'cancelled'"),
  cancel: db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'"),
  countLive: db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE owner_email = ? AND status = 'scheduled'"),
  list: db.prepare(
    "SELECT * FROM reminders WHERE owner_email = ? AND vault_id = ? AND (status = 'scheduled' OR (status = 'fired' AND fired_at > ?)) ORDER BY at ASC LIMIT 100",
  ),
  due: db.prepare("SELECT id FROM reminders WHERE status = 'scheduled' AND at <= ? ORDER BY at ASC LIMIT ?"),
  claim: db.prepare("UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'scheduled'"),
  prune: db.prepare("DELETE FROM reminders WHERE status != 'scheduled' AND created_at < ?"),
};
export const MAX_LIVE_REMINDERS = 500;
export const getReminder = (id: string): ReminderRow | null => (rs.get.get(id) as ReminderRow | undefined) ?? null;
export const countLiveReminders = (email: string): number => (rs.countLive.get(email.toLowerCase()) as { n: number }).n;
export function insertReminder(r: Omit<ReminderRow, "status" | "created_at" | "fired_at">): ReminderRow {
  rs.insert.run({ ...r, created_at: Date.now() });
  return getReminder(r.id)!;
}
export const updateReminder = (id: string, at: number, tz: string, dateOnly: boolean): boolean => rs.update.run(at, tz, dateOnly ? 1 : 0, id).changes > 0;
export const cancelReminder = (id: string): boolean => rs.cancel.run(id).changes > 0;
export const listReminderRows = (email: string, vaultId: string): ReminderRow[] =>
  rs.list.all(email.toLowerCase(), vaultId, Date.now() - 86_400_000) as ReminderRow[];

/** Is `tz` an IANA zone this runtime knows? */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
function tzOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - (ts - (ts % 1000));
}
/** Wall-clock time in `tz` → epoch ms (DST-correct for all but the skipped hour). */
export function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}
export const DATE_ONLY_HOUR = 9;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Parse a reminder time: a date (fires at 09:00 in `tz`) or an instant with an offset. */
export function parseReminderAt(at: unknown, tz: string, dateOnly: boolean): number | null {
  if (typeof at !== "string" || at.length > 40) return null;
  if (dateOnly) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return zonedTimeToUtc(y, mo, d, DATE_ONLY_HOUR, 0, tz);
  }
  if (!ISO_INSTANT.test(at)) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

export const REMINDER_BATCH = 50;
/** Fire due reminders: claim (idempotent), re-check access, notify. */
export async function runRemindersOnce(now = Date.now()): Promise<number> {
  const due = rs.due.all(now, REMINDER_BATCH) as Array<{ id: string }>;
  let fired = 0;
  for (const { id } of due) {
    if (rs.claim.run(Date.now(), id).changes !== 1) continue; // another tick took it
    const r = getReminder(id);
    if (!r) continue;
    const info = await noteInfo(r.vault_id, r.note_id, { fresh: true });
    if (!userCanView(r.owner_email, r.vault_id, info)) continue; // lost access: drop silently
    if (createNotification({ vaultId: r.vault_id, recipient: r.owner_email, type: "reminder", noteId: r.note_id, actorEmail: null, anchor: r.uid ? { reminder: r.id, mention: r.uid } : { reminder: r.id }, dedupe: `reminder:${r.id}:${r.at}` })) fired++;
  }
  return fired;
}

// ── access requests ──────────────────────────────────────────────────────────
export type RequestLevel = "view" | "comment" | "suggest" | "edit";
export const REQUEST_LEVELS: readonly RequestLevel[] = ["view", "comment", "suggest", "edit"];
export interface AccessRequestRow {
  id: string;
  vault_id: string;
  note_id: string;
  requester: string;
  level: RequestLevel;
  message: string | null;
  status: "pending" | "approved" | "denied";
  created_at: number;
  notified_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
}
const ar = {
  pendingFor: db.prepare("SELECT * FROM access_requests WHERE vault_id = ? AND note_id = ? AND requester = ? AND status = 'pending'"),
  insert: db.prepare(
    "INSERT INTO access_requests (id, vault_id, note_id, requester, level, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
  ),
  refresh: db.prepare("UPDATE access_requests SET level = ?, message = ? WHERE id = ?"),
  notified: db.prepare("UPDATE access_requests SET notified_at = ? WHERE id = ?"),
  get: db.prepare("SELECT * FROM access_requests WHERE id = ?"),
  pendingInVault: db.prepare("SELECT * FROM access_requests WHERE vault_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 500"),
  decide: db.prepare("UPDATE access_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'"),
};
export const getAccessRequest = (id: string): AccessRequestRow | null => (ar.get.get(id) as AccessRequestRow | undefined) ?? null;
export const pendingAccessRequests = (vaultId: string): AccessRequestRow[] => ar.pendingInVault.all(vaultId) as AccessRequestRow[];

/** Who may decide a request on this note: workspace owners/admins + holders of `share`. */
export function canDecide(email: string, vaultId: string, info: NoteInfo | null): boolean {
  if (!info || info.trashed) return false;
  const caps = userCaps(email, vaultId, info.ref);
  return caps === "admin" || (caps.has("view") && caps.has("share"));
}
function decidersFor(vaultId: string, info: NoteInfo): string[] {
  const out = new Set<string>();
  if (config.ownerEmail) out.add(config.ownerEmail);
  for (const m of listMemberships(vaultId)) if (m.role === "owner" || m.role === "admin") out.add(m.email.toLowerCase());
  if (info.ref.creator && info.ref.creator.includes("@")) out.add(info.ref.creator.toLowerCase());
  return [...out].filter((e) => canDecide(e, vaultId, info)).slice(0, 20);
}

/**
 * Record a request (the route already answered 202 — nothing here may change the
 * response). Silently drops a request for a missing/trashed note, or for access
 * the requester already holds.
 */
export async function recordAccessRequest(o: { vaultId: string; noteId: string; requester: string; level: RequestLevel; message: string | null }): Promise<string | null> {
  const requester = o.requester.toLowerCase();
  const info = await noteInfo(o.vaultId, o.noteId, { fresh: true });
  if (!info || info.trashed) return null;
  const caps = userCaps(requester, o.vaultId, info.ref);
  if (caps === "admin") return null;
  const want = expandLevel(o.level as Level);
  if ([...want].every((c) => caps.has(c))) return null;
  const existing = ar.pendingFor.get(o.vaultId, o.noteId, requester) as AccessRequestRow | undefined;
  let id: string;
  if (existing) {
    id = existing.id;
    ar.refresh.run(o.level, o.message, id);
    if (existing.notified_at && Date.now() - existing.notified_at < 86_400_000) return id; // no re-ping within a day
  } else {
    id = randomUUID();
    ar.insert.run(id, o.vaultId, o.noteId, requester, o.level, o.message, Date.now());
  }
  ar.notified.run(Date.now(), id);
  for (const d of decidersFor(o.vaultId, info)) {
    createNotification({ vaultId: o.vaultId, recipient: d, type: "access_request", noteId: o.noteId, actorEmail: requester, requestId: id, preview: o.message, dedupe: `access_request:${id}:${Math.floor(Date.now() / 86_400_000)}` });
  }
  return id;
}

export type DecideResult = { ok: true; status: "approved" | "denied" } | { ok: false; status: 404 | 409 | 403 | 400; error: string };
export async function decideAccessRequest(o: { id: string; vaultId: string; decider: string; decision: "approve" | "deny"; level?: RequestLevel }): Promise<DecideResult> {
  const r = getAccessRequest(o.id);
  if (!r || r.vault_id !== o.vaultId) return { ok: false, status: 404, error: "not_found" };
  const info = await noteInfo(r.vault_id, r.note_id, { fresh: true });
  const decider = o.decider.toLowerCase();
  if (!canDecide(decider, r.vault_id, info)) return { ok: false, status: 404, error: "not_found" };
  if (r.status !== "pending") return { ok: false, status: 409, error: "already_decided" };
  if (o.decision === "approve") {
    const level = o.level ?? r.level;
    if (!(REQUEST_LEVELS as readonly string[]).includes(level)) return { ok: false, status: 400, error: "bad_request" };
    const caps = userCaps(decider, r.vault_id, info!.ref);
    // Never hand out more than you hold (acl.ts denyEscalation, same rule).
    if (caps !== "admin" && ![...expandLevel(level as Level)].every((c) => caps.has(c))) return { ok: false, status: 403, error: "escalation" };
    if (ar.decide.run("approved", Date.now(), decider, r.id).changes !== 1) return { ok: false, status: 409, error: "already_decided" };
    upsertGrant({ vault_id: r.vault_id, subject_type: "user", subject: r.requester, resource_type: "note", resource: r.note_id, level: level as Level, created_by: decider });
    forgetNoteInfo(r.vault_id, r.note_id);
    st.readForRequest.run(Date.now(), r.id);
    createNotification({ vaultId: r.vault_id, recipient: r.requester, type: "access_granted", noteId: r.note_id, actorEmail: decider, requestId: r.id, dedupe: `access_granted:${r.id}` });
    return { ok: true, status: "approved" };
  }
  if (ar.decide.run("denied", Date.now(), decider, r.id).changes !== 1) return { ok: false, status: 409, error: "already_decided" };
  st.readForRequest.run(Date.now(), r.id);
  createNotification({ vaultId: r.vault_id, recipient: r.requester, type: "access_denied", noteId: r.note_id, actorEmail: decider, requestId: r.id, dedupe: `access_denied:${r.id}` });
  return { ok: true, status: "denied" };
}

// ── email digest for inactive users ──────────────────────────────────────────
const EMAIL_AFTER_MS = Number(process.env.NOTIFY_EMAIL_AFTER_MS ?? 30 * 60_000);
const EMAIL_MIN_INTERVAL_MS = Number(process.env.NOTIFY_EMAIL_MIN_INTERVAL_MS ?? 6 * 3_600_000);
type EmailSender = (to: string, count: number) => Promise<void>;
let emailSender: EmailSender | null = null;
export function setDigestSender(s: EmailSender | null): void {
  emailSender = s;
}
const defaultDigest: EmailSender = async (to, count) => {
  const link = `${config.appOrigin}/inbox`;
  const noun = count === 1 ? "notification" : "notifications";
  // Content-free on purpose: no titles, names or text leave the server by email.
  await sendEmail(to, `You have ${count} unread ${noun} in Prism`, `<p>You have ${count} unread ${noun} in Prism.</p><p><a href="${link}">Open your inbox</a></p>`, `digest ${count}`);
};

/** One digest per user per interval for notifications still unread after a delay. */
export async function runEmailDigestOnce(now = Date.now()): Promise<number> {
  if (!emailSender && !emailEnabled()) return 0;
  const rows = db
    .prepare("SELECT * FROM notifications WHERE read_at IS NULL AND archived_at IS NULL AND emailed_at IS NULL AND created_at <= ? ORDER BY created_at ASC LIMIT 1000")
    .all(now - EMAIL_AFTER_MS) as Row[];
  const byUser = new Map<string, Row[]>();
  for (const r of rows) {
    if (!getSettings(r.recipient)[categoryOf(r.type)].email) continue;
    byUser.set(r.recipient, [...(byUser.get(r.recipient) ?? []), r]);
  }
  let sent = 0;
  const mark = db.prepare("UPDATE notifications SET emailed_at = ? WHERE id = ?");
  const log = db.prepare("INSERT INTO notification_email_log (email, last_at) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET last_at = excluded.last_at");
  for (const [email, list] of byUser) {
    const last = (db.prepare("SELECT last_at FROM notification_email_log WHERE email = ?").get(email) as { last_at: number } | undefined)?.last_at ?? 0;
    if (now - last < EMAIL_MIN_INTERVAL_MS) continue;
    const visible: Row[] = [];
    for (const r of list) if (await view(r)) visible.push(r);
    for (const r of list) mark.run(now, r.id); // hidden rows are never emailed later either
    if (!visible.length) continue;
    try {
      await (emailSender ?? defaultDigest)(email, visible.length);
      log.run(email, now);
      sent++;
    } catch (e) {
      console.error(`[notify] digest failed: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return sent;
}

// ── worker ───────────────────────────────────────────────────────────────────
const TICK_MS = Number(process.env.NOTIFY_TICK_MS ?? 30_000);
const RETENTION_MS = Number(process.env.NOTIFY_RETENTION_DAYS ?? 90) * 86_400_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastDigest = 0;
export async function notificationTick(now = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runRemindersOnce(now);
    if (now - lastDigest >= 5 * 60_000) {
      lastDigest = now;
      await runEmailDigestOnce(now);
      st.pruneOld.run(now - RETENTION_MS);
      rs.prune.run(now - RETENTION_MS);
    }
  } catch (e) {
    console.error(`[notify] tick failed: ${(e as Error).message}`);
  } finally {
    running = false;
  }
}
export function startNotificationWorker(): () => void {
  if (timer || TICK_MS <= 0) return () => {};
  timer = setInterval(() => void notificationTick(), TICK_MS);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
