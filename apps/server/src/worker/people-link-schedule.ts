/**
 * The SCHEDULED run of the people-link backfill job (src/people-link-job.ts).
 *
 * Why: forward linking only links a record to people who exist when the record
 * arrives. Mail, threads and transcripts that came BEFORE a person note existed
 * are linked only by the backfill job, and that ran only when the owner started
 * it. This runs the SAME job on a slow cadence with the conservative settings.
 *
 * OFF unless PEOPLE_LINK_SCHEDULE_ENABLED=true. Primary vault only.
 *
 *   - Strong keys only (`allowNameLinks: false`): a name never links a person.
 *   - `enqueue: false`: nothing is put in the review queue.
 *   - A hard write cap (PEOPLE_LINK_SCHEDULE_MAX_WRITES, default 200), split evenly
 *     between the phases so a backlog in one phase cannot use up the whole run.
 *   - Only the phases in SCHEDULE_SAFE_PHASES. Each is additive: it adds links to
 *     the record itself, removes nothing, and rewrites no metadata of a person.
 *       emails    exact address of one live person; never a display name, a role
 *                 mailbox or the owner.
 *       meetings  attendee address; the owner by their own full name / a configured
 *                 alias (calendar ingest's convention). Other names → not linked.
 *       threads   Matrix id only. The homeserver membership lookup (which also
 *                 stores `participantIds` on the thread note) runs only with
 *                 PEOPLE_LINK_SCHEDULE_MATRIX_LOOKUPS=true.
 *       tasks     `assigned-to` by address, by an explicit [[person]] reference,
 *                 or the owner's configured alias; `belongs-to` for a `project`
 *                 value that names exactly one project.
 *     NOT run unattended, whatever the setting says:
 *       owner       edits the owner's own person note (identities) — a decision.
 *       tombstones  rewrites `merged_into` on a person note.
 *       repoint     REMOVES links from a merged stub. The pointer it follows can
 *                   have been written by anything (an agent, a name match), and
 *                   the job keeps no undo log.
 *       normalize   REMOVES and re-creates links under another name, vault-wide.
 *   - A DRY RUN (the job's own dry run: counts only, no vault write) until
 *     PEOPLE_LINK_SCHEDULE_DRY_RUN=false is set as well.
 *   - Mutually exclusive with a manual job, a merge and a review decision: when
 *     the people lock is held this tick is skipped and the next one tries again.
 *   - The due time is persisted (worker cursor), so a restart neither repeats a
 *     run nor loses one. The slot is claimed BEFORE the run starts: a process
 *     that dies mid-run does not start another on every boot.
 *   - Never throws. The outcome is the job's own (`people-link` health source,
 *     worker/health.ts) plus ONE `action_audit` row with counts only.
 */
import { config } from "../config";
import { getWorkerCursor, setWorkerCursor } from "../db";
import { getSecret } from "../secrets";
import { recordAction } from "../actions/store";
import { invalidatePeople } from "../people-cache";
import { peopleLockHolder } from "../people-lock";
import { ownerConfigFor } from "../people-owner";
import { linkJobTuning, peopleListing, peopleLiveHooks, peopleVault } from "../people-review-service";
import { LinkJobBusyError, isPhase, linkJobRunning, startLinkJob, type LinkJob, type LinkJobOptions, type LinkJobVault, type Phase } from "../people-link-job";
import { MatrixClient, type MatrixCreds } from "./matrix";

/** The only phases a scheduled run may contain (see the header for why). */
export const SCHEDULE_SAFE_PHASES: readonly Phase[] = ["emails", "meetings", "threads", "tasks"];

const CURSOR = "people-link-schedule";
/** After a run that ended in `error` (or never ended: the process died), try again this soon. */
const RETRY_MS = 86_400_000;
const BUSY_LOG_EVERY_MS = 3_600_000;

export interface PeopleLinkScheduleState {
  /** When the last scheduled run STARTED. */
  at: string;
  jobId: string;
  status: "running" | LinkJob["status"];
  dryRun: boolean;
}

export type ScheduleTick =
  | { ran: false; reason: "disabled" | "not-due" | "in-flight" | "busy" | "no-phases" | "error"; detail?: string }
  | { ran: true; job: LinkJob };

