import { useMemo } from "react";
import { useWidgetData } from "../../../app/hooks/useWidgetData";
import { groupNotes } from "../../../lib/dashboard/filter-engine";
import type { DashboardWidgetConfig } from "../../../lib/dashboard/widget-registry";

interface ChartWidgetProps {
  config: DashboardWidgetConfig;
}

const DEFAULT_PALETTE = [
  "var(--color-accent)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-danger)",
  "#8b5cf6",
  "#06b6d4",
  "#f97316",
  "#ec4899",
];

interface Segment {
  label: string;
  count: number;
  color: string;
}

export function ChartWidget({ config }: ChartWidgetProps) {
  const { items, isLoading } = useWidgetData(config);
  const chartType = config.chartType ?? "bar";
  const segmentField = config.segmentField ?? "status";
  const customColors = config.colors;

  const segments: Segment[] = useMemo(() => {
    const grouped = groupNotes(items, { field: segmentField });
    return Array.from(grouped.entries()).map(([label, notes], i) => ({
      label,
      count: notes.length,
      color: customColors?.[i] ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
    }));
  }, [items, segmentField, customColors]);

  if (isLoading) {
    return (
      <div className="h-32 rounded animate-pulse" style={{ background: "var(--glass)" }} />
    );
  }

  if (segments.length === 0) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>
        No data to chart
      </div>
    );
  }

  return chartType === "donut" ? (
    <DonutChart segments={segments} />
  ) : (
    <BarChart segments={segments} />
  );
}

// ── Bar chart ───────────────────────────────────────────────────────

function BarChart({ segments }: { segments: Segment[] }) {
  const max = Math.max(...segments.map((s) => s.count), 1);

  return (
    <div className="space-y-2 py-1">
      {segments.map((seg) => (
        <div key={seg.label} className="flex items-center gap-2">
          <span
            className="text-xs w-20 truncate text-right flex-shrink-0"
            style={{ color: "var(--text-secondary)" }}
          >
            {seg.label}
          </span>
          <div className="flex-1 h-5 rounded-md overflow-hidden" style={{ background: "var(--glass)" }}>
            <div
              className="h-full rounded-md transition-all duration-500"
              style={{
                width: `${(seg.count / max) * 100}%`,
                background: seg.color,
                minWidth: seg.count > 0 ? 4 : 0,
              }}
            />
          </div>
          <span
            className="text-xs w-8 flex-shrink-0 text-right tabular-nums"
            style={{ color: "var(--text-muted)" }}
          >
            {seg.count}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Donut chart ─────────────────────────────────────────────────────

function DonutChart({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return null;

  const size = 120;
  const strokeWidth = 24;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let accumulated = 0;
  const arcs = segments.map((seg) => {
    const fraction = seg.count / total;
    const offset = accumulated;
    accumulated += fraction;
    return { ...seg, fraction, offset };
  });

  return (
    <div className="flex items-center gap-4 py-2 justify-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {arcs.map((arc) => (
          <circle
            key={arc.label}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${arc.fraction * circumference} ${circumference}`}
            strokeDashoffset={-arc.offset * circumference}
            strokeLinecap="butt"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ))}
        <text
          x={size / 2}
          y={size / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text-primary)"
          fontSize="20"
          fontWeight="700"
        >
          {total}
        </text>
      </svg>
      <div className="space-y-1.5">
        {arcs.map((arc) => (
          <div key={arc.label} className="flex items-center gap-2">
            <div
              className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
              style={{ background: arc.color }}
            />
            <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
              {arc.label}
            </span>
            <span
              className="text-xs tabular-nums"
              style={{ color: "var(--text-muted)" }}
            >
              {arc.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
