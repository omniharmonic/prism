/**
 * Sub-pages in the body (NP-PG-15). The schema node `childPage` lives in
 * editor/blocks.ts (isomorphic, stores the page id ONLY); this file is the
 * browser side:
 *  - the row view: the page's icon + title, resolved through the READER's own
 *    permissions exactly like the page mention (unviewable → "No access",
 *    trashed → "Deleted page"), a click opens the page;
 *  - `ChildPages`: the host seam — `create()` makes the sub-page (slash `/page`),
 *    pages created inside this page elsewhere (tree `+`) get a row too, and
 *    deleting a row moves that page to the Trash (with Undo) when it really is
 *    this page's own sub-page.
 */
import { openPageFromDocument } from "./openPage";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Lock, Trash2 } from "lucide-react";
import { registerBlockViews } from "../../editor/blocks";
import { queryKeys } from "../parachute/queries";
import { useUIStore } from "../../app/stores/ui";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { isAccessUnavailable } from "../../data/VaultClient";
import { isTrashed } from "../pages/model";
import { noteLinkTitle } from "../wikilinks";
import { inferContentType } from "../schemas/content-types";
import { structuralEditsAllowed } from "./blockCommands";
import { editorNotice } from "./notice";
import { SubPageError } from "./subPages";
import { parentOf } from "../pages/model";
import { usePagesUI } from "../pages/store";

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Fired on `window` when a page was created somewhere in the app: `{ id, parentPath }`. A listener that now shows the row sets `handled`. */
export const PAGE_CREATED_EVENT = "prism:page-created";

function ChildPageRow({ node, selected }: NodeViewProps) {
  const id = typeof node.attrs.pageId === "string" ? node.attrs.pageId : null;
  const client = useOptionalVaultClient();
  const query = useQuery({
    queryKey: queryKeys.vault.note(id ?? ""),
    queryFn: () => client!.getNote(id!),
    enabled: !!id && !!client,
    retry: (count, error) => !isAccessUnavailable(error) && count < 1,
  });
  const openTab = useUIStore((s) => s.openTab);
  const data = !isAccessUnavailable(query.error) && query.data && query.data.id === id ? query.data : undefined;
  const state = !id || !client ? "missing" : data ? (isTrashed(data) ? "deleted" : "ready") : query.error ? (isAccessUnavailable(query.error) ? "missing" : "error") : "loading";
  const title = state === "ready" ? noteLinkTitle(data!) : state === "deleted" ? "Deleted page" : state === "missing" ? "No access" : state === "error" ? "Page unavailable" : "Loading page…";
  const icon = state === "ready" && typeof data!.metadata?.icon === "string" ? (data!.metadata.icon as string) : null;
  const open = () => { if (state === "ready") openPageFromDocument(data!.id, () => openTab(data!.id, noteLinkTitle(data!), inferContentType(data!))); };
  return (
    <NodeViewWrapper className={`prism-child-page${selected ? " ProseMirror-selectednode" : ""}`} data-type="child-page" data-page-id={id ?? undefined} data-state={state} contentEditable={false}>
      <button
        type="button"
        className="prism-child-page-row"
        aria-disabled={state !== "ready" || undefined}
        aria-label={state === "ready" ? `Open sub-page: ${title}` : title}
        title={state === "missing" ? "You don’t have access to this page" : undefined}
        onClick={open}
      >
        <span className="prism-child-page-icon" aria-hidden="true">
          {icon ? icon : state === "missing" ? <Lock size={15} /> : state === "deleted" ? <Trash2 size={15} /> : <FileText size={16} />}
        </span>
        <span className="prism-child-page-title">{title}</span>
      </button>
    </NodeViewWrapper>
  );
}

let registered = false;
export function registerChildPageView(): void {
  if (registered || typeof document === "undefined") return;
  registered = true;
  registerBlockViews({
    // The row's own click/keyboard belong to it; drags still reach ProseMirror.
    childPage: ReactNodeViewRenderer(ChildPageRow, { stopEvent: ({ event }) => !/^drag|^drop$/.test(event.type) && event.type !== "mousedown" }),
  });
}
registerChildPageView();

export interface ChildPagesOptions {
  /** Create a sub-page of this page and return its id (null = nothing created). Omitted → `/page` is hidden. */
  create?: () => Promise<string | null>;
  /** This page's path: a page created directly inside it elsewhere (tree `+`) gets a row here. */
  hostPath?: () => string | null | undefined;
  /** Move a page to the Trash (when its row is deleted here). Never a permanent delete. Omitted → rows are only removed. */
  trash?: (pageId: string) => Promise<unknown>;
  /** Put back a page `trash` moved (the toast's Undo, or an editor undo that brings the row back). */
  restore?: (pageId: string) => Promise<unknown>;
  /**
   * The page behind a row, read with the DELETER's own access (null = they cannot view it).
   * `blocked` = why this page may not be moved to the Trash here (an integration's or a system page).
   */
  describe?: (pageId: string) => Promise<{ title: string; path: string | null; blocked?: string | null } | null>;
}

