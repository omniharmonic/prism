/**
 * Import engine (wave 3A, NP-TX-05): Markdown / HTML / CSV files and Notion
 * export ZIPs → vault pages. The pure planner lives in `@prism/core/import-export`
 * (`planImport`); this module is the I/O around it.
 *
 * WHERE THE WORK RUNS. Unzip, HTML conversion, hashing and planning are CPU work
 * whose cost the upload decides: they run in a worker thread (`import-plan.ts`
 * via `worker-pool.ts`) under a wall-clock budget, never on the event loop. This
 * module is the main-thread half: vault reads/writes and the database.
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
import { isProtectedPath, isUnder, normalizePagePath, TRASH_TAG } from "@prism/core/pages";
import { ASSET_TOKEN, type ImportFile, type ImportItem, type ImportPreview, type PlannedNote } from "@prism/core/import-export";
import type { VaultEntry } from "../config";
import { grantsForResource, listGrantsForVault, listPublications } from "../db";
import { vaultClient, VaultConflictError, VaultError, type Note } from "../parachute";
import { exportedLocation, pathKey, placementRefusal, publishedTag, type PlacementRefusal } from "../pages";
import { stampMetadata } from "../writer-stamp";
import { ensureTree, treeUpsertNote } from "../tree";
import { getAttachment, insertAttachment, newAttachmentId, recordOrphan, sanitizeName, usedBytes, vaultAttach, vaultUpload } from "../attachments";
import { ATTACHMENT_EXT, hasBlockedExtension, IMAGE_TYPES, looksActive, sniffAttachment, type AttachmentType } from "../media/sniff-file";
import { stripNotionId } from "@prism/core/import-export";
import { envInt, finishJob, type Job } from "./jobs";
import type { UserActor } from "./export";
import { ImportError, importKeyAllowed, sha, staticTagAllowed, type PlanLimits, type PlanRequest, type PlanResult } from "./import-plan";
import { TaskWorker, WorkerFailedError, WorkerTimeoutError } from "./worker-pool";

export { ImportError, importKeyAllowed, sha } from "./import-plan";
export { htmlBody } from "./import-plan";

export const importConfig = () => ({
  maxBytes: envInt("IMPORT_MAX_BYTES", 100 * 1024 * 1024, 1024),
  maxEntries: envInt("IMPORT_MAX_ENTRIES", 20_000, 1),
  maxEntryBytes: envInt("IMPORT_MAX_ENTRY_BYTES", 25 * 1024 * 1024, 1024),
  maxTotalBytes: envInt("IMPORT_MAX_TOTAL_BYTES", 300 * 1024 * 1024, 1024),
  maxNotes: envInt("IMPORT_MAX_NOTES", 5000, 1),
  maxTextBytes: envInt("IMPORT_MAX_TEXT_BYTES", 1_500_000, 1024),
  maxDepth: envInt("IMPORT_MAX_DEPTH", 16, 1),
  paceMs: envInt("IMPORT_PACE_MS", 10),
  // HTML goes through a DOM-based converter: bounded per file, per request and in nesting.
  maxHtmlFileBytes: envInt("IMPORT_MAX_HTML_FILE_BYTES", 512 * 1024, 1024),
  maxHtmlTotalBytes: envInt("IMPORT_MAX_HTML_TOTAL_BYTES", 8 * 1024 * 1024, 1024),
  maxHtmlDepth: envInt("IMPORT_MAX_HTML_DEPTH", 100, 4),
  /** Wall clock for unzip + convert + plan (in the worker thread); past it the thread is killed. */
  planTimeoutMs: envInt("IMPORT_PLAN_TIMEOUT_MS", 45_000, 100),
  maxVerify: envInt("IMPORT_MAX_VERIFY", 1000, 1),
  // The attachment pipeline's own limits (routes/attachments.ts reads the same variables).
  maxImageBytes: envInt("ATTACHMENT_IMAGE_MAX_BYTES", 10 * 1024 * 1024, 1024),
  maxFileBytes: envInt("ATTACHMENT_MAX_BYTES", 25 * 1024 * 1024, 1024),
  noteQuotaBytes: envInt("ATTACHMENT_NOTE_QUOTA_BYTES", 250 * 1024 * 1024, 1024),
  vaultQuotaBytes: envInt("ATTACHMENT_VAULT_QUOTA_BYTES", 5 * 1024 * 1024 * 1024, 1024),
});

// ── planning (in the worker thread) ─────────────────────────────────────────

/** May an import apply this tag in this vault? Returns the canonical tag or null. */
export function importTagAllowed(vaultId: string, raw: string): string | null {
  const tag = staticTagAllowed(raw);
  if (!tag) return null;
  // A tag someone shares or publishes from: an import must not hand pages to other people.
  if (publishedTag(vaultId, tag) || grantsForResource("tag", tag, vaultId).length > 0) return null;
  return tag;
}

