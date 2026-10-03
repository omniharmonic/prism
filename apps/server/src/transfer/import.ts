/**
 * Import engine (wave 3A, NP-TX-05): Markdown / HTML / CSV files and Notion
 * export ZIPs → vault pages. The pure planner lives in `@prism/core/import-export`
 * (`planImport`); this module is the I/O around it.
 *
 * UPLOAD HANDLING (hostile input)
 *  - A ZIP is read by `readZipDirectory` with hard limits (entries, per-entry and
 *    total declared size) BEFORE anything is inflated, refuses ZIP64 / encrypted
 *    / overlapping entries, and every entry inflates to exactly its declared size
 *    (zlib `maxOutputLength`) with its CRC checked. Nothing is written to disk:
 *    archive names only ever become VAULT paths, rebuilt segment by segment.
 *  - One level of nesting is unpacked, and only for Notion's wrapper (an archive
 *    whose members are all `.zip` parts); inner archives share the total budget.
 *  - HTML is converted to Markdown by turndown with script/style/frame elements
 *    removed; imported bodies are stored as Markdown.
 *
 * WHAT MAY BE WRITTEN
 *  - the destination root passes `placementRefusal` (clean path, not ingest-owned,
 *    not an exported/published/synced folder, not under a trashed page);
 *  - every planned path is re-checked (`normalizePagePath` identity,
 *    `isProtectedPath`, `exportedLocation`, not under a trashed page);
 *  - tags go through `canonicalTag` and are DROPPED when reserved, protected,
 *    published or named by any grant (an import must not share or publish a page
 *    as a side effect); metadata keys must be plain property keys — never
 *    `prism_*`, `gov_*`, an ingest key or a scheduler/renderer key;
 *  - a path already held by a note this import did not create is a `conflict`
 *    and is never overwritten; creates use `if_exists: "error"`, updates CAS.
 *
 * IDEMPOTENT. Every imported note carries `metadata.prism_import = {v, src,
 * hash, body, at}`: `src` identifies the source file inside the upload, `hash`
 * what it was written from, `body` the content as written. Re-running the same
 * upload finds each note by path + `src`: same `hash` → unchanged; different
 * `hash` → updated only if the stored content still equals `body` (nobody edited
 * it since), else reported as a conflict. A note whose first write succeeded but
 * whose attachments did not (no `hash` yet) is completed on the next run.
 *
 * IMAGES AND FILES referenced by a page become attachments of that page through
 * the same vault storage + `prism_attachments` index as an editor upload (magic
 * byte sniffing, blocked active content, size limits, per-note and per-vault
 * quotas); the content is then rewritten to `/api/attachments/<id>`.
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import TurndownService from "turndown";
import { isProtectedPath, isUnder, normalizePagePath, protectionReason, TRASH_TAG } from "@prism/core/pages";
import { isFieldKey, isSystemKey } from "@prism/core/database";
import {
  ASSET_TOKEN,
  ZipError,
  looksLikeZip,
  planImport,
  readZipDirectory,
  readZipEntry,
  safeZipName,
  stripNotionId,
  type ImportFile,
  type ImportItem,
  type ImportPlan,
  type ImportPreview,
  type PlannedNote,
  type ZipLimits,
} from "@prism/core/import-export";
import type { VaultEntry } from "../config";
import { grantsForResource } from "../db";
import { vaultClient, VaultConflictError, VaultError, type Note } from "../parachute";
import { canonicalTag } from "../tags";
import { exportedLocation, pathKey, placementRefusal, publishedTag, type PlacementRefusal } from "../pages";
import { INGEST_KEYS } from "../ingest-keys";
import { isReservedMetaKey, isReservedTag } from "../worker/sync-reserved";
import { stampMetadata } from "../writer-stamp";
import { treeUpsertNote } from "../tree";
import { insertAttachment, newAttachmentId, recordOrphan, sanitizeName, usedBytes, vaultAttach, vaultUpload } from "../attachments";
import { ATTACHMENT_EXT, hasBlockedExtension, IMAGE_TYPES, looksActive, sniffAttachment, type AttachmentType } from "../media/sniff-file";
import { envInt, finishJob, type Job } from "./jobs";
import type { UserActor } from "./export";

export const importConfig = () => ({
  maxBytes: envInt("IMPORT_MAX_BYTES", 100 * 1024 * 1024, 1024),
  maxEntries: envInt("IMPORT_MAX_ENTRIES", 20_000, 1),
  maxEntryBytes: envInt("IMPORT_MAX_ENTRY_BYTES", 25 * 1024 * 1024, 1024),
  maxTotalBytes: envInt("IMPORT_MAX_TOTAL_BYTES", 300 * 1024 * 1024, 1024),
  maxNotes: envInt("IMPORT_MAX_NOTES", 5000, 1),
  maxTextBytes: envInt("IMPORT_MAX_TEXT_BYTES", 1_500_000, 1024),
  maxDepth: envInt("IMPORT_MAX_DEPTH", 16, 1),
  paceMs: envInt("IMPORT_PACE_MS", 10),
  // The attachment pipeline's own limits (routes/attachments.ts reads the same variables).
  maxImageBytes: envInt("ATTACHMENT_IMAGE_MAX_BYTES", 10 * 1024 * 1024, 1024),
  maxFileBytes: envInt("ATTACHMENT_MAX_BYTES", 25 * 1024 * 1024, 1024),
  noteQuotaBytes: envInt("ATTACHMENT_NOTE_QUOTA_BYTES", 250 * 1024 * 1024, 1024),
  vaultQuotaBytes: envInt("ATTACHMENT_VAULT_QUOTA_BYTES", 5 * 1024 * 1024 * 1024, 1024),
});

export class ImportError extends Error {
  constructor(public readonly status: 400 | 413 | 415, public readonly code: string, message: string) {
    super(message);
  }
}

export const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

const inflate = (data: Uint8Array, maxOut: number): Uint8Array => inflateRawSync(data, { maxOutputLength: Math.max(maxOut, 1) });

// ── reading the upload ──────────────────────────────────────────────────────

const SINGLE_EXT = new Set(["md", "markdown", "html", "htm", "csv"]);

/** The members of an upload as lazily-read files, plus entries that were refused. */
export function readUpload(bytes: Uint8Array, fileName: string): { files: ImportFile[]; refused: Array<{ entry: string; reason: string }>; archiveName: string } {
  const cfg = importConfig();
  const refused: Array<{ entry: string; reason: string }> = [];
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
  const collect = (buf: Uint8Array, lim: ZipLimits, prefix: string) => {
    const entries = readZipDirectory(buf, lim);
    for (const e of entries) {
      if (e.directory) continue;
      if (e.unsafe) {
        if (refused.length < 100) refused.push({ entry: `${prefix}${e.name}`.slice(0, 200), reason: `ignored: ${e.unsafe}` });
        continue;
      }
      total += e.size;
      if (total > cfg.maxTotalBytes) throw new ZipError("too_large", "the archive is too large when unpacked");
      if (files.length >= cfg.maxEntries) throw new ZipError("too_many_entries", "the archive has too many files");
      const key = e.name.toLowerCase();
      if (seen.has(key)) {
        if (refused.length < 100) refused.push({ entry: e.name.slice(0, 200), reason: "ignored: duplicate name" });
        continue;
      }
      seen.add(key);
      files.push({ name: e.name, size: e.size, read: () => readZipEntry(buf, e, inflate) });
    }
    return entries;
  };
  try {
    // Notion's wrapper: an archive whose only members are `…-Part-N.zip`. Unpack ONE level.
    const outer = readZipDirectory(bytes, { ...limits, maxEntryBytes: Math.max(cfg.maxEntryBytes, cfg.maxBytes) });
    const members = outer.filter((e) => !e.directory && !e.unsafe);
    const wrapper = members.length > 0 && members.length <= 20 && members.every((e) => e.name.toLowerCase().endsWith(".zip") && !e.name.includes("/"));
    if (wrapper) {
      for (const e of members) {
        const inner = readZipEntry(bytes, e, inflate);
        if (!looksLikeZip(inner)) throw new ZipError("corrupt", "a part of the archive is not a zip file");
        collect(inner, { ...limits, maxTotalBytes: Math.max(cfg.maxTotalBytes - total, 0) }, `${e.name}/`);
      }
    } else collect(bytes, limits, "");
  } catch (e) {
    if (e instanceof ZipError) {
      const status = e.code === "too_large" || e.code === "too_many_entries" ? 413 : 400;
      throw new ImportError(status, e.code, e.message);
    }
    throw e;
  }
  return { files, refused, archiveName: stem };
}