const options = (editor: Editor | null) =>
  editor?.extensionManager.extensions.find((e) => e.name === "childPages")?.options as ChildPagesOptions | undefined;

export const canCreateChildPage = (editor: Editor | null): boolean =>
  !!options(editor)?.create && !!editor?.schema.nodes.childPage && structuralEditsAllowed(editor);

/** Insert a row for `pageId` (one transaction): replaces the empty paragraph at `pos`, else goes after that block (null → the end). */
export function insertChildPageBlock(editor: Editor, pageId: string, pos: number | null): boolean {
  if (editor.isDestroyed || !structuralEditsAllowed(editor) || !PAGE_ID.test(pageId)) return false;
  const { state } = editor;
  const type = state.schema.nodes.childPage;
  if (!type || childPageIds(state.doc).has(pageId)) return false;
  const block = type.create({ pageId });
  const tr = state.tr;
  const at = pos === null ? null : Math.max(0, Math.min(pos, state.doc.content.size));
  const node = at === null ? null : state.doc.nodeAt(at);
  if (at !== null && node && node.isTextblock && node.content.size === 0) tr.replaceWith(at, at + node.nodeSize, block);
  else tr.insert(at !== null && node ? at + node.nodeSize : state.doc.content.size, block);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Offer a created page's row to the editor that has `parentPath` open now (the `ChildPages`
 * listener below answers by setting `handled`). Tried for a few seconds: a page that is
 * re-checking access has no editor for a moment.
 */
async function handOverRow(id: string, parentPath: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const detail = { id, parentPath, handled: false };
    window.dispatchEvent(new CustomEvent(PAGE_CREATED_EVENT, { detail }));
    if (detail.handled) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Slash `/page`: create the sub-page, then put its row where the command ran. */
export async function createChildPage(editor: Editor): Promise<boolean> {
  const create = options(editor)?.create;
  if (!create || !structuralEditsAllowed(editor)) return false;
  const { $from } = editor.state.selection;
  const anchor = $from.depth >= 1 ? $from.before(1) : null;
  const parentPath = options(editor)?.hostPath?.() ?? null;
  // Follow the block through edits made while the page is being created.
  let pos = anchor;
  const track = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map: (p: number, assoc?: number) => number } } }) => {
    if (pos !== null && transaction.docChanged) pos = transaction.mapping.map(pos, -1);
  };
  editor.on("transaction", track);
  try {
    const id = await create();
    // Never a temporary offline id in a document (review M2).
    if (id && id.startsWith("offline-")) throw new SubPageError("Creating a page here needs a connection. Nothing was added.");
    if (!id) return false;
    if (insertChildPageBlock(editor, id, pos)) return true;
    // The page exists, but the editor that ran the command cannot take its row any more (a live
    // page that re-checked access came back with a NEW editor): the row goes to whichever editor
    // has this page open — never a sub-page that nothing on its parent points to, silently.
    if (PAGE_ID.test(id) && parentPath && (await handOverRow(id, parentPath))) return true;
    editorNotice("The page was created, but its link could not be added here. Find it under this page in the sidebar.");
    return false;
  } catch (e) {
    editorNotice(e instanceof SubPageError ? e.message : "Couldn’t create a page here.");
    return false;
  } finally {
    editor.off("transaction", track);
  }
}

function childPageIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((n) => { if (n.type.name === "childPage" && typeof n.attrs.pageId === "string") ids.add(n.attrs.pageId); return !n.isTextblock; });
  return ids;
}

const removalKey = new PluginKey("childPageRemoval");

/**
 * "Move to another page" removes a row here because it now lives THERE: the next
 * local removal in this editor is not a deletion and must not move the page to Trash.
 */
export function suppressTrashOffer(editor: Editor): void {
  const storage = (editor.storage as unknown as Record<string, { suppressUntil?: number } | undefined>).childPages;
  if (storage) storage.suppressUntil = Date.now() + 1000;
}

