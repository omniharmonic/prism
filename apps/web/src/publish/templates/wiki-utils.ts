import { marked } from "marked";
import type { NavNote, PubGraph } from "./types";

/**
 * Pure helpers for the Wiki template: scoped wikilink resolution, markdown/HTML
 * body rendering, table-of-contents extraction, backlink derivation, and the
 * left-nav path tree. Kept side-effect-free (except DOM parsing of an already
 * sanitized string for the TOC) so they're easy to reason about and test.
 */

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Scoped wikilink resolution
// ---------------------------------------------------------------------------

/** Lowercased lookup keys → note id. Keys per note: full path, basename (with
 *  and without extension), and title. First write wins on collision. */
export type LinkIndex = Map<string, string>;

export function buildLinkIndex(notes: NavNote[]): LinkIndex {
  const idx: LinkIndex = new Map();
  const add = (raw: string | null | undefined, id: string) => {
    if (!raw) return;
    const key = raw.trim().toLowerCase();
    if (key && !idx.has(key)) idx.set(key, id);
  };
  for (const n of notes) {
    add(n.title, n.id);
    if (n.path) {
      add(n.path, n.id);
      const base = n.path.split("/").pop() || n.path;
      add(base, n.id);
      add(base.replace(/\.[^.]+$/, ""), n.id);
    }
  }
  return idx;
}

/** Resolve a wikilink target to an in-publication note id, or null. Tries the
 *  full target, its basename, and the basename sans extension (all
 *  case-insensitive). A trailing `#section` anchor is ignored for matching. */
export function resolveTarget(idx: LinkIndex, target: string): string | null {
  const t = (target.split("#")[0] || "").trim();
  if (!t) return null;
  const base = t.split("/").pop() || t;
  const baseNoExt = base.replace(/\.[^.]+$/, "");
  for (const k of [t.toLowerCase(), base.toLowerCase(), baseNoExt.toLowerCase()]) {
    const id = idx.get(k);
    if (id) return id;
  }
  return null;
}

/**
 * Render a note body to HTML with scoped wikilinks. `[[target]]` /
 * `[[target|display]]` becomes an in-app anchor (carrying `data-target=<id>`)
 * ONLY when it resolves to a note in this publication; otherwise it collapses to
 * inert plain text (no link, no leak), matching ShareView's flattening. HTML
 * note bodies pass through (still wikilink-substituted); markdown is converted.
 */
export function renderWikiBody(content: string, idx: LinkIndex, slug: string): string {
  const c = content ?? "";
  const sub = c.replace(WIKILINK_RE, (_m, target: string, name?: string) => {
    const fallback = (target.split("/").pop() || target).replace(/\.[^.]+$/, "");
    const display = (name || fallback || target).trim();
    const id = resolveTarget(idx, target);
    if (id) {
      const href = `/p/${encodeURIComponent(slug)}/notes/${encodeURIComponent(id)}`;
      return `<a class="pub-wikilink" data-target="${escapeHtml(id)}" href="${escapeHtml(href)}">${escapeHtml(display)}</a>`;
    }
    return escapeHtml(display);
  });
  if (sub.trim().startsWith("<")) return sub;
  return marked.parse(sub) as string;
}

// ---------------------------------------------------------------------------
// Table of contents (post-sanitize: only reads + adds id attributes)
// ---------------------------------------------------------------------------

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

/** Parse already-sanitized HTML, assign stable ids to h1–h3, and return both the
 *  id-augmented HTML and the heading list for the right-rail TOC. */
