/**
 * Database-view query engine — PURE, shared by the Prism Server (`POST /api/query`,
 * apps/server/src/routes/databases.ts) and the client fallback (shells without
 * that route, e.g. the legacy desktop, run the same code over `listNotes`).
 *
 * One engine on both sides means a view filters, sorts and pages identically
 * whether the server or the browser evaluates it. It never touches permissions:
 * the server applies `effectiveCaps(...).has("view")` BEFORE handing rows here.
 *
 * Keys are metadata field names, or one of the pseudo-fields below. Values are
 * compared leniently where Prism data is lenient: strings case-insensitively and
 * with `[[wikilink]]` brackets stripped, arrays by membership, numbers and ISO
 * dates by value. A missing value never satisfies a comparison except
 * `ne` / `nin` / `not_contains` / `not_exists`, and always sorts last.
 */
import { dateRange, dayDiff } from "./dates";
import { TEMPLATE_TAG, isTemplateNote } from "../pages/model";
import { containerTitle } from "../pages/containerTitle";
import { scalarText } from "./structured";

export const QUERY_OPS = [
  "eq", "ne", "in", "nin", "contains", "not_contains",
  "gt", "gte", "lt", "lte", "exists", "not_exists",
] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

/** Pseudo-fields that read note columns instead of metadata. */
export const PSEUDO_KEYS = ["$title", "$path", "$createdAt", "$updatedAt", "$tags"] as const;
export type PseudoKey = (typeof PSEUDO_KEYS)[number];

export interface QueryCondition {
  key: string;
  op: QueryOp;
  value?: unknown;
}
export interface QueryFilterGroup {
  match: "all" | "any";
  conditions: QueryCondition[];
}
export interface QueryFilter {
  /** `all` = AND, `any` = OR — how the top-level conditions AND groups combine. */
  match: "all" | "any";
  conditions: QueryCondition[];
  /**
   * One level of nested groups ("advanced filter"): each group is its own AND/OR
   * over flat conditions and counts as ONE term of the top level. Groups never
   * nest further. Conditions across the top level and every group are ≤ 25.
   */
  groups?: QueryFilterGroup[];
}
export interface QuerySort {
  key: string;
  dir: "asc" | "desc";
}
export interface QuerySpec {
  /** Notes must carry EVERY tag (1–5). */
  tags: string[];
  filter?: QueryFilter;
  sort?: QuerySort[];
  /** Page size, 1–500 (default 100). */
  limit?: number;
  /** Opaque, from a previous page's `next`; bound to this exact query. */
  cursor?: string | null;
  /** Metadata keys to return per row (≤ 40; `title` is always returned).
   *  Omitted = each row's whole metadata (no content). */
  fields?: string[];
  /** Case-insensitive substring over the title AND the row's text properties
   *  (string / string[] values of `fields`, or of every non-system key when
   *  `fields` is omitted). `[[link]]` brackets are ignored. */
  search?: string;
  /** The caller's `Date#getTimezoneOffset()` (minutes, −840…840): `@today` and
   *  date-vs-datetime comparisons use the caller's local day. Default 0 (UTC). */
  tzOffset?: number;
  /** Only rows assigned to the CALLER (wave 3, Home → My tasks): the server
   *  resolves who the caller is (their person note / addresses) and keeps rows
   *  whose `assigned`/`assignee` value names them. Signed-in users only; ignored
   *  by the pure engine (the server narrows its input). */
  assignedToMe?: boolean;
  /**
   * Calculations over EVERY matching row the caller may see (not only the page):
   * ≤ 20 `{key, fn}` pairs. Answered in `QueryPage.aggregates`.
   */
  aggregates?: AggregateRequest[];
  /** Also answer the calculations (and a row count) per group of this property. */
  groupBy?: AggregateGroupBy;
}

// ── calculations ─────────────────────────────────────────────────────────────

/** Every calculation a view footer can show. Unknown names are refused everywhere. */
export const AGGREGATE_FNS = [
  "count_all", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty",
  "sum", "average", "median", "min", "max", "range",
  "earliest", "latest", "date_range",
  "checked", "unchecked", "percent_checked",
] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];
export const isAggregateFn = (v: unknown): v is AggregateFn => typeof v === "string" && (AGGREGATE_FNS as readonly string[]).includes(v);
export const MAX_AGGREGATES = 20;
/** Groups answered per query; more distinct values than this are left out (`groupsCapped`). */
export const MAX_AGGREGATE_GROUPS = 500;
/**
 * Work bounds of one calculation request (it runs on the server's event loop):
 * a row joins at most this many groups (its first distinct values)…
 */
export const MAX_GROUPS_PER_ROW = 25;
/** …a multi-value cell is read up to this many values… */
export const MAX_VALUES_PER_CELL = 50;
/** …and one request adds at most this many values to its figures; then it stops and says `truncated`. */
export const AGGREGATE_BUDGET = 2_000_000;
/** How far into a multi-value group cell the distinct values are looked for. */
const GROUP_SCAN = 200;

export interface AggregateRequest {
  key: string;
  fn: AggregateFn;
}
export interface AggregateGroupBy {
  key: string;
  /** A checkbox property: a missing value belongs to the "false" group (never the empty one). */
  checkbox?: boolean;
}
/**
 * A figure: a count / sum / … (number), a share 0–1 (`percent_*`), whole days
 * (`date_range`), a stored date string (`earliest` / `latest`), or null when the
 * rows hold nothing to calculate from.
 */
