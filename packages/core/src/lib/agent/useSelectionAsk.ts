import { useCallback, useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { useAgentClient, useAgentAvailability, useAgentLimitsQuery } from "../../data/AgentClientContext";
import { useUIStore } from "../../app/stores/ui";
import { captureForEditor, useDocumentSnapshots } from "./documentSnapshots";
import { useAgentChatStore } from "./chatStore";
import { canonicalSnapshot, SNAPSHOT_MAX_CHARACTERS } from "./contextSnapshots";

/** Explicit unsent context handoff. No request or document edit is performed here. */
export function useSelectionAsk(editor: Editor | null) {
  const client = useAgentClient();
  const availability = useAgentAvailability();
  const limits = useAgentLimitsQuery();
  const scope = useAgentChatStore(state => state.scope);
  const pending = useAgentChatStore(state => state.pendingSelection);
  useDocumentSnapshots(state => editor ? Object.values(state.notes).find(capture => capture.editor === editor) : null);
  const capture = captureForEditor(editor);
  const supported = availability === "yes" && (limits.data?.contextSnapshots?.maxSnapshots ?? 0) > 0 && !!scope && client?.scope?.() === scope;
  const reason = pending ? "Finish or dismiss the pending selected context first." : !limits.data?.contextSnapshots ? "This server does not currently offer captured context." : !capture ? "Open an available document to capture its text." : "";
  const canAsk = supported && !!capture && !pending;
  const ask = useCallback((kind: "selection" | "document" = "selection", slash?: { from: number; to: number }) => {
    if (!canAsk || !editor || client?.scope?.() !== scope) return false;
    const current = captureForEditor(editor);
    const source = kind === "selection" ? current?.selection : current?.document;
    if (!source) return false;
    const snapshot = canonicalSnapshot(source);
    if (slash) {
      if (!editor.isEditable || slash.from < 0 || slash.to > editor.state.doc.content.size) return false;
      const text = editor.state.doc.textBetween(0, slash.from, "\n") + editor.state.doc.textBetween(slash.to, editor.state.doc.content.size, "\n");
      snapshot.text = text.slice(0, SNAPSHOT_MAX_CHARACTERS);
      snapshot.truncated = text.length > SNAPSHOT_MAX_CHARACTERS;
    }
    const maxCharacters = Math.min(SNAPSHOT_MAX_CHARACTERS, limits.data!.contextSnapshots!.maxCharacters);
    if (!snapshot.text.trim() || maxCharacters < 1) return false;
    if (snapshot.text.length > maxCharacters) { snapshot.text = snapshot.text.slice(0, maxCharacters); snapshot.truncated = true; }
    if (!useAgentChatStore.getState().beginSelection(snapshot)) return false;
    if (slash) editor.chain().focus().deleteRange(slash).run();
    useUIStore.setState({ contextPanelOpen: true, contextPanelTab: "agent" });
    return true;
  }, [canAsk, editor, client, scope, limits.data]);
  return { ask, canAsk, reason, available: availability === "yes", hasClient: !!client, selected: !!capture?.selection?.text.trim() };
}

export function useSelectionAskShortcut(editor: Editor | null, ask: ReturnType<typeof useSelectionAsk>["ask"], enabled: boolean) {
  useEffect(() => {
    if (!editor || !enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j" || !editor.view.dom.contains(document.activeElement)) return;
      event.preventDefault();
      ask();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, ask, enabled]);
}
