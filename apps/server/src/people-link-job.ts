/**
 * The people-linking BACKFILL job — connects existing records to the people
 * they are about, with the conservative identity rules of src/identity.ts.
 * Cloned from the wikilinks job (src/wikilinks-job.ts): server-owner only
 * (routes/people-admin.ts), DRY RUN unless `dryRun: false`, one job at a time,
 * cancellable, progress + result via GET, one `action_audit` row (counts only)
 * when a write run ends.
 *
 * PHASES (each selectable; always run in this order):
 *   owner      — checks the configured owner person note is a live person, adds
 *                the owner's addresses / aliases to it (append-only), and moves
 *                links held by ITS tombstones onto it.
 *   tombstones — repairs DANGLING stubs only: `merged_into` is absent or resolves
 *                to nothing in the whole vault. The one live person sharing a
 *                STRONG key → `merged_into` = that note's id (the old value kept
 *                in `prism_merged_into_prev`); a name match or no match → review
 *                queue (`tombstone-unresolved`). A stub whose target exists but
 *                is not a live person (an organization, a project, a bot note)
 *                is left alone. A stub repaired in this run is neither repointed
 *                nor used for matching until the next run.
 *   repoint    — links held by a merged stub move to its canonical person
 *                (same relationship, same direction). A vault-managed `wikilink`
 *                can't move, so the canonical gets a `references` link beside it.
 *   emails     — `email-from` (sender) and `email-to` (direct `To` recipients),
 *                by exact address. On BULK / AUTOMATED / PROMOTIONS mail only an
 *                exact sender address links (counted in `extra.bulkLinked`,
 *                sampled, and switchable off with `excludeBulkLinks`). A role
 *                mailbox (no-reply, team@, support@ …) NEVER links, whoever's
 *                note holds the address (`role-address-claimed`). A display name
 *                never links an email: name-only is a review item. Never the owner.
 *   meetings   — `attended-by` from `attendees` / `attendeeEmails`: address
 *                first; a name links only with `allowNameLinks`. The owner IS
 *                linked (calendar ingest's convention).
 *   threads    — `messages-with`, by Matrix id: stored `participantIds`, else
 *                the membership lookup (on by default when a Matrix credential
 *                exists; paced, budgeted, with a failure breaker). Looked-up ids
 *                are written back as `participantIds` in the SAME write as the
 *                links. When the lookup cannot answer (budget, failure, breaker)
 *                the thread WAITS for a later run — no fallback to display
 *                names. A display name never links a thread and is never a key.
 *                Rooms over GROUP_MAX_MEMBERS (by REAL membership) get neither
 *                links nor ids; bots and the owner are never linked.
 *   tasks      — `assigned-to` (the owner by configured alias; other names only
 *                with `allowNameLinks`) and `belongs-to` (exact unique project).
 *   normalize  — long-tail relationship names → canonical (src/relationships.ts),
 *                only where direction and endpoint kinds are unambiguous.
 *
 * SAFETY (every phase):
 *   - Lean listings only: never `include_content`, `include_metadata` limited to
 *     the keys a phase reads, one listing per tag. `owner` / `repoint` /
 *     `normalize` share ONE whole-vault lean listing (links + `type`), taken
 *     only when one of them is selected and kept current in memory.
 *   - Every write carries `if_updated_at`. No stamp → the note is skipped and
 *     counted (`no-stamp`), never force-written. A 409 is counted, never forced.
 *   - "Already linked" is direction-aware: only source → target counts.
 *   - A removal is sent only after the matching addition succeeded.
 *   - ≤2 writes in flight, paced; a hard per-run write cap; every vault call has
 *     a timeout; N consecutive failed writes (not 409) ABORT the run as `error`.
 *   - Notes over the vault's 2 MB history ceiling are skipped (`oversize`).
 *   - A note open in the collab editor gets its links written and the collab
 *     reconciler is told the content did not change (`markReconciled`).
 *   - Identities it will not link are COUNTED; they are written to the review
 *     queue only with `enqueue: true`, only for the part of a phase a capped run
 *     actually reached, and never past PEOPLE_QUEUE_MAX_OPEN open rows. A link
 *     that lands closes the open rows that asked about it. An identity the owner
 *     DISMISSED never links.
 * A dry run plans exactly what a write run with the same options writes.
 */
import { randomUUID } from "node:crypto";
import type { Note, NoteLinkInput } from "./parachute";
import { IdentityIndex, cleanName, hasPointerWithoutMarker, isTombstone, looksLikeEmail, mergedIntoRef, nameTokens, ownerMatch, ownerProfile, personKeys, slugKey, type Evidence, type IdentityKey, type IdentityQuery, type Match, type NameKey, type OwnerConfig, type OwnerProfile } from "./identity";
import { REL, VAULT_MANAGED, classifyRelationship, noteKinds } from "./relationships";
import { PERSON_IDENTITY_KEYS, addKeyPatch } from "./people-metadata";
import { candidateStatus, closeCandidatesLinked, enqueueCandidate } from "./identity-store";
import { getWorkerCursor, setWorkerCursor } from "./db";
import { acquirePeopleLock } from "./people-lock";
import { creationRefusal, isNonhumanEmail } from "./worker/people";
import { parseAddressList } from "./worker/proton-parse";

export const PHASES = ["owner", "tombstones", "repoint", "emails", "meetings", "threads", "tasks", "normalize"] as const;
export type Phase = (typeof PHASES)[number];
export const isPhase = (p: unknown): p is Phase => typeof p === "string" && (PHASES as readonly string[]).includes(p);

export interface LinkJobVault {
  listNotes(opts: { tags?: string[]; includeLinks?: boolean; includeMetadata?: string[]; limit?: number }): Promise<Note[]>;
  updateNote(id: string, p: { links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] }; metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note>;
}

/**
 * `owner-full-name`: the owner note's own multi-word name. `owner-alias`: a name
 * the owner CONFIGURED as meaning them. `wikilink`: a `[[reference]]` to one note.
 */
export type LinkEvidence = Evidence | "owner-full-name" | "owner-alias" | "wikilink" | "project";

export interface PhaseReport {
  phase: Phase;
  status: "pending" | "running" | "done" | "skipped";
  /** Records examined. */
  scanned: number;
  /** Planned (identical in a dry run and a write run with the same options). */
  wouldLink: number;
  wouldUnlink: number;
  notesToWrite: number;
  alreadyLinked: number;
  /** Planned links by what decided them (email, mxid, telegram, phone, handle, alias, full-name, path, owner-alias, project). */
  byEvidence: Partial<Record<LinkEvidence, number>>;
  /** Identities sent to (write run) / that would go to (dry run) the review queue. */
  queued: number;
  queuedByReason: Record<string, number>;
  skipped: Record<string, number>;
  /** Phase-specific planned counts (`idsBackfilled`, `repaired`, `identitiesAdded`, …). */
  extra: Record<string, number>;
  /** Write runs only. */
  linked: number;
  unlinked: number;
  notesWritten: number;
  conflicts: number;
  errors: number;
  oversize: number;
  /** Planned writes not attempted: over the write cap, or behind a failed addition. */
  deferred: number;
  /** normalize: planned rewrites per long-tail name / synonyms left alone, per name. */
  byName?: Record<string, number>;
  untouched?: Record<string, number>;
  /** Note ids only — never titles, paths or addresses. `bulk`: bulk-labelled mail that would link; `role`: role mailboxes a person note claims (never linked). */
  sample: { link: string[]; review: string[]; bulk: string[]; role: string[] };
}

export interface LinkJob {
  id: string;
  vaultId: string;
  dryRun: boolean;
  phases: Phase[];
  maxWrites: number;
  allowNameLinks: boolean;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  writes: number;
  capped: boolean;
  /** Review-queue rows this run created (write runs). */
  queuedNew: number;
  memberLookups: number;
  ownerPersonKnown: boolean;
  /** Notes written while open in the collab editor. */
  liveNotes: number;
  report: Record<Phase, PhaseReport>;
}

