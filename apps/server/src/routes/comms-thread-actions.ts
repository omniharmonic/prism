// Row actions + owner folders (sprint Task 9). Owner only (requireCommsOwner); writes take
// application/json ≤ 8 KB and pass the CSRF floor (middleware/csrf.ts) like every comms write.
// Nothing here sends anything to any network: mute / archive / folders are owner overrides,
// status is one tag write on the owner's own vault note (with an undo).
//
// COMMS_THREAD_ACTIONS_ENABLED (off → 404 thread_actions_disabled):
//   POST /api/comms/threads/:id/mute      {muted: bool}      → {thread}
//   POST /api/comms/threads/:id/archive   {archived: bool}   → {thread}
//   POST /api/comms/threads/:id/status    {status}           → {thread, undo: {id, status} | null}
//        status ∈ handled|urgent|action-required|informational|low|social|triaged (core statusChange);
//        409 no_note (the thread has no vault note: iMessage/SMS), 503 vault_unavailable
//   POST /api/comms/threads/:id/status/undo {undoId}         → {thread}
//        409 status_changed (moved since) | already_undone, 404 undo_unavailable
//
// COMMS_FOLDERS_ENABLED (off → 404 folders_disabled):
//   GET    /api/comms/folders                         → {folders: [{id, name, position, count}]}
//   POST   /api/comms/folders {name}                  → {folder}   409 folder_limit (20) | folder_exists
//   PATCH  /api/comms/folders/:id {name}              → {folder}
//   DELETE /api/comms/folders/:id                     → {ok: true} (threads stay where they are)
//   PUT    /api/comms/folders/order {folderIds}       → {folders}  409 folders_changed {folderIds}
//   POST   /api/comms/folders/:id/threads {threadIds}        → {folder} (add, ≤ 200 per call)
//   POST   /api/comms/folders/:id/threads/remove {threadIds} → {folder}
//   GET    /api/comms/threads?inFolder=<id>           — the folder's threads (archived/spam left
//          out unless `folder` is given); every Thread carries `folderIds`.
import { resolveThreadRedirect } from "../comms/forums";
import type { Context } from "hono";
import { config } from "../config";
import { requireCommsOwner } from "../comms/guard";
import { ThreadActionError, setArchived, setMuted, setThreadStatus, undoThreadStatus } from "../comms/thread-actions";
import {
  FolderError, MAX_THREADS_PER_CALL, addToFolder, createFolder, deleteFolder, listFolders, removeFromFolder, renameFolder, reorderFolders,
} from "../comms/folders";
import { isSettableStatus } from "../comms/triage";
import { threadOut } from "../comms/timeline";
import { actionOrigin, readCapped } from "./actions";

const MAX_ID = 200;
const validId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= MAX_ID && !/[\u0000-\u001f\u007f]/.test(s);

/**
 * A person's choice only (final review I2), as notification settings and tidy-up: mute decides
 * what reaches the lock screen and status writes the vault, so an agent-origin request (an MCP
 * tool, an Omni turn, a routine, the loopback token, or `X-Prism-Action-Origin: agent`) is
 * refused 403 `agent_origin_refused`. Only a signed-in session or device, as a human, passes.
 */
export function humanOnly(c: Context): Response | null {
  return actionOrigin(c).origin === "human" ? null : c.json({ error: "agent_origin_refused" }, 403);
}

function gateActions(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g;
  if (!config.commsThreadActionsEnabled) return { ok: false as const, res: c.json({ error: "thread_actions_disabled" }, 404) };
  const refused = humanOnly(c);
  if (refused) return { ok: false as const, res: refused };
  return g;
}

/** Folders: reading is open to the owner; every write needs a human (`write`). */
function gateFolders(c: Context, write = true) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g;
  if (!config.commsFoldersEnabled) return { ok: false as const, res: c.json({ error: "folders_disabled" }, 404) };
  const refused = write ? humanOnly(c) : null;
  if (refused) return { ok: false as const, res: refused };
  return g;
}

/** A JSON object body (≤ 8 KB), or a Response refusing it. */
async function body(c: Context): Promise<Record<string, unknown> | Response> {
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return c.json({ error: "unsupported_type" }, 415);
  const raw = await readCapped(c.req.raw, 8 * 1024);
  if (raw === null) return c.json({ error: "too_large" }, 413);
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return c.json({ error: "invalid_request" }, 400);
    return v as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
}

function actionErr(c: Context, e: unknown): Response {
  if (!(e instanceof ThreadActionError)) throw e;
  return c.json({ error: e.code }, e.status);
}

function folderErr(c: Context, e: unknown): Response {
  if (!(e instanceof FolderError)) throw e;
  if (e.code === "folders_changed") return c.json({ error: e.code, folderIds: listFolders().map((f) => f.id) }, 409);
  return c.json({ error: e.code }, e.status);
}

