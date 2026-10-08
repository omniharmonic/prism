/**
 * Relation values — PURE. Reading is tolerant, writing is not (vault-health §8):
 * the vault holds four encodings for "this note points at that note", and a
 * relation property must read every one of them:
 *
 *   1. a full-path wikilink      `[[vault/projects/prism/PROJECT]]`, `[[vault/people/Ada]]`
 *   2. a FOLDER wikilink         `[[vault/projects/prism]]` (dangles: the note is …/PROJECT)
 *   3. a bare slug               `prism`, `spirit-of-the-front-range`
 *   4. a plain name or address   `Ada Lovelace`, `ada@example.org`
 *
 * plus `""` meaning "empty" (lists written by older ingesters). A value is resolved
 * against the TARGET's notes only, and only when exactly one note answers — an
 * ambiguous or unknown value stays unresolved (shown as the text it is, never
 * guessed). Prism always WRITES one form: the full-path wikilink (`asWikilink`).
 * Nothing here rewrites stored values.
 */
import { GENERIC_LEAF, isBlank, linkTarget, looksLikeEmail, safeTitleLeaf, type RelationTarget } from "./schema";

/** A note a relation may point at (the target's notes, as the reader may see them). */
export interface RelationCandidate {
  id: string;
  path: string | null;
  title: string;
  aliases?: string[];
  emails?: string[];
}

export type RelationResolution =
  | { kind: "note"; note: RelationCandidate; via: "path" | "folder" | "slug" | "name" | "email" }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" };

export interface RelationIndex {
  byPath: Map<string, RelationCandidate[]>;
  byFolder: Map<string, RelationCandidate[]>;
  bySlug: Map<string, RelationCandidate[]>;
  byName: Map<string, RelationCandidate[]>;
  byEmail: Map<string, RelationCandidate[]>;
  size: number;
}