export interface LinkJobLimits {
  groupNameMax: number;
  groupMaxMembers: number;
  groupLinkCap: number;
  maxRecipients: number;
  memberLookups: number;
  memberPaceMs: number;
}

export interface LinkJobOptions {
  dryRun: boolean;
  phases?: Phase[];
  /** Hard cap on note writes this run (0 = no cap). */
  maxWrites?: number;
  /** Put unresolved identities in the review queue (default FALSE, for every run). */
  enqueue?: boolean;
  /** Do not link bulk-labelled mail at all (default: an exact address still links). */
  excludeBulkLinks?: boolean;
  /** Consecutive failed membership lookups that end the lookup stage (default 3). */
  memberFailures?: number;
  /** Let a unique full name / alias LINK in the meetings and tasks phases (default: review). */
  allowNameLinks?: boolean;
  concurrency?: number;
  paceMs?: number;
  owner: OwnerConfig;
  limits?: Partial<LinkJobLimits>;
  /** Matrix membership lookup (mxid → display name), paced + budgeted. */
  members?: (roomId: string) => Promise<Record<string, string> | null>;
  /** The lean person listing (the route passes a cache-refreshing loader). */
  people?: () => Promise<Note[]>;
  /** Collab hooks (the route passes collab.ts's); absent = no live documents. */
  live?: { isLive(noteId: string): boolean; markReconciled(noteId: string, prevMs: number, nextMs: number): void };
  /** Abort after this many consecutive failed writes that are not conflicts (default 5; 0 = never). */
  maxConsecutiveErrors?: number;
  /** Give up on a single vault call after this long (default 30 s). */
  callTimeoutMs?: number;
  /** Called after every successful write (cache invalidation). */
  onWrite?: () => void;
  onEnd?: (job: LinkJob) => void;
}

const DEFAULT_LIMITS: LinkJobLimits = { groupNameMax: 8, groupMaxMembers: 50, groupLinkCap: 15, maxRecipients: 10, memberLookups: 300, memberPaceMs: 150 };
/** The vault refuses to update a note over this many bytes while history is on. */
export const HISTORY_MAX_BYTES = 2_000_000;
const INVENTORY_LIMIT = 50_000;
const SAMPLE = 20;
const BULK_LABELS = new Set(["BULK", "AUTOMATED", "PROMOTIONS", "CATEGORY_PROMOTIONS"]);
/** Calendar resources and group mailboxes are never people. */
const NON_PERSON_DOMAINS = /\.calendar\.google\.com$/i;
const isBridgeBotId = (mxid: string): boolean => mxid.includes("bot:") || mxid.startsWith("@_");
const looksLikeBotName = (n: string): boolean => /\b(bot|bridge)\b/i.test(n);

let current: LinkJob | null = null;
let cancelFlag = false;

export class LinkJobBusyError extends Error {}
class JobAbort extends Error {}

const cloneJob = (j: LinkJob): LinkJob => JSON.parse(JSON.stringify(j)) as LinkJob;
export const linkJobStatus = (): LinkJob | null => (current ? cloneJob(current) : null);
export const linkJobRunning = (): boolean => current?.status === "running";

export function cancelLinkJob(): boolean {
  if (!current || current.status !== "running") return false;
  cancelFlag = true;
  return true;
}

/** Test-only reset. */
export function _resetLinkJob(): void {
  current = null;
  cancelFlag = false;
}

function emptyReport(phase: Phase, selected: boolean): PhaseReport {
  return {
    phase,
    status: selected ? "pending" : "skipped",
    scanned: 0,
    wouldLink: 0,
    wouldUnlink: 0,
    notesToWrite: 0,
    alreadyLinked: 0,
    byEvidence: {},
    queued: 0,
    queuedByReason: {},
    skipped: {},
    extra: {},
    linked: 0,
    unlinked: 0,
    notesWritten: 0,
    conflicts: 0,
    errors: 0,
    oversize: 0,
    deferred: 0,
    sample: { link: [], review: [], bulk: [], role: [] },
  };
}

/**
 * Start a job (returns at once; `done` resolves when it ends — tests await it).
 * Throws LinkJobBusyError while another job, a merge or a resolve is running.
 */
export function startLinkJob(vault: LinkJobVault, vaultId: string, opts: LinkJobOptions): { job: LinkJob; done: Promise<void> } {
  if (current?.status === "running") throw new LinkJobBusyError("a people-link job is already running");
  const release = acquirePeopleLock("people-link-job");
  if (!release) throw new LinkJobBusyError("another people operation is in progress");
  cancelFlag = false;
  const phases = opts.phases?.length ? PHASES.filter((p) => opts.phases!.includes(p)) : [...PHASES];
  const report = Object.fromEntries(PHASES.map((p) => [p, emptyReport(p, phases.includes(p))])) as Record<Phase, PhaseReport>;
  const job: LinkJob = {
    id: randomUUID(),
    vaultId,
    dryRun: opts.dryRun,
    phases,
    maxWrites: Math.max(0, Math.floor(opts.maxWrites ?? 0)),
    allowNameLinks: opts.allowNameLinks === true,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    writes: 0,
    capped: false,
    queuedNew: 0,
    memberLookups: 0,
    ownerPersonKnown: false,
    liveNotes: 0,
    report,
  };
  current = job;
  const done = run(vault, job, opts)
    .then(() => {
      job.status = cancelFlag ? "cancelled" : "done";
    })
    .catch((e) => {
      job.status = "error";
      job.error = String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200);
    })
    .finally(() => {
      release();
      job.endedAt = new Date().toISOString();
      for (const p of job.phases) if (job.status === "done" && job.report[p].status !== "skipped") job.report[p].status = "done";
      persistOutcome(job);
      try {
        opts.onEnd?.(cloneJob(job));
      } catch {
        /* never let the audit hook break the job */
      }
    });
  return { job: cloneJob(job), done };
}

// ── planning ─────────────────────────────────────────────────────────────────

interface Removal {
  link: NoteLinkInput;
  /** This removal waits for that note's addition to succeed. */
  requires?: string;
}
interface Op {
  noteId: string;
  add: NoteLinkInput[];
  remove: Removal[];
  /** A metadata merge-patch riding in the same write (participantIds, merged_into, owner identities). */
  metadata?: Record<string, unknown>;
}

/** One phase's planned edits, merged per note. */
class Plan {
  private ops = new Map<string, Op>();
  private op(id: string): Op {
    let o = this.ops.get(id);
    if (!o) {
      o = { noteId: id, add: [], remove: [] };
      this.ops.set(id, o);
    }
    return o;
  }
  add(id: string, link: NoteLinkInput): boolean {
    const o = this.op(id);
    if (o.add.some((l) => l.target === link.target && l.relationship === link.relationship)) return false;
    o.add.push(link);
    return true;
  }
  remove(id: string, link: NoteLinkInput, requires?: string): boolean {
    const o = this.op(id);
    if (o.remove.some((r) => r.link.target === link.target && r.link.relationship === link.relationship)) return false;
    o.remove.push({ link, ...(requires ? { requires } : {}) });
    return true;
  }
  metadata(id: string, patch: Record<string, unknown>): void {
    const o = this.op(id);
    o.metadata = { ...(o.metadata ?? {}), ...patch };
  }
  list(): Op[] {
    return [...this.ops.values()];
  }
}

/** DIRECTED: does `n` hold an outgoing `rel` link to `targetId`? */
const hasOut = (n: Note | undefined, targetId: string, rel: string): boolean =>
  !!n && Array.isArray(n.links) && n.links.some((l) => l.relationship === rel && l.sourceId === n.id && l.targetId === targetId);