function toggle(key: "muted" | "archived", apply: (id: string, on: boolean) => ReturnType<typeof setMuted>) {
  return async (c: Context): Promise<Response> => {
    const g = gateActions(c);
    if (!g.ok) return g.res;
    const id = resolveThreadRedirect(c.req.param("id") ?? "");
    if (!validId(id)) return c.json({ error: "thread_unavailable" }, 404);
    const b = await body(c);
    if (b instanceof Response) return b;
    if (typeof b[key] !== "boolean" || Object.keys(b).length !== 1) return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({ thread: threadOut(apply(id, b[key] as boolean), g.actor) });
    } catch (e) {
      return actionErr(c, e);
    }
  };
}

export const postMute = toggle("muted", setMuted);
export const postArchive = toggle("archived", setArchived);

export async function postStatus(c: Context): Promise<Response> {
  const g = gateActions(c);
  if (!g.ok) return g.res;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!validId(id)) return c.json({ error: "thread_unavailable" }, 404);
  const b = await body(c);
  if (b instanceof Response) return b;
  if (!isSettableStatus(b.status) || Object.keys(b).length !== 1) return c.json({ error: "invalid_status" }, 400);
  try {
    const r = await setThreadStatus(g.vaultId, id, b.status);
    return c.json({ thread: threadOut(r.thread, g.actor), undo: r.undo });
  } catch (e) {
    return actionErr(c, e);
  }
}

export async function postStatusUndo(c: Context): Promise<Response> {
  const g = gateActions(c);
  if (!g.ok) return g.res;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!validId(id)) return c.json({ error: "thread_unavailable" }, 404);
  const b = await body(c);
  if (b instanceof Response) return b;
  if (!validId(b.undoId) || Object.keys(b).length !== 1) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json({ thread: threadOut(await undoThreadStatus(g.vaultId, id, b.undoId), g.actor) });
  } catch (e) {
    return actionErr(c, e);
  }
}

// ── folders ──────────────────────────────────────────────────────────────────

export function getFolders(c: Context): Response {
  const g = gateFolders(c, false);
  if (!g.ok) return g.res;
  c.header("Cache-Control", "private, no-store");
  return c.json({ folders: listFolders() });
}

export async function postFolder(c: Context): Promise<Response> {
  const g = gateFolders(c);
  if (!g.ok) return g.res;
  const b = await body(c);
  if (b instanceof Response) return b;
  if (Object.keys(b).length !== 1) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json({ folder: createFolder(b.name) }, 201);
  } catch (e) {
    return folderErr(c, e);
  }
}

export async function patchFolder(c: Context): Promise<Response> {
  const g = gateFolders(c);
  if (!g.ok) return g.res;
  const id = c.req.param("id") ?? "";
  if (!validId(id)) return c.json({ error: "folder_unavailable" }, 404);
  const b = await body(c);
  if (b instanceof Response) return b;
  if (Object.keys(b).length !== 1) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json({ folder: renameFolder(id, b.name) });
  } catch (e) {
    return folderErr(c, e);
  }
}

export function removeFolder(c: Context): Response {
  const g = gateFolders(c);
  if (!g.ok) return g.res;
  const id = c.req.param("id") ?? "";
  if (!validId(id)) return c.json({ error: "folder_unavailable" }, 404);
  try {
    deleteFolder(id);
    return c.json({ ok: true });
  } catch (e) {
    return folderErr(c, e);
  }
}

export async function putFolderOrder(c: Context): Promise<Response> {
  const g = gateFolders(c);
  if (!g.ok) return g.res;
  const b = await body(c);
  if (b instanceof Response) return b;
  const ids = b.folderIds;
  if (!Array.isArray(ids) || ids.length > 50 || !ids.every(validId) || Object.keys(b).length !== 1) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json({ folders: reorderFolders(ids as string[]) });
  } catch (e) {
    return folderErr(c, e);
  }
}

function membership(apply: typeof addToFolder) {
  return async (c: Context): Promise<Response> => {
    const g = gateFolders(c);
    if (!g.ok) return g.res;
    const id = c.req.param("id") ?? "";
    if (!validId(id)) return c.json({ error: "folder_unavailable" }, 404);
    const b = await body(c);
    if (b instanceof Response) return b;
    const ids = b.threadIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_THREADS_PER_CALL || !ids.every(validId) || Object.keys(b).length !== 1)
      return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({ folder: apply(id, (ids as string[]).map(resolveThreadRedirect)) });
    } catch (e) {
      return folderErr(c, e);
    }
  };
}

export const postFolderThreads = membership(addToFolder);
export const postFolderThreadsRemove = membership(removeFromFolder);
