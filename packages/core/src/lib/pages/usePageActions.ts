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
import { LOCK_KEY, ORDER_KEY, PAGE_STYLE_KEY, TEMPLATES_FOLDER, PagesRequestError, duplicateCopy, duplicateSummary, templateSource, referencesAttachments, copyFilesNotice, isContainerPath, isLocked, isTrashed, isUnder, pageStyleOf, pageTitle, type MoveResult } from "./model";
import { editorSaveState, flushPendingSaves } from "../../app/hooks/useAutoSave";
import { useCollabSharing } from "../../data/CollabSharing";
import { registeredEditor } from "../agent/documentSnapshots";
import * as ops from "./ops";
import { syncStoredTitle, TITLE_NOT_UPDATED } from "./titleRename";
import { usePagesUI, type PageRef } from "./store";
import { pageLink } from "./pageLink";

const HTMLISH = /^\s*<(p|h[1-6]|ul|ol|div|blockquote|pre|table|section|article|figure|hr)\b/i;

export { pageLink };

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

/** One id per Duplicate click: the server finishes THAT copy when it is sent again. */
const newRequestId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `dup-${c?.randomUUID ? c.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`}`;
};

export function usePageActions() {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  const ui = usePagesUI;
  const toast = (message: string, extra?: { tone?: "info" | "error"; action?: { label: string; run: () => void }; secondary?: { label: string; run: () => void } }) =>
    ui.getState().showToast({ message, ...extra });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
  const fail = (e: unknown, fallback: string) => toast(ops.pageErrorText(e, fallback), { tone: "error" });
  const sharing = useCollabSharing();
  /** The signed-in account (null where the shell has no viewer read, or it failed). */
  const viewerEmail = async (): Promise<string | null> => {
    try {
      return (await sharing?.getViewer?.())?.email ?? null;
    } catch {
      return null;
    }
  };
  const isPathTaken = (e: unknown): boolean => e instanceof Error && /\b409\b/.test(e.message);

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

  /** The tree's Rename when the file name already says the typed name as far as a path can: only the stored title changes. */
  const retitle = async (page: PageRef, typed: string): Promise<boolean> => {
    try {
      const fresh = await client.getNote(page.id, { fresh: true });
      if (!fresh?.path) return false;
      const outcome = await syncStoredTitle(client, fresh, fresh.path, typed);
      if (outcome === "failed") { toast(TITLE_NOT_UPDATED, { tone: "error" }); return false; }
      if (outcome === "written") void queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
      return outcome === "written";
    } catch (e) {
      fail(e, "Couldn’t rename this page. Try again.");
      return false;
    }
  };

  const move = async (page: PageRef, to: { parent?: string; newPath?: string; moveId?: string; /** A rename: the name as it was TYPED (kept as the stored title when the path cannot hold it). */ title?: string }): Promise<"moved" | "partial" | false> => {
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
      // A rename (the tree's Rename): a stored title would keep the old name in every list (NP-DB-20).
      if ((await syncStoredTitle(client, fresh, result.path, to.title)) === "failed") toast(TITLE_NOT_UPDATED, { tone: "error" });
      if (result.ok) {
        const leaf = result.path.split("/").pop();
        // A container-named page (`<folder>/PROJECT`) keeps the name it is shown by; its file name is not a title.
        if (leaf) useUIStore.getState().renameTab(page.id, isContainerPath(result.path) ? page.title : leaf);
        ui.getState().reveal(result.path.includes("/") ? result.path.slice(0, result.path.lastIndexOf("/")) : result.path);
      }
      return await finishMove(page, result);
    } catch (e) {
      fail(e, "Couldn’t move this page. Nothing was changed.");
      return false;
    }
  };

  // ── Duplicate (NP-PG-18) ───────────────────────────────────────────────────
  /** Shells without the server route (the legacy desktop): the ONE page is copied on
   *  the device, as before — and the toast says so when it has sub-pages. */
  const duplicateSingle = async (page: PageRef, opts: { keepPrivate?: boolean } = {}) => {
    try {
      const [note, tree] = await Promise.all([client.getNote(page.id, { fresh: true }), client.listTree()]);
      // A private page's duplicate stays private — to the person duplicating it.
      // `keepPrivate`: the server could not make this copy itself, so nothing here can tell
      // who the copy would reach (its tags may publish it) — it is made private, and said so.
      const priv = opts.keepPrivate || note.metadata?.prism_visibility === "private";
      const limited = Array.isArray((note as Note & { _caps?: string[] })._caps);
      const creator = priv && !limited ? await viewerEmail() : null;
      if (opts.keepPrivate && !limited && !creator) {
        toast("Couldn’t duplicate this page: your account couldn’t be confirmed, so the copy could not be kept private. Nothing was changed.", { tone: "error" });
        return;
      }
      const copy = duplicateCopy(note, tree.map((t) => t.path), { creator });
      if (opts.keepPrivate) {
        copy.metadata.prism_visibility = "private";
        if (creator) copy.metadata.prism_creator = creator;
      }
      const created = await client.createNote(copy);
      // The copy gets its OWN files (before it opens): until then its links name the
      // original page's attachments, which only people who can see the original load.
      let filesNote = "";
      if (client.copyAttachments && referencesAttachments(copy)) filesNote = copyFilesNotice(await client.copyAttachments(created.id).catch(() => null));
      await refresh();
      useUIStore.getState().openTab(created.id, pageTitle(created.path ?? copy.path), inferContentType(created));
      const left = note.path ? tree.filter((t) => isUnder(t.path, note.path!) && !isTrashed(t)).length : 0;
      toast(`Duplicated “${page.title}”${opts.keepPrivate ? ". The copy is private to you" : ""}${left ? `. Its ${left === 1 ? "sub-page was" : `${left} sub-pages were`} not copied` : ""}${filesNote ? `. ${filesNote}` : ""}`);
    } catch (e) {
      fail(e, "Couldn’t duplicate this page.");
    }
  };

  /** Move a finished (or half-finished) copy to the Trash: the root takes its group with it. */
  const undoDuplicate = async (copyId: string, title: string) => {
    try {
      const { trashed } = await ops.trashPage(client, copyId);
      for (const id of trashed.length ? trashed : [copyId]) useUIStore.getState().closeTabs(id);
      await refresh();
      toast(`Moved the copy of “${title}” to Trash`);
    } catch (e) {
      fail(e, "Couldn’t undo the duplicate. The copy is still there.");
    }
  };

  /**
   * The page AND its sub-pages, copied by the server in one retryable request
   * (`requestId`): "Finish" after a partial copy sends the same id again and can
   * never make a second copy; "Undo" moves the whole copy to the Trash.
   */
  const duplicateTree = async (page: PageRef, request: { requestId: string; confirmShared?: boolean }): Promise<void> => {
    const again = (extra: { confirmShared?: boolean } = {}) => void duplicateTree(page, { ...request, ...extra });
    try {
      // Unsaved typing goes in first, so the copy holds what is on screen.
      await flushPendingSaves(page.id).catch(() => {});
      // A large group takes a while: say what is happening until the answer is in.
      const below = (await client.listTree().catch(() => [])).filter((t) => {
        const self = t.id === page.id;
        return !self && !!page.path && isUnder(t.path, page.path) && !isTrashed(t);
      }).length;
      if (below >= 10) toast(`Duplicating “${page.title}” and its ${below} sub-pages…`);
      const result = await client.duplicatePage!(page.id, request);
      // Files the server did not get to within its budget: the existing per-page route.
      let filesNote = result.filesFailed ? "Some files were not copied." : "";
      for (const id of result.filesPending) {
        const note = copyFilesNotice(client.copyAttachments ? await client.copyAttachments(id).catch(() => null) : null);
        if (note) filesNote = "Some files were not copied.";
      }
      await refresh();
      if (!result.ok) {
        toast(`Copied ${result.created} of ${result.created + result.remaining} pages of “${page.title}”.`, {
          tone: "error",
          action: { label: "Finish", run: () => again() },
          secondary: { label: "Undo", run: () => void undoDuplicate(result.id, page.title) },
        });
        return;
      }
      const title = result.title || pageTitle(result.path);
      ui.getState().reveal(result.path.includes("/") ? result.path.slice(0, result.path.lastIndexOf("/")) : result.path);
      const opened = await client.getNote(result.id).catch(() => null);
      useUIStore.getState().openTab(result.id, title, opened ? inferContentType(opened) : "document");
      toast(`${duplicateSummary(page.title, result)}${filesNote ? `. ${filesNote}` : ""}`, { action: { label: "Undo", run: () => void undoDuplicate(result.id, page.title) } });
    } catch (e) {
      if (e instanceof PagesRequestError && e.code === "confirm_shared") {
        toast(e.message, { action: { label: "Duplicate", run: () => again({ confirmShared: true }) } });
        return;
      }
      // A server from before this route: the vault (owner) answers a plain 404/405.
      if (e instanceof PagesRequestError && (e.status === 405 || e.status === 501 || (e.status === 404 && e.code !== "not_found"))) return duplicateSingle(page);
      // A page with no location has no "beside": the one page is copied here, as before.
      if (e instanceof PagesRequestError && e.code === "no_path") return duplicateSingle(page, { keepPrivate: true });
      // No answer, a server error or "busy": the copy may exist in part or still be running.
      // Never "nothing was changed" — and the retry is THIS request (same id), so it can
      // only finish that copy, never start a second one.
      const status = e instanceof PagesRequestError ? e.status : 0;
      const unknown = !(e instanceof PagesRequestError) || status === 0 || status >= 500 || e.code === "busy" || e.code === "offline";
      if (unknown) {
        toast(`Couldn’t confirm the copy of “${page.title}”. The copy may still be running — finish it in a moment.`, { tone: "error", action: { label: "Finish", run: () => again() } });
        return;
      }
      fail(e, "Couldn’t duplicate this page. Nothing was changed.");
    }
  };

  const duplicate = (page: PageRef): Promise<void> =>
    client.duplicatePage ? duplicateTree(page, { requestId: newRequestId() }) : duplicateSingle(page);

  return {
    move,
    retitle,
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

    duplicate,

    /**
     * NP-TX-01 "Save as template": the page's body, icon, cover, properties and tags
     * become a note tagged `template` — what the New page chooser and the Templates
     * gallery list. The original is not changed. A LIVE page's body comes from its
     * editor (the vault copy lags it); a plain page's unsaved typing is saved first.
     */
    saveAsTemplate: async (page: PageRef) => {
      try {
        const open = registeredEditor(page.id);
        if (!open?.live) await flushPendingSaves(page.id).catch(() => {});
        const [note, tree] = await Promise.all([client.getNote(page.id, { fresh: true }), client.listTree()]);
        const content = open?.live ? open.editor.getHTML() : note.content;
        // 🔒 A template is PRIVATE to the person who saves it and carries no source tag
        // (`templateSource`), and it always goes to the Templates folder — never beside
        // the page, where it would inherit whoever the page's parent is shared with.
        // A member's creator is stamped by the server; an owner/admin's is sent here.
        const limited = Array.isArray((note as Note & { _caps?: string[] })._caps);
        const creator = limited ? null : await viewerEmail();
        if (!limited && !creator) {
          toast("Couldn’t save this page as a template: your account couldn’t be confirmed, so it could not be kept private. Nothing was changed.", { tone: "error" });
          return null;
        }
        const name = pageTitle(note.path) || page.title || "Untitled";
        const build = (label: string) => templateSource({ content, metadata: note.metadata, tags: note.tags }, label, TEMPLATES_FOLDER, tree.map((t) => t.path), { creator });
        let template = build(name);
        let created: Note;
        try {
          created = await client.createNote(template);
        } catch (e) {
          // The name is held by a template this person cannot see: one retry under a distinct name.
          if (!isPathTaken(e)) throw e;
          template = build(`${name} ${Date.now().toString(36).slice(-4)}`);
          created = await client.createNote(template);
        }
        let filesNote = "";
        if (client.copyAttachments && referencesAttachments(template)) filesNote = copyFilesNotice(await client.copyAttachments(created.id).catch(() => null));
        await refresh();
        toast(`Saved “${name}” as a template${filesNote ? `. ${filesNote}` : ""}`, { action: { label: "Templates", run: () => ui.getState().openTemplates(true) } });
        return created;
      } catch (e) {
        fail(e, "Couldn’t save this page as a template. Nothing was changed.");
        return null;
      }
    },

    toggleLock: async (note: Pick<Note, "id" | "metadata" | "path">) => {
      const locked = isLocked(note);
      try {
        // Typing that has not been saved yet goes in BEFORE the lock: once locked the
        // server refuses a content write from everyone, the owner included.
        // If that save does not land, the page is NOT locked (the typing would be stranded).
        if (!locked) {
          let flushed = true;
          await flushPendingSaves(note.id).catch(() => { flushed = false; });
          const state = editorSaveState(note.id);
          // A save the server did not take may sit in this device's queue ("saved on this
          // device"): it would be refused once the page is locked, so it counts as unsaved.
          // THIS page's queue only: an unsent change to another page is no reason not to lock this one.
          const unsent = client.hasPendingWritesFor
            ? await client.hasPendingWritesFor(note.id).catch(() => false)
            : ((await client.hasPendingWrites?.().catch(() => false)) ?? false);
          if (!flushed || unsent || state === "failed" || state === "dirty" || state === "parked") {
            toast("Your latest changes couldn’t be saved, so the page was not locked. Check the save state and try again.", { tone: "error" });
            return;
          }
        }
        await ops.setPageMeta(client, note.id, { [LOCK_KEY]: !locked });
        await queryClient.invalidateQueries({ queryKey: queryKeys.vault.note(note.id) });
        toast(locked ? "Page unlocked — anyone with edit access can change it." : "Page locked — editing is off until it’s unlocked.");
      } catch (e) {
        fail(e, locked ? "Couldn’t unlock this page." : "Couldn’t lock this page.");
      }
    },

    /** NP-PG-08: small text / full width, stored on the page (CAS, live-doc safe). */
    setPageStyle: async (note: Pick<Note, "id" | "metadata">, patch: { small?: boolean; full?: boolean }) => {
      const current = pageStyleOf(note);
      const next = { small: patch.small ?? current.small === true, full: patch.full ?? current.full === true };
      try {
        await ops.setPageMeta(client, note.id, { [PAGE_STYLE_KEY]: next });
        await queryClient.invalidateQueries({ queryKey: queryKeys.vault.note(note.id) });
      } catch (e) {
        fail(e, "Couldn’t change this page’s style.");
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
