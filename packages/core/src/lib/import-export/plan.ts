/**
 * The import PLANNER — pure, isomorphic, no I/O.
 *
 * Input: the members of an upload (a Notion export ZIP, a ZIP of Markdown, or a
 * single .md / .html / .csv file) as `{name, size, read()}`. Output: the notes
 * to create, in parent-before-child order, with
 *   - nesting preserved (`Page <id>.md` + folder `Page <id>/` → page + sub-pages;
 *     Notion's 32-hex ids stripped from every name),
 *   - internal links turned into `[[wikilinks]]` to the DESTINATION paths,
 *   - referenced images/files recorded as assets (a token stands in the content
 *     until the server has stored the attachment),
 *   - a `Name.csv` (+ its folder of row pages) mapped to a database note whose
 *     rows are the pages, tagged with a database-specific tag,
 *   - front matter (what Prism's own export writes) mapped to tags + properties.
 *
 * Security: names arrive already canonicalised by `safeZipName`; every
 * destination segment is rebuilt by `safePageSegment`; tags and property keys go
 * through the caller's `allowTag` / `allowKey` (the server passes its canonical
 * tag rule and system/ingest key rules); all text scanning is linear
 * (`./markdown.ts`). The planner never decides WHERE writes are allowed — the
 * server validates every planned path again.
 */
import { parseCsv } from "../database/csv";
import {
  isRelativeTarget,
  leadingHeading,
  neutralizeUnsafeLinks,
  parseFrontMatter,
  resolveRelative,
  rewriteMarkdownLinks,
  safeDecode,
  safePageSegment,
  stripNotionId,
} from "./markdown";

export interface ImportFile {
  /** Clean relative path inside the upload (forward slashes). */
  name: string;
  size: number;
  read(): Uint8Array;
}

export interface ImportLimits {
  maxNotes: number;
  maxTextBytes: number;
  maxAssetBytes: number;
  maxDepth: number;
  maxRows: number;
  maxCols: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxNotes: 5000,
  maxTextBytes: 1_500_000,
  maxAssetBytes: 25 * 1024 * 1024,
  maxDepth: 16,
  maxRows: 5000,
  maxCols: 60,
};

export interface PlanOptions {
  /** Destination folder (a clean vault path, no trailing slash). */
  root: string;
  limits?: Partial<ImportLimits>;
  /** HTML → Markdown (the server passes turndown; dangerous elements removed). null = refused (too large / too complex): the page is skipped. */
  htmlToMarkdown: (html: string) => string | null;
  /** Canonical tag, or null when this tag may not be applied by an import. */
  allowTag: (tag: string) => string | null;
  /** May an import set this metadata key? */
  allowKey: (key: string) => boolean;
  /** Stable hex digest (sha-256 on the server). */
  hash: (data: string | Uint8Array) => string;
}

export interface PlannedAsset {
  /** Archive member the page references. */
  file: string;
  /** Referenced as an image (`![…]`) rather than a link. */
  image: boolean;
  /** The placeholder that stands in the content until the attachment exists. */
  token: string;
  /** What to restore when the asset cannot be attached. */
  original: string;
  /** Digest of the file's bytes (attachments are reused across runs by it). */
  hash: string;
}

export interface PlannedNote {
  /** Stable identity of the source inside the upload (hashed archive path). */
  src: string;
  /** Archive member (for reporting). */
  entry: string;
  path: string;
  title: string;
  kind: "page" | "database" | "row";
  content: string;
  assets: PlannedAsset[];
  tags: string[];
  metadata: Record<string, unknown>;
  /** Digest of everything this note would be written from (content, tags, properties, asset bytes). */
  hash: string;
}

export interface ImportProblem {
  entry: string;
  reason: string;
}

export interface ImportPlan {
  root: string;
  notes: PlannedNote[];
  problems: ImportProblem[];
  /** Archive members some planned note references. */
  assets: Map<string, ImportFile>;
  counts: { pages: number; databases: number; rows: number; assets: number; links: number; ignored: number };
}

const TEXT_EXT = new Set(["md", "markdown", "html", "htm"]);
export const ASSET_TOKEN = "prism-import-asset:";

