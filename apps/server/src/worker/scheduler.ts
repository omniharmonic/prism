/**
 * The Prism worker (Phase 3 — server-first runtime). A colocated poll loop that
 * runs the server-side ingesters per vault on an interval, so context flows into
 * each tenant's vault with no desktop running. Credentials come from the
 * per-tenant secret store; cursors (incremental-sync tokens) persist in settings
 * so a restart resumes. Errors are logged, never fatal.
 *
 * Three kinds of work, on three cadences:
 *   - INGESTERS (Matrix, Fathom, Fireflies) — need a stored credential, so they
 *     no-op unless SECRETS_KEY is set and the vault has that secret.
 *   - VAULT MIRRORS — per source×dest pair, each self-throttled by last_run_at.
 *   - INDEX MAINTENANCE — needs no credential at all, and is the reason the loop
 *     can be worth running on a server that has none. Slower cadence
 *     (INDEX_INTERVAL_MS); 0 disables it.
 *
 * gog-backed Gmail/Calendar + Meetily stay desktop (host-bound).
 */
import { getVaultRegistry, getWorkerCursor, setWorkerCursor, listVaultMirrors } from "../db";
import { getSecret, secretsConfigured, otherSecretOwners } from "../secrets";
import { config, type VaultEntry } from "../config";
import { vault, vaultClient } from "../parachute";
import { MatrixClient, ingestMatrix, type IngestVault, type MatrixCreds } from "./matrix";
import { FathomClient, ingestFathom } from "./fathom";
import { FirefliesClient, ingestAndCleanupFireflies, type FirefliesBudget, type FirefliesVault } from "./fireflies";
import { ClickUpClient, ingestClickUp, type ClickUpCredential, type ClickUpVault } from "./clickup";
import { runVaultMirrorsOnce } from "./vault-mirror";
import { indexNote, deindexNote, type IndexResult } from "../rag/service";
import { getEmbedder } from "../rag/embedder";
import { indexedNoteIds, allIndexedNoteIds } from "../rag/store";

let timer: ReturnType<typeof setInterval> | null = null;

// Index maintenance runs on a slower cadence than the 60s ingest tick; this is
// the in-process throttle (the durable "how far have we indexed" state is the
// per-model worker cursor, so a restart resumes rather than re-sweeping).
let lastIndexSweepAt = 0;
let indexSweepInFlight = false;

// Notes with no embeddable content. They can never appear in the index, so
// "missing from the index" alone would re-select them on every single pass.
// In-process only: a restart re-checks them once, which is cheap and keeps this
// out of the schema.
const emptyNotes = new Set<string>();

// Per-vault set of Fireflies transcript ids that are un-deletable (owned by a
// teammate, needs team-admin). Kept in-process so we don't waste the daily
// budget retrying the same denied delete every slot; a restart retries once.
const firefliesSkip = new Map<string, Set<string>>();

// The API key's own email, resolved once per process. Deletion compares meeting
// ownership against it, and re-fetching it every run would waste daily quota.
const firefliesOwnerEmail = new Map<string, string>();

// A missing credential is the one failure that produces NO output at all: every
// ingester returns 0 before it can log, mirrors stay quiet when nothing is due,
// and the whole tick goes silent — a dead pipeline reads exactly like an idle
// one. That cost 7 days of undetected downtime on 2026-08-04, when OWNER_EMAIL
// was rotated and the stored secrets were left keyed to the previous address.
// Two cases hide behind one missing row, and they deserve very different volume:
//   ORPHANED  — the credential exists under a different owner_email. Something
//               broke; this is the 08-04 bug. Warn hourly until it is fixed.
//   UNSET     — no row under any owner. A mirror-only vault is legitimately like
//               this forever, so say it once at boot and never again.
const missingSecretWarnedAt = new Map<string, number>();
const unsetSecretNoted = new Set<string>();
function warnMissingSecret(vaultId: string, kind: string): void {
  const key = `${vaultId}:${kind}`;
  const strays = otherSecretOwners(vaultId, kind, config.ownerEmail);
  if (strays.length === 0) {
    if (unsetSecretNoted.has(key)) return;
    unsetSecretNoted.add(key);
    console.log(`[worker] ${kind} ${vaultId}: no credential configured — ingester idle (expected for mirror-only vaults)`);
    return;
  }
  const now = Date.now();
  if (now - (missingSecretWarnedAt.get(key) ?? 0) < 3_600_000) return;
  missingSecretWarnedAt.set(key, now);
  console.warn(
    `[worker] ${kind} ${vaultId}: ORPHANED CREDENTIAL — ingest is a silent no-op. A ${kind} secret exists for ` +
      `${strays.map((s) => `"${s}"`).join(", ")} but OWNER_EMAIL is "${config.ownerEmail}". Re-key tenant_secrets ` +
      `to the current address, or re-enter the integration.`,
  );
}