const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const byteSizeOf = (n: Note): number | null => {
  const v = (n as unknown as { byteSize?: unknown }).byteSize;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
const hasLinkMetadata = (l: unknown): boolean => {
  const m = (l as { metadata?: unknown })?.metadata;
  return !!m && typeof m === "object" && Object.keys(m as object).length > 0;
};

/** `Name <a@b>, c@d` → [{name, email}] (the Proton ingest's RFC 5322 parser). */
export function addressList(raw: unknown): Array<{ name: string; email: string }> {
  const out: Array<{ name: string; email: string }> = [];
  for (const s of strings(raw)) {
    for (const item of parseAddressList(s.slice(0, 20_000))) for (const m of item.members) if (looksLikeEmail(m.addr)) out.push({ name: m.name, email: m.addr.trim().toLowerCase() });
  }
  return out;
}

/** JSON merge patch (RFC 7386) on a local copy — mirrors what the vault will hold. */
function mergePatch(target: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v && typeof v === "object" && !Array.isArray(v) ? mergePatch(out[k], v as Record<string, unknown>) : v;
  }
  return out;
}

interface Ctx {
  vault: LinkJobVault;
  job: LinkJob;
  opts: LinkJobOptions;
  limits: LinkJobLimits;
  idx: IdentityIndex;
  people: Note[];
  owner: OwnerProfile;
  enqueue: boolean;
  /** id → current `updatedAt` (listings, then write responses). */
  stamps: Map<string, string | null>;
  sizes: Map<string, number>;
  /** The whole-vault lean listing, kept current in memory once loaded. */
  graph: Map<string, Note> | null;
  /** Dry run only: edits earlier phases WOULD have made, for later per-tag listings. */
  overlay: { add: Array<{ sourceId: string; targetId: string; relationship: string }>; remove: Set<string> };
  consecutiveErrors: number;
  timeoutMs: number;
  /** Per phase: scan order of notes, reviews waiting for the write window, the first capped index. */
  order: Map<string, number>;
  pending: Array<{ index: number; sourceId: string; rel: string; key: IdentityKey | NameKey; reason: string; candidateIds: string[]; display: string | null; origin: string }>;
  firstDeferred: number;
  /** Stubs whose `merged_into` this run repaired: never repointed in the same run. */
  repaired: Set<string>;
  lookup: { failures: number; broken: boolean };
}

const indexOf = (ctx: Ctx, noteId: string): number => {
  let i = ctx.order.get(noteId);
  if (i === undefined) {
    i = ctx.order.size;
    ctx.order.set(noteId, i);
  }
  return i;
};

const edgeKey = (s: string, t: string, r: string): string => `${s}\u0000${t}\u0000${r}`;

const bump = (r: PhaseReport, reason: string, n = 1) => {
  r.skipped[reason] = (r.skipped[reason] ?? 0) + n;
};
const extra = (r: PhaseReport, key: string, n = 1) => {
  r.extra[key] = (r.extra[key] ?? 0) + n;
};
const sampleOf = (list: string[], id: string) => {
  if (list.length < SAMPLE && !list.includes(id)) list.push(id);
};

/** Bound one vault call (an injected vault may have no timeout of its own). */
function timed<T>(ctx: Ctx, p: Promise<T>): Promise<T> {
  if (!ctx.timeoutMs) return p;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`vault call timed out after ${ctx.timeoutMs} ms`)), ctx.timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function remember(ctx: Ctx, notes: Note[]): void {
  for (const n of notes) {
    ctx.stamps.set(n.id, n.updatedAt ?? null);
    const b = byteSizeOf(n);
    if (b !== null) ctx.sizes.set(n.id, b);
  }
}

async function list(ctx: Ctx, opts: Parameters<LinkJobVault["listNotes"]>[0]): Promise<Note[]> {
  const notes = await timed(ctx, ctx.vault.listNotes({ ...opts, limit: INVENTORY_LIMIT }));
  if (notes.length >= INVENTORY_LIMIT) throw new Error("Note inventory reached its limit; no links were changed");
  const { add, remove } = ctx.overlay;
  if (opts.includeLinks && (add.length || remove.size)) {
    for (const n of notes) {
      const kept = (n.links ?? []).filter((l) => !remove.has(edgeKey(l.sourceId, l.targetId, l.relationship)));
      const have = new Set(kept.map((l) => edgeKey(l.sourceId, l.targetId, l.relationship)));
      for (const a of add) if ((a.sourceId === n.id || a.targetId === n.id) && !have.has(edgeKey(a.sourceId, a.targetId, a.relationship))) kept.push({ ...a });
      n.links = kept;
    }
  }
  remember(ctx, notes);
  return notes;
}

/** The whole vault, lean (links + `type` only): listed ONCE per job, then kept current. */
async function graph(ctx: Ctx): Promise<Map<string, Note>> {
  if (!ctx.graph) ctx.graph = new Map((await list(ctx, { includeLinks: true, includeMetadata: ["type"] })).map((n) => [n.id, n]));
  return ctx.graph;
}

/** Fold one applied (or, in a dry run, simulated) write into every in-memory view. */
function applyLocally(ctx: Ctx, o: Op, removed: NoteLinkInput[], updatedAt: string | null | undefined): void {
  if (updatedAt !== undefined && !ctx.job.dryRun) ctx.stamps.set(o.noteId, updatedAt);
  const touch = (n: Note | undefined) => {
    if (!n) return;
    let links = n.links ?? [];
    for (const r of removed) if (o.noteId === n.id || r.target === n.id) links = links.filter((l) => !(l.sourceId === o.noteId && l.targetId === r.target && l.relationship === r.relationship));
    for (const a of o.add) if ((o.noteId === n.id || a.target === n.id) && !links.some((l) => l.sourceId === o.noteId && l.targetId === a.target && l.relationship === a.relationship)) links = [...links, { sourceId: o.noteId, targetId: a.target, relationship: a.relationship }];
    n.links = links;
  };
  const ends = new Set([o.noteId, ...o.add.map((a) => a.target), ...removed.map((r) => r.target)]);
  for (const id of ends) {
    touch(ctx.graph?.get(id));
    touch(ctx.people.find((p) => p.id === id));
  }
  if (o.metadata) {
    const p = ctx.people.find((x) => x.id === o.noteId);
    if (p) p.metadata = mergePatch(p.metadata, o.metadata);
  }
  if (ctx.job.dryRun) {
    for (const a of o.add) ctx.overlay.add.push({ sourceId: o.noteId, targetId: a.target, relationship: a.relationship });
    for (const r of removed) ctx.overlay.remove.add(edgeKey(o.noteId, r.target, r.relationship));
  }
}

function rebuildIdentity(ctx: Ctx): void {
  // The reviewed job may resolve a `merged_into` / `[[wikilink]]` given as an exact, unique name.
  ctx.idx = new IdentityIndex(ctx.people, { refByName: true });
  ctx.owner = ownerProfile(ctx.idx, ctx.opts.owner);
  ctx.job.ownerPersonKnown = !!ctx.owner.person;
}

const evidenceOf = (m: Extract<Match, { status: "linked" }>): LinkEvidence => m.evidence[0] ?? "mxid";

interface PlanOpts {
  origin: string;
  /** Let a unique name LINK (meetings / tasks with `allowNameLinks`). */
  allowName?: boolean;
  /** Never link the owner (threads, emails). */
  excludeOwner?: boolean;
  /** Do not queue a review for this identity (bulk mail, big rooms). */
  noReview?: boolean;
  /** The skip reason to count when nothing links (default `no-person`). */
  noneReason?: string;
  /** Bulk-labelled mail: a planned link is also counted in `extra.bulkLinked` and sampled. */
  bulk?: boolean;
  evidence?: LinkEvidence;
}

/**
 * Plan one identity → link. A linked match becomes an addition (or
 * `alreadyLinked`); a review match is queued unless the owner already decided
 * this exact source + key.
 */
