import { useState, useCallback } from "react";
import { Settings, Plus, Pencil } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { Button } from "../ui/Button";
import { DashboardWidgetWrapper } from "../dashboard/DashboardWidget";
import { WidgetEditorModal } from "../dashboard/editor/WidgetEditorModal";
import type { DashboardWidgetConfig } from "../../lib/dashboard/widget-registry";

// New widget components
import { ListWidget } from "../dashboard/widgets/ListWidget";
import { BoardWidget } from "../dashboard/widgets/BoardWidget";
import { GalleryWidget } from "../dashboard/widgets/GalleryWidget";
import { StatWidget } from "../dashboard/widgets/StatWidget";
import { ProgressWidget } from "../dashboard/widgets/ProgressWidget";
import { TimelineWidget } from "../dashboard/widgets/TimelineWidget";
import { ChartWidget } from "../dashboard/widgets/ChartWidget";
import { EmbedWidget } from "../dashboard/widgets/EmbedWidget";
import { QuickActionsWidget } from "../dashboard/widgets/QuickActionsWidget";

// Legacy widget components (kept for backward compat with old widget type names)
import { TaskListWidget } from "../dashboard/widgets/TaskListWidget";
import { NoteListWidget } from "../dashboard/widgets/NoteListWidget";
import { StatCardWidget } from "../dashboard/widgets/StatCardWidget";
import { CalendarWidget } from "../dashboard/widgets/CalendarWidget";

// ── Render dispatch ─────────────────────────────────────────────────

function renderWidget(widget: DashboardWidgetConfig) {
  switch (widget.type as string) {
    case "list":
      return <ListWidget config={widget} />;
    case "board":
      return <BoardWidget config={widget} />;
    case "gallery":
      return <GalleryWidget config={widget} />;
    case "stat":
      return <StatWidget config={widget} />;
    case "progress":
      return <ProgressWidget config={widget} />;
    case "timeline":
      return <TimelineWidget config={widget} />;
    case "chart":
      return <ChartWidget config={widget} />;
    case "embed":
      return <EmbedWidget config={widget} />;
    case "quick-actions":
      return <QuickActionsWidget config={widget} />;

    // Legacy types (from old DashboardWidget union)
    case "task-list":
      return <TaskListWidget filter={widget.source?.metadataFilters} />;
    case "note-list":
      return <NoteListWidget filter={widget.source?.metadataFilters} />;
    case "stat-card":
      return <StatCardWidget />;
    case "calendar":
      return <CalendarWidget />;

    default:
      return (
        <div className="text-sm py-2" style={{ color: "var(--text-muted)" }}>
          Unknown widget type: {widget.type}
        </div>
      );
  }
}

// ── Main component ──────────────────────────���───────────────────────

export default function DashboardRenderer({ note, onMetadataChange }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const layout = meta?.layout as
    | { columns?: number; widgets: DashboardWidgetConfig[] }
    | undefined;
  const widgets: DashboardWidgetConfig[] = layout?.widgets ?? [];
  const columns = layout?.columns ?? 2;

  const [editMode, setEditMode] = useState(false);
  const [editorWidget, setEditorWidget] = useState<DashboardWidgetConfig | null | undefined>(
    undefined,
  ); // undefined = closed, null = new widget, DashboardWidgetConfig = editing

  const dashboardTitle =
    note.path?.split("/").pop() || (meta?.title as string) || "Dashboard";

  const updateWidgets = useCallback(
    (newWidgets: DashboardWidgetConfig[]) => {
      onMetadataChange({
        ...((meta || {}) as Record<string, unknown>),
        layout: { columns, widgets: newWidgets },
      });
    },
    [meta, columns, onMetadataChange],
  );

  const handleSaveWidget = useCallback(
    (config: DashboardWidgetConfig) => {
      const existing = widgets.findIndex((w) => w.id === config.id);
      if (existing >= 0) {
        const next = [...widgets];
        next[existing] = config;
        updateWidgets(next);
      } else {
        updateWidgets([...widgets, config]);
      }
      setEditorWidget(undefined);
    },
    [widgets, updateWidgets],
  );

  const handleRemoveWidget = useCallback(
    (widgetId: string) => {
      updateWidgets(widgets.filter((w) => w.id !== widgetId));
    },
    [widgets, updateWidgets],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{
          borderBottom: "1px solid var(--glass-border)",
          background: "var(--bg-surface)",
        }}
      >
        <span
          className="text-sm font-medium"
          style={{ color: "var(--text-primary)" }}
        >
          {dashboardTitle}
        </span>
        <Button
          size="sm"
          variant={editMode ? "primary" : "ghost"}
          icon={<Settings size={14} />}
          onClick={() => {
            setEditMode(!editMode);
          }}
        >
          {editMode ? "Done" : "Edit Dashboard"}
        </Button>
      </div>

      {/* Dashboard grid */}
      <div className="flex-1 overflow-auto p-4">
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {widgets.map((widget) => (
            <div
              key={widget.id}
              style={{
                gridColumn: widget.span
                  ? `span ${Math.min(widget.span, columns)}`
                  : undefined,
              }}
            >
              <DashboardWidgetWrapper
                title={widget.title}
                editMode={editMode}
                onRemove={() => handleRemoveWidget(widget.id)}
                editActions={
                  editMode ? (
                    <button
                      onClick={() => setEditorWidget(widget)}
                      className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
                      style={{ color: "var(--text-muted)" }}
                      title="Edit widget"
                    >
                      <Pencil size={13} />
                    </button>
                  ) : undefined
                }
              >
                {renderWidget(widget)}
              </DashboardWidgetWrapper>
            </div>
          ))}
        </div>

        {/* Empty state */}
        {widgets.length === 0 && !editMode && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <p
              className="text-sm"
              style={{ color: "var(--text-muted)" }}
            >
              This dashboard is empty
            </p>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={14} />}
              onClick={() => {
                setEditMode(true);
                setEditorWidget(null);
              }}
            >
              Add Widget
            </Button>
          </div>
        )}

        {/* Add widget button in edit mode */}
        {editMode && (
          <div className="mt-4">
            <button
              onClick={() => setEditorWidget(null)}
              className="w-full flex items-center justify-center gap-2 px-4 py-6 rounded-lg transition-colors hover:bg-[var(--glass-hover)]"
              style={{
                border: "2px dashed var(--glass-border)",
                color: "var(--text-muted)",
              }}
            >
              <Plus size={16} />
              <span className="text-sm">Add Widget</span>
            </button>
          </div>
        )}
      </div>

      {/* Widget editor modal */}
      {editorWidget !== undefined && (
        <WidgetEditorModal
          initial={editorWidget}
          onSave={handleSaveWidget}
          onClose={() => setEditorWidget(undefined)}
        />
      )}
    </div>
  );
}
