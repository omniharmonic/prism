/**
 * Export engine (wave 3A, NP-TX-03 / NP-TX-04): a page with its sub-pages, or the
 * whole vault, as a ZIP of Markdown (front-matter properties) or HTML files with
 * the images and files the pages reference.
 *
 * WHAT GOES IN — the caller's own view, nothing else:
 *  - the candidate list is the tree projection filtered by `effectiveCaps(...)
 *    .has("view")` for the CALLER (admins and owners included — another member's
 *    private note is not exported by anyone but its creator), trashed excluded;
 *  - each note is then read by id and checked AGAIN on the fresh note (id must
 *    match, still viewable, not trashed) before a byte of it is written;
 *  - the caller's role + grants are re-read every `REFRESH_EVERY` notes, so a
 *    grant revoked during a long vault export stops applying;
 *  - an attachment is included only when its index row belongs to this vault
 *    and its OWNING note passes the same view check; otherwise the link is left
 *    as it was and nothing is said about it;
 *  - identity keys and every `prism_*` / `gov_*` / `_*` key are left out of the
 *    front matter; a note that fails or is too large is counted in `skipped`
 *    (never a note the caller could not see).
 *
 * HOW — the ZIP is written incrementally to a 0600 temp file in a 0700
 * directory (never held whole in memory), bounded by `EXPORT_MAX_NOTES` /
 * `EXPORT_MAX_BYTES` / the classic-ZIP limits, and streamed to the caller by
 * the download route. Vault reads are per note, two at a time, with a small
 * pause — a full listing with content would stall the single-threaded vault.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { isTrashed, isUnder, parentOf, TRASH_TAG } from "@prism/core/pages";
import { ZipWriter, ZIP_MAX_ENTRIES, attachmentIdsIn, htmlDepth, htmlToText, renderFrontMatter, replaceAllLiteral, safeFileSegment, type ExportFormat, type ExportScope } from "@prism/core/import-export";
import { CsvError, csvCell, parseCsv } from "@prism/core/database";
import { TaskWorker } from "./worker-pool";
import type { VaultEntry } from "../config";
import type { Actor } from "../auth/actor";
import { grantsForUser } from "../db";
import { vaultClient, type Note } from "../parachute";
import { effectiveCaps, type NoteRef } from "../permissions";
import { roleFloor, workspaceRole } from "../roles";
import { ensureTree, rowRef, warmPageAnchors, type TreeRow } from "../tree";
import { noteKind } from "../collab";
import { getAttachment, vaultStorageFetch } from "../attachments";
import { ATTACHMENT_EXT, type AttachmentType } from "../media/sniff-file";
import { IDENTITY_KEYS } from "../identity-keys";
import { envInt, finishJob, type Job } from "./jobs";

export type UserActor = Extract<Actor, { kind: "user" }>;

export interface ExportProgress {
  scope: ExportScope;
  format: ExportFormat;
  /** Page scope: the exported page (re-checked at download). */
  rootId?: string;
  done: number;
  total: number;
  attachments: number;
  skipped: number;
  bytes: number;
  fileName: string | null;
  /** The temp file (never sent to a client). */
  filePath: string | null;
}

export interface ExportSpec {
  entry: VaultEntry;
  actor: UserActor;
  scope: ExportScope;
  rootId?: string;
  format: ExportFormat;
  subpages: boolean;
  attachments: boolean;
}

