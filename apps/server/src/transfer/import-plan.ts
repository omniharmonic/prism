/**
 * The CPU half of an import — unzip, convert, plan — as ONE synchronous function
 * that runs in the transfer worker thread (`worker.ts`), never on the server's
 * event loop. It touches no database and no network; everything it needs arrives
 * in the message (limits, the tags this vault does not allow an import to apply).
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import TurndownService from "turndown";
import { protectionReason, TRASH_TAG } from "@prism/core/pages";
import { isFieldKey, isSystemKey } from "@prism/core/database";
import {
  ZipError,
  htmlDepth,
  looksLikeZip,
  planImport,
  readZipDirectory,
  readZipEntry,
  safeZipName,
  stripNotionId,
  type ImportFile,
  type ImportProblem,
  type PlannedNote,
  type ZipLimits,
} from "@prism/core/import-export";
import { canonicalTag } from "../tags";
import { INGEST_KEYS } from "../ingest-keys";
import { isReservedMetaKey, isReservedTag } from "../worker/sync-reserved";

export interface PlanLimits {
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxNotes: number;
  maxTextBytes: number;
  maxDepth: number;
  maxFileBytes: number;
  /** HTML handed to the DOM-based converter: per file, per request, and how deeply it may nest. */
  maxHtmlFileBytes: number;
  maxHtmlTotalBytes: number;
  maxHtmlDepth: number;
}

export interface PlanRequest {
  op: "import-plan";
  bytes: Uint8Array;
  fileName: string;
  root: string;
  limits: PlanLimits;
  /** Canonical tags an import may not apply in this vault (published, or named by a grant). */
  deniedTags: string[];
}

export interface PlanResult {
  root: string;
  single: boolean;
  archiveName: string;
  notes: PlannedNote[];
  problems: ImportProblem[];
  counts: { pages: number; databases: number; rows: number; assets: number; links: number; ignored: number };
  /** The bytes of every file some planned page references (transferred, not copied). */
  assets: Array<{ name: string; bytes: Uint8Array }>;
}

export class ImportError extends Error {
  constructor(public readonly status: 400 | 413 | 415, public readonly code: string, message: string) {
    super(message);
  }
}

export const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const inflate = (data: Uint8Array, maxOut: number): Uint8Array => inflateRawSync(data, { maxOutputLength: Math.max(maxOut, 1) });
const SINGLE_EXT = new Set(["md", "markdown", "html", "htm", "csv"]);

/** The members of an upload as lazily-read files, plus entries that were refused. */
export function readUpload(bytes: Uint8Array, fileName: string, cfg: PlanLimits): { files: ImportFile[]; refused: ImportProblem[]; archiveName: string } {
  const refused: ImportProblem[] = [];
  const cleanName = safeZipName(fileName.split("\\").join("/").split("/").pop() ?? "") ?? "import";
  const dot = cleanName.lastIndexOf(".");
  const stem = stripNotionId(dot > 0 ? cleanName.slice(0, dot) : cleanName);
  if (!looksLikeZip(bytes)) {
    const ext = dot > 0 ? cleanName.slice(dot + 1).toLowerCase() : "";
    if (!SINGLE_EXT.has(ext)) throw new ImportError(415, "unsupported_type", "Import a .zip, .md, .html or .csv file.");
    if (bytes.length > cfg.maxTextBytes) throw new ImportError(413, "too_large", "That file is too large to import as one page.");
    return { files: [{ name: cleanName, size: bytes.length, read: () => bytes }], refused, archiveName: stem };
  }
  const limits: ZipLimits = { maxEntries: cfg.maxEntries, maxEntryBytes: cfg.maxEntryBytes, maxTotalBytes: cfg.maxTotalBytes };
  let total = 0;
  const files: ImportFile[] = [];
  const seen = new Set<string>();
  const spend = (n: number) => {
    total += n;
    if (total > cfg.maxTotalBytes) throw new ZipError("too_large", "the archive is too large when unpacked");
  };
  const collect = (buf: Uint8Array, lim: ZipLimits, prefix: string) => {
    for (const e of readZipDirectory(buf, lim)) {
      if (e.directory) continue;
      if (e.unsafe) {
        if (refused.length < 100) refused.push({ entry: `${prefix}${e.name}`.slice(0, 200), reason: `ignored: ${e.unsafe}` });
        continue;
      }
      spend(e.size);
      if (files.length >= cfg.maxEntries) throw new ZipError("too_many_entries", "the archive has too many files");
      const key = e.name.toLowerCase();
      if (seen.has(key)) {
        if (refused.length < 100) refused.push({ entry: e.name.slice(0, 200), reason: "ignored: duplicate name" });
        continue;
      }
      seen.add(key);
      files.push({ name: e.name, size: e.size, read: () => readZipEntry(buf, e, inflate) });
    }
  };
  try {
    // Notion's wrapper: an archive whose only members are `…-Part-N.zip`. Unpack ONE level.
    const outer = readZipDirectory(bytes, { ...limits, maxEntryBytes: Math.max(cfg.maxEntryBytes, cfg.maxBytes) });
    const members = outer.filter((e) => !e.directory && !e.unsafe);
    const wrapper = members.length > 0 && members.length <= 20 && members.every((e) => e.name.toLowerCase().endsWith(".zip") && !e.name.includes("/"));
    if (wrapper) {
      for (const e of members) {
        // An unpacked part is held in memory: it counts against the budget, and so does what is inside it.
        spend(e.size);
        const inner = readZipEntry(bytes, e, inflate);
        if (!looksLikeZip(inner)) throw new ZipError("corrupt", "a part of the archive is not a zip file");
        collect(inner, { ...limits, maxTotalBytes: Math.max(cfg.maxTotalBytes - total, 0) }, `${e.name}/`);
      }
    } else collect(bytes, limits, "");
  } catch (e) {
    if (e instanceof ZipError) throw new ImportError(e.code === "too_large" || e.code === "too_many_entries" ? 413 : 400, e.code, e.message);
    throw e;
  }
  return { files, refused, archiveName: stem };
}

