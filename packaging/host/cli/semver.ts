/**
 * Versions and the version gate (docs/host-bundle.md § Update rules).
 *
 * The server's migrations are additive and run at boot with no down-migrations, so an
 * older build over data a newer build has used is not a supported state. The gate refuses
 * it unless the person says `--force`.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  raw: string;
}

const RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

export function parseVersion(v: string): SemVer | null {
  const m = RE.exec(v.trim());
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ? m[4].split(".") : [], raw: v.trim() };
}

/** -1 / 0 / 1, semver precedence (a pre-release sorts before its release). Throws on a bad version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export function maxVersion(...vs: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of vs) if (v && parseVersion(v) && (!best || compareVersions(v, best) > 0)) best = v;
  return best;
}

export type GateAction = "fresh" | "same" | "upgrade" | "downgrade";

export interface GateDecision {
  action: GateAction;
  allowed: boolean;
  reason: string;
}

/**
 * Decide whether `candidate` may become the current version.
 *  - `installed` = the version `current` points at (null on a fresh install);
 *  - `dataVersion` = the highest version that has run healthy against the data.
 * Anything older than either is a downgrade, allowed only with `force`.
 * The same version is a no-op unless `force` (then a reinstall).
 */
export function versionGate(input: { installed: string | null; candidate: string; dataVersion: string | null; force?: boolean }): GateDecision {
  const { installed, candidate, dataVersion, force = false } = input;
  if (!parseVersion(candidate)) return { action: "downgrade", allowed: false, reason: `the bundle's version "${candidate}" is not a version` };
  const newest = maxVersion(installed, dataVersion);
  if (!newest) return { action: "fresh", allowed: true, reason: "no earlier version" };
  const c = compareVersions(candidate, newest);
  if (c > 0) return { action: "upgrade", allowed: true, reason: `${newest} → ${candidate}` };
  if (c === 0 && installed && compareVersions(candidate, installed) === 0) {
    return { action: "same", allowed: force, reason: force ? `reinstalling ${candidate}` : `${candidate} is already installed` };
  }
  // Older than what is installed or than what the data has seen.
  const over = dataVersion && compareVersions(candidate, dataVersion) < 0 ? `data last used by ${dataVersion}` : `installed ${newest}`;
  if (c === 0) {
    // Equal to the data version but not to the installed one (installed was rolled back): fine.
    return { action: "upgrade", allowed: true, reason: `${installed ?? "nothing"} → ${candidate}` };
  }
  return {
    action: "downgrade",
    allowed: force,
    reason: force ? `downgrade to ${candidate} over ${over} (forced)` : `${candidate} is older than ${over}; refusing a downgrade over newer data (use --force)`,
  };
}