export const exportConfig = () => ({
  maxNotes: envInt("EXPORT_MAX_NOTES", 50_000, 1),
  maxBytes: Math.min(envInt("EXPORT_MAX_BYTES", 2 * 1024 * 1024 * 1024, 1024), 0xf0000000),
  maxNoteBytes: envInt("EXPORT_MAX_NOTE_BYTES", 4 * 1024 * 1024, 1024),
  maxAttachmentBytes: envInt("EXPORT_MAX_ATTACHMENT_BYTES", 30 * 1024 * 1024, 1024),
  ttlMs: envInt("EXPORT_TTL_MS", 15 * 60_000, 1000),
  /** Everything the finished archives may occupy on disk at once (all accounts). */
  diskBudgetBytes: envInt("EXPORT_DISK_BUDGET_BYTES", 4 * 1024 * 1024 * 1024, 1024),
  /** Conversion (Markdown parser / HTML→Markdown) runs in a worker thread: wall clock per page, input cap, nesting cap. */
  convertTimeoutMs: envInt("EXPORT_CONVERT_TIMEOUT_MS", 4000, 50),
  convertMaxBytes: envInt("EXPORT_CONVERT_MAX_BYTES", 1024 * 1024, 1024),
  convertMaxDepth: envInt("EXPORT_CONVERT_MAX_DEPTH", 100, 4),
  paceMs: envInt("EXPORT_PACE_MS", 10),
});

const REFRESH_EVERY = 200;
const MARKDOWN_PARSE_MAX = 200_000;

/** The ONE thread that runs the Markdown parser and the HTML→Markdown converter for exports. */
const converter = new TaskWorker(512, 256);
export const stopExportWorker = (): Promise<void> => converter.stop();

/** Bytes the finished/in-progress archives occupy in the export directory. */
export function exportDiskBytes(): number {
  let total = 0;
  try {
    const dir = exportDir();
    for (const name of readdirSync(dir)) if (FILE_RE.test(name)) total += statSync(join(dir, name)).size;
  } catch {
    /* unreadable = unknown = 0 */
  }
  return total;
}
const CONCURRENCY = 2;
const STORAGE_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const FILE_RE = /^\d+-[A-Za-z0-9_-]{22}\.zip$/;

const ref = (n: Pick<Note, "id" | "tags" | "metadata"> & { path?: string | null }): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
  path: n.path ?? null,
});
/** The view check for a signed-in account — the SAME math for every role (private-note rule included). */
export const canView = (actor: UserActor, note: NoteRef): boolean => effectiveCaps(actor.grants, note, roleFloor(actor.role), actor.email).has("view");
/** The account as the vault sees it NOW (role + grants re-read). */
export const freshActor = (actor: UserActor, vaultId: string): UserActor => ({ ...actor, vaultId, role: workspaceRole(actor.email, vaultId), grants: grantsForUser(actor.email, vaultId) });

// ── temp directory ──────────────────────────────────────────────────────────

let dirReady: string | null = null;
/** A private directory for export archives; stale files of dead/old runs are removed on first use. */
export function exportDir(): string {
  if (dirReady && existsSync(dirReady)) return dirReady;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const dir = process.env.EXPORT_DIR || join(tmpdir(), `prism-export-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("export directory is not a directory");
  if (typeof process.getuid === "function" && st.uid !== uid) throw new Error("export directory is owned by another user");
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  const dayAgo = Date.now() - 24 * 3600_000;
  for (const name of readdirSync(dir)) {
    if (!FILE_RE.test(name)) continue;
    const p = join(dir, name);
    try {
      if (name.startsWith(`${process.pid}-`) || statSync(p).mtimeMs < dayAgo) rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  }
  dirReady = dir;
  return dir;
}

// ── content ─────────────────────────────────────────────────────────────────

const looksLikeHtml = (s: string): boolean => {
  const t = s.trimStart();
  if (!t.startsWith("<") || t.length < 3) return false;
  const c = t.charCodeAt(1) | 0x20;
  return c >= 97 && c <= 122;
};
const escapeHtml = (s: string): string => s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");

const HTML_STYLE =
  "body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f1f1f;background:#fff;max-width:760px;margin:40px auto;padding:0 24px}" +
  "img,video{max-width:100%;height:auto}pre{background:#f5f5f4;padding:12px 14px;border-radius:6px;overflow:auto}code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}" +
  "blockquote{border-left:3px solid #d6d3d1;margin-left:0;padding-left:16px;color:#57534e}table{border-collapse:collapse}td,th{border:1px solid #d6d3d1;padding:6px 10px}h1{font-size:2em;line-height:1.2}";

/** A standalone HTML file. The CSP meta means a script in a page's stored HTML cannot run when the file is opened. */
function htmlShell(title: string, body: string): string {
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${HTML_STYLE}</style></head>\n` +
    `<body>\n<h1>${escapeHtml(title)}</h1>\n${body}\n</body></html>\n`
  );
}

