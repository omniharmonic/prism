// Row actions (sprint Task 9, "slides on chats … mute a chat, archive a chat, or change the status
// of the thread"). All owner overrides or the owner's own vault note — nothing is sent to anyone.
//
//   mute     comms_threads.o_muted (Hide Alerts). comms/notify.ts already never pushes a muted thread.
//   archive  comms_threads.o_archived (+ o_archived_at): the thread moves to the Archived folder; a
//            message from someone else sent after that brings it back (store.ts unarchiveOnArrival),
//            as Messages does. Unarchive = o_archived 0 (it wins over a source-side archive).
//   status   the thread's vault `message-thread` note: ONE tag write following Prism's statusChange
//            rules (comms/triage.ts mirrors core), then the projection is updated at once (the tree
//            listener would follow anyway). Every write records an undo (comms_status_undo): undo
//            re-applies the inverse tag change while the note's classification is still what this
//            write left (else 409 status_changed — someone or the classifier moved it since).
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { config } from "../config";
import { vaultClient, VaultError, type Note } from "../parachute";
import { appendEvent, getThread, setOverride, setStatusForNote } from "./store";
import { ownerSetStatus } from "./notify";
import { unpinThread } from "./pins";
import { forumTopics, isForumThread } from "./forums";
import { commsStatus, statusChange, type CommsStatus, type SettableStatus } from "./triage";
import type { Thread } from "./types";

export class ThreadActionError extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    readonly code: "thread_unavailable" | "no_note" | "undo_unavailable" | "already_undone" | "status_changed" | "vault_unavailable",
  ) {
    super(code);
    this.name = "ThreadActionError";
  }
}

function changed(threadId: string): Thread {
  appendEvent("thread.updated", threadId, { threadId });
  return getThread(threadId)!;
}

function existing(threadId: string): Thread {
  const t = getThread(threadId);
  if (!t) throw new ThreadActionError(404, "thread_unavailable");
  return t;
}

/** Mute (Hide Alerts) or unmute. Idempotent; announced only when it changed. */
export function setMuted(threadId: string, muted: boolean): Thread {
  const t = existing(threadId);
  setOverride(threadId, { muted });
  return t.muted === muted ? getThread(threadId)! : changed(threadId);
}

/**
 * Archive (→ the Archived folder) or unarchive (→ back where the source puts it).
 * - Unarchive clears the owner's override (o_archived NULL) when the source does not archive the
 *   thread, so a later source-side archive still applies (final review M2: undoing an archive used
 *   to leave a sticky "not archived"); only a SOURCE-archived thread gets o_archived = 0 to beat it.
 * - Archive unpins a Comms pin (Mail does; final review M5): an archived pin would hide from the
 *   inbox grid yet still count toward the nine.
 */
export function setArchived(threadId: string, archived: boolean): Thread {
  const t = existing(threadId);
  const sourceArchived = (db.prepare(`SELECT MAX(c.archived) AS a FROM comms_thread_members m JOIN comms_conversations c ON c.id = m.conversation_id
    WHERE m.thread_id = ?`).get(threadId) as { a: number | null }).a === 1;
  const before = t.folder;
  if (archived) {
    setOverride(threadId, { archived: true });
    if (t.pinned && t.pinOrder !== undefined) unpinThread(threadId);
  } else if (sourceArchived) {
    setOverride(threadId, { archived: false });
  } else {
    db.prepare(`UPDATE comms_threads SET o_archived = NULL, o_archived_at = NULL WHERE id = ?`).run(threadId);
  }
  const after = getThread(threadId)!;
  return after.folder === before ? after : changed(threadId);
}

// ── status ───────────────────────────────────────────────────────────────────

export interface TagVault {
  getNote(id: string, opts?: { includeContent?: boolean }): Promise<Note>;
  updateNote(id: string, params: { tags?: { add?: string[]; remove?: string[] } }): Promise<Note>;
}

let vaultImpl: (vaultId: string) => TagVault = (vaultId) =>
  vaultClient(vaultId, { timeoutMs: config.peopleVaultTimeoutMs > 0 ? config.peopleVaultTimeoutMs : 15_000 });
