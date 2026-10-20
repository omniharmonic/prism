/**
 * Stock Parachute run by Prism — the launch plan's fallback (§3.4) until embedded mode ships.
 * docs/host-bundle.md § "Stock Parachute (the fallback)".
 *
 * What stock Parachute 0.7.x does on its own, measured from the installed package:
 *  - `parachute init` ALWAYS installs Parachute's own launchd unit (`computer.parachute.hub`,
 *    `installAndStartHubUnit`) and has no flag to skip it; `--no-autostart` exists only on
 *    `parachute-vault init` (it skips the vault's standalone unit). So Prism never runs
 *    `parachute init`.
 *  - `parachute serve` is the foreground hub + supervisor. It spawns every module listed in
 *    `<PARACHUTE_HOME>/services.json` — the vault included, once `parachute-vault create` has
 *    registered it. A second vault process (a launchd unit of ours) would race the hub's child
 *    for :1940 (Parachute's own issue #580). So in stock mode Prism runs ONE agent, the hub;
 *    the vault is the hub's child, as Parachute designs it. `prism run vault` says so and exits.
 *  - `parachute serve` binds every interface unless `PARACHUTE_BIND_HOST=127.0.0.1` (its own
 *    unit sets it; we do too). The vault binds loopback by default (`VAULT_BIND` unset).
 *  - Files are created 0644 / dirs 0755; the plist's `Umask 077` covers what the hub creates
 *    while Prism runs it, and {@link tightenParachuteModes} fixes what already exists.
 *  - `auth mint-token` takes the issuer from `hub/run/hub.port` or the default 1939, so Prism's
 *    stock mode uses the default ports only (1939 hub, 1940 vault), where that bug does not bite.
 *
 * Nothing here touches a Parachute that Parachute's own launchd unit runs: that one is reused.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT } from "./exit-codes";
import type { Launchd } from "./launchd";
import { agentPath } from "./plist";
import type { Layout } from "./paths";
import { RotatingLog, STOP_GRACE_MS } from "./supervisor";
import { ensureDir } from "./fsutil";
import { DIR_MODE } from "./paths";

export const STOCK_HUB_PORT = 1939;
export const STOCK_VAULT_PORT = 1940;
export const STOCK_HUB_ORIGIN = `http://127.0.0.1:${STOCK_HUB_PORT}`;
export const STOCK_VAULT_URL = `http://127.0.0.1:${STOCK_VAULT_PORT}`;

/** Parachute's own launchd labels (`computer.parachute.<short>`). `PRISM_PARACHUTE_UNIT_PREFIX` moves them (tests, smoke). */
export function parachuteUnitLabels(env: NodeJS.ProcessEnv): { hub: string; vault: string } {
  const p = env.PRISM_PARACHUTE_UNIT_PREFIX?.trim() || "computer.parachute";
  return { hub: `${p}.hub`, vault: `${p}.vault` };
}

export interface ForeignUnit {
  label: string;
  /** The plist in ~/Library/LaunchAgents, when there is one. */
  plist: string | null;
  loaded: boolean;
  pid: number | null;
}

/**
 * Parachute's OWN launchd units on this Mac: a plist in ~/Library/LaunchAgents or a loaded job
 * (read-only: `launchctl print`, which runs under --dry-run too). A plist that is present but not
 * loaded counts — it starts at the next login, and two hubs would fight over :1939.
 */
export async function detectParachuteUnits(ld: Launchd, launchAgents: string, env: NodeJS.ProcessEnv): Promise<ForeignUnit[]> {
  const out: ForeignUnit[] = [];
  for (const label of Object.values(parachuteUnitLabels(env))) {
    const plist = join(launchAgents, `${label}.plist`);
    const info = await ld.info(label);
    const has = existsSync(plist);
    if (has || info.loaded) out.push({ label, plist: has ? plist : null, loaded: info.loaded, pid: info.pid });
  }
  return out;
}

/** Files that say "Parachute has data here" (never moved, never deleted by Prism). */
export const DATA_MARKERS = ["hub.db", "operator.token", "services.json", "vault"] as const;

export function hasParachuteData(home: string): boolean {
  return DATA_MARKERS.some((m) => existsSync(join(home, m)));
}

export type HomeReason = "configured" | "existing" | "prism-owned";

/**
 * Which PARACHUTE_HOME stock mode uses (decision: never move a person's data).
 *  1. one already set (`.env` PARACHUTE_HOME, or `--parachute-home`) → that;
 *  2. `~/.parachute` holds Parachute data → `~/.parachute`, where it is;
 *  3. otherwise → `<prefix>/parachute`, inside the Prism install (one root, backed up with it).
 */
export function chooseParachuteHome(o: { configured?: string; userHome: string; layout: Layout }): { home: string; reason: HomeReason } {
  if (o.configured) return { home: o.configured, reason: "configured" };
  const dot = join(o.userHome, ".parachute");
  if (hasParachuteData(dot)) return { home: dot, reason: "existing" };
  return { home: o.layout.parachuteHome, reason: "prism-owned" };
}

