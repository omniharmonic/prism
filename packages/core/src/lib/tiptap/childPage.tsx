/**
 * Sub-pages in the body (NP-PG-15). The schema node `childPage` lives in
 * editor/blocks.ts (isomorphic, stores the page id ONLY); this file is the
 * browser side:
 *  - the row view: the page's icon + title, resolved through the READER's own
 *    permissions exactly like the page mention (unviewable → "No access",
 *    trashed → "Deleted page"), a click opens the page;
 *  - `ChildPages`: the host seam — `create()` makes the sub-page (slash `/page`),
 *    pages created inside this page elsewhere (tree `+`) get a row too, and
 *    deleting a row offers to move that page to Trash.
 */
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

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Fired on `window` when a page was created somewhere in the app: `{ id, parentPath }`. */
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
  const open = () => { if (state === "ready") openTab(data!.id, noteLinkTitle(data!), inferContentType(data!)); };
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
  /** Move a page to Trash (offered when its row is deleted). Omitted → no offer. */
  trash?: (pageId: string) => Promise<unknown>;
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

/** Slash `/page`: create the sub-page, then put its row where the command ran. */
export async function createChildPage(editor: Editor): Promise<boolean> {
  const create = options(editor)?.create;
  if (!create || !structuralEditsAllowed(editor)) return false;
  const { $from } = editor.state.selection;
  const anchor = $from.depth >= 1 ? $from.before(1) : null;
  // Follow the block through edits made while the page is being created.
  let pos = anchor;
  const track = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map: (p: number, assoc?: number) => number } } }) => {
    if (pos !== null && transaction.docChanged) pos = transaction.mapping.map(pos, -1);
  };
  editor.on("transaction", track);
  try {
    const id = await create();
    return !!id && insertChildPageBlock(editor, id, pos);
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

/** A small standing offer after a row was deleted. Names no page (the reader may not see its title). */
function offerTrash(editor: Editor, ids: string[], trash: (id: string) => Promise<unknown>): () => void {
  const el = document.createElement("div");
  el.className = "prism-child-page-prompt";
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-label", "Sub-page link removed");
  const text = document.createElement("span");
  text.textContent = ids.length === 1 ? "The link is removed. Move the sub-page to Trash too?" : `${ids.length} links removed. Move those sub-pages to Trash too?`;
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "is-danger";
  yes.textContent = "Move to Trash";
  const no = document.createElement("button");
  no.type = "button";
  no.textContent = "Keep page";
  el.append(text, yes, no);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { clearTimeout(timer); el.remove(); };
  no.addEventListener("click", close);
  yes.addEventListener("click", () => {
    yes.disabled = true;
    no.disabled = true;
    // Only pages still absent from the document (an undo may have brought a row back).
    const present = editor.isDestroyed ? new Set<string>() : childPageIds(editor.state.doc);
    void Promise.allSettled(ids.filter((id) => !present.has(id)).map((id) => trash(id))).then((results) => {
      const failed = results.filter((r) => r.status === "rejected").length;
      text.textContent = failed ? "That page could not be moved to Trash." : "Moved to Trash.";
      yes.remove();
      no.remove();
      el.setAttribute("role", "status");
      timer = setTimeout(close, 2500);
    });
  });
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  document.body.appendChild(el);
  timer = setTimeout(close, 12_000);
  return close;
}

export const ChildPages = Extension.create<ChildPagesOptions>({
  name: "childPages",
  addOptions() {
    return { create: undefined, hostPath: undefined, trash: undefined };
  },
  onCreate() {
    const editor = this.editor;
    const hostPath = this.options.hostPath;
    if (!hostPath || typeof window === "undefined") return;
    const onCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; parentPath?: string }>).detail;
      const path = hostPath();
      if (!detail?.id || !path || detail.parentPath !== path || editor.isDestroyed || !structuralEditsAllowed(editor)) return;
      // At the caret's block when the editor has been used, else at the end.
      const { $from } = editor.state.selection;
      const used = editor.isFocused || editor.state.selection.from > 1;
      insertChildPageBlock(editor, detail.id, used && $from.depth >= 1 ? $from.before(1) : null);
    };
    window.addEventListener(PAGE_CREATED_EVENT, onCreated);
    (this.storage as { off?: () => void }).off = () => window.removeEventListener(PAGE_CREATED_EVENT, onCreated);
  },
  onDestroy() {
    (this.storage as { off?: () => void; closePrompt?: () => void }).off?.();
    (this.storage as { closePrompt?: () => void }).closePrompt?.();
  },
  addStorage() {
    return {} as { off?: () => void; closePrompt?: () => void };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const trash = this.options.trash;
    const storage = this.storage as { closePrompt?: () => void };
    if (!trash) return [];
    let pending: Set<string> = new Set();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return [
      new Plugin({
        key: removalKey,
        appendTransaction(transactions, oldState, newState) {
          // Local deletions only: a collaborator's change (y-sync) or history replay is not this user's decision.
          const local = transactions.filter((tr) => tr.docChanged && !tr.getMeta("y-sync$") && tr.getMeta("addToHistory") !== false);
          if (!local.length) return null;
          let touched = false;
          for (const tr of local) for (const map of tr.mapping.maps) map.forEach((from, to) => { if (to > from) touched = true; });
          if (!touched) return null;
          const before = childPageIds(oldState.doc);
          if (!before.size) return null;
          const after = childPageIds(newState.doc);
          for (const id of before) if (!after.has(id)) pending.add(id);
          if (!pending.size) return null;
          // A move is delete-then-insert: decide after the dust settles.
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (editor.isDestroyed) return;
            const now = childPageIds(editor.state.doc);
            const gone = [...pending].filter((id) => !now.has(id));
            pending = new Set();
            if (!gone.length) return;
            storage.closePrompt?.();
            storage.closePrompt = offerTrash(editor, gone, trash);
          }, 250);
          return null;
        },
      }),
    ];
  },
});
