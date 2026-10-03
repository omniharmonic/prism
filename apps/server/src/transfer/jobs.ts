/**
 * In-memory registry for import / export jobs (wave 3A).
 *
 * A job belongs to ONE account in ONE vault; every lookup is `(id, owner, vault)`
 * so another account's job id answers exactly like a missing one. Ids are 128
 * random bits. Finished jobs are kept for `ttlMs` (the export's download window)
 * and then dropped together with whatever `dispose` cleans up (the temp ZIP).
 * Nothing here survives a restart — a restart simply loses running jobs, and the
 * export directory is wiped on first use (see export.ts).
 */
import { randomBytes } from "node:crypto";

export type JobState = "queued" | "running" | "done" | "error" | "cancelled";

export interface Job<P> {
  id: string;
  kind: "export" | "import";
  owner: string;
  vaultId: string;
  state: JobState;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
  cancelled: boolean;
  error: string | null;
  progress: P;
  dispose?: () => void;
}

const jobs = new Map<string, Job<unknown>>();
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const isJobId = (s: string): boolean => ID_RE.test(s);

export function createJob<P>(kind: Job<P>["kind"], owner: string, vaultId: string, progress: P): Job<P> {
  sweepJobs();
  const job: Job<P> = {
    id: randomBytes(16).toString("base64url"),
    kind,
    owner: owner.toLowerCase(),
    vaultId,
    state: "queued",
    createdAt: Date.now(),
    finishedAt: null,
    expiresAt: null,
    cancelled: false,
    error: null,
    progress,
  };
  jobs.set(job.id, job as Job<unknown>);
  return job;
}

/** The caller's own job in this vault, or null (another account's id is indistinguishable from none). */
export function findJob<P>(kind: Job<P>["kind"], id: string, owner: string, vaultId: string): Job<P> | null {
  if (!isJobId(id)) return null;
  sweepJobs();
  const job = jobs.get(id);
  if (!job || job.kind !== kind || job.owner !== owner.toLowerCase() || job.vaultId !== vaultId) return null;
  return job as Job<P>;
}

export function finishJob<P>(job: Job<P>, state: Exclude<JobState, "queued" | "running">, ttlMs: number, error: string | null = null): void {
  job.state = state;
  job.error = error;
  job.finishedAt = Date.now();
  job.expiresAt = job.finishedAt + ttlMs;
}

export function dropJob(job: Job<unknown>): void {
  jobs.delete(job.id);
  try {
    job.dispose?.();
  } catch {
    /* best-effort */
  }
}

export function activeJobs(kind: Job<unknown>["kind"], owner?: string): Job<unknown>[] {
  const o = owner?.toLowerCase();
  return [...jobs.values()].filter((j) => j.kind === kind && (j.state === "queued" || j.state === "running") && (o === undefined || j.owner === o));
}

export function sweepJobs(now = Date.now()): void {
  for (const job of jobs.values()) {
    if (job.expiresAt !== null && job.expiresAt <= now) dropJob(job);
  }
}

/** Test helper: forget every job (and clean up its files). */
export function resetJobsForTests(): void {
  for (const job of [...jobs.values()]) {
    job.cancelled = true;
    dropJob(job);
  }
}

export const envInt = (name: string, fallback: number, min = 0): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};
