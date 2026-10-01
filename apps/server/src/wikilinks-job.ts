/**
 * Vault-wide "Resolve all wikilinks" as a server job (parity A) — the port of the
 * desktop's `resolve_all_wikilinks` (commands/wikilinks.rs), run by the server
 * owner from a thin client: `POST /api/admin/wikilinks/resolve {dryRun}`.
 *
 * WHAT IT DOES (the desktop's semantics): for every note, extract `[[target]]` /
 * `[[target|label]]`, match each target to another note (exact path, the path
 * with `vault/` stripped, or a file name case-insensitively — but only when
 * exactly ONE other note has that name) and add a
 * `references` link note → target (a links-add PATCH, as the desktop sent it —
 * its `{source, original}` link metadata never reached the vault either).
 * It NEVER rewrites note content — only links are added.
 *
 * WHAT CHANGED vs the desktop (every change writes less):
 *   - DRY RUN BY DEFAULT: `dryRun` must be explicitly `false` to write anything;
 *     a dry run reports exactly what a real run would add.
 *   - The whole vault, not the first 2000 notes. The path index comes from ONE
 *     lean list (no content, with links); content is then fetched per note, 2 at
 *     a time with a 25 ms pause per fetch (security review M3: the vault is
 *     single-threaded), skipping machine-written notes that never carry
 *     hand-written wikilinks (agent dispatch/session transcripts, alerts). Memory
 *     stays bounded on a 14k-note vault. (A vault full-text search for `[[` is NOT
 *     used as the pre-filter: FTS tokenizers drop the brackets, so it can't be
 *     trusted to find every candidate.)
 *   - A link that already exists (`references` to the same target) is skipped, and
 *     a note whose every resolvable link already exists is not written at all —
 *     on vault ≥0.7.9 each PATCH is a history version.
 *   - One write per note (all of its new links in one PATCH, the vault's link
 *     insert is idempotent) carrying `if_updated_at` from the content it parsed;
 *     a 409 (the note changed meanwhile) is counted as a conflict, never forced.
 *   - A note whose `[[` brackets don't balance is counted `unparseable` and only
 *     its well-formed links are used; matching prefers an exact path, then the
 *     stripped path, then a file name (deterministic, not list order). A file
 *     name shared by several other notes is AMBIGUOUS: never linked, counted
 *     `ambiguous` (+ a sample) and shown in the dry-run report (M2).
 *   - A write run records one `action_audit` row when it ends (routes/admin.ts).
 * One job at a time (server-wide); progress is polled at
 * `GET /api/admin/wikilinks/resolve`; `POST …/cancel` stops it between notes.
 */
import { randomUUID } from "node:crypto";
import { parseWikilinks, buildWikilinkIndex, resolveWikilink, type WikilinkIndex } from "@prism/core/wikilinks";
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
  /** Notes in the vault / notes that can hold a wikilink (pre-filter) / scanned so far. */
  total: number;
  candidates: number;
  scanned: number;
  notesWithWikilinks: number;
  wikilinks: number;
  /** Links created (real run) or that WOULD be created (dry run). */
  resolved: number;
  alreadyLinked: number;
  unresolved: number;
  /** Wikilinks whose file name matches several notes — never linked (M2). */
  ambiguous: number;
  /** Notes with unbalanced `[[ ]]` (their well-formed links still count). */
  unparseable: number;
  /** Notes written (real run) / that would be written (dry run). */
  notesUpdated: number;
  conflicts: number;
  errors: number;
  /** A few unresolved targets, for the report (capped). */
  unresolvedSample: string[];
  ambiguousSample: string[];
}

// Keep the public job helpers stable while sharing one resolver with clients.
export const extractWikilinks = parseWikilinks;
export type PathIndex = WikilinkIndex<Note>;
export const buildIndex = (notes: Note[]): PathIndex => buildWikilinkIndex(notes);
export type MatchResult = { kind: "match"; note: Note } | { kind: "ambiguous"; candidates: number } | { kind: "none" };
export function matchTarget(target: string, index: PathIndex, selfId: string): MatchResult {
  const result = resolveWikilink(target,index,selfId);
  return result.kind === "ambiguous" ? {kind:"ambiguous",candidates:result.notes.length} : result;
}

