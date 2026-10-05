import { useEffect, useRef, useState } from "react";
import { PageIconView } from "../../lib/pages/PageIconView";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutTemplate, X } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useCollabSharing } from "../../data/CollabSharing";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { TEMPLATE_TAG, leafName, pageTitle, parentOf, protectionReason, withoutTrashed } from "../../lib/pages/model";
import * as ops from "../../lib/pages/ops";
import { usePagesUI, type PageRef } from "../../lib/pages/store";
import { pageIconOf } from "../../lib/pages/iconStore";
import { queryKeys } from "../../lib/parachute/queries";
import type { Note } from "../../lib/types";
import "./pages.css";

type Row = Note & { _caps?: string[] };

export const templateName = (n: Pick<Note, "path" | "metadata">): string =>
  typeof n.metadata?.title === "string" && n.metadata.title.trim() ? n.metadata.title.trim() : pageTitle(n.path);

const edited = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `Edited ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
};

/**
 * NP-TX-01 — the Templates gallery: every page template the viewer can see (notes
 * tagged `template`, the list the New page chooser reads), with Use, Edit, Rename
 * and Delete. Delete is a move to the Trash with Undo. Opened from the chooser
 * ("Manage templates…") and the command bar ("Templates").
 *
 * Database row templates are a different thing (they live inside their database
 * and are managed from its "New" menu); they are never listed here.
 */
export function TemplatesGallery({ onClose }: { onClose: () => void }) {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = JSON.stringify([audience, client.scope?.() ?? null]);
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; tone?: "error"; undo?: PageRef } | null>(null);
  const pendingUndo = useRef<PageRef | null>(null);
  // Who is looking: decides "Private to you" and whether the share toggle is offered.
  const sharing = useCollabSharing();
  const viewer = useQuery({ queryKey: ["viewer-role", client.scope?.() ?? audience], enabled: !!sharing?.getViewer, queryFn: () => sharing!.getViewer!(), staleTime: 5 * 60_000, retry: 1 });
  const me = viewer.data?.email?.toLowerCase() ?? null;
  // One rename per commit: Enter and the field's blur can both fire for the same edit.
  const renameSent = useRef<string | null>(null);
  const templates = useQuery({
    queryKey: ["vault", "templates", "gallery", scope],
    queryFn: async () => (withoutTrashed(await client.listNotes({ tag: TEMPLATE_TAG })) as Row[]).filter((n) => n.tags?.includes(TEMPLATE_TAG)),
    retry: false,
    staleTime: 0,
  });
  const rows = [...(templates.data ?? [])].sort((a, b) => templateName(a).localeCompare(templateName(b)));

  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    node?.showModal();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      // A Trash move made here stays undoable after the gallery closes.
      const undo = pendingUndo.current;
      if (undo) {
        usePagesUI.getState().showToast({
          message: `Moved “${undo.title}” to Trash`,
          action: { label: "Undo", run: () => void ops.restoreFromTrash(client, undo.id).then(() => queryClient.invalidateQueries({ queryKey: queryKeys.vault.all }), () => usePagesUI.getState().showToast({ message: "Couldn’t restore this template. It’s still in the Trash.", tone: "error" })) },
        });
      }
    };
  }, [client, queryClient]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
  };
  const ref = (n: Row): PageRef => ({ id: n.id, path: n.path, title: templateName(n) });
  const focusRow = (index: number, action = "use") => {
    requestAnimationFrame(() => {
      const items = list.current?.querySelectorAll<HTMLElement>("[data-template-row]");
      if (!items?.length) { dialog.current?.querySelector<HTMLElement>("[data-gallery-close]")?.focus(); return; }
      const row = items[Math.max(0, Math.min(index, items.length - 1))]!;
      (row.querySelector<HTMLElement>(`[data-action="${action}"]:not(:disabled)`) ?? row.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
    });
  };

  const use = (n: Row) => {
    onClose();
    usePagesUI.getState().openCreate({ use: { id: n.id, title: templateName(n) } });
  };
  const edit = (n: Row) => {
    onClose();
    useUIStore.getState().openTab(n.id, templateName(n), inferContentType(n));
  };
  const remove = async (n: Row, index: number) => {
    const page = ref(n);
    setBusy(n.id);
    try {
      const { trashed } = await ops.trashPage(client, n.id);
      for (const id of trashed.length ? trashed : [n.id]) useUIStore.getState().closeTabs(id);
      await refresh();
      pendingUndo.current = page;
      setNotice({ message: `Moved “${page.title}” to Trash.`, undo: page });
      focusRow(index);
    } catch (e) {
      setNotice({ message: ops.pageErrorText(e, "Couldn’t delete this template. Nothing was changed."), tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const undo = async (page: PageRef) => {
    setBusy(page.id);
    try {
      await ops.restoreFromTrash(client, page.id);
      pendingUndo.current = null;
      await refresh();
      setNotice({ message: `Restored “${page.title}”.` });
    } catch (e) {
      setNotice({ message: ops.pageErrorText(e, "Couldn’t restore this template. It’s still in the Trash."), tone: "error", undo: page });
    } finally {
      setBusy(null);
    }
  };
  /** 🔒 Sharing a template is a deliberate act: it is private until someone says otherwise. */
  const setShared = async (n: Row, shared: boolean) => {
    if (!me) return;
    setBusy(n.id);
    try {
      const fresh = await client.getNote(n.id, { fresh: true });
      await client.updateNote(n.id, {
        metadata: shared ? { prism_visibility: null } : { prism_visibility: "private", prism_creator: me },
        ...(fresh.updatedAt ? { ifUpdatedAt: fresh.updatedAt } : {}),
      });
      await refresh();
      setNotice({ message: shared ? `“${templateName(n)}” is now shared with the workspace.` : `“${templateName(n)}” is private to you again.` });
    } catch (e) {
      setNotice({ message: ops.pageErrorText(e, "Couldn’t change who can use this template. Nothing was changed."), tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const rename = async (n: Row, index: number) => {
    const token = `${n.id}\u0000${renaming?.value ?? ""}`;
    if (!renaming || renaming.id !== n.id || renameSent.current === token) return;
    renameSent.current = token;
    const name = (renaming?.value ?? "").split("/").join("-").trim().slice(0, 200);
    setRenaming(null);
    if (!name || name === templateName(n)) { focusRow(index, "rename"); return; }
    setBusy(n.id);
    try {
      // The name people see is the template's title; the file follows when it can
      // (a move the server refuses — e.g. a name already taken — leaves the title changed).
      const fresh = await client.getNote(n.id, { fresh: true });
      const updated = await client.updateNote(n.id, { metadata: { title: name }, ...(fresh.updatedAt ? { ifUpdatedAt: fresh.updatedAt } : {}) });
      if (fresh.path && leafName(fresh.path) !== name) {
        const parent = parentOf(fresh.path);
        await ops.movePage(client, n.id, { newPath: (parent ? `${parent}/` : "") + name, ...(updated?.updatedAt ? { ifUpdatedAt: updated.updatedAt } : {}) }).catch(() => null);
      }
      useUIStore.getState().renameTab(n.id, name);
      await refresh();
      setNotice({ message: `Renamed to “${name}”.` });
    } catch (e) {
      setNotice({ message: ops.pageErrorText(e, "Couldn’t rename this template. Nothing was changed."), tone: "error" });
    } finally {
      setBusy(null);
      focusRow(index, "rename");
    }
  };

  /** ↑/↓/Home/End move between templates, keeping the same action in focus. */
  const onListKey = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || (e.target as HTMLElement).tagName === "INPUT") return;
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-template-row]") ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const at = items.findIndex((row) => row.contains(active));
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
    focusRow(next, active?.dataset.action ?? "use");
  };

  return (
    <dialog
      ref={dialog}
      className="page-dialog templates-gallery"
      aria-labelledby="templates-title"
      aria-describedby="templates-about"
      onCancel={(e) => {
        e.preventDefault();
        if (renaming) setRenaming(null);
        else onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="page-dialog-inner">
        <div className="page-dialog-head">
          <div className="min-w-0">
            <h2 id="templates-title">Templates</h2>
            <p id="templates-about">Start a new page from one, or change what a template holds.</p>
          </div>
          <button type="button" data-gallery-close className="page-dialog-close focus-ring" aria-label="Close Templates" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {notice && (
          <div className="templates-notice" role={notice.tone === "error" ? "alert" : "status"} data-tone={notice.tone ?? "info"}>
            <span>{notice.message}</span>
            {notice.undo && !notice.tone && (
              <button type="button" className="trash-action focus-ring" disabled={busy === notice.undo.id} onClick={() => void undo(notice.undo!)}>
                Undo
              </button>
            )}
          </div>
        )}
        <div ref={list} className="page-dialog-list" role="list" aria-label="Templates" onKeyDown={onListKey}>
          {templates.isLoading && <p className="page-dialog-empty">Loading templates…</p>}
          {templates.isError && (
            <div role="alert" className="page-dialog-empty">
              <strong>Couldn’t load templates</strong>
              {ops.pageErrorText(templates.error, "Check your connection and try again.")}{" "}
              <button type="button" className="underline" onClick={() => void templates.refetch()}>
                Try again
              </button>
            </div>
          )}
          {templates.isSuccess && !rows.length && (
            <div className="page-dialog-empty">
              <LayoutTemplate size={22} style={{ margin: "0 auto 10px", color: "var(--text-muted)" }} aria-hidden="true" />
              <strong>No templates yet</strong>
              Open a page you want to reuse and choose “Save as template” in its ⋯ menu.
            </div>
          )}
          {rows.map((n, index) => {
            const name = templateName(n);
            const icon = pageIconOf(n.metadata?.icon);
            const caps = n._caps;
            const canEdit = !caps || caps.includes("edit");
            const canDelete = (!caps || caps.includes("delete")) && !protectionReason(n);
            const editing = renaming?.id === n.id;
            const isPrivate = n.metadata?.prism_visibility === "private";
            const creator = typeof n.metadata?.prism_creator === "string" ? n.metadata.prism_creator.toLowerCase() : null;
            const mine = !!me && (creator === me || (n as Row & { _creator?: { me?: boolean } })._creator?.me === true);
            // Only someone who may change a page's visibility (no caps on the read = owner/admin) is offered the toggle.
            const canShare = !caps && !!me && (!isPrivate || mine || !creator);
            return (
              <div key={n.id} role="listitem" data-template-row={n.id} className="template-row" aria-label={name}>
                <span className="template-row-icon" aria-hidden="true">{icon ? <PageIconView value={icon} fallback={<LayoutTemplate size={16} />} /> : <LayoutTemplate size={16} />}</span>
                <div className="trash-row-main">
                  {editing ? (
                    <input
                      autoFocus
                      aria-label={`New name for ${name}`}
                      className="template-rename focus-ring"
                      value={renaming.value}
                      maxLength={200}
                      onChange={(e) => setRenaming({ id: n.id, value: e.target.value })}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void rename(n, index); }
                        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); focusRow(index, "rename"); }
                      }}
                      onBlur={() => { if (renaming?.id === n.id) void rename(n, index); }}
                    />
                  ) : (
                    <div className="label">{name}</div>
                  )}
                  <div className="crumb">{[isPrivate ? (mine ? "Private to you" : "Private to its creator") : "Shared with the workspace", edited(n.updatedAt)].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="template-row-actions">
                  <button type="button" data-action="use" className="trash-action focus-ring" data-primary="true" aria-label={`Use ${name}`} disabled={busy === n.id} onClick={() => use(n)}>
                    Use
                  </button>
                  <button type="button" data-action="edit" className="trash-action focus-ring" aria-label={`Edit ${name}`} disabled={busy === n.id} onClick={() => edit(n)}>
                    Edit
                  </button>
                  {canEdit && (
                    <button type="button" data-action="rename" className="trash-action focus-ring" aria-label={`Rename ${name}`} disabled={busy === n.id || editing} onClick={() => { renameSent.current = null; setRenaming({ id: n.id, value: name }); }}>
                      Rename
                    </button>
                  )}
                  {canShare && (
                    <button type="button" data-action="share" className="trash-action focus-ring" aria-pressed={!isPrivate}
                      aria-label={isPrivate ? `Share ${name} with the workspace` : `Make ${name} private`} disabled={busy === n.id}
                      onClick={() => void setShared(n, isPrivate)}>
                      {isPrivate ? "Share" : "Make private"}
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" data-action="delete" className="trash-action focus-ring" data-danger="true" aria-label={`Delete ${name}`} disabled={busy === n.id} onClick={() => void remove(n, index)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="page-dialog-foot">
          Deleted templates go to the Trash. Row templates of a database are managed from that database’s New menu.
        </div>
      </div>
    </dialog>
  );
}
