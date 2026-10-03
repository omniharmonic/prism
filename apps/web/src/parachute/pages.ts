/**
 * Pages transport (nested-page move, Trash, synced preferences) for the web and
 * native shells — the server side is apps/server/src/pages.ts. Straight through
 * `serverFetch` with the active write context (vault, workspace, actor binding).
 * Never queued offline: a move, trash or preference write replayed later could
 * act on pages that changed meanwhile, so an offline attempt fails visibly.
 */
import {
  PagesRequestError,
  type MoveRequest,
  type MoveResult,
  type PagePreferences,
  type PreferencesSnapshot,
  type TrashListing,
} from "@prism/core";
import { captureWriteContext } from "../offline/writeScope";
import { serverFetch } from "../transport";

const MESSAGES: Record<number, string> = {
  401: "Sign in again to change pages.",
  403: "You don’t have permission to change this page.",
  404: "This page no longer exists.",
  409: "This page changed. Reload and try again.",
  413: "That’s too many pages to change at once.",
  428: "Reload this page and try again.",
};

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const context = await captureWriteContext();
  let resp: Response;
  try {
    resp = await serverFetch(`${context.scope.api}${path}`, {
      method,
      headers: context.headers,
      cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new PagesRequestError(0, "offline", "You’re offline. Reconnect and try again.");
  }
  const text = await resp.text().catch(() => "");
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const reason = typeof data?.reason === "string" ? data.reason : MESSAGES[resp.status] ?? "Something went wrong. Try again.";
    throw new PagesRequestError(resp.status, typeof data?.error === "string" ? data.error : `http_${resp.status}`, reason, data);
  }
  return { status: resp.status, data: data as T };
}

const id = (noteId: string) => encodeURIComponent(noteId);

export async function movePage(noteId: string, request: MoveRequest): Promise<MoveResult> {
  const body = {
    ...(request.newPath !== undefined ? { newPath: request.newPath } : { newParentPath: request.newParentPath ?? "" }),
    ...(request.ifUpdatedAt ? { if_updated_at: request.ifUpdatedAt } : {}),
    ...(request.fromPath ? { fromPath: request.fromPath } : {}),
  };
  const { status, data } = await call<Record<string, unknown>>("POST", `/notes/${id(noteId)}/move`, body);
  if (status === 207) {
    const resume = data.resume as { fromPath: string; newPath: string };
    return {
      ok: false,
      path: resume.newPath,
      moved: (data.moved as MoveResult["moved"]) ?? [],
      partial: { failed: data.failed as NonNullable<MoveResult["partial"]>["failed"], resume, remaining: Number(data.remaining ?? 0) },
    };
  }
  return { ok: true, path: String(data.path), moved: (data.moved as MoveResult["moved"]) ?? [] };
}

export async function trashPage(noteId: string): Promise<{ rootId: string; trashed: string[] }> {
  const { status, data } = await call<{ rootId: string; trashed: string[]; reason?: string }>("POST", `/notes/${id(noteId)}/trash`, {});
  if (status === 207) throw new PagesRequestError(207, "partial_trash", data.reason ?? "Some pages moved to Trash. Try again to finish.", data);
  return { rootId: data.rootId, trashed: data.trashed ?? [] };
}

export async function listTrash(query = ""): Promise<TrashListing> {
  return (await call<TrashListing>("GET", `/trash${query ? `?q=${encodeURIComponent(query)}` : ""}`)).data;
}

export async function restoreFromTrash(noteId: string): Promise<{ restored: string[] }> {
  const { status, data } = await call<{ restored: string[] }>("POST", `/trash/${id(noteId)}/restore`, {});
  if (status === 207) throw new PagesRequestError(207, "partial_restore", "Some pages were restored. Try again to finish.", data);
  return { restored: data.restored ?? [] };
}

export async function deleteFromTrash(noteId: string): Promise<{ deleted: string[] }> {
  const { status, data } = await call<{ deleted: string[] }>("DELETE", `/trash/${id(noteId)}`);
  if (status === 207) throw new PagesRequestError(207, "partial_delete", "Some pages were deleted. Try again to finish.", data);
  return { deleted: data.deleted ?? [] };
}

export async function getPreferences(): Promise<PreferencesSnapshot> {
  return (await call<PreferencesSnapshot>("GET", `/me/preferences`)).data;
}

export async function savePreferences(preferences: PagePreferences, ifRevision?: number): Promise<PreferencesSnapshot> {
  return (await call<PreferencesSnapshot>("PUT", `/me/preferences`, { preferences, ...(ifRevision !== undefined ? { ifRevision } : {}) })).data;
}
