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
import { db, getUser, listMemberships, listUsers, grantsForUser, grantsForResource, resolveVaultEntry, hasAccount, upsertGrant } from "./db";
import { config, emailEnabled } from "./config";
import { effectiveCaps, expandLevel, levelRank, type Cap, type NoteRef, type Level } from "./permissions";
import { workspaceRole, roleAtLeast, roleFloor } from "./roles";
import { ensureTree, rowRef, subscribeTreeChanges } from "./tree";
import { vaultClient, VaultConflictError, type Note } from "./parachute";
import { extractMentions, mentionKey, extractCommentMentions, COMMENT_MENTION, type ParsedMention } from "@prism/core/mentions";
import { pageTitle, TRASH_TAG } from "@prism/core/pages";
import { personSummary } from "./people-directory";
import { sendPush, pushEnabled } from "./push";
import { apnsEnabled, sendApnsToOwner, notificationAlert } from "./apns";
import { sendEmail } from "./auth/email";
import { documentActorId } from "./human-collab";
import { writerIdFor } from "./writer-stamp";
import { personNotesForEmail } from "./my-tasks";
import { onAccessChanged } from "./access-events";
import { docNameFor, federationTarget, suggestionViewOfHtml, isDocLive, markReconciled, setDocumentStoreListener, type DocumentStoredEvent } from "./collab";

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
  watchedVaults.clear();
  refCache.clear();
  budgets.clear();
  unreadCache.clear();
  chipCache.clear();
  actorIdCache = null;
  accountIdCache = null;
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
  | "suggestion_rejected"
  | "suggestion_resolved";
const TYPES: readonly NotificationType[] = ["mention", "comment_reply", "comment_mention", "reminder", "share", "access_request", "access_granted", "access_denied", "suggestion_accepted", "suggestion_rejected", "suggestion_resolved"];
export const isNotificationType = (t: unknown): t is NotificationType => typeof t === "string" && (TYPES as readonly string[]).includes(t);
/** Filter groups the inbox offers (also accepts an exact type). */
export const TYPE_GROUPS: Record<string, NotificationType[]> = {
  mention: ["mention", "comment_mention"],
  comment: ["comment_reply", "comment_mention", "suggestion_accepted", "suggestion_rejected", "suggestion_resolved"],
  reminder: ["reminder"],
  access: ["access_request", "access_granted", "access_denied", "share"],
};

