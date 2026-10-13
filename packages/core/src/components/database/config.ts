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
 *               order?, calculations?, wrap? }] }
 *
 * Rows are never copied: they ARE the tagged notes, and a row's cells are that
 * note's `metadata` (typed by the tag's vault schema). The note's body is the
 * database's description. This mirrors task boards (`prism_board`) and
 * dashboards (`layout.widgets`): configuration in the owning note's metadata,
 * data in the notes themselves. Unknown/newer configs fail closed (shown, never
 * overwritten), exactly like `readBoardConfig`.
 */
import { isAggregateFn, isFieldKey, MAX_AGGREGATES, QUERY_OPS, type AggregateFn, type QueryFilter, type QuerySort } from "../../lib/database/query";
import { safeTitleLeaf } from "../../lib/database/schema";

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
  /** Board / grouped table / grouped list: leave out groups with no pages. */
  hideEmptyGroups?: boolean;
  /** Gallery: card size (default medium). */
  cardSize?: CardSize;
  /**
   * Calculations (NP-DB-26): property key → function. A table shows each under its
   * column; boards, lists and galleries show them per group / in the footer. The
   * figure is computed over every row the viewer can see, never stored.
   */
  calculations?: Record<string, AggregateFn>;
  /** Table: wrap cell text so a row grows instead of cutting it (default off). */
  wrap?: boolean;
}

export const CARD_SIZES = ["small", "medium", "large"] as const;
export type CardSize = (typeof CARD_SIZES)[number];

/** How a row opens from this database (Notion's per-database preference). */
export type OpenMode = "side" | "center" | "page";
export const OPEN_MODES: OpenMode[] = ["side", "center", "page"];

/** A page template: a vault note (never a row — it does not carry the source tags). */
export interface DatabaseTemplate {
  /** The template note's id. */
  id: string;
  name: string;
}

export interface DatabaseConfig {
  version: 1;
  source: { tags: string[] };
  views: DatabaseView[];
  /** Row opening preference (default: side peek on desktop; phones always open the page). */
  openIn?: OpenMode;
  /** Page templates for "+ New ▾" (≤ 20). */
  templates?: DatabaseTemplate[];
  /** The template "+ New" uses; absent = an empty page. */
  defaultTemplate?: string;
}

/** Template notes keep the values a new row receives here (+ their body). */
export const TEMPLATE_PROPS_KEY = "prism_template_props";
export const TEMPLATE_FOR_KEY = "prism_template_for";

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
  if (v.hideEmptyGroups !== undefined && typeof v.hideEmptyGroups !== "boolean") return false;
  if (v.cardSize !== undefined && !(CARD_SIZES as readonly string[]).includes(v.cardSize as string)) return false;
  if (v.wrap !== undefined && typeof v.wrap !== "boolean") return false;
  if (v.calculations !== undefined) {
    if (!rec(v.calculations)) return false;
    const entries = Object.entries(v.calculations);
    if (entries.length > MAX_AGGREGATES || !entries.every(([k, fn]) => keyOk(k) && isAggregateFn(fn))) return false;
  }
  if (v.visible !== undefined && (!Array.isArray(v.visible) || v.visible.length > VISIBLE_MAX || !v.visible.every(keyOk))) return false;
  if (v.widths !== undefined && (!rec(v.widths) || !Object.entries(v.widths).every(([k, w]) => keyOk(k) && typeof w === "number" && w >= 60 && w <= 1200))) return false;
  if (v.order !== undefined && (!Array.isArray(v.order) || v.order.length > ORDER_MAX || !v.order.every((x) => typeof x === "string"))) return false;
  if (v.sort !== undefined && (!Array.isArray(v.sort) || v.sort.length > SORT_MAX || !v.sort.every((s) => rec(s) && keyOk(s.key) && (s.dir === "asc" || s.dir === "desc")))) return false;
  if (v.filter !== undefined) {
    const f = v.filter;
    if (!rec(f) || (f.match !== "all" && f.match !== "any") || !Array.isArray(f.conditions) || f.conditions.length > CONDITIONS_MAX) return false;
    const condOk = (c: unknown) => rec(c) && keyOk(c.key) && (QUERY_OPS as readonly string[]).includes(c.op as string);
    if (!f.conditions.every(condOk)) return false;
    if (f.groups !== undefined) {
      if (!Array.isArray(f.groups) || f.groups.length > GROUPS_MAX) return false;
      if (!f.groups.every((g) => rec(g) && (g.match === "all" || g.match === "any") && Array.isArray(g.conditions) && g.conditions.length <= CONDITIONS_MAX && g.conditions.every(condOk) && g.groups === undefined)) return false;
    }
  }
  return true;
}

