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
 *
 * Three additions (2026-10-08, qa/schema-stability-2026-10-08.md):
 *  - LINT_TAGS is the contract's `lintTags` (every schema'd tag of the personal vault,
 *    not a hand-kept dozen); `test/schema-drift.test.ts` fails when a schema'd tag is
 *    missing from it.
 *  - FRESH drift: `fresh` = sampled notes that are mis-shaped by the guard's own rules
 *    AND were written since the previous run. After the clean-up the legacy rate is
 *    ~0, so this is "a writer is producing bad shapes NOW" — visible the next day even
 *    when it is 3 notes in 100 (the rate threshold would need > 20). It makes the
 *    source `failing` only when VAULT_LINT_FRESH_MAX > 0 (default 0 = report only).
 *    `writers` buckets the mis-shaped notes by their writer (`writerBucket`).
 *  - DECLARED schema: `declared` counts values that break the tag's seeded schema
 *    (enum / type / empty string, `declaredViolations`). Reported; it joins the rate
 *    only with VAULT_LINT_DECLARED=enforce.
 */
import { config } from "../config";
import { getWorkerCursor, setWorkerCursor } from "../db";
import { vaultClient } from "../parachute";
import { declaredViolations, lintKeys, shapeViolations, writerBucket } from "../vault-shapes";
import { VAULT_SHAPES } from "@prism/core/vault-shapes";

/** Every schema'd tag of the personal vault (the contract's `lintTags`). */
export const LINT_TAGS: readonly string[] = VAULT_SHAPES.lintTags;

/**
 * Tags whose rate may make the source `failing`. The contract's `lintAlertTags` (the
 * twelve tags the lint has always judged) unless VAULT_LINT_ALERT_TAGS says otherwise
 * ("all", or a comma list). Every other lint tag is sampled and REPORTED only: its
 * baseline on the live vault is not known yet, and a tag must not start alerting the
 * day it is first looked at.
 */
export function alertTags(setting: string = config.vaultLintAlertTags): ReadonlySet<string> {
  const s = setting.trim().toLowerCase();
  if (s === "all") return new Set(LINT_TAGS);
  if (s === "" || s === "default") return new Set(VAULT_SHAPES.lintAlertTags);
  return new Set(s.split(",").map((t) => t.trim()).filter((t) => LINT_TAGS.includes(t)));
}

/** At most this many writer buckets are kept per tag (the rest fold into "other"). */
const MAX_WRITER_BUCKETS = 8;

const CURSOR = "vault-lint";

export interface TagLint {
  sampled: number;
  warned: number;
  rate: number;
  /** field name → notes in the sample with that field mis-shaped. */
  fields: Record<string, number>;
  /** Mis-shaped (guard rules) notes written since the previous run: new drift. */
  fresh?: number;
  /** writer bucket → mis-shaped notes in the sample (see `writerBucket`). */
  writers?: Record<string, number>;
  /** `<field>:enum|type|empty` → notes breaking the tag's declared schema. */
  declared?: Record<string, number>;
  /** Notes with at least one declared-schema violation. */
  declaredWarned?: number;
}

export interface VaultLintOutcome {
  at: string;
  status: "ok" | "failing" | "error";
  error?: string;
  tags: Record<string, TagLint>;
  /** Alerting tags whose rate is above the threshold this run. */
  over: string[];
  /** Report-only tags above the threshold (new coverage: shown, never alerted on). */
  overReportOnly?: string[];
  /** Tags whose rate went up by ≥ 5 points since the previous run. */
  rose: string[];
  /** Tags with at least VAULT_LINT_FRESH_MAX freshly written mis-shaped notes (empty when the threshold is 0). */
  freshOver?: string[];
  /** When the last run that listed every tag finished (the "fresh since" mark). */
  lastGoodAt?: string;
}

interface LintRow {
  metadata?: Record<string, unknown> | null;
  updatedAt?: string | null;
  validation_status?: unknown;
  validationStatus?: unknown;
}

export interface VaultLintDeps {
  list?: (tag: string, keys: string[], limit: number) => Promise<LintRow[]>;
  now?: () => number;
  sample?: number;
  maxRate?: number;
  minSample?: number;
  /** ≥ this many fresh mis-shaped notes in a tag = failing; 0 = report only. */
  freshMax?: number;
  /** Declared-schema violations join the rate when true (VAULT_LINT_DECLARED=enforce). */
  declaredEnforce?: boolean;
  /** Tags whose rate may fail the run (default: `alertTags()`). */
  alertTags?: ReadonlySet<string>;
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
    // `schema_conflict` = the note carries two tags whose definitions of one field differ (a
    // spec that is also a report). It describes the tag pair, not a value this note holds, and
    // no rewrite of the note can clear it — so it is not shape drift.
    const counts = (x: unknown) => !(x && typeof x === "object" && (x as { reason?: unknown }).reason === "schema_conflict");
    for (const k of ["warnings", "errors", "issues"]) if (Array.isArray(o[k]) && (o[k] as unknown[]).some(counts)) return true;
    if (o.ok === false || o.valid === false) return true;
  }
  return false;
}

