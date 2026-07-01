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
import { getVaultRegistry, getWorkerCursor, setWorkerCursor } from "../db";
import { getSecret, secretsConfigured } from "../secrets";
import { config, type VaultEntry } from "../config";
import { vaultClient } from "../parachute";
import { MatrixClient, ingestMatrix, type IngestVault, type MatrixCreds } from "./matrix";
import { FathomClient, ingestFathom } from "./fathom";

let timer: ReturnType<typeof setInterval> | null = null;

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

/** One full tick: every configured ingester for every vault. Per-vault, per-source
 *  errors are isolated so one bad credential can't stall the rest. */
async function tick(): Promise<void> {
  for (const entry of getVaultRegistry()) {
    for (const [name, run] of [
      ["matrix", runMatrixOnce],
      ["fathom", runFathomOnce],
    ] as const) {
      try {
        await run(entry);
      } catch (e) {
        console.warn(`[worker] ${name} ${entry.id} failed:`, (e as Error).message);
      }
    }
  }
}

/** Start the worker loop. No-op if secrets aren't configured (nothing to read)
 *  or already running. The interval is unref'd so it never blocks shutdown. */
export function startWorker(intervalMs = 60_000): void {
  if (timer || !secretsConfigured()) return;
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
