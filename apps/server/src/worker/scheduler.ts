/**
 * The Prism worker (Phase 3 — server-first runtime). A colocated poll loop that
 * runs the server-side ingesters per vault on an interval, so context flows into
 * each tenant's vault with no desktop running. Credentials come from the
 * per-tenant secret store; cursors (incremental-sync tokens) persist in settings
 * so a restart resumes. Gated: does nothing unless SECRETS_KEY is configured and
 * a vault actually has an integration secret. Errors are logged, never fatal.
 *
 * Today: Matrix. Notion/transcripts plug in the same way (a secret kind + an
 * ingest fn). gog-backed Gmail/Calendar + Meetily stay desktop (host-bound).
 */
import { getVaultRegistry, getWorkerCursor, setWorkerCursor, listVaultMirrors } from "../db";
import { getSecret, secretsConfigured } from "../secrets";
import { config, type VaultEntry } from "../config";
import { vaultClient } from "../parachute";
import { MatrixClient, ingestMatrix, type IngestVault, type MatrixCreds } from "./matrix";
import { FathomClient, ingestFathom } from "./fathom";
import { FirefliesClient, ingestAndCleanupFireflies, type FirefliesBudget, type FirefliesVault } from "./fireflies";
import { runVaultMirrorsOnce } from "./vault-mirror";

let timer: ReturnType<typeof setInterval> | null = null;

// Per-vault set of Fireflies transcript ids that are un-deletable (owned by a
// teammate, needs team-admin). Kept in-process so we don't waste the daily
// budget retrying the same denied delete every slot; a restart retries once.
const firefliesSkip = new Map<string, Set<string>>();

// The API key's own email, resolved once per process. Deletion compares meeting
// ownership against it, and re-fetching it every run would waste daily quota.
const firefliesOwnerEmail = new Map<string, string>();

/** Run one Matrix ingest pass for a vault, if it has a stored credential.
 *  Returns the message count ingested (0 if not configured / nothing new). */
export async function runMatrixOnce(entry: VaultEntry): Promise<number> {
  // The workspace's Matrix integration is owned by the operator (config.ownerEmail)
  // for now; a per-member model can key it differently later.
  const raw = getSecret(entry.id, config.ownerEmail, "matrix");
  if (!raw) return 0;
  const creds = JSON.parse(raw) as MatrixCreds;
  const client = new MatrixClient(creds);
  const since = getWorkerCursor(entry.id, "matrix") ?? undefined;
  const res = await ingestMatrix(client, vaultClient(entry.id) as unknown as IngestVault, { since });
  if (res.nextBatch) setWorkerCursor(entry.id, "matrix", res.nextBatch);
  if (res.messages > 0) {
    console.log(`[worker] matrix ${entry.id}: +${res.messages} msgs (${res.created} new threads, ${res.updated} updated)`);
  }
  return res.messages;
}

/** Run one Fathom transcript ingest pass for a vault, if it has a stored key.
 *  Create-only + dedup by source_id (safe to run alongside the desktop). */
export async function runFathomOnce(entry: VaultEntry): Promise<number> {
  const raw = getSecret(entry.id, config.ownerEmail, "fathom");
  if (!raw) return 0;
  const { apiKey } = JSON.parse(raw) as { apiKey: string };
  const client = new FathomClient(apiKey);
  const res = await ingestFathom(client, vaultClient(entry.id) as unknown as IngestVault);
  if (res.created > 0) {
    console.log(`[worker] fathom ${entry.id}: +${res.created} transcripts (${res.skipped} skipped)`);
  }
  return res.created;
}

/** Current hour + calendar day in a named timezone (robust to the process TZ),
 *  used to gate Fireflies to fixed LOCAL hours regardless of where node runs. */
function localHourAndDay(tz: string): { hour: number; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(new Date());
  const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? "";
  let hh = get("hour");
  if (hh === "24") hh = "00"; // some ICU builds render midnight as 24
  return { hour: Number(hh), day: `${get("year")}-${get("month")}-${get("day")}` };
}

/** A per-UTC-day Fireflies budget persisted in the worker-cursor store
 *  ("YYYYMMDD:count"), so restarts can't blow the daily API-request quota. */
function makeFirefliesBudget(vaultId: string, dailyBudget: number): FirefliesBudget {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const raw = getWorkerCursor(vaultId, "fireflies-budget");
  let spent = 0;
  if (raw) {
    const [day, n] = raw.split(":");
    if (day === today) spent = Number(n) || 0;
  }
  return {
    remaining: () => Math.max(0, dailyBudget - spent),
    spend: (n: number) => {
      spent += n;
      setWorkerCursor(vaultId, "fireflies-budget", `${today}:${spent}`);
    },
  };
}

/** Run one Fireflies ingest+cleanup pass for a vault, if it has a stored key.
 *  Gated to fixed LOCAL hours (once per slot, DB-persisted) unless `force` (the
 *  on-demand route / backlog drain). Deletes each transcript from Fireflies once
 *  its note is confirmed in the vault. Returns the count newly ingested. */