/** `parachute-vault create` has run for this vault. */
export function vaultExists(home: string, vault: string): boolean {
  const d = join(home, "vault", "data", vault);
  return existsSync(join(d, "vault.yaml")) || existsSync(join(d, "vault.db"));
}

/** A hub user exists: `parachute auth set-password` (and the wizard) write `operator.token`. */
export function adminExists(home: string): boolean {
  return existsSync(join(home, "operator.token"));
}

// ── file modes ───────────────────────────────────────────────────────────────

/** Folders stock Parachute creates (relative to PARACHUTE_HOME; "" = the home itself), plus every `vault/data/<name>`. */
export const KNOWN_DIRS = ["", "hub", "hub/run", "hub/logs", "vault", "vault/data", "vault/logs", "well-known"] as const;
/** Secret-bearing files stock Parachute creates, plus every `vault/data/<name>/vault.db{,-wal,-shm}` and the log files in hub/logs and vault/logs. */
export const KNOWN_FILES = ["hub.db", "hub.db-wal", "hub.db-shm", "operator.token", "vault/config.yaml", "vault/.env", "hub/run/hub.port"] as const;
const VAULT_DB_FILES = ["vault.db", "vault.db-wal", "vault.db-shm"] as const;

/** Exactly the paths {@link tightenParachuteModes} may change, for this home as it is now. */
export function knownParachutePaths(home: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = KNOWN_DIRS.map((d) => (d ? join(home, d) : home));
  const files: string[] = KNOWN_FILES.map((f) => join(home, f));
  const data = join(home, "vault", "data");
  for (const name of safeList(data)) {
    const d = join(data, name);
    if (!isRealDir(d)) continue;
    dirs.push(d);
    for (const f of VAULT_DB_FILES) files.push(join(d, f));
  }
  for (const logDir of [join(home, "hub", "logs"), join(home, "vault", "logs")]) {
    for (const name of safeList(logDir)) if (/\.log(\.\d+)?$/.test(name)) files.push(join(logDir, name));
  }
  return { dirs, files };
}