const extOf = (name: string): string => {
  const slash = name.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  return dot > slash + 0 && dot !== -1 ? name.slice(dot + 1).toLowerCase() : "";
};
const baseOf = (name: string): string => {
  const slash = name.lastIndexOf("/");
  const leaf = slash === -1 ? name : name.slice(slash + 1);
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
};
const dirOf = (name: string): string => {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? "" : name.slice(0, slash);
};
const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;
function text(bytes: Uint8Array): string {
  const s = decoder!.decode(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
const fold = (s: string) => s.normalize("NFC").toLowerCase();

function hiddenName(name: string): boolean {
  for (const seg of name.split("/")) if (seg.startsWith(".") || seg === "__MACOSX" || seg === "Thumbs.db" || seg === "desktop.ini") return true;
  return false;
}

/** `Reading list` → `reading_list`; always a usable property key. */
export function propertyKeyFor(header: string, allowKey: (k: string) => boolean, taken: Set<string>): string {
  let key = "";
  for (const ch of header.trim().toLowerCase()) {
    const c = ch.charCodeAt(0);
    key += (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ? ch : "_";
    if (key.length >= 40) break;
  }
  while (key.includes("__")) key = key.split("__").join("_");
  while (key.startsWith("_")) key = key.slice(1);
  while (key.endsWith("_")) key = key.slice(0, -1);
  if (!key || !(key.charCodeAt(0) >= 97 && key.charCodeAt(0) <= 122)) key = `c_${key}`;
  if (!allowKey(key)) key = `col_${key}`;
  if (!allowKey(key)) key = "col_value";
  let unique = key;
  for (let i = 2; taken.has(unique); i++) unique = `${key}_${i}`;
  taken.add(unique);
  return unique;
}

function slug(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) {
    const c = ch.charCodeAt(0);
    out += (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ? ch : "-";
    if (out.length >= 40) break;
  }
  while (out.includes("--")) out = out.split("--").join("-");
  while (out.startsWith("-")) out = out.slice(1);
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out || "database";
}

/** A link target with a scheme: kept only for http(s) / mailto; `/…`, `#…` and `//host` are not schemes. */
function keepsScheme(target: string): boolean {
  const t = target.trim();
  if (t.startsWith("/") || t.startsWith("#") || t.startsWith("?")) return true;
  let compact = "";
  for (let i = 0; i < t.length && compact.length < 16; i++) if (t.charCodeAt(i) > 32) compact += t[i];
  const scheme = compact.slice(0, Math.max(compact.indexOf(":"), 0)).toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

const cleanLabel = (s: string): string => s.split("[").join("").split("]").join("").split("|").join(" ").trim();

export function planImport(input: ImportFile[], opts: PlanOptions): ImportPlan {
  const limits: ImportLimits = { ...DEFAULT_IMPORT_LIMITS, ...(opts.limits ?? {}) };
  const problems: ImportProblem[] = [];
  const problem = (entry: string, reason: string) => {
    if (problems.length < 500) problems.push({ entry, reason });
  };
  let ignored = 0;

  // 1. Usable members, in a stable order.
  let files = input.filter((f) => {
    if (hiddenName(f.name)) {
      ignored++;
      return false;
    }
    return true;
  });
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // 2. A single wrapping folder (someone zipped a folder) is not a page.
  if (files.length > 1) {
    const first = files[0]!.name.indexOf("/");
    if (first !== -1) {
      const top = files[0]!.name.slice(0, first + 1);
      const pageForTop = top.slice(0, -1);
      // (A page `Top.md` beside `Top/` would sit at the top level, so not every member starts with `Top/`.)
      if (pageForTop && files.every((f) => f.name.startsWith(top))) {
        files = files.map((f) => ({ ...f, name: f.name.slice(top.length), read: () => f.read() }));
      }
    }
  }

  const byName = new Map<string, ImportFile>();
  for (const f of files) byName.set(f.name, f);

  // 3. Nodes: a page/database file and the folder of the same base name are ONE node.
  //    nodeKey = "<dir>/<base without extension>" (raw archive names).
  type Kind = "md" | "html" | "csv";
  interface Source { file: ImportFile; kind: Kind }
  const sources = new Map<string, Source>();
  for (const f of files) {
    const ext = extOf(f.name);
    let kind: Kind | null = TEXT_EXT.has(ext) ? (ext.startsWith("htm") ? "html" : "md") : ext === "csv" ? "csv" : null;
    if (!kind) continue;
    let base = baseOf(f.name);
    if (kind === "csv" && base.endsWith("_all")) {
      // Notion writes `<db>_all.csv` beside `<db>.csv`: one database.
      const twin = `${dirOf(f.name) ? `${dirOf(f.name)}/` : ""}${base.slice(0, -4)}.csv`;
      if (byName.has(twin)) {
        ignored++;
        continue;
      }
      base = base.slice(0, -4);
    }
    const key = `${dirOf(f.name) ? `${dirOf(f.name)}/` : ""}${base}`;
    const had = sources.get(key);
    if (had) {
      // A database wins over a page of the same name; among pages the first (sorted) wins.
      if (kind === "csv" && had.kind !== "csv") {
        problem(had.file.name, "skipped: a database with the same name is imported instead");
        sources.set(key, { file: f, kind });
      } else problem(f.name, "skipped: another file has the same name");
      continue;
    }
    sources.set(key, { file: f, kind });
  }

  // Destination segment per node, unique among siblings (case-insensitive), deterministic.
  const destSeg = new Map<string, string>();
  const siblings = new Map<string, Set<string>>();
  const nodeKeys = new Set<string>(sources.keys());
  for (const key of sources.keys()) {
    // Every ancestor folder is a node too (it may have no page of its own).
    let d = dirOf(key);
    while (d) {
      nodeKeys.add(d);
      d = dirOf(d);
    }
  }
  for (const key of [...nodeKeys].sort()) {
    const parent = dirOf(key);
    const raw = key.slice(parent ? parent.length + 1 : 0);
    const want = safePageSegment(stripNotionId(raw));
    const taken = siblings.get(parent) ?? new Set<string>();
    siblings.set(parent, taken);
    let seg = want;
    for (let i = 2; taken.has(fold(seg)); i++) seg = `${want} (${i})`;
    taken.add(fold(seg));
    destSeg.set(key, seg);
  }
  const destCache = new Map<string, string>();
  const destOf = (key: string): string => {
    const hit = destCache.get(key);
    if (hit !== undefined) return hit;
    const parent = dirOf(key);
    const base = parent ? destOf(parent) : opts.root;
    const seg = destSeg.get(key) ?? safePageSegment(stripNotionId(key.slice(parent ? parent.length + 1 : 0)));
    const out = base ? `${base}/${seg}` : seg;
    destCache.set(key, out);
    return out;
  };
  const depthOf = (key: string) => key.split("/").length;

  // Archive file name → destination path, for link rewriting.
  const pageDest = new Map<string, string>();
  for (const [key, s] of sources) pageDest.set(s.file.name, destOf(key));

  const notes: PlannedNote[] = [];
  const assets = new Map<string, ImportFile>();
  const assetHash = new Map<string, string>();
  let links = 0;
  let rows = 0;
  let databases = 0;
  let pages = 0;
  const budget = () => notes.length < limits.maxNotes;

  const hashOfAsset = (f: ImportFile): string => {
    let h = assetHash.get(f.name);
    if (!h) {
      h = opts.hash(f.read());
      assetHash.set(f.name, h);
    }
    return h;
  };

  /** Markdown body of one source file: front matter split off, links + assets rewritten. */
  function bodyOf(s: Source, title: string, propertyLabels?: Set<string>) {
    let raw = text(s.file.read());
    if (s.kind === "html") {
      const md = opts.htmlToMarkdown(raw);
      if (md === null) return null;
      raw = md;
    }
    const fm = s.kind === "md" ? parseFrontMatter(raw) : { data: {}, body: raw };
    let body = fm.body;
    const head = leadingHeading(body);
    if (head && (fold(head.title) === fold(title) || fold(safePageSegment(head.title)) === fold(title))) {
      body = head.rest;
      // Notion writes a row's properties as `Key: value` lines under the title.
      if (propertyLabels?.size) body = dropPropertyLines(body, propertyLabels);
    }
    const noteAssets: PlannedAsset[] = [];
    // Autolinks and reference definitions with a script-ish scheme become plain text / `#`.
    body = neutralizeUnsafeLinks(body);
    body = rewriteMarkdownLinks(body, (link) => {
      if (!isRelativeTarget(link.target)) {
        // Only web and mail links survive an import; `javascript:`, `data:`, `file:`… become their text.
        return keepsScheme(link.target) ? null : cleanLabel(link.text);
      }
      const resolved = resolveRelative(s.file.name, safeDecode(link.target));
      if (resolved === null) return null;
      const page = pageDest.get(resolved);
      if (page !== undefined && !link.image) {
        links++;
        const label = cleanLabel(link.text);
        const leaf = page.slice(page.lastIndexOf("/") + 1);
        return label && fold(label) !== fold(leaf) ? `[[${page}|${label}]]` : `[[${page}]]`;
      }
      const file = byName.get(resolved);
      if (!file || pageDest.has(resolved)) return null;
      if (file.size > limits.maxAssetBytes) {
        problem(file.name, "not imported: the file is too large");
        return null;
      }
      let asset = noteAssets.find((a) => a.file === file.name && a.image === link.image);
      if (!asset) {
        asset = { file: file.name, image: link.image, token: `${ASSET_TOKEN}${noteAssets.length}`, original: link.target, hash: hashOfAsset(file) };
        noteAssets.push(asset);
        assets.set(file.name, file);
      }
      return `${link.image ? "!" : ""}[${link.text}](${asset.token})`;
    });
    let lead = 0;
    while (lead < body.length && (body[lead] === "\n" || body[lead] === "\r")) lead++;
    return { body: body.trim() === "" ? "" : body.slice(lead), data: fm.data as Record<string, unknown>, assets: noteAssets };
  }

  function metaFrom(data: Record<string, unknown>, entry: string): { tags: string[]; metadata: Record<string, unknown> } {
    const tags: string[] = [];
    const rawTags = Array.isArray(data.tags) ? data.tags : typeof data.tags === "string" ? data.tags.split(",") : [];
    for (const t of rawTags.slice(0, 50)) {
      if (typeof t !== "string") continue;
      const ok = opts.allowTag(t);
      if (ok === null) problem(entry, `tag not applied: ${t.slice(0, 60)}`);
      else if (ok && !tags.includes(ok)) tags.push(ok);
    }
    const metadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === "tags" || k === "title" || k === "created" || k === "updated" || k === "path") continue;
      if (v === null || v === undefined || !opts.allowKey(k)) continue;
      let size = 0;
      try {
        size = JSON.stringify(v).length;
      } catch {
        continue;
      }
      if (size > 10_000) continue;
      metadata[k] = v;
    }
    return { tags, metadata };
  }

  const push = (note: Omit<PlannedNote, "hash" | "src">) => {
    const assetHashes = note.assets.map((a) => `${a.image ? "i" : "f"}:${a.hash}`);
    const hash = opts.hash(JSON.stringify([note.kind, note.content, note.tags, note.metadata, assetHashes]));
    notes.push({ ...note, src: opts.hash(`src:${note.entry}`).slice(0, 24), hash });
  };

  // 4. Emit, parents first.
  const ordered = [...sources.entries()].sort((a, b) => depthOf(a[0]) - depthOf(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const rowSources = new Set<string>(); // node keys consumed as database rows
  // Databases first decide which pages are rows.
  const dbPlans = new Map<string, { header: string[]; keys: string[]; rows: string[][]; tag: string | null }>();
  for (const [key, s] of ordered) {
    if (s.kind !== "csv") continue;
    if (s.file.size > limits.maxTextBytes) {
      problem(s.file.name, "skipped: the file is too large");
      continue;
    }
    let table: string[][];
    try {
      table = parseCsv(text(s.file.read()), { maxRows: limits.maxRows + 1, maxCols: limits.maxCols, maxCell: 10_000 });
    } catch (e) {
      problem(s.file.name, `skipped: ${e instanceof Error ? e.message : "not valid CSV"}`);
      continue;
    }
    const header = (table[0] ?? []).map((h) => h.trim());
    if (!header.length || !header[0]) {
      problem(s.file.name, "skipped: the first row must name the columns");
      continue;
    }
    const taken = new Set<string>();
    const keys = header.map((h, i) => (i === 0 ? "$title" : propertyKeyFor(h || `column ${i + 1}`, opts.allowKey, taken)));
    const dest = destOf(key);
    const tag = opts.allowTag(`db-${slug(destSeg.get(key) ?? "database")}-${opts.hash(`db:${dest}`).slice(0, 8)}`);
    dbPlans.set(key, { header, keys, rows: table.slice(1), tag });
  }

  for (const [key, s] of ordered) {
    if (rowSources.has(key)) continue;
    if (!budget()) {
      problem(s.file.name, `skipped: an import is limited to ${limits.maxNotes} pages`);
      continue;
    }
    if (depthOf(key) + (opts.root ? opts.root.split("/").length : 0) > limits.maxDepth) {
      problem(s.file.name, "skipped: nested too deeply");
      continue;
    }
    const path = destOf(key);
    const title = path.slice(path.lastIndexOf("/") + 1);

    if (s.kind === "csv") {
      const db = dbPlans.get(key);
      if (!db) continue;
      const visible = db.keys.filter((k) => k !== "$title");
      const config = { version: 1, source: { tags: [db.tag ?? ""] }, views: [{ id: "table", name: "Table", type: "table", ...(visible.length ? { visible } : {}) }] };
      if (!db.tag) {
        problem(s.file.name, "imported as plain pages: no tag is available for this database");
      } else {
        push({ entry: s.file.name, path, title, kind: "database", content: "", assets: [], tags: [], metadata: { prism_type: "database", prism_database: config } });
        databases++;
      }
      // Row pages: the .md files directly inside the folder of the same name.
      const children = new Map<string, string>(); // folded title → node key
      for (const [ck, cs] of sources) {
        if (cs.kind === "csv" || dirOf(ck) !== key) continue;
        const seg = fold(safePageSegment(stripNotionId(ck.slice(key.length + 1))));
        if (!children.has(seg)) children.set(seg, ck);
      }
      const labels = new Set(db.header.slice(1).map((h) => fold(h)));
      const used = new Set<string>();
      const rowTaken = new Set<string>();
      for (const [i, cells] of db.rows.entries()) {
        const rowTitle = (cells[0] ?? "").trim().slice(0, 500);
        if (!rowTitle) {
          problem(s.file.name, `row ${i + 2} skipped: the title is empty`);
          continue;
        }
        if (!budget()) {
          problem(s.file.name, `rows after ${i + 1} skipped: an import is limited to ${limits.maxNotes} pages`);
          break;
        }
        const want = safePageSegment(rowTitle);
        // Notion truncates long file names: match an exact name, else a long prefix.
        let childKey = children.get(fold(want));
        if (!childKey) {
          for (const [seg, ck] of children) {
            if (seg.length >= 40 && fold(want).startsWith(seg) && !used.has(ck)) {
              childKey = ck;
              break;
            }
          }
        }
        if (childKey && used.has(childKey)) childKey = undefined;
        let seg = childKey ? destSeg.get(childKey)! : want;
        if (!childKey) for (let n = 2; rowTaken.has(fold(seg)) || (siblings.get(key)?.has(fold(seg)) ?? false); n++) seg = `${want} (${n})`;
        rowTaken.add(fold(seg));
        const metadata: Record<string, unknown> = {};
        for (let c = 1; c < db.keys.length; c++) {
          const v = (cells[c] ?? "").trim();
          if (v) metadata[db.keys[c]!] = v;
        }
        let content = "";
        let rowAssets: PlannedAsset[] = [];
        let entry = `${s.file.name}#${i + 2}`;
        if (childKey) {
          used.add(childKey);
          rowSources.add(childKey);
          const child = sources.get(childKey)!;
          if (child.file.size > limits.maxTextBytes) problem(child.file.name, "body not imported: the file is too large");
          else {
            const b = bodyOf(child, destSeg.get(childKey)!, labels);
            if (!b) problem(child.file.name, "body not imported: the HTML is too large or too complex");
            else {
              content = b.body;
              rowAssets = b.assets;
              entry = child.file.name;
            }
          }
        }
        push({ entry, path: `${path}/${seg}`, title: seg, kind: "row", content, assets: rowAssets, tags: db.tag ? [db.tag] : [], metadata: { title: rowTitle, ...metadata } });
        rows++;
      }
      continue;
    }

    if (s.file.size > limits.maxTextBytes) {
      problem(s.file.name, "skipped: the page is too large");
      continue;
    }
    const b = bodyOf(s, title);
    if (!b) {
      problem(s.file.name, "skipped: the HTML is too large or too complex");
      continue;
    }
    const m = metaFrom(b.data, s.file.name);
    push({ entry: s.file.name, path, title, kind: "page", content: b.body, assets: b.assets, tags: m.tags, metadata: m.metadata });
    pages++;
  }

  // Unreferenced, non-page members are not imported.
  for (const f of files) {
    const ext = extOf(f.name);
    if (!TEXT_EXT.has(ext) && ext !== "csv" && !assets.has(f.name)) ignored++;
  }

  notes.sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: opts.root, notes, problems, assets, counts: { pages, databases, rows, assets: assets.size, links, ignored } };
}

/** Drop a leading block of `Label: value` lines whose labels are all database columns. */
function dropPropertyLines(body: string, labels: Set<string>): string {
  let pos = 0;
  // Skip blank lines after the heading.
  while (pos < body.length) {
    let nl = body.indexOf("\n", pos);
    if (nl === -1) nl = body.length;
    if (body.slice(pos, nl).trim() !== "") break;
    pos = nl + 1;
  }
  let end = pos;
  let any = false;
  while (end < body.length) {
    let nl = body.indexOf("\n", end);
    if (nl === -1) nl = body.length;
    const line = body.slice(end, nl);
    if (line.trim() === "") break;
    const colon = line.indexOf(":");
    if (colon <= 0 || !labels.has(fold(line.slice(0, colon).trim()))) return body;
    any = true;
    end = nl + 1;
  }
  return any ? body.slice(Math.min(end, body.length)) : body;
}