// ── HTML → Markdown ─────────────────────────────────────────────────────────

/** Text handed back as Markdown must not be able to become markup again: `&lt;script&gt;` stays text. */
function escapeText(this: TurndownService, text: string): string {
  return TurndownService.prototype.escape.call(this, text).split("<").join("\\<");
}
export function newTurndown(): TurndownService {
  const t = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  t.escape = escapeText;
  t.remove(["script", "style", "noscript", "template", "title", "iframe", "object", "embed", "form", "button", "input", "select", "textarea", "frame", "frameset", "applet", "link", "meta", "base"] as never);
  return t;
}

/** Index of `<name` / `</name` (ASCII case-insensitive) at or after `from`, or -1. Linear. */
function indexOfTag(html: string, name: string, from: number, closing = false): number {
  const open = closing ? "</" : "<";
  let at = html.indexOf(open, from);
  while (at !== -1) {
    const word = html.slice(at + open.length, at + open.length + name.length);
    const after = html.charCodeAt(at + open.length + name.length);
    // The tag name must end there: `<body>`, `<body class…`, `<body/>` — not `<bodyguard`.
    const ends = Number.isNaN(after) || after === 62 || after === 47 || after <= 32;
    if (word.length === name.length && word.toLowerCase() === name && ends) return at;
    at = html.indexOf(open, at + 1);
  }
  return -1;
}

/**
 * The part of an HTML file that is the page: inside `<body>` when there is one,
 * else whatever follows `</head>`. (The server's DOM parser is a fragment parser:
 * handed a whole document it yields nothing.)
 */
export function htmlBody(html: string): string {
  const body = indexOfTag(html, "body", 0);
  if (body !== -1) {
    const open = html.indexOf(">", body);
    if (open === -1) return "";
    const close = indexOfTag(html, "body", open, true);
    return html.slice(open + 1, close === -1 ? html.length : close);
  }
  const head = indexOfTag(html, "head", 0, true);
  if (head !== -1) {
    const gt = html.indexOf(">", head);
    return gt === -1 ? "" : html.slice(gt + 1);
  }
  return html;
}

// ── what an import may set ──────────────────────────────────────────────────

const TOMBSTONE_TAGS = new Set(["merged-stub", "superseded", "bot", "non-human"]);

/** The static half of the tag rule (no database): the canonical tag, or null. */
export function staticTagAllowed(raw: string): string | null {
  const tag = canonicalTag(raw);
  if (!tag || tag.length > 128) return null;
  for (let i = 0; i < tag.length; i++) if (tag.charCodeAt(i) < 0x20) return null;
  if (tag === TRASH_TAG || isReservedTag(tag) || TOMBSTONE_TAGS.has(tag.toLowerCase())) return null;
  if (protectionReason({ tags: [tag] })) return null;
  return tag;
}

export const importKeyAllowed = (key: string): boolean =>
  isFieldKey(key) && !isSystemKey(key) && !isReservedMetaKey(key) && !INGEST_KEYS.has(key) && key !== "source";

// ── the task ────────────────────────────────────────────────────────────────

export function planUpload(req: PlanRequest): PlanResult {
  const cfg = req.limits;
  const upload = readUpload(req.bytes, req.fileName, cfg);
  const denied = new Set(req.deniedTags);
  const turndown = newTurndown();
  let htmlBudget = cfg.maxHtmlTotalBytes;
  const plan = planImport(upload.files, {
    root: req.root,
    limits: { maxNotes: cfg.maxNotes, maxTextBytes: cfg.maxTextBytes, maxAssetBytes: cfg.maxFileBytes, maxDepth: cfg.maxDepth },
    htmlToMarkdown: (html) => {
      const body = htmlBody(html);
      // The converter builds a DOM: bound what it is given (per file, per request, nesting).
      if (body.length > cfg.maxHtmlFileBytes || body.length > htmlBudget || htmlDepth(body) > cfg.maxHtmlDepth) return null;
      htmlBudget -= body.length;
      return turndown.turndown(body);
    },
    allowTag: (t) => {
      const tag = staticTagAllowed(t);
      return tag && !denied.has(tag) ? tag : null;
    },
    allowKey: importKeyAllowed,
    hash: sha,
  });
  const assets: PlanResult["assets"] = [];
  for (const [name, file] of plan.assets) {
    // A copy with its own buffer: transferable, and independent of the upload it came from.
    assets.push({ name, bytes: new Uint8Array(file.read()) });
  }
  return {
    root: plan.root,
    single: !looksLikeZip(req.bytes),
    archiveName: upload.archiveName,
    notes: plan.notes,
    problems: [...upload.refused, ...plan.problems].slice(0, 500),
    counts: plan.counts,
    assets,
  };
}