/** Every tag of this vault that is published or named by a grant (the worker has no database). */
function deniedTags(vaultId: string): string[] {
  const granted = listGrantsForVault(vaultId).filter((g) => g.resource_type === "tag").map((g) => g.resource);
  const published = listPublications().filter((p) => p.resource_type === "tag" && (p.vault_id ?? "primary") === vaultId).map((p) => p.resource);
  return [...new Set([...granted, ...published])];
}

const planner = new TaskWorker(1024, 4);
export const stopImportWorker = (): Promise<void> => planner.stop();

export interface ImportPlanned {
  root: string;
  single: boolean;
  notes: PlannedNote[];
  problems: Array<{ entry: string; reason: string }>;
  counts: PlanResult["counts"];
  assets: Map<string, ImportFile>;
}

/**
 * Unzip, convert and plan an upload — OFF the event loop, under a wall-clock
 * budget. The upload's buffer is handed to the worker (not copied) and is gone
 * from this thread afterwards; the referenced files come back the same way.
 */
export async function planInWorker(entry: VaultEntry, bytes: Uint8Array, fileName: string, root: string): Promise<ImportPlanned> {
  const cfg = importConfig();
  const limits: PlanLimits = {
    maxBytes: cfg.maxBytes, maxEntries: cfg.maxEntries, maxEntryBytes: cfg.maxEntryBytes, maxTotalBytes: cfg.maxTotalBytes, maxNotes: cfg.maxNotes,
    maxTextBytes: cfg.maxTextBytes, maxDepth: cfg.maxDepth, maxFileBytes: cfg.maxFileBytes,
    maxHtmlFileBytes: cfg.maxHtmlFileBytes, maxHtmlTotalBytes: cfg.maxHtmlTotalBytes, maxHtmlDepth: cfg.maxHtmlDepth,
  };
  // An exact-size buffer of our own, so it can be transferred.
  const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
  const req: PlanRequest = { op: "import-plan", bytes: own, fileName, root, limits, deniedTags: deniedTags(entry.id) };
  let result: PlanResult;
  try {
    result = await planner.run<PlanResult>(req, cfg.planTimeoutMs, [own.buffer as ArrayBuffer]);
  } catch (e) {
    if (e instanceof WorkerTimeoutError) throw new ImportError(413, "too_complex", "That file takes too long to read. Import it in smaller parts.");
    if (e instanceof WorkerFailedError && e.status && e.code) throw new ImportError(e.status as 400 | 413 | 415, e.code, e.message);
    if (e instanceof WorkerFailedError && e.code === "worker_failed") throw new ImportError(413, "too_complex", "That file is too large to read. Import it in smaller parts.");
    throw new ImportError(400, "bad_request", "The file could not be read.");
  }
  const assets = new Map<string, ImportFile>();
  for (const a of result.assets) assets.set(a.name, { name: a.name, size: a.bytes.byteLength, read: () => a.bytes });
  return { root: result.root, single: result.single, notes: result.notes, problems: result.problems, counts: result.counts, assets };
}

/** `vault/Imports` for one file, `vault/Imports/<archive name>` for an archive (when the caller names no folder). */
export function defaultParent(bytes: Uint8Array, fileName: string): string {
  const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!zip) return "vault/Imports";
  const leaf = fileName.split("\\").join("/").split("/").pop() ?? "import";
  const dot = leaf.lastIndexOf(".");
  return `vault/Imports/${stripNotionId(dot > 0 ? leaf.slice(0, dot) : leaf)}`;
}

// ── who will see what is imported ───────────────────────────────────────────

export interface ImportAudience {
  /** The destination lies under (or is) a page somebody shares: imported pages are shared with those people. */
  sharedPage: boolean;
  /** Accounts with access through a page share above the destination, or a whole-vault grant. */
  people: number;
  /** "Anyone with the link" / public grants reaching the destination. */
  links: number;
  /** Workspace members see new pages by default (unless imported as private). */
  workspace: true;
}

export async function importAudience(entry: VaultEntry, root: string): Promise<ImportAudience> {
  const key = pathKey(root);
  const people = new Set<string>();
  let links = 0;
  let sharedPage = false;
  const tree = await ensureTree(entry);
  for (const row of tree.rows()) {
    if (!row.path || row.tags.includes(TRASH_TAG)) continue;
    const rk = pathKey(row.path);
    if (rk !== key && !isUnder(key, rk)) continue;
    for (const g of grantsForResource("page", row.id, entry.id)) {
      sharedPage = true;
      if (g.subject_type === "user") people.add(g.subject.toLowerCase());
      else links++;
    }
  }
  for (const g of listGrantsForVault(entry.id)) {
    if (g.resource_type !== "vault") continue;
    if (g.subject_type === "user") people.add(g.subject.toLowerCase());
    else links++;
  }
  return { sharedPage, people: people.size, links, workspace: true };
}