// ── planning ────────────────────────────────────────────────────────────────

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "template", "title", "iframe", "object", "embed", "form", "button", "input", "select", "textarea", "frame", "frameset", "applet", "link", "meta", "base"] as never);

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

const TOMBSTONE_TAGS = new Set(["merged-stub", "superseded", "bot", "non-human"]);

/** May an import apply this tag in this vault? Returns the canonical tag or null. */
export function importTagAllowed(vaultId: string, raw: string): string | null {
  const tag = canonicalTag(raw);
  if (!tag || tag.length > 128) return null;
  for (let i = 0; i < tag.length; i++) if (tag.charCodeAt(i) < 0x20) return null;
  if (tag === TRASH_TAG || isReservedTag(tag) || TOMBSTONE_TAGS.has(tag.toLowerCase())) return null;
  if (protectionReason({ tags: [tag] })) return null;
  // A tag someone shares or publishes from: an import must not hand pages to other people.
  if (publishedTag(vaultId, tag) || grantsForResource("tag", tag, vaultId).length > 0) return null;
  return tag;
}

export const importKeyAllowed = (key: string): boolean =>
  isFieldKey(key) && !isSystemKey(key) && !isReservedMetaKey(key) && !INGEST_KEYS.has(key) && key !== "source";

export function buildPlan(entry: VaultEntry, files: ImportFile[], root: string): ImportPlan {
  const cfg = importConfig();
  return planImport(files, {
    root,
    limits: { maxNotes: cfg.maxNotes, maxTextBytes: cfg.maxTextBytes, maxAssetBytes: cfg.maxFileBytes, maxDepth: cfg.maxDepth },
    htmlToMarkdown: (html) => turndown.turndown(htmlBody(html)),
    allowTag: (t) => importTagAllowed(entry.id, t),
    allowKey: importKeyAllowed,
    hash: sha,
  });
}

