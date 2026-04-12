import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Square, Loader2, CheckCircle2, XCircle, Sparkles, Send, ChevronDown, ChevronRight } from "lucide-react";
import { agentApi, type AgentDispatch } from "../../lib/parachute/client";
import { Spinner } from "../ui/Spinner";
import type { RendererProps } from "../renderers/RendererProps";

function formatDuration(secs: number | null): string {
  if (!secs) return "";
  if (secs < 60) return `${secs}s`;
  const min = Math.floor(secs / 60);
  const sec = secs % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

const QUICK_SKILLS = [
  { skill: "message-triage", label: "Triage Messages", prompt: "Review recent message-thread notes in the vault that don't have importance tags. For each, classify as urgent/action-required/informational/social and add the appropriate tag. If you find action items, create linked task notes. Summarize what you triaged." },
  { skill: "meeting-processor", label: "Process Meetings", prompt: "Find meeting notes in the vault that have transcript content but haven't been processed (no 'processed' tag). For each, extract attendees, action items, decisions, and key topics. Create linked task notes for action items. Add the 'processed' tag when done. Summarize what you found." },
  { skill: "daily-briefing", label: "Generate Briefing", prompt: "Generate a daily briefing for today. Check: overdue tasks, today's calendar events (meetings, deadlines), recent important messages, and any follow-ups needed. Write the briefing to a new note at vault/agent/briefings/today tagged 'briefing'. Be concise and actionable." },
  { skill: "intelligence-scan", label: "Intelligence Scan", prompt: "Analyze the vault for patterns and insights. Look for: stalled projects (no updates in 7+ days), overdue tasks, upcoming meetings without agendas, commitments others made that need follow-up, and calendar gaps that match pending tasks. Write insights to vault/agent/insights/today tagged 'agent-insight'." },
];

export default function AgentActivity(_props: RendererProps) {
  const queryClient = useQueryClient();
  const [customPrompt, setCustomPrompt] = useState("");
  const customSkill = "custom";

  const { data: dispatches, isLoading } = useQuery({
    queryKey: ["agent", "dispatches"],
    queryFn: agentApi.getDispatches,
    refetchInterval: 5_000,
  });

  const active = dispatches?.filter((d) => d.status === "running") || [];
  const completed = dispatches?.filter((d) => d.status === "completed") || [];
  const failed = dispatches?.filter((d) => d.status === "failed" || d.status === "cancelled") || [];

  // When a dispatch completes, invalidate vault cache so new notes appear in the sidebar
  const prevActiveCount = useRef(active.length);
  useEffect(() => {
    if (prevActiveCount.current > 0 && active.length < prevActiveCount.current) {
      // A dispatch just finished — refresh vault data
      queryClient.invalidateQueries({ queryKey: ["vault"] });
    }
    prevActiveCount.current = active.length;
  }, [active.length, queryClient]);

  const handleDispatch = async (skill: string, prompt: string) => {
    await agentApi.dispatch(skill, prompt);
    queryClient.invalidateQueries({ queryKey: ["agent", "dispatches"] });
  };

  const handleCancel = async (id: string) => {
    await agentApi.cancelDispatch(id);
    queryClient.invalidateQueries({ queryKey: ["agent", "dispatches"] });
  };

  const handleCustomDispatch = () => {
    if (!customPrompt.trim()) return;
    handleDispatch(customSkill, customPrompt);
    setCustomPrompt("");
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><Spinner size={24} /></div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
          <Sparkles size={18} style={{ color: "var(--color-accent)" }} />
          Agent Activity
        </h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          Background tasks, triage, and intelligence
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        {/* Quick dispatch buttons */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>Quick Actions</h3>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_SKILLS.map((qs) => (
              <button
                key={qs.skill}
                onClick={() => handleDispatch(qs.skill, qs.prompt)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-left transition-colors hover:bg-[var(--glass-hover)]"
                style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
              >
                <Play size={12} style={{ color: "var(--color-accent)" }} />
                {qs.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom dispatch */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>Custom Task</h3>
          <div className="flex items-end gap-2">
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Describe what you want the agent to do..."
              rows={2}
              className="flex-1 rounded-lg px-3 py-2 text-xs outline-none resize-none"
              style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
            />
            <button
              onClick={handleCustomDispatch}
              disabled={!customPrompt.trim()}
              className="p-2 rounded-lg transition-colors disabled:opacity-30"
              style={{ background: "var(--color-accent)", color: "white" }}
            >
              <Send size={14} />
            </button>
          </div>
        </div>

        {/* Active dispatches */}
        {active.length > 0 && (
          <DispatchSection title="Active" icon={<Loader2 size={13} className="animate-spin" />} dispatches={active} onCancel={handleCancel} />
        )}

        {/* Completed */}
        {completed.length > 0 && (
          <DispatchSection title={`Completed (${completed.length})`} icon={<CheckCircle2 size={13} />} dispatches={completed} defaultClosed />
        )}

        {/* Failed */}
        {failed.length > 0 && (
          <DispatchSection title={`Failed (${failed.length})`} icon={<XCircle size={13} />} dispatches={failed} defaultClosed />
        )}

        {/* Empty state */}
        {!dispatches?.length && (
          <div className="text-center py-8">
            <Sparkles size={32} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>No dispatches yet. Use the quick actions above to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function DispatchSection({
  title, icon, dispatches, onCancel, defaultClosed,
}: {
  title: string; icon: React.ReactNode; dispatches: AgentDispatch[]; onCancel?: (id: string) => void; defaultClosed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultClosed);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 mb-2 hover:opacity-80"
        style={{ color: "var(--text-secondary)" }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
      </button>
      {open && (
        <div className="space-y-2">
          {dispatches.map((d) => (
            <DispatchCard key={d.id} dispatch={d} onCancel={onCancel} />
          ))}
        </div>
      )}
    </div>
  );
}

function DispatchCard({ dispatch, onCancel }: { dispatch: AgentDispatch; onCancel?: (id: string) => void }) {
  const [expanded, setExpanded] = useState(dispatch.status === "running");

  const statusColor = {
    running: "var(--color-accent)",
    completed: "var(--color-success)",
    failed: "var(--color-danger)",
    cancelled: "var(--text-muted)",
  }[dispatch.status];

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--glass-hover)] transition-colors"
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor }} />
        <span className="text-xs font-medium flex-1" style={{ color: "var(--text-primary)" }}>
          {dispatch.skill}
        </span>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          {formatTime(dispatch.started_at)}
          {dispatch.duration_secs ? ` · ${formatDuration(dispatch.duration_secs)}` : ""}
        </span>
        {dispatch.status === "running" && onCancel && (
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(dispatch.id); }}
            className="p-0.5 rounded hover:bg-[var(--glass-active)]"
            title="Cancel"
          >
            <Square size={10} style={{ color: "var(--color-danger)" }} />
          </button>
        )}
        {dispatch.status === "running" && (
          <Loader2 size={12} className="animate-spin" style={{ color: "var(--color-accent)" }} />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2" style={{ borderTop: "1px solid var(--glass-border)" }}>
          <div className="text-[10px] pt-2" style={{ color: "var(--text-muted)" }}>
            {dispatch.prompt.length > 200 ? dispatch.prompt.slice(0, 200) + "..." : dispatch.prompt}
          </div>
          {dispatch.output && (
            <div className="rounded p-2 text-xs whitespace-pre-wrap" style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}>
              {dispatch.output}
            </div>
          )}
          {dispatch.error && (
            <div className="rounded p-2 text-xs" style={{ background: "rgba(239,68,68,0.1)", color: "var(--color-danger)" }}>
              {dispatch.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