// ── resolving against the vault ─────────────────────────────────────────────

/** `prism_import.assets`: asset key → the attachment that holds it, or "x" = permanently refused. */
type AssetMap = Record<string, string>;
const REFUSED = "x";
const assetKey = (a: { image: boolean; hash: string }): string => `${a.image ? "i" : "f"}${a.hash.slice(0, 40)}`;

export interface Resolved {
  note: PlannedNote;
  action: ImportItem["action"];
  reason?: string;
  /** update / resume: the existing note and the revision the decision was made on. */
  holderId?: string;
  holderUpdatedAt?: string | null;
  /** What earlier runs already attached (or were refused) for this note. */
  prior?: AssetMap;
}

interface ImportStamp { v: 1; src: string; hash?: string; body?: string; at?: string; assets?: AssetMap }
const stampOf = (n: Pick<Note, "metadata">): ImportStamp | null => {
  const s = n.metadata?.prism_import as ImportStamp | undefined;
  return s && typeof s === "object" && typeof s.src === "string" ? s : null;
};
const priorOf = (s: ImportStamp): AssetMap => {
  const out: AssetMap = {};
  if (s.assets && typeof s.assets === "object") for (const [k, v] of Object.entries(s.assets)) if (typeof v === "string") out[k] = v;
  return out;
};

/** The destination root, validated; a refusal carries the HTTP answer. */
export async function resolveRoot(entry: VaultEntry, raw: unknown): Promise<{ root: string; existing: Note[] } | PlacementRefusal> {
  const root = typeof raw === "string" && raw.length <= 1000 ? normalizePagePath(raw) : null;
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

export async function resolveActions(entry: VaultEntry, plan: ImportPlanned, existing: Note[]): Promise<Resolved[]> {
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
  /** Changed in the source: needs the stored body to prove nobody edited it. */
  const verify: Array<{ at: number; holder: Note; stamp: ImportStamp }> = [];
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
    const prior = priorOf(stamp);
    if (stamp.hash === note.hash) { out.push({ note, action: "unchanged", holderId: holder.id }); continue; }
    if (!stamp.body) {
      // Its first write landed but the import never finished it (attachments): complete it.
      out.push({ note, action: "update", holderId: holder.id, holderUpdatedAt: holder.updatedAt ?? null, prior });
      continue;
    }
    if (verify.length >= importConfig().maxVerify) { conflict("too many changed pages to check in one run; run the import again"); continue; }
    verify.push({ at: out.length, holder, stamp });
    out.push({ note, action: "conflict", reason: "could not be read", prior });
  }
  // Changed in the source (or left incomplete): only replace a body nobody has edited
  // since the last import. Bounded, a few reads at a time.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, verify.length) }, async () => {
    while (next < verify.length) {
      const v = verify[next++]!;
      const slot = out[v.at]!;
      try {
        const full = await vc.getNote(v.holder.id);
        if (full.id !== v.holder.id || sha(full.content ?? "") !== v.stamp.body) slot.reason = "edited since it was imported";
        else out[v.at] = { note: slot.note, action: "update", holderId: v.holder.id, holderUpdatedAt: full.updatedAt ?? null, prior: slot.prior };
      } catch {
        /* stays a conflict: "could not be read" */
      }
    }
  }));
  return out;
}

export function previewOf(plan: ImportPlanned, resolved: Resolved[], audience: ImportAudience): ImportPreview {
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
    problems: plan.problems.slice(0, 100),
    audience,
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

type Attached = { id: string } | { error: string; permanent: boolean };

/** Store one referenced file as an attachment of `noteId`. `permanent` = the same file will be refused every time. */
async function attach(entry: VaultEntry, noteId: string, file: ImportFile, image: boolean, createdBy: string): Promise<Attached> {
  const cfg = importConfig();
  const limit = image ? cfg.maxImageBytes : cfg.maxFileBytes;
  if (file.size === 0) return { error: "empty file", permanent: true };
  if (file.size > limit) return { error: "too large", permanent: true };
  if (usedBytes(entry.id, noteId) + file.size > cfg.noteQuotaBytes) return { error: "this page's attachment quota is full", permanent: false };
  if (usedBytes(entry.id) + file.size > cfg.vaultQuotaBytes) return { error: "the workspace's attachment quota is full", permanent: false };
  const bytes = file.read();
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 64 * 1024));
  const sniffed = sniffAttachment(head);
  let mime: AttachmentType;
  if (image) {
    if (!sniffed || !IMAGE_TYPES.has(sniffed)) return { error: "not a supported image (PNG, JPEG, GIF, WebP, AVIF)", permanent: true };
    mime = sniffed;
  } else {
    if (hasBlockedExtension(file.name) || (!sniffed && looksActive(head))) return { error: "active content is not imported", permanent: true };
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
    return { error: "could not be stored", permanent: false };
  }
  try {
    const att = await vaultAttach(entry.id, noteId, row.storage_path, mime);
    insertAttachment({ ...row, vault_attachment_id: att.id || null });
  } catch {
    try { recordOrphan(row); } catch { /* best-effort */ }
    return { error: "could not be stored", permanent: false };
  }
  return { id };
}

