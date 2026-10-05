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
 * Gmail (gog-backed, GMAIL_SYNC_ENABLED) and Calendar (gog-backed, WP1.3:
 * CALENDAR_SYNC_ENABLED / CALENDAR_SHADOW) run here too when enabled; Meetily
 * stays desktop for now (host-bound).
 */
import { getVaultRegistry, getWorkerCursor, setWorkerCursor, listVaultMirrors } from "../db";
import { getSecret, secretsConfigured, otherSecretOwners } from "../secrets";
import { config, type VaultEntry } from "../config";
import { vault, vaultClient } from "../parachute";
import { MatrixClient, ingestMatrix, reconcileMatrix, type IngestVault, type MatrixCreds, type RoomReplay } from "./matrix";
import { FathomClient, ingestFathom } from "./fathom";
import { FirefliesClient, FirefliesError, ingestAndCleanupFireflies, type FirefliesBudget, type FirefliesVault } from "./fireflies";
import { ClickUpClient, ingestClickUp, type ClickUpCredential, type ClickUpVault } from "./clickup";
import { GmailClient, ingestGmail, type GmailVault, type GogRunner } from "./gmail";
import { calendarMode, calendarSourceName, runCalendarOnce } from "./calendar";
import { protonMode, runProtonOnce } from "./proton";
import { ForwardLinker, IngestReviewSink } from "../people-forward";
import { ownerConfigFor } from "../people-owner";
import { ownerProfile } from "../identity";
import type { PeopleIndex } from "./people";
import { runVaultMirrorsOnce } from "./vault-mirror";
import { loadGovernance } from "../governance-service";
import { reconcileGovernanceGrants, type ReconcileResult } from "../governance-grants";
import { GOV_TAGS } from "../governance-store";
import { indexNote, deindexNote, type IndexResult } from "../rag/service";
import { getEmbedder } from "../rag/embedder";
import { indexedNoteIds, allIndexedNoteIds } from "../rag/store";
import { runHistoryCompactOnce } from "./history-compact";
import { runTrashPurgeOnce, purgeEnabled as trashPurgeEnabled } from "../pages";
import { recordSourceOutcome, runHealthCheckOnce } from "./health";
import { defaultSkillsDeps, runSkillsOnce, type PassResult, type SkillsDeps } from "./skills";
import { notionDbBackgroundEnabled, runNotionDbPassOnce } from "./notion-db-service";

let timer: ReturnType<typeof setInterval> | null = null;

// Index maintenance runs on a slower cadence than the 60s ingest tick; this is
// the in-process throttle (the durable "how far have we indexed" state is the
// per-model worker cursor, so a restart resumes rather than re-sweeping).
let lastIndexSweepAt = 0;
// Note-history compaction (vault ≥0.7.9): nightly-ish, in-process throttle. The
// first tick after boot waits one interval rather than compacting immediately —
// every vault also compacts on its own when it (re)starts.
let lastHistoryCompactAt = Date.now();
let historyCompactInFlight = false;
let lastTrashPurgeAt = 0;
let trashPurgeInFlight = false;
let indexSweepInFlight = false;

// Governance→grants reconcile state. `governanceExists` caches the one question
// that decides whether this subsystem does anything at all, so a deploy with no
// constitution pays a single cheap listNotes per interval instead of a full state
// load every tick. Re-probed on the same cadence, so enabling governance is
// picked up within one interval with no restart.
let lastGovernanceReconcileAt = 0;
let governanceExists: boolean | null = null;
let governanceProbedAt = 0;

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
/** How often the current Fireflies slot was handed back after a failure on our side (`<vault>:<slot>` → count). */
const firefliesSlotReturns = new Map<string, number>();

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
  recordSourceOutcome(vaultId, source, err); // health registry (GET /acl/workers + alerts)

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
/** The identity layer's forward linker for one ingest pass — undefined (= the
 *  ingester behaves exactly as before) unless that source's link flag is on. */
function forwardLinker(entry: VaultEntry, origin: string, enabled: boolean, timeoutMs = 0): ForwardLinker | undefined {
  if (!enabled) return undefined;
  return new ForwardLinker(vaultClient(entry.id, timeoutMs > 0 ? { timeoutMs } : {}), {
    vaultId: entry.id,
    origin,
    owner: ownerConfigFor(entry.id),
    queue: config.peopleQueueOnIngest,
    maxRecipients: config.peopleLinkMaxRecipients,
  });
}

let matrixPass = 0;
const matrixSelf = new Map<string, string>();
const lastMatrixReconcileAt = new Map<string, number>();
const lastBridgeResyncAt = new Map<string, number>();

/** What a Matrix pass talks to. Tests inject both; production builds them from the stored credential. */
export interface MatrixPassDeps {
  client?: Parameters<typeof ingestMatrix>[0] & Partial<Parameters<typeof reconcileMatrix>[0]> & { whoami?: () => Promise<string>; sendText?: (roomId: string, text: string) => Promise<unknown> };
  vault?: IngestVault;
}