/**
 * Track consecutive per-(vault, source) ingest failures so a BROKEN pipeline stops
 * looking like a noisy one.
 *
 * A transport failure repeats forever at one warn line a minute and never
 * escalates: the Matrix homeserver reached over an unsupervised SSH forward
 * produced 31,162 identical `fetch failed` warnings with nothing anywhere saying
 * "this has been down for hours" (audit 2026-08-13, F4). Warn on the first
 * failure, escalate to an error with elapsed time once it is clearly not a blip,
 * then fall silent until it either recovers (which logs) or crosses the next
 * escalation interval — so the log stays readable AND the outage stays visible.
 */
const ingestFailures = new Map<string, { count: number; since: number; lastLoggedAt: number }>();
const ESCALATE_AFTER = 5; // consecutive failures ≈ 5 minutes on the 60s tick
const ESCALATE_EVERY_MS = 3_600_000; // then at most hourly

export function noteIngestOutcome(vaultId: string, source: string, err: Error | null): void {
  const key = `${vaultId}:${source}`;
  const prev = ingestFailures.get(key);

  if (!err) {
    if (prev) {
      const mins = Math.round((Date.now() - prev.since) / 60_000);
      console.log(`[worker] ${source} ${vaultId}: RECOVERED after ${prev.count} failed run(s) over ~${mins}m`);
      ingestFailures.delete(key);
    }
    return;
  }

  const now = Date.now();
  const state = prev ?? { count: 0, since: now, lastLoggedAt: 0 };
  state.count++;

  // First failure: one warn (could be a blip). At the escalation threshold, and
  // at most hourly after that: an error naming how long it has actually been down.
  // Everything in between is silent — the per-minute repeat was the noise that
  // made the real outage invisible.
  const escalating = state.count >= ESCALATE_AFTER && now - state.lastLoggedAt >= ESCALATE_EVERY_MS;
  if (state.count === 1) {
    console.warn(`[worker] ${source} ${vaultId} failed:`, err.message);
    state.lastLoggedAt = now;
  } else if (state.count === ESCALATE_AFTER || escalating) {
    const mins = Math.round((now - state.since) / 60_000);
    console.error(
      `[worker] ${source} ${vaultId}: DOWN — ${state.count} consecutive failures over ~${mins}m. ` +
        `Last error: ${err.message}. Ingest for this source has produced nothing that whole time.`,
    );
    state.lastLoggedAt = now;
  }
  ingestFailures.set(key, state);
}

/** Clear all tracked failure state (tests; also a natural restart boundary). */
export function resetIngestFailures(): void {
  ingestFailures.clear();
}

/** Current consecutive-failure state, for tests and for /api/integrations status. */
export function ingestFailureState(): Array<{ vaultId: string; source: string; count: number; sinceMs: number }> {
  const now = Date.now();
  return [...ingestFailures.entries()].map(([k, v]) => {
    const [vaultId, source] = k.split(":");
    return { vaultId: vaultId!, source: source!, count: v.count, sinceMs: now - v.since };
  });
}

/** Run one Matrix ingest pass for a vault, if it has a stored credential.
 *  Returns the message count ingested (0 if not configured / nothing new). */
export async function runMatrixOnce(entry: VaultEntry): Promise<number> {
  // The workspace's Matrix integration is owned by the operator (config.ownerEmail)
  // for now; a per-member model can key it differently later.
  const raw = getSecret(entry.id, config.ownerEmail, "matrix");
  if (!raw) {
    warnMissingSecret(entry.id, "matrix");
    return 0;
  }
  const creds = JSON.parse(raw) as MatrixCreds;
  const client = new MatrixClient(creds);
  const since = getWorkerCursor(entry.id, "matrix") ?? undefined;
  const res = await ingestMatrix(client, vaultClient(entry.id) as unknown as IngestVault, {
    since,
    autoJoin: config.matrixAutoJoin,
    maxJoinsPerRun: config.matrixAutoJoinPerRun,
  });
  if (res.nextBatch) setWorkerCursor(entry.id, "matrix", res.nextBatch);
  if (res.messages > 0 || res.joined > 0) {
    console.log(`[worker] matrix ${entry.id}: +${res.messages} msgs (${res.created} new threads, ${res.updated} updated, ${res.joined} rooms joined)`);
  }
  // Un-joined rooms are invisible to /sync — say so, once per pass that sees them,
  // instead of looking healthy while every new chat since the last join is dropped.
  if (res.invitesPending > 0 && !config.matrixAutoJoin) {
    console.warn(`[worker] matrix ${entry.id}: ${res.invitesPending} pending room invite(s) not joined — their messages are NOT ingested. Set MATRIX_AUTO_JOIN=true to accept them.`);
  }
  return res.messages;
}