function planIdentity(ctx: Ctx, rep: PhaseReport, plan: Plan, source: Note, rel: string, q: IdentityQuery, seen: Set<string>, o: PlanOpts): "linked" | "review" | "none" {
  indexOf(ctx, source.id);
  const m: Match = ctx.idx.match(q, { allowName: o.allowName });
  if (m.status === "linked") {
    if (o.excludeOwner && ctx.owner.person && m.person.id === ctx.owner.person.id) {
      bump(rep, "owner");
      return "none";
    }
    if (m.person.id === source.id || seen.has(m.person.id)) return "linked";
    seen.add(m.person.id);
    if (hasOut(source, m.person.id, rel)) {
      rep.alreadyLinked++;
      // The question a queued row asked has been answered by the link itself.
      if (!ctx.job.dryRun) closeCandidatesLinked(ctx.job.vaultId, source.id, rel, m.person.id);
      return "linked";
    }
    // The owner dismissed exactly this identity for this note → leave it alone.
    const key: IdentityKey | NameKey | undefined = IdentityIndex.queryKeys(q)[0] ?? (q.name ? { kind: "name", value: slugKey(cleanName(q.name)) } : undefined);
    if (key && candidateStatus(ctx.job.vaultId, source.id, rel, key) === "dismissed") {
      bump(rep, "dismissed");
      return "none";
    }
    if (plan.add(source.id, { target: m.person.id, relationship: rel })) {
      rep.wouldLink++;
      const ev = o.evidence ?? evidenceOf(m);
      rep.byEvidence[ev] = (rep.byEvidence[ev] ?? 0) + 1;
      if (o.bulk) {
        extra(rep, "bulkLinked");
        sampleOf(rep.sample.bulk, source.id);
      }
    }
    sampleOf(rep.sample.link, source.id);
    return "linked";
  }
  if (m.status === "review") {
    // The same person already linked from this record (their address AND their name are both listed).
    if (m.reason === "name-only" && m.candidates.length === 1 && seen.has(m.candidates[0]!.id)) return "linked";
    if (o.noReview) {
      bump(rep, o.noneReason ?? "no-exact-match");
      return "none";
    }
    queueReview(ctx, rep, source.id, rel, m.key, m.reason, m.candidates.map((c) => c.id), q.name ? cleanName(q.name) : null, o.origin);
    return "review";
  }
  bump(rep, m.claimed ? "claimed-by-non-person" : (o.noneReason ?? "no-person"));
  return "none";
}

/**
 * Remember a review item. Nothing is counted or written yet: `flushReviews`
 * does that once the phase's writes are known, so a capped run only queues what
 * lies inside the window it actually processed.
 */
function queueReview(ctx: Ctx, _rep: PhaseReport, sourceId: string, rel: string, key: IdentityKey | NameKey, reason: string, candidateIds: string[], display: string | null, origin: string): void {
  ctx.pending.push({ index: indexOf(ctx, sourceId), sourceId, rel, key, reason, candidateIds, display, origin });
}

function flushReviews(ctx: Ctx, rep: PhaseReport): void {
  for (const r of ctx.pending) {
    if (r.index >= ctx.firstDeferred) {
      extra(rep, "reviewsBeyondWindow"); // the next run reaches them
      continue;
    }
    const decided = candidateStatus(ctx.job.vaultId, r.sourceId, r.rel, r.key);
    if (decided && decided !== "open") {
      bump(rep, decided === "dismissed" ? "dismissed" : "already-reviewed");
      continue;
    }
    rep.queued++;
    rep.queuedByReason[r.reason] = (rep.queuedByReason[r.reason] ?? 0) + 1;
    sampleOf(rep.sample.review, r.sourceId);
    if (!ctx.enqueue) continue;
    const res = enqueueCandidate({ vaultId: ctx.job.vaultId, sourceNoteId: r.sourceId, relationship: r.rel, key: r.key, display: r.display, candidateIds: r.candidateIds, reason: r.reason, origin: r.origin });
    if (res === "created") ctx.job.queuedNew++;
    else if (res === "full") bump(rep, "queue-full");
  }
  ctx.pending = [];
}

const oversized = (ctx: Ctx, id: string): boolean => (ctx.sizes.get(id) ?? 0) > HISTORY_MAX_BYTES;

// ── phases ───────────────────────────────────────────────────────────────────

/** Move every link a tombstone holds onto its canonical person (direction preserved). */
function repointStub(ctx: Ctx, rep: PhaseReport, plan: Plan, g: Map<string, Note>, stub: Note, canonical: Note): void {
  const c = g.get(canonical.id) ?? canonical;
  const s = g.get(stub.id) ?? stub;
  const seen = new Set<string>();
  for (const l of s.links ?? []) {
    const k = edgeKey(l.sourceId, l.targetId, l.relationship);
    if (seen.has(k)) continue;
    seen.add(k);
    const outgoing = l.sourceId === stub.id;
    const other = outgoing ? l.targetId : l.sourceId;
    if (other === canonical.id || other === stub.id) {
      bump(rep, "stub-to-canonical");
      continue;
    }
    if (hasLinkMetadata(l)) {
      bump(rep, "link-metadata");
      continue;
    }
    const managed = VAULT_MANAGED.has(l.relationship);
    const rel = managed ? REL.REFERENCES : l.relationship;
    if (outgoing) {
      // stub → Y becomes canonical → Y (never satisfied by a Y → canonical link).
      const exists = hasOut(c, other, rel);
      if (exists) rep.alreadyLinked++;
      else if (oversized(ctx, canonical.id)) {
        bump(rep, "oversize");
        continue;
      } else if (plan.add(canonical.id, { target: other, relationship: rel })) {
        rep.wouldLink++;
        rep.byEvidence.path = (rep.byEvidence.path ?? 0) + 1;
      }
      if (!managed && plan.remove(stub.id, { target: other, relationship: l.relationship }, exists ? undefined : canonical.id)) rep.wouldUnlink++;
      sampleOf(rep.sample.link, canonical.id);
    } else {
      // X → stub becomes X → canonical, written on X in one PATCH.
      const x = g.get(other);
      if (!x) {
        bump(rep, "source-missing");
        continue;
      }
      if (oversized(ctx, other)) {
        bump(rep, "oversize");
        continue;
      }
      if (hasOut(x, canonical.id, rel)) rep.alreadyLinked++;
      else if (plan.add(other, { target: canonical.id, relationship: rel })) {
        rep.wouldLink++;
        rep.byEvidence.path = (rep.byEvidence.path ?? 0) + 1;
      }
      if (!managed && plan.remove(other, { target: stub.id, relationship: l.relationship })) rep.wouldUnlink++;
      sampleOf(rep.sample.link, other);
    }
  }
}

