/**
 * Widget type registry — metadata for each dashboard widget type.
 */

import type { DataSource, SortConfig, GroupConfig, AggregateType } from "./filter-engine";

// ── Widget config type (stored in dashboard note metadata) ──────────

export interface DashboardWidgetConfig {
  id: string;
  type: WidgetTypeId;
  title: string;
  span?: number; // grid column span 1-4
  density?: "compact" | "normal";

  // Data source
  source?: DataSource;
  sort?: SortConfig;
  group?: GroupConfig;

  // Type-specific
  columns?: WidgetColumn[];         // list
  cardFields?: string[];            // board, gallery
  chartType?: "bar" | "donut";      // chart
  segmentField?: string;            // chart
  colors?: string[];                // chart
  aggregateType?: AggregateType;    // stat, progress
  aggregateCondition?: Record<string, unknown>; // stat, progress
  icon?: string;                    // stat
  accentColor?: string;             // stat, progress
  labelTemplate?: string;           // progress
  dateField?: string;               // timeline
  noteId?: string;                  // embed
  maxHeight?: number;               // embed
  columnCount?: number;             // gallery
  actions?: QuickAction[];          // quick-actions
}

export interface WidgetColumn {
  field: string;
  label: string;
  width?: number;
}

export interface QuickAction {
  id: string;
  label: string;
  icon: string;
  action: "create-note" | "open-command-bar";
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ── Widget type IDs ─────────────────────────────────────────────────

export type WidgetTypeId =
  | "list"
  | "board"
  | "gallery"
  | "stat"
  | "progress"
  | "timeline"
  | "chart"
  | "embed"
  | "quick-actions";

// ── Registry ────────────────────────────────────────────────────────

export interface WidgetTypeMeta {
  id: WidgetTypeId;
  label: string;
  icon: string; // lucide icon name
  description: string;
  defaultConfig: Partial<DashboardWidgetConfig>;
}

export const WIDGET_TYPES: WidgetTypeMeta[] = [
  {
    id: "list",
    label: "List",
    icon: "List",
    description: "Table view with sortable columns",
    defaultConfig: {
      columns: [
        { field: "path", label: "Title" },
        { field: "updatedAt", label: "Updated" },
      ],
    },
  },
  {
    id: "board",
    label: "Board",
    icon: "Columns3",
    description: "Kanban board grouped by a field",
    defaultConfig: {
      group: { field: "status" },
      cardFields: ["priority"],
    },
  },
  {
    id: "gallery",
    label: "Gallery",
    icon: "LayoutGrid",
    description: "Card grid with previews",
    defaultConfig: {
      columnCount: 3,
      cardFields: [],
    },
  },
  {
    id: "stat",
    label: "Stat",
    icon: "Hash",
    description: "Big number with label",
    defaultConfig: {
      aggregateType: "count",
      icon: "FileText",
      accentColor: "accent",
    },
  },
  {
    id: "progress",
    label: "Progress",
    icon: "BarChart3",
    description: "Progress bar with done/total",
    defaultConfig: {
      aggregateType: "count-where",
      aggregateCondition: { status: "done" },
      labelTemplate: "{done}/{total} complete ({percent}%)",
      accentColor: "success",
    },
  },
  {
    id: "timeline",
    label: "Timeline",
    icon: "Clock",
    description: "Vertical timeline by date",
    defaultConfig: {
      dateField: "createdAt",
    },
  },
  {
    id: "chart",
    label: "Chart",
    icon: "PieChart",
    description: "Bar or donut chart",
    defaultConfig: {
      chartType: "bar",
      segmentField: "status",
    },
  },
  {
    id: "embed",
    label: "Embed",
    icon: "FileText",
    description: "Embed a specific note",
    defaultConfig: {
      maxHeight: 300,
    },
  },
  {
    id: "quick-actions",
    label: "Quick Actions",
    icon: "Zap",
    description: "Grid of action buttons",
    defaultConfig: {
      actions: [],
    },
  },
];

export function getWidgetType(type: WidgetTypeId): WidgetTypeMeta | undefined {
  return WIDGET_TYPES.find((w) => w.id === type);
}