export type AggregateValue = number | string | null;
/** `{[propertyKey]: {[fn]: value}}` */
export type AggregateValues = Record<string, Partial<Record<AggregateFn, AggregateValue>>>;
export interface AggregateGroup {
  /** The group's stored value (`"true"`/`"false"` for a checkbox); null = rows without one. */
  value: string | null;
  /** Matching rows in the group. */
  count: number;
  aggregates: AggregateValues;
}

/** The lean note shape the engine evaluates (no content). */
export interface QueryInput {
  id: string;
  path: string | null;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string | null;
  metadata: Record<string, unknown> | null;
  _caps?: string[];
  canEdit?: boolean;
}
export interface QueryRow {
  id: string;
  path: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string | null;
  /** Only the selected keys (+ `title`). */
  metadata: Record<string, unknown>;
  /** Non-owner, signed-in rows only (the gateway's caps annotation). */
  _caps?: string[];
  /** Whether THIS caller may edit the row (server answer; absent from the fallback engine). */
  canEdit?: boolean;
}
export interface QueryPage {
  /** `assignedToMe` queries only: "person" when a person page stands for the
   *  caller, "account" when only their sign-in address could be matched, "unset"
   *  when the server owner has no owner identity configured (rows are NOT narrowed). */
  identity?: "person" | "account" | "unset";
  rows: QueryRow[];
  /** Cursor for the next page, or null at the end. */
  next: string | null;
  /** Matching rows the caller may see (never counts hidden notes). */
  total: number;
  /**
   * True when results are permission-filtered for this caller (any non-owner):
   * the view may not be every note carrying the tag. Deliberately NOT "something
   * was hidden" — that would leak the existence of notes the caller cannot see.
   */
  limited: boolean;
  /**
   * True when the server stopped scanning at its inventory cap — or, for a
   * calculation request, when the figures stopped at their work bounds
   * ({@link AGGREGATE_BUDGET}, {@link MAX_VALUES_PER_CELL}).
   */
  truncated: boolean;
  /**
   * The requested calculations over every matching row the caller may see. When
   * `truncated` they cover only part of them (a lower bound for counts). A
   * calculation the server will not answer for this caller is null, never absent.
   */
  aggregates?: AggregateValues;
  /** With `groupBy`: the same calculations (and a row count) per group. */
  groups?: AggregateGroup[];
  /**
   * Groups are missing or incomplete: more than {@link MAX_AGGREGATE_GROUPS} distinct
   * values, a row with more than {@link MAX_GROUPS_PER_ROW}, or the work budget ran out.
   */
  groupsCapped?: boolean;
}

export const QUERY_MAX_LIMIT = 500;
export const QUERY_DEFAULT_LIMIT = 100;
const MAX_TAGS = 5;
const MAX_CONDITIONS = 25;
const MAX_GROUPS = 5;
const MAX_SORTS = 3;
const MAX_FIELDS = 40;

/** Metadata keys a view may read or write. Excludes prototype-pollution names. */
export const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const isFieldKey = (k: unknown): k is string =>
  typeof k === "string" && FIELD_KEY.test(k) && !BANNED_KEYS.has(k);
const isKey = (k: unknown): k is string =>
  isFieldKey(k) || (typeof k === "string" && (PSEUDO_KEYS as readonly string[]).includes(k));
