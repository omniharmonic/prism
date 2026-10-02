/**
 * The people-linking BACKFILL job — connects existing records to the people
 * they are about, with the conservative identity rules of src/identity.ts.
 * Cloned from the wikilinks job (src/wikilinks-job.ts): server-owner only
 * (routes/people-admin.ts), DRY RUN unless `dryRun: false`, one job at a time,
 * cancellable, progress + result via GET, one `action_audit` row (counts only)
 * when a write run ends.
 *
 * PHASES (each selectable; run in this order):
 *   repoint   — links held by a merged person stub (`merged-stub`, `merged_into`)
 *               move to its canonical person: the same relationship is added on
 *               the canonical side and removed from the stub. A vault-managed
 *               `wikilink` can't move (the vault re-derives it from content), so
 *               the canonical person gets a `references` link beside it.
 *   emails    — `email-from` (sender) and `email-to` (direct `To` recipients, at
 *               most PEOPLE_LINK_MAX_RECIPIENTS). Never the owner's own
 *               addresses, never role / no-reply senders (the desktop's rule),
 *               never mail labelled BULK / AUTOMATED / PROMOTIONS.
 *   meetings  — `attended-by` from `attendees` / `attendeeEmails` on meetings
 *               and transcripts: address first, then the name rule. The owner IS
 *               linked when known — the calendar ingest's existing convention.
 *   threads   — `messages-with`: by Matrix membership (stored `participantIds`,
 *               else an injected, paced, budgeted membership lookup) or by the
 *               display-name rule. Small rooms first. Rooms over
 *               GROUP_MAX_MEMBERS are skipped; rooms over GROUP_NAME_MAX link
 *               strong-key matches only, at most GROUP_LINK_CAP each. Bridge bots
 *               and the owner are never linked.
 *   tasks     — `assigned-to` (from `assigned` / `assignee`; owner names come
 *               from configuration + the owner's person note) and `belongs-to`
 *               (from `project`, exact unique match only).
 *   normalize — long-tail relationship names → canonical (src/relationships.ts),
 *               add-canonical-then-remove-synonym, only where the endpoint kinds fit.
 *
 * SAFETY (every phase):
 *   - Lean listings only: never `include_content`, `include_metadata` limited to
 *     the keys the phase reads, one listing per tag (a full list WITH content
 *     once stalled the single-threaded vault). `repoint` and `normalize` each
 *     take one whole-vault lean listing (links + `type`) — they edit notes of
 *     any kind and need those notes' current version.
 *   - Links-only PATCH with `if_updated_at`; a 409 is counted, never forced.
 *   - An edge that already exists is skipped; a note with nothing new is not
 *     written (every PATCH is a history version). A second run converges to
 *     zero writes.
 *   - Removals happen only after the matching addition succeeded (a separate
 *     second wave), so a failure can never drop a link.
 *   - At most 2 writes in flight, paced; a hard per-run write cap (`maxWrites`;
 *     the rest is reported `deferred` and picked up by the next run).
 *   - Notes over the vault's 2 MB history ceiling are skipped (`oversize`):
 *     from the listing's `byteSize` when present, or the vault's 413.
 *   - Identities it will not link go to the review queue (write runs; a dry
 *     run only counts them), and an identity the owner DISMISSED never links.
 * A dry run plans exactly what a write run with the same options writes.
 */
import { randomUUID } from "node:crypto";
import type { Note, NoteLinkInput } from "./parachute";
import { IdentityIndex, cleanName, isOwnerQuery, isTombstone, looksLikeEmail, nameTokens, ownerProfile, slugKey, type IdentityQuery, type Match, type OwnerConfig, type OwnerProfile } from "./identity";
import { REL, VAULT_MANAGED, noteKinds, normalizeRelationship } from "./relationships";
import { PERSON_IDENTITY_KEYS } from "./people-metadata";
import { candidateStatus, enqueueCandidate } from "./identity-store";
import { getWorkerCursor, setWorkerCursor } from "./db";
import { creationRefusal, isNonhumanEmail } from "./worker/people";
import { parseAddressList } from "./worker/proton-parse";

