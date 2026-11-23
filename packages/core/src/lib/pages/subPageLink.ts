import type { NoteTreeEntry } from "../types";
import { serverFetch } from "../transport/serverFetch";
import { isLocked, isTrashed, pageTitle, systemNoteReason } from "./model";
import { usePagesUI } from "./store";
import { flushPendingSaves } from "../../app/hooks/useAutoSave";

/**
 * NP-PG-15: a page created UNDER A PAGE is that page's sub-page, and the parent shows a row
 * for it — whichever way it was created and whether or not the parent is on screen.
 *
 *  1. `prism:page-created` is offered to the editors that are open: the one showing the parent
 *     adds the row itself (`lib/tiptap/childPage.tsx`) and sets `handled`.
 *  2. Nobody took it (the parent is not open here — the sidebar tree's "+", "Choose page type",
 *     ⌘N beside a page whose parent is closed): the row is appended to the parent's STORED body
 *     by the server, `POST /api/notes/:id/blocks/append` — through the live document when
 *     someone else has the parent open, with compare-and-set otherwise, as Markdown-safe HTML
 *     for a Markdown body. The server then links parent → sub-page as it does for any row.
 *
 * Idempotent: the request id is derived from the sub-page's id, and the server drops a row
 * for a page the parent already lists. Never for a plain folder (no page at that path), a
 * system page or a page in the Trash. A refusal (no edit access, a locked parent) never
 * undoes the create: the page exists and opens, and a notice says why it has no row.
 *
 * Tiptap-free on purpose: `quickCreate.ts` is on the shell's boot path.
 */
export const PAGE_CREATED_EVENT = "prism:page-created";
const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PENDING_KEY = "prism:offline-sublinks";

export type SubPageLink = "row" | "appended" | "present" | "no-parent" | "queued" | "refused";

/** The page a new page at `folder/<name>` is a sub-page of: the page stored AT `folder`. Null for a plain folder. */
export function parentPageAt(tree: readonly NoteTreeEntry[], folder: string | null | undefined): NoteTreeEntry | null {
  const at = (folder ?? "").replace(/^\/+|\/+$/g, "");
  if (!at) return null;
  const page = tree.find((e) => e.path === at);
  if (!page || isTrashed(page) || systemNoteReason(page)) return null;
  return page;
}

export const subPageRowHtml = (id: string): string => `<div data-type="child-page" data-page-id="${id}"></div>`;
/** One request id per (parent, sub-page): a repeat appends nothing. */
export const subPageRequestId = (childId: string): string => `subpage_${childId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

type Append = { ok: true; present: boolean } | { ok: false; status: number; code: string };

/** Ask the server to add the row. Retries what the server calls retryable (busy, not yet confirmed, a concurrent open). */
export async function appendSubPageRow(parentId: string, childId: string, waits: readonly number[] = [400, 1200, 2500]): Promise<Append> {
  let last: Append = { ok: false, status: 0, code: "offline" };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await serverFetch(`/api/notes/${encodeURIComponent(parentId)}/blocks/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: subPageRowHtml(childId), requestId: subPageRequestId(childId) }),
      });
      let body: { ok?: boolean; present?: boolean; error?: string; retry?: boolean } | null = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.status === 200 && body?.ok === true) return { ok: true, present: body.present === true };
      last = { ok: false, status: res.status, code: body?.error ?? `http_${res.status}` };
      if (!(body?.retry === true || res.status === 429 || res.status === 502 || res.status === 503)) return last;
    } catch {
      last = { ok: false, status: 0, code: "offline" };
    }
    const wait = waits[attempt];
    if (wait === undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Why the parent has no row, in the person's words. */
export function subPageRefusalText(title: string, parentTitle: string, r: { status: number; code: string }): string {
  const made = `“${title}” was created`;
  if (r.code === "locked") return `${made}. “${parentTitle}” is locked, so it has no link on that page — unlock it and add the page with /page or [[.`;
  if (r.status === 403 || r.status === 404) return `${made}. You can’t edit “${parentTitle}”, so it has no link on that page.`;
  if (r.code === "too_large" || r.code === "too_complex") return `${made}. “${parentTitle}” is too large to take another block, so it has no link on that page.`;
  if (r.status === 0) return `${made}, but “${parentTitle}” could not be reached to add its link. Add the page there with [[ when you are back online.`;
  return `${made}, but its link could not be added to “${parentTitle}”. Add the page there with [[.`;
}

const titleOf = (e: NoteTreeEntry): string => pageTitle(e.path, e.metadata) || "the parent page";

function readPending(): Record<string, { parentId: string; parentTitle: string; title: string }> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ReturnType<typeof readPending>) : {};
  } catch {
    return {};
  }
}
function writePending(next: ReturnType<typeof readPending>): void {
  try {
    const keys = Object.keys(next);
    if (!keys.length) localStorage.removeItem(PENDING_KEY);
    // Bounded: the newest 200 queued creates.
    else localStorage.setItem(PENDING_KEY, JSON.stringify(Object.fromEntries(keys.slice(-200).map((k) => [k, next[k]!]))));
  } catch {
    /* storage unavailable: the row is simply not added later (the page itself is unaffected) */
  }
}