const isTag = (t: unknown): t is string =>
  typeof t === "string" && t.length > 0 && t.length <= 128 && !/[\u0000-\u001f]/.test(t);

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** Validate an untrusted spec (the request body). Never throws. */
export function validateQuerySpec(raw: unknown): { ok: true; spec: QuerySpec } | { ok: false; error: string } {
  if (!record(raw)) return { ok: false, error: "body must be an object" };
  const tags = raw.tags;
  if (!Array.isArray(tags) || !tags.length || tags.length > MAX_TAGS || !tags.every(isTag)) {
    return { ok: false, error: `tags must be 1–${MAX_TAGS} tag names` };
  }
  const spec: QuerySpec = { tags: [...new Set(tags as string[])] };
  if (raw.filter !== undefined && raw.filter !== null) {
    const f = raw.filter;
    if (!record(f) || (f.match !== "all" && f.match !== "any") || !Array.isArray(f.conditions) || f.conditions.length > MAX_CONDITIONS) {
      return { ok: false, error: `filter must be {match: "all"|"any", conditions: [≤${MAX_CONDITIONS}]}` };
    }
    const parsed = parseConditions(f.conditions);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    spec.filter = { match: f.match, conditions: parsed };
    if (f.groups !== undefined && f.groups !== null) {
      if (!Array.isArray(f.groups) || f.groups.length > MAX_GROUPS) return { ok: false, error: `filter.groups must be ≤${MAX_GROUPS} groups` };
      const groups: QueryFilterGroup[] = [];
      let total = parsed.length;
      for (const g of f.groups) {
        // One level only: a group carrying its own `groups` is refused, not ignored.
        if (!record(g) || (g.match !== "all" && g.match !== "any") || !Array.isArray(g.conditions) || g.groups !== undefined) {
          return { ok: false, error: "each group must be {match: \"all\"|\"any\", conditions: [...]} (no nesting)" };
        }
        const gc = parseConditions(g.conditions);
        if (typeof gc === "string") return { ok: false, error: gc };
        total += gc.length;
        groups.push({ match: g.match, conditions: gc });
      }
      if (total > MAX_CONDITIONS) return { ok: false, error: `a filter holds ≤${MAX_CONDITIONS} conditions in all` };
      if (groups.length) spec.filter.groups = groups;
    }
  }
  if (raw.sort !== undefined && raw.sort !== null) {
    if (!Array.isArray(raw.sort) || raw.sort.length > MAX_SORTS) return { ok: false, error: `sort must be ≤${MAX_SORTS} keys` };
    const sort: QuerySort[] = [];
    for (const s of raw.sort) {
      if (!record(s) || !isKey(s.key) || (s.dir !== "asc" && s.dir !== "desc")) return { ok: false, error: "each sort needs a valid key and dir" };
      sort.push({ key: s.key as string, dir: s.dir });
    }
    spec.sort = sort;
  }
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > QUERY_MAX_LIMIT) {
      return { ok: false, error: `limit must be 1–${QUERY_MAX_LIMIT}` };
    }
    spec.limit = raw.limit;
  }
  if (raw.cursor !== undefined && raw.cursor !== null) {
    if (typeof raw.cursor !== "string" || raw.cursor.length > 512) return { ok: false, error: "invalid cursor" };
    spec.cursor = raw.cursor;
  }
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields) || raw.fields.length > MAX_FIELDS || !raw.fields.every(isFieldKey)) {
      return { ok: false, error: `fields must be ≤${MAX_FIELDS} metadata keys` };
    }
    spec.fields = [...new Set(raw.fields as string[])];
  }
  if (raw.tzOffset !== undefined) {
    if (typeof raw.tzOffset !== "number" || !Number.isInteger(raw.tzOffset) || Math.abs(raw.tzOffset) > 840) return { ok: false, error: "tzOffset must be minutes in −840…840" };
    spec.tzOffset = raw.tzOffset;
  }
  if (raw.assignedToMe !== undefined) {
    if (typeof raw.assignedToMe !== "boolean") return { ok: false, error: "assignedToMe must be a boolean" };
    if (raw.assignedToMe) spec.assignedToMe = true;
  }
  if (raw.search !== undefined && raw.search !== "") {
    if (typeof raw.search !== "string" || raw.search.length > 200) return { ok: false, error: "search must be ≤200 chars" };
    spec.search = raw.search;
  }
  if (raw.aggregates !== undefined && raw.aggregates !== null) {
    if (!Array.isArray(raw.aggregates) || raw.aggregates.length > MAX_AGGREGATES) return { ok: false, error: `aggregates must be ≤${MAX_AGGREGATES} {key, fn} pairs` };
    const aggregates: AggregateRequest[] = [];
    for (const a of raw.aggregates) {
      if (!record(a) || !isKey(a.key) || !isAggregateFn(a.fn) || Object.keys(a).some((k) => k !== "key" && k !== "fn")) return { ok: false, error: "each aggregate needs a valid key and fn" };
      if (!aggregates.some((x) => x.key === a.key && x.fn === a.fn)) aggregates.push({ key: a.key as string, fn: a.fn });
    }
    if (aggregates.length) spec.aggregates = aggregates;
  }
  if (raw.groupBy !== undefined && raw.groupBy !== null) {
    const g = raw.groupBy;
    if (!record(g) || !isKey(g.key) || (g.checkbox !== undefined && typeof g.checkbox !== "boolean") || Object.keys(g).some((k) => k !== "key" && k !== "checkbox")) {
      return { ok: false, error: "groupBy must be {key, checkbox?}" };
    }
    spec.groupBy = { key: g.key as string, ...(g.checkbox ? { checkbox: true } : {}) };
  }
  return { ok: true, spec };
}

function parseConditions(raw: unknown[]): QueryCondition[] | string {
  if (raw.length > MAX_CONDITIONS) return `≤${MAX_CONDITIONS} conditions`;
  const conditions: QueryCondition[] = [];
  for (const c of raw) {
    if (!record(c) || !isKey(c.key) || !(QUERY_OPS as readonly string[]).includes(c.op as string)) {
      return "each condition needs a valid key and op";
    }
    const op = c.op as QueryOp;
    const v = c.value;
    if (op === "in" || op === "nin") {
      if (!Array.isArray(v) || v.length > 100 || !v.every(scalar)) return `${op} needs an array of ≤100 values`;
    } else if (op !== "exists" && op !== "not_exists") {
      if (!scalar(v) || (typeof v === "string" && v.length > 500)) return `${op} needs a scalar value`;
    }
    conditions.push({ key: c.key as string, op, ...(op === "exists" || op === "not_exists" ? {} : { value: v }) });
  }
  return conditions;
}

/** Every condition of a filter, top level and groups (for lean key lists). */
export function filterConditions(f: QueryFilter | undefined): QueryCondition[] {
  return f ? [...f.conditions, ...(f.groups ?? []).flatMap((g) => g.conditions)] : [];
}

/**
 * Every metadata key the engine must read to evaluate `spec` (for lean listings),
 * or null when `spec.fields` is omitted — then every row carries its whole
 * metadata (still never content), for tags with no schema to name the keys.
 */
export function metadataKeysFor(spec: QuerySpec): string[] | null {
  if (!spec.fields) return null;
  const keys = new Set<string>(["title"]);
  for (const k of spec.fields ?? []) keys.add(k);
  for (const c of filterConditions(spec.filter)) if (isFieldKey(c.key)) keys.add(c.key);
  for (const s of spec.sort ?? []) if (isFieldKey(s.key)) keys.add(s.key);
  for (const a of spec.aggregates ?? []) if (isFieldKey(a.key)) keys.add(a.key);
  if (spec.groupBy && isFieldKey(spec.groupBy.key)) keys.add(spec.groupBy.key);
  return [...keys];
}

