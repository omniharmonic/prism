/**
 * Editing a STRUCTURED property value (`members: [{name, role}]`) — PURE, no DOM,
 * shared by the dialog (`components/database/StructuredValueDialog.tsx`), the client
 * writers and the server route (`POST /api/properties/:id/structured`).
 *
 * `structured.ts` makes such a value READABLE everywhere and refuses every write that
 * would flatten it. This file is the other half: the one model through which it is
 * edited faithfully.
 *
 *   - The value is a LIST of items (or ONE object, edited as a single item).
 *   - An item that is an object is a row; its keys are the columns. Columns are the
 *     union of the keys of every row, in the order they first appear.
 *   - A cell holds text, a number, a yes/no, or nothing. A cell whose value is itself an
 *     object or a list is shown as a summary and is NOT editable here — and is kept.
 *   - Rows can be added, removed and reordered.
 *   - FIELDS can be added, renamed and removed across the items ({@link renameField},
 *     {@link removeField}; a field just added is stored on the items it is filled in on).
 *   - A NESTED value (an object or a list inside an item) is edited by drilling in: the
 *     same editor on that value, whose result replaces it in place ({@link setItemKey}).
 *
 * 🔒 Fidelity. An edit changes exactly what the person changed, nothing else:
 *   - a row's keys keep their order ({@link setItemKey} replaces in place, appends a new key);
 *   - keys the dialog does not show (beyond {@link MAX_EDIT_COLUMNS}), nested objects and
 *     lists, rows beyond {@link MAX_EDIT_ROWS}, items that are not objects — all are
 *     carried through untouched (`buildValue` reuses the original objects);
 *   - a key present on only some rows stays absent on the others (an untouched empty
 *     cell writes nothing);
 *   - a list stays a list and an object stays an object ({@link sameTopShape}).
 *
 * What may be stored at all is {@link validateStructuredValue} — the same check on the
 * client (before a request) and on the server (on what was actually sent).
 */

/** Rows the dialog lists for editing; more are kept as they are. */
export const MAX_EDIT_ROWS = 200;
/** Columns the dialog shows; keys beyond are kept as they are. */
export const MAX_EDIT_COLUMNS = 12;

/** Bounds of a value the structured route stores (checked client and server). */
export const STRUCTURED_MAX_BYTES = 65_536;
export const STRUCTURED_MAX_DEPTH = 8;
export const STRUCTURED_MAX_NODES = 5_000;
export const STRUCTURED_MAX_ITEMS = 500;
export const STRUCTURED_MAX_KEY = 120;
export const STRUCTURED_MAX_TEXT = 10_000;

const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * May this value be stored by the structured route? Returns what is wrong, or null.
 * JSON only: objects with plain string keys (never a prototype name), lists, text,
 * finite numbers, booleans and null — bounded in size, depth and count. Linear.
 */
export function validateStructuredValue(value: unknown): string | null {
  if (!isObject(value) && !Array.isArray(value)) return "the value must be a list or an object";
  if (Array.isArray(value) && value.length > STRUCTURED_MAX_ITEMS) return `a list holds at most ${STRUCTURED_MAX_ITEMS} items`;
  let nodes = 0;
  const walk = (v: unknown, depth: number): string | null => {
    if (++nodes > STRUCTURED_MAX_NODES) return "the value is too large";
    if (v === null || typeof v === "boolean") return null;
    if (typeof v === "number") return Number.isFinite(v) ? null : "a number must be finite";
    if (typeof v === "string") return v.length <= STRUCTURED_MAX_TEXT ? null : `text is at most ${STRUCTURED_MAX_TEXT} characters`;
    if (typeof v !== "object") return "only text, numbers, yes/no, lists and objects can be stored";
    if (depth >= STRUCTURED_MAX_DEPTH) return "the value is nested too deeply";
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        // A hole in a list is not JSON (it would be written as null): refuse rather than change it.
        if (!has(v, String(i))) return "a list has a missing item";
        const e = walk(v[i], depth + 1);
        if (e) return e;
      }
      return null;
    }
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== null) return "only plain objects can be stored";
    for (const k of Object.keys(v)) {
      if (!k || k.length > STRUCTURED_MAX_KEY) return "a field name is empty or too long";
      if (BANNED_KEYS.has(k)) return `“${k}” cannot be used as a field name`;
      const e = walk((v as Record<string, unknown>)[k], depth + 1);
      if (e) return e;
    }
    return null;
  };
  const e = walk(value, 0);
  if (e) return e;
  let size = 0;
  try { size = JSON.stringify(value).length; } catch { return "the value cannot be stored"; }
  return size <= STRUCTURED_MAX_BYTES ? null : "the value is too large";
}

/** A list stays a list, an object stays an object. */
export function sameTopShape(a: unknown, b: unknown): boolean {
  return Array.isArray(a) ? Array.isArray(b) : isObject(a) && isObject(b);
}