async function planOwner(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const plan = new Plan();
  rep.scanned = 1;
  const owner = ctx.owner.person;
  if (!owner) {
    bump(rep, "owner-unresolved");
    return plan;
  }
  const configured = ctx.opts.owner.person ? ctx.idx.get(ctx.opts.owner.person) : null;
  if (configured && configured.id !== owner.id) extra(rep, "configuredNoteIsMerged");
  // 1) The owner's addresses and aliases, appended to their note (never replacing anything).
  let working: Note = { ...owner, metadata: { ...(owner.metadata ?? {}) } };
  const patch: Record<string, unknown> = {};
  const want: Array<{ key: IdentityKey | NameKey; display?: string }> = [
    ...ctx.opts.owner.emails.filter(looksLikeEmail).map((e) => ({ key: { kind: "email" as const, value: e.trim().toLowerCase() } })),
    ...(ctx.opts.owner.aliases ?? []).filter((a) => !looksLikeEmail(a) && slugKey(a)).map((a) => ({ key: { kind: "name" as const, value: slugKey(a) }, display: a })),
  ];
  for (const w of want) {
    if (w.key.kind !== "name") {
      const others = ctx.idx.claimants(w.key).filter((p) => p.id !== owner.id);
      if (others.length || ctx.idx.claimedBy(w.key).length) {
        bump(rep, "owner-key-claimed-elsewhere");
        continue;
      }
    }
    const r = addKeyPatch(working, w.key, w.display);
    if (r.skipped) bump(rep, "unexpected-type");
    if (!r.patch) continue;
    Object.assign(patch, r.patch);
    working = { ...working, metadata: mergePatch(working.metadata, r.patch) };
    extra(rep, "identitiesAdded");
  }
  if (Object.keys(patch).length) {
    plan.metadata(owner.id, patch);
    sampleOf(rep.sample.link, owner.id);
  }
  // 2) Links still held by the owner's own tombstones.
  const stubs = ctx.people.filter((p) => isTombstone(p) && ctx.idx.canonicalOf(p)?.id === owner.id);
  if (stubs.length) {
    const g = await graph(ctx);
    for (const s of stubs) {
      extra(rep, "ownerTombstones");
      repointStub(ctx, rep, plan, g, s, owner);
    }
  }
  // 3) Live notes that look like the owner are a MERGE decision, not a job's.
  const mine = new Set(ctx.idx.keysFor(owner.id).strong.map((k) => `${k.kind}\u0000${k.value}`));
  for (const p of ctx.idx.live()) if (p.id !== owner.id && personKeys(p).strong.some((k) => mine.has(`${k.kind}\u0000${k.value}`))) extra(rep, "ownerDuplicatesNeedingMerge");
  return plan;
}

/**
 * Repair DANGLING tombstones only. A stub is dangling when it names no target,
 * or names one that resolves to NOTHING in the whole vault. A stub whose target
 * exists but is not a live person (an organization or project note, a non-human
 * person note, another dead end) was merged there on purpose: it is left exactly
 * as it is and its links are never moved onto people.
 *
 * The only automatic repair is a STRONG key shared with exactly one live person;
 * a name match is a review item. The previous pointer is kept in
 * `prism_merged_into_prev`, the new one is the note ID, and a stub repaired in
 * this run is not repointed (or used for matching) until the next run.
 */
async function planTombstones(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const plan = new Plan();
  let byPath: Map<string, Note> | null = null;
  const inVault = async (ref: string): Promise<Note | null> => {
    const g = await graph(ctx);
    byPath ??= new Map([...g.values()].filter((n) => n.path).map((n) => [n.path!.toLowerCase(), n]));
    return g.get(ref) ?? byPath.get(ref.toLowerCase()) ?? byPath.get(`vault/people/${ref}`.toLowerCase()) ?? null;
  };
  for (const t of ctx.people) {
    if (cancelFlag) break;
    if (hasPointerWithoutMarker(t)) extra(rep, "pointerWithoutMarker");
    if (!isTombstone(t)) continue;
    rep.scanned++;
    if (ctx.idx.canonicalOf(t)) {
      extra(rep, "resolvable");
      continue;
    }
    const ref = mergedIntoRef(t);
    if (ref && (await inVault(ref))) {
      // It points at something real that is not a live person. Not broken — not ours to change.
      extra(rep, "leftTargetNotAPerson");
      bump(rep, "target-not-a-live-person");
      continue;
    }
    const keys = personKeys(t);
    const strong = new Map<string, { person: Note; kind: Evidence }>();
    for (const k of keys.strong) {
      if (k.kind === "matrix" && k.value.startsWith("!")) continue;
      for (const p of ctx.idx.claimants(k)) if (p.id !== t.id) strong.set(p.id, { person: p, kind: k.kind === "matrix" ? "mxid" : k.kind });
    }
    if (strong.size === 1) {
      const target = [...strong.values()][0]!;
      const prev = typeof t.metadata?.merged_into === "string" && t.metadata.merged_into.trim() ? t.metadata.merged_into : null;
      plan.metadata(t.id, { merged_into: target.person.id, ...(prev ? { prism_merged_into_prev: prev } : {}) });
      ctx.repaired.add(t.id);
      indexOf(ctx, t.id);
      extra(rep, "repaired");
      rep.byEvidence[target.kind] = (rep.byEvidence[target.kind] ?? 0) + 1;
      sampleOf(rep.sample.link, t.id);
      continue;
    }
    // No single strong match. A name is only ever a suggestion for the reviewer.
    let candidates: Note[] = [...strong.values()].map((x) => x.person);
    if (!candidates.length) {
      const named = new Map<string, Note>();
      for (const nm of keys.names) {
        if (nm.split("-").length < 2) continue;
        for (const p of ctx.idx.named(nm)) if (p.id !== t.id && ctx.idx.keysFor(p.id).names.includes(nm)) named.set(p.id, p);
      }
      candidates = [...named.values()];
    }
    const key: IdentityKey | NameKey = keys.strong.find((k) => !(k.kind === "matrix" && k.value.startsWith("!"))) ?? { kind: "name", value: keys.names[0] ?? slugKey(t.path ?? t.id) };
    const display = typeof t.metadata?.name === "string" ? t.metadata.name : (t.path?.split("/").pop() ?? null);
    queueReview(ctx, rep, t.id, "merged-into", key, "tombstone-unresolved", candidates.map((c) => c.id).sort(), display, "backfill:tombstones");
  }
  return plan;
}

async function planRepoint(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const g = await graph(ctx);
  const plan = new Plan();
  for (const stub of ctx.people) {
    if (cancelFlag) break;
    if (!isTombstone(stub)) continue;
    rep.scanned++;
    if (ctx.repaired.has(stub.id)) {
      bump(rep, "repaired-this-run"); // reviewed first; a later run moves its links
      continue;
    }
    const canonical = ctx.idx.canonicalOf(stub);
    if (!canonical) {
      bump(rep, "no-canonical");
      continue;
    }
    repointStub(ctx, rep, plan, g, stub, canonical);
  }
  return plan;
}

async function planEmails(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const notes = await list(ctx, { tags: ["email"], includeLinks: true, includeMetadata: ["from", "to", "labels"] });
  const plan = new Plan();
  const o: PlanOpts = { origin: "backfill:emails", excludeOwner: true };
  for (const n of notes) {
    if (cancelFlag) break;
    rep.scanned++;
    if (oversized(ctx, n.id)) {
      bump(rep, "oversize");
      continue;
    }
    const bulk = strings(n.metadata?.labels).some((l) => BULK_LABELS.has(l.toUpperCase()));
    const seen = new Set<string>();
    const from = addressList(n.metadata?.from)[0];
    /** A role mailbox (no-reply, team@, support@ …) is never a person, whoever's note holds the address. */
    const role = (email: string, rel: string): boolean => {
      if (!isNonhumanEmail(email)) return false;
      if (ctx.idx.match({ email }).status === "linked") {
        bump(rep, "role-address-claimed");
        sampleOf(rep.sample.role, n.id);
      } else bump(rep, rel === REL.EMAIL_FROM ? "role-sender" : "role-recipient");
      return true;
    };
    if (!from) bump(rep, "no-sender");
    else if (ctx.owner.emails.has(from.email)) bump(rep, "owner");
    else if (role(from.email, REL.EMAIL_FROM)) {
      /* counted above */
    } else if (bulk) {
      // Bulk mail: ONLY an exact address held by one live person links (owner decision) —
      // counted and sampled separately, and switchable off per run.
      if (ctx.opts.excludeBulkLinks) bump(rep, "bulk-label");
      else planIdentity(ctx, rep, plan, n, REL.EMAIL_FROM, { email: from.email }, seen, { ...o, noReview: true, noneReason: "bulk-label", bulk: true });
    } else planIdentity(ctx, rep, plan, n, REL.EMAIL_FROM, { email: from.email, name: from.name || null }, seen, o);

    if (bulk) continue; // a mailing's recipient list is not a conversation
    const to = addressList(n.metadata?.to);
    if (to.length > ctx.limits.maxRecipients) {
      bump(rep, "too-many-recipients");
      continue;
    }
    for (const r of to) {
      if (ctx.owner.emails.has(r.email)) continue; // the owner is every inbound mail's recipient
      if (role(r.email, REL.EMAIL_TO)) continue;
      planIdentity(ctx, rep, plan, n, REL.EMAIL_TO, { email: r.email, name: r.name || null }, seen, o);
    }
  }
  return plan;
}