export interface PeopleLinkScheduleDeps {
  vault?: LinkJobVault;
  now?: () => number;
  /** Extra job options (tests: pacing, a people loader, a members lookup). Never overrides the safety settings. */
  job?: Partial<Pick<LinkJobOptions, "paceMs" | "people" | "members" | "limits" | "owner" | "live" | "callTimeoutMs">>;
}

let inFlight = false;
let busySkips = 0;
let busyLoggedAt = 0;

/** Ticks skipped because another people operation held the lock, since the last scheduled run started. */
export const peopleLinkScheduleBusySkips = (): number => busySkips;

/** Test-only reset. */
export function _resetPeopleLinkSchedule(): void {
  inFlight = false;
  busySkips = 0;
  busyLoggedAt = 0;
}

/** The phases a scheduled run will contain: the setting, limited to SCHEDULE_SAFE_PHASES. */
export function schedulePhases(setting: string = config.peopleLinkSchedulePhases): Phase[] {
  const asked = new Set(setting.split(",").map((s) => s.trim().toLowerCase()).filter(isPhase));
  return SCHEDULE_SAFE_PHASES.filter((p) => asked.has(p));
}

export function lastPeopleLinkSchedule(vaultId = "primary"): PeopleLinkScheduleState | null {
  try {
    const raw = getWorkerCursor(vaultId, CURSOR);
    const v = raw ? (JSON.parse(raw) as PeopleLinkScheduleState) : null;
    return v && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}

const enabled = (): boolean => config.peopleLinkScheduleEnabled && config.peopleLinkScheduleMs > 0;

/** When the next scheduled run is due (ms since epoch; 0 = now), or null when the schedule is off. */
export function peopleLinkScheduleNextAt(vaultId = "primary"): number | null {
  if (!enabled()) return null;
  const last = lastPeopleLinkSchedule(vaultId);
  const at = last ? Date.parse(last.at) : NaN;
  if (!Number.isFinite(at)) return 0;
  // A run that finished (or the owner cancelled) waits a full interval. One that
  // errored, or was cut off by a restart, comes back after a day at most.
  const settled = last!.status === "done" || last!.status === "cancelled";
  return at + (settled ? config.peopleLinkScheduleMs : Math.min(config.peopleLinkScheduleMs, RETRY_MS));
}

/** Due when enabled and the persisted last start is older than the interval (restart-safe). */
export function peopleLinkScheduleDue(vaultId = "primary", nowMs = Date.now()): boolean {
  const next = peopleLinkScheduleNextAt(vaultId);
  return next !== null && nowMs >= next;
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms) return p;
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("matrix call timed out")), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Counts only — no note ids, paths, names or addresses. */
function auditTarget(j: LinkJob): Record<string, unknown> {
  return {
    jobId: j.id,
    scheduled: true,
    dryRun: j.dryRun,
    status: j.status,
    phases: j.phases,
    maxWrites: j.maxWrites,
    maxWritesPerPhase: j.maxWritesPerPhase,
    writes: j.dryRun ? 0 : j.writes,
    capped: j.capped,
    queuedNew: j.queuedNew,
    allowNameLinks: j.allowNameLinks,
    ...Object.fromEntries(
      j.phases.map((p) => {
        const r = j.report[p];
        return [p, { scanned: r.scanned, wouldLink: r.wouldLink, linked: r.linked, unlinked: r.unlinked, review: r.queued, conflicts: r.conflicts, errors: r.errors, oversize: r.oversize, deferred: r.deferred }];
      }),
    ),
  };
}

/**
 * One scheduler visit. Starts a run when one is due and nothing else holds the
 * people lock, and resolves when that run has ended. Never throws.
 */
