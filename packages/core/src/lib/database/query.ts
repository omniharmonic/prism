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
import { dateRange } from "./dates";

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
  /** True when the server stopped scanning at its inventory cap. */
  truncated: boolean;
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
  if (raw.search !== undefined && raw.search !== "") {
    if (typeof raw.search !== "string" || raw.search.length > 200) return { ok: false, error: "search must be ≤200 chars" };
    spec.search = raw.search;
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
  return [...keys];
}

// ── values ───────────────────────────────────────────────────────────────────

/** The display title: `metadata.title`, else the path leaf without extension. */
export function noteTitle(n: Pick<QueryInput, "path" | "metadata" | "id">): string {
  const t = n.metadata?.title;
  if (typeof t === "string" && t.trim()) return t.trim();
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
  const sa = rangeEnd(String(a), "start");
  const sb = rangeEnd(String(b), "start");
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
  if (typeof actual === "boolean" || typeof expected === "boolean") return String(actual) === String(expected);
  return compareValues(actual, expected, tz) === 0;
}

function contains(actual: unknown, needle: unknown): boolean {
  if (isEmpty(actual) || needle === null || needle === undefined) return false;
  const n = norm(String(needle));
  if (Array.isArray(actual)) return actual.some((a) => typeof a === "string" ? norm(a).includes(n) : String(a) === String(needle));
  return norm(String(actual)).includes(n);
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

export function evaluateCondition(n: QueryInput, c: QueryCondition, now = new Date(), tzOffset = 0): boolean {
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

function matchesGroup(n: QueryInput, g: QueryFilterGroup, now: Date, tzOffset: number): boolean {
  if (!g.conditions.length) return true;
  return g.match === "all"
    ? g.conditions.every((c) => evaluateCondition(n, c, now, tzOffset))
    : g.conditions.some((c) => evaluateCondition(n, c, now, tzOffset));
}

export function matchesFilter(n: QueryInput, f: QueryFilter | undefined, now = new Date(), tzOffset = 0): boolean {
  if (!f) return true;
  // Empty groups are no-ops (a half-built group in the editor never empties a view).
  const terms: Array<() => boolean> = [
    ...f.conditions.map((c) => () => evaluateCondition(n, c, now, tzOffset)),
    ...(f.groups ?? []).filter((g) => g.conditions.length).map((g) => () => matchesGroup(n, g, now, tzOffset)),
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
  const hit = (v: unknown): boolean => typeof v === "string" && v.length <= 10_000 && norm(v).includes(needle);
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
  opts: { limited: boolean; truncated?: boolean; now?: Date },
): QueryPage {
  const offset = decodeCursor(spec);
  if (offset === null) throw new CursorMismatchError();
  const now = opts.now ?? new Date();
  const needle = spec.search?.trim().toLowerCase();
  const matched = notes.filter(
    (n) =>
      spec.tags.every((t) => (n.tags ?? []).includes(t)) &&
      matchesFilter(n, spec.filter, now, spec.tzOffset ?? 0) &&
      (!needle || matchesSearch(n, needle, spec.fields)),
  );
  const sorted = sortRows(matched, spec.sort, spec.tzOffset ?? 0);
  const limit = spec.limit ?? QUERY_DEFAULT_LIMIT;
  const page = sorted.slice(offset, offset + limit);
  const end = offset + page.length;
  return {
    rows: page.map((n) => projectRow(n, spec.fields)),
    next: end < sorted.length ? encodeCursor(end, spec) : null,
    total: sorted.length,
    limited: opts.limited,
    truncated: !!opts.truncated,
  };
}

export class CursorMismatchError extends Error {
  constructor() {
    super("cursor does not belong to this query");
    this.name = "CursorMismatchError";
  }
}