/** A room a pass failed on, kept until a later pass has replayed its window. */
interface PendingReplay extends RoomReplay {
  tries: number;
}
const MATRIX_REPLAY_CURSOR = "matrix-replay";
const MATRIX_LOST_CURSOR = "matrix-lost";
const MATRIX_REPLAY_CAP = 2000;

function readJsonCursor<T>(vaultId: string, kind: string): T[] {
  try {
    const v = JSON.parse(getWorkerCursor(vaultId, kind) ?? "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
/** A room given up on after MATRIX_REPLAY_MAX_TRIES failed replays. */
export interface LostMatrixRoom {
  roomId: string;
  since: string | null;
  tries: number;
  at: string;
}
/** Rooms given up on and not yet cleared by the owner: the `matrix` source reads
 *  `failing` while this is non-empty (worker/health.ts), and they are not replayed
 *  again (a room that fails forever must not cycle try → give up → try). */
export const lostMatrixRooms = (vaultId: string): LostMatrixRoom[] =>
  readJsonCursor<LostMatrixRoom>(vaultId, MATRIX_LOST_CURSOR).filter((p) => p && typeof p.roomId === "string");
/** The owner looked: forget the given-up rooms (they may be replayed again if they fail again). */
export function clearLostMatrixRooms(vaultId: string): number {
  const n = lostMatrixRooms(vaultId).length;
  if (n) setWorkerCursor(vaultId, MATRIX_LOST_CURSOR, "[]");
  return n;
}

/** Rooms waiting for a replay (diagnostics + tests). */
export const pendingMatrixReplays = (vaultId: string): Array<{ roomId: string; since?: string; tries: number }> =>
  readJsonCursor<PendingReplay>(vaultId, MATRIX_REPLAY_CURSOR).filter((p) => p && typeof p.roomId === "string");

/** One pass per vault at a time. The tick fires every 60 s whether or not the last
 *  one finished, and `POST /api/integrations/matrix/sync` runs a pass on demand; two
 *  passes started from the same cursor would each append the same events. */
const matrixInFlight = new Map<string, Promise<number>>();
export const matrixPassRunning = (vaultId: string): boolean => matrixInFlight.has(vaultId);

/** The hourly reconcile sweep (+ the bridge resync) has its OWN per-vault guard and
 *  runs AFTER the ingest guard is released: it can take minutes (one probe per joined
 *  room), and ingest must keep its 60 s cadence meanwhile. The two may write the same
 *  thread at once — the compare-and-set append + `notYetWritten` make that safe. */
const matrixReconcileInFlight = new Map<string, Promise<void>>();
export const matrixReconcileRunning = (vaultId: string): boolean => matrixReconcileInFlight.has(vaultId);
/** Resolves when the vault's background reconcile (if any) has finished. */
export const matrixReconcileSettled = (vaultId: string): Promise<void> => matrixReconcileInFlight.get(vaultId) ?? Promise.resolve();

/** Where the last reconcile sweep's probe stopped (a room id; rooms are probed in
 *  sorted order). Empty = the next sweep starts at the front. */
const MATRIX_RECONCILE_CURSOR = "matrix-reconcile-after";
/** Rooms the last sweep left unsettled (probe threw, repair failed / over budget / out of
 *  time): the next sweep probes them first, wherever the resume point is. */
const MATRIX_RECONCILE_RETRY_CURSOR = "matrix-reconcile-retry";

/**
 * One reconcile sweep that CONTINUES where the previous one was cut off by its
 * deadline. Probing used to start at the front of the joined-rooms list every time,
 * so with more rooms than one deadline covers the tail was never reached. The
 * resume point is persisted per vault (worker cursor), so a restart continues too.
 */
export async function runMatrixReconcileSweep(
  entry: VaultEntry,
  client: Parameters<typeof reconcileMatrix>[0],
  ingestVault: IngestVault,
  upTo: string,
  overrides: { deadlineMs?: number; now?: () => number; concurrency?: number; probeShare?: number; maxRepairs?: number } = {},
): Promise<Awaited<ReturnType<typeof reconcileMatrix>>> {
  const r = await reconcileMatrix(client, ingestVault, {
    upTo,
    maxRepairs: overrides.maxRepairs ?? config.matrixReconcilePerSweep,
    deadlineMs: overrides.deadlineMs ?? config.matrixReconcileDeadlineMs,
    resumeAfter: getWorkerCursor(entry.id, MATRIX_RECONCILE_CURSOR) || null,
    retry: readJsonCursor<string>(entry.id, MATRIX_RECONCILE_RETRY_CURSOR).filter((id) => typeof id === "string"),
    ...(overrides.probeShare ? { probeShare: overrides.probeShare } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.concurrency ? { concurrency: overrides.concurrency } : {}),
  });
  setWorkerCursor(entry.id, MATRIX_RECONCILE_CURSOR, r.resumeAfter ?? "");
  setWorkerCursor(entry.id, MATRIX_RECONCILE_RETRY_CURSOR, JSON.stringify(r.retry ?? []));
  return r;
}

/**
 * One Matrix pass for a vault. If one is already running, this JOINS it (returns
 * the running pass's promise) — it never starts a second. The tick skips instead
 * (and records no outcome, so a pass that hangs shows up as `stale`); the manual
 * route answers 409 `busy`.
 */
export function runMatrixOnce(entry: VaultEntry, deps: MatrixPassDeps = {}): Promise<number> {
  const running = matrixInFlight.get(entry.id);
  if (running) return running;
  const pass = runMatrixPass(entry, deps).finally(() => {
    if (matrixInFlight.get(entry.id) === pass) matrixInFlight.delete(entry.id);
  });
  matrixInFlight.set(entry.id, pass);
  return pass;
}

async function runMatrixPass(entry: VaultEntry, deps: MatrixPassDeps): Promise<number> {
  await Promise.resolve(); // never run any of the pass in the caller's synchronous frame
  let client = deps.client;
  if (!client) {
    // The workspace's Matrix integration is owned by the operator (config.ownerEmail)
    // for now; a per-member model can key it differently later.
    const raw = getSecret(entry.id, config.ownerEmail, "matrix");
    if (!raw) {
      warnMissingSecret(entry.id, "matrix");
      return 0;
    }
    // Every homeserver read is bounded: with the one-pass-at-a-time guard, a read
    // that never answers would otherwise stop Matrix ingest until a restart.
    client = new MatrixClient(JSON.parse(raw) as MatrixCreds, fetch, config.matrixReadTimeoutMs > 0 ? config.matrixReadTimeoutMs : undefined);
  }
  // …and so is every vault call (a pass makes one body read per active room).
  const ingestVault = deps.vault ?? (vaultClient(entry.id, config.matrixVaultTimeoutMs > 0 ? { timeoutMs: config.matrixVaultTimeoutMs } : {}) as unknown as IngestVault);
  const since = getWorkerCursor(entry.id, "matrix") ?? undefined;
  const pending = pendingMatrixReplays(entry.id);
  // MATRIX_LINK_PEOPLE: the sync user is never linked as a participant.
  let selfUserId: string | null = null;
  if (config.matrixLinkPeople || config.matrixLinkExisting) {
    selfUserId = matrixSelf.get(entry.id) ?? null;
    if (!selfUserId) {
      selfUserId = client.whoami ? await client.whoami().catch(() => null) : null;
      if (selfUserId) matrixSelf.set(entry.id, selfUserId);
    }
  }
  const res = await ingestMatrix(client, ingestVault, {
    since,
    // Replay needs a cursor to page back from; with none (first pass ever) the rows wait.
    ...(since && pending.length ? { replay: pending.map((p) => ({ roomId: p.roomId, ...(p.since ? { since: p.since } : {}) })) } : {}),
    autoJoin: config.matrixAutoJoin,
    maxJoinsPerRun: config.matrixAutoJoinPerRun,
    // Probe the full invite backlog every 10th pass (~10 min) — or every pass
    // while auto-join is draining it.
    probeInvites: config.matrixAutoJoin || matrixPass++ % 10 === 0,
    linkPeople: config.matrixLinkPeople,
    linkExisting: config.matrixLinkExisting,
    storeParticipantIds: config.matrixStoreParticipantIds,
    selfUserId,
    // Identity layer (only with MATRIX_LINK_EXISTING): never link the owner's own
    // note; queue DM counterparts that have a candidate but no exact match.
    ...(config.matrixLinkExisting
      ? {
          ownerPersonId: (people: PeopleIndex) => ownerProfile(people.identity, ownerConfigFor(entry.id, { matrixId: selfUserId })).person?.id ?? null,
          ...(config.peopleQueueOnIngest ? { reviewSink: new IngestReviewSink({ vaultId: entry.id, origin: "ingest:matrix", relationship: "messages-with" }) } : {}),
        }
      : {}),
  });
  if (res.peopleCreated > 0) console.log(`[worker] matrix ${entry.id}: ${res.peopleCreated} person note(s) created (MATRIX_LINK_PEOPLE)`);
  // Failed rooms are persisted BEFORE the cursor moves past them: a crash between
  // the two re-runs the pass, it never forgets a room.
  const next: PendingReplay[] = [];
  const gaveUp: PendingReplay[] = [];
  for (const p of pending) {
    if (res.replayed.ok.includes(p.roomId)) continue;
    if (!res.replayed.failed.includes(p.roomId)) next.push(p); // not attempted this pass
    else if (p.tries + 1 >= config.matrixReplayMaxTries) gaveUp.push({ ...p, tries: p.tries + 1 });
    else next.push({ ...p, tries: p.tries + 1 });
  }
  const alreadyLost = new Set(lostMatrixRooms(entry.id).map((l) => l.roomId));
  for (const roomId of res.failedRooms) {
    // Given up on and not cleared yet: not queued again (it would cycle forever).
    if (alreadyLost.has(roomId)) continue;
    // A room already waiting keeps its OLDER cursor (the wider window).
    if (!next.some((p) => p.roomId === roomId)) next.push({ roomId, ...(since ? { since } : {}), tries: 0 });
  }
  while (next.length > MATRIX_REPLAY_CAP) gaveUp.push(next.shift()!);
  if (pending.length || next.length) setWorkerCursor(entry.id, MATRIX_REPLAY_CURSOR, JSON.stringify(next));
  if (gaveUp.length) {
    const lost = [...lostMatrixRooms(entry.id), ...gaveUp.map((p) => ({ roomId: p.roomId, since: p.since ?? null, tries: p.tries, at: new Date().toISOString() }))].slice(-200);
    setWorkerCursor(entry.id, MATRIX_LOST_CURSOR, JSON.stringify(lost));
  }
  if (res.nextBatch) setWorkerCursor(entry.id, "matrix", res.nextBatch);
  if (res.messages > 0 || res.joined > 0) {
    console.log(`[worker] matrix ${entry.id}: +${res.messages} msgs (${res.created} new threads, ${res.updated} updated, ${res.joined} rooms joined)`);
  }
  // Un-joined rooms are invisible to /sync — say so, once per pass that sees them,
  // instead of looking healthy while every new chat since the last join is dropped.
  if (res.invitesPending > 0 && !config.matrixAutoJoin) {
    console.warn(`[worker] matrix ${entry.id}: ${res.invitesPending} pending room invite(s) not joined — their messages are NOT ingested. Set MATRIX_AUTO_JOIN=true to accept them.`);
  }

  // The repair sweep, bounded to the cursor just persisted so it never overlaps
  // the next incremental pass. Runs on boot too (the map starts empty) — which
  // is exactly when a downtime gap needs closing. It is STARTED here and runs in
  // the background under its own guard: this pass (and the ingest guard) end now.
  const now = Date.now();
  const canReconcile = !!(client.joinedRooms && client.messagesBefore && client.joinedMembers && client.roomName);
  const reconcileDue = canReconcile && !!res.nextBatch && config.matrixReconcileMs > 0 && now - (lastMatrixReconcileAt.get(entry.id) ?? 0) >= config.matrixReconcileMs;
  const resyncDue = !!client.sendText && config.matrixBridgeResync.length > 0 && config.matrixBridgeResyncMs > 0 && now - (lastBridgeResyncAt.get(entry.id) ?? 0) >= config.matrixBridgeResyncMs;
  if ((reconcileDue || resyncDue) && !matrixReconcileInFlight.has(entry.id)) {
    if (reconcileDue) lastMatrixReconcileAt.set(entry.id, now);
    if (resyncDue) lastBridgeResyncAt.set(entry.id, now);
    const upTo = res.nextBatch;
    const background = (async () => {
      await Promise.resolve();
      if (reconcileDue) {
        try {
          const r = await runMatrixReconcileSweep(entry, client as Parameters<typeof reconcileMatrix>[0], ingestVault, upTo);
          const line = `[worker] matrix ${entry.id} reconcile: ${r.scanned} of ${r.rooms} rooms probed, ${r.behind} behind, ${r.repaired} repaired (+${r.messages} msgs), ${r.deferred} deferred${r.unprobed ? `, ${r.unprobed} not reached before the deadline` : ""}`;
          if (r.behind > 0 || r.unprobed) console.warn(line);
          else console.log(line);
          // Deferred / unreached rooms may still miss messages — come back in 5 min, not an hour.
          if (r.deferred > 0 || r.unprobed || r.retry?.length) lastMatrixReconcileAt.set(entry.id, now - config.matrixReconcileMs + 300_000);
        } catch (e) {
          console.warn(`[worker] matrix ${entry.id} reconcile failed: ${String(e)}`);
        }
      }
      if (resyncDue && client.sendText) {
        for (const b of config.matrixBridgeResync) {
          await client.sendText(b.roomId, b.command).then(
            () => console.log(`[worker] matrix ${entry.id}: bridge resync "${b.command}" → ${b.roomId}`),
            (e) => console.warn(`[worker] matrix ${entry.id}: bridge resync to ${b.roomId} failed: ${String(e)}`),
          );
        }
      }
    })().finally(() => {
      if (matrixReconcileInFlight.get(entry.id) === background) matrixReconcileInFlight.delete(entry.id);
    });
    matrixReconcileInFlight.set(entry.id, background);
  }
  // Never silent: a room whose window could not be replayed in N passes is given
  // up on, and THIS pass is reported as failed (everything above is already done
  // and persisted). The rooms are listed under the `matrix-lost` worker cursor.
  if (gaveUp.length) {
    const msg = `gave up replaying ${gaveUp.length} room(s) after ${config.matrixReplayMaxTries} attempt(s) — their messages from the failed pass may be missing (rooms: ${gaveUp.slice(0, 5).map((p) => p.roomId).join(", ")}${gaveUp.length > 5 ? ", …" : ""}; full list in settings cursor:${MATRIX_LOST_CURSOR}:${entry.id})`;
    console.error(`[worker] matrix ${entry.id}: ERROR ${msg}`);
    throw new Error(`matrix: ${msg}`);
  }
  return res.messages;
}

/** The ingesters that share the per-(source, vault) guard below. */
export type GuardedSource = "fathom" | "fireflies" | "clickup";
const GUARDED_SOURCES: ReadonlySet<string> = new Set<GuardedSource>(["fathom", "fireflies", "clickup"]);

/**
 * One pass per (source, vault) at a time — the guard Matrix has. The tick fires
 * every 60 s whether or not the last one finished: a pass that overran its slot
 * used to be started a second time (two writers creating the same notes), and the
 * extra call returned at once and recorded a SUCCESS while the first was still
 * hung. A call while one runs JOINS it; the tick skips instead (no outcome, so a
 * pass that never finishes reads `stale`); the manual sync routes answer 409 `busy`.
 */
const ingestInFlight = new Map<string, Promise<number>>();
const flightKey = (source: string, vaultId: string): string => `${source}:${vaultId}`;
export const ingestPassRunning = (source: GuardedSource, vaultId: string): boolean => ingestInFlight.has(flightKey(source, vaultId));
function onePass(source: GuardedSource, entry: VaultEntry, pass: () => Promise<number>): Promise<number> {
  const key = flightKey(source, entry.id);
  const running = ingestInFlight.get(key);
  if (running) return running;
  const p = (async () => {
    await Promise.resolve(); // never run any of the pass in the caller's synchronous frame
    return pass();
  })().finally(() => {
    if (ingestInFlight.get(key) === p) ingestInFlight.delete(key);
  });
  ingestInFlight.set(key, p);
  return p;
}
/** An upstream API (ClickUp / Fathom / Fireflies) did not answer within INGEST_UPSTREAM_TIMEOUT_MS. */
export class UpstreamTimeoutError extends Error {
  constructor(host: string, ms: number) {
    super(`${host} did not answer within ${Math.round(ms / 1000)} s`);
    this.name = "UpstreamTimeoutError";
  }
}
/** `fetch` for those clients: every request bounded, so a stalled upstream fails the pass
 *  (a recorded failure, the guard released) instead of holding it for ever. */
const upstreamFetch: typeof fetch = async (input, init) => {
  const ms = config.ingestUpstreamTimeoutMs;
  if (!(ms > 0) || init?.signal) return fetch(input, init);
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") {
      let host = "upstream";
      try { host = new URL(String(input instanceof Request ? input.url : input)).host; } catch { /* keep */ }
      throw new UpstreamTimeoutError(host, ms);
    }
    throw e;
  }
};
/** The vault client of a ClickUp / Fathom / Fireflies pass: every call bounded (INGEST_VAULT_TIMEOUT_MS). */
const boundedVault = (entry: VaultEntry) => vaultClient(entry.id, config.ingestVaultTimeoutMs > 0 ? { timeoutMs: config.ingestVaultTimeoutMs } : {});

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
export function runFathomOnce(entry: VaultEntry, opts: { force?: boolean } = {}): Promise<number> {
  return onePass("fathom", entry, () => runFathomPass(entry, opts));
}
async function runFathomPass(entry: VaultEntry, opts: { force?: boolean }): Promise<number> {
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
  const client = new FathomClient(apiKey, upstreamFetch);
  const res = await ingestFathom(client, boundedVault(entry) as unknown as IngestVault, {
    forward: forwardLinker(entry, "ingest:fathom", config.transcriptLinkPeople, config.ingestVaultTimeoutMs),
  });
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
export function runClickUpOnce(entry: VaultEntry, opts: { force?: boolean } = {}): Promise<number> {
  return onePass("clickup", entry, () => runClickUpPass(entry, opts));
}
async function runClickUpPass(entry: VaultEntry, opts: { force?: boolean }): Promise<number> {
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
  const client = new ClickUpClient(credential.apiKey, upstreamFetch);
  const cursor = getWorkerCursor(entry.id, "clickup");
  const sinceMs = cursor ? Number(cursor) - 120_000 : null;
  const res = await ingestClickUp(client, boundedVault(entry) as unknown as ClickUpVault, {
    credential,
    sinceMs,
    forward: forwardLinker(entry, "ingest:clickup", config.clickupLinkEnabled, config.ingestVaultTimeoutMs),
  });
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

/** Vaults whose Gmail 14-day body backfill already ran in this process (the
 *  desktop did it once per app launch; the server does it once per boot). */
const gmailBackfilled = new Set<string>();
/**
 * Run one Gmail ingest pass for a vault (WP1.2). No-op unless GMAIL_SYNC_ENABLED
 * and the vault has a `google` credential ({account}). Throttled to one run per
 * GMAIL_INTERVAL_MS slot (the desktop's 3 min); `force` bypasses the gate.
 * First pass per process: `in:inbox newer_than:14d` (max 100) — the desktop's
 * body backfill; after that `in:inbox newer_than:3h` (max 30). Throws on a gog
 * or vault failure so the health registry sees it; the backfill is retried on
 * the next pass until one succeeds.
 */
export async function runGmailOnce(entry: VaultEntry, opts: { force?: boolean; run?: GogRunner } = {}): Promise<number> {
  if (!config.gmailSyncEnabled) return 0;
  const raw = getSecret(entry.id, config.ownerEmail, "google");
  if (!raw) {
    warnMissingSecret(entry.id, "google");
    return 0;
  }
  if (config.gmailIntervalMs <= 0 && !opts.force) return 0;
  const slot = Math.floor(Date.now() / Math.max(1, config.gmailIntervalMs));
  if (!opts.force) {
    if (getWorkerCursor(entry.id, "gmail-slot") === String(slot)) return 0;
    setWorkerCursor(entry.id, "gmail-slot", String(slot)); // claim up front
  }
  const { account } = JSON.parse(raw) as { account?: string };
  if (!account) throw new Error("google credential has no account");
  const backfill = !gmailBackfilled.has(entry.id);
  const query = backfill ? "in:inbox newer_than:14d" : "in:inbox newer_than:3h";
  const client = new GmailClient(account, opts.run);
  const res = await ingestGmail(client, vaultClient(entry.id) as unknown as GmailVault, {
    query,
    max: backfill ? 100 : 30,
    log: (l) => console.warn(`[worker] gmail ${entry.id}: ${l}`),
  });
  gmailBackfilled.add(entry.id);
  console.log(
    `[worker] gmail ${entry.id}: ${res.messages} msgs / ${res.threads} threads → +${res.created} created ~${res.updated} updated =${res.unchanged} unchanged` +
      (res.peopleCreated ? `, ${res.peopleCreated} people created` : "") +
      (res.failed ? ` !${res.failed} FAILED` : "") +
      (backfill ? " [14d backfill]" : "") +
      (opts.force ? " [forced]" : ` [slot ${slot}]`),
  );
  if (res.failed && res.failed === res.threads) throw new Error(`gmail: all ${res.failed} thread write(s) failed`);
  return res.created + res.updated;
}

/** Forget the per-process backfill marker (tests). */
export function resetGmailBackfill(): void {
  gmailBackfilled.clear();
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
export function runFirefliesOnce(entry: VaultEntry, opts: { force?: boolean } = {}): Promise<number> {
  return onePass("fireflies", entry, () => runFirefliesPass(entry, opts));
}
async function runFirefliesPass(entry: VaultEntry, opts: { force?: boolean }): Promise<number> {
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

  const client = new FirefliesClient(apiKey, upstreamFetch);
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
  const res = await runFirefliesLoop().catch((e: unknown) => {
    // The slot was claimed so that Fireflies' API is touched once per scheduled hour. A pass
    // that died on OUR side (the vault listing timed out, the vault was down) has not done
    // its work: give the slot back so the next tick tries again — at most twice per slot,
    // and never for a failure Fireflies itself answered or timed out on.
    const ours = !(e instanceof FirefliesError) && !(e instanceof UpstreamTimeoutError);
    const key = `${entry.id}:${slot}`;
    const given = firefliesSlotReturns.get(key) ?? 0;
    if (!opts.force && ours && given < 2 && getWorkerCursor(entry.id, "fireflies-slot") === slot) {
      for (const k of firefliesSlotReturns.keys()) if (k.startsWith(`${entry.id}:`) && k !== key) firefliesSlotReturns.delete(k); // only the current slot matters
      firefliesSlotReturns.set(key, given + 1);
      setWorkerCursor(entry.id, "fireflies-slot", "");
    }
    throw e;
  });
  function runFirefliesLoop() {
    return ingestAndCleanupFireflies(client, boundedVault(entry) as unknown as FirefliesVault, {
    budget,
    forward: forwardLinker(entry, "ingest:fireflies", config.transcriptLinkPeople, config.ingestVaultTimeoutMs),
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
  }
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
 * Automatic maintenance retains the established primary-vault schedule. Other
 * vaults use explicit durable jobs; their vectors now have isolated namespaces.
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
  // listNotes has a 50k ceiling. A partial inventory must never delete vectors
  // for the unseen remainder or claim a complete maintenance pass.
  if (lean.length >= 50_000) throw new Error("Index inventory reached its limit; refusing incomplete cleanup");
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

/**
 * Is there a governance constitution in the primary vault at all? Cached for one
 * reconcile interval — this is the guard that keeps the whole governance
 * subsystem free on the (overwhelmingly common) deploy that has never enabled it.
 */
async function governanceConfigured(): Promise<boolean> {
  const now = Date.now();
  if (governanceExists !== null && now - governanceProbedAt < config.governanceReconcileMs) {
    return governanceExists;
  }
  const notes = await vault.listNotes({ tags: [GOV_TAGS.config], limit: 1 });
  governanceExists = notes.length > 0;
  governanceProbedAt = now;
  return governanceExists;
}

/** Forget the cached probe (tests; also what a fresh bootstrap wants). */
export function resetGovernanceProbe(): void {
  governanceExists = null;
  governanceProbedAt = 0;
  lastGovernanceReconcileAt = 0;
}

/**
 * Recompile the constitution into grant rows for the primary vault. Returns null
 * when there is no governance to compile. Primary vault only, matching the
 * governance routes — the constitution is a property of one vault, and
 * `loadGovernance` reads that vault's notes.
 */
export async function runGovernanceReconcileOnce(): Promise<ReconcileResult | null> {
  if (!(await governanceConfigured())) return null;
  const state = await loadGovernance(vault, config.ownerEmail);
  const res = reconcileGovernanceGrants("primary", state);
  if (res.added > 0 || res.removed > 0) {
    console.log(`[worker] governance primary: +${res.added} grants, -${res.removed} grants (${res.kept} unchanged)`);
  }
  return res;
}

/** One full tick: every configured ingester for every vault. Per-vault, per-source
 *  errors are isolated so one bad credential can't stall the rest. */
async function tick(): Promise<void> {
  await runIngestersOnce();
  await tickRest();
}

/** The ingest half of a tick: every configured ingester for every vault, one after
 *  the other. Exported for tests; `tick` is its only production caller. */
export async function runIngestersOnce(): Promise<void> {
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
        // Reported as "email": with GMAIL_SYNC_ENABLED the server is that source's
        // owner (worker/health.ts stops inferring it from desktop notes).
        ...(config.gmailSyncEnabled ? ([["email", runGmailOnce]] as const) : []),
        // "calendar" when the server owns it (live), "calendar-shadow" while it only
        // diffs alongside the desktop (worker/calendar.ts). Off → not run at all.
        ...(calendarMode() !== "off" ? ([[calendarSourceName(), runCalendarOnce]] as const) : []),
        // Proton Bridge mail (WP1.2b): "proton" while shadowing OR live. Off → not run.
        ...(protonMode() !== "off" ? ([["proton", runProtonOnce]] as const) : []),
      ] as const) {
        // A Matrix pass still running (a slow vault, the hourly reconcile, a manual
        // sync) is not started again and records no outcome: if it never finishes,
        // the source goes `stale` instead of reading healthy.
        if (name === "matrix" && matrixPassRunning(entry.id)) continue;
        // …and the same for ClickUp / Fathom / Fireflies: an overrun pass is neither
        // started twice nor reported as a success by the tick that found it running.
        if (GUARDED_SOURCES.has(name) && ingestInFlight.has(flightKey(name, entry.id))) continue;
        try {
          await run(entry);
          noteIngestOutcome(entry.id, name, null);
        } catch (e) {
          noteIngestOutcome(entry.id, name, e as Error);
        }
      }
    }
  }
}

async function tickRest(): Promise<void> {
  // Vault mirrors are per-PAIR (source vault × dest vault), not per-vault-entry,
  // hence their own iteration. Each mirror throttles itself (last_run_at), so a
  // 60s tick costs one SELECT when nothing is due.
  await runVaultMirrorsOnce();

  // Governance→grants, on its own cadence. Isolated exactly like the index sweep:
  // a broken constitution must never stop the ingesters.
  if (config.governanceReconcileMs > 0 && Date.now() - lastGovernanceReconcileAt >= config.governanceReconcileMs) {
    lastGovernanceReconcileAt = Date.now();
    try {
      await runGovernanceReconcileOnce();
    } catch (e) {
      console.warn("[worker] governance primary failed:", (e as Error).message);
    }
  }

  // Note-history compaction, on the slowest cadence. Fire-and-forget: a run walks
  // every vault in short slices with pauses, and must never hold up ingest ticks.
  if (historyCompactEnabled() && !historyCompactInFlight && Date.now() - lastHistoryCompactAt >= config.historyCompactIntervalMs) {
    lastHistoryCompactAt = Date.now();
    historyCompactInFlight = true;
    void runHistoryCompactOnce()
      .catch((e) => console.warn("[worker] history-compact failed:", (e as Error).message))
      .finally(() => {
        historyCompactInFlight = false;
      });
  }

  // Trash auto-purge (pages): OFF unless TRASH_PURGE_ENABLED=true. Pages older than
  // TRASH_RETENTION_DAYS (30) in the Trash are deleted for good, every
  // TRASH_PURGE_INTERVAL_MS (6 h). Fire-and-forget, like compaction.
  if (trashPurgeEnabled() && !trashPurgeInFlight && Date.now() - lastTrashPurgeAt >= Number(process.env.TRASH_PURGE_INTERVAL_MS ?? 6 * 3_600_000)) {
    lastTrashPurgeAt = Date.now();
    trashPurgeInFlight = true;
    void runTrashPurgeOnce()
      .catch((e) => console.warn("[worker] trash-purge failed:", (e as Error).message))
      .finally(() => {
        trashPurgeInFlight = false;
      });
  }

  // Semantic index maintenance, on its own slower cadence — embeddings are not
  // latency-critical, and even the lean note list is a whole-vault fetch, so it
  // has no business running on the 60s ingest tick.
  if (indexSweepEnabled() && Date.now() - lastIndexSweepAt >= config.indexIntervalMs) {
    lastIndexSweepAt = Date.now();
    try {
      await runIndexOnce();
      recordSourceOutcome("primary", "index", null);
    } catch (e) {
      console.warn("[worker] index primary failed:", (e as Error).message);
      recordSourceOutcome("primary", "index", e as Error);
    }
  }

  // Background agent skills (WP1.1). Fire-and-forget with an in-flight guard: a
  // structured classify pass can run for many minutes on the local model and must
  // never hold up the ingest tick. SKILLS_ENABLED=false → nothing runs or writes.
  if (config.skillsEnabled && !skillsInFlight) {
    skillsInFlight = true;
    void runSkillsPass().finally(() => {
      skillsInFlight = false;
    });
  }

  // Notion DATABASE sync (Client parity B): auto-sync configs every
  // NOTION_DB_SYNC_INTERVAL_MS, only with NOTION_DB_SYNC_ENABLED=true. Fire-and-
  // forget with its own in-flight guard (it is rate-limited to 3 Notion req/s).
  if (notionDbBackgroundEnabled()) void runNotionDbPassOnce();

  // Staleness alerts last, so this tick's outcomes are already recorded. Never
  // throws; desktop freshness is cached (WORKER_DESKTOP_PROBE_MS).
  await runHealthCheckOnce();
}

let skillsInFlight = false;

/** Consecutive skill passes in which a model load was refused (jitLoadRefusal). */
let jitRefusedPasses = 0;
export function _resetJitRefusalsForTests(): void {
  jitRefusedPasses = 0;
}

/**
 * One skills pass with health reporting (source "skills", kind server). A pass
 * that could not list skills, or a run that FAILED, is an error; a finished run,
 * an accepted claude dispatch, or an idle pass (nothing due) is a success; a pass
 * whose only due skills were refused admission for memory pressure / a busy slot
 * records NOTHING — so that surfaces as "stale" past WORKER_STALE_SKILLS_MS instead
 * of a failure storm. The exception is a refused model LOAD (see below).
 */
export async function runSkillsPass(deps: SkillsDeps = defaultSkillsDeps()): Promise<PassResult | null> {
  try {
    const res = await runSkillsOnce(deps, (r) =>
      recordSourceOutcome("primary", "skills", r.status === "failed" ? new Error(r.error ?? "skill run failed") : null),
    );
    // A refused model LOAD is not "memory pressure, try later": on this host it can
    // persist for as long as the model is not resident. Each such pass is a failure
    // outcome, so the third in a row reads `failing` WITH the reason in /acl/workers
    // (one alert per episode) instead of `stale` six hours later. The next pass that
    // admits a run / finishes one / has nothing due records the recovery.
    const jit = res.refused.find((r) => r.jit);
    if (jit) {
      jitRefusedPasses++;
      recordSourceOutcome("primary", "skills", new Error(`local model load refused ${jitRefusedPasses} pass(es) in a row — ${jit.reason}`));
    } else {
      jitRefusedPasses = 0;
      if (res.finished.length === 0 && (res.refused.length === 0 || res.dispatched.length > 0)) {
        recordSourceOutcome("primary", "skills", null);
      }
    }
    return res;
  } catch (e) {
    console.warn("[worker] skills pass failed:", (e as Error).message);
    recordSourceOutcome("primary", "skills", e as Error);
    return null;
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

/** Is periodic history compaction turned on? (HISTORY_COMPACT_INTERVAL_MS=0 disables it.) */
export const historyCompactEnabled = (): boolean => config.historyCompactIntervalMs > 0;

/** Start the worker loop. No-op if already running, or if there is nothing any
 *  subsystem could ever do: no secrets (→ no ingesters), no mirrors, AND no index
 *  sweep. Index maintenance now counts toward "something to do" — it is the one
 *  subsystem that needs no credential, which is why the loop can be worth running
 *  on a server that has none. The interval is unref'd so it never blocks shutdown.
 *  POST /acl/mirrors re-invokes this, so creating the first mirror on a
 *  secrets-less server starts the loop without a restart. */
export function startWorker(intervalMs = 60_000): void {
  if (timer || (!secretsConfigured() && listVaultMirrors().length === 0 && !indexSweepEnabled() && !config.skillsEnabled)) return;
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