export type Category = "mention" | "comment" | "reminder" | "access";
const categoryOf = (t: NotificationType): Category =>
  t === "mention" || t === "comment_mention" ? "mention" : t === "comment_reply" || t === "suggestion_accepted" || t === "suggestion_rejected" || t === "suggestion_resolved" ? "comment" : t === "reminder" ? "reminder" : "access";

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
  del: db.prepare("DELETE FROM notifications WHERE id = ?"),
  anyUnread: db.prepare("SELECT 1 FROM notifications WHERE recipient = ? AND vault_id = ? AND read_at IS NULL AND archived_at IS NULL LIMIT 1"),
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
  let treeSaysMissing = false;
  try {
    const tree = await ensureTree(entry);
    watchTree(entry);
    const row = tree.state.rows.get(noteId);
    // Read-time lookups trust a loaded projection's "not there" (deleted notes must
    // not cost a vault call per inbox row); producers (`fresh`) still ask the vault.
    treeSaysMissing = !row && tree.state.loaded && !opts.fresh;
    // The projection is live (vault subscribe socket + gateway write-through), so
    // `fresh` only bypasses the short TTL cache, never the tree.
    if (row) {
      info = { ref: rowRef(row), title: pageTitle(row.path), trashed: row.tags.includes(TRASH_TAG) || !!row.trashedAt };
    }
  } catch {
    /* tree unavailable: fall back to the vault */
  }
  if (!info && !treeSaysMissing) {
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
export const clearNoteInfoCache = (): void => {
  refCache.clear();
  unreadCache.clear();
};
/** Access-relevant tree changes (tags, creator, visibility, trash, removal) drop the
 *  cached note facts and unread counts, so a revocation shows up at once. */
const watchedVaults = new Set<string>();
function watchTree(entry: Parameters<typeof subscribeTreeChanges>[0]): void {
  if (watchedVaults.has(entry.id)) return;
  watchedVaults.add(entry.id);
  void subscribeTreeChanges(entry, (ch) => {
    if (ch.kind === "resync") {
      refCache.clear();
      unreadCache.clear();
      return;
    }
    const id = ch.kind === "upsert" ? ch.row.id : ch.id;
    const prev = ch.prev;
    const next = ch.kind === "upsert" ? ch.row : undefined;
    const relevant = !prev || !next || prev.creator !== next.creator || prev.visibility !== next.visibility ||
      prev.tags.join("\0") !== next.tags.join("\0") || prev.trashedAt !== next.trashedAt;
    if (!relevant) return;
    refCache.delete(`${entry.id}\0${id}`);
    unreadCache.clear();
  }).catch(() => watchedVaults.delete(entry.id));
}

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
  const known = actorIdCache.map.get(actorId);
  if (known) return known;
  // Legacy form: MCP agent suggestions written before wave 3 stored the account
  // email itself. Believed only when it names a real account.
  if (actorId.includes("@")) {
    const email = actorId.trim().toLowerCase();
    for (const e of actorIdCache.map.values()) if (e.toLowerCase() === email) return e;
  }
  return null;
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

// ── mentioning a member by ACCOUNT (wave 3) ──────────────────────────────────
// A workspace member with no person note is mentioned by their account. The chip
// stores the opaque subject id `u_<16 hex>` (writer-stamp.ts: HMAC of the email)
// in the mention's existing `id` attribute and their display name in `label` —
// never an email, and no editor schema change.
export const ACCOUNT_MENTION_ID = /^u_[0-9a-f]{16}$/;
let accountIdCache: { n: number; map: Map<string, string> } | null = null;
/** The account behind an account-mention id, or null. */
export function emailForAccountMention(id: string): string | null {
  if (!ACCOUNT_MENTION_ID.test(id)) return null;
  const users = listUsers();
  if (!accountIdCache || accountIdCache.n !== users.length) {
    const map = new Map<string, string>();
    for (const u of users) map.set(writerIdFor(u.email), u.email.toLowerCase());
    if (config.ownerEmail) map.set(writerIdFor(config.ownerEmail), config.ownerEmail.toLowerCase());
    accountIdCache = { n: users.length, map };
  }
  return accountIdCache.map.get(id) ?? null;
}
/** May this account mention members by account? Workspace members only (never a guest). */
export const canMentionMembers = (email: string, vaultId: string): boolean => roleAtLeast(workspaceRole(email, vaultId), "member");

/**
 * Members the caller may mention by account: workspace members (role ≥ member) of
 * this vault who have a display name and are NOT already reachable through a
 * person page the caller can view (those are offered as people). Returns the
 * opaque id + display name only — never an email. Empty for a guest.
 */
export async function mentionableMembers(caller: string, vaultId: string, q: string, limit = 8): Promise<Array<{ id: string; name: string }>> {
  const me = caller.toLowerCase();
  if (!canMentionMembers(me, vaultId)) return [];
  const needle = q.trim().toLowerCase();
  const entry = resolveVaultEntry(vaultId);
  const candidates = new Map<string, string>();
  for (const u of listUsers()) candidates.set(u.email.toLowerCase(), (u.name ?? "").trim());
  if (config.ownerEmail && !candidates.has(config.ownerEmail.toLowerCase())) candidates.set(config.ownerEmail.toLowerCase(), (getUser(config.ownerEmail)?.name ?? "").trim());
  const out: Array<{ id: string; name: string }> = [];
  for (const [email, name] of candidates) {
    if (out.length >= limit) break;
    if (email === me || !name || name.toLowerCase() === email || name.includes("@")) continue;
    if (needle && !name.toLowerCase().includes(needle)) continue;
    if (!canMentionMembers(email, vaultId)) continue;
    let viaPerson = false;
    try {
      for (const pid of await personNotesForEmail(entry, email)) {
        if (userCanView(me, vaultId, await noteInfo(vaultId, pid))) { viaPerson = true; break; }
      }
    } catch { /* people listing unavailable: offer the account */ }
    if (!viaPerson) out.push({ id: writerIdFor(email), name });
  }
  return out;
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

// Budgets (review M1). Spent only AFTER a row was actually inserted (a dedupe hit
// is free). Mentions/comments from one sender are capped per recipient and per
// (sender, page, recipient) — an over-budget item is not kept. Everything else
// (reminders, shares, access outcomes) always gets its row; the recipient-wide
// hourly budget only ever skips the PUSH, never the inbox item.
const PER_SENDER_HOUR = Number(process.env.NOTIFY_PER_SENDER_HOUR ?? 20);
const PER_SENDER_NOTE_HOUR = Number(process.env.NOTIFY_PER_SENDER_NOTE_HOUR ?? 8);
const SPAMMABLE: ReadonlySet<NotificationType> = new Set(["mention", "comment_reply", "comment_mention", "suggestion_accepted", "suggestion_rejected", "suggestion_resolved"]);
const budgets = new Map<string, { n: number; reset: number }>();
function budgetLeft(key: string, max: number): boolean {
  const b = budgets.get(key);
  return !b || b.reset < Date.now() || b.n < max;
}
function spend(key: string): void {
  const now = Date.now();
  const b = budgets.get(key);
  if (!b || b.reset < now) budgets.set(key, { n: 1, reset: now + 3_600_000 });
  else b.n++;
  if (budgets.size > 20_000) for (const [k, v] of budgets) if (v.reset < now) budgets.delete(k);
}

/** Insert (idempotent by dedupe key) and fan out. Returns the new id, or null. */
export function createNotification(n: NewNotification): string | null {
  const recipient = n.recipient.toLowerCase();
  const actor = n.actorEmail?.toLowerCase() ?? null;
  if (actor && recipient === actor) return null; // never the author
  const id = randomUUID();
  const r = st.insert.run({
    id,
    vault_id: n.vaultId,
    recipient,
    type: n.type,
    note_id: n.noteId,
    actor_email: actor,
    anchor: n.anchor ? JSON.stringify(n.anchor) : null,
    preview: n.preview ? n.preview.slice(0, PREVIEW_MAX) : null,
    request_id: n.requestId ?? null,
    dedupe_key: n.dedupe.slice(0, 400),
    created_at: Date.now(),
  });
  if (r.changes !== 1) return null; // duplicate: no budget spent
  if (actor && SPAMMABLE.has(n.type)) {
    const k1 = `s:${actor}:${recipient}`;
    const k2 = `n:${actor}:${n.noteId ?? ""}:${recipient}`;
    if (!budgetLeft(k1, PER_SENDER_HOUR) || !budgetLeft(k2, PER_SENDER_NOTE_HOUR)) {
      st.del.run(id);
      return null;
    }
    spend(k1);
    spend(k2);
  }
  const rk = `r:${recipient}`;
  const push = budgetLeft(rk, MAX_PER_RECIPIENT_HOUR);
  spend(rk);
  forgetUnread(recipient);
  void deliver(id, { push }).catch((e) => console.error(`[notify] deliver failed: ${(e as Error).message}`));
  return id;
}

/** Push / APNs for one notification, re-checking access at delivery time. */
export async function deliver(id: string, opts: { push?: boolean } = {}): Promise<boolean> {
  const row = st.get.get(id) as Row | undefined;
  if (!row || row.delivered_at || row.read_at) return false;
  if (row.note_id && row.type !== "access_denied") {
    const info = await noteInfo(row.vault_id, row.note_id, { fresh: true });
    if (!userCanView(row.recipient, row.vault_id, info)) return false;
  }
  st.delivered.run(Date.now(), id);
  if (opts.push === false) return false; // over the recipient's hourly push budget: inbox only
  if (!getSettings(row.recipient)[categoryOf(row.type)].push) return false;
  deliveryHook?.({ id, recipient: row.recipient, type: row.type });
  // IDS ONLY: the notification id; the app fetches the rest with its own credentials.
  if (pushEnabled()) void sendPush(row.recipient, { type: "notification", id }).catch(() => {});
  if (apnsEnabled()) void sendApnsToOwner(row.recipient, notificationAlert(id)).catch(() => {});
  return true;
}

// Unread counts (review L5): a short per-(user, vault) cache, dropped on every
// change to that user's rows and on any permission change.
const unreadCache = new Map<string, { at: number; n: number }>();
const UNREAD_TTL_MS = 30_000;
function forgetUnread(email: string): void {
  for (const k of unreadCache.keys()) if (k.startsWith(`${email}\0`)) unreadCache.delete(k);
}
onAccessChanged(() => unreadCache.clear());

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

/** Unread, still-viewable, not archived (cached briefly; capped at 500 rows scanned). */
export async function unreadCount(email: string, vaultId: string): Promise<number> {
  const e = email.toLowerCase();
  const key = `${e}\0${vaultId}`;
  const hit = unreadCache.get(key);
  if (hit && Date.now() - hit.at < UNREAD_TTL_MS) return hit.n;
  let n = 0;
  if (st.anyUnread.get(e, vaultId)) {
    const rows = st.unreadRows.all(e, vaultId) as Row[];
    for (const r of rows) if (await view(r)) n++;
  }
  unreadCache.set(key, { at: Date.now(), n });
  if (unreadCache.size > 5000) unreadCache.clear();
  return n;
}

export function markRead(email: string, vaultId: string, o: { ids?: string[]; all?: boolean }): void {
  forgetUnread(email.toLowerCase());
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
  forgetUnread(email.toLowerCase());
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
  /** The previous body (or null when only `prevMentions` is known). */
  prev: string | null;
  /** The previous chip set, when known without the body (the chip cache). */
  prevMentions?: ParsedMention[] | null;
  next: string;
  /** Who wrote this batch. One author → they're never notified and get the credit;
   *  several (a live-editor batch) → credited to "a collaborator", nobody excluded. */
  authors: string[];
  /** The note's updatedAt after the write (CAS base for the backlink write). */
  updatedAt: string | null;
}

// Last-seen chip set per note (review M4): lets a REST autosave skip the
// pre-read when the body carries no chip this server hasn't already seen.
const CHIP_TTL_MS = 10 * 60_000;
const chipCache = new Map<string, { at: number; chips: ParsedMention[] }>();
export function cachedChips(vaultId: string, noteId: string): ParsedMention[] | null {
  const k = `${vaultId}\0${noteId}`;
  const hit = chipCache.get(k);
  if (!hit || Date.now() - hit.at > CHIP_TTL_MS) return null;
  return hit.chips;
}
function rememberChips(vaultId: string, noteId: string, chips: ParsedMention[]): void {
  const k = `${vaultId}\0${noteId}`;
  chipCache.delete(k);
  chipCache.set(k, { at: Date.now(), chips });
  if (chipCache.size > 2000) chipCache.delete(chipCache.keys().next().value!);
}

// An account mention (`u_…`) names no note: it is never a link target.
const linkTargets = (ms: ParsedMention[], self: string) =>
  new Set(ms.filter((m) => (m.kind === "page" || m.kind === "person") && m.id && m.id !== self && !ACCOUNT_MENTION_ID.test(m.id)).map((m) => m.id!));

/**
 * Diff old vs new mention chips; notify the people newly mentioned, link the
 * newly mentioned pages/people and unlink targets whose last chip is gone
 * (backlinks). Never throws.
 */
export async function noteContentStored(e: StoredContent): Promise<{ notified: number; linked: number; unlinked: number }> {
  const out = { notified: 0, linked: 0, unlinked: 0 };
  try {
    const before = e.prevMentions ?? extractMentions(e.prev);
    const after = extractMentions(e.next);
    rememberChips(e.vaultId, e.noteId, after);
    const seen = new Set(before.map(mentionKey));
    const added = after.filter((m) => !seen.has(mentionKey(m)));
    const removedTargets = [...linkTargets(before, e.noteId)].filter((t) => !linkTargets(after, e.noteId).has(t));
    if (!added.length && !removedTargets.length) return out;
    const authors = new Set(e.authors.map((a) => a.toLowerCase()));
    const info = await noteInfo(e.vaultId, e.noteId, { fresh: true });
    if (!info || info.trashed) return out;
    // A TEMPLATE's chips are part of a blueprint: nobody was mentioned, and nothing
    // links from it. (A page made from the template gets fresh chip uids and notifies.)
    if (info.ref.tags.includes("template")) return out;
    // A crafted chip can name any id: link/notify only for targets some author may view.
    const authorCanView = async (id: string) => {
      const t = await noteInfo(e.vaultId, id);
      for (const a of authors) if (userCanView(a, e.vaultId, t)) return true;
      return false;
    };
    // L4: per-update attribution isn't available in a multi-editor batch, so the
    // credit goes to "a collaborator" and nobody in it is excluded (a mentioned
    // co-editor did not necessarily write the chip).
    const single = authors.size === 1 ? [...authors][0]! : null;
    const people = [...new Set(added.filter((m) => m.kind === "person" && m.id).map((m) => m.id!))].slice(0, MAX_MENTION_RECIPIENTS);
    const uidFor = new Map(added.filter((m) => m.kind === "person" && m.id).map((m) => [m.id!, m.uid]));
    const notified = new Set<string>();
    for (const pid of people) {
      // A member mentioned by account: EVERY author of the batch must be a workspace
      // member (per-chip attribution isn't available, so a guest co-editing with a
      // member cannot piggyback — review low 5); the recipient must be one too.
      const account = emailForAccountMention(pid);
      const recipients = ACCOUNT_MENTION_ID.test(pid)
        ? account && canMentionMembers(account, e.vaultId) && authors.size > 0 && [...authors].every((a) => canMentionMembers(a, e.vaultId)) ? [account] : []
        : (await authorCanView(pid)) ? await accountsForPerson(e.vaultId, pid) : [];
      for (const email of recipients) {
        if (email === single || notified.has(email)) continue;
        if (!userCanView(email, e.vaultId, info)) continue;
        notified.add(email);
        const uid = uidFor.get(pid) ?? null;
        if (createNotification({
          vaultId: e.vaultId,
          recipient: email,
          type: "mention",
          noteId: e.noteId,
          actorEmail: single,
          anchor: uid ? { mention: uid } : null,
          dedupe: `mention:${e.noteId}:${uid ?? pid}`,
        })) out.notified++;
      }
    }
    const allowed: string[] = [];
    for (const t of [...linkTargets(added, e.noteId)].slice(0, MAX_LINKS_PER_STORE)) if (await authorCanView(t)) allowed.push(t);
    const remove = removedTargets.slice(0, MAX_LINKS_PER_STORE);
    if (allowed.length || remove.length) {
      const ok = await writeMentionLinks(e.vaultId, e.noteId, allowed, remove, e.updatedAt);
      if (ok) {
        out.linked = allowed.length;
        out.unlinked = remove.length;
      }
    }
  } catch (err) {
    console.error(`[notify] mention processing failed: ${(err as Error).message}`);
  }
  return out;
}

async function writeMentionLinks(vaultId: string, noteId: string, add: string[], remove: string[], updatedAt: string | null): Promise<boolean> {
  const v = vaultClient(vaultId, { timeoutMs: 15_000 });
  let base = updatedAt;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!base) base = (await v.getNote(noteId)).updatedAt;
      if (!base) return false;
      const links: { add?: Array<{ target: string; relationship: string }>; remove?: Array<{ target: string; relationship: string }> } = {};
      if (add.length) links.add = add.map((target) => ({ target, relationship: "mentions" }));
      if (remove.length) links.remove = remove.map((target) => ({ target, relationship: "mentions" }));
      const res = await v.updateNote(noteId, { links, ifUpdatedAt: base });
      // A links-only write to a note open in the live editor: tell the reconciler
      // this vault version carries no content change (never fold it over typing).
      if (isDocLive(vaultId, noteId)) markReconciled(docNameFor(vaultId, noteId), Date.parse(base), Date.parse(res.updatedAt ?? ""));
      return true;
    } catch (err) {
      if (err instanceof VaultConflictError && attempt === 0) {
        base = null; // someone wrote in between: re-read once and retry
        continue;
      }
      console.warn(`[notify] mention links for ${noteId} not written: ${(err as Error).message.slice(0, 120)}`);
      return false;
    }
  }
  return false;
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