// ── resolving against the vault ─────────────────────────────────────────────

export interface Resolved {
  note: PlannedNote;
  action: ImportItem["action"];
  reason?: string;
  /** update / resume: the existing note and the revision the decision was made on. */
  holderId?: string;
  holderUpdatedAt?: string | null;
}

interface ImportStamp { v: 1; src: string; hash?: string; body?: string; at?: string }
const stampOf = (n: Pick<Note, "metadata">): ImportStamp | null => {
  const s = n.metadata?.prism_import as ImportStamp | undefined;
  return s && typeof s === "object" && typeof s.src === "string" ? s : null;
};

/** The destination root, validated; a refusal carries the HTTP answer. */
export async function resolveRoot(entry: VaultEntry, raw: unknown): Promise<{ root: string; existing: Note[] } | PlacementRefusal> {
  const root = normalizePagePath(raw);
  if (!root) return { status: 400, body: { error: "invalid_request", reason: "Choose a folder to import into." } };
  if (root.split("/").length > 12) return { status: 400, body: { error: "invalid_request", reason: "That folder is nested too deeply." } };
  let existing: Note[];
  try {
    // ONE lean listing of the destination: who holds which path, and what this import wrote before.
    existing = await vaultClient(entry.id, { timeoutMs: 30_000 }).listNotes({ pathPrefix: root, includeContent: false, includeMetadata: ["prism_import"] });
  } catch {
    return { status: 502, body: { error: "vault_unreachable" } };
  }
  const holder = existing.find((n) => !!n.path && pathKey(n.path) === pathKey(root) && !(n.tags ?? []).includes(TRASH_TAG));
  const placed = await placementRefusal(entry, root, { exceptId: holder?.id });
  if (!("path" in placed)) return placed;
  return { root: placed.path, existing };
}

export async function resolveActions(entry: VaultEntry, plan: ImportPlan, existing: Note[]): Promise<Resolved[]> {
  const vc = vaultClient(entry.id, { timeoutMs: 30_000 });
  const byPath = new Map<string, Note>();
  const trashed: string[] = [];
  for (const n of existing) {
    if (!n.path) continue;
    if ((n.tags ?? []).includes(TRASH_TAG)) trashed.push(pathKey(n.path));
    if (!byPath.has(pathKey(n.path)) || !(n.tags ?? []).includes(TRASH_TAG)) byPath.set(pathKey(n.path), n);
  }
  const out: Resolved[] = [];
  const planned = new Set<string>();
  for (const note of plan.notes) {
    const key = pathKey(note.path);
    const conflict = (reason: string) => out.push({ note, action: "conflict", reason });
    if (normalizePagePath(note.path) !== note.path) { conflict("the name cannot be used as a page path"); continue; }
    if (isProtectedPath(note.path)) { conflict("that location is kept in sync by an integration"); continue; }
    if (exportedLocation(entry.id, note.path)) { conflict("that folder is published or synced elsewhere"); continue; }
    if (trashed.some((t) => key === t || isUnder(key, t))) { conflict("that location is in the Trash"); continue; }
    if (planned.has(key)) { conflict("another imported page has the same name"); continue; }
    planned.add(key);
    const holder = byPath.get(key);
    if (!holder) { out.push({ note, action: "create" }); continue; }
    const stamp = stampOf(holder);
    if (!stamp || stamp.src !== note.src) { conflict("a page already exists here"); continue; }
    if (stamp.hash === note.hash) { out.push({ note, action: "unchanged", holderId: holder.id }); continue; }
    if (!stamp.body) {
      // Its first write landed but the import never finished it (attachments): complete it.
      out.push({ note, action: "update", holderId: holder.id, holderUpdatedAt: holder.updatedAt ?? null });
      continue;
    }
    // Changed in the source (or left incomplete): only replace a body nobody has edited since the last import.
    let full: Note;
    try {
      full = await vc.getNote(holder.id);
    } catch {
      conflict("could not be read");
      continue;
    }
    if (full.id !== holder.id || sha(full.content ?? "") !== stamp.body) conflict("edited since it was imported");
    else out.push({ note, action: "update", holderId: holder.id, holderUpdatedAt: full.updatedAt ?? null });
  }
  return out;
}

