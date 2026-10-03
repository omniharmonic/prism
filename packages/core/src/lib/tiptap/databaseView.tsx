/**
 * Browser node view + insert plumbing for the `databaseView` block (inline and
 * linked databases). The schema node lives in editor/blocks.ts (isomorphic); the
 * view renders wave 2C's `renderDatabaseBlock` through TipTap's React node-view
 * portal, so it sits inside the app's providers (VaultClient, QueryClient) and
 * reads the database through the reader's own permissions.
 */
import { Extension, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { registerBlockViews } from "../../editor/blocks";
import { renderDatabaseBlock } from "../../components/database/DatabaseBlock";
import type { ViewType } from "../../components/database/config";
import { structuralEditsAllowed } from "./blockCommands";

function DatabaseNodeView({ node, editor, selected }: NodeViewProps) {
  return (
    <NodeViewWrapper className={`prism-database-block${selected ? " is-selected" : ""}`} data-type="database-view" contentEditable={false}>
      {renderDatabaseBlock(String(node.attrs.noteId), node.attrs.viewId ?? null, { readOnly: !editor.isEditable })}
    </NodeViewWrapper>
  );
}

let registered = false;
export function registerDatabaseView(): void {
  if (registered || typeof document === "undefined") return;
  registered = true;
  registerBlockViews({
    // Keyboard/mouse inside the embedded database belong to it, not to ProseMirror.
    databaseView: ReactNodeViewRenderer(DatabaseNodeView, { stopEvent: ({ event }) => !/^drag|^drop$/.test(event.type) }),
  });
}
registerDatabaseView();

export interface DatabaseInsertRequest {
  /** "new": create a database as a sub-page of this page and embed it; "linked": embed an existing one; "page": create the sub-page and open it (a link is left here). */
  mode: "new" | "linked" | "page";
  type: ViewType;
  /** Where the block goes (captured when the slash item ran). */
  pos: number;
}
export interface DatabaseInsertOptions {
  /** Host handler: opens the picker, creates/links, then calls `insertDatabaseBlock`. Omitted → the slash items are hidden. */
  onRequest?: (request: DatabaseInsertRequest) => void;
}

/** Carries the host's "insert a database" handler to the slash menu. */
export const DatabaseInsert = Extension.create<DatabaseInsertOptions>({
  name: "databaseInsert",
  addOptions() {
    return { onRequest: undefined };
  },
});

const handler = (editor: Editor | null) =>
  (editor?.extensionManager.extensions.find((e) => e.name === "databaseInsert")?.options as DatabaseInsertOptions | undefined)?.onRequest;

export const canInsertDatabase = (editor: Editor | null): boolean => !!handler(editor) && !!editor?.schema.nodes.databaseView;

export function requestDatabaseInsert(editor: Editor, mode: DatabaseInsertRequest["mode"], type: ViewType): void {
  const { $from } = editor.state.selection;
  handler(editor)?.({ mode, type, pos: $from.depth >= 1 ? $from.before(1) : $from.pos });
}

/** Insert the block (one transaction): replaces the empty paragraph at `pos`, else goes after that block. */
export function insertDatabaseBlock(editor: Editor, pos: number, attrs: { noteId: string; viewId: string | null }): boolean {
  if (editor.isDestroyed || !structuralEditsAllowed(editor)) return false;
  const { state } = editor;
  const type = state.schema.nodes.databaseView;
  if (!type || !/^[A-Za-z0-9_-]{1,128}$/.test(attrs.noteId)) return false;
  const at = Math.max(0, Math.min(pos, state.doc.content.size));
  const node = state.doc.nodeAt(at);
  const block = type.create({ noteId: attrs.noteId, viewId: attrs.viewId });
  const tr = state.tr;
  if (node && node.isTextblock && node.content.size === 0) tr.replaceWith(at, at + node.nodeSize, block);
  else tr.insert(node ? at + node.nodeSize : state.doc.content.size, block);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