// ── values ───────────────────────────────────────────────────────────────────

/** The display title: `metadata.title`, else the path leaf without extension. */
export function noteTitle(n: Pick<QueryInput, "path" | "metadata" | "id">): string {
  const t = n.metadata?.title;
  if (typeof t === "string" && t.trim()) return t.trim();
  const container = containerTitle(n.path, n.metadata);
  if (container) return container;
  const leaf = n.path?.split("/").pop()?.replace(/\.[^.]+$/, "");
  return leaf || "Untitled";
}

export function readKey(n: QueryInput, key: string): unknown {
  switch (key) {
    case "$title": return noteTitle(n);
    case "$path": return n.path;
    case "$createdAt": return n.createdAt;
    case "$updatedAt": return n.updatedAt;
    case "$tags": return n.tags ?? [];
    default: return Object.prototype.hasOwnProperty.call(n.metadata ?? {}, key) ? n.metadata![key] : undefined;
  }
}

/**
 * `[[vault/people/Ada|Ada L]]` → `vault/people/ada`; trims; lowercases.
 * LINEAR on purpose (review H2): the old `/\|.*$/` was quadratic on values with
 * many `|`, and search runs this on every string of every row.
 */
export function unwrapLink(v: string): string {
  let s = v.trim();
  if (s.length >= 4 && s.startsWith("[[") && s.endsWith("]]")) s = s.slice(2, -2);
  return s;
}
const norm = (v: string) => {
  const s = unwrapLink(v);
  const bar = s.indexOf("|");
  return (bar >= 0 ? s.slice(0, bar) : s).toLowerCase();
};

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** `@today`, `@today+7`, `@today-3` → YYYY-MM-DD on the caller's local day. */
export function resolveRelative(v: unknown, now: Date, tzOffset = 0): unknown {
  if (typeof v !== "string") return v;
  const m = v.match(/^@today([+-]\d{1,4})?$/);
  if (!m) return v;
  const d = new Date(now.getTime() - tzOffset * 60_000);
  d.setUTCDate(d.getUTCDate() + Number(m[1] ?? 0));
  return d.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}[\d:.]*(Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;
/** Instant of an ISO datetime; a zone-less one is wall time in the caller's zone. */
function instant(s: string, tzOffset: number): number {
  if (HAS_ZONE.test(s)) return Date.parse(s.replace(" ", "T"));
  return Date.parse(`${s.replace(" ", "T")}Z`) + tzOffset * 60_000;
}
/** The caller's local calendar day of an ISO date/datetime. */
function localDay(s: string, tzOffset: number): string {
  if (DATE_ONLY.test(s) || !HAS_ZONE.test(s)) return s.slice(0, 10);
  const t = Date.parse(s.replace(" ", "T"));
  return Number.isNaN(t) ? s.slice(0, 10) : new Date(t - tzOffset * 60_000).toISOString().slice(0, 10);
}

/**
 * Total order for two present scalar values: numbers, then ISO dates (a date vs
 * a datetime compares the datetime's LOCAL day; two datetimes compare as
 * instants, across zones), then text.
 */
export function compareValues(a: unknown, b: unknown, tzOffset = 0): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a === true) - Number(b === true);
  // A date range (`start/end`) orders by its start.
  // `scalarText`, never `String`: an object compares by its name, and cannot throw.
  const sa = rangeEnd(scalarText(a), "start");
  const sb = rangeEnd(scalarText(b), "start");
  const na = Number(sa);
  const nb = Number(sb);
  if (sa.trim() !== "" && sb.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (ISO_DATE.test(sa) && ISO_DATE.test(sb)) {
    if (DATE_ONLY.test(sa) || DATE_ONLY.test(sb)) {
      const da = localDay(sa, tzOffset);
      const dbb = localDay(sb, tzOffset);
      return da < dbb ? -1 : da > dbb ? 1 : 0;
    }
    const ia = instant(sa, tzOffset);
    const ib = instant(sb, tzOffset);
    if (!Number.isNaN(ia) && !Number.isNaN(ib)) return ia - ib;
  }
  return norm(sa).localeCompare(norm(sb));
}

/** One end of a date range; any other string unchanged. */
function rangeEnd(s: string, side: "start" | "end"): string {
  if (s.indexOf("/") < 10) return s;
  const r = dateRange(s);
  return r ? r[side === "start" ? 0 : 1] : s;
}

function equalsOne(actual: unknown, expected: unknown, tz = 0): boolean {
  if (Array.isArray(actual)) return actual.some((a) => equalsOne(a, expected, tz));
  if (isEmpty(actual)) return isEmpty(expected);
  if (typeof actual === "string" && typeof expected === "string") {
    // A range "is" a date when that date falls inside it.
    const r = dateRange(actual.trim());
    if (r && ISO_DATE.test(expected.trim())) return compareValues(r[0], expected.trim(), tz) <= 0 && compareValues(r[1], expected.trim(), tz) >= 0;
    if (ISO_DATE.test(actual.trim()) && ISO_DATE.test(expected.trim())) return compareValues(actual.trim(), expected.trim(), tz) === 0;
    return norm(actual) === norm(expected);
  }
  if (typeof actual === "boolean" || typeof expected === "boolean") return scalarText(actual) === scalarText(expected);
  return compareValues(actual, expected, tz) === 0;
}