export function previewOf(plan: ImportPlan, resolved: Resolved[], extraProblems: Array<{ entry: string; reason: string }>): ImportPreview {
  const count = (a: ImportItem["action"]) => resolved.filter((r) => r.action === a).length;
  return {
    dryRun: true,
    destination: plan.root,
    summary: {
      pages: plan.counts.pages,
      databases: plan.counts.databases,
      rows: plan.counts.rows,
      attachments: plan.counts.assets,
      links: plan.counts.links,
      create: count("create"),
      update: count("update"),
      unchanged: count("unchanged"),
      conflict: count("conflict"),
      ignored: plan.counts.ignored,
    },
    items: resolved.slice(0, 100).map((r) => ({ path: r.note.path, kind: r.note.kind, action: r.action, ...(r.reason ? { reason: r.reason } : {}) })),
    problems: [...extraProblems, ...plan.problems].slice(0, 100),
  };
}

// ── writing ─────────────────────────────────────────────────────────────────

export interface ImportProgress {
  destination: string;
  done: number;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  attachments: number;
  failed: Array<{ path: string; reason: string }>;
  problems: Array<{ entry: string; reason: string }>;
  firstId: string | null;
}

/** Store one referenced file as an attachment of `noteId`; the URL, or why not. */
async function attach(entry: VaultEntry, noteId: string, file: ImportFile, image: boolean, createdBy: string): Promise<{ url: string } | { error: string }> {
  const cfg = importConfig();
  const limit = image ? cfg.maxImageBytes : cfg.maxFileBytes;
  if (file.size === 0) return { error: "empty file" };
  if (file.size > limit) return { error: "too large" };
  if (usedBytes(entry.id, noteId) + file.size > cfg.noteQuotaBytes) return { error: "this page's attachment quota is full" };
  if (usedBytes(entry.id) + file.size > cfg.vaultQuotaBytes) return { error: "the workspace's attachment quota is full" };
  let bytes: Uint8Array;
  try {
    bytes = file.read();
  } catch {
    return { error: "could not be unpacked" };
  }
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 64 * 1024));
  const sniffed = sniffAttachment(head);
  let mime: AttachmentType;
  if (image) {
    if (!sniffed || !IMAGE_TYPES.has(sniffed)) return { error: "not a supported image (PNG, JPEG, GIF, WebP, AVIF)" };
    mime = sniffed;
  } else {
    if (hasBlockedExtension(file.name) || (!sniffed && looksActive(head))) return { error: "active content is not imported" };
    mime = sniffed ?? "application/octet-stream";
  }
  const leaf = file.name.slice(file.name.lastIndexOf("/") + 1);
  const dot = leaf.lastIndexOf(".");
  const name = sanitizeName(dot > 0 ? `${stripNotionId(leaf.slice(0, dot))}${leaf.slice(dot)}` : leaf);
  const id = newAttachmentId();
  const row = { id, vault_id: entry.id, note_id: noteId, storage_path: "", mime, size: bytes.byteLength, name, created_by: createdBy, created_at: new Date().toISOString() };
  try {
    const up = await vaultUpload(entry.id, new Blob([bytes as BlobPart]), `upload.${ATTACHMENT_EXT[mime]}`);
    row.storage_path = up.path;
  } catch {
    return { error: "could not be stored" };
  }
  try {
    const att = await vaultAttach(entry.id, noteId, row.storage_path, mime);
    insertAttachment({ ...row, vault_attachment_id: att.id || null });
  } catch {
    try { recordOrphan(row); } catch { /* best-effort */ }
    return { error: "could not be stored" };
  }
  return { url: `/api/attachments/${id}` };
}