/** An `attendees` entry: an address, "Name <address>", or a display name. */
function attendeeQueries(md: Record<string, unknown>): IdentityQuery[] {
  const emails = new Set(strings(md.attendeeEmails).map((e) => e.trim().toLowerCase()).filter(looksLikeEmail));
  const names: string[] = [];
  const raw = typeof md.attendees === "string" ? md.attendees.split(/[,;\n]/) : strings(md.attendees);
  for (const a of raw.map((s) => s.trim()).filter(Boolean)) {
    if (looksLikeEmail(a)) emails.add(a.toLowerCase());
    else if (a.includes("<") && a.includes("@")) {
      const parsed = addressList(a)[0];
      if (parsed) emails.add(parsed.email);
      else names.push(a);
    } else names.push(a);
  }
  return [...[...emails].map((email) => ({ email })), ...names.map((name) => ({ name }))];
}

async function planMeetings(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const meta = ["attendees", "attendeeEmails"];
  const meetings = await list(ctx, { tags: ["meeting"], includeLinks: true, includeMetadata: meta });
  const transcripts = await list(ctx, { tags: ["transcript"], includeLinks: true, includeMetadata: meta });
  const seenNotes = new Set<string>();
  const notes = [...meetings, ...transcripts].filter((n) => !seenNotes.has(n.id) && seenNotes.add(n.id));
  const plan = new Plan();
  const o: PlanOpts = { origin: "backfill:meetings", allowName: ctx.job.allowNameLinks };
  for (const n of notes) {
    if (cancelFlag) break;
    rep.scanned++;
    const qs = attendeeQueries(n.metadata ?? {});
    if (!qs.length) {
      bump(rep, "no-attendees");
      continue;
    }
    if (oversized(ctx, n.id)) {
      bump(rep, "oversize");
      continue;
    }
    const seen = new Set<string>();
    for (const q of qs) {
      if (q.email && NON_PERSON_DOMAINS.test(q.email)) {
        bump(rep, "role-attendee");
        continue;
      }
      // Calendar ingest links the owner too (their own attendee entry) — same here.
      const me = ownerMatch(ctx.owner, q); // multi-word names only: a first name in an attendee list could be anybody
      if (me) {
        if (!ctx.owner.person) bump(rep, "owner-unresolved");
        else planIdentity(ctx, rep, plan, n, REL.ATTENDED_BY, { ref: ctx.owner.person.id }, seen, { ...o, evidence: me });
        continue;
      }
      if (q.email && isNonhumanEmail(q.email)) {
        // A role mailbox is never a person, whoever's note holds the address.
        if (ctx.idx.match({ email: q.email }).status === "linked") {
          bump(rep, "role-address-claimed");
          sampleOf(rep.sample.role, n.id);
        } else bump(rep, "role-attendee");
        continue;
      }
      if (q.name && creationRefusal(q.name)) {
        bump(rep, "not-a-name");
        continue;
      }
      planIdentity(ctx, rep, plan, n, REL.ATTENDED_BY, q, seen, o);
    }
  }
  return plan;
}

async function planThreads(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const notes = await list(ctx, { tags: ["message-thread"], includeLinks: true, includeMetadata: ["participants", "participantIds", "matrixRoomId"] });
  const plan = new Plan();
  const L = ctx.limits;
  const sized = notes
    .filter((n) => !(n.tags ?? []).includes("message-archive"))
    .map((n) => {
      const md = n.metadata ?? {};
      const names = typeof md.participants === "string" ? md.participants.split(",").map((s) => s.trim()).filter(Boolean) : strings(md.participants);
      const ids = strings(md.participantIds).filter((s) => s.startsWith("@"));
      return { n, names, ids, size: ids.length || names.length };
    })
    // DMs and small rooms first: they spend the write cap and the lookup budget.
    .sort((a, b) => a.size - b.size || a.n.id.localeCompare(b.n.id));
  for (const t of sized) {
    if (cancelFlag) break;
    rep.scanned++;
    const { n } = t;
    if (oversized(ctx, n.id)) {
      bump(rep, "oversize");
      continue;
    }
    let members: Array<{ mxid: string | null; name: string | null }> = t.ids.map((mxid) => ({ mxid, name: null }));
    const roomId = typeof n.metadata?.matrixRoomId === "string" ? n.metadata.matrixRoomId : null;
    let lookedUp: string[] | null = null;
    if (!members.length && roomId && ctx.opts.members) {
      // The lookup is how a thread gets ids. When it cannot answer, the thread
      // WAITS for a later run — it never falls back to display names.
      if (t.size > L.groupMaxMembers) {
        bump(rep, "large-group");
        continue;
      }
      if (ctx.lookup.broken) {
        bump(rep, "lookup-unavailable");
        continue;
      }
      if (ctx.job.memberLookups >= L.memberLookups) {
        bump(rep, "lookup-budget");
        continue;
      }
      ctx.job.memberLookups++;
      let got: Record<string, string> | null = null;
      try {
        got = await timed(ctx, ctx.opts.members(roomId));
        ctx.lookup.failures = 0;
      } catch {
        // 429 / 5xx / timeout: after N in a row the homeserver is left alone for this run.
        if (++ctx.lookup.failures >= (ctx.opts.memberFailures ?? 3)) {
          ctx.lookup.broken = true;
          extra(rep, "lookupBreaker");
        }
      }
      if (L.memberPaceMs) await new Promise((r) => setTimeout(r, L.memberPaceMs));
      if (!got || !Object.keys(got).length) {
        bump(rep, "lookup-failed");
        continue;
      }
      // The REAL member count decides: a big room gets neither links nor ids.
      if (Object.keys(got).length > L.groupMaxMembers) {
        bump(rep, "large-group");
        continue;
      }
      members = Object.entries(got).map(([mxid, name]) => ({ mxid, name: name || null }));
      lookedUp = Object.keys(got);
    }
    if (!members.length) members = t.names.map((name) => ({ mxid: null, name }));
    if (!members.length) {
      bump(rep, "no-participants");
      continue;
    }
    const size = members.length;
    if (size > L.groupMaxMembers) {
      bump(rep, "large-group");
      continue;
    }
    // Ids we just fetched are kept (in the same write as any link), so the room is not asked again.
    if (lookedUp) {
      indexOf(ctx, n.id);
      plan.metadata(n.id, { participantIds: lookedUp });
      extra(rep, "idsBackfilled");
    }
    const small = size <= L.groupNameMax;
    const cap = size > 3 ? L.groupLinkCap : Infinity;
    const seen = new Set<string>();
    let namesSkipped = false;
    for (const m of members) {
      if (m.mxid && (isBridgeBotId(m.mxid) || ctx.owner.matrixIds.has(m.mxid.toLowerCase()))) continue;
      if (m.name && looksLikeBotName(m.name)) continue;
      if (seen.size >= cap) {
        bump(rep, "group-link-cap");
        break;
      }
      // A display name NEVER links a thread: with an id it only helps the review
      // row; alone it is a review item in a small room and nothing in a big one.
      if (m.mxid) {
        planIdentity(ctx, rep, plan, n, REL.MESSAGES_WITH, { matrixId: m.mxid, name: small ? m.name : null }, seen, { origin: "backfill:threads", excludeOwner: true, noReview: !small });
        continue;
      }
      if (!small) {
        namesSkipped = true;
        continue;
      }
      if (!m.name || ownerMatch(ctx.owner, { name: m.name }, { singleToken: true }) || creationRefusal(m.name)) continue;
      planIdentity(ctx, rep, plan, n, REL.MESSAGES_WITH, { name: m.name }, seen, { origin: "backfill:threads", excludeOwner: true });
    }
    if (namesSkipped) bump(rep, "group-names-only");
  }
  return plan;
}

