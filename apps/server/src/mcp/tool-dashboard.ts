/**
 * `prism_dashboard_query` (Architecture v2 WP6.4): run the dashboard filter
 * engine server-side, over ONLY the notes the caller may view.
 *
 * The engine is the client's own pure module (`@prism/core/dashboard-engine`:
 * `filterNotes` / `sortNotes` / `groupNotes` / `aggregateNotes` — no DOM or
 * store deps), so a widget evaluates here exactly as in the app. The input set is
 * whatever `GET /api/notes` returns for the caller's actor — the gateway has
 * already applied `effectiveCaps` (grants, private notes) — so a dashboard can
 * never be used to read a note the caller could not open. Notes are fetched
 * WITHOUT content; rows carry only lean fields plus the metadata fields the
 * widget (or the `fields` argument) names.
 */
import * as z from "zod/v4";
import { aggregateNotes, filterNotes, groupNotes, sortNotes, type DataSource } from "@prism/core/dashboard-engine";
/** The engine's own note shape (importing the @prism/core index would drag the whole UI into the server typecheck). */
type Note = Parameters<typeof filterNotes>[0][number];
import { grantCaps } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import type { McpPrincipal } from "./auth";
import { jsonOrToolError } from "./dispatch";
import { ToolError } from "./errors";
import { defineTool, type PrismTool, type ToolContext } from "./tools";

const enc = encodeURIComponent;
const MAX_SCAN = 5_000;
const MAX_ROWS = 100;
const MAX_WIDGETS = 20;
const GROUP_ROWS = 20;

function canViewAnywhere(p: McpPrincipal): boolean {
  if (roleFloor(p.actor.role)) return true;
  return p.actor.grants.some((g) => new Set(grantCaps(g)).has("view"));
}

const sourceSchema = z.object({
  tags: z.array(z.string()).max(20).optional().describe("Note must carry ALL of these tags"),
  pathPrefix: z.string().max(500).optional(),
  metadataFilters: z.record(z.string(), z.unknown()).optional().describe("field → value, or field → {$eq|$ne|$lt|$gt|$in: …}"),
  dateRange: z.object({ field: z.string(), preset: z.string().optional(), from: z.string().optional(), to: z.string().optional() }).optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
});

