import type { ReactNode } from "react";
import { X } from "lucide-react";

interface DashboardWidgetWrapperProps {
  title?: string;
  count?: number;
  editMode?: boolean;
  onRemove?: () => void;
  children: ReactNode;
}

export function DashboardWidgetWrapper({
  title,
  count,
  editMode,
  onRemove,
  children,
}: DashboardWidgetWrapperProps) {
  return (
    <div
      className="glass rounded-xl overflow-hidden"
      style={{ border: "1px solid var(--glass-border)" }}
    >
      {/* Widget header */}
      {(title || editMode) && (
        <div
          className="flex items-center gap-2 px-4 py-2.5"
          style={{ borderBottom: "1px solid var(--glass-border)" }}
        >
          {title && (
            <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
              {title}
            </span>
          )}
          {count !== undefined && (
            <span
              className="text-xs px-1.5 rounded-full"
              style={{ background: "var(--glass)", color: "var(--text-muted)" }}
            >
              {count}
            </span>
          )}
          {editMode && onRemove && (
            <button
              onClick={onRemove}
              className="ml-auto p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
              style={{ color: "var(--text-muted)" }}
              title="Remove widget"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* Widget content */}
      <div className="p-4">{children}</div>
    </div>
  );
}
