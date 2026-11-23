/**
 * Where a host install lives, and the permission rules for it (docs/host-bundle.md § Layout).
 *
 * One root (decision D-C): everything Prism writes on the host is under the prefix, default
 * `~/Library/Application Support/Prism/Host`. Deleting that folder (after `prism uninstall`)
 * starts over. The launchd plists are the only files outside it (`~/Library/LaunchAgents`).
 */
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export interface Layout {
  prefix: string;
  /** Marker that says "this folder is a Prism host install" (uninstall refuses a folder without it). */
  marker: string;
  /** Versioned app trees: app/<version>/ … and the `current` symlink. */
  appRoot: string;
  current: string;
  bin: string;
  binPrism: string;
  /** Host configuration: the server's `.env` (0600) — also the server's working directory. */
  config: string;
  envFile: string;
  data: string;
  db: string;
  /** Highest version that has run healthy against `data/` (the version gate reads it). */
  dataVersionFile: string;
  agentCwd: string;
  logs: string;
  backups: string;
  /** PARACHUTE_HOME when Prism owns Parachute: embedded mode, or stock mode for a person with no Parachute data yet. */
  parachuteHome: string;
  state: string;
  lock: string;
  /** `prism setup`'s run-wide lock (separate from `lock`, which each changing command takes). */
  setupLock: string;
}

export function versionDir(layout: Layout, version: string): string {
  return join(layout.appRoot, version);
}

export function layoutFor(prefix: string): Layout {
  const p = resolve(prefix);
  const config = join(p, "config");
  const data = join(p, "data");
  return {
    prefix: p,
    marker: join(p, ".prism-host"),
    appRoot: join(p, "app"),
    current: join(p, "app", "current"),
    bin: join(p, "bin"),
    binPrism: join(p, "bin", "prism"),
    config,
    envFile: join(config, ".env"),
    data,
    db: join(data, "prism-server.db"),
    dataVersionFile: join(data, "DATA_VERSION"),
    agentCwd: join(data, "agent-cwd"),
    logs: join(p, "logs"),
    backups: join(p, "backups"),
    parachuteHome: join(p, "parachute"),
    state: join(p, "state.json"),
    lock: join(p, ".lock"),
    setupLock: join(p, ".setup.lock"),
  };
}

/** The default prefix (decision D-C). */
export function defaultPrefix(home: string): string {
  return join(home, "Library", "Application Support", "Prism", "Host");
}

export function launchAgentsDir(home: string): string {
  return join(home, "Library", "LaunchAgents");
}

/** Directories the install creates, all 0700 (several hold secrets or the database). */
export function privateDirs(layout: Layout): string[] {
  return [layout.prefix, layout.appRoot, layout.bin, layout.config, layout.data, layout.agentCwd, layout.logs, layout.backups, layout.parachuteHome];
}

export const DIR_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;
/** launchd refuses a plist that others may write; it holds no secret, so 0644. */
export const PLIST_MODE = 0o644;

const SYSTEM_ROOTS = ["/System", "/usr", "/bin", "/sbin", "/etc", "/var", "/private", "/Library", "/Applications", "/opt", "/cores", "/dev", "/Volumes"];

/**
 * Why `prefix` may not be used, or null when it may. The prefix must be an absolute,
 * normalised path of its own: not `/`, not the home folder itself, not a system folder,
 * not inside Parachute's own `~/.parachute`.
 */
export function prefixProblem(prefix: string, home: string): string | null {
  if (!prefix) return "the prefix is empty";
  if (/[\0\r\n]/.test(prefix)) return "the prefix contains a control character";
  if (!isAbsolute(prefix)) return "the prefix must be an absolute path";
  if (prefix.split(/[/\\]/).includes("..")) return "the prefix may not contain '..'";
  const p = normalize(prefix).replace(/\/+$/, "") || "/";
  if (p === "/") return "the prefix may not be /";
  const h = normalize(home).replace(/\/+$/, "");
  if (p === h) return "the prefix may not be the home folder itself";
  if (h && (p === join(h, "Library") || p === join(h, "Library", "Application Support"))) return "the prefix must be a folder of its own";
  const parachute = join(h, ".parachute");
  if (p === parachute || p.startsWith(parachute + sep)) return "the prefix may not be inside ~/.parachute";
  // Temporary folders (tests, smoke runs) are fine.
  const tmpOk = ["/private/tmp/", "/private/var/folders/", "/var/folders/", "/tmp/"].some((t) => p.startsWith(t));
  if (!tmpOk && !(h && p.startsWith(h + sep))) {
    for (const r of SYSTEM_ROOTS) if (p === r || p.startsWith(r + sep)) return `the prefix may not be under ${r}`;
  }
  return null;
}
