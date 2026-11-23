import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { topLevelBlocks } from "./blockCommands";

/**
 * A stable reference to one top-level block across edits, so the block menu and
 * a drag act on the block the user picked even after other edits move it.
 *
 * - Live editor: the block's Yjs element. A collaborator's update reaches
 *   ProseMirror as ONE replace over the whole document, so mapping positions
 *   cannot tell a block that shifted from one that was replaced; the Yjs element
 *   can (and knows when it was deleted).
 * - Plain editor: the position, mapped through every transaction.
 */
export type BlockRef =
  | { kind: "y"; type: { _item?: { deleted: boolean } | null } }
  | { kind: "pos"; pos: number };

interface YMapping { forEach(fn: (value: unknown, key: unknown) => void): void; get(key: unknown): unknown }

function yMapping(editor: Editor): YMapping | null {
  const state = ySyncPluginKey.getState(editor.state) as { binding?: { mapping?: YMapping } } | undefined;
  return state?.binding?.mapping ?? null;
}

export function blockRefAt(editor: Editor, pos: number): BlockRef | null {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return null;
  const mapping = yMapping(editor);
  if (!mapping) return { kind: "pos", pos };
  let found: unknown = null;
  mapping.forEach((value, key) => { if (value === node) found = key; });
  return found ? { kind: "y", type: found as { _item?: { deleted: boolean } | null } } : null;
}

/** Map a position reference through a local transaction (no-op for Yjs refs). */
export function mapBlockRef(ref: BlockRef, tr: Transaction): BlockRef | null {
  if (ref.kind === "y" || !tr.docChanged) return ref;
  const res = tr.mapping.mapResult(ref.pos, 1);
  return res.deletedAfter || res.deletedAcross ? null : { kind: "pos", pos: res.pos };
}

/** Where the referenced block is now, or null when it no longer exists. */
export function locateBlock(editor: Editor, ref: BlockRef | null): { index: number; pos: number } | null {
  if (!ref) return null;
  const blocks = topLevelBlocks(editor.state.doc);
  if (ref.kind === "pos") {
    const b = blocks.find((x) => x.pos === ref.pos);
    return b ? { index: b.index, pos: b.pos } : null;
  }
  if (ref.type._item?.deleted) return null;
  const mapping = yMapping(editor);
  if (!mapping) return null;
  const node = mapping.get(ref.type);
  const b = blocks.find((x) => x.node === node);
  return b ? { index: b.index, pos: b.pos } : null;
}