const tokenRe = (i: number) => `${ASSET_TOKEN}${i}`;
/** Content with every asset token replaced (by the attachment URL, or the original target). */
function withAssets(note: PlannedNote, urls: Map<string, string>): string {
  let content = note.content;
  // Highest index first so `…:1` never eats the head of `…:10`.
  for (let i = note.assets.length - 1; i >= 0; i--) {
    const a = note.assets[i]!;
    content = content.split(`(${tokenRe(i)})`).join(`(${urls.get(a.token) ?? a.original})`);
  }
  return content;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runImport(
  job: Job<ImportProgress>,
  entry: VaultEntry,
  actor: UserActor,
  plan: ImportPlan,
  resolved: Resolved[],
  hooks: { onWrite?: () => void; onEnd?: (job: Job<ImportProgress>) => void } = {},
): Promise<void> {
  const cfg = importConfig();
  const p = job.progress;
  const vc = vaultClient(entry.id, { timeoutMs: 60_000 });
  const createdBy = `u:${actor.email.toLowerCase()}`;
  const fail = (path: string, reason: string) => {
    if (p.failed.length < 200) p.failed.push({ path, reason });
  };
  job.state = "running";
  try {
    let next = 0;
    let consecutive = 0;
    const work = async () => {
      while (next < resolved.length && !job.cancelled && consecutive < 10) {
        const r = resolved[next++]!;
        const { note } = r;
        try {
          if (r.action === "unchanged") p.unchanged++;
          else if (r.action === "conflict") p.conflicts++;
          else {
            const base = { v: 1 as const, src: note.src };
            let id = r.holderId;
            let updatedAt = r.holderUpdatedAt ?? undefined;
            const plain = withAssets(note, new Map());
            if (r.action === "create") {
              const done = note.assets.length === 0;
              const created = await vc.createNote({
                content: plain,
                path: note.path,
                tags: note.tags,
                metadata: stampMetadata({ ...note.metadata, prism_import: done ? { ...base, hash: note.hash, body: sha(plain), at: new Date().toISOString() } : base }, actor),
                ifExists: "error",
              });
              treeUpsertNote(entry, created);
              id = created.id;
              updatedAt = created.updatedAt ?? undefined;
              p.created++;
              if (!p.firstId) p.firstId = created.id;
            }
            if (r.action === "update" || note.assets.length) {
              const urls = new Map<string, string>();
              for (const a of note.assets) {
                const file = plan.assets.get(a.file);
                const res = file ? await attach(entry, id!, file, a.image, createdBy) : { error: "missing from the upload" };
                if ("url" in res) {
                  urls.set(a.token, res.url);
                  p.attachments++;
                } else if (p.problems.length < 200) p.problems.push({ entry: a.file, reason: `not attached: ${res.error}` });
              }
              const content = withAssets(note, urls);
              const complete = urls.size === note.assets.length;
              const updated = await vc.updateNote(id!, {
                content,
                // The vault MERGES nested metadata: send the whole stamp. An import whose
                // attachments did not all land keeps no `hash`, so the next run completes it.
                metadata: stampMetadata({ ...(r.action === "update" ? note.metadata : {}), prism_import: { ...base, hash: complete ? note.hash : null, body: sha(content), at: new Date().toISOString() } }, actor),
                ...(r.action === "update" && note.tags.length ? { tags: { add: note.tags } } : {}),
                ifUpdatedAt: updatedAt ?? "",
              });
              treeUpsertNote(entry, updated);
              if (r.action === "update") p.updated++;
              if (!p.firstId) p.firstId = updated.id;
            }
            hooks.onWrite?.();
            consecutive = 0;
          }
        } catch (e) {
          consecutive++;
          fail(note.path, e instanceof VaultConflictError ? "changed or taken since the preview; run the import again" : e instanceof VaultError ? `vault HTTP ${e.status}` : "not written");
        }
        p.done++;
        if (cfg.paceMs) await sleep(cfg.paceMs);
      }
    };
    await Promise.all([work(), work()]);
    if (job.cancelled) finishJob(job, "cancelled", 10 * 60_000);
    else if (consecutive >= 10) finishJob(job, "error", 10 * 60_000, "stopped after repeated failures");
    else finishJob(job, "done", 10 * 60_000);
  } catch (e) {
    console.warn(`[import] failed: ${(e as Error).message}`);
    finishJob(job, "error", 10 * 60_000, "failed");
  }
  console.log(`[import] vault ${entry.id}: +${p.created} ~${p.updated} =${p.unchanged} conflicts ${p.conflicts} failed ${p.failed.length} attachments ${p.attachments} (${job.state})`);
  try {
    hooks.onEnd?.(job);
  } catch {
    /* audit is best-effort */
  }
}
