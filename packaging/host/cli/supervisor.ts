/**
 * `prism run server` — what the launchd agent runs (and what you run in the foreground
 * with `--no-launchd`). It:
 *  1. reads the install's `.env` for the non-secret facts it needs (port, Parachute URLs)
 *     and refuses to start without a vault token (exit 78, launchd does not restart it);
 *  2. waits for Parachute: when Prism runs it (embedded, stock) the hub's /api/ready and the vault's /health
 *     (bounded; exit 75 → launchd tries again after ThrottleInterval); otherwise up to 30 s
 *     for the vault, then starts anyway (the server answers 503 on /health until it is up);
 *  3. starts the server on the bundled Node: `node --env-file=<.env> --import <tsx> index.ts`
 *     with the working directory = the config folder (the server edits `./.env` there), and an
 *     ALLOWLISTED environment (`INHERITED_ENV` + LC_*, minus anything `.env` sets, plus the
 *     paths the CLI sets): a shell variable never overrides the `.env`;
 *  4. writes its output to logs/server.log, rotated by size (10 MB × 5);
 *  5. watches /health?live=1 every 30 s and restarts a server that stops answering
 *     (3 misses in a row → SIGTERM, SIGKILL after 10 s → exit 1 → launchd starts it again);
 *  6. records DATA_VERSION once the server answered healthy with this version;
 *  7. forwards SIGTERM/SIGINT and WAITS for the server's graceful shutdown (it stores every
 *     open document, closes clients and the database — apps/server/src/shutdown.ts, bounded by
 *     SHUTDOWN_DEADLINE_MS, 8 s), SIGKILLs it only after `STOP_GRACE_MS` (15 s; launchd's
 *     ExitTimeOut is 20 s), and exits 0. A second signal is forwarded too (the server then
 *     exits at once). The server runs in its own process group, so a Ctrl-C in the terminal
 *     reaches it ONCE, through this forwarding — not twice (which would skip the stores).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv as parseDotEnv } from "node:util";
import { EXIT } from "./exit-codes";
import { envFacts } from "./hostenv";
import { probe, serverBase, type Fetch } from "./health";
import type { Layout } from "./paths";
import { readTextOrNull, writeFileAtomic, ensureDir } from "./fsutil";
import { readDataVersion, type BuildInfo, type ParachuteMode } from "./state";
import { nextDataVersion } from "./update";
import { DIR_MODE } from "./paths";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 5;
/** How long a stop waits for the server's graceful shutdown before SIGKILL. */
export const STOP_GRACE_MS = 15_000;

/** A size-rotating log file: name, name.1 … name.<keep>. */
export class RotatingLog {
  private fd: number;
  private size: number;

  constructor(
    private readonly path: string,
    private readonly maxBytes = LOG_MAX_BYTES,
    private readonly keep = LOG_KEEP,
  ) {
    this.fd = openSync(path, "a", 0o600);
    this.size = existsSync(path) ? statSync(path).size : 0;
  }

  write(chunk: Buffer | string): void {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.size > 0 && this.size + b.length > this.maxBytes) this.rotate();
    writeSync(this.fd, b);
    this.size += b.length;
  }

  rotate(): void {
    closeSync(this.fd);
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
    this.fd = openSync(this.path, "a", 0o600);
    this.size = 0;
  }

  close(): void {
    closeSync(this.fd);
  }
}

export interface ServerCommand {
  node: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * The variables the server inherits from whoever started the supervisor (launchd, or a shell
 * with `--foreground`). Everything else — a shell's `PARACHUTE_TOKEN`, `APP_ORIGIN`,
 * `NODE_OPTIONS`, `DYLD_*`, a stray `OWNER_EMAIL` — is dropped: the install's `.env` is the
 * configuration, and `node --env-file` never overrides a variable that is already set, so an
 * inherited one would silently win over it.
 */
export const INHERITED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TZ", "TMPDIR"] as const;
const inherited = (k: string): boolean => (INHERITED_ENV as readonly string[]).includes(k) || /^LC_[A-Z_]+$/.test(k);

/** The keys a `.env` text defines, read the way `node --env-file` reads it. */
export function envFileKeys(envText: string | null): Set<string> {
  if (!envText) return new Set();
  try {
    return new Set(Object.keys(parseDotEnv(envText)));
  } catch {
    return new Set();
  }
}

/**
 * The exact command the supervisor starts (pure; pinned by tests). `envText` = the install's
 * `.env`: an allowlisted inherited variable that the `.env` also sets is left out, so the
 * `.env` value is the one the server sees.
 */
export function serverCommand(layout: Layout, bundleRoot: string, info: BuildInfo, baseEnv: NodeJS.ProcessEnv, envText: string | null = null): ServerCommand {
  const fromFile = envFileKeys(envText);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined && inherited(k) && !fromFile.has(k)) env[k] = v;
  // App paths come from the bundle that is running (an update swaps them); --env-file does not
  // override variables that are already set, so these (set by the CLI, never inherited) win
  // over a stale value in .env.
  env.WEB_ROOT = join(bundleRoot, info.paths.web);
  env.PRISM_HOME = layout.prefix;
  const models = join(layout.config, "models.json");
  if (existsSync(models)) env.PRISM_MODELS_CONFIG = models;
  return {
    node: join(bundleRoot, info.paths.node),
    args: [`--env-file=${layout.envFile}`, "--import", pathToFileURL(join(bundleRoot, info.paths.tsxLoader)).href, join(bundleRoot, info.paths.server)],
    cwd: layout.config,
    env,
  };
}

export interface ReadyDeps {
  fetch: Fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
}