const cp = {
  list: db.prepare("SELECT email FROM comment_participants WHERE vault_id = ? AND note_id = ? AND thread_id = ? LIMIT 50"),
  has: db.prepare("SELECT 1 FROM comment_participants WHERE vault_id = ? AND note_id = ? AND thread_id = ? LIMIT 1"),
  add: db.prepare("INSERT OR IGNORE INTO comment_participants (vault_id, note_id, thread_id, email) VALUES (?, ?, ?, ?)"),
};

/**
 * Baseline a document's comment items (called when the doc loads). A thread this
 * server has never attributed (written before wave 2A) seeds its participants
 * from the items' `actorId` once — afterwards participants come only from
 * attribution at store time (review M3: `actorId` in the comments map is
 * writable by any edit-level socket).
 */
export function primeComments(docName: string, doc: Y.Doc, target?: { vaultId: string; noteId: string }): void {
  const json = commentsJson(doc);
  commentBaselines.set(docName, keysOf(json));
  if (!target) return;
  for (const [tid, t] of Object.entries(json)) {
    const threadId = String(t.id ?? tid);
    if (cp.has.get(target.vaultId, target.noteId, threadId)) continue;
    for (const c of (t.comments ?? []).slice(0, 50)) {
      const e = typeof c.actorId === "string" ? emailForActorId(c.actorId) : null;
      if (e) cp.add.run(target.vaultId, target.noteId, threadId, e);
    }
  }
}
/** Forget a document's in-memory state when it unloads (review L6). */
export function forgetComments(docName: string): void {
  commentBaselines.delete(docName);
}

