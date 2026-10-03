/**
 * Database notes — the data model.
 *
 * A DATABASE is an ordinary vault note with `metadata.prism_type: "database"`
 * (so `inferContentType` routes it to the DatabaseRenderer, the tree shows it,
 * history/sharing/search work unchanged) whose `metadata.prism_database` holds:
 *
 *   { version: 1,
 *     source: { tags: ["task"] },            // rows = notes carrying ALL these tags
 *     views: [{ id, name, type: table|board|gallery|list|calendar,
 *               filter?, sort?, groupBy?, visible?, widths?, dateKey?, coverKey?,
 *               order? }] }
 *
 * Rows are never copied: they ARE the tagged notes, and a row's cells are that
 * note's `metadata` (typed by the tag's vault schema). The note's body is the
 * database's description. This mirrors task boards (`prism_board`) and
 * dashboards (`layout.widgets`): configuration in the owning note's metadata,
 * data in the notes themselves. Unknown/newer configs fail closed (shown, never
 * overwritten), exactly like `readBoardConfig`.
 */
import { isFieldKey, QUERY_OPS, type QueryFilter, type QuerySort } from "../../lib/database/query";

export const VIEW_TYPES = ["table", "board", "gallery", "list", "calendar"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export interface DatabaseView {
  id: string;
  name: string;
  type: ViewType;
  filter?: QueryFilter;
  sort?: QuerySort[];
  /** Board columns / table sections. */
  groupBy?: string;
  /** Property keys shown, in order (undefined = every property). */
  visible?: string[];
  /** Table column widths in px. */
  widths?: Record<string, number>;
  /** Calendar: the date property. */
  dateKey?: string;
  /** Gallery: the property holding a cover image URL. */
  coverKey?: string;
  /** Board: view-local manual rank (rows are never rewritten to reorder). */
  order?: string[];
}

export interface DatabaseConfig {
  version: 1;
  source: { tags: string[] };
  views: DatabaseView[];
}

export const VIEW_LABELS: Record<ViewType, string> = {
  table: "Table", board: "Board", gallery: "Gallery", list: "List", calendar: "Calendar",
};

export const newViewId = () => `v${Math.random().toString(36).slice(2, 9)}`;

export function defaultConfig(tag: string): DatabaseConfig {
  return { version: 1, source: { tags: [tag] }, views: [{ id: "table", name: "Table", type: "table" }] };
}

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keyOk = (k: unknown): boolean => typeof k === "string" && (isFieldKey(k) || /^\$(title|path|createdAt|updatedAt|tags)$/.test(k));

function viewOk(v: unknown): v is DatabaseView {
  if (!rec(v)) return false;
  if (typeof v.id !== "string" || !v.id || v.id.length > 40) return false;
  if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 80) return false;
  if (!(VIEW_TYPES as readonly string[]).includes(v.type as string)) return false;
  if (v.groupBy !== undefined && !keyOk(v.groupBy)) return false;
  if (v.dateKey !== undefined && !keyOk(v.dateKey)) return false;
  if (v.coverKey !== undefined && !keyOk(v.coverKey)) return false;
  if (v.visible !== undefined && (!Array.isArray(v.visible) || v.visible.length > 60 || !v.visible.every(keyOk))) return false;
  if (v.widths !== undefined && (!rec(v.widths) || !Object.entries(v.widths).every(([k, w]) => keyOk(k) && typeof w === "number" && w >= 60 && w <= 1200))) return false;
  if (v.order !== undefined && (!Array.isArray(v.order) || v.order.length > 10000 || !v.order.every((x) => typeof x === "string"))) return false;
  if (v.sort !== undefined && (!Array.isArray(v.sort) || v.sort.length > 3 || !v.sort.every((s) => rec(s) && keyOk(s.key) && (s.dir === "asc" || s.dir === "desc")))) return false;
  if (v.filter !== undefined) {
    const f = v.filter;
    if (!rec(f) || (f.match !== "all" && f.match !== "any") || !Array.isArray(f.conditions) || f.conditions.length > 25) return false;
    if (!f.conditions.every((c) => rec(c) && keyOk(c.key) && (QUERY_OPS as readonly string[]).includes(c.op as string))) return false;
  }
  return true;
}

/** Read `prism_database`; null when the note has none yet; throws on an unknown shape. */
export function readDatabaseConfig(metadata: Record<string, unknown> | null | undefined): DatabaseConfig | null {
  const raw = metadata?.prism_database;
  if (raw == null) return null;
  if (
    !rec(raw) || raw.version !== 1 || !rec(raw.source) || !Array.isArray(raw.source.tags) ||
    !raw.source.tags.length || raw.source.tags.length > 5 ||
    !raw.source.tags.every((t) => typeof t === "string" && t.length > 0 && t.length <= 128) ||
    !Array.isArray(raw.views) || !raw.views.length || raw.views.length > 20 || !raw.views.every(viewOk) ||
    new Set(raw.views.map((v) => (v as DatabaseView).id)).size !== raw.views.length
  ) {
    throw new Error("This database has a configuration this version of Prism does not understand. Its saved settings have been preserved.");
  }
  return raw as unknown as DatabaseConfig;
}

/**
 * Move `id` next to `neighbor` in a view-local rank, keeping every id the view
 * already knew (hidden rows included) — the same contract as task boards'
 * `reorderBoardTasks`, generalised to any database view.
 */
export function reorderRank(order: string[] | undefined, visibleIds: string[], id: string, neighbor: string, side: "before" | "after"): string[] | null {
  if (id === neighbor) return null;
  const all = [...new Set([...(order ?? []), ...visibleIds])].filter((x) => x !== id);
  const at = all.indexOf(neighbor);
  if (at < 0) return null;
  all.splice(at + (side === "after" ? 1 : 0), 0, id);
  return all;
}

/** Apply a manual rank on top of an already-sorted list (unranked rows keep their order, after ranked ones). */
export function applyRank<T extends { id: string }>(rows: T[], order: string[] | undefined): T[] {
  if (!order?.length) return rows;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

/** A path for a new row: inside the database page's own folder. */
export function rowPath(dbPath: string | null, title: string): string {
  const safe = title.trim().replace(/[\\/]/g, "-").slice(0, 120) || "Untitled";
  const base = (dbPath ?? "").replace(/\.[^./]+$/, "");
  return base ? `${base}/${safe}` : safe;
}