async function answers(fetchFn: Fetch, url: string): Promise<boolean> {
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(2000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

/**
 * Wait for Parachute (launchd has no job dependencies, so the order is kept here).
 * embedded / stock (Prism runs Parachute): hub /api/ready AND vault /health, ≤ `embeddedMs`,
 * else not ready (→ exit 75). external: vault /health ≤ `externalMs`, then go on regardless.
 */
export async function waitForParachute(mode: ParachuteMode, urls: { hub: string; vault: string }, deps: ReadyDeps, limits = { embeddedMs: 120_000, externalMs: 30_000 }): Promise<{ ready: boolean; waitedMs: number }> {
  if (mode === "none") return { ready: true, waitedMs: 0 };
  const start = deps.now();
  const owned = mode === "embedded" || mode === "stock";
  const budget = owned ? limits.embeddedMs : limits.externalMs;
  for (;;) {
    const hubOk = owned ? await answers(deps.fetch, `${urls.hub}/api/ready`) : true;
    const vaultOk = hubOk && (await answers(deps.fetch, `${urls.vault}/health`));
    const waited = deps.now() - start;
    if (hubOk && vaultOk) return { ready: true, waitedMs: waited };
    if (waited >= budget) return { ready: !owned, waitedMs: waited };
    await deps.sleep(2000);
  }
}

/** Watchdog bookkeeping: true once `misses` consecutive probes failed. */
export class Watchdog {
  private misses = 0;
  constructor(private readonly limit = 3) {}
  observe(live: boolean): boolean {
    this.misses = live ? 0 : this.misses + 1;
    return this.misses >= this.limit;
  }
}

export async function runServer(opts: { layout: Layout; bundleRoot: string; info: BuildInfo; parachute: ParachuteMode; fetch: Fetch; foreground: boolean; log: (s: string) => void }): Promise<number> {
  const { layout, bundleRoot, info, log } = opts;
  const envText = readTextOrNull(layout.envFile);
  const facts = envFacts(envText);
  if (!facts.present) {
    log(`prism run server: no ${layout.envFile} — run \`prism install\` first`);
    return EXIT.CONFIG;
  }
  if (!facts.vaultTokenSet || !facts.ownerEmailSet) {
    log(`prism run server: ${!facts.vaultTokenSet ? "PARACHUTE_TOKEN" : "OWNER_EMAIL"} is not set in ${layout.envFile}; not starting (set it, then \`prism start\`)`);
    // 0, not 78, under launchd: KeepAlive restarts only a failed exit, and a config gap is not fixed by retrying.
    return opts.foreground ? EXIT.CONFIG : EXIT.OK;
  }
  const ready = await waitForParachute(opts.parachute, { hub: facts.hubOrigin, vault: facts.parachuteUrl }, { fetch: opts.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now });
  if (!ready.ready) {
    log(`prism run server: Parachute is not ready after ${Math.round(ready.waitedMs / 1000)} s; launchd will try again`);
    return EXIT.TEMPFAIL;
  }

  ensureDir(layout.logs, DIR_MODE);
  const out = opts.foreground ? null : new RotatingLog(join(layout.logs, "server.log"));
  const cmd = serverCommand(layout, bundleRoot, info, process.env, envText);
  // detached = its own process group (see 7. above); the supervisor still waits for it.
  const child: ChildProcess = spawn(cmd.node, cmd.args, { cwd: cmd.cwd, env: cmd.env, detached: true, stdio: opts.foreground ? "inherit" : ["ignore", "pipe", "pipe"] });
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
      /* already gone */
    }
    killTimer ??= setTimeout(() => {
      log(`prism run server: the server did not stop within ${STOP_GRACE_MS / 1000} s; killing it`);
      child.kill("SIGKILL");
    }, STOP_GRACE_MS);
    killTimer.unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const base = serverBase(facts.port);
  const dog = new Watchdog(3);
  let recorded = false;
  let exited = false;
  // Boot grace: the first start compiles the TypeScript (tsx) and may take a while.
  const graceUntil = Date.now() + 120_000;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    const p = await probe(opts.fetch, base, 5000);
    if (exited) return;
    if (p.live && !recorded && p.version === info.version) {
      recorded = true;
      const next = nextDataVersion(readDataVersion(layout), info.version);
      writeFileAtomic(layout.dataVersionFile, next + "\n", 0o600);
    }
    if ((recorded || Date.now() >= graceUntil) && dog.observe(p.live) && !stopping) {
      log("prism run server: /health?live=1 did not answer 3 times in a row; restarting the server");
      stop("SIGTERM");
    }
    // Every 2 s until the first healthy answer, then every 30 s.
    timer = setTimeout(tick, recorded ? 30_000 : 2_000);
  };
  timer = setTimeout(tick, 2_000);

  const code: number = await new Promise((resolve) => child.on("exit", (c, sig) => resolve(c ?? (sig ? 128 : 1))));
  exited = true;
  if (timer) clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  if (stopping && code !== 0) {
    const line = `prism run server: the server stopped with ${code}${code === 1 ? " (its shutdown deadline passed with document stores unfinished — see server.log)" : ""}\n`;
    if (out) out.write(line);
    else log(line.trimEnd());
  }
  out?.close();
  if (stopping) return EXIT.OK;
  log(`prism run server: the server exited with ${code}`);
  return code === 0 ? EXIT.ERROR : code;
}

/** `prism run hub|vault` — placeholders until the Parachute payload ships in the bundle. */
export function runParachutePlaceholder(name: "hub" | "vault", info: BuildInfo, log: (s: string) => void): number {
  if (!info.parachute.bundled) {
    log(`prism run ${name}: this bundle carries no Parachute payload yet (embedded mode); nothing to run`);
    return EXIT.OK;
  }
  log(`prism run ${name}: embedded Parachute is not wired in this version`);
  return EXIT.CONFIG;
}