function extrasOk(raw: Record<string, unknown>): boolean {
  if (raw.openIn !== undefined && !(OPEN_MODES as string[]).includes(raw.openIn as string)) return false;
  if (raw.templates !== undefined) {
    const t = raw.templates;
    if (!Array.isArray(t) || t.length > 20) return false;
    if (!t.every((x) => rec(x) && typeof x.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x.id) && typeof x.name === "string" && x.name.trim() !== "" && x.name.length <= 80)) return false;
  }
  if (raw.defaultTemplate !== undefined && (typeof raw.defaultTemplate !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.defaultTemplate))) return false;
  return true;
}

const VISIBLE_MAX = 60;
const CONDITIONS_MAX = 25;
const GROUPS_MAX = 5;
const ORDER_MAX = 10000;
const SORT_MAX = 3;
const cut = <T,>(list: T[], max: number): T[] => (list.length > max ? list.slice(0, max) : list);

/**
 * A view whose lists are longer than the reader accepts, shortened to fit. A list that only grew
 * too long (60 columns shown, a 26th filter condition, a board rank that was never pruned) is not
 * a configuration Prism "does not understand": refusing it left the whole page unreadable with no
 * way back from inside the app. Anything else about the shape is still judged by {@link viewOk}.
 * Returns the same object when nothing was too long.
 */
function fitView<T>(view: T): T {
  if (!rec(view)) return view;
  const v = view as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  if (Array.isArray(v.visible) && v.visible.length > VISIBLE_MAX) next.visible = cut(v.visible, VISIBLE_MAX);
  if (Array.isArray(v.order) && v.order.length > ORDER_MAX) next.order = cut(v.order, ORDER_MAX);
  if (Array.isArray(v.sort) && v.sort.length > SORT_MAX) next.sort = cut(v.sort, SORT_MAX);
  const f = v.filter;
  if (rec(f) && Array.isArray(f.conditions)) {
    const groups = Array.isArray(f.groups) ? cut(f.groups, GROUPS_MAX).map((g) => (rec(g) && Array.isArray(g.conditions) && g.conditions.length > CONDITIONS_MAX ? { ...g, conditions: cut(g.conditions, CONDITIONS_MAX) } : g)) : undefined;
    const long = f.conditions.length > CONDITIONS_MAX || (Array.isArray(f.groups) && (f.groups.length > GROUPS_MAX || groups!.some((g, i) => g !== (f.groups as unknown[])[i])));
    if (long) next.filter = { ...f, conditions: cut(f.conditions, CONDITIONS_MAX), ...(groups ? { groups } : {}) };
  }
  return Object.keys(next).length ? ({ ...v, ...next } as T) : view;
}

/** What is saved is always something the reader accepts (see {@link fitView}). */
export function fitDatabaseConfig(config: DatabaseConfig): DatabaseConfig {
  const views = config.views.map(fitView);
  return views.some((v, i) => v !== config.views[i]) ? { ...config, views } : config;
}

