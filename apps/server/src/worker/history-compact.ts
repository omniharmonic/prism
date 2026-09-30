/**
 * Nightly note-history compaction (vault ≥0.7.9).
 *
 * Vault 0.7.9 keeps note version history (on by default). Every update stores the
 * prior body as a full snapshot; the vault only delta-compresses those snapshots
 * at vault OPEN (a 250 ms / 50-note budget) or on `POST /api/history/compact`.
 * A long-running vault that ingests into big notes (Matrix threads appended every
 * minute) therefore accumulates full copies between restarts — the rehearsal
 * measured 50 appends to a 1.2 MB note at +46.5 MB, 3.6 MB after compaction.
 * This job calls the compact endpoint for every registered vault on a slow
 * cadence (HISTORY_COMPACT_INTERVAL_MS, default 24h; 0 disables it).
 *
 * Compaction runs SYNCHRONOUSLY inside the (single-threaded) vault process, so a
 * big budget would stall every other request for its duration. We therefore work
 * in short slices — `budget_ms` ≤1 s, `max_notes` 50 — pausing between them and
 * repeating until the vault reports `remaining_candidates: 0` (or a slice cap is
 * hit; the next night picks up the rest).
 *
 * The endpoint needs an UNSCOPED `vault:<name>:admin` token, so each run mints a
 * 1h ephemeral one via the operator CLI (or uses PARACHUTE_ADMIN_TOKEN) — no
 * standing admin credential is stored. Best-effort throughout: a vault without
 * the endpoint (0.6.x → 404/405) is skipped and logged once, a mint failure skips
 * that vault, and nothing here ever throws into the worker tick.
 */
import { getVaultRegistry } from "../db";
import type { VaultEntry } from "../config";
import { mintEphemeralAdminToken } from "../mcp-token";

export interface CompactSummary {
  vault: string;
  status: "compacted" | "unsupported" | "skipped" | "failed";
  detail?: string;
  /** The vault's own summary body when compaction ran. */
  result?: Record<string, unknown>;
}

export interface CompactDeps {
  fetchImpl?: typeof fetch;
  mintAdmin?: (vaultName: string) => Promise<string>;
  registry?: () => VaultEntry[];
  /** Per-SLICE bounds passed through to the endpoint (keep small: it blocks the vault). */
  budgetMs?: number;
  maxNotes?: number;
  /** Max slices per vault per run. */
  maxSlices?: number;
  /** Pause between slices, so queued requests drain. */
  pauseMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sum the numeric fields of per-slice summaries (duration, bytes, counts). */
function accumulate(total: Record<string, unknown>, slice: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(slice)) {
    if (typeof v === "number" && k !== "remaining_candidates") total[k] = ((total[k] as number) ?? 0) + v;
    else total[k] = v; // remaining_candidates / stopped_by: last slice wins
  }
}

// Vaults we've already reported as not supporting compaction (0.6.x) — logged
// once per process so the nightly run doesn't repeat it forever.
const reportedUnsupported = new Set<string>();

/** Test hook: forget which vaults were reported unsupported. */
export function resetCompactState(): void {
  reportedUnsupported.clear();
}

export async function runHistoryCompactOnce(deps: CompactDeps = {}): Promise<CompactSummary[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const mintAdmin = deps.mintAdmin ?? mintEphemeralAdminToken;
  const entries = (deps.registry ?? getVaultRegistry)();
  const body = JSON.stringify({ budget_ms: deps.budgetMs ?? 1_000, max_notes: deps.maxNotes ?? 50 });
  const maxSlices = deps.maxSlices ?? 200;
  const pauseMs = deps.pauseMs ?? 2_000;

  const out: CompactSummary[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.url}|${entry.vault}`;
    if (seen.has(key)) continue; // two registry ids can point at one vault
    seen.add(key);

    let token: string;
    try {
      token = await mintAdmin(entry.vault);
    } catch (e) {
      out.push({ vault: entry.vault, status: "skipped", detail: `no admin token: ${(e as Error).message}` });
      continue;
    }

    const total: Record<string, unknown> = {};
    let slices = 0;
    let summary: CompactSummary | null = null;
    try {
      while (slices < maxSlices) {
        if (slices > 0) await sleep(pauseMs);
        const r = await doFetch(`${entry.url}/vault/${entry.vault}/api/history/compact`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
        });
        if (r.status === 404 || r.status === 405) {
          if (!reportedUnsupported.has(key)) {
            reportedUnsupported.add(key);
            console.log(`[worker] history-compact ${entry.vault}: not supported by this vault (${r.status}) — skipping until upgraded`);
          }
          summary = { vault: entry.vault, status: "unsupported" };
          break;
        }
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          summary = { vault: entry.vault, status: "failed", detail: `${r.status} ${text.slice(0, 200)}` };
          break;
        }
        reportedUnsupported.delete(key);
        slices++;
        const slice = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        accumulate(total, slice);
        if (!(typeof slice.remaining_candidates === "number" && slice.remaining_candidates > 0)) break;
      }
    } catch (e) {
      summary = { vault: entry.vault, status: "failed", detail: (e as Error).message };
    }
    // A mid-run failure after some slices still reports what did get compacted.
    if (summary && (summary.status === "unsupported" || slices === 0)) {
      out.push(summary);
      continue;
    }
    out.push({
      vault: entry.vault,
      status: summary?.status === "failed" ? "failed" : "compacted",
      ...(summary?.detail ? { detail: summary.detail } : {}),
      result: { ...total, slices },
    });
  }

  for (const s of out) {
    if (s.status === "compacted") {
      console.log(`[worker] history-compact ${s.vault}: ${JSON.stringify(s.result)}`);
    }
    if (s.status === "failed" || s.status === "skipped") {
      console.warn(`[worker] history-compact ${s.vault}: ${s.status} — ${s.detail}`);
    }
  }
  return out;
}
