/**
 * Vault-wide "Resolve all wikilinks" as a server job (parity A) — the port of the
 * desktop's `resolve_all_wikilinks` (commands/wikilinks.rs), run by the server
 * owner from a thin client: `POST /api/admin/wikilinks/resolve {dryRun}`.
 *
 * WHAT IT DOES (the desktop's semantics): for every note, extract `[[target]]` /
 * `[[target|label]]`, match each target to another note (exact path, the path
 * with `vault/` stripped, or the file name case-insensitively) and add a
 * `references` link note → target (a links-add PATCH, as the desktop sent it —
 * its `{source, original}` link metadata never reached the vault either).
 * It NEVER rewrites note content — only links are added.
 *
 * WHAT CHANGED vs the desktop (every change writes less):
 *   - DRY RUN BY DEFAULT: `dryRun` must be explicitly `false` to write anything;
 *     a dry run reports exactly what a real run would add.
 *   - The whole vault, not the first 2000 notes. The path index comes from ONE
 *     lean list (no content, with links); content is fetched per note in small
 *     concurrent batches, so memory stays bounded on a 14k-note vault.
 *   - A link that already exists (`references` to the same target) is skipped, and
 *     a note whose every resolvable link already exists is not written at all —
 *     on vault ≥0.7.9 each PATCH is a history version.
 *   - One write per note (all of its new links in one PATCH, the vault's link
 *     insert is idempotent) carrying `if_updated_at` from the content it parsed;
 *     a 409 (the note changed meanwhile) is counted as a conflict, never forced.
 *   - A note whose `[[` brackets don't balance is counted `unparseable` and only
 *     its well-formed links are used; matching prefers an exact path, then the
 *     stripped path, then a file name (deterministic, not list order).
 * One job at a time (server-wide); progress is polled at
 * `GET /api/admin/wikilinks/resolve`; `POST …/cancel` stops it between notes.
 */
import { randomUUID } from "node:crypto";
import type { Note, NoteLinkInput } from "./parachute";

export interface WikilinkJobVault {
  listNotes(opts: { includeLinks?: boolean; includeMetadata?: string[] }): Promise<Note[]>;
  getNote(id: string): Promise<Note>;
  updateNote(id: string, p: { links?: { add?: NoteLinkInput[] }; ifUpdatedAt?: string }): Promise<Note>;
}

export interface WikilinkJob {
  id: string;
  vaultId: string;
  dryRun: boolean;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  /** Notes in the vault / notes scanned so far. */
  total: number;
  scanned: number;
  notesWithWikilinks: number;
  wikilinks: number;
  /** Links created (real run) or that WOULD be created (dry run). */
  resolved: number;
  alreadyLinked: number;
  unresolved: number;
  /** Notes with unbalanced `[[ ]]` (their well-formed links still count). */
  unparseable: number;
  /** Notes written (real run) / that would be written (dry run). */
  notesUpdated: number;
  conflicts: number;
  errors: number;
  /** A few unresolved targets, for the report (capped). */
  unresolvedSample: string[];
}

/** Desktop `extract_wikilinks`: targets in order, `|label` dropped, trimmed,
 *  de-duplicated. One deliberate difference: a target may not contain `[`, so a
 *  stray `[[` before a real link (`[[oops [[Real]]`) yields `Real` instead of the
 *  desktop's garbage target `oops [[Real`; the note is still counted unparseable. */
export function extractWikilinks(content: string): { links: string[]; balanced: boolean } {
  const links: string[] = [];
  const re = /\[\[([^[\]]*?)\]\]/g;
  let m: RegExpExecArray | null;
  let matched = 0;
  while ((m = re.exec(content)) !== null) {
    matched++;
    const target = m[1]!.split("|")[0]!.trim();
    if (target && !links.includes(target)) links.push(target);
  }
  const opens = content.split("[[").length - 1;
  return { links, balanced: opens === matched };
}

interface PathIndex {
  byPath: Map<string, Note>;
  byStripped: Map<string, Note>;
  byName: Map<string, Note>;
}

function buildIndex(notes: Note[]): PathIndex {
  const idx: PathIndex = { byPath: new Map(), byStripped: new Map(), byName: new Map() };
  for (const n of notes) {
    const path = n.path ?? "";
    if (!path) continue;
    const stripped = path.startsWith("vault/") ? path.slice(6) : path;
    const name = (path.split("/").pop() ?? "").toLowerCase();
    if (!idx.byPath.has(path)) idx.byPath.set(path, n);
    if (!idx.byStripped.has(stripped)) idx.byStripped.set(stripped, n);
    if (name && !idx.byName.has(name)) idx.byName.set(name, n);
  }
  return idx;
}

