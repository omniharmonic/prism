/**
 * `prism update <tarball>` — the state machine (docs/host-bundle.md § Update and rollback).
 *
 *   verify the signed SHA256SUMS + SHA-256 → unpack beside the install → version gate → backup → place app/<new>
 *   → swap `current` → restart → wait for health (live + the new version answering)
 *   → success: record; failure: swap back → restart → wait for health
 *        → healthy: ROLLED_BACK (7); not healthy: ROLLBACK_FAILED (8)
 *
 * Every effect goes through `UpdateDeps`, so the tests drive each branch with fakes.
 * Nothing is changed before the backup is verified; a refused or failed step before the
 * swap leaves the install exactly as it was (the unpacked copy is removed).
 * DATA_VERSION moves only after the new version answered healthy, so a rollback never
 * counts as a "downgrade over newer data".
 *
 * After a rollback the failed version is NOT recorded as `previous`: `previous` stays the
 * healthy version that was previous before the update, and the failure is recorded as
 * `failed` (state.json `lastFailedUpdate`, shown by `prism status`). After a HEALTHY rollback
 * the failed tree is pruned — it holds no data (that lives in data/), the tarball it came from
 * still exists, and keeping it made `app/` hold three trees with the wrong one named as the way
 * back. After a rollback that is NOT healthy (exit 8) nothing is pruned: a person looks at it.
 * Prune never removes `current` or the healthy previous version.
 */
import { EXIT, type ExitCode } from "./exit-codes";
import { maxVersion, versionGate, type GateDecision } from "./semver";
import type { BuildInfo } from "./state";

export interface StagedBundle {
  dir: string;
  info: BuildInfo;
}

export interface UpdateDeps {
  log(msg: string): void;
  /**
   * Check the tarball against a SIGNED SHA256SUMS (minisign, the release key shipped in the
   * running bundle). `warning` = accepted without a signature check (`--allow-unsigned`).
   */
  verify(tarball: string): Promise<{ ok: boolean; sha256?: string; reason?: string; warning?: string; signedBy?: string }>;
  unpack(tarball: string): Promise<StagedBundle>;
  discard(staged: StagedBundle): void;
  installed(): { current: string | null; previous: string | null; dataVersion: string | null };
  backup(label: string): Promise<{ ok: boolean; dir?: string; reason?: string }>;
  /** Move the unpacked bundle to app/<version> (replacing a leftover of the same version). */
  place(staged: StagedBundle): void;
  /** Point `current` at app/<version>. */
  pointCurrent(version: string): void;
  /** Whether launchd runs the server (false: the person runs it; nothing is restarted). */
  managed(): boolean;
  restart(): Promise<void>;
  waitHealthy(version: string): Promise<{ ok: boolean; reason?: string }>;
  /** Record the outcome (state.json; DATA_VERSION when `healthyVersion` is set). */
  record(r: { current: string; previous: string | null; healthyVersion: string | null; action: string; result: string; from: string | null; to: string; failed?: { version: string; reason: string; treeKept: boolean } }): void;
  /** Remove old app/<version> trees, keeping these. */
  prune(keep: string[]): void;
}

export type UpdateStatus = "updated" | "unchanged" | "refused" | "verify_failed" | "backup_failed" | "rolled_back" | "rollback_failed" | "dry_run" | "swapped_unmanaged";

export interface UpdateResult {
  code: ExitCode;
  status: UpdateStatus;
  from: string | null;
  to: string | null;
  gate?: GateDecision;
  backup?: string;
  reason?: string;
  warnings?: string[];
  steps: string[];
}

