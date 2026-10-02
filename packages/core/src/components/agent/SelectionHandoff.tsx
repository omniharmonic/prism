import { useEffect, useState, type RefObject } from "react";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { MAX_CONTEXT_SNAPSHOTS, type AgentContextSnapshot } from "../../lib/agent/contextSnapshots";

export function useSelectionHandoff({ scope, sessionId, noteId, ready, limits, snapshots, setSnapshots, inputRef, busy }: {
  scope: string | null; sessionId: string | null; noteId?: string | null; ready: boolean;
  limits?: { maxSnapshots: number; maxCharacters: number };
  snapshots: AgentContextSnapshot[]; setSnapshots: (text: string) => unknown;
  inputRef: RefObject<HTMLTextAreaElement | null>; busy: boolean;
}) {
  const candidate = useAgentChatStore(state => state.pendingSelection);
  const draft = useAgentChatStore(state => state.draft);
  const [approved, setApproved] = useState<string | null>(null);
  const pending = candidate?.scope === scope && candidate.targetSessionId === sessionId && (sessionId || candidate.targetDraftNoteId === (draft?.noteId ?? null)) ? candidate : null;
  const duplicate = !!pending && snapshots.some(snapshot => snapshot.kind === pending.snapshot.kind && snapshot.noteId === pending.snapshot.noteId && snapshot.text === pending.snapshot.text && snapshot.baseUpdatedAt === pending.snapshot.baseUpdatedAt);
  const error = !limits ? "Captured context is unavailable. Reconnect to a server that supports snapshots." : pending && pending.snapshot.text.length > limits.maxCharacters ? "This captured passage exceeds the server's context limit. Dismiss it and select a shorter passage." : !duplicate && snapshots.length >= Math.min(MAX_CONTEXT_SNAPSHOTS, limits.maxSnapshots) ? "Remove an attached snapshot before adding this passage." : null;
  const differentDocument = !!pending && pending.snapshot.noteId !== noteId;
  useEffect(() => {
    if (!pending || !ready || busy || error || (differentDocument && approved !== pending.id)) return;
    const claimed = useAgentChatStore.getState().claimSelection(pending.id);
    if (!claimed) return;
    if (!duplicate) setSnapshots(JSON.stringify([...snapshots, claimed.snapshot]));
    requestAnimationFrame(() => {
      if (useAgentChatStore.getState().scope === scope && useAgentChatStore.getState().activeSessionId === sessionId) inputRef.current?.focus({ preventScroll: true });
    });
  }, [pending, ready, busy, error, differentDocument, approved, duplicate, snapshots, setSnapshots, inputRef, scope, sessionId]);
  return {
    pending,
    message: !ready ? "Checking this conversation…" : busy ? "Waiting for the current send to finish…" : error,
    needsChoice: ready && !busy && !error && differentDocument,
    acceptCurrent: () => pending && setApproved(pending.id),
    startDocument: () => pending && useAgentChatStore.getState().selectionInNewDocument(pending.id),
    dismiss: () => pending && useAgentChatStore.getState().dismissSelection(pending.id),
  };
}

export function SelectionHandoffNotice({ handoff }: { handoff: ReturnType<typeof useSelectionHandoff> }) {
  if (!handoff.pending) return null;
  return <section aria-label="Selected context destination" className="mb-2 rounded-lg border border-[var(--glass-border)] p-3 text-xs">
    <p className="mb-2">Captured from <strong>{handoff.pending.snapshot.label}</strong>. Nothing has been sent.</p>
    {handoff.message && <p role="status" className="mb-2">{handoff.message}</p>}
    {handoff.needsChoice && <><p className="mb-2">This conversation is working with different context. Choose where to add the captured text.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="focus-ring min-h-11 rounded border border-[var(--glass-border)] px-2" onClick={handoff.acceptCurrent}>Attach to current conversation</button>
        <button type="button" className="focus-ring min-h-11 rounded border border-[var(--glass-border)] px-2" onClick={handoff.startDocument}>New conversation about this page</button>
      </div>
    </>}
    <button type="button" className="focus-ring mt-2 min-h-10 underline" onClick={handoff.dismiss}>Dismiss captured context</button>
  </section>;
}