/** The desktop matcher, deterministic: exact path → stripped path → file name (case-insensitive); never the note itself. */
export function matchTarget(wikilink: string, idx: PathIndex, selfId: string): Note | null {
  for (const cand of [idx.byPath.get(wikilink), idx.byStripped.get(wikilink), idx.byName.get(wikilink.toLowerCase())]) {
    if (cand && cand.id !== selfId) return cand;
  }
  return null;
}

const hasRef = (n: Note, targetId: string): boolean =>
  Array.isArray(n.links) && n.links.some((l) => l.relationship === "references" && l.sourceId === n.id && l.targetId === targetId);

let current: WikilinkJob | null = null;
let cancelFlag = false;

export const wikilinkJobStatus = (): WikilinkJob | null => (current ? { ...current, unresolvedSample: [...current.unresolvedSample] } : null);

export function cancelWikilinkJob(): boolean {
  if (!current || current.status !== "running") return false;
  cancelFlag = true;
  return true;
}

export class WikilinkJobBusyError extends Error {}

/** Test-only reset. */
export function _resetWikilinkJob(): void {
  current = null;
  cancelFlag = false;
}

/**
 * Start a job (returns at once; `done` resolves when it ends — tests await it).
 * Throws WikilinkJobBusyError while another job runs.
 */
export function startWikilinkJob(vault: WikilinkJobVault, vaultId: string, opts: { dryRun: boolean; concurrency?: number }): { job: WikilinkJob; done: Promise<void> } {
  if (current?.status === "running") throw new WikilinkJobBusyError("a wikilink job is already running");
  cancelFlag = false;
  const job: WikilinkJob = {
    id: randomUUID(),
    vaultId,
    dryRun: opts.dryRun,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    total: 0,
    scanned: 0,
    notesWithWikilinks: 0,
    wikilinks: 0,
    resolved: 0,
    alreadyLinked: 0,
    unresolved: 0,
    unparseable: 0,
    notesUpdated: 0,
    conflicts: 0,
    errors: 0,
    unresolvedSample: [],
  };
  current = job;
  const done = run(vault, job, Math.max(1, Math.min(8, opts.concurrency ?? 4))).catch((e) => {
    job.status = "error";
    job.error = String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200);
    job.endedAt = new Date().toISOString();
  });
  return { job: { ...job }, done };
}

async function run(vault: WikilinkJobVault, job: WikilinkJob, concurrency: number): Promise<void> {
  // One lean listing (no content) for the path index + existing links.
  const notes = await vault.listNotes({ includeLinks: true, includeMetadata: ["type"] });
  job.total = notes.length;
  const idx = buildIndex(notes);

  let next = 0;
  const worker = async () => {
    while (!cancelFlag) {
      const i = next++;
      if (i >= notes.length) return;
      const lean = notes[i]!;
      try {
        await processNote(vault, job, idx, lean);
      } catch {
        job.errors++;
      }
      job.scanned++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  job.status = cancelFlag ? "cancelled" : "done";
  job.endedAt = new Date().toISOString();
}

async function processNote(vault: WikilinkJobVault, job: WikilinkJob, idx: PathIndex, lean: Note): Promise<void> {
  const note = await vault.getNote(lean.id);
  const content = note.content ?? "";
  if (!content.includes("[[")) return;
  const { links, balanced } = extractWikilinks(content);
  if (!balanced) job.unparseable++;
  if (!links.length) return;
  job.notesWithWikilinks++;
  const add: NoteLinkInput[] = [];
  const seenTargets = new Set<string>();
  for (const w of links) {
    job.wikilinks++;
    const target = matchTarget(w, idx, note.id);
    if (!target) {
      job.unresolved++;
      if (job.unresolvedSample.length < 50 && !job.unresolvedSample.includes(w)) job.unresolvedSample.push(w.slice(0, 120));
      continue;
    }
    if (hasRef(lean, target.id) || seenTargets.has(target.id)) {
      job.alreadyLinked++;
      continue;
    }
    seenTargets.add(target.id);
    add.push({ target: target.id, relationship: "references" });
  }
  if (!add.length) return;
  if (job.dryRun) {
    job.resolved += add.length;
    job.notesUpdated++;
    return;
  }
  try {
    await vault.updateNote(note.id, { links: { add }, ...(note.updatedAt ? { ifUpdatedAt: note.updatedAt } : {}) });
    job.resolved += add.length;
    job.notesUpdated++;
  } catch (e) {
    if ((e as { status?: number }).status === 409) job.conflicts++;
    else job.errors++;
  }
}