/** Content with every asset token replaced (by the attachment URL, or the original target). */
function withAssets(note: PlannedNote, urls: Map<string, string>): string {
  let content = note.content;
  // Highest index first so `…:1` never eats the head of `…:10`.
  for (let i = note.assets.length - 1; i >= 0; i--) {
    const a = note.assets[i]!;
    content = content.split(`(${ASSET_TOKEN}${i})`).join(`(${urls.get(a.token) ?? a.original})`);
  }
  return content;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ImportOptions {
  /** Create the pages private to the importing account. */
  private?: boolean;
}

export async function runImport(
  job: Job<ImportProgress>,
  entry: VaultEntry,
  actor: UserActor,
  plan: ImportPlanned,
  resolved: Resolved[],
  hooks: { onWrite?: () => void; onEnd?: (job: Job<ImportProgress>) => void } = {},
  options: ImportOptions = {},
): Promise<void> {
  const cfg = importConfig();
  const p = job.progress;
  const vc = vaultClient(entry.id, { timeoutMs: 60_000 });
  const createdBy = `u:${actor.email.toLowerCase()}`;
  const visibility = options.private ? { prism_visibility: "private", prism_creator: actor.email } : {};
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
          // A page that is open in the live editor, or whose live changes have not reached the
          // vault yet, is never overwritten by an import (its stored body is not what people see).
          else if (r.action === "update" && r.holderId && (await import("../collab")).hasLiveState(entry.id, r.holderId)) {
            p.conflicts++;
            const forGood = (await import("../collab")).unsavedPermanentReason(entry.id, r.holderId);
            if (p.problems.length < 200)
              p.problems.push({
                entry: note.src,
                reason: forGood
                  ? "the page has live-editor changes that cannot be saved (too large or refused by the vault) — running the import again will not help until the page is made smaller or the owner discards those changes"
                  : "the page is open in the live editor (or still saving); run the import again later",
              });
          } else {
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
                metadata: stampMetadata({ ...note.metadata, ...visibility, prism_import: done ? { ...base, hash: note.hash, body: sha(plain), at: new Date().toISOString() } : base }, actor),
                ifExists: "error",
              });
              treeUpsertNote(entry, created);
              id = created.id;
              updatedAt = created.updatedAt ?? undefined;
              p.created++;
              if (!p.firstId) p.firstId = created.id;
            }
            if (r.action === "update" || note.assets.length) {
              // Each file is stored ONCE per page: an earlier run's attachment is reused, and a
              // file that can never be attached (wrong type, too large) is not tried again.
              const prior = r.prior ?? {};
              const settled: AssetMap = {};
              const urls = new Map<string, string>();
              let complete = true;
              for (const a of note.assets) {
                const key = assetKey(a);
                const known = settled[key] ?? prior[key];
                if (known === REFUSED) {
                  settled[key] = REFUSED;
                  continue;
                }
                if (known) {
                  const row = getAttachment(known);
                  if (row && row.vault_id === entry.id && row.note_id === id) {
                    settled[key] = known;
                    urls.set(a.token, `/api/attachments/${known}`);
                    continue;
                  }
                }
                const file = plan.assets.get(a.file);
                const res: Attached = file ? await attach(entry, id!, file, a.image, createdBy) : { error: "missing from the upload", permanent: true };
                if ("id" in res) {
                  settled[key] = res.id;
                  urls.set(a.token, `/api/attachments/${res.id}`);
                  p.attachments++;
                } else {
                  if (res.permanent) settled[key] = REFUSED;
                  else complete = false;
                  if (p.problems.length < 200) p.problems.push({ entry: a.file, reason: `not attached: ${res.error}` });
                }
              }
              const content = withAssets(note, urls);
              const updated = await vc.updateNote(id!, {
                content,
                // The vault MERGES nested metadata: send the whole stamp. An import whose
                // attachments did not all settle keeps no `hash`, so the next run completes it.
                metadata: stampMetadata({ ...(r.action === "update" ? note.metadata : {}), prism_import: { ...base, hash: complete ? note.hash : null, body: sha(content), at: new Date().toISOString(), ...(Object.keys(settled).length ? { assets: settled } : {}) } }, actor),
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
