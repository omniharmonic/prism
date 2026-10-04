/**
 * Renaming a page from its TITLE (NP-PG-03) — the same operation as the tree's
 * Rename: a MOVE of the page and its sub-pages (`ops.movePage`: the server's
 * `POST /api/notes/:id/move` where the shell has the pages routes, per-note path
 * writes on the legacy desktop). A single-note path PATCH left the sub-pages
 * behind under a plain folder with the old name, and the gateway refuses it for
 * everyone but the owner (`move_required`).
 *
 * Never queued: offline it is refused with a toast and the title goes back.
 * A plain function (no hooks): the full-page share route has no providers.
 */
import type { VaultClient } from "../../data/VaultClient";
import { PagesRequestError, pageTitle, renamePath, type MoveResult } from "./model";
import * as ops from "./ops";
import { flushPendingSaves } from "../../app/hooks/useAutoSave";
import { usePagesUI } from "./store";

/**
 * A rename a retry cannot fix — the name is taken / the page changed (409), no
 * permission (403), the page is gone (404) or locked (423), or the device is
 * offline: the title editor shows `message` and puts the old title back
 * (`revertTitle`). Anything else thrown keeps the typed title for a retry.
 */
export class TitleRenameRefused extends Error {
  readonly revertTitle = true;
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "TitleRenameRefused";
  }
}

export const isTitleRenameRefused = (e: unknown): e is TitleRenameRefused =>
  !!e && typeof e === "object" && (e as { revertTitle?: unknown }).revertTitle === true && e instanceof Error;

const OFFLINE = "You’re offline. Renaming or moving a page needs a connection — reconnect and try again.";

function offlineRefusal(): TitleRenameRefused {
  // The shell's offline indicator shows this as a toast (one toast: the same event every refused offline write raises).
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("prism:offline-refused", { detail: { message: OFFLINE } }));
  return new TitleRenameRefused(OFFLINE, "offline");
}

function refusalOf(e: unknown, title: string): TitleRenameRefused | null {
  if (!(e instanceof PagesRequestError)) return null;
  if (e.code === "offline" || e.status === 0) return offlineRefusal();
  if (e.code === "path_conflict") return new TitleRenameRefused(`A page named “${title}” already exists here. Choose another title.`, e.code);
  // Unsent changes of this page: saved in a moment — the typed title stays for a retry.
  if (e.code === "pending_writes") return null;
  // No permission (403), page gone or hidden (404), locked (423), changed or name unavailable (409):
  // a retry cannot fix any of them. The title goes back with the server's own reason.
  if ([403, 404, 409, 423].includes(e.status)) return new TitleRenameRefused(e.message, e.code);
  // Everything else (5xx, a bad answer) keeps the typed title; the editor shows the reason.
  return null;
}

/** Finish a rename whose sub-pages did not all move. True when everything has moved. */
async function finishRename(client: VaultClient, id: string, title: string, moveId: string, onDone?: () => void): Promise<boolean> {
  try {
    const fresh = await client.getNote(id, { fresh: true });
    const result = await ops.movePage(client, id, { moveId, ...(fresh?.updatedAt ? { ifUpdatedAt: fresh.updatedAt } : {}) });
    onDone?.();
    partialNotice(client, id, title, result, onDone);
    if (result.ok) usePagesUI.getState().showToast({ message: `Renamed “${title}” and its sub-pages` });
    return result.ok;
  } catch (e) {
    usePagesUI.getState().showToast({ message: ops.pageErrorText(e, "Couldn’t finish the rename. Try again."), tone: "error" });
    return false;
  }
}

function partialNotice(client: VaultClient, id: string, title: string, result: MoveResult, onDone?: () => void): void {
  if (result.ok || !result.partial) return;
  const { remaining, resume } = result.partial;
  usePagesUI.getState().showToast({
    message: `Renamed “${title}”. ${remaining} sub-page${remaining === 1 ? "" : "s"} still need${remaining === 1 ? "s" : ""} moving.`,
    tone: "error",
    ...(resume.moveId ? { action: { label: "Finish move", run: () => void finishRename(client, id, title, resume.moveId, onDone) } } : {}),
  });
}

export interface TitleRenameResult {
  path: string;
  /** Some sub-pages have not moved yet. */
  partial: boolean;
  /** Present while `partial` and resumable: finishes the move (the toast's "Finish move"; hosts without toasts render their own button). */
  finish?: () => Promise<boolean>;
}

/**
 * Rename `page` to `newName`. Resolves with the confirmed path (null when the
 * name is empty or unchanged). Throws {@link TitleRenameRefused} when the title
 * should go back, anything else when the typed title should stay for a retry.
 * `onChanged` runs after every confirmed write (also the "Finish move" action).
 */
export async function renamePageFromTitle(
  client: VaultClient,
  page: { id: string; path: string | null | undefined },
  newName: string,
  onChanged?: () => void,
): Promise<TitleRenameResult | null> {
  const next = renamePath(page.path, newName);
  if (!next) return null;
  const title = newName.trim();
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw offlineRefusal();
  // What was just typed in the body goes first: a debounced autosave landing between our fresh
  // read and the move would make the move conflict with the page's own save.
  await flushPendingSaves(page.id).catch(() => {});
  let result: MoveResult;
  try {
    // CAS against the page as the server has it NOW (the tree's Rename does the same).
    const fresh = await client.getNote(page.id, { fresh: true });
    result = await ops.movePage(client, page.id, { newPath: next, ...(fresh?.updatedAt ? { ifUpdatedAt: fresh.updatedAt } : {}) });
  } catch (e) {
    throw refusalOf(e, title) ?? e;
  }
  onChanged?.();
  partialNotice(client, page.id, pageTitle(result.path) || title, result, onChanged);
  const name = pageTitle(result.path) || title;
  const moveId = !result.ok ? result.partial?.resume.moveId : undefined;
  return { path: result.path, partial: !result.ok, ...(moveId ? { finish: () => finishRename(client, page.id, name, moveId, onChanged) } : {}) };
}