/** Paths compare like the vault looks them up: case-insensitive, NFC, no `.md`, no slashes at the ends. */
export const pathKey = (p: string): string => p.normalize("NFC").trim().replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "").toLowerCase();
const nameKey = (s: string): string => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
/** "Spirit of the Front Range" → `spirit-of-the-front-range` (letters and digits kept, any script). */
export function slugOf(s: string): string {
  return s.normalize("NFC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

/** The stored strings of a relation value; `""`, null and blank list items are empty. */
export function relationValues(v: unknown): string[] {
  if (isBlank(v)) return [];
  const list = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const x of list) if (typeof x === "string" && x.trim()) out.push(x.trim());
  return out;
}

const add = (m: Map<string, RelationCandidate[]>, k: string, c: RelationCandidate) => {
  if (!k) return;
  const cur = m.get(k);
  if (!cur) m.set(k, [c]);
  else if (!cur.includes(c)) cur.push(c);
};

export function buildRelationIndex(candidates: RelationCandidate[]): RelationIndex {
  const idx: RelationIndex = { byPath: new Map(), byFolder: new Map(), bySlug: new Map(), byName: new Map(), byEmail: new Map(), size: candidates.length };
  for (const c of candidates) {
    if (c.path) {
      const p = pathKey(c.path);
      add(idx.byPath, p, c);
      const parts = p.split("/");
      const leaf = parts.pop() ?? "";
      const folder = parts.join("/");
      if (folder) add(idx.byFolder, folder, c);
      // A folder's own note (…/<slug>/PROJECT) is known by the folder's name.
      add(idx.bySlug, GENERIC_LEAF.test(leaf) && parts.length ? parts[parts.length - 1]! : leaf, c);
    }
    if (c.title) {
      add(idx.byName, nameKey(c.title), c);
      add(idx.bySlug, slugOf(c.title), c);
    }
    for (const a of c.aliases ?? []) if (typeof a === "string" && a.trim()) add(idx.byName, nameKey(a), c);
    for (const e of c.emails ?? []) if (typeof e === "string" && looksLikeEmail(e)) add(idx.byEmail, e.trim().toLowerCase(), c);
  }
  return idx;
}

const one = (list: RelationCandidate[] | undefined, via: Extract<RelationResolution, { kind: "note" }>["via"]): RelationResolution | null => {
  if (!list?.length) return null;
  return list.length === 1 ? { kind: "note", note: list[0]!, via } : { kind: "ambiguous", count: list.length };
};

/** A path (from a wikilink or written raw): exact, else the folder's own note, else its only note. */
function resolvePath(p: string, idx: RelationIndex): RelationResolution | null {
  const k = pathKey(p);
  if (!k) return null;
  const exact = one(idx.byPath.get(k), "path");
  if (exact) return exact;
  for (const leaf of ["project", "index", "readme"]) {
    const hit = one(idx.byPath.get(`${k}/${leaf}`), "folder");
    if (hit) return hit;
  }
  return one(idx.byFolder.get(k), "folder");
}

/**
 * Which target note a stored relation value means, if exactly one does. Order (vault-health §8):
 * wikilink path exact → folder link + `/PROJECT` (or the folder's only note) → bare slug →
 * an address (people) → a name or alias. A name or address that two notes answer is
 * `ambiguous`; nothing is ever matched by a partial string.
 */
export function resolveRelationValue(raw: string, idx: RelationIndex): RelationResolution {
  const t = raw.trim();
  if (!t) return { kind: "none" };
  const isLink = t.length >= 4 && t.startsWith("[[") && t.endsWith("]]");
  const inner = isLink ? linkTarget(t) : t;
  if (inner.includes("/")) {
    const byPath = resolvePath(inner, idx);
    // A [[link]] is a path; a plain value with a "/" may still be a name ("Sprint 6 (10/6 - 10/20)").
    if (byPath || isLink) return byPath ?? { kind: "none" };
    return one(idx.byName.get(nameKey(inner)), "name") ?? { kind: "none" };
  }
  if (looksLikeEmail(inner)) return one(idx.byEmail.get(inner.toLowerCase()), "email") ?? { kind: "none" };
  // A bare word: a path at the top level, a slug, then a name.
  const top = one(idx.byPath.get(pathKey(inner)), "path");
  if (top) return top;
  if (!/\s/.test(inner)) {
    const s = one(idx.bySlug.get(inner.toLowerCase()), "slug");
    if (s) return s;
  }
  return one(idx.byName.get(nameKey(inner)), "name") ?? { kind: "none" };
}

/** The path a stored value points at, when it resolves; else null. */
export function resolvedPath(raw: string, idx: RelationIndex | null | undefined): string | null {
  if (!idx) return null;
  const r = resolveRelationValue(raw, idx);
  return r.kind === "note" ? r.note.path : null;
}

/**
 * Where a NEW page of a relation's target goes ("Create “Atlas”" in the picker):
 * beside the target's existing pages. When most of them are a folder's own note
 * (`vault/projects/<slug>/PROJECT`) the new one follows that convention; else the
 * most common folder; a folder target uses the folder; nothing known → the top level.
 * `taken` = paths already in use (compared like the vault, case-insensitively).
 */
export function conventionalPath(target: RelationTarget | null, existing: Array<string | null>, title: string, taken: Iterable<string> = []): string {
  const leaf = safeTitleLeaf(title);
  const used = new Set<string>();
  for (const p of taken) used.add(pathKey(p));
  for (const p of existing) if (p) used.add(pathKey(p));
  const free = (make: (n: number) => string) => {
    for (let n = 1; n < 100; n++) { const p = make(n); if (!used.has(pathKey(p))) return p; }
    return make(Date.now());
  };
  const suffix = (n: number) => (n === 1 ? "" : ` ${n}`);
  if (target && "pathPrefix" in target) return free((n) => `${target.pathPrefix}/${leaf}${suffix(n)}`);
  const paths = existing.filter((p): p is string => !!p).map((p) => p.replace(/\.md$/i, ""));
  if (paths.length) {
    const count = (keys: string[]) => {
      const m = new Map<string, number>();
      for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    };
    const leaves = count(paths.map((p) => p.split("/").pop() ?? ""));
    if (leaves && GENERIC_LEAF.test(leaves[0]) && leaves[1] >= 2 && leaves[1] * 2 >= paths.length) {
      const genericPaths = paths.filter((p) => (p.split("/").pop() ?? "") === leaves[0]);
      const grand = count(genericPaths.map((p) => p.split("/").slice(0, -2).join("/")))?.[0] ?? "";
      const slug = slugOf(title) || "untitled";
      return free((n) => `${grand ? `${grand}/` : ""}${slug}${n === 1 ? "" : `-${n}`}/${leaves[0]}`);
    }
    const parent = count(paths.map((p) => p.split("/").slice(0, -1).join("/")))?.[0];
    if (parent !== undefined) return free((n) => `${parent ? `${parent}/` : ""}${leaf}${suffix(n)}`);
  }
  return free((n) => `${leaf}${suffix(n)}`);
}
