import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Square, Loader2, CheckCircle2, XCircle, Bot, Send, ChevronDown, ChevronRight, Settings2, Clock, ToggleLeft, ToggleRight, PlusCircle, X, Trash2 } from "lucide-react";
import { agentApi, ollamaApi, vaultApi, type AgentDispatch, type AgentSkill } from "../../lib/parachute/client";
import { Spinner } from "../ui/Spinner";
import { DesktopOnlyNotice } from "../ui/DesktopOnlyNotice";
import { useIsWeb } from "../../data/Platform";
import { useVaultClient } from "../../data/VaultClientContext";
import { useUIStore } from "../../app/stores/ui";
import { webGetSkills, webGetDispatches } from "../../lib/agent/web-monitor";
import type { RendererProps } from "../renderers/RendererProps";
import { useAgentClient, useAgentAvailable, useAgentLimits, agentKeys } from "../../data/AgentClientContext";
import { openAgentChat } from "../../lib/agent/chatStore";
import type { AgentSessionSummary } from "../../lib/agent/sessions";
import { formatAgentCost } from "../../lib/agent/cost";
import { failureOfRun } from "../../lib/agent/failure";
import { useLivePollMs } from "../../lib/events/channelStatus";
import { useHostServices } from "../../data/HostServicesContext";
import { queueSkillRun, updateSkillNote, validateStructuredBlock, type SkillPatch } from "../../lib/host/vaultOps";
import { hostServiceErrorText, type RunningSkill } from "../../lib/host/services";

import { formatTime as fmtTime } from "../../lib/datetime/format";
type ModelOption = { id: string; name: string; provider: string; size: string | null };
/** Save a skill-config change: desktop → its Tauri command (+ the vault for the
 *  fields that command never had); thin client → the skill note via VaultClient. */
type SaveSkill = (skill: AgentSkill, patch: SkillPatch) => Promise<void>;

function formatDuration(secs: number | null): string {
  if (!secs) return "";
  if (secs < 60) return `${secs}s`;
  const min = Math.floor(secs / 60);
  const sec = secs % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function formatTime(iso: string): string {
  try { return fmtTime(new Date(iso), { hour: "numeric", minute: "2-digit" }, { locale: "en-US" }); }
  catch { return ""; }
}

const INTERVAL_OPTIONS = [
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
  { label: "1 hour", value: 3600 },
  { label: "3 hours", value: 10800 },
  { label: "6 hours", value: 21600 },
  { label: "12 hours", value: 43200 },
  { label: "Daily", value: 86400 },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  label: `${i === 0 ? 12 : i > 12 ? i - 12 : i}:00 ${i < 12 ? "AM" : "PM"}`,
  value: i,
}));

function formatInterval(secs: number, runAtHour?: number | null): string {
  if (secs >= 86400) {
    if (runAtHour != null) {
      const h = runAtHour % 12 || 12;
      const ampm = runAtHour < 12 ? "AM" : "PM";
      return `daily @ ${h}${ampm}`;
    }
    return "daily";
  }
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}