export function extractToc(html: string): { html: string; toc: TocEntry[] } {
  if (!html || typeof DOMParser === "undefined") return { html, toc: [] };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const toc: TocEntry[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll("h1, h2, h3").forEach((h) => {
    const text = h.textContent?.trim() || "";
    if (!text) return;
    const baseId = (h as HTMLElement).id || slugify(text);
    let uid = baseId;
    let i = 1;
    while (seen.has(uid)) uid = `${baseId}-${i++}`;
    seen.add(uid);
    (h as HTMLElement).id = uid;
    toc.push({ id: uid, text, level: Number(h.tagName[1]) });
  });
  return { html: doc.body.innerHTML, toc };
}

// ---------------------------------------------------------------------------
// Backlinks ("Linked references") from the publication-scoped graph
// ---------------------------------------------------------------------------

export interface Backlink {
  id: string;
  title: string;
}

/** Notes whose edge.target === activeId, restricted to in-publication notes
 *  (the graph is already pub-scoped; this is belt-and-suspenders + supplies
 *  titles for display). */
export function computeBacklinks(
  graph: PubGraph | null,
  activeId: string | null,
  notes: NavNote[],
): Backlink[] {
  if (!graph || !activeId) return [];
  const titleById = new Map<string, string>();
  for (const n of notes) titleById.set(n.id, n.title);
  for (const n of graph.nodes) if (!titleById.has(n.id)) titleById.set(n.id, n.title);
  const inPub = new Set(notes.map((n) => n.id));
  const sources = new Set<string>();
  for (const e of graph.edges) {
    if (e.target === activeId && e.source !== activeId) sources.add(e.source);
  }
  return [...sources]
    .filter((id) => inPub.has(id))
    .map((id) => ({ id, title: titleById.get(id) || id }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Left-nav path tree
// ---------------------------------------------------------------------------

export interface TreeLeaf {
  type: "leaf";
  name: string;
  id: string;
  path: string | null;
}
export interface TreeFolder {
  type: "folder";
  name: string;
  path: string;
  children: TreeItem[];
}
export type TreeItem = TreeFolder | TreeLeaf;

interface RawFolder {
  folders: Map<string, RawFolder>;
  leaves: TreeLeaf[];
}

function leafName(n: NavNote): string {
  if (n.path) {
    const base = n.path.split("/").pop() || n.path;
    return base.replace(/\.[^.]+$/, "") || n.title;
  }
  return n.title;
}

/** Build a folder tree from note `path`s. Notes without a path become top-level
 *  leaves (the flat fallback). Folders sort before leaves, both alphabetically. */
export function buildTree(notes: NavNote[]): TreeItem[] {
  const root: RawFolder = { folders: new Map(), leaves: [] };
  for (const n of notes) {
    if (!n.path) {
      root.leaves.push({ type: "leaf", name: n.title, id: n.id, path: null });
      continue;
    }
    const parts = n.path.split("/").filter(Boolean);
    const fileParts = parts.slice(0, -1); // folders only; last segment is the file
    let cur = root;
    for (const seg of fileParts) {
      let next = cur.folders.get(seg);
      if (!next) {
        next = { folders: new Map(), leaves: [] };
        cur.folders.set(seg, next);
      }
      cur = next;
    }
    cur.leaves.push({ type: "leaf", name: leafName(n), id: n.id, path: n.path });
  }

  const toItems = (raw: RawFolder, prefix: string): TreeItem[] => {
    const folders: TreeItem[] = [...raw.folders.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, child]) => {
        const path = prefix ? `${prefix}/${name}` : name;
        return { type: "folder", name, path, children: toItems(child, path) } as TreeFolder;
      });
    const leaves = [...raw.leaves].sort((a, b) => a.name.localeCompare(b.name));
    return [...folders, ...leaves];
  };

  return toItems(root, "");
}

/** Folder paths that contain `activeId` (so they can default to open). */
export function ancestorFolders(notes: NavNote[], activeId: string | null): Set<string> {
  const out = new Set<string>();
  if (!activeId) return out;
  const active = notes.find((n) => n.id === activeId);
  if (!active?.path) return out;
  const parts = active.path.split("/").filter(Boolean).slice(0, -1);
  let prefix = "";
  for (const seg of parts) {
    prefix = prefix ? `${prefix}/${seg}` : seg;
    out.add(prefix);
  }
  return out;
}