/**
 * Run one Fathom transcript ingest pass for a vault, if it has a stored key.
 * Create-only + dedup by source_id (safe to run alongside the desktop).
 *
 * Throttled and heartbeat-logged (audit 2026-08-13, F10). Two problems, one fix:
 * this ran on every 60s tick and re-fetched the vault's ENTIRE transcript set to
 * dedupe against — once a minute, forever — while Fireflies has superseded it as
 * the transcript source (nothing new since 2026-07-06). And because it only
 * logged when it created something, a genuinely broken Fathom was byte-for-byte
 * indistinguishable from a correctly idle one. Now: one run per interval, and one
 * line per run whatever the outcome, exactly like the Fireflies ingester.
 */
export async function runFathomOnce(entry: VaultEntry, opts: { force?: boolean } = {}): Promise<number> {
  const raw = getSecret(entry.id, config.ownerEmail, "fathom");
  if (!raw) {
    warnMissingSecret(entry.id, "fathom");
    return 0;
  }
  const slot = Math.floor(Date.now() / config.fathomIntervalMs);
  if (!opts.force) {
    if (getWorkerCursor(entry.id, "fathom-slot") === String(slot)) return 0;
    setWorkerCursor(entry.id, "fathom-slot", String(slot)); // claim up front
  }
  const { apiKey } = JSON.parse(raw) as { apiKey: string };
  const client = new FathomClient(apiKey);
  const res = await ingestFathom(client, vaultClient(entry.id) as unknown as IngestVault);
  console.log(
    `[worker] fathom ${entry.id}: +${res.created} transcripts (${res.skipped} skipped)` +
      (opts.force ? " [forced]" : ""),
  );
  return res.created;
}

/** Run one ClickUp task ingest pass for a vault, if it has a stored credential.
 *  Throttled to one run per CLICKUP_INTERVAL_MS slot (0 disables); `force`
 *  bypasses the gate (the on-demand /api/integrations/clickup/sync route).
 *  The cursor is the max task `date_updated` (ms) from the last CLEAN pass —
 *  never Date.now() — advanced only forward; each incremental run re-covers a
 *  120s overlap so a task updated during the previous pass can't be missed. */
