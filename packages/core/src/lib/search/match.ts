/**
 * Pure search helpers shared by the Prism Server (`GET /api/search`) and the
 * client fallback (NP-SR-03 highlighting, NP-SR-04 filters). No DOM, no I/O.
 */
export type Range = [start: number, end: number];

export interface SearchFilters {
  /** Match the query against titles only. */
  titleOnly?: boolean;
  /** Content types (see inferContentType), e.g. ["document", "database"]. */
  types?: string[];
  /** Every listed tag must be present. */
  tags?: string[];
  /** Created or last edited by this account (email, case-insensitive). */
  author?: string;
  /** Inclusive ISO date bounds (YYYY-MM-DD or full ISO). */
  after?: string;
  before?: string;
  dateField?: "updated" | "created";
}

export interface SearchMatches {
  title: Range[];
  snippet: string;
  snippetMatches: Range[];
}

interface NoteLike {
  id: string;
  path?: string | null;
  content?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 8;

/** Lower-case, de-duplicated words of the query (quotes dropped). */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.slice(0, MAX_QUERY_LENGTH).split(/\s+/)) {
    const term = raw.replace(/^["'“”‘’(]+|["'“”‘’),.;:!?]+$/g, "").toLowerCase();
    if (term && !out.includes(term)) out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every occurrence of any term, merged into sorted non-overlapping ranges. */
export function findMatches(text: string, terms: string[], cap = 64): Range[] {
  if (!text || !terms.length) return [];
  const pattern = new RegExp(terms.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|"), "giu");
  const found: Range[] = [];
  for (const m of text.matchAll(pattern)) {
    if (!m[0]) continue;
    found.push([m.index!, m.index! + m[0].length]);
    if (found.length >= cap) break;
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Saved note HTML/Markdown → readable plain text (linear; never executes markup). */
/** Drop <script>/<style>/<noscript> blocks with indexOf scans (linear, no regex backtracking). */
function stripRawBlocks(input: string): string {
  const lower = input.toLowerCase();
  const tags = ["script", "style", "noscript"] as const;
  // Next opener per tag, recomputed only once the scan has passed it (linear overall).
  const nextOpen = tags.map((tag) => lower.indexOf(`<${tag}`));
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    let which = -1;
    for (let t = 0; t < tags.length; t++) {
      if (nextOpen[t]! !== -1 && nextOpen[t]! < at) nextOpen[t] = lower.indexOf(`<${tags[t]}`, at);
      if (nextOpen[t]! !== -1 && (which === -1 || nextOpen[t]! < nextOpen[which]!)) which = t;
    }
    if (which === -1) { parts.push(input.slice(at)); return parts.join(""); }
    const open = nextOpen[which]!;
    parts.push(input.slice(at, open));
    const close = lower.indexOf(`</${tags[which]}`, open);
    if (close === -1) return parts.join("");
    const end = lower.indexOf(">", close);
    at = end === -1 ? input.length : end + 1;
  }
}

function decodeEntity(name: string): string | null {
  const named = ENTITIES[name];
  if (named !== undefined) return named;
  if (name[0] !== "#") return null;
  const hex = name[1] === "x" || name[1] === "X";
  const digits = name.slice(hex ? 2 : 1);
  if (!digits || digits.length > 8 || !(hex ? /^[0-9a-fA-F]+$/ : /^\d+$/).test(digits)) return null;
  const code = parseInt(digits, hex ? 16 : 10);
  // Out of range, NUL and lone surrogates would throw or corrupt: a space instead.
  if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return " ";
  return String.fromCodePoint(code);
}

/**
 * Saved note HTML/Markdown → readable plain text. ONE linear pass, no regex over
 * the input (note content is attacker-controlled: an unanchored pattern with an
 * unbounded quantifier — the old `[[…]]` regex — went quadratic on `[[[[[…`).
 * Tags are dropped, entities decoded (≤ 10 chars), `[[target|label]]` becomes its
 * label, Markdown punctuation and whitespace runs collapse to one space.
 */
export function plainText(source: string, max = 200_000): string {
  const input = stripRawBlocks(source.length > max ? source.slice(0, max) : source);
  const n = input.length;
  const out: string[] = [];
  let space = true; // collapses whitespace and trims the start
  const push = (text: string) => {
    for (let k = 0; k < text.length; k++) {
      const c = text[k]!;
      if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f" || c === "\u00a0" || c === "#" || c === "*" || c === "_" || c === "`" || c === ">") {
        if (!space) { out.push(" "); space = true; }
      } else { out.push(c); space = false; }
    }
  };
  // Next "]]" at or after the scan point; recomputed only once passed (keeps "[[[[…" linear).
  let close = -2;
  let i = 0;
  while (i < n) {
    const ch = input[i]!;
    if (ch === "<") {
      const next = input.charCodeAt(i + 1);
      const tagStart = (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 47 || next === 33; // A-Z a-z / !
      if (tagStart) {
        const end = input.indexOf(">", i + 1);
        if (!space) { out.push(" "); space = true; }
        if (end === -1) break; // an unterminated tag swallows the rest, as before
        i = end + 1;
        continue;
      }
    } else if (ch === "&") {
      // An entity name is at most 10 chars: look no further (keeps "&&&&…" linear).
      const rel = input.slice(i + 1, i + 12).indexOf(";");
      if (rel > 0) {
        const decoded = decodeEntity(input.slice(i + 1, i + 1 + rel));
        if (decoded !== null) { push(decoded); i += rel + 2; continue; }
      }
    } else if (ch === "[" && input[i + 1] === "[") {
      if (close !== -1 && close < i + 2) close = input.indexOf("]]", i + 2);
      if (close !== -1 && close - i <= 402) {
        const inner = input.slice(i + 2, close);
        if (!inner.includes("\n") && !inner.includes("[[")) {
          const bar = inner.indexOf("|");
          push(bar === -1 ? inner : inner.slice(bar + 1));
          i = close + 2;
          continue;
        }
      }
      out.push("[["); space = false;
      i += 2;
      continue;
    }
    push(ch);
    i++;
  }
  if (space && out.length) out.pop();
  return out.join("");
}

/** A window of `max` characters around the first match, with offsets inside it. */
export function buildSnippet(text: string, terms: string[], max = 220): { snippet: string; matches: Range[] } {
  if (!text) return { snippet: "", matches: [] };
  const first = findMatches(text, terms, 1)[0];
  let start = 0;
  if (first && first[0] > max / 3) {
    start = first[0] - Math.floor(max / 3);
    const space = text.lastIndexOf(" ", start + 12);
    if (space > start - 24 && space > 0) start = space + 1;
  }
  const end = Math.min(text.length, start + max);
  const body = text.slice(start, end).trim();
  const snippet = (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
  return { snippet, matches: findMatches(snippet, terms) };
}

export function noteTitle(note: NoteLike): string {
  const meta = note.metadata ?? {};
  if (typeof meta.title === "string" && meta.title.trim()) return meta.title.trim();
  return note.path?.split("/").pop() || note.id;
}

/** Bytes of raw note content a snippet may read (per note). */
export const SNIPPET_SOURCE_MAX = 20_000;

/**
 * At most `max` chars of raw content, positioned around the first term hit (a
 * plain case-insensitive indexOf — no regex over the whole body), so a snippet
 * costs the same for a 2 KB and a 2 MB note.
 */
export function contentWindow(content: string, terms: string[], max = SNIPPET_SOURCE_MAX): string {
  if (content.length <= max) return content;
  let hit = -1;
  if (terms.length) {
    const lower = content.slice(0, 400_000).toLowerCase(); // bounded: a hit past 400 KB falls back to the prefix
    for (const term of terms) {
      const at = lower.indexOf(term);
      if (at !== -1 && (hit === -1 || at < hit)) hit = at;
    }
  }
  if (hit <= max / 4) return content.slice(0, max);
  let start = hit - Math.floor(max / 4);
  // Don't start inside a tag: skip to just after its ">" when one closes first.
  const gt = content.indexOf(">", start);
  const lt = content.indexOf("<", start);
  if (gt !== -1 && gt - start < 400 && (lt === -1 || gt < lt)) start = gt + 1;
  return content.slice(start, start + max);
}

export function searchMatches(note: NoteLike, terms: string[]): SearchMatches {
  const title = noteTitle(note);
  const { snippet, matches } = buildSnippet(plainText(contentWindow(note.content ?? "", terms)), terms);
  return { title: findMatches(title, terms), snippet, snippetMatches: matches };
}

function day(value: string | undefined, end: boolean): number | null {
  if (!value) return null;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00.000Z`);
    return Number.isFinite(t) ? t + (end ? 86_400_000 - 1 : 0) : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Parse + validate filters from query params. Unknown/oversized values are dropped. */
export function parseSearchFilters(get: (name: string) => string | undefined): SearchFilters {
  const list = (name: string, cap: number) => (get(name) ?? "").split(",").map((s) => s.trim()).filter((s) => s && s.length <= 64 && /^[\w./:-]+$/u.test(s)).slice(0, cap);
  const f: SearchFilters = {};
  if (get("title") === "1" || get("title") === "true") f.titleOnly = true;
  const types = list("type", 10);
  if (types.length) f.types = types;
  const tags = list("tag", 5);
  if (tags.length) f.tags = tags;
  const author = (get("author") ?? "").trim().toLowerCase();
  if (author && author.length <= 254 && /^[^\s<>"]+$/.test(author)) f.author = author;
  const after = get("after"); const before = get("before");
  if (after && day(after, false) !== null) f.after = after;
  if (before && day(before, true) !== null) f.before = before;
  if (get("date") === "created") f.dateField = "created";
  return f;
}

export function hasFilters(f: SearchFilters): boolean {
  return !!(f.titleOnly || f.types?.length || f.tags?.length || f.author || f.after || f.before);
}

/** Does `note` pass every filter? `typeOf` = inferContentType (kept injectable). */
export function matchesFilters(note: NoteLike, f: SearchFilters, terms: string[], typeOf: (n: NoteLike) => string): boolean {
  if (f.titleOnly && terms.length) {
    const title = noteTitle(note).toLowerCase();
    if (!terms.every((t) => title.includes(t))) return false;
  }
  if (f.types?.length && !f.types.includes(typeOf(note))) return false;
  if (f.tags?.length && !f.tags.every((t) => note.tags?.includes(t))) return false;
  if (f.author) {
    const meta = note.metadata ?? {};
    const who = [meta.prism_creator, meta.prism_last_writer].filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
    if (!who.includes(f.author)) return false;
  }
  if (f.after || f.before) {
    const stamp = Date.parse((f.dateField === "created" ? note.createdAt : note.updatedAt) ?? "");
    if (!Number.isFinite(stamp)) return false;
    const lo = day(f.after, false); const hi = day(f.before, true);
    if (lo !== null && stamp < lo) return false;
    if (hi !== null && stamp > hi) return false;
  }
  return true;
}

/** Query-string form of filters (client → `/api/search`). */
export function filtersToParams(f: SearchFilters, params: URLSearchParams): URLSearchParams {
  if (f.titleOnly) params.set("title", "1");
  if (f.types?.length) params.set("type", f.types.join(","));
  if (f.tags?.length) params.set("tag", f.tags.join(","));
  if (f.author) params.set("author", f.author);
  if (f.after) params.set("after", f.after);
  if (f.before) params.set("before", f.before);
  if (f.dateField === "created") params.set("date", "created");
  return params;
}