/** JSON equality on the stored shape (key order included — the shape is part of the value). */
export function sameStructured(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); } catch { return false; }
}

// ── the editing model ────────────────────────────────────────────────────────

export type CellType = "text" | "number" | "boolean";
/** What one cell of the dialog holds. */
export type Cell =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  /** The key is on this row with `null`. */
  | { kind: "null" }
  /** The key is not on this row at all. */
  | { kind: "absent" }
  /** An object or a list: summarised, kept, not editable here. */
  | { kind: "nested"; value: unknown };

/** The items of a structured value: a list's entries, or the one object. */
export function itemsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : isObject(value) ? [value] : [];
}
/** Put edited items back in the value's own top shape. */
export function buildValue(original: unknown, items: readonly unknown[]): unknown {
  return Array.isArray(original) ? [...items] : items[0] ?? {};
}

/** Every key of every object item, in the order first seen. Prototype names are never columns. */
export function columnsOf(items: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const it of items) {
    if (!isObject(it)) continue;
    for (const k of Object.keys(it)) if (!BANNED_KEYS.has(k)) seen.add(k);
  }
  return [...seen];
}

export function cellOf(item: unknown, key: string): Cell {
  if (!isObject(item) || !has(item, key)) return { kind: "absent" };
  const v = item[key];
  if (v === null || v === undefined) return { kind: "null" };
  if (typeof v === "string") return { kind: "text", value: v };
  if (typeof v === "number") return { kind: "number", value: v };
  if (typeof v === "boolean") return { kind: "boolean", value: v };
  return { kind: "nested", value: v };
}

/** What a column holds: the type of its first plain value (text when it has none yet). */
export function columnType(items: readonly unknown[], key: string): CellType {
  for (const it of items) {
    const c = cellOf(it, key);
    if (c.kind === "text" || c.kind === "number" || c.kind === "boolean") return c.kind;
  }
  return "text";
}

const isLinkText = (s: string): boolean => { const t = s.trim(); return t.length >= 4 && t.startsWith("[[") && t.endsWith("]]"); };
/** Column names whose value names a page even when written without `[[ ]]`. ("note", "link" and "contact" are not: they usually hold a remark, a URL, an address.) */
const LINK_KEYS = /^(person|people|member|page|project|organization|org|owner|assignee|sponsor|attendee)s?$/i;
/**
 * Does this column hold page links (so its cells offer the page picker)? A `[[link]]` in
 * any row; or a name that says so, when the column holds text (or nothing yet) — never a
 * number, a yes/no or a nested value.
 */
export function isLinkColumn(items: readonly unknown[], key: string): boolean {
  let named = LINK_KEYS.test(key);
  let linked = false;
  for (const it of items) {
    const c = cellOf(it, key);
    if (c.kind === "text") { if (isLinkText(c.value)) linked = true; }
    else if (c.kind === "number" || c.kind === "boolean" || c.kind === "nested") named = false;
  }
  return linked || named;
}

/**
 * `item` with `key` set to `next` — a NEW object; the key keeps its place (a new key
 * goes last), every other key and value is carried over by reference. Own data
 * properties only, defined (never assigned), so no key can reach a prototype.
 */
export function setItemKey(item: unknown, key: string, next: unknown): Record<string, unknown> {
  const src = isObject(item) ? item : {};
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const k of Object.keys(src)) {
    const v = k === key ? next : src[k];
    if (k === key) placed = true;
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  if (!placed && !BANNED_KEYS.has(key)) Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
  return out;
}