const stripTokens = (text: string) => text.replace(COMMENT_MENTION, (_m, label: string) => `@${label}`).replace(/\s+/g, " ").trim();

export async function commentsStored(docName: string, vaultId: string, noteId: string, doc: Y.Doc, editors: string[]): Promise<number> {
  const json = commentsJson(doc);
  const now = keysOf(json);
  const before = commentBaselines.get(docName);
  commentBaselines.set(docName, now);
  if (!before) {
    // First sight of this doc: baseline only, never a backfill burst.
    primeComments(docName, doc, { vaultId, noteId });
    return 0;
  }
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
      // M3: an item's actorId is believed only when that account really wrote in
      // this batch (server commands and MCP report themselves as editors);
      // otherwise the batch's single editor is the author, or nobody is credited.
      const claimed = typeof c.actorId === "string" ? emailForActorId(c.actorId) : null;
      const author = claimed && editorSet.has(claimed) ? claimed : editorSet.size === 1 ? [...editorSet][0]! : null;
      const authors = author ? new Set([author]) : editorSet;
      const text = typeof c.text === "string" ? c.text : "";
      const preview = stripTokens(text).slice(0, PREVIEW_MAX) || null;
      const mentioned = new Set<string>();
      for (const m of extractCommentMentions(text).slice(0, 10)) {
        // L3: the same rule as document chips — only people some author can see
        // (a member mentioned by account: an author who is a workspace member).
        let targets: string[];
        if (ACCOUNT_MENTION_ID.test(m.id)) {
          const account = emailForAccountMention(m.id);
          targets = account && canMentionMembers(account, vaultId) && authors.size > 0 && [...authors].every((a) => canMentionMembers(a, vaultId)) ? [account] : [];
        } else {
          const person = await noteInfo(vaultId, m.id);
          if (![...authors].some((a) => userCanView(a, vaultId, person))) continue;
          targets = await accountsForPerson(vaultId, m.id);
        }
        for (const email of targets) {
          if (authors.has(email) || mentioned.has(email) || !userCanView(email, vaultId, info)) continue;
          mentioned.add(email);
          if (createNotification({ vaultId, recipient: email, type: "comment_mention", noteId, actorEmail: author, anchor: { thread: threadId }, preview, dedupe: `comment:${noteId}:${key}` })) sent++;
        }
      }
      const participants = new Set<string>((cp.list.all(vaultId, noteId, threadId) as Array<{ email: string }>).map((r) => r.email));
      for (const email of participants) {
        if (authors.has(email) || mentioned.has(email) || !userCanView(email, vaultId, info)) continue;
        if (createNotification({ vaultId, recipient: email, type: "comment_reply", noteId, actorEmail: author, anchor: { thread: threadId }, preview, dedupe: `comment:${noteId}:${key}` })) sent++;
      }
      if (author) cp.add.run(vaultId, noteId, threadId, author);
    }
  }
  return sent;
}