export const PHASES = ["repoint", "emails", "meetings", "threads", "tasks", "normalize"] as const;
export type Phase = (typeof PHASES)[number];
export const isPhase = (p: unknown): p is Phase => typeof p === "string" && (PHASES as readonly string[]).includes(p);

export interface LinkJobVault {
  listNotes(opts: { tags?: string[]; includeLinks?: boolean; includeMetadata?: string[]; limit?: number }): Promise<Note[]>;
  updateNote(id: string, p: { links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] }; ifUpdatedAt?: string }): Promise<Note>;
}

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
  /** Identities sent to (write run) / that would go to (dry run) the review queue. */
  queued: number;
  skipped: Record<string, number>;
  /** Write runs only. */
  linked: number;
  unlinked: number;
  notesWritten: number;
  conflicts: number;
  errors: number;
  oversize: number;
  /** Planned writes not attempted: over the write cap, or behind a failed addition. */
  deferred: number;
  /** normalize: planned rewrites per long-tail name. */
  byName?: Record<string, number>;
  /** Note ids only — never titles, paths or addresses. */
  sample: { link: string[]; review: string[] };
}

export interface LinkJob {
  id: string;
  vaultId: string;
  dryRun: boolean;
  phases: Phase[];
  maxWrites: number;
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
  /** Put unresolved identities in the review queue (default: write runs only). */
  enqueue?: boolean;
  concurrency?: number;
  paceMs?: number;
  owner: OwnerConfig;
  limits?: Partial<LinkJobLimits>;
  /** Optional Matrix membership lookup (mxid → display name), paced + budgeted. */
  members?: (roomId: string) => Promise<Record<string, string> | null>;
  onEnd?: (job: LinkJob) => void;
}

const DEFAULT_LIMITS: LinkJobLimits = { groupNameMax: 8, groupMaxMembers: 50, groupLinkCap: 15, maxRecipients: 10, memberLookups: 300, memberPaceMs: 150 };
/** The vault refuses to update a note over this many bytes while history is on. */
export const HISTORY_MAX_BYTES = 2_000_000;
const INVENTORY_LIMIT = 50_000;
const SAMPLE = 20;
const BULK_LABELS = new Set(["BULK", "AUTOMATED", "PROMOTIONS", "CATEGORY_PROMOTIONS"]);
/** Calendar resources and group mailboxes are never people. */
const NON_PERSON_DOMAINS = /@(resource\.calendar\.google\.com|group\.calendar\.google\.com|.*\.calendar\.google\.com)$/i;
const isBridgeBotId = (mxid: string): boolean => mxid.includes("bot:") || mxid.startsWith("@_");
const looksLikeBotName = (n: string): boolean => /\b(bot|bridge)\b/i.test(n);

let current: LinkJob | null = null;
let cancelFlag = false;

export class LinkJobBusyError extends Error {}

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
    queued: 0,
    skipped: {},
    linked: 0,
    unlinked: 0,
    notesWritten: 0,
    conflicts: 0,
    errors: 0,
    oversize: 0,
    deferred: 0,
    sample: { link: [], review: [] },
  };
}

/**
 * Start a job (returns at once; `done` resolves when it ends — tests await it).
 * Throws LinkJobBusyError while another job runs.
 */
