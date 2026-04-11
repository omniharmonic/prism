import { useState, useCallback } from "react";
import {
  X,
  List,
  Columns3,
  LayoutGrid,
  Hash,
  BarChart3,
  Clock,
  PieChart,
  FileText,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { DataSourceEditor } from "./DataSourceEditor";
import {
  WIDGET_TYPES,
  getWidgetType,
  type DashboardWidgetConfig,
  type WidgetTypeId,
  type WidgetColumn,
  type QuickAction,
} from "../../../lib/dashboard/widget-registry";
import type { DataSource, SortConfig, GroupConfig } from "../../../lib/dashboard/filter-engine";

interface WidgetEditorModalProps {
  initial?: DashboardWidgetConfig | null;
  onSave: (config: DashboardWidgetConfig) => void;
  onClose: () => void;
}

const ICON_MAP: Record<string, LucideIcon> = {
  List,
  Columns3,
  LayoutGrid,
  Hash,
  BarChart3,
  Clock,
  PieChart,
  FileText,
  Zap,
};

export function WidgetEditorModal({
  initial,
  onSave,
  onClose,
}: WidgetEditorModalProps) {
  const isNew = !initial;

  const [widgetType, setWidgetType] = useState<WidgetTypeId>(
    initial?.type ?? "list",
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [span, setSpan] = useState(initial?.span ?? 1);
  const [density, setDensity] = useState<"compact" | "normal">(
    initial?.density ?? "normal",
  );
  const [source, setSource] = useState<DataSource>(initial?.source ?? {});
  const [sort, setSort] = useState<SortConfig | null>(initial?.sort ?? null);
  const [group, setGroup] = useState<GroupConfig | null>(
    initial?.group ?? null,
  );

  // Type-specific
  const [columns, setColumns] = useState<WidgetColumn[]>(
    initial?.columns ?? [
      { field: "path", label: "Title" },
      { field: "updatedAt", label: "Updated" },
    ],
  );
  const [cardFields, setCardFields] = useState(
    (initial?.cardFields ?? []).join(", "),
  );
  const [chartType, setChartType] = useState<"bar" | "donut">(
    initial?.chartType ?? "bar",
  );
  const [segmentField, setSegmentField] = useState(
    initial?.segmentField ?? "status",
  );
  const [aggregateType, setAggregateType] = useState(
    initial?.aggregateType ?? "count",
  );
  const [aggregateConditionStr, setAggregateConditionStr] = useState(
    initial?.aggregateCondition
      ? JSON.stringify(initial.aggregateCondition)
      : '{"status":"done"}',
  );
  const [iconName, setIconName] = useState(initial?.icon ?? "Hash");
  const [accentColor, setAccentColor] = useState(
    initial?.accentColor ?? "accent",
  );
  const [labelTemplate, setLabelTemplate] = useState(
    initial?.labelTemplate ?? "{done}/{total} ({percent}%)",
  );
  const [dateField, setDateField] = useState(
    initial?.dateField ?? "createdAt",
  );
  const [noteId, setNoteId] = useState(initial?.noteId ?? "");
  const [maxHeight, setMaxHeight] = useState(initial?.maxHeight ?? 300);
  const [columnCount, setColumnCount] = useState(initial?.columnCount ?? 3);
  const [actionsJson, setActionsJson] = useState(
    initial?.actions ? JSON.stringify(initial.actions, null, 2) : "[]",
  );

  // When type changes, apply defaults
  const handleTypeChange = useCallback(
    (type: WidgetTypeId) => {
      setWidgetType(type);
      const meta = getWidgetType(type);
      if (meta && isNew) {
        setTitle(meta.label);
      }
    },
    [isNew],
  );

  const handleSave = () => {
    let parsedCondition: Record<string, unknown> | undefined;
    try {
      parsedCondition = JSON.parse(aggregateConditionStr);
    } catch {
      parsedCondition = undefined;
    }

    let parsedActions: QuickAction[] | undefined;
    try {
      parsedActions = JSON.parse(actionsJson);
    } catch {
      parsedActions = undefined;
    }

    const config: DashboardWidgetConfig = {
      id: initial?.id ?? `w-${Date.now()}`,
      type: widgetType,
      title: title || getWidgetType(widgetType)?.label || widgetType,
      span: span > 1 ? span : undefined,
      density: density !== "normal" ? density : undefined,
      source: Object.keys(source).length > 0 ? source : undefined,
      sort: sort ?? undefined,
      group: group ?? undefined,
      columns: widgetType === "list" ? columns : undefined,
      cardFields:
        ["board", "gallery", "timeline"].includes(widgetType) && cardFields
          ? cardFields
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      chartType: widgetType === "chart" ? chartType : undefined,
      segmentField: widgetType === "chart" ? segmentField : undefined,
      aggregateType: ["stat", "progress"].includes(widgetType)
        ? aggregateType
        : undefined,
      aggregateCondition:
        ["stat", "progress"].includes(widgetType) && parsedCondition
          ? parsedCondition
          : undefined,
      icon: widgetType === "stat" ? iconName : undefined,
      accentColor: ["stat", "progress"].includes(widgetType)
        ? accentColor
        : undefined,
      labelTemplate: widgetType === "progress" ? labelTemplate : undefined,
      dateField: widgetType === "timeline" ? dateField : undefined,
      noteId: widgetType === "embed" ? noteId || undefined : undefined,
      maxHeight: widgetType === "embed" ? maxHeight : undefined,
      columnCount: widgetType === "gallery" ? columnCount : undefined,
      actions:
        widgetType === "quick-actions" ? parsedActions : undefined,
    };

    onSave(config);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(8px)" }}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] flex rounded-2xl overflow-hidden"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--glass-border)",
        }}
      >
        {/* Left sidebar — widget type selector */}
        <div
          className="w-48 flex-shrink-0 p-3 space-y-1 overflow-y-auto"
          style={{
            borderRight: "1px solid var(--glass-border)",
            background: "var(--glass)",
          }}
        >
          <div
            className="text-xs font-medium px-2 py-1 mb-2"
            style={{ color: "var(--text-muted)" }}
          >
            Widget Type
          </div>
          {WIDGET_TYPES.map((wt) => {
            const Icon = ICON_MAP[wt.icon] ?? FileText;
            const isActive = widgetType === wt.id;
            return (
              <button
                key={wt.id}
                onClick={() => handleTypeChange(wt.id)}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-colors"
                style={{
                  background: isActive
                    ? "var(--color-accent)"
                    : "transparent",
                  color: isActive ? "white" : "var(--text-primary)",
                }}
              >
                <Icon size={15} />
                {wt.label}
              </button>
            );
          })}
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-3 flex-shrink-0"
            style={{ borderBottom: "1px solid var(--glass-border)" }}
          >
            <span
              className="text-sm font-medium"
              style={{ color: "var(--text-primary)" }}
            >
              {isNew ? "Add Widget" : "Edit Widget"}
            </span>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={16} />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {/* Title */}
            <Section label="Title">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Widget title"
              />
            </Section>

            {/* Data Source */}
            <Section label="Data Source">
              <DataSourceEditor value={source} onChange={setSource} />
            </Section>

            {/* Sort */}
            <Section label="Sort">
              <div className="flex gap-2">
                <Input
                  placeholder="Field (e.g. updatedAt)"
                  value={sort?.field ?? ""}
                  onChange={(e) =>
                    setSort(
                      e.target.value
                        ? { field: e.target.value, direction: sort?.direction ?? "desc" }
                        : null,
                    )
                  }
                  className="flex-1"
                />
                <select
                  className="h-8 rounded-lg px-2 text-sm"
                  style={{
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    color: "var(--text-primary)",
                  }}
                  value={sort?.direction ?? "desc"}
                  onChange={(e) =>
                    setSort(
                      sort
                        ? { ...sort, direction: e.target.value as "asc" | "desc" }
                        : null,
                    )
                  }
                >
                  <option value="asc">Asc</option>
                  <option value="desc">Desc</option>
                </select>
              </div>
            </Section>

            {/* Group (board, chart) */}
            {["board", "chart", "list"].includes(widgetType) && (
              <Section label="Group By">
                <div className="flex gap-2">
                  <Input
                    placeholder="Metadata field (e.g. status)"
                    value={group?.field ?? ""}
                    onChange={(e) =>
                      setGroup(
                        e.target.value
                          ? { field: e.target.value, order: group?.order }
                          : null,
                      )
                    }
                    className="flex-1"
                  />
                  <Input
                    placeholder="Custom order (comma separated)"
                    value={group?.order?.join(", ") ?? ""}
                    onChange={(e) =>
                      setGroup(
                        group
                          ? {
                              ...group,
                              order: e.target.value
                                ? e.target.value.split(",").map((s) => s.trim())
                                : undefined,
                            }
                          : null,
                      )
                    }
                    className="flex-1"
                  />
                </div>
              </Section>
            )}

            {/* Type-specific config */}
            {widgetType === "list" && (
              <Section label="Columns">
                <div className="space-y-2">
                  {columns.map((col, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <Input
                        placeholder="Field"
                        value={col.field}
                        onChange={(e) => {
                          const next = [...columns];
                          next[i] = { ...col, field: e.target.value };
                          setColumns(next);
                        }}
                        className="flex-1"
                      />
                      <Input
                        placeholder="Label"
                        value={col.label}
                        onChange={(e) => {
                          const next = [...columns];
                          next[i] = { ...col, label: e.target.value };
                          setColumns(next);
                        }}
                        className="flex-1"
                      />
                      <button
                        onClick={() =>
                          setColumns(columns.filter((_, j) => j !== i))
                        }
                        className="p-1 rounded hover:bg-[var(--glass-hover)]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setColumns([...columns, { field: "", label: "" }])
                    }
                  >
                    + Add Column
                  </Button>
                </div>
              </Section>
            )}

            {["board", "gallery", "timeline"].includes(widgetType) && (
              <Section label="Card Fields">
                <Input
                  placeholder="Comma-separated metadata fields"
                  value={cardFields}
                  onChange={(e) => setCardFields(e.target.value)}
                />
              </Section>
            )}

            {widgetType === "gallery" && (
              <Section label="Column Count">
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={columnCount}
                  onChange={(e) => setColumnCount(parseInt(e.target.value, 10))}
                  className="w-full"
                />
                <div className="text-xs text-center" style={{ color: "var(--text-muted)" }}>
                  {columnCount}
                </div>
              </Section>
            )}

            {widgetType === "chart" && (
              <>
                <Section label="Chart Type">
                  <div className="flex gap-2">
                    {(["bar", "donut"] as const).map((ct) => (
                      <button
                        key={ct}
                        onClick={() => setChartType(ct)}
                        className="px-3 py-1.5 rounded-lg text-sm transition-colors"
                        style={{
                          background:
                            chartType === ct
                              ? "var(--color-accent)"
                              : "var(--glass)",
                          color: chartType === ct ? "white" : "var(--text-primary)",
                          border: "1px solid var(--glass-border)",
                        }}
                      >
                        {ct.charAt(0).toUpperCase() + ct.slice(1)}
                      </button>
                    ))}
                  </div>
                </Section>
                <Section label="Segment Field">
                  <Input
                    placeholder="e.g. status"
                    value={segmentField}
                    onChange={(e) => setSegmentField(e.target.value)}
                  />
                </Section>
              </>
            )}

            {["stat", "progress"].includes(widgetType) && (
              <>
                <Section label="Aggregate">
                  <select
                    className="w-full h-8 rounded-lg px-3 text-sm"
                    style={{
                      background: "var(--glass)",
                      border: "1px solid var(--glass-border)",
                      color: "var(--text-primary)",
                    }}
                    value={aggregateType}
                    onChange={(e) => setAggregateType(e.target.value as typeof aggregateType)}
                  >
                    <option value="count">Count</option>
                    <option value="count-where">Count Where</option>
                    <option value="percentage-where">Percentage Where</option>
                  </select>
                </Section>
                {aggregateType !== "count" && (
                  <Section label="Condition (JSON)">
                    <Input
                      placeholder='{"status":"done"}'
                      value={aggregateConditionStr}
                      onChange={(e) => setAggregateConditionStr(e.target.value)}
                    />
                  </Section>
                )}
                <Section label="Accent Color">
                  <div className="flex gap-2">
                    {["accent", "success", "warning", "danger"].map((c) => (
                      <button
                        key={c}
                        onClick={() => setAccentColor(c)}
                        className="px-3 py-1.5 rounded-lg text-xs transition-colors"
                        style={{
                          background:
                            accentColor === c
                              ? `var(--color-${c})`
                              : "var(--glass)",
                          color:
                            accentColor === c ? "white" : "var(--text-primary)",
                          border: "1px solid var(--glass-border)",
                        }}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </Section>
              </>
            )}

            {widgetType === "stat" && (
              <Section label="Icon">
                <Input
                  placeholder="Lucide icon name (e.g. Hash, FileText)"
                  value={iconName}
                  onChange={(e) => setIconName(e.target.value)}
                />
              </Section>
            )}

            {widgetType === "progress" && (
              <Section label="Label Template">
                <Input
                  placeholder="{done}/{total} ({percent}%)"
                  value={labelTemplate}
                  onChange={(e) => setLabelTemplate(e.target.value)}
                />
              </Section>
            )}

            {widgetType === "timeline" && (
              <Section label="Date Field">
                <Input
                  placeholder="createdAt, updatedAt, or metadata field"
                  value={dateField}
                  onChange={(e) => setDateField(e.target.value)}
                />
              </Section>
            )}

            {widgetType === "embed" && (
              <>
                <Section label="Note ID">
                  <Input
                    placeholder="Paste the note ID to embed"
                    value={noteId}
                    onChange={(e) => setNoteId(e.target.value)}
                  />
                </Section>
                <Section label="Max Height (px)">
                  <Input
                    type="number"
                    value={maxHeight}
                    onChange={(e) =>
                      setMaxHeight(parseInt(e.target.value, 10) || 300)
                    }
                  />
                </Section>
              </>
            )}

            {widgetType === "quick-actions" && (
              <Section label="Actions (JSON)">
                <textarea
                  className="w-full h-32 rounded-lg px-3 py-2 text-xs font-mono outline-none resize-none"
                  style={{
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    color: "var(--text-primary)",
                  }}
                  placeholder='[{"id":"1","label":"New Task","icon":"CheckSquare","action":"create-note","tags":["task"]}]'
                  value={actionsJson}
                  onChange={(e) => setActionsJson(e.target.value)}
                />
              </Section>
            )}

            {/* Visual: span + density */}
            <Section label="Layout">
              <div className="space-y-3">
                <div>
                  <div
                    className="text-xs mb-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Column Span: {span}
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={4}
                    value={span}
                    onChange={(e) => setSpan(parseInt(e.target.value, 10))}
                    className="w-full"
                  />
                </div>
                <div className="flex gap-2">
                  {(["compact", "normal"] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDensity(d)}
                      className="px-3 py-1.5 rounded-lg text-xs transition-colors"
                      style={{
                        background:
                          density === d
                            ? "var(--color-accent)"
                            : "var(--glass)",
                        color: density === d ? "white" : "var(--text-primary)",
                        border: "1px solid var(--glass-border)",
                      }}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            </Section>
          </div>

          {/* Footer */}
          <div
            className="flex items-center justify-end gap-2 px-5 py-3 flex-shrink-0"
            style={{ borderTop: "1px solid var(--glass-border)" }}
          >
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave}>
              {isNew ? "Add Widget" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section helper ──────────────────────────────────────────────────

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3
        className="text-xs font-semibold uppercase tracking-wider mb-2"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </h3>
      {children}
    </div>
  );
}