// ── suggestions resolved (wave 3) ────────────────────────────────────────────
const SUGGESTION_NOTICES_PER_STORE = 20;
const SUGGESTION_MIN_CHARS = 4;
const occurrences = (hay: string, needle: string): number => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < 3; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};
/**
 * Was a resolved suggestion accepted or declined? Read from the DECODED text of
 * the parsed documents (review M2 — entity-encoded HTML never matches mark text),
 * and only when the evidence is unambiguous: the text is at least 4 characters,
 * occurs exactly once in the previous document (the suggestion itself), and — for
 * a replacement — both halves agree. Anything else is "resolved", never a guess.
 */
export function suggestionOutcome(s: { ins: string; del: string }, prevPlain: string, nextPlain: string): "accepted" | "rejected" | "resolved" {
  const usable = (t: string) => t.trim().length >= SUGGESTION_MIN_CHARS && !t.includes("\n") && occurrences(prevPlain, t) === 1;
  // Inserted text: still there → accepted; gone → declined.
  const byIns = s.ins && usable(s.ins) ? (nextPlain.includes(s.ins) ? "accepted" : "rejected") : null;
  // Deleted text: gone → accepted; still there → declined.
  const byDel = s.del && usable(s.del) ? (nextPlain.includes(s.del) ? "rejected" : "accepted") : null;
  if (s.ins && s.del) return byIns && byDel && byIns === byDel ? byIns : "resolved";
  return (s.ins ? byIns : byDel) ?? "resolved";
}
/**
 * "X accepted / declined your suggestion". Runs after a document is persisted
 * (live store) or after the review queue applied a decision: a suggestion id
 * present in the previous content and absent from the new one was resolved.
 *
 *  - the suggester is the ACCOUNT behind the suggestion's actor id (the opaque
 *    `h_…` id the command endpoint and MCP write; the legacy email form is read
 *    too). No resolvable account (a capability guest, a live-typed suggestion
 *    with no actor id) → nothing is sent.
 *  - accepted = the inserted text is still in the page (or, for a pure deletion,
 *    the deleted text is gone); otherwise declined — the same rule the writer
 *    stamp uses.
 *  - the decider is the batch's single editor (several → unnamed); never sent
 *    when the suggester is among the editors (they withdrew or changed it
 *    themselves), and only to a suggester who can still VIEW the page.
 *  - idempotent per (page, suggestion id); spends the per-sender budgets, because
 *    an actor id on a mark is writable by any edit-level socket.
 */
