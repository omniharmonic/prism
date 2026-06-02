import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, MessageSquare, Clock, Check, ChevronDown } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { matrixApi } from "../../lib/matrix/client";
import { vaultApi } from "../../lib/parachute/client";
import { MessageThread } from "../comms/MessageThread";
import { MessageComposer } from "../comms/MessageComposer";
import { PlatformBadge } from "../comms/PlatformBadge";
import type { MatrixMessage } from "../../lib/matrix/types";

const TRIAGE_OPTIONS = [
  { tag: "urgent", label: "Urgent", icon: AlertTriangle, color: "var(--color-danger)" },
  { tag: "action-required", label: "Action Required", icon: Bell, color: "var(--color-warning)" },
  { tag: "informational", label: "Informational", icon: MessageSquare, color: "var(--text-secondary)" },
  { tag: "handled", label: "Handled", icon: Check, color: "var(--color-success)" },
] as const;

// Parse the vault note's text content (lines like "[YYYY-MM-DD HH:MM] sender: body")
// into MatrixMessage[]. The vault is the canonical source — Matrix is optional live data.
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s+([^:]+):\s(.*)$/;

function parseThreadContent(content: string | null | undefined): MatrixMessage[] {
  if (!content) return [];
  const messages: MatrixMessage[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const [, timeStr, sender, body] = m;
    const ts = Date.parse(timeStr.replace(" ", "T"));
    messages.push({
      event_id: `vault-${i}`,
      sender,
      sender_name: sender,
      body,
      msg_type: "m.text",
      timestamp: Number.isNaN(ts) ? 0 : ts,
      is_outgoing: false,
      media_url: null,
      media_info: null,
    });
  }
  return messages;
}

export default function MessageRenderer({ note }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const roomId = (meta?.matrixRoomId as string) || (meta?.matrix_room_id as string) || "";
  const platform = (meta?.platform as string) || "matrix";
  const queryClient = useQueryClient();

  // Vault content is the source of truth — parse it once for instant render.
  const vaultMessages = useMemo(() => parseThreadContent(note.content), [note.content]);

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

  const handleTriageChange = useCallback(async (newTag: string) => {
    // Remove old triage tags, add new one
    const oldTags = ["urgent", "action-required", "informational", "social", "handled"];
    const currentTags = note.tags || [];
    const tagsToRemove = currentTags.filter((t) => oldTags.includes(t));
    if (tagsToRemove.length > 0) {
      await vaultApi.removeTags(note.id, tagsToRemove);
    }
    await vaultApi.addTags(note.id, [newTag]);
    setTriageStatus(newTag);
    setShowTriageMenu(false);
    queryClient.invalidateQueries({ queryKey: ["vault"] });
  }, [note.id, note.tags, queryClient]);

  // Live Matrix fetch is best-effort. No retries (avoids the "load forever" symptom
  // when Synapse is offline or slow), and we never gate render on it.
  const { data: liveData } = useQuery({
    queryKey: ["matrix", "messages", roomId],
    queryFn: () => matrixApi.getMessages(roomId, 50),
    enabled: !!roomId,
    retry: false,
    staleTime: 30_000,
  });

  const handleSend = useCallback(async (body: string) => {
    if (!roomId) return;
    await matrixApi.sendMessage(roomId, body);
    queryClient.invalidateQueries({ queryKey: ["matrix", "messages", roomId] });
  }, [roomId, queryClient]);

  // Prefer live Matrix data when it arrives (richer: real event IDs, is_outgoing).
  // Fall back to vault content immediately so the thread renders even if Matrix is unavailable.
  const messages = useMemo(() => {
    if (liveData?.messages && liveData.messages.length > 0) {
      return [...liveData.messages].reverse();
    }
    return vaultMessages;
  }, [liveData, vaultMessages]);

  // Determine the triage option for display
  const triageOption = TRIAGE_OPTIONS.find((o) => o.tag === triageStatus);

  return (
    <div className="flex flex-col h-full">
      {/* Header with triage status */}
      <div
        className="flex items-center gap-2 px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <PlatformBadge platform={platform} />
        <span className="text-sm font-medium flex-1" style={{ color: "var(--text-primary)" }}>
          {note.path?.split("/").pop()?.replace(/-/g, " ") || "Chat"}
        </span>

        {/* Triage status dropdown */}
        <div className="relative">
          <button
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
                  onClick={() => handleTriageChange(opt.tag)}
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

      {/* Messages */}
      <MessageThread
        messages={messages}
        hasMore={liveData?.has_more}
      />

      {/* Composer with auto-suggest handled */}
      <MessageComposer
        onSend={async (body) => {
          await handleSend(body);
          // Auto-suggest: if message was urgent/action-required, prompt to mark handled
          if (triageStatus === "urgent" || triageStatus === "action-required") {
            // Show a brief toast-like suggestion
            setTriageStatus("handled");
            // Actually update the tags
            const oldTags = ["urgent", "action-required", "informational", "social"];
            const tagsToRemove = (note.tags || []).filter((t) => oldTags.includes(t));
            if (tagsToRemove.length > 0) vaultApi.removeTags(note.id, tagsToRemove).catch(() => {});
            vaultApi.addTags(note.id, ["handled"]).catch(() => {});
            queryClient.invalidateQueries({ queryKey: ["vault"] });
          }
        }}
      />
    </div>
  );
}
