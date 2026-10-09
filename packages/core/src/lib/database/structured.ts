/**
 * Structured property values — PURE, dependency-light, also used by the server.
 *
 * A property is normally text, a number, a boolean or a list of text. Ingesters and
 * agents also store OBJECTS (`members: [{name: "Ada", role: "delegate"}]`), and every
 * `String(value)` in the UI printed those as `[object Object]`. This file is the ONE
 * place a value of any shape becomes text:
 *
 *   - `valueText(v)`        any value → short human text, never `[object Object]`, never throws
 *   - `structuredItems(v)`  the same, one entry per list item, for chips (label · detail · link)
 *   - `isStructuredValue(v)` does the stored value hold an object (or a nested list)?
 *
 * EDITING. A structured value is READ-ONLY in every inline editor: the editors work
 * on text, so any edit would write the text back and lose the fields. `refuseStructuredWrite`
 * is the client-side rule every property write passes through; the server's property
 * routes and the CSV import apply the same rule against the value actually stored.
 *
 * Bounded and linear whatever the value holds (this runs per cell, and in the server's
 * query engine): at most {@link MAX_ITEMS} list items, {@link MAX_KEYS} keys of an
 * object and {@link MAX_DEPTH} levels are read; text is cut at {@link MAX_TEXT}.
 */
import { linkLabel } from "./links";

const MAX_ITEMS = 50;
const MAX_KEYS = 24;
const MAX_DEPTH = 3;
const MAX_TEXT = 160;
/** Pairs shown by the `key: value` fallback. */
const MAX_PAIRS = 3;

/** What a person sees where a structured value would otherwise be editable. */
export const STRUCTURED_HINT = "Structured value: shown read-only here so its fields are kept.";

/** Keys that NAME the thing an object describes, most telling first. */
const LABEL_KEYS = ["name", "title", "label", "display_name", "displayName", "full_name", "fullName", "person", "user", "member", "page", "note", "email", "handle", "username", "slug", "id", "path", "url", "value"] as const;
/** Keys that say what the named thing IS here — shown after the label. */
const DETAIL_KEYS = ["role", "roles", "relationship", "position", "status", "type", "kind"] as const;
/** Label keys whose value is a page reference even when written without `[[ ]]`. */
const PATH_KEYS = new Set(["path", "page", "note"]);

export interface StructuredItem {
  /** The whole item as text: "Ada Lovelace — delegate". */
  text: string;
  /** The name part alone: "Ada Lovelace". */
  label: string;
  /** The secondary part, when there is an obvious one: "delegate". */
  detail?: string;
  /** The stored string the label came from, when it may name a page (a `[[wikilink]]`, a path, a name): what a chip opens. */
  link?: string;
  /** True when the item was an object or a list (not plain text / number / boolean). */
  structured: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Does this stored value hold an object, or a list inside a list? (Text cannot edit it faithfully.) */
export function isStructuredValue(v: unknown): boolean {
  if (isObject(v)) return true;
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) if (typeof v[i] === "object" && v[i] !== null) return true;
  return false;
}

const cut = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const isLink = (s: string): boolean => s.length >= 4 && s.startsWith("[[") && s.endsWith("]]");

/** A primitive as text; null for anything that is not one (or is blank). */
function primitiveText(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    return cut(isLink(t) ? linkLabel(t) : t);
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "bigint") return v.toString();
  return null;
}

/** Own, enumerable keys only — read through `hasOwnProperty`, so `toString` / `__proto__` keys are just data. */
function ownKeys(o: Record<string, unknown>): string[] {
  let keys: string[];
  try { keys = Object.keys(o); } catch { return []; }
  return keys.length > MAX_KEYS ? keys.slice(0, MAX_KEYS) : keys;
}
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function objectItem(o: Record<string, unknown>, depth: number): StructuredItem {
  let label = "";
  let link: string | undefined;
  let labelKey = "";
  for (const k of LABEL_KEYS) {
    const raw = own(o, k);
    const t = primitiveText(raw);
    if (t !== null) {
      label = t;
      labelKey = k;
      if (typeof raw === "string" && (isLink(raw.trim()) || PATH_KEYS.has(k) || k === "name" || k === "title" || k === "person" || k === "member" || k === "email")) link = raw.trim();
      break;
    }
    // `person: {name: "Ada"}` — the name one level down.
    if (isObject(raw) && depth < MAX_DEPTH) {
      const inner = objectItem(raw, depth + 1);
      if (inner.label) { label = inner.label; link = inner.link; labelKey = k; break; }
    }
  }
  // A page link anywhere among the naming keys is the better thing to open than a bare name.
  if (label && !(link && isLink(link))) {
    for (const k of LABEL_KEYS) {
      const raw = own(o, k);
      if (typeof raw === "string" && isLink(raw.trim())) { link = raw.trim(); break; }
    }
  }
  let detail: string | undefined;
  if (label) {
    for (const k of DETAIL_KEYS) {
      if (k === labelKey) continue;
      const raw = own(o, k);
      const t = Array.isArray(raw) ? listText(raw, depth + 1) : primitiveText(raw);
      if (t && t !== label) { detail = t; break; }
    }
    return { text: cut(detail ? `${label} — ${detail}` : label), label, ...(detail ? { detail } : {}), ...(link ? { link } : {}), structured: true };
  }
  // Nothing names it: a compact `key: value` summary of what it holds.
  const pairs: string[] = [];
  const keys = ownKeys(o);
  let more = false;
  for (const k of keys) {
    const t = depth < MAX_DEPTH ? textOf(own(o, k), depth + 1) : "";
    if (!t) continue;
    if (pairs.length >= MAX_PAIRS) { more = true; break; }
    pairs.push(`${k}: ${t}`);
  }
  const text = cut(pairs.join(", ") + (more ? ", …" : ""));
  return { text, label: text, structured: true };
}