function safeList(dir: string): string[] {
  try {
    return isRealDir(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

function isRealDir(p: string): boolean {
  try {
    const s = lstatSync(p);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}

export interface ModeChange {
  path: string;
  from: string;
  to: string;
}

/**
 * Take group/other access off the files and folders stock Parachute is KNOWN to create
 * ({@link knownParachutePaths}) — nothing else under PARACHUTE_HOME is looked at. Only ever
 * narrows (`mode & ~077`), never widens; symlinks and paths owned by another user are left
 * alone; a path that does not exist is skipped. Runs at every `prism run hub` start.
 */
export function tightenParachuteModes(home: string, o: { dryRun?: boolean; uid?: number } = {}): ModeChange[] {
  const uid = o.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const { dirs, files } = knownParachutePaths(home);
  const out: ModeChange[] = [];
  const visit = (p: string, wantDir: boolean) => {
    let s;
    try {
      s = lstatSync(p);
    } catch {
      return;
    }
    if (s.isSymbolicLink() || s.isDirectory() !== wantDir || (!wantDir && !s.isFile())) return;
    if (uid >= 0 && s.uid !== uid) return;
    const cur = s.mode & 0o777;
    const next = cur & ~0o077;
    if (cur === next) return;
    if (!o.dryRun) chmodSync(p, next);
    out.push({ path: p, from: cur.toString(8).padStart(4, "0"), to: next.toString(8).padStart(4, "0") });
  };
  for (const d of dirs) visit(d, true);
  for (const f of files) visit(f, false);
  return out;
}

// ── the hub process ──────────────────────────────────────────────────────────

export interface HubCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Variables the hub child inherits from `prism run hub`'s own environment, by name (no secret). */
const HUB_ENV_PASS = ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TZ"] as const;

/**
 * The exact command `prism run hub` starts in stock mode (pure; pinned by tests): the stock
 * `parachute serve` in the foreground — what Parachute's own unit runs, minus the unit.
 */
export function stockHubCommand(o: { bin: string; home: string; userHome: string; parentEnv: NodeJS.ProcessEnv }): HubCommand {
  const env: Record<string, string> = {};
  for (const k of HUB_ENV_PASS) if (typeof o.parentEnv[k] === "string") env[k] = o.parentEnv[k]!;
  for (const [k, v] of Object.entries(o.parentEnv)) if (k.startsWith("LC_") && typeof v === "string") env[k] = v;
  const binDir = dirname(o.bin);
  const bunInstall = binDir.endsWith("/.bun/bin") ? dirname(binDir) : o.parentEnv.BUN_INSTALL || join(o.userHome, ".bun");
  Object.assign(env, {
    HOME: env.HOME ?? o.userHome,
    PATH: [binDir, join(bunInstall, "bin"), agentPath(o.userHome)].join(":"),
    BUN_INSTALL: bunInstall,
    PARACHUTE_HOME: o.home,
    // Stock `serve` binds 0.0.0.0 without this (launch plan §3.6).
    PARACHUTE_BIND_HOST: "127.0.0.1",
    PORT: String(STOCK_HUB_PORT),
  });
  return { cmd: o.bin, args: ["serve"], cwd: o.home, env };
}

export interface StockHubRun {
  layout: Layout;
  /** `.env` facts: the Parachute CLI and home. */
  bin: string | undefined;
  home: string | undefined;
  userHome: string;
  parentEnv: NodeJS.ProcessEnv;
  foreground: boolean;
  dryRun: boolean;
  /** Parachute's own units, already detected (a loaded one means: do not start a second hub). */
  foreign: ForeignUnit[];
  log(s: string): void;
  /** Test seam: start the child. */
  spawnChild?(c: HubCommand, foreground: boolean): ChildProcess;
}

/**
 * `prism run hub` in stock mode. Refuses (exit 0 under launchd — KeepAlive restarts only a
 * failed exit, and retrying fixes neither) without a Parachute CLI or home in `.env`, or when
 * Parachute's own hub unit is loaded. Otherwise tightens the known file modes and runs
 * `parachute serve` with its output in `logs/hub.log` (rotated), forwarding SIGTERM/SIGINT and
 * SIGKILLing only after {@link STOP_GRACE_MS}.
 */
export async function runStockHub(o: StockHubRun): Promise<{ code: number; command?: HubCommand; modes?: ModeChange[] }> {
  const refuse = (why: string) => {
    o.log(`prism run hub: ${why}`);
    return { code: o.foreground ? EXIT.CONFIG : EXIT.OK };
  };
  if (!o.bin) return refuse(`PARACHUTE_BIN is not set in ${o.layout.envFile}; run prism setup --from vault`);
  if (!o.home) return refuse(`PARACHUTE_HOME is not set in ${o.layout.envFile}; run prism setup --from vault`);
  const loaded = o.foreign.find((u) => u.loaded && u.label.endsWith(".hub"));
  if (loaded) return refuse(`Parachute's own launchd unit ${loaded.label} is running a hub; not starting a second one (prism setup --from vault explains)`);

  const command = stockHubCommand({ bin: o.bin, home: o.home, userHome: o.userHome, parentEnv: o.parentEnv });
  const modes = tightenParachuteModes(o.home, { dryRun: o.dryRun });
  if (o.dryRun) return { code: EXIT.OK, command, modes };
  if (modes.length) o.log(`prism run hub: tightened ${modes.length} Parachute file mode(s) under ${o.home}`);

  ensureDir(o.layout.logs, DIR_MODE);
  process.umask(0o077);
  const out = o.foreground ? null : new RotatingLog(join(o.layout.logs, "hub.log"));
  const child = (o.spawnChild ?? defaultSpawn)(command, o.foreground);
  if (out) {
    child.stdout?.on("data", (d: Buffer) => out.write(d));
    child.stderr?.on("data", (d: Buffer) => out.write(d));
  }
  let stopping = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = (sig: NodeJS.Signals) => {
    stopping = true;
    try {
      child.kill(sig);
    } catch {
      /* gone */
    }
    killTimer ??= setTimeout(() => {
      o.log(`prism run hub: the hub did not stop within ${STOP_GRACE_MS / 1000} s; killing it`);
      child.kill("SIGKILL");
    }, STOP_GRACE_MS);
    killTimer.unref();
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const code: number = await new Promise((resolve) => {
    child.on("error", (e) => {
      o.log(`prism run hub: could not start ${command.cmd}: ${e.message}`);
      resolve(EXIT.ERROR);
    });
    child.on("exit", (c, sig) => resolve(c ?? (sig ? 128 : 1)));
  });
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  if (killTimer) clearTimeout(killTimer);
  out?.close();
  if (stopping) return { code: EXIT.OK, command, modes };
  o.log(`prism run hub: the hub exited with ${code}`);
  // An unexpected exit 0 is still a failure for launchd (KeepAlive restarts only failures).
  return { code: code === 0 ? EXIT.ERROR : code, command, modes };
}

function defaultSpawn(c: HubCommand, foreground: boolean): ChildProcess {
  // detached = its own process group: a terminal Ctrl-C reaches the hub once, through us.
  return spawn(c.cmd, c.args, { cwd: c.cwd, env: c.env, detached: true, stdio: foreground ? "inherit" : ["ignore", "pipe", "pipe"] });
}

/** `prism run vault` in stock mode: the hub supervises the vault; Prism starts no second one. */
export function stockVaultMessage(): string {
  return "prism run vault: in stock mode the Parachute hub's supervisor runs the vault (services.json); Prism starts no second vault";
}
