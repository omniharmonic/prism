import { useAgentLimits } from "../../data/AgentClientContext";
import { formatAgentBudget, formatAgentCost } from "../../lib/agent/cost";

/**
 * Read-only budget display (WP3.4): today's spend vs the daily cap and what is
 * left, plus the per-session cap. Budgets are SERVER config (AGENT_DAILY_BUDGET_USD /
 * AGENT_SESSION_BUDGET_USD) — nothing here edits them. Renders nothing on a
 * server that predates /api/agent/limits.
 */
export function AgentBudgetLine({ sessionCostUsd }: { sessionCostUsd?: number }) {
  const limits = useAgentLimits();
  if (!limits) return null;
  const { billing, daily, session } = limits;
  const parts: Array<{ key: string; text: string; title?: string }> = [];
  if (daily.limitUsd != null) {
    const spent = formatAgentCost(daily.spentUsd, billing)!;
    const left = formatAgentBudget(daily.remainingUsd ?? 0, billing);
    parts.push({
      key: "daily",
      text: `Today ${spent.text} of ${formatAgentBudget(daily.limitUsd, billing).text} · ${left.text} left`,
      title: spent.title,
    });
  }
  if (session.limitUsd != null && sessionCostUsd != null) {
    const s = formatAgentCost(sessionCostUsd, billing)!;
    parts.push({ key: "session", text: `This session ${s.text} of ${formatAgentBudget(session.limitUsd, billing).text}`, title: s.title });
  }
  if (parts.length === 0) return null;
  const exhausted = daily.limitUsd != null && (daily.remainingUsd ?? 0) <= 0;
  return (
    <div
      className="flex flex-wrap gap-x-2 text-[11px]"
      style={{ color: exhausted ? "var(--color-danger)" : "var(--text-muted)" }}
      data-testid="agent-budget-line"
    >
      {parts.map((p) => (
        <span key={p.key} title={p.title}>
          {p.text}
        </span>
      ))}
    </div>
  );
}