/** Read `prism_database`; null when the note has none yet; throws on an unknown shape. */
export function readDatabaseConfig(metadata: Record<string, unknown> | null | undefined): DatabaseConfig | null {
  let raw = metadata?.prism_database;
  if (raw == null) return null;
  if (rec(raw) && Array.isArray(raw.views)) {
    const stored: unknown[] = raw.views;
    const views = stored.map(fitView);
    if (views.some((v, i) => v !== stored[i])) raw = { ...raw, views };
  }
  if (
    !rec(raw) || raw.version !== 1 || !rec(raw.source) || !Array.isArray(raw.source.tags) ||
    !raw.source.tags.length || raw.source.tags.length > 5 ||
    !raw.source.tags.every((t) => typeof t === "string" && t.length > 0 && t.length <= 128) ||
    !Array.isArray(raw.views) || !raw.views.length || raw.views.length > 20 || !raw.views.every(viewOk) ||
    new Set(raw.views.map((v) => (v as DatabaseView).id)).size !== raw.views.length ||
    !extrasOk(raw)
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

export const MAX_VIEWS = 20;

/** A copy of `view` placed right after it (NP-DB-16): its own id, every setting kept. */
export function duplicateView(config: DatabaseConfig, viewId: string): { config: DatabaseConfig; id: string } | null {
  const at = config.views.findIndex((v) => v.id === viewId);
  if (at < 0 || config.views.length >= MAX_VIEWS) return null;
  const src = config.views[at]!;
  const taken = new Set(config.views.map((v) => v.name));
  const base = `${src.name} copy`.slice(0, 76);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
  const copy: DatabaseView = { ...(JSON.parse(JSON.stringify(src)) as DatabaseView), id: newViewId(), name };
  const views = [...config.views];
  views.splice(at + 1, 0, copy);
  return { config: { ...config, views }, id: copy.id };
}

/**
 * A property moved to another key (a type conversion, NP-DB-11): every view keeps
 * showing, sorting, grouping and filtering by it. Null when nothing names `from`.
 */
export function renamePropertyKey(config: DatabaseConfig, from: string, to: string): DatabaseConfig | null {
  let changed = false;
  const key = (k: string) => (k === from ? ((changed = true), to) : k);
  const conds = <T extends { key: string }>(list: T[]) => list.map((c) => ({ ...c, key: key(c.key) }));
  const views = config.views.map((v) => {
    const next: DatabaseView = { ...v };
    if (v.visible) next.visible = [...new Set(v.visible.map(key))];
    if (v.sort) next.sort = conds(v.sort);
    if (v.groupBy) next.groupBy = key(v.groupBy);
    if (v.dateKey) next.dateKey = key(v.dateKey);
    if (v.coverKey) next.coverKey = key(v.coverKey);
    if (v.widths && Object.prototype.hasOwnProperty.call(v.widths, from)) {
      const { [from]: w, ...rest } = v.widths;
      next.widths = { ...rest, [to]: w! };
      changed = true;
    }
    if (v.filter) {
      next.filter = {
        ...v.filter,
        conditions: conds(v.filter.conditions),
        ...(v.filter.groups ? { groups: v.filter.groups.map((g) => ({ ...g, conditions: conds(g.conditions) })) } : {}),
      };
    }
    return next;
  });
  return changed ? { ...config, views } : null;
}

/**
 * A converted property keeps working in EVERY database over its tag without any
 * note being rewritten: where a field says it was converted from another one
 * (`convertedFrom`, set by the server), is shown, and that other field is now
 * deleted, a saved view that still names the old key is READ as naming the new
 * one — columns, widths, sort, group, date / cover key and filters. The next time
 * somebody saves the view it is stored that way. Restoring the old property (it
 * is no longer deleted) ends the aliasing. Chains (a → a_number → a_number_text)
 * are followed.
 */
export function followConversions(config: DatabaseConfig, schemas: Record<string, { fields: Record<string, { convertedFrom?: string; deleted?: boolean }> } | undefined>): DatabaseConfig {
  let out = config;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const tag of config.source.tags) {
      const fields = schemas[tag]?.fields;
      if (!fields) continue;
      for (const [key, f] of Object.entries(fields)) {
        const from = f.convertedFrom;
        if (!from || f.deleted || from === key || !Object.prototype.hasOwnProperty.call(fields, from) || fields[from]!.deleted !== true) continue;
        const next = renamePropertyKey(out, from, key);
        if (next) { out = next; moved = true; }
      }
    }
    if (!moved) break;
  }
  return out;
}

/** Move a view tab to `to` (an index in the current order). */
export function moveView(config: DatabaseConfig, viewId: string, to: number): DatabaseConfig | null {
  const from = config.views.findIndex((v) => v.id === viewId);
  const target = Math.max(0, Math.min(config.views.length - 1, to));
  if (from < 0 || from === target) return null;
  const views = [...config.views];
  const [v] = views.splice(from, 1);
  views.splice(target, 0, v!);
  return { ...config, views };
}

/** A path for a new row: inside the database page's own folder. */
export function rowPath(dbPath: string | null, title: string): string {
  const safe = safeTitleLeaf(title);
  const base = (dbPath ?? "").replace(/\.[^./]+$/, "");
  return base ? `${base}/${safe}` : safe;
}

/** The columns a view shows before anyone has chosen: the first few of the database's own properties
 *  (never the system ones). The view and its settings must agree, or the first box ticked in View
 *  settings saved "every property" as the choice. */
export function defaultVisibleKeys(props: ReadonlyArray<{ key: string; system?: unknown }>, type: ViewType | undefined): string[] {
  return props.filter((p) => !p.system).slice(0, type === "table" ? 12 : 4).map((p) => p.key);
}
