import { useState, useCallback } from "react";
import {
  X, List, Columns3, LayoutGrid, Hash, BarChart3, Clock, PieChart, FileText, Zap,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../ui/Button";
import { useTags } from "../../../app/hooks/useParachute";
import {
  WIDGET_TYPES, getWidgetType,
  type DashboardWidgetConfig, type WidgetTypeId, type WidgetColumn,
} from "../../../lib/dashboard/widget-registry";
import type { DataSource } from "../../../lib/dashboard/filter-engine";

interface WidgetEditorModalProps {
  initial?: DashboardWidgetConfig | null;
  onSave: (config: DashboardWidgetConfig) => void;
  onClose: () => void;
}

const ICON_MAP: Record<string, LucideIcon> = { List, Columns3, LayoutGrid, Hash, BarChart3, Clock, PieChart, FileText, Zap };

// Common metadata fields available in Parachute tag schemas
const COMMON_FIELDS = [
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
  { value: "due", label: "Due Date" },
  { value: "date", label: "Date" },
  { value: "source", label: "Source" },
  { value: "attendees", label: "Attendees" },
  { value: "visibility", label: "Visibility" },
  { value: "role", label: "Role" },
  { value: "org", label: "Organization" },
  { value: "url", label: "URL" },
];

const STATUS_VALUES = ["todo", "in-progress", "blocked", "done", "cancelled", "draft", "review", "active", "paused", "completed", "archived"];
const PRIORITY_VALUES = ["critical", "high", "medium", "low"];
const DATE_PRESETS = [
  { value: "", label: "All time" },
  { value: "today", label: "Today" },
  { value: "this-week", label: "This week" },
  { value: "this-month", label: "This month" },
  { value: "last-7d", label: "Last 7 days" },
  { value: "last-30d", label: "Last 30 days" },
];
const ACCENT_COLORS = [
  { value: "accent", label: "Blue", color: "var(--color-accent)" },
  { value: "success", label: "Green", color: "var(--color-success)" },
  { value: "warning", label: "Yellow", color: "var(--color-warning)" },
  { value: "danger", label: "Red", color: "var(--color-danger)" },
];

// Predefined templates — one-click setup for common dashboards
const TEMPLATES: { label: string; description: string; config: Partial<DashboardWidgetConfig> }[] = [
  {
    label: "Task Board",
    description: "Kanban board of tasks by status",
    config: { type: "board", title: "Tasks", source: { tags: ["task"] }, group: { field: "status", order: ["todo", "in-progress", "blocked", "done"] }, cardFields: ["priority", "due", "project"], span: 4 },
  },
  {
    label: "Task Progress",
    description: "Progress bar of completed tasks",
    config: { type: "progress", title: "Task Progress", source: { tags: ["task"] }, aggregateCondition: { status: "done" }, labelTemplate: "{done}/{total} complete ({percent}%)", accentColor: "success" },
  },
  {
    label: "Meeting Notes",
    description: "Recent meetings sorted by date",
    config: { type: "list", title: "Meetings", source: { tags: ["meeting"] }, sort: { field: "createdAt", direction: "desc" }, columns: [{ field: "path", label: "Title" }, { field: "date", label: "Date" }, { field: "attendees", label: "Attendees" }], span: 2 },
  },
  {
    label: "Project Documents",
    description: "All docs for a project",
    config: { type: "gallery", title: "Documents", source: { pathPrefix: "projects/" }, sort: { field: "updatedAt", direction: "desc" }, columnCount: 3, span: 2 },
  },
  {
    label: "Status Distribution",
    description: "Chart showing task status breakdown",
    config: { type: "chart", title: "Status Overview", source: { tags: ["task"] }, chartType: "donut", segmentField: "status", span: 1 },
  },
  {
    label: "Overdue Count",
    description: "Number of overdue tasks",
    config: { type: "stat", title: "Overdue", source: { tags: ["task"] }, aggregateType: "count-where", aggregateCondition: { due: { $lt: "today" }, status: { $ne: "done" } }, accentColor: "danger", icon: "Hash" },
  },
  {
    label: "Recent Timeline",
    description: "Chronological view of recent notes",
    config: { type: "timeline", title: "Timeline", source: { dateRange: { field: "createdAt", preset: "last-30d" } }, dateField: "createdAt", span: 2 },
  },
];

export function WidgetEditorModal({ initial, onSave, onClose }: WidgetEditorModalProps) {
  const isNew = !initial;
  const { data: allTags } = useTags();
  const tagOptions = (allTags || []).map((t) => t.tag).sort();

  // State
  const [widgetType, setWidgetType] = useState<WidgetTypeId>(initial?.type ?? "list");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [span, setSpan] = useState(initial?.span ?? 1);
  const [selectedTags, setSelectedTags] = useState<string[]>(initial?.source?.tags ?? []);
  const [pathPrefix, setPathPrefix] = useState(initial?.source?.pathPrefix ?? "");
  const [datePreset, setDatePreset] = useState(initial?.source?.dateRange?.preset ?? "");
  const [sortField, setSortField] = useState(initial?.sort?.field ?? "updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initial?.sort?.direction ?? "desc");
  const [groupField, setGroupField] = useState(initial?.group?.field ?? "status");
  const [groupOrder, setGroupOrder] = useState(initial?.group?.order?.join(", ") ?? "");
  const [columns, setColumns] = useState<WidgetColumn[]>(initial?.columns ?? [{ field: "path", label: "Title" }, { field: "updatedAt", label: "Updated" }]);
  const [cardFields, setCardFields] = useState<string[]>(initial?.cardFields ?? ["priority", "due"]);
  const [chartType, setChartType] = useState<"bar" | "donut">(initial?.chartType ?? "donut");
  const [segmentField, setSegmentField] = useState(initial?.segmentField ?? "status");
  const [aggregateType, setAggregateType] = useState(initial?.aggregateType ?? "count");
  const [conditionField, setConditionField] = useState("status");
  const [conditionValue, setConditionValue] = useState("done");
  const [accentColor, setAccentColor] = useState(initial?.accentColor ?? "accent");
  const [labelTemplate, setLabelTemplate] = useState(initial?.labelTemplate ?? "{done}/{total} ({percent}%)");
  const [dateField, setDateField] = useState(initial?.dateField ?? "createdAt");
  const [columnCount, setColumnCount] = useState(initial?.columnCount ?? 3);
  const [showTemplates, setShowTemplates] = useState(isNew);

  // When type changes, set smart defaults
  const handleTypeChange = useCallback((type: WidgetTypeId) => {
    setWidgetType(type);
    const meta = getWidgetType(type);
    if (meta && isNew) setTitle(meta.label);
    // Set type-specific defaults
    if (type === "board") { setGroupField("status"); setGroupOrder("todo, in-progress, blocked, done"); setSpan(4); }
    if (type === "chart") { setSegmentField("status"); setSpan(1); }
    if (type === "stat" || type === "progress") { setAggregateType("count-where"); setConditionField("status"); setConditionValue("done"); }
    if (type === "timeline") { setDateField("createdAt"); setSpan(2); }
    if (type === "gallery") { setColumnCount(3); setSpan(2); }
    if (type === "list") { setSpan(2); }
    setShowTemplates(false);
  }, [isNew]);

  const applyTemplate = (template: typeof TEMPLATES[0]) => {
    const c = template.config;
    setWidgetType((c.type as WidgetTypeId) || "list");
    setTitle(c.title || "");
    setSpan(c.span || 1);
    if (c.source?.tags) setSelectedTags(c.source.tags);
    if (c.source?.pathPrefix) setPathPrefix(c.source.pathPrefix);
    if (c.source?.dateRange?.preset) setDatePreset(c.source.dateRange.preset);
    if (c.sort) { setSortField(c.sort.field); setSortDir(c.sort.direction); }
    if (c.group) { setGroupField(c.group.field); setGroupOrder(c.group.order?.join(", ") || ""); }
    if (c.columns) setColumns(c.columns);
    if (c.cardFields) setCardFields(c.cardFields);
    if (c.chartType) setChartType(c.chartType);
    if (c.segmentField) setSegmentField(c.segmentField);
    if (c.aggregateType) setAggregateType(c.aggregateType);
    if (c.accentColor) setAccentColor(c.accentColor);
    if (c.labelTemplate) setLabelTemplate(c.labelTemplate);
    if (c.dateField) setDateField(c.dateField);
    if (c.columnCount) setColumnCount(c.columnCount);
    setShowTemplates(false);
  };

  const handleSave = () => {
    const source: DataSource = {};
    if (selectedTags.length) source.tags = selectedTags;
    if (pathPrefix) source.pathPrefix = pathPrefix;
    if (datePreset) source.dateRange = { field: dateField || "createdAt", preset: datePreset };

    let aggregateCondition: Record<string, unknown> | undefined;
    if (["stat", "progress"].includes(widgetType) && aggregateType !== "count") {
      aggregateCondition = { [conditionField]: conditionValue };
    }

    const config: DashboardWidgetConfig = {
      id: initial?.id ?? `w-${Date.now()}`,
      type: widgetType,
      title: title || getWidgetType(widgetType)?.label || widgetType,
      span: span > 1 ? span : undefined,
      source: Object.keys(source).length ? source : undefined,
      sort: sortField ? { field: sortField, direction: sortDir } : undefined,
      group: ["board", "chart"].includes(widgetType) && groupField ? {
        field: groupField,
        order: groupOrder ? groupOrder.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      } : undefined,
      columns: widgetType === "list" ? columns : undefined,
      cardFields: ["board", "gallery", "timeline"].includes(widgetType) ? cardFields : undefined,
      chartType: widgetType === "chart" ? chartType : undefined,
      segmentField: widgetType === "chart" ? segmentField : undefined,
      aggregateType: ["stat", "progress"].includes(widgetType) ? aggregateType : undefined,
      aggregateCondition,
      accentColor: ["stat", "progress"].includes(widgetType) ? accentColor : undefined,
      labelTemplate: widgetType === "progress" ? labelTemplate : undefined,
      dateField: widgetType === "timeline" ? dateField : undefined,
      columnCount: widgetType === "gallery" ? columnCount : undefined,
    };

    onSave(config);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8" style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(8px)" }} onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[85vh] flex rounded-2xl overflow-hidden" style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)" }} onClick={(e) => e.stopPropagation()}>

        {/* Left sidebar */}
        <div className="w-48 flex-shrink-0 p-3 space-y-1 overflow-y-auto" style={{ borderRight: "1px solid var(--glass-border)", background: "var(--glass)" }}>
          {isNew && (
            <button onClick={() => setShowTemplates(true)}
              className="w-full text-left px-2.5 py-2 rounded-lg text-sm mb-2"
              style={{ background: showTemplates ? "var(--color-accent)" : "var(--glass-hover)", color: showTemplates ? "white" : "var(--text-primary)" }}>
              ✨ Templates
            </button>
          )}
          <div className="text-xs font-medium px-2 py-1" style={{ color: "var(--text-muted)" }}>Widget Type</div>
          {WIDGET_TYPES.map((wt) => {
            const Icon = ICON_MAP[wt.icon] ?? FileText;
            const isActive = widgetType === wt.id && !showTemplates;
            return (
              <button key={wt.id} onClick={() => handleTypeChange(wt.id)}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-colors"
                style={{ background: isActive ? "var(--color-accent)" : "transparent", color: isActive ? "white" : "var(--text-primary)" }}>
                <Icon size={15} /> {wt.label}
              </button>
            );
          })}
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--glass-border)" }}>
            <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{showTemplates ? "Choose a Template" : isNew ? "Add Widget" : "Edit Widget"}</span>
            <button onClick={onClose} className="p-1 rounded hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-muted)" }}><X size={16} /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Templates view */}
            {showTemplates ? (
              <div className="grid grid-cols-2 gap-3">
                {TEMPLATES.map((t, i) => (
                  <button key={i} onClick={() => applyTemplate(t)}
                    className="text-left glass p-4 rounded-xl hover:bg-[var(--glass-hover)] transition-colors">
                    <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{t.label}</div>
                    <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{t.description}</div>
                  </button>
                ))}
              </div>
            ) : (
              <>
                {/* Title */}
                <Section label="Widget Title">
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="My Widget"
                    className="w-full h-8 rounded-lg px-3 text-sm outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
                </Section>

                {/* Data Source — always shown */}
                <Section label="Filter by Tag">
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {selectedTags.map((tag) => (
                      <span key={tag} className="inline-flex items-center gap-1 glass px-2 py-0.5 rounded text-xs" style={{ color: "var(--text-primary)" }}>
                        {tag}
                        <button onClick={() => setSelectedTags(selectedTags.filter((t) => t !== tag))} style={{ color: "var(--text-muted)" }}><X size={10} /></button>
                      </span>
                    ))}
                  </div>
                  <select onChange={(e) => { if (e.target.value && !selectedTags.includes(e.target.value)) setSelectedTags([...selectedTags, e.target.value]); e.target.value = ""; }}
                    className="w-full h-8 rounded-lg px-3 text-sm outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
                    defaultValue="">
                    <option value="" style={{ background: "var(--bg-elevated)" }}>+ Add tag filter...</option>
                    {tagOptions.filter((t) => !selectedTags.includes(t)).slice(0, 50).map((t) => (
                      <option key={t} value={t} style={{ background: "var(--bg-elevated)" }}>{t}</option>
                    ))}
                  </select>
                </Section>

                <Section label="Filter by Path">
                  <input value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="e.g. projects/opencivics"
                    className="w-full h-8 rounded-lg px-3 text-sm outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }} />
                </Section>

                <Section label="Time Range">
                  <div className="flex flex-wrap gap-1.5">
                    {DATE_PRESETS.map((dp) => (
                      <button key={dp.value} onClick={() => setDatePreset(dp.value)}
                        className="px-3 py-1 rounded-lg text-xs transition-colors"
                        style={{ background: datePreset === dp.value ? "var(--color-accent)" : "var(--glass)", color: datePreset === dp.value ? "white" : "var(--text-primary)", border: "1px solid var(--glass-border)" }}>
                        {dp.label}
                      </button>
                    ))}
                  </div>
                </Section>

                {/* Sort — for list, gallery, timeline */}
                {["list", "gallery", "timeline"].includes(widgetType) && (
                  <Section label="Sort By">
                    <div className="flex gap-2">
                      <select value={sortField} onChange={(e) => setSortField(e.target.value)}
                        className="flex-1 h-8 rounded-lg px-3 text-sm outline-none"
                        style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                        <option value="createdAt" style={{ background: "var(--bg-elevated)" }}>Created</option>
                        <option value="updatedAt" style={{ background: "var(--bg-elevated)" }}>Updated</option>
                        <option value="path" style={{ background: "var(--bg-elevated)" }}>Name</option>
                        {COMMON_FIELDS.map((f) => <option key={f.value} value={f.value} style={{ background: "var(--bg-elevated)" }}>{f.label}</option>)}
                      </select>
                      <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
                        {(["desc", "asc"] as const).map((d) => (
                          <button key={d} onClick={() => setSortDir(d)}
                            className="px-2.5 py-1 text-xs"
                            style={{ background: sortDir === d ? "var(--glass-active)" : "transparent", color: "var(--text-primary)" }}>
                            {d === "desc" ? "↓ Newest" : "↑ Oldest"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </Section>
                )}

                {/* Group — for board, chart */}
                {["board", "chart"].includes(widgetType) && (
                  <Section label="Group By">
                    <select value={groupField} onChange={(e) => setGroupField(e.target.value)}
                      className="w-full h-8 rounded-lg px-3 text-sm outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                      {COMMON_FIELDS.map((f) => <option key={f.value} value={f.value} style={{ background: "var(--bg-elevated)" }}>{f.label}</option>)}
                    </select>
                    {widgetType === "board" && (
                      <input value={groupOrder} onChange={(e) => setGroupOrder(e.target.value)} placeholder="Column order (comma separated)"
                        className="w-full h-8 rounded-lg px-3 text-sm outline-none mt-2"
                        style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
                    )}
                  </Section>
                )}

                {/* === TYPE-SPECIFIC OPTIONS === */}

                {/* List: column picker */}
                {widgetType === "list" && (
                  <Section label="Columns to Show">
                    <div className="flex flex-wrap gap-1.5">
                      {[{ value: "path", label: "Title" }, { value: "createdAt", label: "Created" }, { value: "updatedAt", label: "Updated" }, ...COMMON_FIELDS].map((f) => {
                        const isSelected = columns.some((c) => c.field === f.value);
                        return (
                          <button key={f.value} onClick={() => {
                            if (isSelected) setColumns(columns.filter((c) => c.field !== f.value));
                            else setColumns([...columns, { field: f.value, label: f.label }]);
                          }}
                            className="px-2.5 py-1 rounded-lg text-xs transition-colors"
                            style={{ background: isSelected ? "var(--color-accent)" : "var(--glass)", color: isSelected ? "white" : "var(--text-primary)", border: "1px solid var(--glass-border)" }}>
                            {f.label}
                          </button>
                        );
                      })}
                    </div>
                  </Section>
                )}

                {/* Board/Gallery/Timeline: card fields */}
                {["board", "gallery", "timeline"].includes(widgetType) && (
                  <Section label="Fields on Cards">
                    <div className="flex flex-wrap gap-1.5">
                      {COMMON_FIELDS.map((f) => {
                        const isSelected = cardFields.includes(f.value);
                        return (
                          <button key={f.value} onClick={() => {
                            if (isSelected) setCardFields(cardFields.filter((v) => v !== f.value));
                            else setCardFields([...cardFields, f.value]);
                          }}
                            className="px-2.5 py-1 rounded-lg text-xs transition-colors"
                            style={{ background: isSelected ? "var(--color-accent)" : "var(--glass)", color: isSelected ? "white" : "var(--text-primary)", border: "1px solid var(--glass-border)" }}>
                            {f.label}
                          </button>
                        );
                      })}
                    </div>
                  </Section>
                )}

                {/* Gallery: column count */}
                {widgetType === "gallery" && (
                  <Section label={`Grid Columns: ${columnCount}`}>
                    <input type="range" min={1} max={5} value={columnCount} onChange={(e) => setColumnCount(Number(e.target.value))} className="w-full" />
                  </Section>
                )}

                {/* Chart: type + segment */}
                {widgetType === "chart" && (
                  <Section label="Chart Style">
                    <div className="flex gap-2">
                      {(["bar", "donut"] as const).map((ct) => (
                        <button key={ct} onClick={() => setChartType(ct)}
                          className="flex-1 py-2 rounded-lg text-sm transition-colors text-center"
                          style={{ background: chartType === ct ? "var(--color-accent)" : "var(--glass)", color: chartType === ct ? "white" : "var(--text-primary)", border: "1px solid var(--glass-border)" }}>
                          {ct === "bar" ? "Bar Chart" : "Donut Chart"}
                        </button>
                      ))}
                    </div>
                  </Section>
                )}

                {/* Stat/Progress: what to count */}
                {["stat", "progress"].includes(widgetType) && (
                  <>
                    <Section label="What to Measure">
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {([["count", "Total Count"], ["count-where", "Count Where"], ["percentage-where", "Percentage Where"]] as const).map(([val, label]) => (
                          <button key={val} onClick={() => setAggregateType(val)}
                            className="px-3 py-1.5 rounded-lg text-xs transition-colors"
                            style={{ background: aggregateType === val ? "var(--color-accent)" : "var(--glass)", color: aggregateType === val ? "white" : "var(--text-primary)", border: "1px solid var(--glass-border)" }}>
                            {label}
                          </button>
                        ))}
                      </div>
                      {aggregateType !== "count" && (
                        <div className="flex gap-2">
                          <select value={conditionField} onChange={(e) => setConditionField(e.target.value)}
                            className="flex-1 h-8 rounded-lg px-3 text-sm outline-none"
                            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                            {COMMON_FIELDS.map((f) => <option key={f.value} value={f.value} style={{ background: "var(--bg-elevated)" }}>{f.label}</option>)}
                          </select>
                          <select value={conditionValue} onChange={(e) => setConditionValue(e.target.value)}
                            className="flex-1 h-8 rounded-lg px-3 text-sm outline-none"
                            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                            {(conditionField === "priority" ? PRIORITY_VALUES : STATUS_VALUES).map((v) => (
                              <option key={v} value={v} style={{ background: "var(--bg-elevated)" }}>{v}</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </Section>
                    <Section label="Color">
                      <div className="flex gap-2">
                        {ACCENT_COLORS.map((c) => (
                          <button key={c.value} onClick={() => setAccentColor(c.value)}
                            className="flex-1 py-1.5 rounded-lg text-xs text-center transition-colors"
                            style={{ background: accentColor === c.value ? c.color : "var(--glass)", color: accentColor === c.value ? "white" : "var(--text-primary)", border: "1px solid var(--glass-border)" }}>
                            {c.label}
                          </button>
                        ))}
                      </div>
                    </Section>
                  </>
                )}

                {/* Progress: label template */}
                {widgetType === "progress" && (
                  <Section label="Label">
                    <input value={labelTemplate} onChange={(e) => setLabelTemplate(e.target.value)}
                      className="w-full h-8 rounded-lg px-3 text-sm outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
                    <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Use {"{done}"}, {"{total}"}, {"{percent}"}</div>
                  </Section>
                )}

                {/* Timeline: date field */}
                {widgetType === "timeline" && (
                  <Section label="Date Field">
                    <select value={dateField} onChange={(e) => setDateField(e.target.value)}
                      className="w-full h-8 rounded-lg px-3 text-sm outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                      <option value="createdAt" style={{ background: "var(--bg-elevated)" }}>Created Date</option>
                      <option value="updatedAt" style={{ background: "var(--bg-elevated)" }}>Updated Date</option>
                      <option value="date" style={{ background: "var(--bg-elevated)" }}>Date (metadata)</option>
                      <option value="due" style={{ background: "var(--bg-elevated)" }}>Due Date</option>
                    </select>
                  </Section>
                )}

                {/* Layout */}
                <Section label={`Width: ${span} column${span > 1 ? "s" : ""}`}>
                  <input type="range" min={1} max={4} value={span} onChange={(e) => setSpan(Number(e.target.value))} className="w-full" />
                </Section>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-5 py-3 flex-shrink-0" style={{ borderTop: "1px solid var(--glass-border)" }}>
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            {!showTemplates && <Button variant="primary" size="sm" onClick={handleSave}>{isNew ? "Add Widget" : "Save"}</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>{label}</h3>
      {children}
    </div>
  );
}