export async function runUpdate(tarball: string, opts: { force?: boolean; dryRun?: boolean; skipBackup?: boolean }, deps: UpdateDeps): Promise<UpdateResult> {
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    deps.log(s);
  };
  const before = deps.installed();
  const from = before.current;

  const v = await deps.verify(tarball);
  if (!v.ok) return { code: EXIT.VERIFY_FAILED, status: "verify_failed", from, to: null, reason: v.reason, steps };
  const warnings = v.warning ? [v.warning] : undefined;
  if (v.warning) step(`WARNING: ${v.warning}`);
  step(`verified ${tarball}${v.sha256 ? ` (sha256 ${v.sha256.slice(0, 16)}…)` : ""}${v.signedBy ? `, SHA256SUMS signed by ${v.signedBy}` : ""}`);

  let staged: StagedBundle;
  try {
    staged = await deps.unpack(tarball);
  } catch (e) {
    return { code: EXIT.VERIFY_FAILED, status: "verify_failed", from, to: null, reason: `could not unpack: ${(e as Error).message}`, warnings, steps };
  }
  const to = staged.info.version;
  if (staged.info.platform !== "darwin" || staged.info.arch !== "arm64") {
    deps.discard(staged);
    return { code: EXIT.VERIFY_FAILED, status: "verify_failed", from, to, reason: `bundle is for ${staged.info.platform}-${staged.info.arch}`, warnings, steps };
  }
  const gate = versionGate({ installed: before.current, candidate: to, dataVersion: before.dataVersion, force: opts.force });
  step(`version gate: ${gate.action} — ${gate.reason}`);
  if (!gate.allowed) {
    deps.discard(staged);
    if (gate.action === "same") return { code: EXIT.OK, status: "unchanged", from, to, gate, reason: gate.reason, warnings, steps };
    return { code: EXIT.VERSION_REFUSED, status: "refused", from, to, gate, reason: gate.reason, warnings, steps };
  }
  if (opts.dryRun) {
    deps.discard(staged);
    step(`dry run: would back up, install ${to}, switch from ${from ?? "nothing"} and ${deps.managed() ? "restart + wait for health" : "leave the restart to you"}`);
    return { code: EXIT.OK, status: "dry_run", from, to, gate, warnings, steps };
  }

  let backupDir: string | undefined;
  if (!opts.skipBackup && from) {
    const b = await deps.backup(`pre-update-${to.replace(/[^0-9a-z.-]/gi, "")}`.replace(/\./g, "-"));
    if (!b.ok) {
      deps.discard(staged);
      return { code: EXIT.ERROR, status: "backup_failed", from, to, gate, reason: `backup failed, nothing changed: ${b.reason ?? "unknown"}`, warnings, steps };
    }
    backupDir = b.dir;
    step(`backed up to ${b.dir}`);
  }

  deps.place(staged);
  deps.pointCurrent(to);
  step(`current → ${to}`);

  if (!deps.managed()) {
    deps.record({ current: to, previous: from, healthyVersion: null, action: "update", result: "swapped (not managed by launchd)", from, to });
    step("not managed by launchd: restart the server yourself (`prism run server`)");
    return { code: EXIT.OK, status: "swapped_unmanaged", from, to, gate, backup: backupDir, warnings, steps };
  }

  let failure: string | undefined;
  try {
    await deps.restart();
    step("restarted");
    const h = await deps.waitHealthy(to);
    if (h.ok) {
      deps.record({ current: to, previous: from, healthyVersion: to, action: "update", result: "ok", from, to });
      deps.prune([to, ...(from ? [from] : [])]);
      step(`healthy on ${to}`);
      return { code: EXIT.OK, status: "updated", from, to, gate, backup: backupDir, warnings, steps };
    }
    failure = h.reason ?? "not healthy";
  } catch (e) {
    failure = (e as Error).message;
  }
  step(`${to} did not become healthy: ${failure}`);

  if (!from) {
    deps.record({ current: to, previous: null, healthyVersion: null, action: "update", result: `failed: ${failure}`, from, to });
    return { code: EXIT.ROLLBACK_FAILED, status: "rollback_failed", from, to, gate, backup: backupDir, reason: `${failure}; there is no earlier version to roll back to`, warnings, steps };
  }
  deps.pointCurrent(from);
  step(`rolled back: current → ${from}`);
  // The way back stays the healthy version that was previous before this update.
  const previous = before.previous && before.previous !== from ? before.previous : null;
  try {
    await deps.restart();
    const h = await deps.waitHealthy(from);
    if (h.ok) {
      const keep = [from, ...(previous ? [previous] : [])];
      deps.record({ current: from, previous, healthyVersion: null, action: "update", result: `rolled back: ${failure}`, from, to, failed: { version: to, reason: failure, treeKept: keep.includes(to) } });
      deps.prune(keep);
      if (!keep.includes(to)) step(`removed the failed ${to} tree`);
      return { code: EXIT.ROLLED_BACK, status: "rolled_back", from, to, gate, backup: backupDir, reason: failure, warnings, steps };
    }
    failure = `${failure}; after the rollback: ${h.reason ?? "not healthy"}`;
  } catch (e) {
    failure = `${failure}; after the rollback: ${(e as Error).message}`;
  }
  deps.record({ current: from, previous, healthyVersion: null, action: "update", result: `rollback failed: ${failure}`, from, to, failed: { version: to, reason: failure, treeKept: true } });
  return { code: EXIT.ROLLBACK_FAILED, status: "rollback_failed", from, to, gate, backup: backupDir, reason: failure, warnings, steps };
}

/** The data version after a healthy run of `version`. */
export function nextDataVersion(prior: string | null, version: string): string {
  return maxVersion(prior, version) ?? version;
}
