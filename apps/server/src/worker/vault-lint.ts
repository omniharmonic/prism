/**
 * Vault lint — a cheap, READ-ONLY daily check that the field-shape drift found in
 * `qa/vault-health.md` (2026-10-08) is not coming back.
 *
 * Per tag in LINT_TAGS: ONE lean listing (`limit` = VAULT_LINT_SAMPLE newest by
 * `updated_at`, no bodies, only the metadata keys the check reads) → each note is
 * checked with `shapeViolations` (vault-shapes.ts — the same rules the write-side
 * guard enforces) and, when the vault sends one, its own `validation_status`. The
 * result is a warning RATE per tag (warned / sampled) plus per-field counts.
 *
 * Reported as the `vault-lint` health source (GET /acl/workers): `failing` (→ the
 * usual once-per-episode alert) when any tag with ≥ VAULT_LINT_MIN_SAMPLE sampled
 * notes has a rate above VAULT_LINT_MAX_RATE; `detail` names the tags and whether
 * a rate ROSE since the previous run. The last result persists in the worker cursor
 * table so a restart keeps the comparison. Counts and field names only — never a
 * value, path or id. Off unless VAULT_LINT_ENABLED=true; never throws into the tick.
 */
import { config } from "../config";
import { getWorkerCursor, setWorkerCursor } from "../db";
import { vaultClient } from "../parachute";
import { lintKeys, shapeViolations } from "../vault-shapes";

export const LINT_TAGS = [
  "person", "organization", "project", "concept", "meeting", "transcript", "task",
  "message-thread", "briefing", "spec", "report", "writing",
] as const;

const CURSOR = "vault-lint";

export interface TagLint {
  sampled: number;
  warned: number;
  rate: number;
  /** field name → notes in the sample with that field mis-shaped. */
  fields: Record<string, number>;
}

export interface VaultLintOutcome {
  at: string;
  status: "ok" | "failing" | "error";
  error?: string;
  tags: Record<string, TagLint>;
  /** Tags whose rate is above the threshold this run. */
  over: string[];
  /** Tags whose rate went up by ≥ 5 points since the previous run. */
  rose: string[];
}

interface LintRow {
  metadata?: Record<string, unknown> | null;
  validation_status?: unknown;
  validationStatus?: unknown;
}

export interface VaultLintDeps {
  list?: (tag: string, keys: string[], limit: number) => Promise<LintRow[]>;
  now?: () => number;
  sample?: number;
  maxRate?: number;
  minSample?: number;
  getCursor?: (vaultId: string, name: string) => string | null;
  setCursor?: (vaultId: string, name: string, v: string) => void;
}

/** The vault's own verdict, when a row carries one: any warning/error counts. */
function vaultWarned(row: LintRow): boolean {
  const v = row.validation_status ?? row.validationStatus;
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v !== "" && v !== "ok" && v !== "valid";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["warnings", "errors", "issues"]) if (Array.isArray(o[k]) && (o[k] as unknown[]).length) return true;
    if (o.ok === false || o.valid === false) return true;
  }
  return false;
}

export function lintRows(rows: readonly LintRow[], tag: string): TagLint {
  const fields: Record<string, number> = {};
  let warned = 0;
  for (const row of rows) {
    const bad = shapeViolations(row.metadata ?? {}, tag);
    for (const f of bad) fields[f] = (fields[f] ?? 0) + 1;
    if (bad.length || vaultWarned(row)) warned++;
  }
  const sampled = rows.length;
  return { sampled, warned, rate: sampled ? Math.round((warned / sampled) * 1000) / 1000 : 0, fields };
}

export function lastVaultLintOutcome(vaultId = "primary", getCursor: (v: string, n: string) => string | null = getWorkerCursor): VaultLintOutcome | null {
  try {
    const raw = getCursor(vaultId, CURSOR);
    return raw ? (JSON.parse(raw) as VaultLintOutcome) : null;
  } catch {
    return null;
  }
}

export async function runVaultLintOnce(vaultId = "primary", deps: VaultLintDeps = {}): Promise<VaultLintOutcome> {
  const now = deps.now ?? Date.now;
  const sample = deps.sample ?? config.vaultLintSample;
  const maxRate = deps.maxRate ?? config.vaultLintMaxRate;
  const minSample = deps.minSample ?? config.vaultLintMinSample;
  const getCursor = deps.getCursor ?? getWorkerCursor;
  const setCursor = deps.setCursor ?? setWorkerCursor;
  const list =
    deps.list ??
    ((tag: string, keys: string[], limit: number) =>
      vaultClient(vaultId, { timeoutMs: 30_000 }).listNotes({ tags: [tag], limit, orderBy: "updated_at", includeMetadata: keys }) as Promise<LintRow[]>);

  const previous = lastVaultLintOutcome(vaultId, getCursor);
  const tags: Record<string, TagLint> = {};
  let error: string | undefined;
  for (const tag of LINT_TAGS) {
    try {
      // The listing may hold notes with the tag nested under another tag (inheritance):
      // judge each against `tag`'s rules only, which is what its schema declares.
      tags[tag] = lintRows(await list(tag, lintKeys(tag), sample), tag);
    } catch (e) {
      error = `listing ${tag}: ${(e as Error).message}`.slice(0, 200);
      break; // a vault that fails one listing is not asked eleven more times
    }
  }
  const over = Object.entries(tags)
    .filter(([, t]) => t.sampled >= minSample && t.rate > maxRate)
    .map(([k]) => k);
  const rose = Object.entries(tags)
    .filter(([k, t]) => {
      const before = previous?.tags?.[k];
      return before && t.sampled >= minSample && t.rate - before.rate >= 0.05;
    })
    .map(([k]) => k);
  const outcome: VaultLintOutcome = {
    at: new Date(now()).toISOString(),
    status: error ? "error" : over.length ? "failing" : "ok",
    ...(error ? { error } : {}),
    tags,
    over,
    rose,
  };
  try {
    setCursor(vaultId, CURSOR, JSON.stringify(outcome));
  } catch {
    /* health falls back to "never ran" */
  }
  return outcome;
}

/** Due when enabled and the last persisted run is older than the interval (restart-safe). */
export function vaultLintDue(vaultId = "primary", nowMs = Date.now(), getCursor: (v: string, n: string) => string | null = getWorkerCursor): boolean {
  if (!config.vaultLintEnabled || config.vaultLintIntervalMs <= 0) return false;
  const last = lastVaultLintOutcome(vaultId, getCursor);
  const at = last ? Date.parse(last.at) : NaN;
  return !Number.isFinite(at) || nowMs - at >= config.vaultLintIntervalMs;
}