/**
 * Step 1: offer the row to the editor that has the parent open. True when one took it — and then
 * that editor's save has been SENT before this resolves: the caller is about to open the new page
 * in its place, and a save sent as the editor goes away leaves this device's copy of the parent
 * one step behind (coming back showed the parent without the row and offered the saved row as
 * somebody else's change). One request, and only when the parent is the page on screen; a live
 * page has no pending save and this resolves at once.
 */
export async function offerRowToOpenParent(o: { id: string; folder: string | null | undefined; tree: readonly NoteTreeEntry[] }): Promise<boolean> {
  const folder = (o.folder ?? "").replace(/^\/+|\/+$/g, "");
  // A temporary (queued, offline) id is never offered to a document: a body must not store one.
  if (!folder || o.id.startsWith("offline-") || typeof window === "undefined") return false;
  const detail = { id: o.id, parentPath: folder, handled: false };
  window.dispatchEvent(new CustomEvent(PAGE_CREATED_EVENT, { detail }));
  if (!detail.handled) return false;
  const parent = parentPageAt(o.tree, folder);
  if (parent) await flushPendingSaves(parent.id).catch(() => undefined);
  return true;
}

/**
 * Step 2, when no editor took it: the server appends the row to the parent's stored body.
 * Resolves with what happened; never throws (callers `void` it — the page opens meanwhile).
 */
export async function appendRowToClosedParent(o: { id: string; title: string; folder: string | null | undefined; tree: readonly NoteTreeEntry[] }): Promise<SubPageLink> {
  const folder = (o.folder ?? "").replace(/^\/+|\/+$/g, "");
  const parent = parentPageAt(o.tree, folder);
  if (!parent || parent.id.startsWith("offline-")) return "no-parent";
  const parentTitle = titleOf(parent);
  if (o.id.startsWith("offline-")) {
    // Created offline: linked when the queued create is delivered and the page has its real id.
    writePending({ ...readPending(), [o.id]: { parentId: parent.id, parentTitle, title: o.title } });
    return "queued";
  }
  if (!PAGE_ID.test(o.id)) return "no-parent";
  // Known here already: do not ask the server for a write it will refuse.
  const r: Append = isLocked(parent) ? { ok: false, status: 409, code: "locked" } : await appendSubPageRow(parent.id, o.id);
  if (r.ok) return r.present ? "present" : "appended";
  usePagesUI.getState().showToast({ message: subPageRefusalText(o.title, parentTitle, r), tone: "error" });
  return "refused";
}

/** Both steps. Awaiting it waits for the open parent's save only; the server append runs on. */
export async function linkNewPageToParent(o: { id: string; title: string; folder: string | null | undefined; tree: readonly NoteTreeEntry[] }): Promise<void> {
  if (await offerRowToOpenParent(o)) return;
  void appendRowToClosedParent(o);
}

/** Once per app: a page created offline gets its parent's row when its create is delivered. */
export function installOfflineSubPageLinks(): () => void {
  if (typeof window === "undefined") return () => {};
  const onResolved = (event: Event) => {
    const d = (event as CustomEvent<{ temporaryId?: string; noteId?: string }>).detail;
    if (!d?.temporaryId || !d.noteId || !PAGE_ID.test(d.noteId)) return;
    const pending = readPending();
    const entry = pending[d.temporaryId];
    if (!entry) return;
    delete pending[d.temporaryId];
    writePending(pending);
    void appendSubPageRow(entry.parentId, d.noteId).then((r) => {
      if (!r.ok) usePagesUI.getState().showToast({ message: subPageRefusalText(entry.title, entry.parentTitle, r), tone: "error" });
    });
  };
  window.addEventListener("prism:offline-note-resolved", onResolved);
  return () => window.removeEventListener("prism:offline-note-resolved", onResolved);
}