const hasRef = (n: Note, targetId: string): boolean =>
  Array.isArray(n.links) && n.links.some((l) => l.relationship === "references" && l.sourceId === n.id && l.targetId === targetId);

let current: WikilinkJob | null = null;
let cancelFlag = false;

export const wikilinkJobStatus = (): WikilinkJob | null =>
  current ? { ...current, unresolvedSample: [...current.unresolvedSample], ambiguousSample: [...current.ambiguousSample] } : null;

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

export interface WikilinkJobOptions {
  dryRun: boolean;
  /** Concurrent note fetches (default 2, max 4 — M3: keep the single-threaded vault responsive). */
  concurrency?: number;
  /** Pause per worker between note fetches, ms (default 25). */
  paceMs?: number;
  /** Called once when the job ends (the route writes the audit row for write runs). */
  onEnd?: (job: WikilinkJob) => void;
}

/**
 * Start a job (returns at once; `done` resolves when it ends — tests await it).
 * Throws WikilinkJobBusyError while another job runs.
 */
export function startWikilinkJob(vault: WikilinkJobVault, vaultId: string, opts: WikilinkJobOptions): { job: WikilinkJob; done: Promise<void> } {
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
    candidates: 0,
    scanned: 0,
    notesWithWikilinks: 0,
    wikilinks: 0,
    resolved: 0,
    alreadyLinked: 0,
    unresolved: 0,
    ambiguous: 0,
    unparseable: 0,
    notesUpdated: 0,
    conflicts: 0,
    errors: 0,
    unresolvedSample: [],
    ambiguousSample: [],
  };
  current = job;
  const done = run(vault, job, Math.max(1, Math.min(4, opts.concurrency ?? 2)), Math.max(0, opts.paceMs ?? 25))
    .catch((e) => {
      job.status = "error";
      job.error = String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200);
      job.endedAt = new Date().toISOString();
    })
    .finally(() => {
      try {
        opts.onEnd?.({ ...job });
      } catch {
        /* never let the audit hook break the job */
      }
    });
  return { job: { ...job }, done };
}

/** Bulk machine-written notes that never carry hand-written wikilinks (M3 pre-filter):
 *  dispatch/session transcripts and alerts. Mail and chat are KEPT (a human can type [[x]]). */
const SKIP_TAGS = new Set(["agent-dispatch", "agent-output", "agent-session", "alert", "governance-audit"]);

async function run(vault: WikilinkJobVault, job: WikilinkJob, concurrency: number, paceMs: number): Promise<void> {
  // One lean listing (no content) for the path index + existing links.
  const notes = await vault.listNotes({ includeLinks: true, includeMetadata: ["type", "title", "aliases", "alias"] });
  if (notes.length >= 50_000) throw new Error("Document inventory reached its limit; no links were changed");
  job.total = notes.length;
  const idx = buildIndex(notes);
  // M3 pre-filter, content-free: only notes that can hold a wikilink are fetched.
  const candidates = notes.filter((n) => !(n.tags ?? []).some((t) => SKIP_TAGS.has(t)));
  job.candidates = candidates.length;

  let next = 0;
  const worker = async () => {
    while (!cancelFlag) {
      const i = next++;
      if (i >= candidates.length) return;
      const lean = candidates[i]!;
      try {
        await processNote(vault, job, idx, lean);
      } catch {
        job.errors++;
      }
      job.scanned++;
      if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
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
    const m = matchTarget(w, idx, note.id);
    if (m.kind === "none") {
      job.unresolved++;
      if (job.unresolvedSample.length < 50 && !job.unresolvedSample.includes(w)) job.unresolvedSample.push(w.slice(0, 120));
      continue;
    }
    if (m.kind === "ambiguous") {
      job.ambiguous++;
      if (job.ambiguousSample.length < 50 && !job.ambiguousSample.includes(w)) job.ambiguousSample.push(w.slice(0, 120));
      continue;
    }
    if (hasRef(lean, m.note.id) || seenTargets.has(m.note.id)) {
      job.alreadyLinked++;
      continue;
    }
    seenTargets.add(m.note.id);
    add.push({ target: m.note.id, relationship: "references" });
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
