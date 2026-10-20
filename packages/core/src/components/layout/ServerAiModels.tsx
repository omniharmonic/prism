/**
 * Settings → AI models on a thin client (parity A) — replaces the desktop's
 * "AI Models" table + "Local AI" section in non-desktop shells. Everything lives
 * on the Prism Server (server owner only):
 *   - the local models its LM Studio offers (GET /api/agent/models);
 *   - per-skill routing for the interactive skills edit / chat / transform /
 *     generate (GET/PUT /api/agent/routing) — honoured by the server-run inline
 *     edit and transform; agent chat sessions always run on Claude;
 *   - a server-side "Test" round trip per route (POST /api/agent/routing/test).
 * The laptop's own Ollama / LM Studio are not involved.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { hostServiceErrorText, INTERACTIVE_SKILLS, type HostServices, type InteractiveSkill, type RouteTestResult, type SkillRoute } from "../../lib/host/services";

const SKILL_HELP: Record<InteractiveSkill, string> = {
  edit: "Inline edit (⌘J)",
  chat: "Chat-style one-shot prompts (agent chat sessions always use Claude)",
  transform: "Transform a note (presentation, email draft…)",
  generate: "Generate text",
};

export function ServerAiModels({ host }: { host: HostServices }) {
  const queryClient = useQueryClient();
  const scope = host.scope?.() ?? "";
  const models = useQuery({ queryKey: ["agent-models", scope], queryFn: () => host.agentModels(), staleTime: 30_000 });
  const routing = useQuery({ queryKey: ["agent-routing", scope], queryFn: () => host.getRouting() });
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<InteractiveSkill, RouteTestResult | "running">>>({});

  const localModels = (models.data?.local.models ?? []).filter((m) => m.type === null || m.type === "llm" || m.type === "vlm");
  const claudeModels = models.data?.claude.models ?? ["sonnet", "opus", "haiku"];

  const save = async (skill: InteractiveSkill, route: SkillRoute) => {
    setError(null);
    try {
      const next = await host.setRouting({ [skill]: route });
      queryClient.setQueryData(["agent-routing", scope], next);
      setTests((t) => ({ ...t, [skill]: undefined }));
    } catch (e) {
      setError(hostServiceErrorText(e));
    }
  };

  const test = async (skill: InteractiveSkill, route: SkillRoute) => {
    setTests((t) => ({ ...t, [skill]: "running" }));
    try {
      const r = await host.testRoute(route);
      setTests((t) => ({ ...t, [skill]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [skill]: { ok: false, provider: route.provider, model: route.model, ms: 0, error: hostServiceErrorText(e) } }));
    }
  };

  const selectStyle = { background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" };
  const local = models.data?.local;

  return (
    <div className="space-y-3" data-testid="server-ai-models">
      <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
        These run on your Prism Server. "Local" uses the server's LM Studio (the same one background skills use), behind the same memory guard; if it refuses, the
        request fails rather than silently switching to Claude.
      </p>

      <div className="rounded-lg px-3 py-2 text-[11px] space-y-1" style={{ border: "1px solid var(--glass-border)", background: "var(--glass)" }}>
        <div className="flex items-center gap-2" style={{ color: "var(--text-secondary)" }}>
          <span className="font-medium" style={{ color: "var(--text-primary)" }}>Local models</span>
          {models.isLoading ? (
            <Loader2 size={11} className="animate-spin" />
          ) : !local?.configured ? (
            <span>not configured on the server (SKILLS_LOCAL_BASE_URL)</span>
          ) : local.reachable ? (
            <span style={{ color: "var(--color-success)" }}>reachable · {localModels.length} model{localModels.length === 1 ? "" : "s"}</span>
          ) : (
            <span style={{ color: "var(--color-danger)" }}>unreachable{local.error ? ` (${local.error})` : ""}</span>
          )}
          <button onClick={() => models.refetch()} className="ml-auto text-[10px] underline" style={{ color: "var(--text-muted)" }}>
            Refresh
          </button>
        </div>
        {localModels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {localModels.map((m) => (
              <span key={m.id} className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}>
                {m.id}
                {m.state === "loaded" ? " · loaded" : ""}
              </span>
            ))}
          </div>
        )}
        <div style={{ color: "var(--text-muted)" }}>
          Claude: {models.data ? (models.data.claude.available ? "available on the server" : "CLI not found on the server") : "…"}
          {models.data?.skillsLocalModel ? ` · background skills default local model: ${models.data.skillsLocalModel}` : ""}
        </div>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
        <div className="grid grid-cols-[1fr_90px_1fr_60px] gap-0 px-3 py-1.5" style={{ background: "var(--glass)", borderBottom: "1px solid var(--glass-border)" }}>
          {["Skill", "Provider", "Model", ""].map((h) => (
            <span key={h} className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{h}</span>
          ))}
        </div>
        {INTERACTIVE_SKILLS.map((skill) => {
          const current = routing.data?.[skill] ?? { provider: "claude" as const, model: "sonnet" };
          const t = tests[skill];
          return (
            <div key={skill} className="px-3 py-1.5" style={{ borderBottom: "1px solid var(--glass-border)" }} data-testid={`route-row-${skill}`}>
              <div className="grid grid-cols-[1fr_90px_1fr_60px] gap-2 items-center">
                <span className="text-xs capitalize" style={{ color: "var(--text-primary)" }} title={SKILL_HELP[skill]}>{skill}</span>
                <select
                  value={current.provider}
                  onChange={(e) => {
                    const provider = e.target.value as SkillRoute["provider"];
                    if (provider === "claude") void save(skill, { provider, model: "sonnet" });
                    else if (localModels[0]) void save(skill, { provider, model: localModels[0].id });
                    else setError("No local model is available on the server yet.");
                  }}
                  className="h-6 rounded px-1 text-[10px] outline-none"
                  style={selectStyle}
                  aria-label={`${skill} provider`}
                >
                  <option value="claude">Claude</option>
                  <option value="local">Local</option>
                </select>
                <select
                  value={current.model}
                  onChange={(e) => void save(skill, { provider: current.provider, model: e.target.value })}
                  className="h-6 rounded px-1 text-[10px] outline-none"
                  style={selectStyle}
                  aria-label={`${skill} model`}
                >
                  {(current.provider === "claude" ? claudeModels : localModels.map((m) => m.id)).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {current.provider === "local" && !localModels.some((m) => m.id === current.model) && (
                    <option value={current.model}>{current.model} (not on the server)</option>
                  )}
                </select>
                <button
                  onClick={() => void test(skill, current)}
                  disabled={t === "running"}
                  className="h-6 rounded text-[10px] disabled:opacity-50 hover:bg-[var(--glass-hover)]"
                  style={{ border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }}
                  title="Run a tiny test on the server with this route"
                >
                  {t === "running" ? <Loader2 size={10} className="animate-spin mx-auto" /> : "Test"}
                </button>
              </div>
              {t && t !== "running" && (
                <div className="text-[10px] mt-1" style={{ color: t.ok ? "var(--color-success)" : "var(--color-danger)" }}>
                  {t.ok ? `OK in ${t.ms} ms${t.reply ? ` — "${t.reply}"` : ""}` : `Failed: ${t.error ?? "unknown error"}`}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="text-[11px]" style={{ color: "var(--color-danger)" }}>{error}</div>}
    </div>
  );
}
