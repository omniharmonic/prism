import { useEffect, useRef, useState, type RefObject } from "react";
import { hasRequestReceipt } from "../../lib/drafts/requestReceipt";
import { Plus } from "lucide-react";
import { useAgentAvailable } from "../../data/AgentClientContext";
import { useVaultClient } from "../../data/VaultClientContext";
import {
  isAskableNoteId,
  openAgentChat,
  useAgentChatStore,
} from "../../lib/agent/chatStore";

export function AddSavedNoteContextButton({
  noteId,
  label,
  onAdded,
}: {
  noteId: string;
  label: string;
  onAdded: () => void;
}) {
  const available = useAgentAvailable();
  const pending = useAgentChatStore((state) => state.pendingSavedNote);
  const scope = useAgentChatStore((state) => state.scope);
  if (!available || !scope || !isAskableNoteId(noteId)) return null;
  return (
    <button
      type="button"
      disabled={!!pending}
      title={
        pending
          ? "Finish or dismiss the pending context note in your conversation"
          : "Attach this saved note without sending a message"
      }
      aria-label={
        pending
          ? "Finish or dismiss pending context"
          : `Add ${label} to context`
      }
      className="focus-ring flex min-h-control shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-xs disabled:opacity-50"
      style={{ color: "var(--color-accent)" }}
      onClick={() => {
        if (!useAgentChatStore.getState().beginSavedNote(noteId, label)) return;
        onAdded();
        openAgentChat();
      }}
    >
      <Plus size={15} aria-hidden="true" />
      {pending ? "Context pending" : "Add to context"}
    </button>
  );
}

export function useSavedNoteHandoff({
  scope,
  sessionId,
  ready,
  busy,
  sendingRef,
  maxNotes,
  contextText,
  updateContext,
}: {
  scope: string | null;
  sessionId: string | null;
  ready: boolean;
  busy: boolean;
  sendingRef: RefObject<boolean>;
  maxNotes?: number;
  contextText: string;
  updateContext: (updater: (current: string) => string) => boolean;
}) {
  const vault = useVaultClient();
  const candidate = useAgentChatStore((state) => state.pendingSavedNote);
  const draft = useAgentChatStore((state) => state.draft);
  const pending = candidate?.scope === scope ? candidate : null;
  const changed =
    !!pending &&
    (pending.targetSessionId !== sessionId ||
      (!sessionId && pending.targetDraft !== draft));
  let receiptMessage: string | null = null;
  if (pending && scope) {
    try {
      if (
        hasRequestReceipt(
          scope,
          sessionId ? `session:${sessionId}` : `note:${draft?.noteId ?? "new"}`,
        )
      )
        receiptMessage =
          "Confirm the previous send before adding context. Retry it from the composer without changing the message.";
    } catch {
      receiptMessage =
        "Couldn't check your previous send. Restore browser storage access, then check this note again.";
    }
  }
  const [failure, setFailure] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const latest = useRef({
    scope,
    sessionId,
    ready,
    busy,
    maxNotes,
    updateContext,
  });
  latest.current = { scope, sessionId, ready, busy, maxNotes, updateContext };
  useEffect(() => {
    if (
      !pending ||
      !ready ||
      busy ||
      receiptMessage ||
      changed ||
      !Number.isSafeInteger(maxNotes) ||
      !maxNotes ||
      maxNotes < 1
    )
      return;
    let cancelled = false;
    setFailure(null);
    void vault
      .getNote(pending.noteId, { fresh: true })
      .then((note) => {
        if (cancelled) return;
        if (note.id !== pending.noteId)
          throw new Error("Note identity changed");
        useAgentChatStore.getState().commitSavedNote(pending.id, () => {
          const current = latest.current;
          if (
            cancelled ||
            !current.ready ||
            current.busy ||
            sendingRef.current ||
            current.scope !== pending.scope ||
            current.sessionId !== pending.targetSessionId
          )
            return false;
          try {
            if (
              hasRequestReceipt(
                pending.scope,
                current.sessionId
                  ? `session:${current.sessionId}`
                  : `note:${pending.targetDraftNoteId ?? "new"}`,
              )
            )
              return false;
          } catch {
            return false;
          }
          let appended = false;
          current.updateContext((text) => {
            let ids: unknown;
            try {
              ids = JSON.parse(text || "[]");
            } catch {
              ids = null;
            }
            if (
              !Array.isArray(ids) ||
              !ids.every((id) => typeof id === "string" && isAskableNoteId(id))
            ) {
              setFailure({
                id: pending.id,
                message:
                  "Your existing context draft couldn't be read. Review it before adding another note.",
              });
              return text;
            }
            if (ids.includes(pending.noteId)) {
              appended = true;
              return text;
            }
            if (ids.length >= Math.min(5, current.maxNotes ?? 0)) {
              setFailure({
                id: pending.id,
                message: "Remove an attached note before adding this one.",
              });
              return text;
            }
            appended = true;
            return JSON.stringify([...ids, pending.noteId]);
          });
          return appended;
        });
      })
      .catch(() => {
        if (!cancelled)
          setFailure({
            id: pending.id,
            message:
              "Couldn't check access to this note. Your context draft is unchanged.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [
    pending,
    ready,
    busy,
    changed,
    maxNotes,
    contextText,
    retry,
    vault,
    sendingRef,
    receiptMessage,
  ]);
  return {
    pending,
    changed,
    message: !ready
      ? "Checking this conversation…"
      : busy
        ? "Waiting for the current send to finish…"
        : receiptMessage
          ? receiptMessage
          : !maxNotes || maxNotes < 1 || !Number.isSafeInteger(maxNotes)
            ? "This server hasn't enabled saved-note context."
            : failure?.id === pending?.id
              ? failure?.message
              : "Checking access to this note…",
    retry: () => setRetry((value) => value + 1),
    canRetry:
      !!pending && (failure?.id === pending.id || !!receiptMessage) && !busy,
    acceptCurrent: () =>
      pending && useAgentChatStore.getState().retargetSavedNote(pending.id),
    dismiss: () =>
      pending && useAgentChatStore.getState().dismissSavedNote(pending.id),
  };
}

export function SavedNoteHandoffNotice({
  handoff,
}: {
  handoff: ReturnType<typeof useSavedNoteHandoff>;
}) {
  if (!handoff.pending) return null;
  return (
    <section
      aria-label="Saved note context"
      className="mb-2 rounded-lg border border-[var(--glass-border)] p-3 text-xs"
    >
      <p>
        <strong>{handoff.pending.label}</strong> · Saved note. Nothing has been
        sent.
      </p>
      {handoff.changed ? (
        <>
          <p className="mt-2">
            You switched conversations. Choose where to attach this note.
          </p>
          <button
            className="focus-ring min-h-control underline"
            onClick={handoff.acceptCurrent}
          >
            Attach to this conversation
          </button>
        </>
      ) : (
        <p role="status" className="mt-2">
          {handoff.message}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {handoff.canRetry && (
          <button
            className="focus-ring min-h-control underline"
            onClick={handoff.retry}
          >
            Check note again
          </button>
        )}
        <button
          className="focus-ring min-h-control underline"
          onClick={handoff.dismiss}
        >
          Dismiss pending note
        </button>
      </div>
    </section>
  );
}