export async function runFirefliesOnce(entry: VaultEntry, opts: { force?: boolean } = {}): Promise<number> {
  const raw = getSecret(entry.id, config.ownerEmail, "fireflies");
  if (!raw) return 0;
  const { apiKey } = JSON.parse(raw) as { apiKey: string };

  const { hour, day } = localHourAndDay(config.firefliesTz);
  const slot = `${day}-${String(hour).padStart(2, "0")}`;
  if (!opts.force) {
    if (!config.firefliesSyncHours.includes(hour)) return 0;
    if (getWorkerCursor(entry.id, "fireflies-slot") === slot) return 0;
    // Claim the slot up front so at most one API-touching run happens per
    // scheduled hour, even if this run errors or is throttled.
    setWorkerCursor(entry.id, "fireflies-slot", slot);
  }

  let skip = firefliesSkip.get(entry.id);
  if (!skip) {
    skip = new Set<string>();
    firefliesSkip.set(entry.id, skip);
  }

  const client = new FirefliesClient(apiKey);
  let owner = firefliesOwnerEmail.get(entry.id);
  if (!owner) {
    try {
      owner = await client.currentUserEmail();
      if (owner) firefliesOwnerEmail.set(entry.id, owner);
    } catch {
      owner = ""; // unknown identity → the loop refuses every delete (fail closed)
    }
  }

  const budget = makeFirefliesBudget(entry.id, config.firefliesDailyBudget);
  const res = await ingestAndCleanupFireflies(client, vaultClient(entry.id) as unknown as FirefliesVault, {
    budget,
    skipSet: skip,
    ownerEmail: owner,
    deleteEnabled: config.firefliesDeleteEnabled,
    maxNewPerRun: config.firefliesMaxNewPerRun,
    maxDeletePerRun: config.firefliesMaxDeletePerRun,
    recoverEmptySources: config.firefliesRecoverEmpty,
    maxRecoveriesPerRun: config.firefliesMaxRecoveriesPerRun,
    quotaMinutesCap: config.firefliesQuotaMinutesCap,
    onEvent: (e) => {
      // Every irreversible (or would-be irreversible) action is logged by id.
      const p = `[worker] fireflies ${entry.id}:`;
      if (e.kind === "deleted") console.log(`${p} DELETED ${e.id} "${e.title}"`);
      else if (e.kind === "would-delete") console.log(`${p} [dry-run] would delete ${e.id} "${e.title}"`);
      else if (e.kind === "unverified") console.warn(`${p} KEEPING ${e.id} "${e.title}" — ${e.reason}`);
      else if (e.kind === "not-owner") console.warn(`${p} NOT YOURS ${e.id} "${e.title}" — owned by ${e.owner}; cannot delete`);
      else if (e.kind === "false-delete") console.error(`${p} FALSE DELETE ${e.id} "${e.title}" — vault claimed deleted but it is still live; relabeled blocked`);
      else if (e.kind === "recovered") console.log(`${p} RECOVERED ${e.id} "${e.title}" — empty transcript; audio re-submitted for transcription`);
      else if (e.kind === "quota-warning") console.warn(`${p} QUOTA ${e.minutesConsumed.toFixed(0)}/${e.cap} min — Fireflies stops transcribing at the cap; delete ingested transcripts now`);
      else if (e.kind === "undeletable") console.warn(`${p} cannot delete ${e.id} "${e.title}" — ${e.reason}`);
    },
  });
  // ALWAYS log one line per run (<=4/day). A quiet run is the norm once the
  // backlog is drained — everything falls into the in-memory skip-set and no
  // counter moves — and a silently-quiet run is indistinguishable from a run
  // that never happened. Silent stalls are exactly what wedged this integration
  // before, so the heartbeat is the point, not the counters.
  console.log(
    `[worker] fireflies ${entry.id}: +${res.created} ingested, -${res.deleted} deleted` +
      (res.recovered ? `, ${res.recovered} recovered` : "") +
      (res.wouldDelete ? `, ${res.wouldDelete} would-delete (dry run)` : "") +
      (res.unverified ? `, ${res.unverified} UNVERIFIED (kept)` : "") +
      (res.notOwner ? `, ${res.notOwner} not-yours` : "") +
      (res.falseDeletes ? `, ${res.falseDeletes} FALSE-DELETES relabeled` : "") +
      ` (${res.skipped} skipped, ${budget.remaining()}/${config.firefliesDailyBudget} calls left today)` +
      (opts.force ? " [forced]" : ` [slot ${slot}]`),
  );
  return res.created;
}

/** One full tick: every configured ingester for every vault. Per-vault, per-source
 *  errors are isolated so one bad credential can't stall the rest. */
async function tick(): Promise<void> {
  // Secret-backed ingesters keep their original gate: on a mirrors-only server
  // (no SECRETS_KEY) they would otherwise throw per vault × source on every
  // tick, flooding the logs while appearing configured.
  if (secretsConfigured()) {
    for (const entry of getVaultRegistry()) {
      for (const [name, run] of [
        ["matrix", runMatrixOnce],
        ["fathom", runFathomOnce],
        ["fireflies", runFirefliesOnce],
      ] as const) {
        try {
          await run(entry);
        } catch (e) {
          console.warn(`[worker] ${name} ${entry.id} failed:`, (e as Error).message);
        }
      }
    }
  }
  // Vault mirrors are per-PAIR (source vault × dest vault), not per-vault-entry,
  // hence their own iteration. Each mirror throttles itself (last_run_at), so a
  // 60s tick costs one SELECT when nothing is due.
  await runVaultMirrorsOnce();
}

/** Start the worker loop. No-op if there is nothing it could ever do (no secrets
 *  → no ingesters, and no mirrors) or already running. The interval is unref'd so
 *  it never blocks shutdown. POST /acl/mirrors re-invokes this, so creating the
 *  first mirror on a secrets-less server starts the loop without a restart. */
export function startWorker(intervalMs = 60_000): void {
  if (timer || (!secretsConfigured() && listVaultMirrors().length === 0)) return;
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick(); // an immediate first pass on boot
  console.log(`[worker] started (interval ${Math.round(intervalMs / 1000)}s)`);
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