export interface LintRowsOpts {
  /** Epoch ms of the previous run: a mis-shaped note updated after it is `fresh`. */
  sinceMs?: number | null;
  declaredEnforce?: boolean;
}

export function lintRows(rows: readonly LintRow[], tag: string, opts: LintRowsOpts = {}): TagLint {
  const fields: Record<string, number> = {};
  const declared: Record<string, number> = {};
  const writerCounts: Record<string, number> = {};
  let warned = 0;
  let fresh = 0;
  let declaredWarned = 0;
  for (const row of rows) {
    const md = row.metadata ?? {};
    const bad = shapeViolations(md, tag);
    for (const f of bad) fields[f] = (fields[f] ?? 0) + 1;
    const decl = declaredViolations(md, tag, bad);
    for (const f of decl) declared[f] = (declared[f] ?? 0) + 1;
    if (decl.length) declaredWarned++;
    if (bad.length || vaultWarned(row) || (opts.declaredEnforce && decl.length)) warned++;
    if (bad.length) {
      const w = writerBucket(md);
      writerCounts[w] = (writerCounts[w] ?? 0) + 1;
      const at = row.updatedAt ? Date.parse(row.updatedAt) : NaN;
      if (opts.sinceMs != null && Number.isFinite(at) && at > opts.sinceMs) fresh++;
    }
  }
  // Keep the outcome small: the biggest buckets by count, the rest as "other".
  const ranked = Object.entries(writerCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const writers: Record<string, number> = Object.fromEntries(ranked.slice(0, MAX_WRITER_BUCKETS));
  const rest = ranked.slice(MAX_WRITER_BUCKETS).reduce((n, [, c]) => n + c, 0);
  if (rest) writers.other = (writers.other ?? 0) + rest;
  const sampled = rows.length;
  return { sampled, warned, rate: sampled ? Math.round((warned / sampled) * 1000) / 1000 : 0, fields, fresh, writers, declared, declaredWarned };
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
  const freshMax = deps.freshMax ?? config.vaultLintFreshMax;
  const declaredEnforce = deps.declaredEnforce ?? config.vaultLintDeclaredEnforce;
  const getCursor = deps.getCursor ?? getWorkerCursor;
  const setCursor = deps.setCursor ?? setWorkerCursor;
  const list =
    deps.list ??
    ((tag: string, keys: string[], limit: number) =>
      vaultClient(vaultId, { timeoutMs: 30_000 }).listNotes({ tags: [tag], limit, orderBy: "updated_at", includeMetadata: keys }) as Promise<LintRow[]>);

  const previous = lastVaultLintOutcome(vaultId, getCursor);
  // "Fresh" = written since the last COMPLETE look at the vault (`lastGoodAt` survives
  // errored runs, so a vault outage cannot hide a day of drift); the first run has none.
  const prevGood = previous?.lastGoodAt ?? (previous && previous.status !== "error" ? previous.at : undefined);
  const prevAt = prevGood ? Date.parse(prevGood) : NaN;
  const sinceMs = Number.isFinite(prevAt) ? prevAt : null;
  const tags: Record<string, TagLint> = {};
  let error: string | undefined;
  for (const tag of LINT_TAGS) {
    try {
      // The listing may hold notes with the tag nested under another tag (inheritance):
      // judge each against `tag`'s rules only, which is what its schema declares.
      tags[tag] = lintRows(await list(tag, lintKeys(tag), sample), tag, { sinceMs, declaredEnforce });
    } catch (e) {
      error = `listing ${tag}: ${(e as Error).message}`.slice(0, 200);
      break; // a vault that fails one listing is not asked for the rest
    }
  }
  const alerting = deps.alertTags ?? alertTags();
  const over = Object.entries(tags)
    .filter(([k, t]) => alerting.has(k) && t.sampled >= minSample && t.rate > maxRate)
    .map(([k]) => k);
  const rose = Object.entries(tags)
    .filter(([k, t]) => {
      const before = previous?.tags?.[k];
      return before && t.sampled >= minSample && t.rate - before.rate >= 0.05;
    })
    .map(([k]) => k);
  const freshOver = freshMax > 0 ? Object.entries(tags).filter(([, t]) => (t.fresh ?? 0) >= freshMax).map(([k]) => k) : [];
  const outcome: VaultLintOutcome = {
    at: new Date(now()).toISOString(),
    ...(error ? (prevGood ? { lastGoodAt: prevGood } : {}) : { lastGoodAt: new Date(now()).toISOString() }),
    status: error ? "error" : over.length || freshOver.length ? "failing" : "ok",
    ...(error ? { error } : {}),
    tags,
    over,
    overReportOnly: Object.entries(tags).filter(([k, t]) => !alerting.has(k) && t.sampled >= minSample && t.rate > maxRate).map(([k]) => k),
    rose,
    freshOver,
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