function listText(list: unknown[], depth: number): string {
  if (depth > MAX_DEPTH) return "";
  const out: string[] = [];
  const end = Math.min(list.length, MAX_ITEMS);
  for (let i = 0; i < end; i++) {
    const t = textOf(list[i], depth);
    if (t) out.push(t);
  }
  return cut(out.join(", ") + (list.length > end ? ", …" : ""));
}

function textOf(v: unknown, depth: number): string {
  const p = primitiveText(v);
  if (p !== null) return p;
  if (Array.isArray(v)) return listText(v, depth + 1);
  if (isObject(v)) return depth > MAX_DEPTH ? "" : objectItem(v, depth).text;
  return "";
}

/**
 * Any stored value as short human text: "Ada Lovelace — delegate, Grace Hopper — delegate".
 * Never `[object Object]`, never throws (an object with a `toString` key is data here), "" for nothing.
 */
export function valueText(v: unknown): string {
  return textOf(v, 0);
}

/**
 * Text for comparing / grouping / counting a value in the query engine. A string is
 * returned UNCHANGED (callers normalise links themselves); everything else reads as
 * {@link valueText}. Replaces `String(v)`, which printed objects as `[object Object]`
 * and threw on an object holding a `toString` key.
 */
export function scalarText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v === null || v === undefined) return "";
  return valueText(v);
}

/** One entry per list item (a lone value is one item), blanks dropped; at most {@link MAX_ITEMS}. */
export function structuredItems(v: unknown): StructuredItem[] {
  const list = Array.isArray(v) ? v : [v];
  const out: StructuredItem[] = [];
  const end = Math.min(list.length, MAX_ITEMS);
  for (let i = 0; i < end; i++) {
    const x = list[i];
    if (isObject(x)) {
      const item = objectItem(x, 0);
      if (item.text) out.push(item);
    } else if (Array.isArray(x)) {
      const text = listText(x, 1);
      if (text) out.push({ text, label: text, structured: true });
    } else {
      const text = primitiveText(x);
      if (text !== null) out.push({ text, label: text, ...(typeof x === "string" ? { link: x.trim() } : {}), structured: false });
    }
  }
  return out;
}

/** The text `String()` gives an object — a value that only ever exists because of a bug. */
const STRINGIFIED = "[object Object]";
const isStringified = (v: unknown): boolean =>
  (typeof v === "string" && v.trim() === STRINGIFIED) || (Array.isArray(v) && v.some((x) => typeof x === "string" && x.trim() === STRINGIFIED));

/**
 * The rule every property write passes (inline edit, chip remove, bulk edit, undo,
 * CSV import). Returns the keys the write must NOT touch:
 *   - a key whose `current` value is structured — unless the write puts back exactly
 *     that value (a no-op), nothing may replace it, not even a clear: the property
 *     routes carry text, numbers, booleans and lists of text only, so a cleared
 *     structured value could not be put back by Undo;
 *   - a key being set to the literal text `[object Object]`.
 * `current` = the values the writer knows are stored (what the person saw, or the
 * note as read). A key absent from `current` is only checked for the literal.
 */
export function refuseStructuredWrite(set: Record<string, unknown>, current: Record<string, unknown> | null | undefined): string[] {
  const refused: string[] = [];
  for (const k of Object.keys(set)) {
    const next = set[k];
    if (isStringified(next)) { refused.push(k); continue; }
    const cur = current && Object.prototype.hasOwnProperty.call(current, k) ? current[k] : undefined;
    if (!isStructuredValue(cur)) continue;
    let same = false;
    try { same = JSON.stringify(cur) === JSON.stringify(next); } catch { same = false; }
    if (!same) refused.push(k);
  }
  return refused;
}

/** Thrown by the client's property writers when {@link refuseStructuredWrite} refuses a key. */
export class StructuredValueError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(STRUCTURED_HINT);
    this.name = "StructuredValueError";
    this.fields = fields;
  }
}