export async function suggestionsResolved(o: { vaultId: string; noteId: string; prev: string | null; next: string; editors: string[] }): Promise<number> {
  if (!o.prev || !o.prev.includes("data-suggestion-id")) return 0;
  // Both documents are parsed OFF the main thread (one parse each gives the
  // suggestions and the reader text); one that cannot be parsed in budget → no notice.
  let prevView: Awaited<ReturnType<typeof suggestionViewOfHtml>>;
  let nextView: Awaited<ReturnType<typeof suggestionViewOfHtml>>;
  try {
    prevView = await suggestionViewOfHtml(o.prev);
    nextView = await suggestionViewOfHtml(o.next);
  } catch {
    return 0;
  }
  const before = prevView.suggestions;
  const after = nextView.suggestions;
  const gone = [...before].filter(([id]) => !after.has(id));
  if (!gone.length) return 0;
  const editors = new Set(o.editors.map((e) => e.toLowerCase()));
  if (!editors.size) return 0; // a server-internal store (reconcile, restore): nobody decided anything
  const info = await noteInfo(o.vaultId, o.noteId, { fresh: true });
  if (!info || info.trashed) return 0;
  const decider = editors.size === 1 ? [...editors][0]! : null;
  let prevPlain: string;
  let nextPlain: string;
  try {
    prevPlain = prevView.plain ?? "";
    nextPlain = nextView.plain ?? (await suggestionViewOfHtml(o.next, true)).plain ?? "";
  } catch {
    return 0;
  }
  let sent = 0;
  for (const [id, s] of gone.slice(0, SUGGESTION_NOTICES_PER_STORE)) {
    const suggester = s.actorId ? emailForActorId(s.actorId)?.toLowerCase() ?? null : null;
    if (!suggester || editors.has(suggester) || !isAccount(suggester) || !userCanView(suggester, o.vaultId, info)) continue;
    const outcome = suggestionOutcome(s, prevPlain, nextPlain);
    const preview = (s.ins || s.del).replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX) || null;
    if (createNotification({ vaultId: o.vaultId, recipient: suggester, type: outcome === "accepted" ? "suggestion_accepted" : outcome === "rejected" ? "suggestion_rejected" : "suggestion_resolved", noteId: o.noteId, actorEmail: decider, preview, dedupe: `suggestion:${o.noteId}:${id}` })) sent++;
  }
  return sent;
}