export function setStatusVaultForTests(f: ((vaultId: string) => TagVault) | null): void {
  vaultImpl = f ?? ((vaultId) => vaultClient(vaultId, { timeoutMs: 15_000 }));
}

async function readNote(vault: TagVault, noteId: string): Promise<Note> {
  try {
    return await vault.getNote(noteId, { includeContent: false });
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) throw new ThreadActionError(409, "no_note");
    throw new ThreadActionError(503, "vault_unavailable");
  }
}

async function writeTags(vault: TagVault, noteId: string, change: { add: string[]; remove: string[] }): Promise<string[]> {
  try {
    const n = await vault.updateNote(noteId, { tags: change });
    return n.tags ?? [];
  } catch (e) {
    // Content-free: the class and the vault status only.
    console.warn(`[comms] status write failed: ${e instanceof VaultError ? `vault_${e.status}` : e instanceof Error ? e.name : "error"}`);
    throw new ThreadActionError(503, "vault_unavailable");
  }
}

/** Apply the tags the vault now holds to the projection (every conversation of that note). */
function project(threadId: string, noteId: string, tags: readonly string[]): Thread {
  setStatusForNote(noteId, commsStatus(tags));
  return getThread(threadId) ?? existing(threadId);
}

export interface StatusResult { thread: Thread; undo: { id: string; status: CommsStatus } | null }

/**
 * Set the thread's triage status: one tag write on its vault note (core statusChange rules).
 * Already that status: nothing is written and there is nothing to undo.
 */