function contains(actual: unknown, needle: unknown): boolean {
  if (isEmpty(actual) || needle === null || needle === undefined) return false;
  const n = norm(scalarText(needle));
  // An object item is searched by its readable text ("Ada Lovelace — delegate").
  if (Array.isArray(actual)) return actual.some((a) => typeof a === "string" ? norm(a).includes(n) : typeof a === "object" && a !== null ? scalarText(a).toLowerCase().includes(n) : scalarText(a) === scalarText(needle));
  return norm(scalarText(actual)).includes(n);
}

/**
 * `side`: which end of a date RANGE the comparison reads — "after / on or after"
 * look at its end, "before / on or before" at its start, so a window filter
 * (`>= from` AND `<= to`) keeps every range that overlaps the window.
 */
function ordered(actual: unknown, expected: unknown, test: (c: number) => boolean, tz: number, side: "start" | "end"): boolean {
  if (isEmpty(actual) || isEmpty(expected)) return false;
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((v) => !isEmpty(v) && test(compareValues(typeof v === "string" ? rangeEnd(v, side) : v, expected, tz)));
}

/**
 * "Me" as a filter value: a view stores this token, never an address, and it is
 * resolved for whoever is looking — by the server, which knows the caller
 * (`eq` / `contains` = the property names me, `ne` / `not_contains` = it does not).
 */
export const ME_TOKEN = "@me";
/** Does `key` of this row name the caller? Supplied by whoever knows the caller. */
export type MeResolver = (n: QueryInput, key: string) => boolean;
const ME_POSITIVE: ReadonlySet<QueryOp> = new Set(["eq", "contains"]);
const ME_NEGATIVE: ReadonlySet<QueryOp> = new Set(["ne", "not_contains"]);

export function evaluateCondition(n: QueryInput, c: QueryCondition, now = new Date(), tzOffset = 0, me?: MeResolver): boolean {
  if (c.value === ME_TOKEN && (ME_POSITIVE.has(c.op) || ME_NEGATIVE.has(c.op))) {
    // Nobody to resolve it for (a shell without the server route): no row is "mine".
    const mine = me ? me(n, c.key) : false;
    return ME_POSITIVE.has(c.op) ? mine : !mine;
  }
  const actual = readKey(n, c.key);
  const value = resolveRelative(c.value, now, tzOffset);
  const tz = tzOffset;
  switch (c.op) {
    case "eq": return equalsOne(actual, value, tz);
    case "ne": return !equalsOne(actual, value, tz);
    case "in": return (value as unknown[]).some((v) => equalsOne(actual, resolveRelative(v, now, tz), tz));
    case "nin": return !(value as unknown[]).some((v) => equalsOne(actual, resolveRelative(v, now, tz), tz));
    case "contains": return contains(actual, value);
    case "not_contains": return !contains(actual, value);
    case "gt": return ordered(actual, value, (x) => x > 0, tz, "end");
    case "gte": return ordered(actual, value, (x) => x >= 0, tz, "end");
    case "lt": return ordered(actual, value, (x) => x < 0, tz, "start");
    case "lte": return ordered(actual, value, (x) => x <= 0, tz, "start");
    case "exists": return !isEmpty(actual);
    case "not_exists": return isEmpty(actual);
  }
}

function matchesGroup(n: QueryInput, g: QueryFilterGroup, now: Date, tzOffset: number, me?: MeResolver): boolean {
  if (!g.conditions.length) return true;
  return g.match === "all"
    ? g.conditions.every((c) => evaluateCondition(n, c, now, tzOffset, me))
    : g.conditions.some((c) => evaluateCondition(n, c, now, tzOffset, me));
}

export function matchesFilter(n: QueryInput, f: QueryFilter | undefined, now = new Date(), tzOffset = 0, me?: MeResolver): boolean {
  if (!f) return true;
  // Empty groups are no-ops (a half-built group in the editor never empties a view).
  const terms: Array<() => boolean> = [
    ...f.conditions.map((c) => () => evaluateCondition(n, c, now, tzOffset, me)),
    ...(f.groups ?? []).filter((g) => g.conditions.length).map((g) => () => matchesGroup(n, g, now, tzOffset, me)),
  ];
  if (!terms.length) return true;
  return f.match === "all" ? terms.every((t) => t()) : terms.some((t) => t());
}

/** Keys never searched: system/permission state (`prism_*`, `gov_*`, `_*`) and presentation keys. */
const UNSEARCHED = /^(prism_|gov_|_)|^(type|icon|cover|layout|sync|content_font)$/;

/** Title, then text-ish property values of `fields` (or every non-system key). */
export function matchesSearch(n: QueryInput, needle: string, fields: string[] | undefined): boolean {
  if (noteTitle(n).toLowerCase().includes(needle)) return true;
  const meta = n.metadata ?? {};
  const keys = fields ?? Object.keys(meta);
  // Text, or an object's readable text (bounded by `valueText`).
  const hit = (v: unknown): boolean => typeof v === "string" ? v.length <= 10_000 && norm(v).includes(needle) : typeof v === "object" && v !== null && scalarText(v).toLowerCase().includes(needle);
  for (const k of keys) {
    if (k === "title" || UNSEARCHED.test(k) || !Object.prototype.hasOwnProperty.call(meta, k)) continue;
    const v = meta[k];
    if (Array.isArray(v) ? v.slice(0, 200).some(hit) : hit(v)) return true;
  }
  return false;
}