const GENERIC_LEAF = new Set(["index", "readme", "_index", "overview", "home"]);

/** Exact project lookup: [[path]] / path / id, else a unique name, slug or alias. */
function projectIndex(projects: Note[]) {
  const byRef = new Map<string, Note>();
  const bySlug = new Map<string, Map<string, Note>>();
  const put = (k: string, n: Note) => {
    if (!k) return;
    const b = bySlug.get(k) ?? new Map<string, Note>();
    b.set(n.id, n);
    bySlug.set(k, b);
  };
  for (const p of projects) {
    byRef.set(p.id, p);
    if (p.path) byRef.set(p.path.toLowerCase(), p);
    const segs = (p.path ?? "").split("/").filter(Boolean);
    const leaf = segs.at(-1) ?? "";
    put(slugKey(GENERIC_LEAF.has(leaf.toLowerCase()) ? (segs.at(-2) ?? "") : leaf), p);
    const md = p.metadata ?? {};
    // A PROJECT's `title` is its name (unlike a person's, which is a job title).
    for (const v of [...strings(md.name), ...strings(md.title), ...strings(md.slug), ...strings(md.aliases).flatMap((s) => s.split(","))]) put(slugKey(v), p);
  }
  return (raw: string): Note | "ambiguous" | null => {
    const v = raw.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0]!.trim();
    if (!v) return null;
    const exact = byRef.get(v) ?? byRef.get(v.toLowerCase());
    if (exact) return exact;
    const b = bySlug.get(slugKey(v.split("/").filter(Boolean).at(-1) ?? v));
    if (!b?.size) return null;
    return b.size === 1 ? [...b.values()][0]! : "ambiguous";
  };
}

/** `assigned` values: CSV, " & ", " and ", wikilinks kept whole. */
function assigneeValues(md: Record<string, unknown>): string[] {
  const raw = [...strings(md.assigned), ...strings(md.assignee), ...strings(md.assigneeEmail), ...strings(md.assignee_email)];
  return raw
    .flatMap((s) => s.match(/\[\[[^\]]*\]\]|[^,;&]+/g) ?? [])
    .flatMap((s) => (s.includes("[[") ? [s] : s.split(/\s+and\s+/i)))
    .map((s) => s.trim())
    .filter(Boolean);
}

async function planTasks(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const tasks = await list(ctx, { tags: ["task"], includeLinks: true, includeMetadata: ["assigned", "assignee", "assigneeEmail", "assignee_email", "project"] });
  const projects = await list(ctx, { tags: ["project"], includeMetadata: ["name", "title", "slug", "aliases"] });
  const findProject = projectIndex(projects);
  const plan = new Plan();
  const o: PlanOpts = { origin: "backfill:tasks", allowName: ctx.job.allowNameLinks };
  for (const n of tasks) {
    if (cancelFlag) break;
    rep.scanned++;
    if (oversized(ctx, n.id)) {
      bump(rep, "oversize");
      continue;
    }
    const md = n.metadata ?? {};
    const seen = new Set<string>();
    for (const v of assigneeValues(md)) {
      const wikilink = v.startsWith("[[");
      const q: IdentityQuery = wikilink || v.startsWith("vault/") ? { ref: v } : looksLikeEmail(v) ? { email: v } : { name: v };
      // The owner's own tasks link to the owner: their address, their note's full
      // name, or a CONFIGURED alias (the only way a first name can mean them).
      const me = ownerMatch(ctx.owner, q, { singleToken: true });
      if (me) {
        if (!ctx.owner.person) bump(rep, "owner-unresolved");
        else planIdentity(ctx, rep, plan, n, REL.ASSIGNED_TO, { ref: ctx.owner.person.id }, seen, { ...o, evidence: me === "path" && wikilink ? "wikilink" : me });
        continue;
      }
      if (q.ref) {
        // `[[Name]]` / a path: a reference to exactly ONE person note (path, leaf, or unique exact name).
        planIdentity(ctx, rep, plan, n, REL.ASSIGNED_TO, q, seen, { ...o, evidence: wikilink ? "wikilink" : "path", noneReason: "reference-unresolved" });
        continue;
      }
      if (q.name && nameTokens(q.name).length === 0) {
        bump(rep, "not-a-name");
        continue;
      }
      planIdentity(ctx, rep, plan, n, REL.ASSIGNED_TO, q, seen, o);
    }
    const project = typeof md.project === "string" ? md.project.trim() : "";
    if (project) {
      const p = findProject(project);
      if (p === "ambiguous") bump(rep, "project-ambiguous");
      else if (!p) bump(rep, "project-unknown");
      else if (p.id === n.id) continue;
      else if (hasOut(n, p.id, REL.BELONGS_TO)) rep.alreadyLinked++;
      else {
        if (plan.add(n.id, { target: p.id, relationship: REL.BELONGS_TO })) {
          rep.wouldLink++;
          rep.byEvidence.project = (rep.byEvidence.project ?? 0) + 1;
        }
        sampleOf(rep.sample.link, n.id);
      }
    }
  }
  return plan;
}

async function planNormalize(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const g = await graph(ctx);
  const plan = new Plan();
  rep.byName = {};
  rep.untouched = {};
  for (const n of g.values()) {
    if (cancelFlag) break;
    rep.scanned++;
    for (const l of n.links ?? []) {
      if (l.sourceId !== n.id) continue;
      const target = g.get(l.targetId);
      if (!target) continue;
      const norm = classifyRelationship(l.relationship, noteKinds(n), noteKinds(target));
      if (!norm) continue;
      if ("untouched" in norm) {
        rep.untouched[l.relationship] = (rep.untouched[l.relationship] ?? 0) + 1;
        bump(rep, norm.untouched);
        continue;
      }
      // A link that carries its own data is never re-created (the copy would lose it).
      if (hasLinkMetadata(l)) {
        bump(rep, "link-metadata");
        continue;
      }
      const [from, to] = norm.reversed ? [target, n] : [n, target];
      if (oversized(ctx, from.id) || oversized(ctx, n.id)) {
        bump(rep, "oversize");
        continue;
      }
      rep.byName[l.relationship] = (rep.byName[l.relationship] ?? 0) + 1;
      const exists = hasOut(from, to.id, norm.canonical);
      if (exists) rep.alreadyLinked++;
      else if (plan.add(from.id, { target: to.id, relationship: norm.canonical })) rep.wouldLink++;
      // Same note → one write; the other note → only after its addition landed.
      if (plan.remove(n.id, { target: l.targetId, relationship: l.relationship }, from.id === n.id || exists ? undefined : from.id)) rep.wouldUnlink++;
      sampleOf(rep.sample.link, from.id);
    }
  }
  return plan;
}

// ── applying ────────────────────────────────────────────────────────────────