interface WidgetSpec {
  id?: string;
  type?: string;
  title?: string;
  source?: DataSource;
  sort?: { field: string; direction: "asc" | "desc" };
  group?: { field: string; order?: string[] };
  columns?: Array<{ field: string }>;
  cardFields?: string[];
  segmentField?: string;
  aggregateType?: "count" | "count-where" | "percentage-where";
  aggregateCondition?: Record<string, unknown>;
  dateField?: string;
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

function row(n: Note, fields: string[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (n.metadata as Record<string, unknown> | undefined)?.[f];
    if (v !== undefined) meta[f] = v;
  }
  return { id: n.id, path: n.path ?? null, tags: n.tags ?? [], updatedAt: n.updatedAt ?? null, ...(fields.length ? { fields: meta } : {}) };
}

/** Evaluate one widget over the viewable notes. */
function runWidget(w: WidgetSpec, notes: Note[], extraFields: string[]): Record<string, unknown> {
  const type = w.type ?? "list";
  const source: DataSource = { ...(w.source ?? {}) };
  const limit = Math.min(source.limit ?? MAX_ROWS, MAX_ROWS);
  delete source.limit; // sort first, then cut (the engine's limit-before-sort would drop the wrong rows)
  let matched = filterNotes(notes, source);
  if (w.sort) matched = sortNotes(matched, w.sort);
  const fields = [
    ...new Set([
      ...extraFields,
      ...(w.columns ?? []).map((c) => c.field),
      ...strs(w.cardFields),
      ...(w.sort ? [w.sort.field] : []),
      ...(w.group ? [w.group.field] : []),
      ...(w.segmentField ? [w.segmentField] : []),
      ...(w.dateField ? [w.dateField] : []),
    ]),
  ].filter((f) => !["id", "path", "createdAt", "updatedAt", "content"].includes(f));
  const head = { widget: w.id ?? null, title: w.title ?? null, type, total: matched.length };

  if (type === "embed" || type === "quick-actions") return { ...head, data: null, note: "this widget type has no data to query" };

  if (type === "stat" || type === "progress") {
    const value = aggregateNotes(matched, w.aggregateType ?? "count", w.aggregateCondition);
    return { ...head, value, aggregate: w.aggregateType ?? "count" };
  }
  const groupField = type === "chart" ? (w.segmentField ?? w.group?.field) : w.group?.field;
  if (groupField) {
    const groups = groupNotes(matched, { field: groupField, order: w.group?.order });
    return {
      ...head,
      groupBy: groupField,
      groups: [...groups].map(([key, list]) => ({
        key,
        count: list.length,
        ...(type === "chart" ? {} : { notes: list.slice(0, GROUP_ROWS).map((n) => row(n, fields)) }),
      })),
    };
  }
  const page = matched.slice(0, limit);
  return { ...head, rows: page.map((n) => row(n, fields)), truncated: matched.length > page.length };
}

async function visibleNotes(ctx: ToolContext): Promise<{ notes: Note[]; truncated: boolean }> {
  const q = roleAtLeast(ctx.principal.actor.role, "admin") ? `?limit=${MAX_SCAN}&include_content=false` : "?include_content=false";
  const all = await jsonOrToolError<Note[]>(await ctx.dispatch(`/api/notes${q}`));
  return { notes: all.slice(0, MAX_SCAN), truncated: all.length > MAX_SCAN };
}

export const dashboardQueryTool = defineTool({
  name: "prism_dashboard_query",
  scope: "read",
  title: "Run a dashboard or widget query",
  description:
    "Compute dashboard data server-side over the notes YOU may view. Either `dashboard_id` (a note tagged `dashboard`; optionally " +
    "one `widget_id`) runs that dashboard's saved widgets, or an inline `source` (tags ALL-of, pathPrefix, metadataFilters, " +
    "dateRange) with optional `sort`, `group_by`, `aggregate` runs an ad-hoc query. Stat/progress widgets return a number, " +
    "chart/board widgets group counts, list-like widgets return lean rows (id, path, tags, updatedAt + the metadata fields the widget " +
    "names, or `fields`). Rows ≤ 100. Notes you cannot view are never counted.",
  inputSchema: z.object({
    dashboard_id: z.string().min(1).max(200).optional(),
    widget_id: z.string().min(1).max(200).optional(),
    source: sourceSchema.optional(),
    sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }).optional(),
    group_by: z.string().min(1).max(200).optional(),
    aggregate: z
      .object({ type: z.enum(["count", "count-where", "percentage-where"]), condition: z.record(z.string(), z.unknown()).optional() })
      .optional(),
    fields: z.array(z.string().min(1).max(200)).max(20).optional().describe("Metadata fields to include on rows"),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canViewAnywhere,
  async handler(a, ctx) {
    if (Boolean(a.dashboard_id) === Boolean(a.source)) throw new ToolError("invalid_request", "give exactly one of `dashboard_id` or an inline `source`");
    if (a.widget_id && !a.dashboard_id) throw new ToolError("invalid_request", "`widget_id` needs a `dashboard_id`");
    let widgets: WidgetSpec[];
    if (a.dashboard_id) {
      const dash = await jsonOrToolError<Note>(await ctx.dispatch(`/api/notes/${enc(a.dashboard_id)}`));
      const isDash = (dash.tags ?? []).some((t) => t === "dashboard" || t.startsWith("dashboard/"));
      if (!isDash) throw new ToolError("invalid_request", "that note is not a dashboard");
      const layout = (dash.metadata as Record<string, unknown> | undefined)?.layout;
      const raw = isRecord(layout) && Array.isArray(layout.widgets) ? (layout.widgets as unknown[]) : [];
      widgets = raw.filter(isRecord).map((w) => w as WidgetSpec);
      if (a.widget_id) {
        widgets = widgets.filter((w) => w.id === a.widget_id);
        if (widgets.length === 0) throw new ToolError("not_found", "no such widget on that dashboard");
      }
      widgets = widgets.slice(0, MAX_WIDGETS);
    } else {
      widgets = [
        {
          id: "inline",
          type: a.aggregate ? "stat" : a.group_by ? "board" : "list",
          source: a.source as DataSource,
          sort: a.sort,
          group: a.group_by ? { field: a.group_by } : undefined,
          aggregateType: a.aggregate?.type,
          aggregateCondition: a.aggregate?.condition,
        },
      ];
    }
    const { notes, truncated } = await visibleNotes(ctx);
    return {
      scanned: notes.length,
      ...(truncated ? { scanTruncated: true } : {}),
      widgets: widgets.map((w) => runWidget(w, notes, a.fields ?? [])),
    };
  },
});

export const DASHBOARD_TOOLS = [dashboardQueryTool] as unknown as PrismTool[];
