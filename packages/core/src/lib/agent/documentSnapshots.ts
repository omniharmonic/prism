import { useEffect } from "react";
import { create } from "zustand";
import type { Editor } from "@tiptap/react";
import { useAgentChatStore } from "./chatStore";
import {
  SNAPSHOT_MAX_CHARACTERS,
  type AgentContextSnapshot,
} from "./contextSnapshots";

type Capture = {
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
      if (state.notes[noteId]) {
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
    };
  }, [editor, noteId, label, baseUpdatedAt, enabled, scope]);
}