/** `item` without `key` — a NEW object, every other key in its place. */
export function unsetItemKey(item: unknown, key: string): Record<string, unknown> {
  const src = isObject(item) ? item : {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) if (k !== key) Object.defineProperty(out, k, { value: src[k], enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * An edit that EMPTIES a cell puts the field back the way the row had it before the
 * dialog opened when that was "nothing": a key the row never had is removed again, a
 * `null` stays `null`. So typing into an empty cell and deleting it again is not a change.
 * `original` = the row as loaded (undefined for a row added in the dialog).
 */
export function clearItemKey(item: unknown, original: unknown, key: string, type: CellType): Record<string, unknown> {
  const before = original === undefined ? null : cellOf(original, key);
  if (before?.kind === "absent") return unsetItemKey(item, key);
  if (before?.kind === "null") return setItemKey(item, key, null);
  return setItemKey(item, key, type === "text" ? "" : type === "boolean" ? false : null);
}

/**
 * What a typed cell stores, or `{error}`. Text is kept exactly as typed (a cleared text
 * cell stores `""` so the field stays). A number cell takes a plain decimal; cleared it
 * stores `null` (the field stays, without a number).
 */
export function parseCell(type: CellType, input: string | boolean): { value: string | number | boolean | null } | { error: string } {
  if (type === "boolean") return { value: input === true || input === "true" };
  const text = typeof input === "string" ? input : "";
  if (type === "text") return text.length <= STRUCTURED_MAX_TEXT ? { value: text } : { error: `Text is at most ${STRUCTURED_MAX_TEXT} characters.` };
  const t = text.trim().replace(/,/g, "");
  if (t === "") return { value: null };
  if (t.length > 40 || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return { error: "That isn’t a number." };
  const n = Number(t);
  return Number.isFinite(n) ? { value: n } : { error: "That isn’t a number." };
}

// ── fields (columns) across the items ────────────────────────────────────────

/** Why `name` cannot be a field name here, or null. (`existing` = the fields the items already have.) */
export function fieldNameProblem(name: string, existing: readonly string[]): string | null {
  if (!name) return "Give the field a name.";
  if (name !== name.trim()) return "A field name cannot start or end with a space.";
  if (name.length > STRUCTURED_MAX_KEY) return `A field name is at most ${STRUCTURED_MAX_KEY} characters.`;
  if (BANNED_KEYS.has(name)) return `“${name}” cannot be used as a field name.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return "A field name cannot hold a line break or a control character.";
  if (existing.includes(name)) return `There is already a field named “${name}”.`;
  const lower = name.toLowerCase();
  const twin = existing.find((k) => k.toLowerCase() === lower);
  return twin ? `There is already a field named “${twin}” (names that differ only by capitals are easy to mix up).` : null;
}

/**
 * `item` with its key `from` called `to` — a NEW object; the key keeps its PLACE and its
 * value (whatever it is, nested or not) by reference; every other key is untouched. An
 * item without `from` (or that is not an object) is returned as it is. An item that
 * already has `to` is returned as it is too: callers refuse such a rename first
 * ({@link fieldNameProblem}) — a value is never overwritten by a rename.
 */
export function renameItemKey<T>(item: T, from: string, to: string): T | Record<string, unknown> {
  if (!isObject(item) || !has(item, from) || from === to || has(item, to) || BANNED_KEYS.has(to)) return item;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(item)) Object.defineProperty(out, k === from ? to : k, { value: item[k], enumerable: true, writable: true, configurable: true });
  return out;
}
/** Rename a field on every item that has it. Items that do not have it are the same objects as before. */
export function renameField(items: readonly unknown[], from: string, to: string): unknown[] {
  return items.map((it) => renameItemKey(it, from, to));
}
/** Remove a field from every item that has it (its values go with it). Other items are the same objects as before. */
export function removeField(items: readonly unknown[], key: string): unknown[] {
  return items.map((it) => (isObject(it) && has(it, key) ? unsetItemKey(it, key) : it));
}
/** How many items carry this field. */
export function fieldCount(items: readonly unknown[], key: string): number {
  let n = 0;
  for (const it of items) if (isObject(it) && has(it, key)) n++;
  return n;
}

/**
 * What "Add item" adds to a list that has no object to shape a row by: a plain entry of
 * the kind the list already holds (text → `""`, a number → `0`, a yes/no → `false`),
 * text for an empty list. Null when the list holds only nested lists (nothing to model).
 */
export function blankPlain(items: readonly unknown[]): string | number | boolean | null {
  if (!items.length) return "";
  for (let i = items.length - 1; i >= 0; i--) {
    const v = items[i];
    if (typeof v === "string") return "";
    if (typeof v === "number") return 0;
    if (typeof v === "boolean") return false;
  }
  return null;
}

/**
 * A new, empty row shaped like its neighbours: every plain field of the LAST object row
 * gets its empty value (text → `""`, yes/no → `false`, a number or nothing → `null`), in
 * that row's key order. Nested fields are not invented.
 */
export function blankItem(items: readonly unknown[]): Record<string, unknown> {
  let model: Record<string, unknown> | null = null;
  for (let i = items.length - 1; i >= 0 && !model; i--) if (isObject(items[i])) model = items[i] as Record<string, unknown>;
  let out: Record<string, unknown> = {};
  if (!model) return out;
  for (const k of Object.keys(model)) {
    if (BANNED_KEYS.has(k)) continue;
    const c = cellOf(model, k);
    if (c.kind === "nested") continue;
    // A field the model row holds as "nothing" (null) starts as nothing here too.
    out = setItemKey(out, k, c.kind === "text" ? "" : c.kind === "boolean" ? false : null);
  }
  return out;
}

/** A row nobody filled in: every field is `""`, `null` or `false` (or it has none). */
export function isBlankItem(item: unknown): boolean {
  if (!isObject(item)) return false;
  for (const k of Object.keys(item)) {
    const v = item[k];
    if (!(v === "" || v === null || v === false)) return false;
  }
  return true;
}
