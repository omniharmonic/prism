/**
 * `state.json` (the install's own bookkeeping) and `build-info.json` (what a bundle is).
 * Neither holds a secret.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths";
import { writeFileAtomic, readTextOrNull } from "./fsutil";
import { parseVersion } from "./semver";

/**
 * Who runs Parachute: `external` = something else (Parachute's own launchd unit, a person) —
 * Prism only talks to it; `stock` = Prism's own hub agent runs the agent-installed stock
 * Parachute (the fallback, cli/parachute-stock.ts); `embedded` = the bundled payload; `none`.
 */
export type ParachuteMode = "external" | "stock" | "embedded" | "none";

export interface HistoryEntry {
  at: string;
  action: string;
  from: string | null;
  to: string | null;
  result: string;
}

export interface HostState {
  schema: 1;
  current: string | null;
  previous: string | null;
  /** Versions present under app/. */
  installed: string[];
  /** Whether Prism's launchd agents manage the server (false = `--no-launchd`). */
  launchd: boolean;
  parachute: ParachuteMode;
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
  /**
   * The last update that did not become healthy (and was rolled back), until a later update
   * succeeds. Never also `previous`: `prism status` reports it here, as failed. `treeKept` =
   * its app/<version> tree is still on disk (a rollback that was not healthy keeps it for a
   * person to look at; a healthy rollback removes it).
   */
  lastFailedUpdate?: { version: string; at: string; reason: string; treeKept: boolean };
}

export function emptyState(now: string, launchd: boolean, parachute: ParachuteMode): HostState {
  return { schema: 1, current: null, previous: null, installed: [], launchd, parachute, createdAt: now, updatedAt: now, history: [] };
}

export function readState(layout: Layout): HostState | null {
  const t = readTextOrNull(layout.state);
  if (t === null) return null;
  const s = JSON.parse(t) as HostState;
  if (s.schema !== 1) throw new Error(`state.json: unknown schema ${String((s as { schema?: unknown }).schema)}`);
  return s;
}

export function writeState(layout: Layout, s: HostState): void {
  s.history = s.history.slice(-30);
  writeFileAtomic(layout.state, JSON.stringify(s, null, 2) + "\n", 0o600);
}

export function readDataVersion(layout: Layout): string | null {
  const t = readTextOrNull(layout.dataVersionFile)?.trim();
  return t && parseVersion(t) ? t : null;
}

export interface BuildInfo {
  name: "prism-host";
  version: string;
  platform: "darwin";
  arch: "arm64";
  commit: string;
  builtAt: string;
  node: { version: string; sha256: string };
  parachute: { bundled: boolean; version: string | null };
  /** Bundle-relative paths the CLI and supervisor rely on. */
  paths: { node: string; cli: string; server: string; tsxLoader: string; web: string; webNative: string; launchd: string };
}

export function readBuildInfo(bundleRoot: string): BuildInfo {
  const info = JSON.parse(readFileSync(join(bundleRoot, "build-info.json"), "utf8")) as BuildInfo;
  if (info.name !== "prism-host" || !parseVersion(info.version)) throw new Error(`${bundleRoot}: not a prism-host bundle`);
  return info;
}
