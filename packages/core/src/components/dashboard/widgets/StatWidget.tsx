import {
  FileText,
  Hash,
  CheckSquare,
  Tags,
  Link2,
  Users,
  Star,
  Zap,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { useWidgetData } from "../../../app/hooks/useWidgetData";
import type { DashboardWidgetConfig } from "../../../lib/dashboard/widget-registry";

interface StatWidgetProps {
  config: DashboardWidgetConfig;
}

const ICON_MAP: Record<string, LucideIcon> = {
  FileText,
  Hash,
  CheckSquare,
  Tags,
  Link2,
  Users,
  Star,
  Zap,
  Clock,
};

const COLOR_MAP: Record<string, string> = {
  accent: "var(--color-accent)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
};

export function StatWidget({ config }: StatWidgetProps) {
  const { aggregate, isLoading } = useWidgetData(config);
  const Icon = ICON_MAP[config.icon ?? "Hash"] ?? Hash;
  const color = COLOR_MAP[config.accentColor ?? "accent"] ?? "var(--color-accent)";

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-4">
        <div
          className="h-10 w-20 rounded animate-pulse"
          style={{ background: "var(--glass)" }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-4">
      <Icon size={20} style={{ color }} />
      <div
        className="text-3xl font-bold mt-2"
        style={{ color: "var(--text-primary)" }}
      >
        {aggregate != null ? aggregate.toLocaleString() : "—"}
      </div>
      <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
        {config.title}
      </div>
    </div>
  );
}
