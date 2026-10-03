/**
 * Every page action the sidebar, the page `⋯` menu and the phone sheet share:
 * Trash (with Undo), restore, delete permanently, move (with resume), reorder,
 * duplicate, lock, copy link and export. One implementation, three entry points.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { useUIStore } from "../../app/stores/ui";
import { queryKeys } from "../parachute/queries";
import { convertApi } from "../parachute/client";
import { inferContentType } from "../schemas/content-types";
import type { Note } from "../types";
import { LOCK_KEY, ORDER_KEY, duplicateCopy, isLocked, pageTitle, type MoveResult } from "./model";
import * as ops from "./ops";
import { usePagesUI, type PageRef } from "./store";

const HTMLISH = /^\s*<(p|h[1-6]|ul|ol|div|blockquote|pre|table|section|article|figure|hr)\b/i;

/** The shareable in-app address of a page (a client route: `/page/<id>`). */
export const pageLink = (id: string): string => {
  // Prism Client: the app origin is the Tauri shell; a shareable link names the SERVER.
  const host = typeof window !== "undefined" ? (window as unknown as { __PRISM_HOST__?: { apiOrigin?: string } }).__PRISM_HOST__ : undefined;
  const origin = host?.apiOrigin && /^https?:\/\//.test(host.apiOrigin) ? host.apiOrigin.replace(/\/+$/, "") : typeof location !== "undefined" ? location.origin : "";
  return `${origin}/page/${encodeURIComponent(id)}`;
};

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-");
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function usePageActions() {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  const ui = usePagesUI;
  const toast = (message: string, extra?: { tone?: "info" | "error"; action?: { label: string; run: () => void } }) =>
    ui.getState().showToast({ message, ...extra });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
  const fail = (e: unknown, fallback: string) => toast(ops.pageErrorText(e, fallback), { tone: "error" });

  const restore = async (page: PageRef) => {
    try {
      await ops.restoreFromTrash(client, page.id);
      await refresh();
      toast(`Restored “${page.title}”`, { action: { label: "Open", run: () => useUIStore.getState().openTab(page.id, page.title, "document") } });
      return true;
    } catch (e) {
      fail(e, "Couldn’t restore this page. It’s still in the Trash.");
      return false;
    }
  };

  /** "moved" | "partial" (some pages moved; a toast offers to finish) | false (nothing changed). */
  const finishMove = async (page: PageRef, result: MoveResult): Promise<"moved" | "partial"> => {
    await refresh();
    if (result.ok) {
      toast(`Moved “${page.title}”`);
      return "moved";
    }
    const resume = result.partial!.resume;
    toast(`Part of “${page.title}” moved. ${result.partial!.remaining} page${result.partial!.remaining === 1 ? "" : "s"} still need moving.`, {
      tone: "error",
      action: { label: "Finish move", run: () => void move(page, { moveId: resume.moveId }) },
    });
    return "partial";
  };

  const move = async (page: PageRef, to: { parent?: string; newPath?: string; moveId?: string }): Promise<"moved" | "partial" | false> => {
    try {
      // The page's own write is CAS against what the server has NOW (a stale tab
      // must not move a page someone just renamed); descendants are CAS server-side.
      // Resume too: the server binds it to the page as it stands NOW (CAS).
      const fresh = await client.getNote(page.id, { fresh: true });
      const result = await ops.movePage(client, page.id, {
        ...(to.newPath !== undefined ? { newPath: to.newPath } : { newParentPath: to.parent ?? "" }),
        ...(fresh?.updatedAt ? { ifUpdatedAt: fresh.updatedAt } : {}),
        ...(to.moveId ? { moveId: to.moveId } : {}),
      });
      if (result.ok) {
        const leaf = result.path.split("/").pop();
        if (leaf) useUIStore.getState().renameTab(page.id, leaf);
        ui.getState().reveal(result.path.includes("/") ? result.path.slice(0, result.path.lastIndexOf("/")) : result.path);
      }
      return await finishMove(page, result);
    } catch (e) {
      fail(e, "Couldn’t move this page. Nothing was changed.");
      return false;
    }
  };

  return {
    move,
    restore,

    trash: async (page: PageRef) => {
      try {
        const { trashed } = await ops.trashPage(client, page.id);
        for (const id of trashed.length ? trashed : [page.id]) useUIStore.getState().closeTabs(id);
        await refresh();
        const extra = trashed.length > 1 ? ` and ${trashed.length - 1} page${trashed.length === 2 ? "" : "s"} inside` : "";
        toast(`Moved “${page.title}”${extra} to Trash`, { action: { label: "Undo", run: () => void restore(page) } });
        return true;
      } catch (e) {
        fail(e, "Couldn’t move this page to Trash. Nothing was changed.");
        return false;
      }
    },

    deleteForever: async (page: PageRef) => {
      try {
        const { deleted } = await ops.deleteFromTrash(client, page.id);
        for (const id of deleted) useUIStore.getState().closeTabs(id);
        await refresh();
        toast(`Deleted “${page.title}” permanently`);
        return true;
      } catch (e) {
        fail(e, "Couldn’t delete this page. It’s still in the Trash.");
        return false;
      }
    },

    /** Persist a sidebar position (fractional order key) for one page. */
    reorder: async (page: PageRef, order: number) => {
      try {
        await ops.setPageMeta(client, page.id, { [ORDER_KEY]: order });
        await refresh();
      } catch (e) {
        fail(e, "Couldn’t save the new order.");
      }
    },

    duplicate: async (page: PageRef) => {
      try {
        const [note, tree] = await Promise.all([client.getNote(page.id, { fresh: true }), client.listTree()]);
        const copy = duplicateCopy(note, tree.map((t) => t.path));
        const created = await client.createNote(copy);
        await refresh();
        useUIStore.getState().openTab(created.id, pageTitle(created.path ?? copy.path), inferContentType(created));
        toast(`Duplicated “${page.title}”`);
      } catch (e) {
        fail(e, "Couldn’t duplicate this page.");
      }
    },

    toggleLock: async (note: Pick<Note, "id" | "metadata" | "path">) => {
      const locked = isLocked(note);
      try {
        await ops.setPageMeta(client, note.id, { [LOCK_KEY]: !locked });
        await queryClient.invalidateQueries({ queryKey: queryKeys.vault.note(note.id) });
        toast(locked ? "Page unlocked — anyone with edit access can change it." : "Page locked — editing is off until it’s unlocked.");
      } catch (e) {
        fail(e, locked ? "Couldn’t unlock this page." : "Couldn’t lock this page.");
      }
    },

    copyLink: async (page: PageRef) => {
      const link = pageLink(page.id);
      try {
        await navigator.clipboard.writeText(link);
        toast("Link copied");
      } catch {
        toast(`Copy this link: ${link}`);
      }
    },

    exportPage: async (page: PageRef, format: "markdown" | "html") => {
      const shell = (window as unknown as { __PRISM_SHELL__?: { exportNote?: unknown } }).__PRISM_SHELL__;
      if (typeof shell?.exportNote === "function") {
        // Prism Client: the native save panel (apps/web/src/native/extras.ts) exports the ACTIVE note.
        useUIStore.getState().openTab(page.id, page.title, "document");
        window.dispatchEvent(new CustomEvent("prism:export-note", { detail: { format } }));
        return;
      }
      try {
        const note = await client.getNote(page.id);
        const content = note.content ?? "";
        const html = HTMLISH.test(content);
        const title = pageTitle(note.path) || page.title;
        if (format === "markdown") {
          download(`${title}.md`, html ? await convertApi.htmlToMarkdown(content) : content, "text/markdown;charset=utf-8");
        } else {
          const body = html ? content : await convertApi.markdownToHtml(content);
          const esc = title.replace(/[<&>"]/g, (c) => `&#${c.charCodeAt(0)};`);
          download(`${title}.html`, `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc}</title></head><body>\n<h1>${esc}</h1>\n${body}\n</body></html>\n`, "text/html;charset=utf-8");
        }
        toast(`Exported “${title}”`);
      } catch (e) {
        fail(e, "Couldn’t export this page.");
      }
    },
  };
}
