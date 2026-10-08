/**
 * "Change type" between vault types (NP-DB-11), without ever changing a vault type
 * in place. The tag schema is shared and additive-only, so text → number (and every
 * other change `compatibleKinds` does not allow as a presentation) is a GUIDED
 * CONVERSION: a NEW field of the target type is added, each page's value is coerced
 * and copied into it (one compare-and-set write per page, server side), and the old
 * field is then marked deleted — hidden everywhere, its values untouched, so the
 * conversion can be undone by restoring it.
 *
 * Pure and linear: no regex with an unbounded quantifier runs over a stored value.
 */
import { parseFileRef } from "../media/attachments";
import { looksLikeEmail, looksLikePhone, VAULT_TYPE_FOR_KIND, type PropertyKind } from "./schema";

export type Coerced = { ok: true; value: unknown } | { ok: false };
const NO: Coerced = { ok: false };
const yes = (value: unknown): Coerced => ({ ok: true, value });

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "on", "checked", "done", "✓", "✔"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off", "unchecked", ""]);

const isDigit = (c: number) => c >= 48 && c <= 57;

/** "1,234.5", "$12", "40%", " 7 " → a finite number; anything else → null. One pass. */
export function parseNumberText(raw: string): number | null {
  if (raw.length > 64) return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.endsWith("%")) s = s.slice(0, -1).trim();
  let sign = "";
  if (s.startsWith("-") || s.startsWith("+")) { sign = s[0] === "-" ? "-" : ""; s = s.slice(1).trim(); }
  if (s.startsWith("$") || s.startsWith("€") || s.startsWith("£")) s = s.slice(1).trim();
  let out = "";
  let dot = false;
  let digits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isDigit(c)) { out += s[i]; digits++; }
    else if (s[i] === "," && digits > 0 && !dot && i + 1 < s.length && isDigit(s.charCodeAt(i + 1))) continue; // thousands separator
    else if (s[i] === "." && !dot) { out += "."; dot = true; }
    else return null;
  }
  if (!digits) return null;
  const n = Number(sign + out);
  return Number.isFinite(n) ? n : null;
}

/** A day (`YYYY-MM-DD…`) the date editor can read, from text. */
function dayOf(s: string): string | null {
  const t = s.trim();
  if (t.length < 10 || t.length > 64) return null;
  for (let i = 0; i < 10; i++) {
    const c = t.charCodeAt(i);
    if (i === 4 || i === 7) { if (t[i] !== "-") return null; } else if (!isDigit(c)) return null;
  }
  return Number.isNaN(Date.parse(t.slice(0, 10))) ? null : t;
}

function text(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.map(String).join(", ");
  return null;
}

/**
 * The value a stored `value` becomes as a property of kind `to`, or `{ok:false}`
 * when it has no faithful reading (it then stays on the old property and is
 * reported — never guessed, never dropped silently).
 */
export function coerceToKind(value: unknown, to: PropertyKind): Coerced {
  if (value === null || value === undefined) return NO;
  const one = Array.isArray(value) && value.length === 1 ? value[0] : value;
  switch (to) {
    case "number": {
      if (typeof one === "number") return Number.isFinite(one) ? yes(one) : NO;
      if (typeof one === "boolean") return yes(one ? 1 : 0);
      if (typeof one !== "string") return NO;
      const n = parseNumberText(one);
      return n === null ? NO : yes(n);
    }
    case "checkbox": {
      if (typeof one === "boolean") return yes(one);
      if (typeof one === "number") return yes(one !== 0);
      if (typeof one !== "string" || one.length > 16) return NO;
      const w = one.trim().toLowerCase();
      return TRUE_WORDS.has(w) ? yes(true) : FALSE_WORDS.has(w) ? yes(false) : NO;
    }
    case "multi_select": {
      if (Array.isArray(value)) return value.every((x) => typeof x === "string") ? yes(value) : NO;
      const s = text(value);
      if (s === null) return NO;
      const parts = [...new Set(s.split(",").map((p) => p.trim()).filter(Boolean))];
      return parts.length && parts.length <= 100 && parts.every((p) => p.length <= 80) ? yes(parts) : NO;
    }
    case "files": {
      const list = Array.isArray(value) ? value : [value];
      return list.length && list.every((x) => typeof x === "string" && !!parseFileRef(x)) ? yes(list) : NO;
    }
    case "person":
    case "relation": {
      // Stored as one link (the vault type a new relation is created with is a string).
      return typeof one === "string" && one.startsWith("[[") && one.endsWith("]]") ? yes(one) : NO;
    }
    case "select":
    case "status": {
      if (Array.isArray(value) && value.length !== 1) return NO; // several values are not one option
      const s = text(one);
      return s !== null && s.trim() && s.length <= 80 ? yes(s.trim()) : NO;
    }
    case "date": {
      if (typeof one !== "string") return NO;
      const d = dayOf(one);
      return d ? yes(d) : NO;
    }
    case "url": {
      if (typeof one !== "string") return NO;
      const t = one.trim();
      return t.length <= 2048 && (t.startsWith("https://") || t.startsWith("http://")) ? yes(t) : NO;
    }
    case "email": return typeof one === "string" && looksLikeEmail(one.trim()) ? yes(one.trim()) : NO;
    case "phone": return typeof one === "string" && looksLikePhone(one.trim()) ? yes(one.trim()) : NO;
    case "text": {
      const s = text(value);
      return s === null ? NO : yes(s);
    }
    default: return NO;
  }
}

/**
 * The key of the field a conversion writes into: the same for every run of the same
 * (field, kind), so an interrupted conversion continues instead of starting a third
 * property. ≤ 64 chars, a valid field name.
 */
export function conversionKey(field: string, to: PropertyKind): string {
  const suffix = `_${to}`;
  return field.slice(0, 64 - suffix.length) + suffix;
}

/** Is `to` a real type change for a field stored as `vaultType` (so it needs a conversion)? */
export function needsConversion(vaultType: string | undefined, to: PropertyKind): boolean {
  const from = vaultType === "integer" ? "number" : vaultType === "reference" || vaultType === "date" || vaultType === undefined ? "string" : vaultType;
  return VAULT_TYPE_FOR_KIND[to] !== from;
}

/** A short, safe rendering of a value for the "these cannot be converted" list. */
export function sampleText(value: unknown): string {
  const s = typeof value === "string" ? value : (() => { try { return JSON.stringify(value) ?? ""; } catch { return ""; } })();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}