/** Put a row for `pageId` back where it was (`pos`, kept current by the plugin); at the end when that place is gone. */
function restoreRow(editor: Editor, pageId: string, pos: number | undefined): boolean {
  if (editor.isDestroyed || !structuralEditsAllowed(editor)) return false;
  const { state } = editor;
  const type = state.schema.nodes.childPage;
  if (!type) return false;
  if (childPageIds(state.doc).has(pageId)) return true;
  const end = state.doc.content.size;
  let at = pos === undefined ? end : Math.max(0, Math.min(pos, end));
  const $at = state.doc.resolve(at);
  if ($at.parent.isTextblock || !$at.parent.canReplaceWith($at.index(), $at.index(), type)) at = end;
  try {
    editor.view.dispatch(state.tr.insert(at, type.create({ pageId })).scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

const quoted = (pages: Array<{ title: string }>, many: string) => (pages.length === 1 ? `“${pages[0]!.title}”` : many.replace("#", String(pages.length)));

interface ChildPagesStorage {
  off?: () => void;
  suppressUntil?: number;
  /** Pages THIS editor moved to the Trash because their row was deleted here: id → title. */
  trashed: Map<string, string>;
  /** Rows this person deleted here themselves (a redo of that deletion is theirs too). */
  deletedHere: Set<string>;
  /** Where each deleted row was, mapped through every later change. */
  removedAt: Map<string, number>;
}

export const ChildPages = Extension.create<ChildPagesOptions>({
  name: "childPages",
  addOptions() {
    return { create: undefined, hostPath: undefined, trash: undefined, describe: undefined };
  },
  onCreate() {
    const editor = this.editor;
    const hostPath = this.options.hostPath;
    if (!hostPath || typeof window === "undefined") return;
    const onCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; parentPath?: string; handled?: boolean }>).detail;
      const path = hostPath();
      if (!detail?.id || !path || detail.parentPath !== path || editor.isDestroyed || !structuralEditsAllowed(editor)) return;
      // At the caret's block when the editor has been used, else at the end.
      const { $from } = editor.state.selection;
      const used = editor.isFocused || editor.state.selection.from > 1;
      if (insertChildPageBlock(editor, detail.id, used && $from.depth >= 1 ? $from.before(1) : null) || childPageIds(editor.state.doc).has(detail.id)) detail.handled = true;
    };
    window.addEventListener(PAGE_CREATED_EVENT, onCreated);
    (this.storage as ChildPagesStorage).off = () => window.removeEventListener(PAGE_CREATED_EVENT, onCreated);
  },
  onDestroy() {
    (this.storage as ChildPagesStorage).off?.();
  },
  addStorage() {
    return { trashed: new Map(), deletedHere: new Set(), removedAt: new Map() } as ChildPagesStorage;
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { trash, restore, describe, hostPath } = this.options;
    const storage = this.storage as ChildPagesStorage;
    if (!trash || !describe || !hostPath) return [];
    const toast = usePagesUI.getState().showToast;
    let pending: Set<string> = new Set();
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** A page this editor moved to the Trash comes back (its row is on the page again, or Undo was chosen). */
    const bringBack = (id: string, withRow: boolean) => {
      const title = storage.trashed.get(id);
      if (title === undefined || !restore) return;
      storage.trashed.delete(id);
      restore(id).then(
        () => toast({ message: withRow ? `Restored “${title}”` : `Restored “${title}”. Its link was not put back on the page — find it under this page in the sidebar.` }),
        () => {
          storage.trashed.set(id, title);
          toast({ message: `Couldn’t restore “${title}”. It’s still in the Trash.`, tone: "error" });
        },
      );
    };
    /** The toast's Undo: the row goes back where it was — which is what restores the page (see `appendTransaction`). */
    const undo = (ids: string[]) => {
      // Last row first: rows deleted together share one place, and each insertion there goes in
      // front of the one before it — so they come back in their original order.
      const at = (id: string) => storage.removedAt.get(id) ?? Number.MAX_SAFE_INTEGER;
      const ordered = ids.map((id, i) => ({ id, i })).sort((a, b) => at(a.id) - at(b.id) || a.i - b.i).reverse();
      for (const { id } of ordered) if (!restoreRow(editor, id, storage.removedAt.get(id))) bringBack(id, false);
    };

    const settle = () => {
      if (editor.isDestroyed) return;
      const now = childPageIds(editor.state.doc);
      const gone = [...pending].filter((id) => !now.has(id));
      pending = new Set();
      const host = hostPath();
      if (!gone.length || !host) return;
      // Only pages that really are THIS page's direct sub-pages, read with the deleter's own
      // access (unviewable, moved elsewhere, already trashed → the row is simply removed).
      void Promise.all(gone.map((id) => describe(id).then((p) => (p && p.path && parentOf(p.path) === host ? { id, title: p.title, blocked: p.blocked ?? null } : null), () => null))).then(async (found) => {
        if (editor.isDestroyed) return;
        const still = childPageIds(editor.state.doc);
        const mine = found.filter((p): p is { id: string; title: string; blocked: string | null } => !!p && !still.has(p.id));
        if (!mine.length) return;
        const allowed = mine.filter((p) => !p.blocked);
        const results = await Promise.allSettled(allowed.map((p) => trash(p.id)));
        const moved = allowed.filter((_, i) => results[i]!.status === "fulfilled");
        const kept = [...mine.filter((p) => p.blocked), ...allowed.filter((_, i) => results[i]!.status === "rejected")];
        for (const p of moved) storage.trashed.set(p.id, p.title);
        // An undo that landed while the request was in flight: the row is back, so is the page.
        const back = editor.isDestroyed ? new Set<string>() : childPageIds(editor.state.doc);
        const stay = moved.filter((p) => !back.has(p.id));
        for (const p of moved) if (back.has(p.id)) bringBack(p.id, true);
        const keptText = kept.length
          ? kept.length === 1 && kept[0]!.blocked
            ? ` “${kept[0]!.title}” was not moved to Trash. ${kept[0]!.blocked}`
            : ` ${quoted(kept, "# sub-pages")} couldn’t be moved to Trash and ${kept.length === 1 ? "is" : "are"} still under this page in the sidebar.`
          : "";
        if (stay.length) {
          toast({
            message: `Moved ${quoted(stay, "# sub-pages")} to Trash.${keptText}`,
            ...(kept.length ? { tone: "error" as const } : {}),
            ...(restore ? { action: { label: "Undo", run: () => undo(stay.map((p) => p.id)) } } : {}),
          });
        } else if (kept.length) {
          toast({ message: `The link was removed.${keptText}`, tone: "error" });
        }
      });
    };

    return [
      new Plugin({
        key: removalKey,
        appendTransaction(transactions, oldState, newState) {
          const changed = transactions.filter((tr) => tr.docChanged);
          if (!changed.length) return null;
          // Where the deleted rows were follows every later change (the toast's Undo puts them back there).
          if (storage.removedAt.size) for (const tr of changed) for (const [id, pos] of storage.removedAt) storage.removedAt.set(id, tr.mapping.map(pos, -1));
          // This person's own changes only. A collaborator's change (y-sync) is not their decision;
          // their own undo/redo in a live page arrives through y-sync too, marked as such.
          const sync = (tr: (typeof changed)[number]) => tr.getMeta("y-sync$") as { isUndoRedoOperation?: boolean } | undefined;
          const own = changed.filter((tr) => !sync(tr) || sync(tr)!.isUndoRedoOperation);
          if (!own.length) return null;
          const before = childPageIds(oldState.doc);
          const after = childPageIds(newState.doc);
          // A row that is back (undo, or the toast's Undo): the page this editor trashed for it comes back too.
          for (const id of after) {
            if (before.has(id)) continue;
            pending.delete(id);
            storage.removedAt.delete(id);
            if (storage.trashed.has(id)) bringBack(id, true);
          }
          if (!before.size || (storage.suppressUntil ?? 0) > Date.now()) return null;
          // What counts as DELETING a row: a direct edit. Not a cut (⌘X: a move in progress), not
          // "Move to" (the row lives on another page now), not a whole-document load (a template,
          // an import, an agent's replacement: `setContent`), and not a change kept out of history.
          const replay = (tr: (typeof changed)[number]) => !!sync(tr)?.isUndoRedoOperation || tr.getMeta("history$") !== undefined;
          const direct = own.filter((tr) => !replay(tr) && tr.getMeta("addToHistory") !== false && tr.getMeta("uiEvent") !== "cut" && tr.getMeta("preventUpdate") === undefined);
          const replayed = own.some(replay);
          if (!direct.length && !replayed) return null;
          const removed = [...before].filter((id) => !after.has(id));
          if (!removed.length) return null;
          for (const id of removed) {
            // An undo/redo removes a row for many reasons (undoing the `/page` that made it): it
            // moves a page to Trash only when it replays THIS person's own deletion of that row.
            if (!direct.length && !storage.deletedHere.has(id)) continue;
            storage.deletedHere.add(id);
            pending.add(id);
            let at = -1;
            oldState.doc.descendants((n, pos) => { if (at < 0 && n.type.name === "childPage" && n.attrs.pageId === id) at = pos; return at < 0 && !n.isTextblock; });
            if (at >= 0) storage.removedAt.set(id, changed.reduce((pos, tr) => tr.mapping.map(pos, -1), at));
          }
          if (!pending.size) return null;
          // A move is delete-then-insert: decide after the dust settles.
          clearTimeout(timer);
          timer = setTimeout(settle, 250);
          return null;
        },
      }),
    ];
  },
});
