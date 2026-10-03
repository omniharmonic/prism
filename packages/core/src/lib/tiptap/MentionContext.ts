import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";

/**
 * Client-only context for mention chips (no schema): which note the editor is
 * showing, so a date chip's "Remind me" can create a reminder for it. The host
 * editor configures it and may update `editor.storage.mentionContext.noteId`.
 */
export interface MentionContextOptions {
  noteId: string | null;
}

export const MentionContext = Extension.create<MentionContextOptions, { noteId: string | null }>({
  name: "mentionContext",
  addOptions() {
    return { noteId: null };
  },
  addStorage() {
    return { noteId: this.options.noteId };
  },
});

export function mentionNoteId(editor: Editor | null | undefined): string | null {
  const store = (editor?.storage as unknown as Record<string, { noteId?: string | null }> | undefined)?.mentionContext;
  return store?.noteId ?? null;
}

export function setMentionNoteId(editor: Editor | null | undefined, noteId: string | null): void {
  const store = (editor?.storage as unknown as Record<string, { noteId?: string | null }> | undefined)?.mentionContext;
  if (store) store.noteId = noteId;
}

/** Update the attrs of the chip with this uid (off the undo stack when `silent`). */
export function updateMentionByUid(editor: Editor, uid: string, attrs: Record<string, unknown>): boolean {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === "mention" && node.attrs.uid === uid) found = pos;
    return true;
  });
  if (found < 0) return false;
  const node = editor.state.doc.nodeAt(found)!;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(found, undefined, { ...node.attrs, ...attrs }));
  return true;
}