export async function runClickUpOnce(entry: VaultEntry, opts: { force?: boolean } = {}): Promise<number> {
  const raw = getSecret(entry.id, config.ownerEmail, "clickup");
  if (!raw) {
    warnMissingSecret(entry.id, "clickup");
    return 0;
  }
  if (config.clickupIntervalMs <= 0 && !opts.force) return 0;
  const slot = Math.floor(Date.now() / config.clickupIntervalMs);
  if (!opts.force) {
    if (getWorkerCursor(entry.id, "clickup-slot") === String(slot)) return 0;
    setWorkerCursor(entry.id, "clickup-slot", String(slot)); // claim up front
  }
  const credential = JSON.parse(raw) as ClickUpCredential;
  const client = new ClickUpClient(credential.apiKey);
  const cursor = getWorkerCursor(entry.id, "clickup");
  const sinceMs = cursor ? Number(cursor) - 120_000 : null;
  const res = await ingestClickUp(client, vaultClient(entry.id) as unknown as ClickUpVault, { credential, sinceMs });
  const prev = cursor ? Number(cursor) : 0;
  const next = Math.max(res.maxDateUpdatedMs, prev); // clean-pass value only, never backward
  if (next > 0) setWorkerCursor(entry.id, "clickup", String(next));
  console.log(
    `[worker] clickup ${entry.id}: +${res.created} created ~${res.updated} updated ·${res.skipped} skipped` +
      (res.errors ? ` !${res.errors} FAILED (cursor clamped to retry)` : "") +
      (res.rateLimited ? " [rate-limited, cursor held]" : "") +
      (opts.force ? " [forced]" : ` [slot ${slot}]`),
  );
  return res.created + res.updated;
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
  if (!raw) {
    warnMissingSecret(entry.id, "fireflies");
    return 0;
  }
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

/**
 * Keep the semantic-search index current from the ALWAYS-ON process.
 *
 * Until 2026-08-13 nothing here indexed: `indexNote` was reachable only through
 * the owner-only `/api/index/notes` route, and its sole caller was the DESKTOP
 * app's 5-minute sweep. So the index advanced only while the desktop happened to
 * be open — web and mobile searched an ageing index with no signal that anything
 * was wrong. (Measured gap: zero embeddings written 2026-07-30 → 08-10.) The
 * server owns the index and the query path, so it should own the maintenance too.
 *
 * Incremental by design, because a full sweep is expensive:
 *   - the LEAN note list (no bodies) is one cheap call and carries `updatedAt`;
 *   - only notes newer than the cursor have their body fetched and re-embedded;
 *   - `indexNote` still hash-skips, so a redundant push costs nothing;
 *   - ids that vanished from the vault are de-indexed (orphan vectors are hits
 *     for notes that no longer exist).
 * With no cursor — first boot, or an embedder change, which changes the model id
 * every vector is stored under — it falls back to one full content sweep, which
 * is exactly the backfill those cases need.
 *
 * Primary vault only: the `embeddings` table is keyed by note id with no vault
 * column, so indexing a second vault would collide ids in one namespace.
 */
export async function runIndexOnce(opts: { force?: boolean } = {}): Promise<number> {
  // A first-run backfill of a full vault takes far longer than one sweep
  // interval, so without this guard the timer would start a SECOND sweep over
  // the same notes while the first is still embedding — doubling the load on the
  // embedding endpoint and racing two writers over the same rows.
  if (indexSweepInFlight) return 0;
  indexSweepInFlight = true;
  try {
    return await indexSweep(opts);
  } finally {
    indexSweepInFlight = false;
  }
}

async function indexSweep(opts: { force?: boolean }): Promise<number> {
  const model = getEmbedder().id;
  const cursorKey = `index-sweep:${model}`; // model-scoped → a model swap re-backfills
  const since = opts.force ? null : getWorkerCursor("primary", cursorKey);

  // Lean list first: ids + updatedAt for the whole vault, no bodies.
  const lean = await vault.listNotes({});
  const newest = lean.reduce((mx, n) => {
    const t = n.updatedAt ?? n.createdAt ?? "";
    return t > mx ? t : mx;
  }, "");

  // Work is selected by what the index is actually MISSING, not by the cursor
  // alone. Two independent reasons a note needs embedding:
  //   · it has no vectors under this model — never indexed, or a past attempt
  //     failed. This is what makes the sweep self-healing: a note that errors
  //     stays un-indexed, so it is re-selected next pass no matter what.
  //   · its content changed since the cursor — the steady-state case.
  // A pure timestamp cursor had neither property. It also drove the backfill off
  // ONE bulk `includeContent` call over the whole vault (~100MB in a single
  // response, re-issued every interval), and a single transient failure anywhere
  // in that loop aborted the pass before the cursor advanced — so it restarted
  // the entire backfill forever and never converged. Content is now fetched
  // per note: bounded memory, and one bad note costs one note.
  // An EMPTY note (no chunks) never lands in the index by design, so
  // "missing from the index" would re-select it on every pass forever. Skipping
  // it needs the same signal the sweep already has: its content is unchanged, so
  // once the cursor is past it there is nothing to do. Before the cursor exists,
  // one fetch per empty note per pass is the price, and it is bounded.
  const alreadyIndexed = indexedNoteIds(model);
  const changedSince = (n: { updatedAt: string | null; createdAt: string }) =>
    since !== null && (n.updatedAt ?? n.createdAt ?? "") > since;

  const needsIndexing = (n: (typeof lean)[number]): boolean => {
    if (opts.force) return true;
    if (changedSince(n)) return true; // content moved — re-embed regardless
    if (alreadyIndexed.has(n.id)) return false; // has vectors, unchanged
    if (emptyNotes.has(n.id)) return false; // has no chunks to embed, unchanged
    return true; // missing from the index → try it
  };
  const work = lean.filter(needsIndexing);

  let indexed = 0;
  let failed = 0;
  let retried = 0;
  for (const n of work) {
    try {
      // One retry on a short backoff. The failures seen here are transient
      // `fetch failed` connection drops under sustained back-to-back requests —
      // not bad notes; every note that failed embeds fine in isolation. Without
      // a retry each blip defers that note to an entire next pass.
      let status: IndexResult["status"];
      try {
        status = (await indexNote(n.id, await noteContent(n.id), opts.force)).status;
      } catch {
        retried++;
        await new Promise((r) => setTimeout(r, 1000));
        status = (await indexNote(n.id, await noteContent(n.id), opts.force)).status;
      }
      if (status === "indexed") indexed++;
      if (status === "empty") emptyNotes.add(n.id);
    } catch (e) {
      failed++;
      // Name the note. "index primary failed: fetch failed" with no id was
      // undiagnosable; the id is what makes a recurring bad note findable.
      if (failed <= 3) {
        console.warn(`[worker] index primary: note ${n.id} (${n.path ?? "?"}) failed:`, (e as Error).message);
      }
    }
  }

  // Drop vectors for notes that no longer exist in the vault — across ALL
  // models, not just the current one. A model-scoped scan cannot see rows left
  // by a PREVIOUS embedder for a note deleted since the switch, so those orphans
  // would survive forever (observed: 2 notes stuck after the nomic switch).
  const live = new Set(lean.map((n) => n.id));
  let dropped = 0;
  for (const id of allIndexedNoteIds()) {
    if (!live.has(id)) {
      deindexNote(id);
      dropped++;
    }
  }

  // Advance the cursor only on a CLEAN pass. A note that failed is still
  // un-indexed and would be re-selected regardless — but a note that was already
  // indexed and merely CHANGED is only findable by timestamp, so moving the
  // cursor past a pass that dropped work could strand a stale copy.
  if (newest && failed === 0) setWorkerCursor("primary", cursorKey, newest);

  // Log whenever anything happened OR anything failed. A pass that only fails
  // must never be silent — that silence is what let the stalled backfill run for
  // hours looking exactly like a finished one.
  if (indexed > 0 || dropped > 0 || failed > 0) {
    // `still missing` is the number that actually matters during a backfill: it
    // is what the NEXT pass will pick up, so a converging sweep visibly counts
    // down and a stuck one visibly doesn't.
    const nowIndexed = indexedNoteIds(model);
    const stillMissing = lean.filter((n) => !nowIndexed.has(n.id) && !emptyNotes.has(n.id)).length;
    console.log(
      `[worker] index primary: +${indexed} embedded, -${dropped} dropped` +
        (retried ? `, ${retried} retried` : "") +
        (failed ? `, ${failed} FAILED` : "") +
        `, ${stillMissing} still missing (model=${model}${failed === 0 ? "" : "; cursor held"})`,
    );
  }
  return indexed;
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
        ["clickup", runClickUpOnce],
      ] as const) {
        try {
          await run(entry);
          noteIngestOutcome(entry.id, name, null);
        } catch (e) {
          noteIngestOutcome(entry.id, name, e as Error);
        }
      }
    }
  }
  // Vault mirrors are per-PAIR (source vault × dest vault), not per-vault-entry,
  // hence their own iteration. Each mirror throttles itself (last_run_at), so a
  // 60s tick costs one SELECT when nothing is due.
  await runVaultMirrorsOnce();

  // Semantic index maintenance, on its own slower cadence — embeddings are not
  // latency-critical, and even the lean note list is a whole-vault fetch, so it
  // has no business running on the 60s ingest tick.
  if (indexSweepEnabled() && Date.now() - lastIndexSweepAt >= config.indexIntervalMs) {
    lastIndexSweepAt = Date.now();
    try {
      await runIndexOnce();
    } catch (e) {
      console.warn("[worker] index primary failed:", (e as Error).message);
    }
  }
}

/** A note's content, fetched on its own. The backfill used to pull every note's
 *  body in ONE call over the whole vault; per-note keeps memory bounded and makes
 *  a failure cost exactly one note. */
async function noteContent(id: string): Promise<string> {
  return (await vault.getNote(id)).content ?? "";
}

/** Is periodic index maintenance turned on? (INDEX_INTERVAL_MS=0 disables it.) */
export const indexSweepEnabled = (): boolean => config.indexIntervalMs > 0;

/** Start the worker loop. No-op if already running, or if there is nothing any
 *  subsystem could ever do: no secrets (→ no ingesters), no mirrors, AND no index
 *  sweep. Index maintenance now counts toward "something to do" — it is the one
 *  subsystem that needs no credential, which is why the loop can be worth running
 *  on a server that has none. The interval is unref'd so it never blocks shutdown.
 *  POST /acl/mirrors re-invokes this, so creating the first mirror on a
 *  secrets-less server starts the loop without a restart. */
export function startWorker(intervalMs = 60_000): void {
  if (timer || (!secretsConfigured() && listVaultMirrors().length === 0 && !indexSweepEnabled())) return;
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
