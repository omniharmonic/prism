import { useIsWeb } from "../../data/Platform";
import { parseLegacyThread } from "../../lib/messages/legacyThread";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, MessageSquare, Clock, Check, ChevronDown } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { matrixApi } from "../../lib/matrix/client";
import { useVaultClient } from "../../data/VaultClientContext";
import { useLiveActions, useLiveActionsClient } from "../../data/LiveActionsContext";
import { MessageThread } from "../comms/MessageThread";
import { MessageComposer } from "../comms/MessageComposer";
import { PlatformBadge } from "../comms/PlatformBadge";

const TRIAGE_OPTIONS = [
  { tag: "urgent", label: "Urgent", icon: AlertTriangle, color: "var(--color-danger)" },
  { tag: "action-required", label: "Action Required", icon: Bell, color: "var(--color-warning)" },
  { tag: "informational", label: "Informational", icon: MessageSquare, color: "var(--text-secondary)" },
  { tag: "handled", label: "Handled", icon: Check, color: "var(--color-success)" },
] as const;

export default function MessageRenderer({ note }: RendererProps) {
  const actionClient = useLiveActionsClient();
  const scope = actionClient?.scope?.() || null;
  return <ScopedMessageRenderer key={JSON.stringify([scope, note.id])} note={note} scope={scope} />;
}