export async function runPeopleLinkScheduleOnce(vaultId = "primary", deps: PeopleLinkScheduleDeps = {}): Promise<ScheduleTick> {
  const now = deps.now ?? Date.now;
  if (!enabled()) return { ran: false, reason: "disabled" };
  if (inFlight) return { ran: false, reason: "in-flight" };
  if (!peopleLinkScheduleDue(vaultId, now())) return { ran: false, reason: "not-due" };
  inFlight = true;
  try {
    const phases = schedulePhases();
    if (!phases.length) {
      console.warn(`[worker] people-link schedule: PEOPLE_LINK_SCHEDULE_PHASES names none of ${SCHEDULE_SAFE_PHASES.join(", ")} — nothing to run`);
      return { ran: false, reason: "no-phases" };
    }
    const skipBusy = (holder: string): ScheduleTick => {
      busySkips++;
      if (now() - busyLoggedAt >= BUSY_LOG_EVERY_MS) {
        busyLoggedAt = now();
        console.log(`[worker] people-link schedule: another people operation is in progress (${holder}) — skipped, will try on the next tick`);
      }
      return { ran: false, reason: "busy", detail: holder };
    };
    // Busy → this tick is skipped; the due time is NOT moved, so the next tick tries again.
    const holder = peopleLockHolder() ?? (linkJobRunning() ? "people-link-job" : null);
    if (holder) return skipBusy(holder);

    const dryRun = config.peopleLinkScheduleDryRun;
    const maxWrites = Math.max(1, Math.floor(config.peopleLinkScheduleMaxWrites) || 1);
    let members = deps.job?.members;
    let self: string | null = null;
    if (!members && config.peopleLinkScheduleMatrixLookups && phases.includes("threads")) {
      const raw = getSecret(vaultId, config.ownerEmail, "matrix");
      if (raw) {
        // Bounded reads; a failure THROWS so the job's lookup breaker counts it.
        const client = new MatrixClient(JSON.parse(raw) as MatrixCreds);
        self = await bounded(client.whoami(), config.peopleVaultTimeoutMs).catch(() => null);
        members = (roomId) => bounded(client.joinedMembers(roomId), config.peopleVaultTimeoutMs);
      }
    }
    // The Matrix read above yielded: something else may have taken the lock meanwhile.
    const late = peopleLockHolder();
    if (late) return skipBusy(late);

    let started: { job: LinkJob; done: Promise<void> };
    let ended: LinkJob | null = null;
    try {
      started = startLinkJob(deps.vault ?? (peopleVault(vaultId) as unknown as LinkJobVault), vaultId, {
        ...linkJobTuning(),
        owner: ownerConfigFor(vaultId, { matrixId: self }),
        people: () => peopleListing(vaultId, true),
        live: peopleLiveHooks(vaultId),
        ...deps.job,
        members,
        // The safety settings: after `deps.job`, so nothing can loosen them.
        dryRun,
        phases,
        maxWrites,
        maxWritesPerPhase: Math.ceil(maxWrites / phases.length),
        enqueue: false,
        allowNameLinks: false,
        scheduled: true,
        onEnd: (j) => {
          ended = j;
        },
      });
    } catch (e) {
      if (e instanceof LinkJobBusyError) return skipBusy(peopleLockHolder() ?? "people-link-job");
      throw e;
    }
    // Claim the slot now that a run exists: a crash from here on waits RETRY_MS, never loops.
    const state: PeopleLinkScheduleState = { at: new Date(now()).toISOString(), jobId: started.job.id, status: "running", dryRun };
    setWorkerCursor(vaultId, CURSOR, JSON.stringify(state));
    busySkips = 0;
    console.log(`[worker] people-link schedule: started (${dryRun ? "DRY RUN" : `WRITE, max ${maxWrites} writes`}) on vault ${vaultId}: ${phases.join(",")}`);
    await started.done;
    const job: LinkJob = ended ?? { ...started.job, status: "error", error: "the job ended without a result" };
    setWorkerCursor(vaultId, CURSOR, JSON.stringify({ ...state, status: job.status }));
    invalidatePeople(vaultId);
    recordAction({
      actorEmail: config.ownerEmail,
      via: "worker",
      origin: "agent", // not a person: nobody confirmed this run
      action: "worker.people-link-schedule",
      vaultId,
      target: auditTarget(job),
      status: job.status === "done" ? "ok" : "failed",
      error: job.error,
    });
    const sum = (k: "wouldLink" | "linked" | "deferred") => job.phases.reduce((n, p) => n + job.report[p][k], 0);
    const line = `[worker] people-link schedule: ${job.status}${dryRun ? " (dry run)" : ""} — ${sum("wouldLink")} planned, ${sum("linked")} linked, ${job.dryRun ? 0 : job.writes} notes written, ${sum("deferred")} deferred${job.capped ? " [capped]" : ""}${job.error ? ` (${job.error})` : ""}`;
    if (job.status === "done") console.log(line);
    else console.warn(line);
    return { ran: true, job };
  } catch (e) {
    const detail = String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200);
    console.warn(`[worker] people-link schedule failed: ${detail}`);
    return { ran: false, reason: "error", detail };
  } finally {
    inFlight = false;
  }
}
