/**
 * Sharing / review reads for the web and native shells (server:
 * apps/server/src/routes/sharing.ts). GET only, through `serverFetch` with the
 * active write context (vault, workspace, actor binding), so a cookie session and
 * a native device token both work. Errors are plain messages — never server text.
 */
import type { AccessPreview, IndexedThread, PageActivity, SharedWithMeListing } from "@prism/core/shell";
import { captureWriteContext } from "../offline/writeScope";
import { serverFetch } from "../transport";

export class SharingReadError extends Error {
  constructor(readonly status: number) {
    super(status === 404 ? "This page is not available." : status === 429 ? "Too many requests. Wait a moment and try again." : status === 0 ? "You’re offline. Reconnect and try again." : "This could not be loaded. Try again.");
  }
}

async function read<T>(path: string): Promise<T> {
  const context = await captureWriteContext();
  let resp: Response;
  try {
    resp = await serverFetch(`${context.scope.api}${path}`, { method: "GET", headers: context.headers, cache: "no-store" });
  } catch {
    throw new SharingReadError(0);
  }
  if (!resp.ok) throw new SharingReadError(resp.status);
  return (await resp.json()) as T;
}

const enc = encodeURIComponent;

export const listSharedWithMe = (): Promise<SharedWithMeListing> => read<SharedWithMeListing>("/shared-with-me");

export async function listComments(opts: { noteId?: string; unresolved?: boolean; mine?: boolean; limit?: number } = {}): Promise<IndexedThread[]> {
  const q = new URLSearchParams();
  if (opts.noteId) q.set("note", opts.noteId);
  if (opts.unresolved) q.set("unresolved", "1");
  if (opts.mine) q.set("mine", "1");
  if (opts.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return (await read<{ threads: IndexedThread[] }>(`/comments${qs ? `?${qs}` : ""}`)).threads;
}

export const getPageActivity = (noteId: string): Promise<PageActivity> => read<PageActivity>(`/notes/${enc(noteId)}/activity`);

export const getAccessPreview = (noteId: string, parentPath: string): Promise<AccessPreview> =>
  read<AccessPreview>(`/notes/${enc(noteId)}/access-preview?parent=${enc(parentPath)}`);