async function apply(ctx: Ctx, rep: PhaseReport, plan: Plan): Promise<void> {
  const concurrency = Math.max(1, Math.min(2, ctx.opts.concurrency ?? 2));
  const paceMs = Math.max(0, ctx.opts.paceMs ?? 50);
  const maxErrors = ctx.opts.maxConsecutiveErrors ?? 5;
  const failed = new Set<string>();
  const planned = new Set<string>(); // a note written in both waves is ONE note to write
  const written = new Set<string>();
  let abort: Error | null = null;
  // Wave 1: everything without a cross-note dependency. Wave 2: removals that
  // wait for another note's addition (a failed or deferred addition blocks them).
  const wave1: Op[] = [];
  const wave2: Op[] = [];
  // Scan order: a capped run writes (and queues reviews for) the FRONT of the phase.
  for (const o of plan.list().sort((a, b) => indexOf(ctx, a.noteId) - indexOf(ctx, b.noteId))) {
    const free = o.remove.filter((r) => !r.requires);
    const dep = o.remove.filter((r) => r.requires);
    if (o.add.length || free.length || o.metadata) wave1.push({ ...o, remove: free });
    if (dep.length) wave2.push({ noteId: o.noteId, add: [], remove: dep });
  }
  const runWave = async (wave: Op[], second: boolean) => {
    let next = 0;
    const worker = async () => {
      while (!cancelFlag && !abort) {
        const i = next++;
        if (i >= wave.length) return;
        const o = wave[i]!;
        const remove = second ? o.remove.filter((r) => !failed.has(r.requires!)) : o.remove;
        if (!o.add.length && !remove.length && !o.metadata) {
          // Every removal here waited on an addition that did not land.
          if (o.remove.length) rep.deferred++;
          continue;
        }
        const ifUpdatedAt = ctx.stamps.get(o.noteId);
        if (!ifUpdatedAt) {
          // No version to compare against → never a blind (force) write.
          bump(rep, "no-stamp");
          failed.add(o.noteId);
          continue;
        }
        if (!planned.has(o.noteId)) {
          planned.add(o.noteId);
          rep.notesToWrite++;
        }
        if (ctx.job.maxWrites && ctx.job.writes >= ctx.job.maxWrites) {
          ctx.job.capped = true;
          rep.deferred++;
          failed.add(o.noteId);
          ctx.firstDeferred = Math.min(ctx.firstDeferred, indexOf(ctx, o.noteId));
          continue;
        }
        ctx.job.writes++;
        const removed = remove.map((r) => r.link);
        if (ctx.job.dryRun) {
          applyLocally(ctx, { ...o, remove }, removed, undefined);
          continue;
        }
        try {
          const liveBefore = ctx.opts.live?.isLive(o.noteId) ?? false;
          const links = { ...(o.add.length ? { add: o.add } : {}), ...(removed.length ? { remove: removed } : {}) };
          const updated = await timed(
            ctx,
            ctx.vault.updateNote(o.noteId, { ...(Object.keys(links).length ? { links } : {}), ...(o.metadata ? { metadata: o.metadata } : {}), ifUpdatedAt }),
          );
          // Checked again AFTER the write: an editor may have opened the note meanwhile.
          if (liveBefore || (ctx.opts.live?.isLive(o.noteId) ?? false)) {
            // The vault version moved but the content did not: tell the collab
            // reconciler, or it folds the stored body over unsaved typing.
            ctx.job.liveNotes++;
            const prev = Date.parse(ifUpdatedAt), nextMs = Date.parse(updated?.updatedAt ?? "");
            if (Number.isFinite(prev) && Number.isFinite(nextMs)) ctx.opts.live!.markReconciled(o.noteId, prev, nextMs);
          }
          ctx.consecutiveErrors = 0;
          applyLocally(ctx, { ...o, remove }, removed, updated?.updatedAt ?? null);
          if (!written.has(o.noteId)) {
            written.add(o.noteId);
            rep.notesWritten++;
          }
          rep.linked += o.add.length;
          rep.unlinked += removed.length;
          // A link that landed answers any open review row that asked about that person.
          for (const a of o.add) closeCandidatesLinked(ctx.job.vaultId, o.noteId, a.relationship, a.target);
          ctx.opts.onWrite?.();
        } catch (e) {
          failed.add(o.noteId);
          const s = statusOf(e);
          if (s === 409 || s === 428) rep.conflicts++;
          else if (s === 413) rep.oversize++;
          else {
            rep.errors++;
            if (maxErrors && ++ctx.consecutiveErrors >= maxErrors) abort = new JobAbort(`aborted after ${ctx.consecutiveErrors} consecutive failed writes (last: ${s ? `vault HTTP ${s}` : "no response"})`);
          }
        }
        if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (abort) throw abort;
  };
  await runWave(wave1, false);
  await runWave(wave2, true);
}

// ── the run ─────────────────────────────────────────────────────────────────

const PLANNERS: Record<Phase, (ctx: Ctx, rep: PhaseReport) => Promise<Plan>> = {
  owner: planOwner,
  tombstones: planTombstones,
  repoint: planRepoint,
  emails: planEmails,
  meetings: planMeetings,
  threads: planThreads,
  tasks: planTasks,
  normalize: planNormalize,
};

async function run(vault: LinkJobVault, job: LinkJob, opts: LinkJobOptions): Promise<void> {
  const ctx: Ctx = {
    vault,
    job,
    opts,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    idx: new IdentityIndex(),
    people: [],
    owner: { person: null, emails: new Set(), fullNames: new Set(), aliases: new Set(), matrixIds: new Set() },
    enqueue: opts.enqueue === true,
    stamps: new Map(),
    sizes: new Map(),
    graph: null,
    overlay: { add: [], remove: new Set() },
    consecutiveErrors: 0,
    timeoutMs: Math.max(0, opts.callTimeoutMs ?? 30_000),
    order: new Map(),
    pending: [],
    firstDeferred: Infinity,
    repaired: new Set(),
    lookup: { failures: 0, broken: false },
  };
  const loaded = opts.people ? await timed(ctx, opts.people()) : await list(ctx, { tags: ["person"], includeLinks: true, includeMetadata: PERSON_IDENTITY_KEYS });
  ctx.people = loaded.filter((n) => (n.tags ?? []).includes("person"));
  remember(ctx, ctx.people);
  rebuildIdentity(ctx);
  for (const phase of job.phases) {
    if (cancelFlag) return;
    const rep = job.report[phase];
    rep.status = "running";
    ctx.order = new Map();
    ctx.pending = [];
    ctx.firstDeferred = Infinity;
    const plan = await PLANNERS[phase](ctx, rep);
    if (cancelFlag) return;
    await apply(ctx, rep, plan);
    if (cancelFlag) return;
    flushReviews(ctx, rep);
    // The owner's own identities are configuration, so later phases see them. A
    // tombstone REPAIR is not used for matching or repointing until the next run.
    if (phase === "owner") rebuildIdentity(ctx);
    rep.status = "done";
  }
}

// ── outcome (health) ────────────────────────────────────────────────────────

export interface LinkJobOutcome {
  jobId: string;
  at: string;
  dryRun: boolean;
  status: LinkJob["status"];
  error: string | null;
  writes: number;
  linked: number;
  queued: number;
  /** Consecutive runs that ended in `error`. */
  failStreak: number;
  lastSuccessAt: string | null;
}

const OUTCOME_CURSOR = "people-link-last-job";

/** The last job's outcome for a vault (survives restarts; read by worker/health.ts). */
export function lastLinkJobOutcome(vaultId: string): LinkJobOutcome | null {
  const raw = getWorkerCursor(vaultId, OUTCOME_CURSOR);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LinkJobOutcome;
  } catch {
    return null;
  }
}

function persistOutcome(job: LinkJob): void {
  try {
    const prev = lastLinkJobOutcome(job.vaultId);
    const ok = job.status !== "error";
    const sum = (k: "linked" | "queued") => job.phases.reduce((n, p) => n + job.report[p][k], 0);
    const out: LinkJobOutcome = {
      jobId: job.id,
      at: job.endedAt ?? new Date().toISOString(),
      dryRun: job.dryRun,
      status: job.status,
      error: job.error,
      writes: job.dryRun ? 0 : job.writes,
      linked: sum("linked"),
      queued: sum("queued"),
      failStreak: ok ? 0 : (prev?.failStreak ?? 0) + 1,
      lastSuccessAt: ok ? (job.endedAt ?? new Date().toISOString()) : (prev?.lastSuccessAt ?? null),
    };
    setWorkerCursor(job.vaultId, OUTCOME_CURSOR, JSON.stringify(out));
  } catch (e) {
    console.warn(`[people-link] could not record the job outcome: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
}