export default function AgentActivity(_props: RendererProps) {
  const queryClient = useQueryClient();
  const isWeb = useIsWeb();
  const vaultClient = useVaultClient();
  const openTab = useUIStore((s) => s.openTab);
  const [customPrompt, setCustomPrompt] = useState("");
  const customSkill = "custom";
  const [showSkillConfig, setShowSkillConfig] = useState(false);
  const [showSkillBuilder, setShowSkillBuilder] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  // Server agent sessions (WP3.2): the owner's durable chats, listed live.
  const agentClient = useAgentClient();
  const agentChat = useAgentAvailable();
  // Thin client, server owner (WP4.3): "run now" = clear the skill note's
  // lastRun so the SERVER scheduler (SKILLS_ENABLED) runs it on its next tick,
  // with the skill's own routing. No client-side spawn.
  const host = useHostServices();
  const [queued, setQueued] = useState<Record<string, "queued" | "error">>({});
  const queueRun = async (skillId: string) => {
    try {
      await queueSkillRun(vaultClient, skillId);
      setQueued((q) => ({ ...q, [skillId]: "queued" }));
      queryClient.invalidateQueries({ queryKey: ["agent", "skills"] });
    } catch {
      setQueued((q) => ({ ...q, [skillId]: "error" }));
    }
  };
  const { data: sessions } = useQuery({
    queryKey: agentKeys(agentClient).list(false),
    queryFn: () => agentClient!.listSessions({ limit: 50 }),
    enabled: agentChat,
    refetchInterval: useLivePollMs(20_000, 60_000),
  });

  useEffect(() => {
    if (isWeb) {
      // Thin client (server owner): the models the SERVER's LM Studio offers —
      // the same server the background skills run their local model on.
      if (!host) return;
      host
        .agentModels()
        .then((m) =>
          setAvailableModels(
            m.local.models
              .filter((x) => x.type === null || x.type === "llm" || x.type === "vlm")
              .map((x) => ({ id: x.id, name: x.id, provider: "local", size: x.quantization })),
          ),
        )
        .catch(() => {});
      return;
    }
    try {
      ollamaApi.listModels().then(setAvailableModels).catch(() => {});
    } catch { /* not in Tauri */ }
  }, [isWeb, host]);

  // Skill config (parity A): the desktop card on every shell. A thin client edits
  // the skill note (the server scheduler's source of truth) through VaultClient.
  const canConfigure = !isWeb || !!host;
  const saveSkill: SaveSkill = async (skill, patch) => {
    if (isWeb) {
      await updateSkillNote(vaultClient, skill.id, patch);
    } else {
      const { runAtHour, dependsOn, structured, ...rest } = patch;
      if (Object.keys(rest).length) await agentApi.updateSkill(skill.id, rest);
      const extra: SkillPatch = {};
      if (runAtHour !== undefined) extra.runAtHour = runAtHour;
      if (dependsOn !== undefined) extra.dependsOn = dependsOn;
      if (structured !== undefined) extra.structured = structured;
      if (Object.keys(extra).length) await updateSkillNote(vaultClient, skill.id, extra);
    }
    queryClient.invalidateQueries({ queryKey: ["agent", "skills"] });
  };

  // Running server skills + Stop (parity A, server owner on a thin client).
  const { data: runningSkills } = useQuery({
    queryKey: ["agent", "skills-running", host?.scope?.() ?? ""],
    queryFn: () => host!.runningSkills(),
    enabled: isWeb && !!host,
    refetchInterval: useLivePollMs(5_000, 15_000),
  });
  const [stopError, setStopError] = useState<string | null>(null);
  const stopSkill = async (name: string) => {
    setStopError(null);
    try {
      await host!.cancelSkill(name);
    } catch (e) {
      setStopError(hostServiceErrorText(e));
    }
    queryClient.invalidateQueries({ queryKey: ["agent", "skills-running"] });
    queryClient.invalidateQueries({ queryKey: ["agent", "dispatches"] });
  };

  // Web: source skills + run history straight from the vault (owner passthrough),
  // since triggering/live-status isn't available in the browser. Desktop: the
  // Tauri agent API (in-memory dispatch manager + skill registry).
  const { data: skills } = useQuery({
    queryKey: ["agent", "skills", isWeb ? "web" : "desktop"],
    queryFn: () => (isWeb ? webGetSkills(vaultClient) : agentApi.getSkills()),
    refetchInterval: useLivePollMs(30_000),
  });

  const { data: dispatches, isLoading } = useQuery({
    queryKey: ["agent", "dispatches", isWeb ? "web" : "desktop", agentChat],
    queryFn: () => (isWeb ? webGetDispatches(vaultClient, { excludeSessions: agentChat }) : agentApi.getDispatches()),
    refetchInterval: useLivePollMs(isWeb ? 20_000 : 5_000),
  });

  /** Open a skill or dispatch report as a normal note tab (the web monitor's
   *  "view / edit" affordance, since skills + runs are just vault notes). */
  const openNote = (id: string, title: string) => openTab(id, title, "document");

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
          <Bot size={18} style={{ color: "var(--color-accent)" }} />
          Agent
        </h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          Background tasks, triage, and intelligence
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        {/* Server agent sessions (owner, web) */}
        {agentChat && <SessionsSection sessions={sessions ?? []} />}

        {/* Server skill runs in flight (owner, thin client) — with Stop */}
        {isWeb && host && (runningSkills?.length ?? 0) > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
              <Loader2 size={12} className="animate-spin" /> Running on the server
            </h3>
            <div className="space-y-1.5">
              {(runningSkills ?? []).map((r: RunningSkill) => (
                <div
                  key={r.skill}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg"
                  style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
                  data-testid="running-skill-row"
                >
                  <span className="w-2 h-2 rounded-full animate-pulse flex-shrink-0" style={{ background: "var(--color-accent)" }} />
                  <span className="text-xs font-medium flex-1 truncate capitalize" style={{ color: "var(--text-primary)" }}>
                    {r.skill.replace(/-/g, " ")}
                  </span>
                  <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    {r.kind === "local" ? `local${r.model ? ` · ${r.model}` : ""}` : "claude"} · since {formatTime(r.startedAt)}
                  </span>
                  <button
                    onClick={() => stopSkill(r.skill)}
                    disabled={r.cancelRequested}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] disabled:opacity-50 hover:bg-[var(--glass-hover)]"
                    style={{ color: "var(--color-danger)", border: "1px solid var(--glass-border)" }}
                    title="Stop this run (it is recorded as cancelled)"
                    aria-label={`Stop ${r.skill}`}
                  >
                    <Square size={9} /> {r.cancelRequested ? "Stopping…" : "Stop"}
                  </button>
                </div>
              ))}
            </div>
            {stopError && <div className="text-[11px] mt-1" style={{ color: "var(--color-danger)" }}>{stopError}</div>}
          </div>
        )}

        {/* Skills */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Skills</h3>
            {/* Create/configure skills: desktop, or the server owner on a thin client
                (the skill notes are the server scheduler's config). */}
            {canConfigure && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { setShowSkillBuilder(true); setShowSkillConfig(true); }}
                  className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
                  title="Create new skill"
                >
                  <PlusCircle size={12} style={{ color: "var(--color-accent)" }} />
                </button>
                <button
                  onClick={() => { setShowSkillConfig(!showSkillConfig); setShowSkillBuilder(false); }}
                  className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
                  title="Configure skills"
                >
                  <Settings2 size={12} style={{ color: showSkillConfig ? "var(--color-accent)" : "var(--text-muted)" }} />
                </button>
              </div>
            )}
          </div>

          {showSkillConfig ? (
            <div className="space-y-2">
              {showSkillBuilder && (
                <SkillBuilder onCreated={() => { setShowSkillBuilder(false); queryClient.invalidateQueries({ queryKey: ["agent", "skills"] }); }} onCancel={() => setShowSkillBuilder(false)} />
              )}
              {(skills || []).map((skill) => (
                <SkillConfigCard
                  key={skill.id}
                  skill={skill}
                  allSkills={skills || []}
                  save={saveSkill}
                  onUpdate={() => queryClient.invalidateQueries({ queryKey: ["agent", "skills"] })}
                  onRun={() => (isWeb ? queueRun(skill.id) : handleDispatch(skill.skillName, skill.prompt))}
                  runLabel={isWeb ? "Run on the server at its next scheduler tick" : "Run now"}
                  availableModels={availableModels}
                />
              ))}
              {(!skills || skills.length === 0) && !showSkillBuilder && (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {isWeb ? "No skills yet. Create one with +; the server scheduler runs enabled skills." : "No skills configured. They'll be created automatically on next restart."}
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {(skills || []).map((skill) => (
                <div key={skill.id} className="relative">
                <button
                  // Desktop: run the skill now. Web (monitor): open the skill note
                  // to read/edit it — on-demand running is a host process.
                  onClick={() => (isWeb ? openNote(skill.id, skill.skillName) : handleDispatch(skill.skillName, skill.prompt))}
                  title={isWeb ? "Open this skill" : "Run this skill now"}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-left transition-colors hover:bg-[var(--glass-hover)]"
                  style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
                >
                  {isWeb ? (
                    <ChevronRight size={12} style={{ color: "var(--color-accent)" }} />
                  ) : (
                    <Play size={12} style={{ color: "var(--color-accent)" }} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate capitalize">{skill.skillName.replace(/-/g, " ")}</div>
                    {skill.enabled && (
                      <div className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                        {formatInterval(skill.intervalSecs, skill.runAtHour)}
                        {skill.lastRun && ` · ran ${formatTime(skill.lastRun)}`}
                      </div>
                    )}
                  </div>
                  {skill.enabled && <Clock size={9} style={{ color: "var(--color-success)" }} />}
                </button>
                {isWeb && host && skill.enabled && (
                  <button
                    onClick={() => queueRun(skill.id)}
                    disabled={queued[skill.id] === "queued"}
                    className="absolute right-6 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--glass-hover)] transition-colors disabled:opacity-60"
                    title={
                      queued[skill.id] === "queued"
                        ? "Queued: the server scheduler runs it within a minute (a daily skill waits for its hour)"
                        : queued[skill.id] === "error"
                          ? "Could not queue this skill"
                          : "Run on the server at its next scheduler tick"
                    }
                    aria-label={`Queue a run of ${skill.skillName}`}
                  >
                    {queued[skill.id] === "queued" ? (
                      <Clock size={11} style={{ color: "var(--color-accent)" }} />
                    ) : (
                      <Play size={11} style={{ color: queued[skill.id] === "error" ? "var(--color-danger)" : "var(--color-accent)" }} />
                    )}
                  </button>
                )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Custom dispatch — running on demand spawns claude -p on the host (desktop only). */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>Custom Task</h3>
          {isWeb && agentChat ? (
            <div className="flex items-end gap-2">
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Ask the agent on your Prism server…"
                rows={2}
                className="flex-1 rounded-lg px-3 py-2 outline-none resize-none"
                style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontSize: 16 }}
              />
              <button
                onClick={() => {
                  if (!customPrompt.trim()) return;
                  openAgentChat({ ask: { prompt: customPrompt.trim() } });
                  setCustomPrompt("");
                }}
                disabled={!customPrompt.trim()}
                className="p-2 rounded-lg transition-colors disabled:opacity-30"
                style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
                title="Start an agent chat"
              >
                <Send size={14} />
              </button>
            </div>
          ) : isWeb ? (
            <DesktopOnlyNotice
              feature="Running the agent on demand"
              detail="Custom tasks run as server agent sessions, which only the server owner can start. Here you can review every past run."
            />
          ) : (
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
                style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
              >
                <Send size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Active dispatches (cancel is host-side → desktop only) */}
        {active.length > 0 && (
          <DispatchSection title="Active" icon={<Loader2 size={13} className="animate-spin" />} dispatches={active} onCancel={isWeb ? undefined : handleCancel} onOpen={isWeb ? openNote : undefined} />
        )}

        {/* Completed */}
        {completed.length > 0 && (
          <DispatchSection title={`Completed (${completed.length})`} icon={<CheckCircle2 size={13} />} dispatches={completed} defaultClosed onOpen={isWeb ? openNote : undefined} />
        )}

        {/* Failed */}
        {failed.length > 0 && (
          <DispatchSection title={`Failed (${failed.length})`} icon={<XCircle size={13} />} dispatches={failed} defaultClosed onOpen={isWeb ? openNote : undefined} />
        )}

        {/* Empty state */}
        {!dispatches?.length && !(agentChat && sessions?.length) && (
          <div className="text-center py-8">
            <Bot size={32} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              {isWeb ? "No agent runs yet. They'll appear here as your skills run on the Prism Server." : "No dispatches yet. Use the quick actions above to get started."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionsSection({ sessions }: { sessions: AgentSessionSummary[] }) {
  const billing = useAgentLimits()?.billing;
  const [open, setOpen] = useState(true);
  const running = sessions.filter((s) => s.lastTurnStatus === "queued" || s.lastTurnStatus === "running").length;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2 hover:opacity-80" style={{ color: "var(--text-secondary)" }}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="text-xs font-semibold uppercase tracking-wider">
            Chat sessions ({sessions.length}){running ? ` · ${running} running` : ""}
          </span>
        </button>
        <button
          onClick={() => openAgentChat({ sessionId: null, ask: {} })}
          className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
          title="New agent chat"
        >
          <PlusCircle size={12} style={{ color: "var(--color-accent)" }} />
        </button>
      </div>
      {open && (
        <div className="space-y-1.5">
          {sessions.length === 0 && (
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>No chat sessions yet.</div>
          )}
          {sessions.slice(0, 12).map((s) => {
            const live = s.lastTurnStatus === "queued" || s.lastTurnStatus === "running";
            const color = live
              ? "var(--color-accent)"
              : s.lastTurnStatus === "error"
                ? "var(--color-danger)"
                : s.lastTurnStatus === "done"
                  ? "var(--color-success)"
                  : "var(--text-muted)";
            return (
              <button
                key={s.id}
                onClick={() => openAgentChat({ sessionId: s.id })}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left hover:bg-[var(--glass-hover)] transition-colors"
                style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
                data-testid="activity-session-row"
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${live ? "animate-pulse" : ""}`} style={{ background: color }} />
                <span className="text-xs font-medium flex-1 truncate" style={{ color: "var(--text-primary)" }}>
                  {s.title || "Untitled session"}
                </span>
                <span className="text-[10px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>
                  {live ? (s.lastTurnStatus === "queued" ? "queued" : "running") : s.lastTurnAt ? formatTime(new Date(s.lastTurnAt).toISOString()) : ""}
                  {s.turnCount ? ` · ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}` : ""}
                  {s.cost_usd > 0 && (
                    <span title={formatAgentCost(s.cost_usd, billing)?.title} data-testid="activity-session-cost">
                      {" · "}
                      {formatAgentCost(s.cost_usd, billing)?.text}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DispatchSection({
  title, icon, dispatches, onCancel, onOpen, defaultClosed,
}: {
  title: string; icon: React.ReactNode; dispatches: AgentDispatch[]; onCancel?: (id: string) => void; onOpen?: (id: string, title: string) => void; defaultClosed?: boolean;
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
            <DispatchCard key={d.id} dispatch={d} onCancel={onCancel} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function DispatchCard({ dispatch, onCancel, onOpen }: { dispatch: AgentDispatch; onCancel?: (id: string) => void; onOpen?: (id: string, title: string) => void }) {
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
          {dispatch.prompt && (
            <div className="text-[10px] pt-2" style={{ color: "var(--text-muted)" }}>
              {dispatch.prompt.length > 200 ? dispatch.prompt.slice(0, 200) + "..." : dispatch.prompt}
            </div>
          )}
          {dispatch.output && (
            <div className="rounded p-2 text-xs whitespace-pre-wrap" style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}>
              {dispatch.output}
            </div>
          )}
          {dispatch.error && (
            <div className="rounded p-2 text-xs" style={{ background: "rgba(239,68,68,0.1)", color: "var(--color-danger)" }} data-testid="agent-dispatch-problem">
              {/* What happened + what to do, then the server's own record of it. */}
              {(failureOfRun({ status: "error", error: dispatch.error }) ?? { text: dispatch.error }).text}
              <div className="mt-1 opacity-70">{dispatch.error}</div>
            </div>
          )}
          {/* Web monitor: the run's full report is the dispatch note — open it. */}
          {onOpen && dispatch.note_id && (
            <button
              onClick={() => onOpen(dispatch.note_id!, dispatch.skill || "Agent run")}
              className="text-[11px] flex items-center gap-1 pt-1 hover:opacity-80"
              style={{ color: "var(--color-accent)" }}
            >
              <ChevronRight size={11} /> Open full report
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Skill Builder ───────────────────────────────────────────

function SkillBuilder({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [interval, setInterval] = useState(3600);
  const [runAtHour, setRunAtHour] = useState(7);
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    try {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const path = `vault/agent/skills/${slug}`;
      const metadata: Record<string, unknown> = {
        type: "agent-skill",
        skillName: slug,
        description: description.trim(),
        intervalSecs: interval,
        enabled: false,
        lastRun: null,
      };
      if (interval >= 86400) {
        metadata.runAtHour = runAtHour;
      }
      await vaultApi.createNote({
        content: prompt,
        path,
        tags: ["agent-skill"],
        metadata,
      });
      onCreated();
    } catch (e) {
      console.error("Failed to create skill:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: "var(--glass)", border: "2px solid var(--color-accent)" }}>
      <div className="flex items-center justify-between px-3 py-2" style={{ background: "rgba(var(--accent-rgb, 99,102,241), 0.1)", borderBottom: "1px solid var(--glass-border)" }}>
        <span className="text-xs font-semibold" style={{ color: "var(--color-accent)" }}>New Skill</span>
        <button onClick={onCancel} className="p-0.5 rounded hover:bg-[var(--glass-hover)]">
          <X size={12} style={{ color: "var(--text-muted)" }} />
        </button>
      </div>
      <div className="px-3 py-3 space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Skill name (e.g., Weekly Report)"
          className="w-full rounded px-2 py-1.5 text-xs outline-none"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          autoFocus
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description"
          className="w-full rounded px-2 py-1.5 text-xs outline-none"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do? Describe the task in detail...&#10;&#10;Use {{today}}, {{yesterday}}, {{now}} for dynamic dates.&#10;Use Parachute MCP tools to search, create, and update notes."
          rows={6}
          className="w-full rounded px-2 py-1.5 text-xs outline-none resize-none font-mono"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }}
        />
        <div className="flex items-center gap-2">
          <Clock size={11} style={{ color: "var(--text-muted)" }} />
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>Run:</span>
          <select
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            className="rounded px-1.5 py-0.5 text-[10px] outline-none"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {interval >= 86400 && (
            <>
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>at</span>
              <select
                value={runAtHour}
                onChange={(e) => setRunAtHour(Number(e.target.value))}
                className="rounded px-1.5 py-0.5 text-[10px] outline-none"
                style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
              >
                {HOUR_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </>
          )}
        </div>
        <button
          onClick={handleCreate}
          disabled={!name.trim() || !prompt.trim() || saving}
          className="w-full py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
        >
          {saving ? "Creating..." : "Create Skill"}
        </button>
      </div>
    </div>
  );
}

// ─── Skill Config Card ───────────────────────────────────────

const CLAUDE_MODELS = [{ id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }, { id: "haiku", name: "Haiku" }];

function SkillConfigCard({
  skill,
  allSkills,
  save,
  onUpdate,
  onRun,
  runLabel,
  availableModels,
}: {
  skill: AgentSkill;
  allSkills: AgentSkill[];
  save: SaveSkill;
  onUpdate: () => void;
  onRun: () => void;
  runLabel: string;
  availableModels: ModelOption[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [editPrompt, setEditPrompt] = useState(skill.prompt);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialStructured = skill.structured ? JSON.stringify(skill.structured, null, 2) : "";
  const [structuredText, setStructuredText] = useState(initialStructured);

  // Every change goes through `save` (validated like the desktop + the server
  // scheduler's parser); a refusal is shown inline, nothing is half-written.
  const apply = async (patch: SkillPatch) => {
    setError(null);
    try {
      await save(skill, patch);
      onUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Per-skill AI routing, persisted to the skill note (read by the scheduler).
  // "" provider = inherit the server default; reset model when provider changes.
  const handleProviderChange = (provider: string) => apply({ provider: provider as SkillPatch["provider"], model: "" });
  const handleSkillModelChange = (model: string) => apply({ model });
  const handleExecutionModeChange = (executionMode: string) => apply({ executionMode: executionMode as SkillPatch["executionMode"] });
  // Two-click inline confirm — window.confirm() is unreliable in the Tauri webview.
  const handleDelete = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    try {
      await vaultApi.deleteNote(skill.id);
      onUpdate();
    } catch (e) {
      console.error("Failed to delete skill:", e);
    }
  };

  const handleToggle = () => apply({ enabled: !skill.enabled });
  const handleIntervalChange = (secs: number) => apply({ intervalSecs: secs });
  const handleRunAtHourChange = (hour: number) => apply({ runAtHour: hour });
  const handleDependsOnChange = (name: string) => apply({ dependsOn: name || null });

  const handleSavePrompt = async () => {
    setSaving(true);
    await apply({ prompt: editPrompt });
    setSaving(false);
  };

  const handleSaveStructured = async () => {
    let parsed: unknown;
    try {
      parsed = structuredText.trim() ? JSON.parse(structuredText) : null;
    } catch (e) {
      setError(`structured config is not valid JSON: ${(e as Error).message}`);
      return;
    }
    const err = parsed === null ? null : validateStructuredBlock(parsed);
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    await apply({ structured: parsed as Record<string, unknown> | null });
    setSaving(false);
  };

  const otherSkills = allSkills.filter((s) => s.id !== skill.id).map((s) => s.skillName);
  const intervalOptions = INTERVAL_OPTIONS.some((o) => o.value === skill.intervalSecs)
    ? INTERVAL_OPTIONS
    : [...INTERVAL_OPTIONS, { label: formatInterval(skill.intervalSecs), value: skill.intervalSecs }].sort((a, b) => a.value - b.value);
  const selectStyle = { background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" };

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }} data-testid="skill-config-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={handleToggle} title={skill.enabled ? "Disable" : "Enable"} aria-label={skill.enabled ? `Disable ${skill.skillName}` : `Enable ${skill.skillName}`}>
          {skill.enabled
            ? <ToggleRight size={16} style={{ color: "var(--color-success)" }} />
            : <ToggleLeft size={16} style={{ color: "var(--text-muted)" }} />
          }
        </button>
        <button onClick={() => setExpanded(!expanded)} className="flex-1 text-left">
          <div className="text-xs font-medium capitalize" style={{ color: "var(--text-primary)" }}>
            {skill.skillName.replace(/-/g, " ")}
          </div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            {skill.description}
          </div>
        </button>
        <button onClick={onRun} className="p-1 rounded hover:bg-[var(--glass-hover)]" title={runLabel} aria-label={runLabel}>
          <Play size={12} style={{ color: "var(--color-accent)" }} />
        </button>
        {confirmingDelete ? (
          <span className="flex items-center gap-1">
            <button onClick={handleDelete} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: "var(--color-error, #ef4444)", color: "white" }} title="Confirm delete">
              Delete
            </button>
            <button onClick={() => setConfirmingDelete(false)} className="p-1 rounded hover:bg-[var(--glass-hover)]" title="Cancel">
              <X size={11} style={{ color: "var(--text-muted)" }} />
            </button>
          </span>
        ) : (
          <button onClick={handleDelete} className="p-1 rounded hover:bg-[var(--glass-hover)]" title="Delete skill">
            <Trash2 size={12} style={{ color: "var(--text-muted)" }} />
          </button>
        )}
      </div>
      {error && !expanded && <div className="px-3 pb-2 text-[10px]" style={{ color: "var(--color-danger)" }}>{error}</div>}

      {expanded && (
        <div className="px-3 pb-3 space-y-2" style={{ borderTop: "1px solid var(--glass-border)" }}>
          <div className="flex items-center gap-2 pt-2 flex-wrap">
            <Clock size={11} style={{ color: "var(--text-muted)" }} />
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>Run:</span>
            <select
              value={skill.intervalSecs}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
              className="rounded px-1.5 py-0.5 text-[10px] outline-none"
              style={selectStyle}
              aria-label="Run interval"
            >
              {intervalOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {skill.intervalSecs >= 86400 && (
              <>
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>at</span>
                <select
                  value={skill.runAtHour ?? 7}
                  onChange={(e) => handleRunAtHourChange(Number(e.target.value))}
                  className="rounded px-1.5 py-0.5 text-[10px] outline-none"
                  style={selectStyle}
                  aria-label="Run at hour"
                >
                  {HOUR_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </>
            )}
            {skill.lastRun && (
              <span className="text-[9px] ml-auto" style={{ color: "var(--text-muted)" }}>
                Last: {formatTime(skill.lastRun)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>After:</span>
            <select
              value={skill.dependsOn ?? ""}
              onChange={(e) => handleDependsOnChange(e.target.value)}
              className="rounded px-1.5 py-0.5 text-[10px] outline-none"
              style={selectStyle}
              title="Wait until this other skill has run today"
              aria-label="Depends on"
            >
              <option value="">No dependency</option>
              {otherSkills.map((n) => <option key={n} value={n}>{n}</option>)}
              {skill.dependsOn && !otherSkills.includes(skill.dependsOn) && <option value={skill.dependsOn}>{skill.dependsOn} (missing)</option>}
            </select>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>AI:</span>
            <select
              value={skill.provider ?? ""}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="rounded px-1.5 py-0.5 text-[10px] outline-none"
              style={selectStyle}
              aria-label="AI provider"
            >
              <option value="">Default (global)</option>
              <option value="claude">Claude</option>
              <option value="local">Local</option>
            </select>
            {skill.provider && (
              <select
                value={skill.model ?? ""}
                onChange={(e) => handleSkillModelChange(e.target.value)}
                className="rounded px-1.5 py-0.5 text-[10px] outline-none"
                style={selectStyle}
                aria-label="AI model"
              >
                <option value="">Default model</option>
                {(skill.provider === "claude" ? CLAUDE_MODELS : availableModels.filter(m => m.provider === "local"))
                  .map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                {skill.model && !(skill.provider === "claude" ? CLAUDE_MODELS : availableModels).some((m) => m.id === skill.model) && (
                  <option value={skill.model}>{skill.model}</option>
                )}
              </select>
            )}
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>Mode:</span>
            <select
              value={skill.executionMode || "agentic"}
              onChange={(e) => handleExecutionModeChange(e.target.value)}
              className="rounded px-1.5 py-0.5 text-[10px] outline-none"
              style={selectStyle}
              title="Agentic: free-form tool-calling loop. Structured: grammar-constrained classification (requires a 'structured' config block in the skill)."
              aria-label="Execution mode"
            >
              <option value="agentic">Agentic</option>
              <option value="structured">Structured</option>
            </select>
          </div>

          <textarea
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            rows={6}
            className="w-full rounded px-2 py-1.5 text-[10px] outline-none resize-none font-mono"
            style={selectStyle}
            aria-label="Skill prompt"
          />
          {editPrompt !== skill.prompt && (
            <button
              onClick={handleSavePrompt}
              disabled={saving}
              className="px-3 py-1 rounded text-[10px] font-medium"
              style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
            >
              {saving ? "Saving..." : "Save Prompt"}
            </button>
          )}

          {(skill.executionMode === "structured" || skill.structured) && (
            <div className="space-y-1">
              <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                Structured config (JSON): sourceTags, schema, resultField required; excludeTags, allowedValues, alsoAddTags, shortcutLabels, limit optional.
              </div>
              <textarea
                value={structuredText}
                onChange={(e) => setStructuredText(e.target.value)}
                rows={8}
                className="w-full rounded px-2 py-1.5 text-[10px] outline-none resize-y font-mono"
                style={selectStyle}
                spellCheck={false}
                aria-label="Structured config"
              />
              {structuredText !== initialStructured && (
                <button
                  onClick={handleSaveStructured}
                  disabled={saving}
                  className="px-3 py-1 rounded text-[10px] font-medium"
                  style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
                >
                  {saving ? "Saving..." : "Save Structured Config"}
                </button>
              )}
            </div>
          )}
          {error && <div className="text-[10px]" style={{ color: "var(--color-danger)" }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