export function startLinkJob(vault: LinkJobVault, vaultId: string, opts: LinkJobOptions): { job: LinkJob; done: Promise<void> } {
  if (current?.status === "running") throw new LinkJobBusyError("a people-link job is already running");
  cancelFlag = false;
  const phases = opts.phases?.length ? PHASES.filter((p) => opts.phases!.includes(p)) : [...PHASES];
  const report = Object.fromEntries(PHASES.map((p) => [p, emptyReport(p, phases.includes(p))])) as Record<Phase, PhaseReport>;
  const job: LinkJob = {
    id: randomUUID(),
    vaultId,
    dryRun: opts.dryRun,
    phases,
    maxWrites: Math.max(0, Math.floor(opts.maxWrites ?? 0)),
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    writes: 0,
    capped: false,
    queuedNew: 0,
    memberLookups: 0,
    ownerPersonKnown: false,
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
      job.endedAt = new Date().toISOString();
      for (const p of job.phases) if (job.report[p].status === "running" || job.report[p].status === "pending") job.report[p].status = job.status === "done" ? "done" : job.report[p].status;
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
  updatedAt: string | null;
  add: NoteLinkInput[];
  remove: Removal[];
}

/** One phase's planned edits, merged per note. */
class Plan {
  private ops = new Map<string, Op>();
  constructor(private stamp: (id: string) => string | null) {}
  private op(id: string): Op {
    let o = this.ops.get(id);
    if (!o) {
      o = { noteId: id, updatedAt: this.stamp(id), add: [], remove: [] };
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
  remove(id: string, link: NoteLinkInput, requires?: string): void {
    const o = this.op(id);
    if (!o.remove.some((r) => r.link.target === link.target && r.link.relationship === link.relationship)) o.remove.push({ link, ...(requires ? { requires } : {}) });
  }
  has(id: string): boolean {
    return this.ops.has(id);
  }
  list(): Op[] {
    return [...this.ops.values()];
  }
}

const hasEdge = (n: Note | undefined, otherId: string, rel: string): boolean =>
  !!n &&
  Array.isArray(n.links) &&
  n.links.some((l) => l.relationship === rel && ((l.sourceId === n.id && l.targetId === otherId) || (l.targetId === n.id && l.sourceId === otherId)));

const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const byteSizeOf = (n: Note): number | null => {
  const v = (n as unknown as { byteSize?: unknown }).byteSize;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;

/** `Name <a@b>, c@d` → [{name, email}] (the Proton ingest's RFC 5322 parser). */
export function addressList(raw: unknown): Array<{ name: string; email: string }> {
  const out: Array<{ name: string; email: string }> = [];
  for (const s of strings(raw)) {
    for (const item of parseAddressList(s.slice(0, 20_000))) for (const m of item.members) if (looksLikeEmail(m.addr)) out.push({ name: m.name, email: m.addr.trim().toLowerCase() });
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
  /** id → note from this job's listings (CAS stamps for notes a phase edits). */
  known: Map<string, Note>;
  /** Dry run only: the edits earlier phases WOULD have made, so later phases plan
   *  against the same state a write run leaves behind. */
  overlay: { add: Array<{ sourceId: string; targetId: string; relationship: string }>; remove: Set<string> };
}

const edgeKey = (s: string, t: string, r: string): string => `${s}\u0000${t}\u0000${r}`;

const bump = (r: PhaseReport, reason: string, n = 1) => {
  r.skipped[reason] = (r.skipped[reason] ?? 0) + n;
};
const sampleOf = (list: string[], id: string) => {
  if (list.length < SAMPLE && !list.includes(id)) list.push(id);
};

async function list(ctx: Ctx, opts: Parameters<LinkJobVault["listNotes"]>[0]): Promise<Note[]> {
  const notes = await ctx.vault.listNotes({ ...opts, limit: INVENTORY_LIMIT });
  if (notes.length >= INVENTORY_LIMIT) throw new Error("Note inventory reached its limit; no links were changed");
  const { add, remove } = ctx.overlay;
  for (const n of notes) {
    if (opts.includeLinks && (add.length || remove.size)) {
      const kept = (n.links ?? []).filter((l) => !remove.has(edgeKey(l.sourceId, l.targetId, l.relationship)));
      const have = new Set(kept.map((l) => edgeKey(l.sourceId, l.targetId, l.relationship)));
      for (const a of add) if ((a.sourceId === n.id || a.targetId === n.id) && !have.has(edgeKey(a.sourceId, a.targetId, a.relationship))) kept.push({ ...a });
      n.links = kept;
    }
    ctx.known.set(n.id, n);
  }
  return notes;
}

/**
 * The whole vault, lean (links + `type` only). Listed afresh by each phase that
 * needs it (repoint, normalize): an earlier phase's writes change both the
 * links and the `updatedAt` a later phase must plan against.
 */
const everything = (ctx: Ctx): Promise<Note[]> => list(ctx, { includeLinks: true, includeMetadata: ["type"] });

/**
 * Plan one identity → link. Handles the queue: a linked match becomes an
 * addition (or `alreadyLinked`), a review match is queued unless the owner
 * already decided this exact source + key.
 */
function planIdentity(ctx: Ctx, rep: PhaseReport, plan: Plan, source: Note, rel: string, q: IdentityQuery, origin: string, seen: Set<string>): "linked" | "review" | "none" {
  const m: Match = ctx.idx.match(q);
  if (m.status === "linked") {
    if (m.person.id === source.id || seen.has(m.person.id)) return "linked";
    seen.add(m.person.id);
    if (hasEdge(source, m.person.id, rel)) {
      rep.alreadyLinked++;
      return "linked";
    }
    // The owner dismissed exactly this identity for this note → leave it alone.
    const key = IdentityIndex.queryKeys(q)[0] ?? (q.name ? { kind: "name" as const, value: slugKey(cleanName(q.name)) } : undefined);
    if (key && candidateStatus(ctx.job.vaultId, source.id, rel, key) === "dismissed") {
      bump(rep, "dismissed");
      return "none";
    }
    if (plan.add(source.id, { target: m.person.id, relationship: rel })) rep.wouldLink++;
    sampleOf(rep.sample.link, source.id);
    return "linked";
  }
  if (m.status === "review") {
    const decided = candidateStatus(ctx.job.vaultId, source.id, rel, m.key);
    if (decided && decided !== "open") {
      bump(rep, decided === "dismissed" ? "dismissed" : "already-reviewed");
      return "none";
    }
    rep.queued++;
    sampleOf(rep.sample.review, source.id);
    if (ctx.enqueue) {
      const r = enqueueCandidate({
        vaultId: ctx.job.vaultId,
        sourceNoteId: source.id,
        relationship: rel,
        key: m.key,
        display: q.name ? cleanName(q.name) : null,
        candidateIds: m.candidates.map((c) => c.id),
        reason: m.reason,
        origin,
      });
      if (r === "created") ctx.job.queuedNew++;
    }
    return "review";
  }
  bump(rep, "no-person");
  return "none";
}

const oversized = (n: Note): boolean => (byteSizeOf(n) ?? 0) > HISTORY_MAX_BYTES;

// ── phases ───────────────────────────────────────────────────────────────────

async function planRepoint(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const all = await everything(ctx);
  const byId = new Map(all.map((n) => [n.id, n]));
  const stamp = (id: string) => byId.get(id)?.updatedAt ?? ctx.known.get(id)?.updatedAt ?? null;
  const plan = new Plan(stamp);
  for (const stub of ctx.people) {
    if (cancelFlag) break;
    if (!isTombstone(stub)) continue;
    rep.scanned++;
    const canonical = ctx.idx.canonicalOf(stub);
    if (!canonical) {
      bump(rep, "no-canonical");
      continue;
    }
    const c = byId.get(canonical.id) ?? canonical;
    for (const l of stub.links ?? []) {
      const outgoing = l.sourceId === stub.id;
      const other = outgoing ? l.targetId : l.sourceId;
      if (other === canonical.id || other === stub.id) {
        bump(rep, "stub-to-canonical");
        continue;
      }
      const managed = VAULT_MANAGED.has(l.relationship);
      const rel = managed ? REL.REFERENCES : l.relationship;
      if (outgoing) {
        // stub → Y becomes canonical → Y.
        const exists = hasEdge(c, other, rel) || (managed && hasEdge(c, other, l.relationship));
        if (exists) rep.alreadyLinked++;
        else if (oversized(c)) {
          bump(rep, "oversize");
          continue;
        } else if (plan.add(canonical.id, { target: other, relationship: rel })) rep.wouldLink++;
        if (!managed) {
          plan.remove(stub.id, { target: other, relationship: l.relationship }, exists ? undefined : canonical.id);
          rep.wouldUnlink++;
        }
      } else {
        // X → stub becomes X → canonical, written on X.
        const x = byId.get(other);
        if (!x) {
          bump(rep, "source-missing");
          continue;
        }
        if (oversized(x)) {
          bump(rep, "oversize");
          continue;
        }
        const exists = hasEdge(x, canonical.id, rel) || hasEdge(c, other, rel) || (managed && hasEdge(c, other, l.relationship));
        if (exists) rep.alreadyLinked++;
        else if (plan.add(other, { target: canonical.id, relationship: rel })) rep.wouldLink++;
        if (!managed) {
          // Same note: the add and the remove ride in ONE write.
          plan.remove(other, { target: stub.id, relationship: l.relationship });
          rep.wouldUnlink++;
        }
      }
      sampleOf(rep.sample.link, outgoing ? canonical.id : other);
    }
  }
  return plan;
}

async function planEmails(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const notes = await list(ctx, { tags: ["email"], includeLinks: true, includeMetadata: ["from", "to", "labels"] });
  const plan = new Plan((id) => ctx.known.get(id)?.updatedAt ?? null);
  for (const n of notes) {
    if (cancelFlag) break;
    rep.scanned++;
    if (oversized(n)) {
      bump(rep, "oversize");
      continue;
    }
    const labels = strings(n.metadata?.labels).map((l) => l.toUpperCase());
    if (labels.some((l) => BULK_LABELS.has(l))) {
      bump(rep, "bulk-label");
      continue;
    }
    const seen = new Set<string>();
    const from = addressList(n.metadata?.from)[0];
    let fromOwner = false;
    if (!from) bump(rep, "no-sender");
    else if (ctx.owner.emails.has(from.email)) fromOwner = true;
    else if (isNonhumanEmail(from.email)) bump(rep, "role-sender");
    else planIdentity(ctx, rep, plan, n, REL.EMAIL_FROM, { email: from.email, name: from.name || null }, "backfill:emails", seen);

    const to = addressList(n.metadata?.to);
    if (to.length > ctx.limits.maxRecipients) {
      bump(rep, "too-many-recipients");
      continue;
    }
    for (const r of to) {
      if (ctx.owner.emails.has(r.email)) continue; // the owner is every inbound mail's recipient
      if (isNonhumanEmail(r.email)) {
        bump(rep, "role-recipient");
        continue;
      }
      planIdentity(ctx, rep, plan, n, REL.EMAIL_TO, { email: r.email, name: r.name || null }, "backfill:emails", seen);
    }
    if (fromOwner && !to.length) bump(rep, "sent-without-recipient");
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
  const plan = new Plan((id) => ctx.known.get(id)?.updatedAt ?? null);
  for (const n of notes) {
    if (cancelFlag) break;
    rep.scanned++;
    const qs = attendeeQueries(n.metadata ?? {});
    if (!qs.length) {
      bump(rep, "no-attendees");
      continue;
    }
    if (oversized(n)) {
      bump(rep, "oversize");
      continue;
    }
    const seen = new Set<string>();
    for (const q of qs) {
      if (q.email && (isNonhumanEmail(q.email) || NON_PERSON_DOMAINS.test(q.email))) {
        bump(rep, "role-attendee");
        continue;
      }
      // Calendar ingest links the owner too (their own attendee entry) — same here.
      if (isOwnerQuery(ctx.owner, q)) {
        if (!ctx.owner.person) {
          bump(rep, "owner-unresolved");
          continue;
        }
        planIdentity(ctx, rep, plan, n, REL.ATTENDED_BY, { ref: ctx.owner.person.id }, "backfill:meetings", seen);
        continue;
      }
      if (q.name && creationRefusal(q.name)) {
        bump(rep, "not-a-name");
        continue;
      }
      planIdentity(ctx, rep, plan, n, REL.ATTENDED_BY, q, "backfill:meetings", seen);
    }
  }
  return plan;
}

async function planThreads(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const notes = await list(ctx, { tags: ["message-thread"], includeLinks: true, includeMetadata: ["participants", "participantIds", "matrixRoomId"] });
  const plan = new Plan((id) => ctx.known.get(id)?.updatedAt ?? null);
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
    if (oversized(n)) {
      bump(rep, "oversize");
      continue;
    }
    let members: Array<{ mxid: string | null; name: string | null }> = t.ids.map((mxid) => ({ mxid, name: null }));
    const roomId = typeof n.metadata?.matrixRoomId === "string" ? n.metadata.matrixRoomId : null;
    if (!members.length && roomId && ctx.opts.members && ctx.job.memberLookups < L.memberLookups && t.size <= L.groupMaxMembers) {
      ctx.job.memberLookups++;
      const got = await ctx.opts.members(roomId).catch(() => null);
      if (got) members = Object.entries(got).map(([mxid, name]) => ({ mxid, name: name || null }));
      if (L.memberPaceMs) await new Promise((r) => setTimeout(r, L.memberPaceMs));
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
    const namesAllowed = size <= L.groupNameMax;
    const cap = size > 3 ? L.groupLinkCap : Infinity;
    const seen = new Set<string>();
    let namesSkipped = false;
    for (const m of members) {
      if (m.mxid && (isBridgeBotId(m.mxid) || ctx.owner.matrixIds.has(m.mxid.toLowerCase()))) continue;
      if (m.name && looksLikeBotName(m.name)) continue;
      const q: IdentityQuery = { matrixId: m.mxid, name: namesAllowed ? m.name : null };
      if (!m.mxid && !namesAllowed) {
        namesSkipped = true;
        continue;
      }
      if (isOwnerQuery(ctx.owner, q) || (m.name && !m.mxid && isOwnerQuery(ctx.owner, { name: m.name }))) continue;
      if (!m.mxid && m.name && creationRefusal(m.name)) continue;
      if (seen.size >= cap) {
        bump(rep, "group-link-cap");
        break;
      }
      planIdentity(ctx, rep, plan, n, REL.MESSAGES_WITH, q, "backfill:threads", seen);
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
  const plan = new Plan((id) => ctx.known.get(id)?.updatedAt ?? null);
  for (const n of tasks) {
    if (cancelFlag) break;
    rep.scanned++;
    if (oversized(n)) {
      bump(rep, "oversize");
      continue;
    }
    const md = n.metadata ?? {};
    const seen = new Set<string>();
    for (const v of assigneeValues(md)) {
      const q: IdentityQuery = v.startsWith("[[") || v.startsWith("vault/") ? { ref: v } : looksLikeEmail(v) ? { email: v } : { name: v };
      if (isOwnerQuery(ctx.owner, q)) {
        if (!ctx.owner.person) {
          bump(rep, "owner-unresolved");
          continue;
        }
        planIdentity(ctx, rep, plan, n, REL.ASSIGNED_TO, { ref: ctx.owner.person.id }, "backfill:tasks", seen);
        continue;
      }
      if (q.name && nameTokens(q.name).length === 0) {
        bump(rep, "not-a-name");
        continue;
      }
      planIdentity(ctx, rep, plan, n, REL.ASSIGNED_TO, q, "backfill:tasks", seen);
    }
    const project = typeof md.project === "string" ? md.project.trim() : "";
    if (project) {
      const p = findProject(project);
      if (p === "ambiguous") bump(rep, "project-ambiguous");
      else if (!p) bump(rep, "project-unknown");
      else if (p.id === n.id) continue;
      else if (hasEdge(n, p.id, REL.BELONGS_TO)) rep.alreadyLinked++;
      else {
        if (plan.add(n.id, { target: p.id, relationship: REL.BELONGS_TO })) rep.wouldLink++;
        sampleOf(rep.sample.link, n.id);
      }
    }
  }
  return plan;
}

async function planNormalize(ctx: Ctx, rep: PhaseReport): Promise<Plan> {
  const all = await everything(ctx);
  const byId = new Map(all.map((n) => [n.id, n]));
  const plan = new Plan((id) => byId.get(id)?.updatedAt ?? null);
  rep.byName = {};
  for (const n of all) {
    if (cancelFlag) break;
    rep.scanned++;
    for (const l of n.links ?? []) {
      if (l.sourceId !== n.id) continue;
      const target = byId.get(l.targetId);
      if (!target) continue;
      const norm = normalizeRelationship(l.relationship, noteKinds(n), noteKinds(target));
      if (!norm) continue;
      const [from, to] = norm.reversed ? [target, n] : [n, target];
      if (oversized(from) || oversized(n)) {
        bump(rep, "oversize");
        continue;
      }
      rep.byName[l.relationship] = (rep.byName[l.relationship] ?? 0) + 1;
      const exists = hasEdge(from, to.id, norm.canonical);
      if (exists) rep.alreadyLinked++;
      else if (plan.add(from.id, { target: to.id, relationship: norm.canonical })) rep.wouldLink++;
      // Same note → one write; the other note → only after its addition landed.
      plan.remove(n.id, { target: l.targetId, relationship: l.relationship }, from.id === n.id || exists ? undefined : from.id);
      rep.wouldUnlink++;
      sampleOf(rep.sample.link, from.id);
    }
  }
  return plan;
}

// ── applying ────────────────────────────────────────────────────────────────

async function apply(ctx: Ctx, rep: PhaseReport, plan: Plan): Promise<void> {
  const concurrency = Math.max(1, Math.min(2, ctx.opts.concurrency ?? 2));
  const paceMs = Math.max(0, ctx.opts.paceMs ?? 50);
  const failed = new Set<string>();
  const stamps = new Map<string, string | null>();
  const ops = plan.list();
  // Wave 1: everything without a cross-note dependency. Wave 2: removals that
  // wait for another note's addition (a failed or deferred addition blocks them).
  const wave1: Op[] = [];
  const wave2: Op[] = [];
  for (const o of ops) {
    const free = o.remove.filter((r) => !r.requires);
    const dep = o.remove.filter((r) => r.requires);
    if (o.add.length || free.length) wave1.push({ ...o, remove: free });
    if (dep.length) wave2.push({ ...o, add: [], remove: dep });
  }
  const runWave = async (wave: Op[], second: boolean) => {
    let next = 0;
    const worker = async () => {
      while (!cancelFlag) {
        const i = next++;
        if (i >= wave.length) return;
        const o = wave[i]!;
        const remove = second ? o.remove.filter((r) => !failed.has(r.requires!)) : o.remove;
        if (!o.add.length && !remove.length) {
          // Every removal here waited on an addition that did not land.
          if (o.remove.length) rep.deferred++;
          continue;
        }
        rep.notesToWrite++;
        if (ctx.job.maxWrites && ctx.job.writes >= ctx.job.maxWrites) {
          ctx.job.capped = true;
          rep.deferred++;
          failed.add(o.noteId);
          continue;
        }
        ctx.job.writes++;
        if (ctx.job.dryRun) {
          for (const a of o.add) ctx.overlay.add.push({ sourceId: o.noteId, targetId: a.target, relationship: a.relationship });
          for (const r of remove) ctx.overlay.remove.add(edgeKey(o.noteId, r.link.target, r.link.relationship));
          continue;
        }
        const ifUpdatedAt = stamps.get(o.noteId) ?? o.updatedAt;
        try {
          const updated = await ctx.vault.updateNote(o.noteId, {
            links: { ...(o.add.length ? { add: o.add } : {}), ...(remove.length ? { remove: remove.map((r) => r.link) } : {}) },
            ...(ifUpdatedAt ? { ifUpdatedAt } : {}),
          });
          stamps.set(o.noteId, updated?.updatedAt ?? null);
          rep.notesWritten++;
          rep.linked += o.add.length;
          rep.unlinked += remove.length;
        } catch (e) {
          failed.add(o.noteId);
          const s = statusOf(e);
          if (s === 409 || s === 428) rep.conflicts++;
          else if (s === 413) rep.oversize++;
          else rep.errors++;
        }
        if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  };
  await runWave(wave1, false);
  await runWave(wave2, true);
}

// ── the run ─────────────────────────────────────────────────────────────────

const PLANNERS: Record<Phase, (ctx: Ctx, rep: PhaseReport) => Promise<Plan>> = {
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
    owner: { person: null, emails: new Set(), names: new Set(), matrixIds: new Set() },
    enqueue: opts.enqueue ?? !opts.dryRun,
    known: new Map(),
    overlay: { add: [], remove: new Set() },
  };
  ctx.people = (await list(ctx, { tags: ["person"], includeLinks: true, includeMetadata: PERSON_IDENTITY_KEYS })).filter((n) => (n.tags ?? []).includes("person"));
  ctx.idx = new IdentityIndex(ctx.people);
  ctx.owner = ownerProfile(ctx.idx, opts.owner);
  job.ownerPersonKnown = !!ctx.owner.person;
  for (const phase of job.phases) {
    if (cancelFlag) return;
    const rep = job.report[phase];
    rep.status = "running";
    const plan = await PLANNERS[phase](ctx, rep);
    if (cancelFlag) return;
    await apply(ctx, rep, plan);
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
