import { useState, useCallback } from "react";
import { Settings, Plus, X } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import type { DashboardWidget } from "../../lib/types";
import { Button } from "../ui/Button";
import { DashboardWidgetWrapper } from "../dashboard/DashboardWidget";
import { TaskListWidget } from "../dashboard/widgets/TaskListWidget";
import { NoteListWidget } from "../dashboard/widgets/NoteListWidget";
import { StatCardWidget } from "../dashboard/widgets/StatCardWidget";
import { CalendarWidget } from "../dashboard/widgets/CalendarWidget";

const WIDGET_TYPES: { type: DashboardWidget["type"]; label: string; description: string }[] = [
  { type: "stat-card", label: "Vault Stats", description: "Note count, tag count, link count" },
  { type: "task-list", label: "Task List", description: "Tasks filtered by status or project" },
  { type: "note-list", label: "Note List", description: "Notes filtered by tag or path" },
  { type: "calendar", label: "Today's Events", description: "Calendar events for today" },
];

function renderWidget(widget: DashboardWidget) {
  switch (widget.type) {
    case "task-list":
      return <TaskListWidget filter={widget.filter} />;
    case "note-list":
      return <NoteListWidget filter={widget.filter} />;
    case "stat-card":
      return <StatCardWidget />;
    case "calendar":
      return <CalendarWidget />;
    default:
      return (
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>
          Unknown widget type
        </div>
      );
  }
}

export default function DashboardRenderer({ note, onMetadataChange }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const layout = meta?.layout as { columns?: number; widgets: DashboardWidget[] } | undefined;
  const widgets = layout?.widgets ?? [];
  const columns = layout?.columns ?? 2;

  const [editMode, setEditMode] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const dashboardTitle = note.path?.split("/").pop() || (meta?.title as string) || "Dashboard";

  const updateWidgets = useCallback(
    (newWidgets: DashboardWidget[]) => {
      onMetadataChange({
        ...((meta || {}) as Record<string, unknown>),
        layout: { columns, widgets: newWidgets },
      });
    },
    [meta, columns, onMetadataChange],
  );

  const handleAddWidget = (type: DashboardWidget["type"]) => {
    const id = `w-${Date.now()}`;
    const label = WIDGET_TYPES.find((w) => w.type === type)?.label ?? type;
    const newWidget: DashboardWidget = { id, type, title: label };
    updateWidgets([...widgets, newWidget]);
    setShowPicker(false);
  };

  const handleRemoveWidget = (widgetId: string) => {
    updateWidgets(widgets.filter((w) => w.id !== widgetId));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {dashboardTitle}
        </span>
        <Button
          size="sm"
          variant={editMode ? "primary" : "ghost"}
          icon={<Settings size={14} />}
          onClick={() => {
            setEditMode(!editMode);
            setShowPicker(false);
          }}
        >
          {editMode ? "Done" : "Edit Dashboard"}
        </Button>
      </div>

      {/* Dashboard grid */}
      <div className="flex-1 overflow-auto p-4">
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
          }}
        >
          {widgets.map((widget) => (
            <div
              key={widget.id}
              style={{ gridColumn: widget.span ? `span ${widget.span}` : undefined }}
            >
              <DashboardWidgetWrapper
                title={widget.title}
                editMode={editMode}
                onRemove={() => handleRemoveWidget(widget.id)}
              >
                {renderWidget(widget)}
              </DashboardWidgetWrapper>
            </div>
          ))}
        </div>

        {/* Empty state */}
        {widgets.length === 0 && !editMode && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              This dashboard is empty
            </p>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={14} />}
              onClick={() => {
                setEditMode(true);
                setShowPicker(true);
              }}
            >
              Add Widget
            </Button>
          </div>
        )}

        {/* Add widget button in edit mode */}
        {editMode && (
          <div className="mt-4">
            {!showPicker ? (
              <button
                onClick={() => setShowPicker(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-6 rounded-lg transition-colors hover:bg-[var(--glass-hover)]"
                style={{
                  border: "2px dashed var(--glass-border)",
                  color: "var(--text-muted)",
                }}
              >
                <Plus size={16} />
                <span className="text-sm">Add Widget</span>
              </button>
            ) : (
              <WidgetPicker onSelect={handleAddWidget} onClose={() => setShowPicker(false)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WidgetPicker({
  onSelect,
  onClose,
}: {
  onSelect: (type: DashboardWidget["type"]) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="glass-elevated rounded-xl p-4 space-y-3"
      style={{ border: "1px solid var(--glass-border)" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          Add Widget
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          <X size={14} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {WIDGET_TYPES.map(({ type, label, description }) => (
          <button
            key={type}
            onClick={() => onSelect(type)}
            className="text-left p-3 rounded-lg hover:bg-[var(--glass-hover)] transition-colors"
            style={{ border: "1px solid var(--glass-border)" }}
          >
            <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
              {label}
            </div>
            <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              {description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