// ── collab wiring ────────────────────────────────────────────────────────────
setDocumentStoreListener({
  loaded: (docName, doc) => {
    const t = federationTarget(docName);
    primeComments(docName, doc, { vaultId: t.vaultId, noteId: t.noteId });
  },
  unloaded: (docName) => forgetComments(docName),
  stored: (e: DocumentStoredEvent) => {
    void noteContentStored({ vaultId: e.vaultId, noteId: e.noteId, prev: e.prevContent, next: e.content, authors: e.editors, updatedAt: e.updatedAt });
    void commentsStored(e.docName, e.vaultId, e.noteId, e.doc, e.editors).catch((err) =>
      console.error(`[notify] comment processing failed: ${(err as Error).message}`),
    );
    void suggestionsResolved({ vaultId: e.vaultId, noteId: e.noteId, prev: e.prevContent, next: e.content, editors: e.editors }).catch((err) =>
      console.error(`[notify] suggestion processing failed: ${(err as Error).message}`),
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
    // L2: approving never LOWERS what the requester already holds on this note.
    const existing = grantsForResource("note", r.note_id, r.vault_id).find((g) => g.subject_type === "user" && g.subject === r.requester);
    const want = expandLevel(level as Level);
    const held = existing ? new Set<Cap>(existing.caps ?? expandLevel(existing.level)) : new Set<Cap>();
    if (![...want].every((c) => held.has(c))) {
      if (existing?.caps) {
        upsertGrant({ vault_id: r.vault_id, subject_type: "user", subject: r.requester, resource_type: "note", resource: r.note_id, level: level as Level, caps: [...new Set<Cap>([...held, ...want])], created_by: decider });
      } else {
        const lvl = existing && levelRank(existing.level) > levelRank(level as Level) ? existing.level : (level as Level);
        upsertGrant({ vault_id: r.vault_id, subject_type: "user", subject: r.requester, resource_type: "note", resource: r.note_id, level: lvl, created_by: decider });
      }
    }
    forgetNoteInfo(r.vault_id, r.note_id);
    st.readForRequest.run(Date.now(), r.id);
    unreadCache.clear();
    createNotification({ vaultId: r.vault_id, recipient: r.requester, type: "access_granted", noteId: r.note_id, actorEmail: decider, requestId: r.id, dedupe: `access_granted:${r.id}` });
    return { ok: true, status: "approved" };
  }
  if (ar.decide.run("denied", Date.now(), decider, r.id).changes !== 1) return { ok: false, status: 409, error: "already_decided" };
  st.readForRequest.run(Date.now(), r.id);
  unreadCache.clear();
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

/**
 * One digest per user per interval for notifications still unread after a delay.
 * Paged PER RECIPIENT (review M2): rows whose category has email off are marked
 * as handled, so they can never fill a page and block anyone's digest.
 */
export async function runEmailDigestOnce(now = Date.now()): Promise<number> {
  if (!emailSender && !emailEnabled()) return 0;
  const cutoff = now - EMAIL_AFTER_MS;
  const pending = "read_at IS NULL AND archived_at IS NULL AND emailed_at IS NULL AND created_at <= ?";
  const recipients = db.prepare(`SELECT DISTINCT recipient FROM notifications WHERE ${pending} LIMIT 500`).all(cutoff) as Array<{ recipient: string }>;
  const rowsFor = db.prepare(`SELECT * FROM notifications WHERE recipient = ? AND ${pending} ORDER BY created_at ASC LIMIT 200`);
  const mark = db.prepare("UPDATE notifications SET emailed_at = ? WHERE id = ?");
  const lastAt = db.prepare("SELECT last_at FROM notification_email_log WHERE email = ?");
  const log = db.prepare("INSERT INTO notification_email_log (email, last_at) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET last_at = excluded.last_at");
  let sent = 0;
  for (const { recipient: email } of recipients) {
    const settings = getSettings(email);
    const rows = rowsFor.all(email, cutoff) as Row[];
    const wanted: Row[] = [];
    for (const r of rows) {
      if (settings[categoryOf(r.type)].email) wanted.push(r);
      else mark.run(now, r.id); // email off for this kind: handled, never emailed
    }
    if (!wanted.length) continue;
    const last = (lastAt.get(email) as { last_at: number } | undefined)?.last_at ?? 0;
    if (now - last < EMAIL_MIN_INTERVAL_MS) continue;
    const visible: Row[] = [];
    for (const r of wanted) if (await view(r)) visible.push(r);
    for (const r of wanted) mark.run(now, r.id); // hidden rows are never emailed later either
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