function ScopedMessageRenderer({ note, scope }: Pick<RendererProps, "note"> & { scope: string | null }) {
  const vault = useVaultClient();
  const meta = note.metadata as Record<string, unknown> | null;
  const roomId = (meta?.matrixRoomId as string) || (meta?.matrix_room_id as string) || "";
  const platform = (meta?.platform as string) || "matrix";
  const queryClient = useQueryClient();

  // Vault content is the source of truth — parse it once for instant render.
  const imported = useMemo(() => parseLegacyThread(note.content), [note.content]);
  const vaultMessages = imported.messages;
  const [view, setView] = useState<"saved" | "live">("saved");
  const [triageError, setTriageError] = useState<string | null>(null);
  const [triagePending, setTriagePending] = useState(false);
  const [sent, setSent] = useState(false);
  const isWeb = useIsWeb();

  // Determine current triage status from tags
  const currentTriage = useMemo(() => {
    const tags = note.tags || [];
    if (tags.includes("handled")) return "handled";
    if (tags.includes("urgent")) return "urgent";
    if (tags.includes("action-required")) return "action-required";
    if (tags.includes("informational")) return "informational";
    if (tags.includes("social")) return "social";
    return null;
  }, [note.tags]);

  const [triageStatus, setTriageStatus] = useState(currentTriage);
  const [showTriageMenu, setShowTriageMenu] = useState(false);

  useEffect(() => setTriageStatus(currentTriage), [currentTriage]);

  const handleTriageChange = useCallback(async (newTag: string) => {
    if (triagePending) return;
    setTriagePending(true);
    setTriageError(null);
    try {
      const oldTags = ["urgent", "action-required", "informational", "social", "handled"];
      // Add the new value before removing old values; a partial failure leaves
      // a visible classification to reconcile, not a silently untagged thread.
      await vault.addTags(note.id, [newTag]);
      const toRemove = (note.tags || []).filter((tag) => oldTags.includes(tag) && tag !== newTag);
      if (toRemove.length) await vault.removeTags(note.id, toRemove);
      setTriageStatus(newTag);
      setShowTriageMenu(false);
      setSent(false);
    } catch {
      setTriageError("The status update was not confirmed. Refresh this thread before trying again.");
    } finally {
      setTriagePending(false);
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
    }
  }, [note.id, note.tags, queryClient, triagePending, vault]);

  // Live Matrix fetch is best-effort. No retries (avoids the "load forever" symptom
  // when Synapse is offline or slow), and we never gate render on it.
  const { data: liveData } = useQuery({
    queryKey: ["matrix", "messages", scope, roomId],
    queryFn: () => matrixApi.getMessages(roomId, 50),
    enabled: !!roomId,
    retry: false,
    staleTime: 30_000,
  });

  // Web/native: send through the server (WP1.5 live actions) when it offers
  // Matrix actions; desktop (no provider) keeps its Tauri command.
  const live = useLiveActions("matrix");
  const handleSend = useCallback(async (body: string, requestId?: string) => {
    if (!roomId || (isWeb && !live)) throw new Error("Messaging is unavailable for this thread");
    if (live) {
      if (!scope || live.scope?.() !== scope) throw new Error("Workspace changed. Reopen this thread before sending.");
      await live.matrixSend(roomId, body, { idempotencyKey: requestId });
    }
    else await matrixApi.sendMessage(roomId, body);
    queryClient.invalidateQueries({ queryKey: ["matrix", "messages", scope, roomId] });
  }, [roomId, queryClient, live, isWeb, scope]);

  // Imported history has no reliable source IDs. Do not pretend a live tail
  // replaces or can be deduplicated against the complete saved transcript.
  const showLive = view === "live" || vaultMessages.length === 0;
  const messages = showLive && liveData?.messages?.length ? [...liveData.messages].reverse() : vaultMessages;

  // Determine the triage option for display
  const triageOption = TRIAGE_OPTIONS.find((o) => o.tag === triageStatus);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header with triage status */}
      <div
        className="flex flex-wrap items-center gap-2 px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <PlatformBadge platform={platform} />
        <span className="text-sm font-medium min-w-0 flex-1 break-words" style={{ color: "var(--text-primary)", overflowWrap: "anywhere" }}>
          {note.path?.split("/").pop()?.replace(/-/g, " ") || "Chat"}
        </span>

        {/* Triage status dropdown */}
        <div className="relative">
          <button
            aria-label="Thread status" aria-expanded={showTriageMenu} disabled={triagePending}
            onClick={() => setShowTriageMenu(!showTriageMenu)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors hover:bg-[var(--glass-hover)]"
            style={{
              color: triageOption?.color || "var(--text-muted)",
              border: `1px solid ${triageOption?.color || "var(--glass-border)"}`,
            }}
          >
            {triageOption ? <triageOption.icon size={10} /> : <Clock size={10} />}
            {triageOption?.label || "Unclassified"}
            <ChevronDown size={9} />
          </button>

          {showTriageMenu && (
            <div
              className="absolute right-0 top-full mt-1 w-44 rounded-lg py-1 z-50"
              style={{ background: "var(--bg-elevated)", border: "1px solid var(--glass-border)", boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}
            >
              {TRIAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.tag}
                  disabled={triagePending}
                  onClick={() => void handleTriageChange(opt.tag)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-[var(--glass-hover)] transition-colors"
                  style={{ color: opt.color }}
                >
                  <opt.icon size={11} />
                  {opt.label}
                  {triageStatus === opt.tag && <Check size={10} className="ml-auto" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {triageError && <p role="alert" className="px-4 py-2 text-xs">{triageError}</p>}
      {vaultMessages.length > 0 && liveData?.messages?.length ? <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
        <span>{showLive ? `Latest ${messages.length} live messages` : "Saved conversation history"}</span>
        <button type="button" className="underline" onClick={() => setView(showLive ? "saved" : "live")}>{showLive ? "View saved history" : "View latest messages"}</button>
      </div> : null}
      {imported.preamble && <details className="px-4 py-2 text-xs" style={{ color: "var(--text-secondary)" }}><summary>Imported thread details</summary><pre className="whitespace-pre-wrap break-words mt-2">{imported.preamble}</pre></details>}
      <MessageThread messages={messages} />
      {sent && (triageStatus === "urgent" || triageStatus === "action-required") && <div className="px-4 py-2 text-xs">Reply sent. <button type="button" disabled={triagePending} className="underline" onClick={() => void handleTriageChange("handled")}>Mark handled</button></div>}
      {(!roomId || (isWeb && !live)) && <p className="px-4 py-2 text-xs" role="status">Replying is unavailable for this thread on this connection.</p>}
      <MessageComposer draftScope={scope} draftKey={`matrix:${roomId || note.id}`} retrySafe={!!live} disabled={!roomId || (isWeb && !live)} onSend={async (body, options) => {
        await handleSend(body, options.requestId);
        setSent(true);
        setView("live");
      }} />
    </div>
  );
}