const SYSTEM_KEY = (k: string): boolean => k.startsWith("prism_") || k.startsWith("gov_") || k.startsWith("_") || (IDENTITY_KEYS as readonly string[]).includes(k);

/** Properties as front matter: the page's own metadata minus system and identity keys. */
export function frontMatterFor(note: Note, title: string): Record<string, unknown> {
  const out: Record<string, unknown> = { title };
  const tags = (note.tags ?? []).filter((t) => t !== TRASH_TAG);
  if (tags.length) out.tags = tags;
  if (note.createdAt) out.created = note.createdAt;
  if (note.updatedAt) out.updated = note.updatedAt;
  for (const [k, v] of Object.entries(note.metadata ?? {})) {
    if (k === "title" || k === "tags" || k === "created" || k === "updated" || SYSTEM_KEY(k) || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

const leaf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
function codeExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 11) return null;
  const ext = name.slice(dot + 1);
  for (let i = 0; i < ext.length; i++) {
    const c = ext.charCodeAt(i) | 0x20;
    if (!((c >= 97 && c <= 122) || (ext.charCodeAt(i) >= 48 && ext.charCodeAt(i) <= 57))) return null;
  }
  return ext.toLowerCase();
}

/**
 * Raw kinds keep an extension only from this list (source and data files that
 * nothing runs on a double-click); anything else — `.html`, `.svg`, `.js`,
 * `.bat`, `.command`, no extension — gets `.txt` appended.
 */
const RAW_EXT = new Set(["ts", "tsx", "jsx", "py", "rs", "go", "java", "rb", "c", "cpp", "h", "css", "scss", "json", "yaml", "yml", "toml", "sql", "md", "txt", "csv", "excalidraw"]);

/** `-12`, `3.5`, `1e3`-free plain decimals: left as they are (a number is not a formula). Linear. */
function plainNumber(cell: string): boolean {
  if (!cell || cell.length > 32) return false;
  let digits = 0;
  let dots = 0;
  for (let i = 0; i < cell.length; i++) {
    const c = cell.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if (c === 46) dots++;
    else if (!(c === 45 && i === 0)) return false;
  }
  return digits > 0 && dots <= 1;
}

interface Rendered { name: string; text: string; asText?: boolean }

/** The archive leaf for a raw note: its own name when the extension is allowlisted, else `<name>.txt`. */
function rawName(leafName: string, fallbackExt: string): string {
  const ext = codeExtension(leafName);
  if (ext && RAW_EXT.has(ext)) return leafName;
  return `${leafName}.${RAW_EXT.has(fallbackExt) && !ext ? fallbackExt : "txt"}`;
}

/**
 * One note as a file body. The Markdown parser and the HTML→Markdown converter
 * NEVER run on this thread: both go to the worker with a wall-clock limit, after
 * an input cap and a linear nesting check; a page that cannot be converted is
 * exported as plain text (`asText`), never dropped and never retried.
 */
async function render(note: Note, title: string, leafName: string, format: ExportFormat): Promise<Rendered> {
  const cfg = exportConfig();
  const kind = noteKind({ path: note.path ?? null, tags: note.tags ?? null, metadata: note.metadata ?? null, content: note.content });
  const content = note.content ?? "";
  if (kind === "spreadsheet") {
    // Formula guard (the same one the database CSV export applies): a cell from someone
    // else's page must not run as a formula when the file is opened in a spreadsheet.
    try {
      const rows = parseCsv(content, { maxRows: 200_000, maxCols: 2000, maxCell: 200_000 });
      const base = leafName.toLowerCase().endsWith(".csv") ? leafName.slice(0, -4) : leafName;
      return { name: `${base}.csv`, text: rows.map((r) => r.map((cell) => (plainNumber(cell) ? cell : csvCell(cell))).join(",")).join("\r\n") + "\r\n" };
    } catch (e) {
      if (!(e instanceof CsvError)) throw e;
      return { name: `${leafName}.txt`, text: content, asText: true };
    }
  }
  if (kind === "canvas") return { name: rawName(leafName.toLowerCase().endsWith(".excalidraw") ? leafName : `${leafName}.excalidraw`, "excalidraw"), text: content };
  if (kind === "code") return { name: rawName(leafName, "txt"), text: content };
  const isHtml = looksLikeHtml(content);
  const convertible = content.length <= cfg.convertMaxBytes && (!isHtml || htmlDepth(content) <= cfg.convertMaxDepth);
  if (format === "html") {
    let body: string | null = null;
    if (convertible && (isHtml || content.length <= MARKDOWN_PARSE_MAX)) {
      body = await converter.run<string>({ op: "to-html", content, isHtml }, cfg.convertTimeoutMs).catch(() => null);
    }
    if (body === null) return { name: `${leafName}.html`, text: htmlShell(title, `<pre>${escapeHtml(isHtml ? htmlToText(content) : content)}</pre>`), asText: true };
    return { name: `${leafName}.html`, text: htmlShell(title, body) };
  }
  let md: string | null = content;
  if (isHtml) md = convertible ? await converter.run<string>({ op: "to-markdown", html: content }, cfg.convertTimeoutMs).catch(() => null) : null;
  const head = `${renderFrontMatter(frontMatterFor(note, title))}# ${title.split("\n").join(" ")}\n\n`;
  if (md === null) return { name: `${leafName}.md`, text: `${head}${htmlToText(content).trimEnd()}\n`, asText: true };
  return { name: `${leafName}.md`, text: `${head}${md.trimEnd()}\n` };
}

/** URL-encode one relative path for a Markdown/HTML link. */
const encodePath = (p: string): string => p.split("/").map((s) => encodeURIComponent(s).split("(").join("%28").split(")").join("%29")).join("/");

// ── the job ─────────────────────────────────────────────────────────────────

/** The notes this export covers for this caller, sorted by path; null = the root is not viewable/exists. */
export async function exportCandidates(spec: ExportSpec): Promise<TreeRow[] | null> {
  await warmPageAnchors(spec.actor.grants);
  const tree = await ensureTree(spec.entry);
  const visible = tree.rows().filter((r) => !r.tags.includes(TRASH_TAG) && !r.trashedAt && canView(spec.actor, rowRef(r)));
  let rows = visible;
  if (spec.scope === "page") {
    const root = visible.find((r) => r.id === spec.rootId);
    if (!root) return null;
    rows = spec.subpages && root.path ? [root, ...visible.filter((r) => r.id !== root.id && isUnder(r.path, root.path!))] : [root];
  }
  return rows.sort((a, b) => ((a.path ?? `￿${a.id}`) < (b.path ?? `￿${b.id}`) ? -1 : 1));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runExport(job: Job<ExportProgress>, spec: ExportSpec, rows: TreeRow[]): Promise<void> {
  const cfg = exportConfig();
  const p = job.progress;
  let fd: number | null = null;
  let filePath: string | null = null;
  const fail = (reason: string) => {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
      fd = null;
    }
    if (filePath) rmSync(filePath, { force: true });
    p.filePath = null;
    finishJob(job, job.cancelled ? "cancelled" : "error", 60_000, job.cancelled ? null : reason);
  };
  try {
    job.state = "running";
    filePath = join(exportDir(), `${process.pid}-${job.id}.zip`);
    fd = openSync(filePath, "wx", 0o600);
    p.filePath = filePath;
    job.dispose = () => {
      if (filePath) rmSync(filePath, { force: true });
    };
    const zip = new ZipWriter();
    // What this archive may grow to: its own cap, and what is left of the shared disk budget.
    const room = Math.min(cfg.maxBytes, Math.max(cfg.diskBudgetBytes - exportDiskBytes(), 0));
    const write = (name: string, data: Uint8Array, compress: boolean) => {
      if (zip.count + 1 > ZIP_MAX_ENTRIES - 1) throw new ExportLimit("too_many_files");
      if (zip.bytes + data.length + 4096 > room) throw new ExportLimit("too_large");
      const chunk = zip.add(name, data, compress ? { deflate: (d) => deflateRawSync(d) } : {});
      writeSync(fd!, chunk);
      p.bytes = zip.bytes;
    };

    // Archive names: relative to the exported page's parent (page scope) or the vault root.
    const root = spec.scope === "page" ? rows.find((r) => r.id === spec.rootId) : undefined;
    const base = root?.path ? parentOf(root.path) : "";
    const relDir = (path: string | null, id: string): string[] => {
      if (!path) return ["_unfiled", id];
      const rel = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
      const segs = rel.split("/").filter(Boolean).map((s) => safeFileSegment(s));
      // The archive's own names are reserved: a page called `_attachments` or `_export.json`
      // is written beside them under another name.
      const first = (segs[0] ?? "").toLowerCase();
      if (first === "_attachments" || first === "_unfiled" || (segs.length === 1 && first.startsWith("_export"))) segs[0] = `_${segs[0]}`;
      return segs;
    };
    /** `dir/leaf` (leaf = name with its extension), made unique by a ` (n)` before the extension. */
    const uniqueName = (dirSegs: string[], leafName: string): string => {
      const dir = dirSegs.join("/");
      const dot = leafName.lastIndexOf(".");
      const stem = dot > 0 ? leafName.slice(0, dot) : leafName;
      const ext = dot > 0 ? leafName.slice(dot) : "";
      for (let i = 1; ; i++) {
        const name = `${dir ? `${dir}/` : ""}${i === 1 ? stem : `${stem} (${i})`}${ext}`;
        if (!zip.has(name)) return name;
      }
    };
    const asText: string[] = [];

    let actor = spec.actor;
    const vc = vaultClient(spec.entry.id, { timeoutMs: 30_000 });
    const treeById = new Map(rows.map((r) => [r.id, r]));
    // Attachments already written: id → archive path; and the per-note view verdict of OTHER owners.
    const written = new Map<string, string>();
    const ownerViewable = new Map<string, boolean>();
    let allRows: Map<string, TreeRow> | null = null;
    const skippedNotes: Array<{ path: string; reason: string }> = [];
    const skip = (path: string | null, reason: string) => {
      p.skipped++;
      if (skippedNotes.length < 200) skippedNotes.push({ path: path ?? "(no path)", reason });
    };

    async function attachmentPath(id: string, note: Note): Promise<string | null> {
      const had = written.get(id);
      if (had) return had;
      const row = getAttachment(id);
      if (!row || row.vault_id !== spec.entry.id || !STORAGE_PATH.test(row.storage_path) || row.storage_path.includes("..")) return null;
      if (row.size > cfg.maxAttachmentBytes) return null;
      if (row.note_id !== note.id) {
        // Referenced from another page: its OWNING note must be viewable too.
        let ok = ownerViewable.get(row.note_id);
        if (ok === undefined) {
          if (!allRows) allRows = new Map((await ensureTree(spec.entry)).rows().map((r) => [r.id, r]));
          const owner = treeById.get(row.note_id) ?? allRows.get(row.note_id);
          ok = !!owner && !owner.tags.includes(TRASH_TAG) && !owner.trashedAt && canView(actor, rowRef(owner));
          ownerViewable.set(row.note_id, ok);
        }
        if (!ok) return null;
      }
      let bytes: Uint8Array;
      try {
        const res = await vaultStorageFetch(row.vault_id, row.storage_path, null);
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > cfg.maxAttachmentBytes) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > cfg.maxAttachmentBytes) return null;
      } catch {
        return null;
      }
      const ext = ATTACHMENT_EXT[row.mime as AttachmentType] ?? "bin";
      const dot = row.name.lastIndexOf(".");
      const stem = safeFileSegment(dot > 0 ? row.name.slice(0, dot) : row.name, 60);
      const name = `_attachments/${stem}-${id.slice(2, 10)}.${ext}`;
      write(name, bytes, false);
      written.set(id, name);
      p.attachments++;
      return name;
    }

    async function exportOne(row: TreeRow): Promise<void> {
      let note: Note;
      try {
        note = await vc.getNote(row.id);
      } catch {
        return skip(row.path, "could not be read");
      }
      // The fresh note decides — never the cached row. A failed check is SILENT:
      // the caller may have lost access since the list was made.
      if (note.id !== row.id || isTrashed(note) || !canView(actor, ref(note))) return;
      if (Buffer.byteLength(note.content ?? "") > cfg.maxNoteBytes) return skip(note.path ?? null, "too large");
      const segs = relDir(note.path ?? null, note.id);
      const title = (typeof note.metadata?.title === "string" && note.metadata.title.trim()) || (note.path ? leaf(note.path) : "Untitled");
      let out: Rendered;
      try {
        out = await render(note, title, segs[segs.length - 1]!, spec.format);
      } catch {
        return skip(note.path ?? null, "could not be converted");
      }
      if (out.asText && asText.length < 200) asText.push(note.path ?? note.id);
      let text = out.text;
      if (spec.attachments) {
        const ids = attachmentIdsIn(text);
        if (ids.length) {
          const depth = segs.length - 1;
          const map = new Map<string, string>();
          for (const id of ids.slice(0, 500)) {
            const path = await attachmentPath(id, note);
            if (path) map.set(`/api/attachments/${id}`, `${"../".repeat(depth)}${encodePath(path)}`);
          }
          text = replaceAllLiteral(text, map);
        }
      }
      // Named at write time (no await in between): two pages never race for one name.
      write(uniqueName(segs.slice(0, -1), out.name), Buffer.from(text, "utf8"), true);
    }

    let next = 0;
    let limit: ExportLimit | null = null;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, rows.length) || 1 }, async () => {
        while (next < rows.length && !job.cancelled && !limit) {
          const i = next++;
          if (i > 0 && i % REFRESH_EVERY === 0) {
            actor = freshActor(spec.actor, spec.entry.id);
            ownerViewable.clear();
            await warmPageAnchors(actor.grants);
          }
          try {
            await exportOne(rows[i]!);
          } catch (e) {
            if (e instanceof ExportLimit) limit = e;
            else skip(rows[i]!.path, "could not be exported");
          }
          p.done++;
          if (cfg.paceMs) await sleep(cfg.paceMs);
        }
      }),
    );
    if (job.cancelled) return fail("cancelled");
    if (limit) return fail((limit as ExportLimit).code);

    const manifest = {
      exportedAt: new Date().toISOString(),
      scope: spec.scope,
      format: spec.format,
      pages: zip.count - p.attachments,
      attachments: p.attachments,
      skipped: skippedNotes,
      /** Pages too large or too complex to convert: exported as plain text. */
      plainText: asText,
    };
    write("_export.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), true);
    writeSync(fd, zip.end());
    closeSync(fd);
    fd = null;
    p.bytes = statSync(filePath).size;
    const day = new Date().toISOString().slice(0, 10);
    p.fileName = spec.scope === "page" && root ? `${safeFileSegment(root.path ? leaf(root.path) : "page", 80)}.zip` : `${safeFileSegment(spec.entry.vault || "vault", 60)}-export-${day}.zip`;
    finishJob(job, "done", cfg.ttlMs);
    console.log(`[export] ${spec.scope} ${spec.format} (vault ${spec.entry.id}): ${manifest.pages} pages, ${p.attachments} attachments, ${p.skipped} skipped, ${p.bytes} bytes`);
  } catch (e) {
    console.warn(`[export] failed: ${e instanceof ExportLimit ? e.code : (e as Error).message}`);
    fail(e instanceof ExportLimit ? e.code : "failed");
  }
}

class ExportLimit extends Error {
  constructor(public readonly code: "too_large" | "too_many_files") {
    super(code);
  }
}