function sortValue(n: QueryInput, key: string): unknown {
  const v = readKey(n, key);
  return Array.isArray(v) ? v[0] : v;
}

/** Stable multi-key sort; missing values last in either direction; id breaks ties. */
export function sortRows<T extends QueryInput>(rows: T[], sort: QuerySort[] | undefined, tzOffset = 0): T[] {
  const keys = sort?.length ? sort : [{ key: "$updatedAt", dir: "desc" as const }];
  return [...rows].sort((a, b) => {
    for (const s of keys) {
      const va = sortValue(a, s.key);
      const vb = sortValue(b, s.key);
      const ea = isEmpty(va);
      const eb = isEmpty(vb);
      if (ea || eb) {
        if (ea && eb) continue;
        return ea ? 1 : -1;
      }
      const c = compareValues(va, vb, tzOffset);
      if (c !== 0) return s.dir === "asc" ? c : -c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── calculations ─────────────────────────────────────────────────────────────

/**
 * A number for a calculation: a finite number, or a string that is exactly a
 * decimal (`12`, `-0.5`, `.5`, `1e3`). Not `Number()`'s reading: no hex / octal /
 * binary, no surrounding blanks, no "Infinity". Else null.
 */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
export function numericValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.length > 64 || !DECIMAL.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** What one calculation request may still spend, and whether anything was cut. */
interface AggregateRun { left: number; cut: boolean }

const FAMILY: Record<AggregateFn, "count" | "number" | "date" | "check"> = {
  count_all: "count", count_values: "count", count_unique: "count", count_empty: "count", count_not_empty: "count", percent_empty: "count", percent_not_empty: "count",
  sum: "number", average: "number", median: "number", min: "number", max: "number", range: "number",
  earliest: "date", latest: "date", date_range: "date",
  checked: "check", unchecked: "check", percent_checked: "check",
};

/** One property's running figures over one set of rows. Only what its requested fns need is kept. */
class Collector {
  rows = 0;
  empty = 0;
  values = 0;
  checked = 0;
  sum = 0;
  /** Numbers seen (what `average` divides by). */
  numbers = 0;
  min = Infinity;
  max = -Infinity;
  nums: number[] | null;
  unique: Set<string> | null;
  first: string | null = null;
  last: string | null = null;
  private firstAt = Infinity;
  private lastAt = -Infinity;
  readonly need: Plan["need"];
  constructor(need: Plan["need"]) {
    this.need = need;
    this.nums = need.median ? [] : null;
    this.unique = need.unique ? new Set() : null;
  }
  add(v: unknown, tz: number, run: AggregateRun): void {
    this.rows++;
    if (v === true) this.checked++;
    if (isEmpty(v)) { this.empty++; run.left--; return; }
    if (Array.isArray(v)) {
      // The first values only: a cell is never read further, however long it is.
      const end = Math.min(v.length, MAX_VALUES_PER_CELL);
      if (v.length > end) run.cut = true;
      run.left -= end;
      for (let i = 0; i < end; i++) if (!isEmpty(v[i])) this.one(v[i], tz);
    } else {
      run.left--;
      this.one(v, tz);
    }
  }
  private one(v: unknown, tz: number): void {
    this.values++;
    if (this.unique) this.unique.add(typeof v === "string" ? norm(v) : scalarText(v));
    if (this.need.number) {
      const n = numericValue(v);
      if (n !== null) {
        this.sum += n;
        this.numbers++;
        if (n < this.min) this.min = n;
        if (n > this.max) this.max = n;
        this.nums?.push(n);
      }
    }
    if (this.need.date && typeof v === "string") {
      const d = dateSpan(v, tz);
      if (!d) return;
      if (d.from < this.firstAt) { this.firstAt = d.from; this.first = d.start; }
      if (d.to > this.lastAt) { this.lastAt = d.to; this.last = d.end; }
    }
  }
  value(fn: AggregateFn, tz: number): AggregateValue {
    const share = (part: number) => (this.rows ? part / this.rows : null);
    const any = this.max !== -Infinity;
    switch (fn) {
      case "count_all": return this.rows;
      case "count_values": return this.values;
      case "count_unique": return this.unique?.size ?? 0;
      case "count_empty": return this.empty;
      case "count_not_empty": return this.rows - this.empty;
      case "percent_empty": return share(this.empty);
      case "percent_not_empty": return share(this.rows - this.empty);
      case "checked": return this.checked;
      case "unchecked": return this.rows - this.checked;
      case "percent_checked": return share(this.checked);
      case "sum": return any ? this.sum : null;
      case "min": return any ? this.min : null;
      case "max": return any ? this.max : null;
      case "range": return any ? this.max - this.min : null;
      case "average": return this.numbers ? this.sum / this.numbers : null;
      case "median": {
        const a = this.nums;
        if (!a?.length) return null;
        const sorted = Float64Array.from(a).sort();
        const mid = sorted.length >> 1;
        return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      }
      case "earliest": return this.first;
      case "latest": return this.last;
      case "date_range": return this.first !== null && this.last !== null ? Math.abs(dayDiff(localDay(this.first, tz), localDay(this.last, tz))) : null;
    }
  }
}

/**
 * When a date value starts and ends, as instants: a plain day runs from its local
 * midnight to the end of that day in the caller's zone; a range from its start
 * (earliest) to its end (latest), like the filter operators read one. Null when
 * the text is not a date. The last answer is kept: a row's value is asked for
 * once per set it belongs to (the view, its group).
 */
let spanMemo: { v: string; tz: number; out: { start: string; end: string; from: number; to: number } | null } | null = null;
function dateSpan(v: string, tz: number): { start: string; end: string; from: number; to: number } | null {
  if (spanMemo && spanMemo.v === v && spanMemo.tz === tz) return spanMemo.out;
  let out: { start: string; end: string; from: number; to: number } | null = null;
  if (v.length <= 80) {
    const s = v.trim();
    const r = s.length > 10 ? dateRange(s) : null;
    const start = r ? r[0] : s;
    const end = r ? r[1] : s;
    if (ISO_DATE.test(start) && ISO_DATE.test(end)) {
      const from = DATE_ONLY.test(start) ? Date.parse(`${start}T00:00:00Z`) + tz * 60_000 : instant(start, tz);
      const to = DATE_ONLY.test(end) ? Date.parse(`${end}T00:00:00Z`) + tz * 60_000 + 86_399_999 : instant(end, tz);
      if (!Number.isNaN(from) && !Number.isNaN(to)) out = { start, end, from, to };
    }
  }
  spanMemo = { v, tz, out };
  return out;
}

interface Plan { key: string; fns: AggregateFn[]; need: { unique: boolean; number: boolean; median: boolean; date: boolean } }
function planAggregates(requests: AggregateRequest[]): Plan[] {
  const byKey = new Map<string, Plan>();
  for (const r of requests) {
    let p = byKey.get(r.key);
    if (!p) byKey.set(r.key, (p = { key: r.key, fns: [], need: { unique: false, number: false, median: false, date: false } }));
    if (!p.fns.includes(r.fn)) p.fns.push(r.fn);
    if (r.fn === "count_unique") p.need.unique = true;
    if (FAMILY[r.fn] === "number") p.need.number = true;
    if (r.fn === "median") p.need.median = true;
    if (FAMILY[r.fn] === "date") p.need.date = true;
  }
  return [...byKey.values()];
}
class Bucket {
  count = 0;
  readonly cols: Collector[];
  constructor(plans: Plan[]) { this.cols = plans.map((p) => new Collector(p.need)); }
  add(vals: unknown[], tz: number, run: AggregateRun): void {
    this.count++;
    run.left--;
    for (let i = 0; i < vals.length; i++) {
      this.cols[i]!.add(vals[i], tz, run);
    }
  }
  result(plans: Plan[], tz: number): AggregateValues {
    const out: AggregateValues = {};
    plans.forEach((p, i) => {
      const fns: Partial<Record<AggregateFn, AggregateValue>> = {};
      for (const fn of p.fns) fns[fn] = this.cols[i]!.value(fn, tz);
      out[p.key] = fns;
    });
    return out;
  }
}

/** The group value(s) a row belongs to — the same rule the grouped layouts draw by. */
export function groupValuesOf(v: unknown, checkbox = false): Array<string | null> {
  if (checkbox) return [String(v === true)];
  // A value a cell repeats is one membership: the row is in that group once.
  if (Array.isArray(v)) return v.length ? [...new Set(v.map(scalarText))] : [null];
  return isEmpty(v) ? [null] : [scalarText(v)];
}

/**
 * The groups ONE row is counted in: its first {@link MAX_GROUPS_PER_ROW} distinct
 * values, looked for in the first {@link GROUP_SCAN} entries of the cell. `cut`
 * when the cell held more.
 */
function rowGroups(v: unknown, checkbox: boolean | undefined): { values: Array<string | null>; cut: boolean } {
  if (checkbox || !Array.isArray(v)) return { values: groupValuesOf(v, checkbox), cut: false };
  if (!v.length) return { values: [null], cut: false };
  const end = Math.min(v.length, GROUP_SCAN);
  const seen = new Set<string>();
  let cut = v.length > end;
  for (let i = 0; i < end; i++) {
    const s = scalarText(v[i]);
    if (seen.has(s)) continue;
    if (seen.size >= MAX_GROUPS_PER_ROW) { cut = true; break; }
    seen.add(s);
  }
  return { values: [...seen], cut };
}

/**
 * Calculations over `rows` (already filtered — and, on the server, already
 * permission-filtered: a row the caller cannot see is never in here). One pass;
 * `median` sorts the numbers it kept, `count_unique` keeps a set.
 *
 * Bounded work, whatever the rows hold (this runs on the server's event loop): a
 * row joins ≤ {@link MAX_GROUPS_PER_ROW} groups, a cell is read to
 * {@link MAX_VALUES_PER_CELL} values, and the whole request adds at most
 * `budget` values (+ one row's worth) to its figures — which also bounds what
 * `median` and `count_unique` keep. Past the budget it stops: `truncated` (the
 * figures cover the rows read so far) and, when grouped, `groupsCapped`.
 */
export function computeAggregates(
  rows: QueryInput[],
  requests: AggregateRequest[] | undefined,
  groupBy?: AggregateGroupBy,
  tzOffset = 0,
  budget = AGGREGATE_BUDGET,
): { aggregates: AggregateValues; groups?: AggregateGroup[]; groupsCapped?: boolean; truncated?: boolean } {
  const plans = planAggregates(requests ?? []);
  const total = new Bucket(plans);
  const groups = groupBy ? new Map<string | null, Bucket>() : null;
  let capped = false;
  let spent = false;
  const run: AggregateRun = { left: budget, cut: false };
  const vals: unknown[] = new Array(plans.length);
  for (const n of rows) {
    if (run.left <= 0) { spent = true; break; }
    for (let i = 0; i < plans.length; i++) vals[i] = readKey(n, plans[i]!.key);
    total.add(vals, tzOffset, run);
    if (!groups) continue;
    const mine = rowGroups(readKey(n, groupBy!.key), groupBy!.checkbox);
    if (mine.cut) capped = true;
    for (const g of mine.values) {
      let b = groups.get(g);
      if (!b) {
        if (groups.size >= MAX_AGGREGATE_GROUPS) { capped = true; continue; }
        groups.set(g, (b = new Bucket(plans)));
      }
      b.add(vals, tzOffset, run);
    }
  }
  return {
    aggregates: total.result(plans, tzOffset),
    ...(groups ? { groups: [...groups.entries()].map(([value, b]) => ({ value, count: b.count, aggregates: b.result(plans, tzOffset) })) } : {}),
    ...(capped || (spent && groups) ? { groupsCapped: true } : {}),
    ...(spent || run.cut ? { truncated: true } : {}),
  };
}

// ── cursor ───────────────────────────────────────────────────────────────────

/** FNV-1a (32-bit) — enough to bind a cursor to its query; not a security boundary. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
// btoa/atob exist in every browser and in Node ≥16; the payload is ASCII JSON.
const b64 = (s: string) => btoa(s);
const unb64 = (s: string) => atob(s);

export function queryFingerprint(spec: QuerySpec): string {
  const { cursor: _c, limit: _l, ...rest } = spec;
  return fnv(JSON.stringify(rest));
}
export function encodeCursor(offset: number, spec: QuerySpec): string {
  return b64(JSON.stringify({ v: 1, o: offset, h: queryFingerprint(spec) })).replace(/=+$/, "");
}
/** Offset for `spec.cursor`, 0 when absent, or null when it belongs to another query. */
export function decodeCursor(spec: QuerySpec): number | null {
  if (!spec.cursor) return 0;
  try {
    const raw = JSON.parse(unb64(spec.cursor)) as { v?: unknown; o?: unknown; h?: unknown };
    if (raw.v !== 1 || typeof raw.o !== "number" || !Number.isInteger(raw.o) || raw.o < 0) return null;
    return raw.h === queryFingerprint(spec) ? raw.o : null;
  } catch {
    return null;
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

export function projectRow(n: QueryInput, fields: string[] | undefined): QueryRow {
  const metadata: Record<string, unknown> = {};
  const src = n.metadata ?? {};
  for (const k of fields ? ["title", ...fields] : Object.keys(src)) {
    if (Object.prototype.hasOwnProperty.call(src, k)) metadata[k] = src[k];
  }
  return {
    id: n.id,
    path: n.path,
    tags: n.tags ?? [],
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    metadata,
    ...(n._caps ? { _caps: n._caps } : {}),
    ...(typeof n.canEdit === "boolean" ? { canEdit: n.canEdit } : {}),
  };
}

/**
 * Evaluate `spec` over `notes` (already permission-filtered by the caller) and
 * cut one page. Throws `CursorMismatchError` for a cursor from another query.
 */
export function runQuery(
  notes: QueryInput[],
  spec: QuerySpec,
  opts: { limited: boolean; truncated?: boolean; now?: Date; /** Resolves the `@me` filter value for the caller. */ me?: MeResolver },
): QueryPage {
  const offset = decodeCursor(spec);
  if (offset === null) throw new CursorMismatchError();
  const now = opts.now ?? new Date();
  const needle = spec.search?.trim().toLowerCase();
  // A page TEMPLATE (tag `template`) is a blueprint, not a row: a template of a task is
  // not a task. It is a row only for a view that asks for templates by tag. (One rule for
  // the server's /api/query and the client fallback; `lib/pages/model.ts` TEMPLATE_TAG.)
  const wantsTemplates = spec.tags.includes(TEMPLATE_TAG);
  const matched = notes.filter(
    (n) =>
      (wantsTemplates || !isTemplateNote(n)) &&
      spec.tags.every((t) => (n.tags ?? []).includes(t)) &&
      matchesFilter(n, spec.filter, now, spec.tzOffset ?? 0, opts.me) &&
      (!needle || matchesSearch(n, needle, spec.fields)),
  );
  const sorted = sortRows(matched, spec.sort, spec.tzOffset ?? 0);
  const limit = spec.limit ?? QUERY_DEFAULT_LIMIT;
  const page = sorted.slice(offset, offset + limit);
  const end = offset + page.length;
  // Over every MATCHING row (not the page): the footer of a view is about the view.
  const { truncated: partial, ...figures } = spec.aggregates || spec.groupBy ? computeAggregates(matched, spec.aggregates, spec.groupBy, spec.tzOffset ?? 0) : { truncated: false };
  return {
    rows: page.map((n) => projectRow(n, spec.fields)),
    next: end < sorted.length ? encodeCursor(end, spec) : null,
    total: sorted.length,
    limited: opts.limited,
    truncated: !!opts.truncated || !!partial,
    ...figures,
  };
}

export class CursorMismatchError extends Error {
  constructor() {
    super("cursor does not belong to this query");
    this.name = "CursorMismatchError";
  }
}