export async function setThreadStatus(vaultId: string, threadId: string, next: SettableStatus): Promise<StatusResult> {
  const t = existing(threadId);
  if (isForumThread(threadId)) return setForumStatus(vaultId, t, next);
  if (!t.noteId) throw new ThreadActionError(409, "no_note");
  const vault = vaultImpl(vaultId);
  const note = await readNote(vault, t.noteId);
  const before = note.tags ?? [];
  const change = statusChange(before, next);
  if (!change.add.length && !change.remove.length) return { thread: project(threadId, t.noteId, before), undo: null };
  const after = await writeTags(vault, t.noteId, change);
  ownerSetStatus(threadId);
  // The undo record is written right after the vault write: a changed note always has its undo.
  const id = `su_${randomUUID().replace(/-/g, "")}`;
  db.prepare(`INSERT INTO comms_status_undo (id, thread_id, note_id, added_json, removed_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, threadId, t.noteId, JSON.stringify(change.add), JSON.stringify(change.remove), commsStatus(after), Date.now());
  pruneUndo();
  return { thread: project(threadId, t.noteId, after), undo: { id, status: commsStatus(before) } };
}

/**
 * A Telegram forum (comms/forums.ts): the forum's status is its topics' (the most pressing one), so
 * setting it writes every topic's note that is not there yet — one tag write each, bounded. The undo
 * rows share the undo id (`<id>`, `<id>.1`, …): one Undo reverts the forum.
 */
const MAX_FORUM_STATUS_WRITES = 50;
async function setForumStatus(vaultId: string, t: Thread, next: SettableStatus): Promise<StatusResult> {
  const notes = [...new Set(forumTopics(t.id).map((x) => x.noteId).filter((n): n is string => !!n))].slice(0, MAX_FORUM_STATUS_WRITES);
  if (!notes.length) throw new ThreadActionError(409, "no_note");
  const vault = vaultImpl(vaultId);
  const before = t.status;
  const id = `su_${randomUUID().replace(/-/g, "")}`;
  let n = 0;
  for (const noteId of notes) {
    const note = await readNote(vault, noteId);
    const tags = note.tags ?? [];
    const change = statusChange(tags, next);
    if (!change.add.length && !change.remove.length) { setStatusForNote(noteId, commsStatus(tags)); continue; }
    const after = await writeTags(vault, noteId, change);
    db.prepare(`INSERT INTO comms_status_undo (id, thread_id, note_id, added_json, removed_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(n ? `${id}.${n}` : id, t.id, noteId, JSON.stringify(change.add), JSON.stringify(change.remove), commsStatus(after), Date.now());
    n++;
    setStatusForNote(noteId, commsStatus(after));
  }
  if (!n) return { thread: getThread(t.id) ?? t, undo: null };
  ownerSetStatus(t.id);
  pruneUndo();
  return { thread: getThread(t.id) ?? t, undo: { id, status: before } };
}

/** Undo one status write: the inverse tag change, only while the note still shows what it left. */
export async function undoThreadStatus(vaultId: string, threadId: string, undoId: string): Promise<Thread> {
  existing(threadId);
  type UndoRow = { id: string; note_id: string; added_json: string; removed_json: string; status: string; undone_at: number | null };
  const group = /^su_[0-9a-f]{32}$/.test(undoId)
    ? db.prepare(`SELECT * FROM comms_status_undo WHERE thread_id = ? AND id LIKE ? ORDER BY id`).all(threadId, `${undoId}.%`) as UndoRow[]
    : [];
  if (group.length) {
    // A forum's status write: every topic note, each only while it still shows what the write left.
    const first = db.prepare(`SELECT * FROM comms_status_undo WHERE id = ? AND thread_id = ?`).get(undoId, threadId) as UndoRow | undefined;
    const rows = [...(first ? [first] : []), ...group];
    if (rows.every((r) => r.undone_at !== null)) throw new ThreadActionError(409, "already_undone");
    const vault = vaultImpl(vaultId);
    let changedSince = false;
    for (const r of rows.filter((x) => x.undone_at === null)) {
      const note = await readNote(vault, r.note_id);
      const now = note.tags ?? [];
      if (commsStatus(now) !== r.status) { changedSince = true; continue; }
      const added = JSON.parse(r.added_json) as string[];
      const removed = JSON.parse(r.removed_json) as string[];
      const inverse = { add: removed.filter((x) => !now.includes(x)), remove: added.filter((x) => now.includes(x)) };
      const after = inverse.add.length || inverse.remove.length ? await writeTags(vault, r.note_id, inverse) : now;
      db.prepare(`UPDATE comms_status_undo SET undone_at = ? WHERE id = ?`).run(Date.now(), r.id);
      setStatusForNote(r.note_id, commsStatus(after));
    }
    if (changedSince && rows.every((r) => r.undone_at === null) && !rows.some((r) => (db.prepare(`SELECT undone_at FROM comms_status_undo WHERE id = ?`).get(r.id) as { undone_at: number | null }).undone_at !== null))
      throw new ThreadActionError(409, "status_changed");
    return getThread(threadId) ?? existing(threadId);
  }
  const row = db.prepare(`SELECT * FROM comms_status_undo WHERE id = ? AND thread_id = ?`).get(undoId, threadId) as
    { note_id: string; added_json: string; removed_json: string; status: string; undone_at: number | null } | undefined;
  if (!row) throw new ThreadActionError(404, "undo_unavailable");
  if (row.undone_at !== null) throw new ThreadActionError(409, "already_undone");
  const vault = vaultImpl(vaultId);
  const note = await readNote(vault, row.note_id);
  const now = note.tags ?? [];
  if (commsStatus(now) !== row.status) throw new ThreadActionError(409, "status_changed");
  const added = JSON.parse(row.added_json) as string[];
  const removed = JSON.parse(row.removed_json) as string[];
  const inverse = { add: removed.filter((x) => !now.includes(x)), remove: added.filter((x) => now.includes(x)) };
  const after = inverse.add.length || inverse.remove.length ? await writeTags(vault, row.note_id, inverse) : now;
  db.prepare(`UPDATE comms_status_undo SET undone_at = ? WHERE id = ?`).run(Date.now(), undoId);
  return project(threadId, row.note_id, after);
}

/** Undo records older than a day are dropped (an undo is a moment's second thought). */
function pruneUndo(now = Date.now()): void {
  db.prepare(`DELETE FROM comms_status_undo WHERE created_at < ?`).run(now - 86_400_000);
}
