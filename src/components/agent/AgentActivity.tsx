import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Square, Loader2, CheckCircle2, XCircle, Bot, Send, ChevronDown, ChevronRight, Settings2, Clock, ToggleLeft, ToggleRight, PlusCircle, X } from "lucide-react";
import { agentApi, ollamaApi, vaultApi, type AgentDispatch, type AgentSkill } from "../../lib/parachute/client";
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
  const [customPrompt, setCustomPrompt] = useState("");
  const customSkill = "custom";
  const [showSkillConfig, setShowSkillConfig] = useState(false);
  const [showSkillBuilder, setShowSkillBuilder] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string; size: string | null }>>([]);
  const [skillModels, setSkillModels] = useState<Record<string, { provider: string; model: string }>>({});

  useEffect(() => {
    try {
      ollamaApi.listModels().then(setAvailableModels).catch(() => {});
      ollamaApi.getSkillModels().then(setSkillModels).catch(() => {});
    } catch { /* not in Tauri */ }
  }, []);

  const handleModelChange = async (skillName: string, provider: string, model: string) => {
    if (!model) {
      const firstModel = availableModels.find(m => m.provider === provider);
      model = firstModel?.id || (provider === "claude" ? "sonnet" : "");
    }
    try {
      await ollamaApi.setSkillModel(skillName, provider, model);
      setSkillModels(prev => ({ ...prev, [skillName]: { provider, model } }));
    } catch { /* silent fail */ }
  };

  const { data: skills } = useQuery({
    queryKey: ["agent", "skills"],
    queryFn: agentApi.getSkills,
    refetchInterval: 30_000,
  });

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
          <Bot size={18} style={{ color: "var(--color-accent)" }} />
          Agent
        </h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          Background tasks, triage, and intelligence
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        {/* Skills */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Skills</h3>
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
          </div>

          {showSkillConfig ? (
            <div className="space-y-2">
              {showSkillBuilder && (
                <SkillBuilder onCreated={() => { setShowSkillBuilder(false); queryClient.invalidateQueries({ queryKey: ["agent", "skills"] }); }} onCancel={() => setShowSkillBuilder(false)} />
              )}
              {(skills || []).map((skill) => (
                <SkillConfigCard key={skill.id} skill={skill} onUpdate={() => queryClient.invalidateQueries({ queryKey: ["agent", "skills"] })} onRun={() => handleDispatch(skill.skillName, skill.prompt)} availableModels={availableModels} skillModels={skillModels} onModelChange={handleModelChange} />
              ))}
              {(!skills || skills.length === 0) && !showSkillBuilder && (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>No skills configured. They'll be created automatically on next restart.</div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {(skills || []).map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => handleDispatch(skill.skillName, skill.prompt)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-left transition-colors hover:bg-[var(--glass-hover)]"
                  style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
                >
                  <Play size={12} style={{ color: "var(--color-accent)" }} />
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
              ))}
            </div>
          )}
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
            <Bot size={32} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
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
          style={{ background: "var(--color-accent)", color: "white" }}
        >
          {saving ? "Creating..." : "Create Skill"}
        </button>
      </div>
    </div>
  );
}

// ─── Skill Config Card ───────────────────────────────────────

function SkillConfigCard({ skill, onUpdate, onRun, availableModels, skillModels, onModelChange }: { skill: AgentSkill; onUpdate: () => void; onRun: () => void; availableModels: Array<{ id: string; name: string; provider: string; size: string | null }>; skillModels: Record<string, { provider: string; model: string }>; onModelChange: (skillName: string, provider: string, model: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editPrompt, setEditPrompt] = useState(skill.prompt);
  const [saving, setSaving] = useState(false);

  const handleToggle = async () => {
    await agentApi.updateSkill(skill.id, { enabled: !skill.enabled });
    onUpdate();
  };

  const handleIntervalChange = async (secs: number) => {
    await agentApi.updateSkill(skill.id, { intervalSecs: secs });
    onUpdate();
  };

  const handleRunAtHourChange = async (hour: number) => {
    // Store runAtHour by updating skill metadata via a direct vault update
    const note = await vaultApi.getNote(skill.id);
    const meta = (note.metadata || {}) as Record<string, unknown>;
    await vaultApi.updateNote(skill.id, { metadata: { ...meta, runAtHour: hour } });
    onUpdate();
  };

  const handleSavePrompt = async () => {
    setSaving(true);
    await agentApi.updateSkill(skill.id, { prompt: editPrompt });
    setSaving(false);
    onUpdate();
  };

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={handleToggle} title={skill.enabled ? "Disable" : "Enable"}>
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
        <button onClick={onRun} className="p-1 rounded hover:bg-[var(--glass-hover)]" title="Run now">
          <Play size={12} style={{ color: "var(--color-accent)" }} />
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-2" style={{ borderTop: "1px solid var(--glass-border)" }}>
          <div className="flex items-center gap-2 pt-2 flex-wrap">
            <Clock size={11} style={{ color: "var(--text-muted)" }} />
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>Run:</span>
            <select
              value={skill.intervalSecs}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
              className="rounded px-1.5 py-0.5 text-[10px] outline-none"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
            >
              {INTERVAL_OPTIONS.map((opt) => (
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
                  style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
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

          {availableModels.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>Model:</span>
              <select
                value={skillModels[skill.skillName]?.provider || "claude"}
                onChange={(e) => onModelChange(skill.skillName, e.target.value, "")}
                className="rounded px-1.5 py-0.5 text-[10px] outline-none"
                style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
              >
                <option value="claude">Claude</option>
                <option value="ollama">Ollama</option>
              </select>
              <select
                value={skillModels[skill.skillName]?.model || "sonnet"}
                onChange={(e) => onModelChange(skill.skillName, skillModels[skill.skillName]?.provider || "claude", e.target.value)}
                className="rounded px-1.5 py-0.5 text-[10px] outline-none"
                style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
              >
                {availableModels
                  .filter(m => m.provider === (skillModels[skill.skillName]?.provider || "claude"))
                  .map(m => <option key={m.id} value={m.id}>{m.name}</option>)
                }
              </select>
            </div>
          )}

          <textarea
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            rows={6}
            className="w-full rounded px-2 py-1.5 text-[10px] outline-none resize-none font-mono"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          />
          {editPrompt !== skill.prompt && (
            <button
              onClick={handleSavePrompt}
              disabled={saving}
              className="px-3 py-1 rounded text-[10px] font-medium"
              style={{ background: "var(--color-accent)", color: "white" }}
            >
              {saving ? "Saving..." : "Save Prompt"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
