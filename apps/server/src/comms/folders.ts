// Owner folders (sprint Task 9, "add chats to folders that I can swipe between").
//
// Owner data (not rebuildable): comms_folders (name, dense position 0…n-1) and
// comms_folder_members (folder × display thread). Every device reads the same folders from the
// server; changes are announced on the stream:
//   - a folder created / renamed / reordered / deleted → one list-wide `thread.updated`
//     {threadId: null, reason: "folders"} (clients refetch GET /folders and the list);
//   - a thread added to / removed from a folder → `thread.updated` for that thread (its
//     `folderIds` changed; a delete also announces each member that lost the folder).
// A thread in a folder is still in its system folder (inbox, archived…): folders are a second
// grouping, as Telegram's folders over the chat list. Nothing here reaches any network.
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { appendEvent, getThread, visibleSql } from "./store";

export const MAX_FOLDERS = 20;
export const MAX_FOLDER_NAME = 40;
export const MAX_FOLDER_THREADS = 2000;
/** One request adds or removes at most this many threads (multi-select). */
export const MAX_THREADS_PER_CALL = 200;

export interface CommsFolderOut { id: string; name: string; position: number; count: number }

export class FolderError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: "folder_unavailable" | "folder_limit" | "folder_exists" | "invalid_name" | "folders_changed" | "folder_full" | "thread_unavailable",
  ) {
    super(code);
    this.name = "FolderError";
  }
}

/** Trimmed, inner whitespace collapsed, no control characters, 1…40 characters. */
export function folderName(raw: unknown): string {
  if (typeof raw !== "string") throw new FolderError(400, "invalid_name");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(raw)) throw new FolderError(400, "invalid_name");
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name || [...name].length > MAX_FOLDER_NAME) throw new FolderError(400, "invalid_name");
  // "All" and "Comms" name the home page.
  if (["all", "comms"].includes(name.toLowerCase())) throw new FolderError(409, "folder_exists");
  return name;
}

const announceList = () => appendEvent("thread.updated", null, { threadId: null, reason: "folders" });

/** The folder page's own rule (store.ts listThreads inFolder): a listed conversation, not Archived or Spam. */
const E_FOLDER = `COALESCE(t.o_folder, CASE WHEN COALESCE(t.o_archived, c.archived) = 1 THEN 'archived' ELSE c.folder END)`;

export function listFolders(): CommsFolderOut[] {
  // `count` = what the folder's page shows (final review M1): members whose conversation still
  // lists, outside Archived and Spam, and served (visibleSql).
  return (db.prepare(`SELECT f.id, f.name, f.position, (SELECT COUNT(DISTINCT fm.thread_id) FROM comms_folder_members fm
      JOIN comms_threads t ON t.id = fm.thread_id JOIN comms_thread_members m ON m.thread_id = t.id
      JOIN comms_conversations c ON c.id = m.conversation_id AND c.forum_id IS NULL
      WHERE fm.folder_id = f.id AND ${E_FOLDER} NOT IN ('archived', 'spam') AND ${visibleSql()}) AS count
    FROM comms_folders f ORDER BY f.position ASC, f.created_at ASC`).all() as CommsFolderOut[]);
}

/** Every membership row of a folder (the cap counts these, listed or not). */
const memberRows = (id: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM comms_folder_members WHERE folder_id = ?`).get(id) as { n: number }).n;

function folder(id: string): CommsFolderOut {
  const f = listFolders().find((x) => x.id === id);
  if (!f) throw new FolderError(404, "folder_unavailable");
  return f;
}

function nameTaken(name: string, except?: string): boolean {
  return listFolders().some((f) => f.id !== except && f.name.toLowerCase() === name.toLowerCase());
}

/** Dense positions in the given order (inside a transaction). */
function writePositions(ids: string[]): void {
  const upd = db.prepare(`UPDATE comms_folders SET position = ? WHERE id = ?`);
  ids.forEach((id, i) => upd.run(i, id));
}

export function createFolder(rawName: unknown): CommsFolderOut {
  const name = folderName(rawName);
  const id = db.transaction((): string => {
    const all = listFolders();
    if (all.length >= MAX_FOLDERS) throw new FolderError(409, "folder_limit");
    if (nameTaken(name)) throw new FolderError(409, "folder_exists");
    const id = `cf_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const now = Date.now();
    db.prepare(`INSERT INTO comms_folders (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, name, all.length, now, now);
    return id;
  })();
  announceList();
  return folder(id);
}

export function renameFolder(id: string, rawName: unknown): CommsFolderOut {
  const name = folderName(rawName);
  const changed = db.transaction((): boolean => {
    const f = folder(id);
    if (f.name === name) return false;
    if (nameTaken(name, id)) throw new FolderError(409, "folder_exists");
    db.prepare(`UPDATE comms_folders SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), id);
    return true;
  })();
  if (changed) announceList();
  return folder(id);
}

/** Delete a folder (its threads stay where they are — only the grouping goes). */
export function deleteFolder(id: string): void {
  const members = db.transaction((): string[] => {
    folder(id);
    const ids = (db.prepare(`SELECT thread_id FROM comms_folder_members WHERE folder_id = ?`).all(id) as { thread_id: string }[]).map((r) => r.thread_id);
    db.prepare(`DELETE FROM comms_folder_members WHERE folder_id = ?`).run(id);
    db.prepare(`DELETE FROM comms_folders WHERE id = ?`).run(id);
    writePositions(listFolders().map((f) => f.id));
    return ids;
  })();
  announceList();
  for (const t of members) appendEvent("thread.updated", t, { threadId: t });
}

/** `ids` must be exactly the folders that exist (any order, no duplicates), else 409 folders_changed. */
export function reorderFolders(ids: string[]): CommsFolderOut[] {
  const changed = db.transaction((): boolean => {
    const now = listFolders();
    const same = ids.length === now.length && new Set(ids).size === ids.length && ids.every((id) => now.some((f) => f.id === id));
    if (!same) throw new FolderError(409, "folders_changed");
    const moved = ids.some((id, i) => now[i]!.id !== id);
    if (moved) writePositions(ids);
    return moved;
  })();
  if (changed) announceList();
  return listFolders();
}

/** Add threads to a folder (idempotent). An unknown thread refuses the whole call (404). */
export function addToFolder(id: string, threadIds: string[]): CommsFolderOut {
  const added = db.transaction((): string[] => {
    folder(id);
    for (const t of threadIds) if (!getThread(t)) throw new FolderError(404, "thread_unavailable");
    const ins = db.prepare(`INSERT OR IGNORE INTO comms_folder_members (folder_id, thread_id, added_at) VALUES (?, ?, ?)`);
    const now = Date.now();
    const out: string[] = [];
    for (const t of new Set(threadIds)) if (ins.run(id, t, now).changes > 0) out.push(t);
    if (memberRows(id) > MAX_FOLDER_THREADS) throw new FolderError(409, "folder_full");
    return out;
  })();
  for (const t of added) appendEvent("thread.updated", t, { threadId: t });
  return folder(id);
}

/** Remove threads from a folder (idempotent; unknown threads are simply not in it). */
export function removeFromFolder(id: string, threadIds: string[]): CommsFolderOut {
  const removed = db.transaction((): string[] => {
    folder(id);
    const del = db.prepare(`DELETE FROM comms_folder_members WHERE folder_id = ? AND thread_id = ?`);
    return [...new Set(threadIds)].filter((t) => del.run(id, t).changes > 0);
  })();
  for (const t of removed) appendEvent("thread.updated", t, { threadId: t });
  return folder(id);
}

export const folderExists = (id: string): boolean => listFolders().some((f) => f.id === id);
