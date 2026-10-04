import { useEffect } from "react";
import { create } from "zustand";
import type { Editor } from "@tiptap/react";
import { useAgentChatStore } from "./chatStore";
import {
  SNAPSHOT_MAX_CHARACTERS,
  type AgentContextSnapshot,
} from "./contextSnapshots";

type Capture = {
  /** Memory-only identity; never included in a context payload. */
  editor?: Editor;
  document: AgentContextSnapshot;
  selection: AgentContextSnapshot | null;
};
/** Small memory-only handoff across document/panel remounts. Attachments persist only by explicit choice. */
export const useDocumentSnapshots = create<{
  scope: string | null;
  notes: Record<string, Capture>;
}>(() => ({ scope: null, notes: {} }));
useAgentChatStore.subscribe((state, previous) => {
  if (state.scope !== previous.scope)
    useDocumentSnapshots.setState({ scope: state.scope, notes: {} });
});
export function useAgentDocumentSnapshot(
  editor: Editor | null,
  noteId: string,
  label: string,
  baseUpdatedAt: string | null,
  enabled = true,
) {
  const scope = useAgentChatStore((s) => s.scope);
  useEffect(() => {
    if (!scope || !editor || editor.isDestroyed || !enabled) {
      const state = useDocumentSnapshots.getState();
      if (editor && state.notes[noteId]?.editor === editor) {
        const notes = { ...state.notes };
        delete notes[noteId];
        useDocumentSnapshots.setState({ notes });
      }
      return;
    }
    const capture = () => {
      if (editor.isDestroyed || useAgentChatStore.getState().scope !== scope)
        return;
      const doc = editor.state.doc;
      const now = new Date().toISOString();
      const snapshot = (
        kind: "document" | "selection",
        from: number,
        to: number,
      ): AgentContextSnapshot => {
        const end = Math.min(to, from + SNAPSHOT_MAX_CHARACTERS * 2);
        const text = doc.textBetween(from, end, "\n");
        return {
          kind,
          noteId,
          label: label.slice(0, 200) || "Untitled document",
          text: text.slice(0, SNAPSHOT_MAX_CHARACTERS),
          capturedAt: now,
          baseUpdatedAt,
          truncated: end < to || text.length > SNAPSHOT_MAX_CHARACTERS,
        };
      };
      const { from, to } = editor.state.selection;
      const value = {
        editor,
        document: snapshot("document", 0, doc.content.size),
        selection: from === to ? null : snapshot("selection", from, to),
      };
      const state = useDocumentSnapshots.getState();
      const entries = Object.entries(state.scope === scope ? state.notes : {})
        .filter(([id]) => id !== noteId)
        .slice(-3);
      useDocumentSnapshots.setState({
        scope,
        notes: { ...Object.fromEntries(entries), [noteId]: value },
      });
    };
    capture();
    editor.on("update", capture);
    editor.on("selectionUpdate", capture);
    return () => {
      editor.off("update", capture);
      editor.off("selectionUpdate", capture);
      // An older host must not unregister a replacement editor for this note.
      const state = useDocumentSnapshots.getState();
      if (state.scope === scope && state.notes[noteId]?.editor === editor) {
        const { editor: _editor, ...snapshot } = state.notes[noteId];
        useDocumentSnapshots.setState({ notes: { ...state.notes, [noteId]: snapshot } });
      }
    };
  }, [editor, noteId, label, baseUpdatedAt, enabled, scope]);
}

/** Resolve only the registered editor, never whichever document is active in the shell. */
export function captureForEditor(editor: Editor | null) {
  const state = useDocumentSnapshots.getState();
  if (!editor || editor.isDestroyed || !state.scope || state.scope !== useAgentChatStore.getState().scope) return null;
  return Object.values(state.notes).find(capture => capture.editor === editor) ?? null;
}

/** The editor registered for a note (the page that is open), with whether it is a LIVE
 *  (collaborative) document: live hosts register without a base revision. Null when the
 *  page is not open in an editor, or belongs to another audience. */
export function registeredEditor(noteId: string): { editor: Editor; live: boolean } | null {
  const state = useDocumentSnapshots.getState();
  if (!state.scope || state.scope !== useAgentChatStore.getState().scope) return null;
  const capture = state.notes[noteId];
  if (!capture?.editor || capture.editor.isDestroyed) return null;
  return { editor: capture.editor, live: capture.document.baseUpdatedAt == null };
}

/** Which note a registered editor shows (id + its title as registered). */
export function noteForEditor(editor: Editor | null): { noteId: string; title: string } | null {
  const state = useDocumentSnapshots.getState();
  if (!editor || editor.isDestroyed || !state.scope || state.scope !== useAgentChatStore.getState().scope) return null;
  for (const [noteId, capture] of Object.entries(state.notes)) if (capture.editor === editor) return { noteId, title: capture.document.label };
  return null;
}
