import { useWidgetData } from "../../../app/hooks/useWidgetData";
import { aggregateNotes } from "../../../lib/dashboard/filter-engine";
import type { DashboardWidgetConfig } from "../../../lib/dashboard/widget-registry";

interface ProgressWidgetProps {
  config: DashboardWidgetConfig;
}

const COLOR_MAP: Record<string, string> = {
  accent: "var(--color-accent)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
};

export function ProgressWidget({ config }: ProgressWidgetProps) {
  const { items, isLoading } = useWidgetData(config);
  const color =
    COLOR_MAP[config.accentColor ?? "success"] ?? "var(--color-success)";

  const total = items.length;
  const done = config.aggregateCondition
    ? aggregateNotes(items, "count-where", config.aggregateCondition)
    : 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const template = config.labelTemplate ?? "{done}/{total} ({percent}%)";
  const label = template
    .replace("{done}", String(done))
    .replace("{total}", String(total))
    .replace("{percent}", String(percent));

  if (isLoading) {
    return (
      <div className="space-y-2 py-2">
        <div
          className="h-3 rounded-full animate-pulse"
          style={{ background: "var(--glass)" }}
        />
        <div
          className="h-4 w-24 rounded animate-pulse"
          style={{ background: "var(--glass)" }}
        />
      </div>
    );
  }

  return (
    <div className="py-2">
      {/* Bar */}
      <div
        className="h-3 rounded-full overflow-hidden"
        style={{ background: "var(--glass)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${percent}%`,
            background: color,
          }}
        />
      </div>

      {/* Label */}
      <div className="text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
        {label}
      </div>
    </div>
  );
}
