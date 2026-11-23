/**
 * The `prism` commands. Each returns a result object; `main.ts` prints it (or `--json`
 * prints it as one JSON object) and exits with `result.code`. Every effect on the machine
 * goes through `Ctx`, so tests run the commands against a scratch prefix with fakes.
 */
import { copyFileSync, constants as fsConstants, cpSync, createReadStream, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { CliError, EXIT, type ExitCode } from "./exit-codes";
import { bool, int, str, type Parsed } from "./args";
import { DIR_MODE, PLIST_MODE, SECRET_FILE_MODE, defaultPrefix, launchAgentsDir, layoutFor, prefixProblem, privateDirs, versionDir, type Layout } from "./paths";
import { acquireLock, ensureDir, modeOf, readLinkOrNull, readTextOrNull, symlinkAtomic, writeFileAtomic } from "./fsutil";
import { emptyState, readBuildInfo, readDataVersion, readState, writeState, type BuildInfo, type HostState, type ParachuteMode } from "./state";
import { envFacts, freshEnv, updateEnv, DEFAULT_PORT } from "./hostenv";
import { Launchd, type Runner } from "./launchd";
import { AGENTS, labelFor, loadIdentity, loadTemplate, renderAgent, type AgentName } from "./plist";
import { ExitWatch, probe, serverBase, waitHealthy, type Fetch } from "./health";
import { runDoctor, type MachineProbes } from "./doctor";
import { runBackup, databasesToBackUp, type OpenSqlite } from "./backup";
import { parsePublicKey, verifyMinisign } from "./minisign";
import { runUpdate, nextDataVersion, type StagedBundle, type UpdateDeps } from "./update";
import { runParachutePlaceholder, runServer } from "./supervisor";
import { versionGate } from "./semver";
import { hostKeyFileFor, readHostKey, requestLocalLink, requestReachRecord, PRINTED_LINK_WARNING, type SigninFetch } from "../../../apps/server/scripts/lib/local-signin-client";
import { reachOff, reachOn, reachStatus, type ReachDeps } from "./reach";
import { chooseParachuteHome, detectParachuteUnits, runStockHub, stockVaultMessage, type ForeignUnit } from "./parachute-stock";
import { parseEnv } from "../../../apps/server/scripts/lib/env-file";

export interface Ctx {
  /** The bundle this CLI belongs to (`<bundle>/libexec/prism.mjs` → `<bundle>`). */
  bundleRoot: string;
  home: string;
  uid: number;
  env: NodeJS.ProcessEnv;
  runner: Runner;
  fetch: Fetch;
  probes: MachineProbes;
  /** better-sqlite3 from a bundle's node_modules (loaded on first use). */
  openSqlite(bundleRoot: string): OpenSqlite;
  copyTree(src: string, dst: string): void;
  now(): Date;
  log(s: string): void;
  healthTimeoutMs: number;
  /**
   * Open a URL in this person's default browser WITHOUT putting it on a command line (other
   * macOS users can read process arguments). Absent (tests, headless) = nothing is opened.
   */
  openUrl?(url: string): Promise<void>;
  /**
   * Progress of a long command (`prism setup`): one event per step as it finishes. With `--json`
   * main.ts writes each as one JSON line on stdout before the final object; otherwise one line on
   * stderr. Absent = nothing is reported until the end.
   */
  progress?(event: Record<string, unknown>): void;
}

export interface Result {
  code: ExitCode | number;
  [k: string]: unknown;
}

const PARACHUTE_MODES: readonly ParachuteMode[] = ["external", "stock", "embedded", "none"];

export function prefixOf(ctx: Ctx, p: Parsed): Layout {
  const raw = str(p, "prefix") ?? ctx.env.PRISM_HOME ?? defaultPrefix(ctx.home);
  const abs = resolve(raw);
  const problem = prefixProblem(abs, ctx.home);
  if (problem) throw new CliError(EXIT.USAGE, `--prefix: ${problem}`);
  return layoutFor(abs);
}

export function requireInstalled(layout: Layout): HostState {
  const s = readState(layout);
  if (!s || !s.current) throw new CliError(EXIT.NOT_INSTALLED, `Prism is not installed at ${layout.prefix} (run \`prism install\`)`);
  return s;
}

function launchdFor(ctx: Ctx, dryRun: boolean): Launchd {
  return new Launchd(ctx.runner, ctx.uid, dryRun);
}

function launchdDir(bundleRoot: string, info: BuildInfo): string {
  return join(bundleRoot, info.paths.launchd);
}

/**
 * The agents an install runs: the server; plus hub + vault for the embedded payload; plus the
 * hub alone for stock Parachute (its supervisor runs the vault — cli/parachute-stock.ts).
 */
export function agentsFor(state: Pick<HostState, "parachute">): AgentName[] {
  if (state.parachute === "embedded") return [...AGENTS];
  if (state.parachute === "stock") return ["hub", "server"];
  return ["server"];
}

/** Parachute's own launchd units on this Mac (read-only; runs under --dry-run too). */
export async function foreignParachuteUnits(ctx: Ctx): Promise<ForeignUnit[]> {
  return detectParachuteUnits(launchdFor(ctx, true), launchAgentsDir(ctx.home), ctx.env);
}

/**
 * Write Prism's hub agent for stock Parachute and load it (or restart it when it is loaded and
 * `restart`). The caller has checked that Parachute's own unit is not there.
 */
export async function startStockHubAgent(ctx: Ctx, layout: Layout, o: { dryRun: boolean; restart: boolean }): Promise<{ label: string; path: string; launchd: string[] }> {
  const bundle = currentBundle(layout);
  const info = readBuildInfo(bundle);
  const [hub] = writeAgents(ctx, layout, bundle, info, ["hub"], o.dryRun);
  const ld = launchdFor(ctx, o.dryRun);
  const loaded = !o.dryRun && (await ld.info(hub!.label)).loaded;
  if (!loaded) await ld.bootstrap(hub!.label, hub!.path);
  else if (o.restart) await ld.kickstart(hub!.label, true);
  return { label: hub!.label, path: hub!.path, launchd: ld.changes };
}

function writeAgents(ctx: Ctx, layout: Layout, bundleRoot: string, info: BuildInfo, names: AgentName[], dryRun: boolean) {
  const dir = launchdDir(bundleRoot, info);
  const identity = loadIdentity(dir);
  const la = launchAgentsDir(ctx.home);
  const rendered = names.map((name) => renderAgent({ name, template: loadTemplate(dir, name), identity, layout, home: ctx.home, launchAgents: la }));
  if (!dryRun) {
    ensureDir(la, modeOf(la) ?? 0o755);
    for (const a of rendered) if (readTextOrNull(a.path) !== a.xml) writeFileAtomic(a.path, a.xml, PLIST_MODE);
  }
  return rendered;
}

export function serverPort(layout: Layout): number {
  return envFacts(readTextOrNull(layout.envFile)).port;
}

async function waitFor(ctx: Ctx, layout: Layout, version: string, timeoutMs = ctx.healthTimeoutMs, failFast?: () => Promise<string | null>) {
  return waitHealthy(ctx.fetch, serverBase(serverPort(layout)), version, { timeoutMs, failFast });
}

/**
 * A `failFast` for `waitHealthy` that reads the server agent from launchd each round
 * (`launchctl print`, read-only) and answers once its process has exited repeatedly
 * (`ExitWatch`). A launchd error is no answer — the wait goes on.
 */
export function serverExitWatch(ctx: Ctx, layout: Layout): () => Promise<string | null> {
  const bundle = currentBundle(layout);
  const label = labelFor(loadIdentity(launchdDir(bundle, readBuildInfo(bundle))), "server");
  const ld = launchdFor(ctx, true);
  const watch = new ExitWatch();
  return async () => {
    try {
      return watch.observe(await ld.info(label));
    } catch {
      return null;
    }
  };
}

export function currentBundle(layout: Layout): string {
  return resolve(layout.appRoot, readLinkOrNull(layout.current) ?? "current");
}

function history(state: HostState, ctx: Ctx, action: string, from: string | null, to: string | null, result: string) {
  state.history.push({ at: ctx.now().toISOString(), action, from, to, result });
  state.updatedAt = ctx.now().toISOString();
}

// ── doctor ───────────────────────────────────────────────────────────────────

export async function cmdDoctor(ctx: Ctx, p: Parsed): Promise<Result> {
  const layout = prefixOf(ctx, p);
  const installed = readState(layout);
  const port = int(p, "port", 1024, 65535) ?? serverPort(layout);
  // An installed, running server holds its own port: that is not a conflict.
  const live = installed ? (await probe(ctx.fetch, serverBase(port), 1500)).live : false;
  const checks = await runDoctor(ctx.probes, { ports: live ? [] : [port], prefix: layout.prefix });
  const failed = checks.filter((c) => !c.ok && c.fatal);
  return { code: failed.length ? EXIT.PRECONDITION : EXIT.OK, ok: failed.length === 0, prefix: layout.prefix, checks };
}

// ── install ──────────────────────────────────────────────────────────────────

function readTokenFile(path: string): { token: string; warning?: string } {
  const abs = resolve(path);
  const t = readFileSync(abs, "utf8").trim();
  if (!t || /\s/.test(t)) throw new CliError(EXIT.USAGE, "--parachute-token-file must hold one token on one line");
  const mode = modeOf(abs);
  return { token: t, warning: mode !== null && (mode & 0o077) !== 0 ? `${abs} is readable by others (mode ${mode.toString(8)}); chmod 600 it` : undefined };
}

export async function cmdInstall(ctx: Ctx, p: Parsed): Promise<Result> {
  const layout = prefixOf(ctx, p);
  const dryRun = bool(p, "dry-run");
  const info = readBuildInfo(ctx.bundleRoot);
  const mode = (str(p, "parachute") ?? "external") as ParachuteMode;
  if (!PARACHUTE_MODES.includes(mode)) throw new CliError(EXIT.USAGE, "--parachute must be external, embedded or none");
  if (mode === "embedded" && !info.parachute.bundled) throw new CliError(EXIT.PRECONDITION, "--parachute embedded: this bundle carries no Parachute payload yet (use external, or stock)");
  if (mode === "stock") {
    // Never a second hub beside Parachute's own unit: reuse that one (--parachute external).
    const theirs = await foreignParachuteUnits(ctx);
    if (theirs.length) throw new CliError(EXIT.PRECONDITION, `--parachute stock: Parachute's own launchd unit runs here (${theirs.map((u) => u.label).join(", ")}); use --parachute external to reuse it`, { units: theirs });
  }
  const useLaunchd = !bool(p, "no-launchd");
  const start = useLaunchd && !bool(p, "no-start");
  const port = int(p, "port", 1024, 65535);
  const prior = readState(layout);
  if (prior?.current && prior.current !== info.version) {
    throw new CliError(EXIT.PRECONDITION, `Prism ${prior.current} is installed at ${layout.prefix}; use \`prism update <tarball>\` to change versions`, { installed: prior.current, bundle: info.version });
  }
  const gate = versionGate({ installed: prior?.current ?? null, candidate: info.version, dataVersion: readDataVersion(layout), force: true });
  if (gate.action === "downgrade" && !bool(p, "force")) {
    throw new CliError(EXIT.VERSION_REFUSED, `the data at ${layout.prefix} was last used by a newer Prism (${readDataVersion(layout)}); refusing (use --force)`);
  }

  const warnings: string[] = [];
  const actions: string[] = [];
  if (!bool(p, "skip-checks")) {
    const ports = prior ? [] : [port ?? DEFAULT_PORT];
    const checks = await runDoctor(ctx.probes, { ports, prefix: layout.prefix });
    const failed = checks.filter((c) => !c.ok && c.fatal);
    if (failed.length) throw new CliError(EXIT.PRECONDITION, `this Mac cannot host Prism: ${failed.map((c) => c.detail).join("; ")}`, { checks });
  }

  const tokenFile = str(p, "parachute-token-file");
  const token = tokenFile ? readTokenFile(tokenFile) : undefined;
  if (token?.warning) warnings.push(token.warning);
  if (mode === "stock" && !str(p, "parachute-bin") && !parseEnv(readTextOrNull(layout.envFile) ?? "").PARACHUTE_BIN) {
    warnings.push("--parachute stock without --parachute-bin: the hub agent waits until PARACHUTE_BIN is set (prism setup --from vault finds it)");
  }
  const envInput = {
    ownerEmail: str(p, "owner-email"),
    appOrigin: str(p, "app-origin"),
    port,
    parachuteUrl: str(p, "parachute-url"),
    parachuteVault: str(p, "parachute-vault"),
    parachuteToken: token?.token,
    parachuteBin: str(p, "parachute-bin"),
    parachuteVaultBin: str(p, "parachute-vault-bin"),
    parachuteHome:
      str(p, "parachute-home") ??
      (mode === "embedded" ? layout.parachuteHome : mode === "stock" ? chooseParachuteHome({ configured: parseEnv(readTextOrNull(layout.envFile) ?? "").PARACHUTE_HOME, userHome: ctx.home, layout }).home : undefined),
    parachuteHubOrigin: str(p, "parachute-hub-origin"),
  };
  const existingEnv = readTextOrNull(layout.envFile);
  let envText: string;
  let envChange: { created: boolean; added: string[]; replaced: string[] };
  if (existingEnv === null) {
    try {
      envText = freshEnv(layout, envInput);
    } catch (e) {
      throw new CliError(EXIT.USAGE, (e as Error).message);
    }
    envChange = { created: true, added: [], replaced: [] };
  } else {
    const u = updateEnv(layout, existingEnv, envInput);
    envText = u.text;
    envChange = { created: false, added: u.added, replaced: u.replaced };
  }

  const target = versionDir(layout, info.version);
  const insideInstall = resolve(ctx.bundleRoot).startsWith(layout.appRoot + "/");
  const needCopy = !insideInstall && !existsSync(join(target, "build-info.json"));
  for (const d of privateDirs(layout)) if (!existsSync(d) || modeOf(d) !== DIR_MODE) actions.push(`mkdir -m 700 ${d}`);
  if (needCopy) actions.push(`copy ${ctx.bundleRoot} → ${target}`);
  actions.push(`current → ${info.version}`, `link ${layout.binPrism}`);
  actions.push(envChange.created ? `write ${layout.envFile} (0600, new secrets)` : `update ${layout.envFile}: added [${envChange.added.join(", ")}] replaced [${envChange.replaced.join(", ")}]`);

  let launchd: Launchd | null = null;
  let agents: Array<{ label: string; path: string }> = [];
  if (dryRun) {
    if (useLaunchd) {
      agents = writeAgents(ctx, layout, ctx.bundleRoot, info, agentsFor({ parachute: mode }), true).map(({ label, path }) => ({ label, path }));
      for (const a of agents) actions.push(`write ${a.path}`);
      if (start) {
        launchd = launchdFor(ctx, true);
        for (const a of agents) await launchd.bootstrap(a.label, a.path);
      }
    }
    if (prior === null && existingEnv !== null && str(p, "parachute") === undefined && useLaunchd && start) actions.push("reinstall over kept data: run setup's vault step (restore Prism's hub agent for stock Parachute, or reuse a running one)");
    if (start && !bool(p, "no-signin")) actions.push("open a one-time owner sign-in link in the browser (`prism signin`)");
    return { code: EXIT.OK, dryRun: true, prefix: layout.prefix, version: info.version, actions: [...actions, ...(launchd?.changes ?? [])], warnings };
  }

  ensureDir(layout.prefix, DIR_MODE);
  const release = acquireLock(layout.lock);
  try {
    for (const d of privateDirs(layout)) ensureDir(d, DIR_MODE);
    if (!existsSync(layout.marker)) writeFileAtomic(layout.marker, "This folder is a Prism host install. See docs/host-bundle.md.\n", 0o600);
    if (needCopy) {
      const tmp = join(layout.appRoot, `.incoming-${randomBytes(4).toString("hex")}`);
      try {
        ctx.copyTree(ctx.bundleRoot, tmp);
        rmSync(target, { recursive: true, force: true });
        renameSync(tmp, target);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    symlinkAtomic(info.version, layout.current);
    symlinkAtomic(relative(layout.bin, join(layout.current, "bin", "prism")), layout.binPrism);
    if (envText !== existingEnv) writeFileAtomic(layout.envFile, envText, SECRET_FILE_MODE);
    else if (modeOf(layout.envFile) !== SECRET_FILE_MODE) writeFileAtomic(layout.envFile, envText, SECRET_FILE_MODE);

    const state = prior ?? emptyState(ctx.now().toISOString(), useLaunchd, mode);
    state.current = info.version;
    state.launchd = useLaunchd;
    state.parachute = mode;
    if (!state.installed.includes(info.version)) state.installed.push(info.version);
    history(state, ctx, "install", prior?.current ?? null, info.version, "ok");
    writeState(layout, state);

    // Reinstall over kept data (`prism uninstall` without --delete-data removed state.json, which
    // said how Parachute runs): run setup's own `vault` step — the same code `prism setup` runs —
    // so stock Parachute's hub agent comes back (or a running Parachute is reused) before the
    // server starts. Without it the server came up in external mode with no hub (clean-VM
    // finding: status 11, vault unreachable until `prism setup`). An explicit --parachute wins.
    let parachute: Record<string, unknown> | undefined;
    let hubJustStarted = false;
    if (prior === null && existingEnv !== null && str(p, "parachute") === undefined && useLaunchd && start) {
      const { runVaultStep } = await import("./setup");
      const v = await runVaultStep(ctx, p, layout);
      parachute = { step: "vault", state: v.state, ...(v.detail ? { detail: v.detail } : {}), changed: v.changed ?? [], ...(v.next ? { next: v.next } : {}), ...(v.commands ? { commands: v.commands } : {}) };
      hubJustStarted = (v.changed ?? []).includes("hub-agent");
      if (v.state !== "done") warnings.push(`Parachute is not ready (${v.state}): ${v.next ?? v.detail ?? "see parachute.next"}; then run prism setup --from vault`);
    }
    const now = readState(layout) ?? state; // the vault step may have switched the mode to stock
    let health: unknown = "skipped";
    if (useLaunchd) {
      const rendered = writeAgents(ctx, layout, target, info, agentsFor(now), false);
      agents = rendered.map(({ label, path }) => ({ label, path }));
      if (start) {
        launchd = launchdFor(ctx, false);
        for (const a of rendered) {
          // The hub agent the vault step just loaded (and waited for) is left running.
          if (hubJustStarted && a.name === "hub") continue;
          // Re-load so a changed plist takes effect.
          await launchd.bootout(a.label);
          await launchd.bootstrap(a.label, a.path);
        }
        const facts = envFacts(readTextOrNull(layout.envFile));
        if (facts.vaultTokenSet) {
          const h = await waitFor(ctx, layout, info.version);
          health = h;
          if (!h.ok) return { code: EXIT.DEGRADED, prefix: layout.prefix, version: info.version, actions, agents, env: envChange, health, warnings, ...(parachute ? { parachute } : {}), message: `installed, but the server did not become healthy: ${h.reason}`, next: "prism logs --lines 50" };
          if (h.last.vault === false) {
            // Running, but it cannot reach the vault: the same 11 `prism status` would answer.
            return {
              code: EXIT.DEGRADED,
              prefix: layout.prefix,
              version: info.version,
              actions,
              agents,
              launchd: launchd.changes,
              env: envChange,
              health,
              warnings,
              ...(parachute ? { parachute } : {}),
              message: "installed and running, but the server cannot reach the vault",
              next: "prism setup --from vault",
            };
          }
        } else {
          health = "waiting for PARACHUTE_TOKEN";
          warnings.push(`PARACHUTE_TOKEN is empty in ${layout.envFile}: the server starts once it is set (then \`prism start\`)`);
        }
      }
    }
    // The owner's first sign-in: never a link in the transcript — the browser opens it
    // (`prism signin`), or the person is told the command.
    let signin: unknown = { next: "prism signin", why: "sign in as the owner once the server is running" };
    if (health && typeof health === "object" && (health as { ok?: boolean }).ok && !bool(p, "no-signin")) {
      const s = await openOwnerSignin(ctx, layout);
      signin = s.ok ? { opened: true, expiresAt: s.expiresAt } : { opened: false, next: "prism signin", why: s.message };
    }
    return { code: EXIT.OK, prefix: layout.prefix, version: info.version, actions, agents, launchd: launchd?.changes ?? [], env: envChange, health, signin, warnings, ...(parachute ? { parachute } : {}) };
  } finally {
    release();
  }
}

// ── start / stop / restart ───────────────────────────────────────────────────

function managedOrThrow(state: HostState) {
  if (!state.launchd) throw new CliError(EXIT.PRECONDITION, "this install does not use launchd (installed with --no-launchd); run `prism run server` yourself");
}

export async function cmdStart(ctx: Ctx, p: Parsed, restart = false): Promise<Result> {
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  managedOrThrow(state);
  const dryRun = bool(p, "dry-run");
  const bundle = currentBundle(layout);
  const info = readBuildInfo(bundle);
  const agents = writeAgents(ctx, layout, bundle, info, agentsFor(state), dryRun);
  const ld = launchdFor(ctx, dryRun);
  for (const a of agents) {
    const loaded = (await ld.info(a.label)).loaded;
    if (!loaded) await ld.bootstrap(a.label, a.path);
    else if (restart) await ld.kickstart(a.label, true);
    else await ld.kickstart(a.label, false);
  }
  if (dryRun || bool(p, "no-wait")) return { code: EXIT.OK, dryRun, launchd: ld.changes };
  if (!envFacts(readTextOrNull(layout.envFile)).vaultTokenSet) {
    return { code: EXIT.NOT_RUNNING, launchd: ld.changes, message: `PARACHUTE_TOKEN is empty in ${layout.envFile}; the server will not start until it is set` };
  }
  const h = await waitFor(ctx, layout, info.version, (int(p, "timeout", 1, 3600) ?? ctx.healthTimeoutMs / 1000) * 1000);
  return { code: h.ok ? EXIT.OK : EXIT.DEGRADED, launchd: ld.changes, health: h };
}

export async function cmdStop(ctx: Ctx, p: Parsed): Promise<Result> {
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  managedOrThrow(state);
  const ld = launchdFor(ctx, bool(p, "dry-run"));
  const identity = loadIdentity(launchdDir(currentBundle(layout), readBuildInfo(currentBundle(layout))));
  // Server first, then Parachute (the reverse of the start order).
  for (const name of [...agentsFor(state)].reverse()) await ld.bootout(labelFor(identity, name));
  return { code: EXIT.OK, dryRun: bool(p, "dry-run"), launchd: ld.changes, note: "the agents start again at the next login; `prism uninstall` removes them" };
}

// ── status ───────────────────────────────────────────────────────────────────

export async function cmdStatus(ctx: Ctx, p: Parsed): Promise<Result> {
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  const bundle = currentBundle(layout);
  const info = readBuildInfo(bundle);
  const facts = envFacts(readTextOrNull(layout.envFile));
  const agents: Record<string, unknown> = {};
  if (state.launchd) {
    const identity = loadIdentity(launchdDir(bundle, info));
    const ld = launchdFor(ctx, true);
    for (const name of agentsFor(state)) agents[name] = { label: labelFor(identity, name), ...(await ld.info(labelFor(identity, name))) };
  }
  const pr = await probe(ctx.fetch, serverBase(facts.port));
  const code = !pr.live ? EXIT.NOT_RUNNING : pr.version !== info.version || pr.vault === false ? EXIT.DEGRADED : EXIT.OK;
  return {
    code,
    prefix: layout.prefix,
    installed: state.current,
    previous: state.previous,
    lastFailedUpdate: state.lastFailedUpdate ? { ...state.lastFailedUpdate, status: "failed" } : null,
    dataVersion: readDataVersion(layout),
    launchd: state.launchd,
    parachute: state.parachute,
    agents,
    server: { port: facts.port, live: pr.live, vault: pr.vault, version: pr.version },
    config: { envFile: layout.envFile, vaultTokenSet: facts.vaultTokenSet, ownerEmailSet: facts.ownerEmailSet },
  };
}

// ── logs ─────────────────────────────────────────────────────────────────────

export function logFiles(layout: Layout, name: string): string[] {
  const base = join(layout.logs, name);
  const out: string[] = [];
  for (let i = 5; i >= 1; i--) if (existsSync(`${base}.${i}`)) out.push(`${base}.${i}`);
  if (existsSync(base)) out.push(base);
  return out;
}

export function tailLines(files: string[], n: number): string[] {
  const lines: string[] = [];
  for (let i = files.length - 1; i >= 0 && lines.length < n; i--) {
    const text = readTextOrNull(files[i]!) ?? "";
    const ls = text.split("\n");
    if (ls[ls.length - 1] === "") ls.pop();
    lines.unshift(...ls.slice(Math.max(0, ls.length - (n - lines.length))));
  }
  return lines.slice(-n);
}

export async function cmdLogs(ctx: Ctx, p: Parsed): Promise<Result> {
  const layout = prefixOf(ctx, p);
  requireInstalled(layout);
  const which = str(p, "file") ?? "server";
  const names: Record<string, string> = { server: "server.log", launchd: "server.launchd.log", hub: "hub.log", "hub-launchd": "hub.launchd.log" };
  const name = names[which];
  if (!name) throw new CliError(EXIT.USAGE, "--file must be server, launchd, hub or hub-launchd");
  const files = logFiles(layout, name);
  const lines = tailLines(files, int(p, "lines", 1, 100_000) ?? 100);
  if (!bool(p, "follow")) return { code: EXIT.OK, files, lines };
  for (const l of lines) ctx.log(l);
  // Follow: poll the live file; a rotation (the file shrank or is a new inode) starts it over.
  const path = join(layout.logs, name);
  let pos = existsSync(path) ? statSync(path).size : 0;
  let ino = existsSync(path) ? statSync(path).ino : 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    if (!existsSync(path)) continue;
    const st = statSync(path);
    if (st.ino !== ino || st.size < pos) {
      ino = st.ino;
      pos = 0;
    }
    if (st.size > pos) {
      const chunk = await new Promise<string>((res, rej) => {
        let s = "";
        createReadStream(path, { start: pos, end: st.size - 1, encoding: "utf8" })
          .on("data", (d) => (s += d))
          .on("end", () => res(s))
          .on("error", rej);
      });
      pos = st.size;
      for (const l of chunk.replace(/\n$/, "").split("\n")) ctx.log(l);
    }
  }
}

// ── backup ───────────────────────────────────────────────────────────────────

function parachuteHomeFor(layout: Layout, state: HostState, p: Parsed): string | null {
  const explicit = str(p, "parachute-home");
  if (explicit) return resolve(explicit);
  if (state.parachute !== "embedded" && state.parachute !== "stock") return null;
  const env = readTextOrNull(layout.envFile);
  const m = env ? /^PARACHUTE_HOME=(.+)$/m.exec(env) : null;
  return m ? m[1]! : layout.parachuteHome;
}

export async function doBackup(ctx: Ctx, layout: Layout, state: HostState, label: string, keep: number | undefined, parachuteHome: string | null) {
  const bundle = currentBundle(layout);
  return runBackup({
    layout,
    open: ctx.openSqlite(bundle),
    label,
    keep,
    parachuteHome,
    now: ctx.now(),
    versions: { prism: state.current, dataVersion: readDataVersion(layout) },
  });
}

export async function cmdBackup(ctx: Ctx, p: Parsed): Promise<Result> {
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  const parachuteHome = parachuteHomeFor(layout, state, p);
  if (bool(p, "dry-run")) {
    return { code: EXIT.OK, dryRun: true, databases: databasesToBackUp(layout, parachuteHome).map((d) => d.rel), into: layout.backups };
  }
  const release = acquireLock(layout.lock);
  try {
    const r = await doBackup(ctx, layout, state, str(p, "label") ?? "manual", int(p, "keep", 0, 1000), parachuteHome);
    return { code: r.ok ? EXIT.OK : EXIT.VERIFY_FAILED, ...r };
  } finally {
    release();
  }
}

// ── update ───────────────────────────────────────────────────────────────────

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest("hex");
}

/** Where a bundle carries the release public key (copied from packaging/host/release/minisign.pub by build.ts). */
export function releaseKeyPath(bundleRoot: string): string {
  return join(bundleRoot, "share", "minisign.pub");
}

const DEV_ONLY = "--allow-unsigned is for development builds only";

/**
 * The expected hash of `name`, from a SHA256SUMS whose minisign signature verifies against the
 * release key shipped in THIS (the running) bundle. Fails closed: no key in the bundle, no
 * signature, a bad signature, or a bare `--sha256` -> refused, unless `--allow-unsigned`, which
 * then answers a `warning`. A signature that is present but does not verify is refused even
 * with `--allow-unsigned`. The bytes that are verified are the bytes that are parsed.
 */
export function checkSignedSums(o: { sumsPath: string; sigPath: string; keyPath: string; sha256Flag?: string; allowUnsigned: boolean; name: string }): { ok: true; expected: string; warning?: string; signedBy?: string } | { ok: false; reason: string } {
  if (o.sha256Flag !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(o.sha256Flag)) return { ok: false, reason: "--sha256 needs 64 hex characters" };
    if (!o.allowUnsigned) return { ok: false, reason: "--sha256 is a checksum, not a signature: updates need a signed SHA256SUMS (or --allow-unsigned, development builds only)" };
    return { ok: true, expected: o.sha256Flag, warning: `the checksum came from --sha256 and no signature was checked (${DEV_ONLY})` };
  }
  if (!existsSync(o.sumsPath)) return { ok: false, reason: `no checksum for ${o.name} (expected ${o.sumsPath})` };
  const sums = readFileSync(o.sumsPath);
  let warning: string | undefined;
  let signedBy: string | undefined;
  const hasKey = existsSync(o.keyPath);
  const hasSig = existsSync(o.sigPath);
  if (hasKey && hasSig) {
    let pub;
    try {
      pub = parsePublicKey(readFileSync(o.keyPath, "utf8"));
    } catch (e) {
      return { ok: false, reason: `the release key shipped in this install is unreadable (${o.keyPath}): ${(e as Error).message}` };
    }
    const v = verifyMinisign(sums, readFileSync(o.sigPath, "utf8"), pub);
    if (!v.ok) return { ok: false, reason: `${basename(o.sigPath)} does not verify: ${v.reason}` };
    signedBy = `key ${v.keyId} (${v.trustedComment})`;
  } else if (!hasKey && hasSig && !o.allowUnsigned) {
    return { ok: false, reason: `this install ships no release key (${o.keyPath}), so ${basename(o.sigPath)} cannot be checked; refusing (--allow-unsigned, development builds only)` };
  } else if (!o.allowUnsigned) {
    return {
      ok: false,
      reason: hasKey
        ? `${basename(o.sumsPath)} is not signed (no ${o.sigPath}); updates need the release signature`
        : `this install ships no release key (${o.keyPath}), so no signature can be checked; refusing (--allow-unsigned, development builds only)`,
    };
  } else {
    warning = hasKey ? `${basename(o.sumsPath)} is not signed and was accepted anyway (${DEV_ONLY})` : `no release key in this install: the signature was not checked (${DEV_ONLY})`;
  }
  const expected = sumFor(sums.toString("utf8"), o.name);
  if (!expected) return { ok: false, reason: `no checksum for ${o.name} in ${o.sumsPath}` };
  return { ok: true, expected, warning, signedBy };
}

/** Find `name`'s hash in a SHA256SUMS file (`<hex>  <name>` or `<hex> *<name>`). */
export function sumFor(sums: string, name: string): string | null {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1]!;
  }
  return null;
}

/**
 * What an unpacked bundle may not hold (security review): a symlink whose target is absolute
 * or leaves `root`, a device file, a FIFO or a socket. macOS tar already refuses `..` names,
 * absolute names and writing through a symlink, but it CREATES a symlink entry pointing
 * anywhere. Returns the offending paths, relative to `root` (empty = fine). Never follows a link.
 */
export function unsafeBundleEntries(root: string): string[] {
  const bad: string[] = [];
  const top = resolve(root);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(path);
        const lands = resolve(dirname(path), target);
        if (isAbsolute(target) || (lands !== top && !lands.startsWith(top + sep))) bad.push(relative(top, path));
      } else if (st.isDirectory()) walk(path);
      else if (!st.isFile()) bad.push(relative(top, path));
    }
  };
  walk(top);
  return bad;
}

export function realUpdateDeps(ctx: Ctx, layout: Layout, state: HostState, p: Parsed): UpdateDeps {
  const staging = new Map<StagedBundle, string>();
  /** The hash `verify` accepted, per tarball: `unpack` works on a private copy that must match it. */
  const verified = new Map<string, string>();
  return {
    log: (m) => ctx.log(m),
    async verify(tarball) {
      if (!existsSync(tarball)) return { ok: false, reason: `${tarball} does not exist` };
      const sumsPath = str(p, "sums") ?? join(dirname(tarball), "SHA256SUMS");
      const signed = checkSignedSums({
        sumsPath,
        sigPath: str(p, "sig") ?? `${sumsPath}.minisig`,
        keyPath: releaseKeyPath(ctx.bundleRoot),
        sha256Flag: str(p, "sha256"),
        allowUnsigned: bool(p, "allow-unsigned"),
        name: basename(tarball),
      });
      if (!signed.ok) return { ok: false, reason: signed.reason };
      const got = await sha256File(tarball);
      if (got !== signed.expected.toLowerCase()) return { ok: false, reason: `SHA-256 mismatch: expected ${signed.expected}, got ${got}` };
      verified.set(tarball, got);
      return { ok: true, sha256: got, warning: signed.warning, signedBy: signed.signedBy };
    },
    async unpack(tarball) {
      const outer = join(layout.appRoot, `.incoming-${randomBytes(4).toString("hex")}`);
      ensureDir(outer, DIR_MODE);
      try {
        // Work on a private copy whose hash is the verified one: the file at `tarball` may be
        // rewritten by someone else after the check (a tarball left in /tmp).
        const want = verified.get(tarball);
        if (!want) throw new Error("the archive was not verified");
        if (!lstatSync(tarball).isFile()) throw new Error("the archive is not a regular file");
        const copy = join(outer, "bundle.tar.gz");
        copyFileSync(tarball, copy, fsConstants.COPYFILE_EXCL);
        if ((await sha256File(copy)) !== want) throw new Error("the archive changed after it was verified");
        tarball = copy;
        const list = await ctx.runner("/usr/bin/tar", ["-tzf", tarball]);
        if (list.code !== 0) throw new Error(`tar -t failed: ${list.stderr.trim()}`);
        const tops = new Set(list.stdout.split("\n").filter(Boolean).map((e) => e.replace(/^\.\//, "").split("/")[0]));
        if (tops.size !== 1 || ![...tops][0]!.startsWith("prism-host-")) throw new Error("the archive must hold exactly one prism-host-* folder");
        const x = await ctx.runner("/usr/bin/tar", ["-xzf", tarball, "-C", outer]);
        if (x.code !== 0) throw new Error(`tar -x failed: ${x.stderr.trim()}`);
        const dir = join(outer, [...tops][0]!);
        if (!lstatSync(dir).isDirectory()) throw new Error("the archive's prism-host-* entry is not a folder");
        const unsafe = unsafeBundleEntries(dir);
        if (unsafe.length) throw new Error(`the archive holds links or special files that leave the bundle: ${unsafe.slice(0, 3).join(", ")}`);
        rmSync(copy, { force: true });
        const s: StagedBundle = { dir, info: readBuildInfo(dir) };
        staging.set(s, outer);
        return s;
      } catch (e) {
        rmSync(outer, { recursive: true, force: true });
        throw e;
      }
    },
    discard(s) {
      rmSync(staging.get(s) ?? s.dir, { recursive: true, force: true });
    },
    installed: () => ({ current: state.current, previous: state.previous, dataVersion: readDataVersion(layout) }),
    backup: async (label) => {
      try {
        const r = await doBackup(ctx, layout, state, label, undefined, parachuteHomeFor(layout, state, p));
        return r.ok ? { ok: true, dir: r.dir } : { ok: false, reason: r.problems.join("; ") };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
    place(s) {
      const target = versionDir(layout, s.info.version);
      if (readLinkOrNull(layout.current) !== s.info.version) rmSync(target, { recursive: true, force: true });
      if (!existsSync(target)) renameSync(s.dir, target);
      rmSync(staging.get(s) ?? s.dir, { recursive: true, force: true });
      if (!state.installed.includes(s.info.version)) state.installed.push(s.info.version);
    },
    pointCurrent: (v) => symlinkAtomic(v, layout.current),
    managed: () => state.launchd,
    async restart() {
      const bundle = currentBundle(layout);
      const info = readBuildInfo(bundle);
      const agents = writeAgents(ctx, layout, bundle, info, agentsFor(state), false);
      const ld = launchdFor(ctx, false);
      for (const a of agents) {
        if ((await ld.info(a.label)).loaded) await ld.kickstart(a.label, true);
        else await ld.bootstrap(a.label, a.path);
      }
    },
    waitHealthy: (v) => waitFor(ctx, layout, v, (int(p, "timeout", 1, 3600) ?? ctx.healthTimeoutMs / 1000) * 1000, serverExitWatch(ctx, layout)),
    record(r) {
      state.current = r.current;
      state.previous = r.previous;
      if (r.failed) state.lastFailedUpdate = { version: r.failed.version, at: ctx.now().toISOString(), reason: r.failed.reason, treeKept: r.failed.treeKept };
      else if (r.healthyVersion) delete state.lastFailedUpdate;
      history(state, ctx, r.action, r.from, r.to, r.result);
      writeState(layout, state);
      if (r.healthyVersion) writeFileAtomic(layout.dataVersionFile, nextDataVersion(readDataVersion(layout), r.healthyVersion) + "\n", SECRET_FILE_MODE);
    },
    prune(keep) {
      for (const name of readdirSync(layout.appRoot)) {
        if (name === "current" || name.startsWith(".") || keep.includes(name)) continue;
        if (existsSync(join(layout.appRoot, name, "build-info.json"))) rmSync(join(layout.appRoot, name), { recursive: true, force: true });
      }
      state.installed = state.installed.filter((v) => keep.includes(v));
      writeState(layout, state);
    },
  };
}

export async function cmdUpdate(ctx: Ctx, p: Parsed, deps?: UpdateDeps): Promise<Result> {
  const tarball = p.positional[0];
  if (!tarball) throw new CliError(EXIT.USAGE, "usage: prism update <prism-host-…tar.gz> [--sums SHA256SUMS] [--sig SHA256SUMS.minisig] [--force] [--dry-run] [--allow-unsigned]");
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  const dryRun = bool(p, "dry-run");
  const release = dryRun ? () => {} : acquireLock(layout.lock);
  try {
    const r = await runUpdate(resolve(tarball), { force: bool(p, "force"), dryRun }, deps ?? realUpdateDeps(ctx, layout, state, p));
    return { ...r };
  } finally {
    release();
  }
}

// ── uninstall ────────────────────────────────────────────────────────────────

export async function cmdUninstall(ctx: Ctx, p: Parsed): Promise<Result> {
  const layout = prefixOf(ctx, p);
  const dryRun = bool(p, "dry-run");
  const deleteData = bool(p, "delete-data");
  const state = readState(layout);
  if (!state && !existsSync(layout.marker)) throw new CliError(EXIT.NOT_INSTALLED, `no Prism host install at ${layout.prefix}`);
  if (deleteData && !bool(p, "yes")) {
    throw new CliError(EXIT.NEEDS_CONFIRMATION, `--delete-data removes ${layout.prefix} entirely — the database, the .env with every secret, logs and backups. Re-run with --yes to confirm (consider \`prism backup\` first).`);
  }
  const removed: string[] = [];
  const ld = launchdFor(ctx, dryRun);
  // Labels from the bundle that is installed; fall back to this CLI's own identity.
  let launchd: string = ctx.bundleRoot;
  try {
    launchd = launchdDir(currentBundle(layout), readBuildInfo(currentBundle(layout)));
  } catch {
    launchd = launchdDir(ctx.bundleRoot, readBuildInfo(ctx.bundleRoot));
  }
  const identity = loadIdentity(launchd);
  for (const name of ["server", "vault", "hub"] as AgentName[]) {
    const label = labelFor(identity, name);
    const plist = join(launchAgentsDir(ctx.home), `${label}.plist`);
    // An install made with --no-launchd and no plist on disk: launchd is not asked at all.
    if (state?.launchd === false && !existsSync(plist)) continue;
    await ld.bootout(label);
    if (existsSync(plist)) {
      if (!dryRun) rmSync(plist, { force: true });
      removed.push(plist);
    }
  }
  const appPaths = [layout.appRoot, layout.bin, layout.state, layout.lock];
  const targets = deleteData ? [layout.prefix] : appPaths;
  for (const t of targets) {
    if (!existsSync(t) && readLinkOrNull(t) === null) continue;
    removed.push(t);
    if (!dryRun) rmSync(t, { recursive: true, force: true });
  }
  return {
    code: EXIT.OK,
    dryRun,
    removed,
    launchd: ld.changes,
    kept: deleteData ? [] : [layout.config, layout.data, layout.logs, layout.backups, layout.parachuteHome].filter((d) => existsSync(d)),
  };
}

// ── run (the launchd entry) ──────────────────────────────────────────────────

export async function cmdRun(ctx: Ctx, p: Parsed): Promise<Result> {
  const which = p.positional[0];
  if (!which || !["server", "hub", "vault"].includes(which)) throw new CliError(EXIT.USAGE, "usage: prism run server|hub|vault [--foreground]");
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  const info = readBuildInfo(ctx.bundleRoot);
  if (which !== "server" && state.parachute === "stock") {
    if (which === "vault") {
      ctx.log(stockVaultMessage());
      return { code: EXIT.OK, quiet: !bool(p, "dry-run") };
    }
    const e = parseEnv(readTextOrNull(layout.envFile) ?? "");
    const r = await runStockHub({
      layout,
      bin: e.PARACHUTE_BIN || undefined,
      home: e.PARACHUTE_HOME || undefined,
      userHome: ctx.home,
      parentEnv: ctx.env,
      foreground: bool(p, "foreground"),
      dryRun: bool(p, "dry-run"),
      foreign: await foreignParachuteUnits(ctx),
      log: ctx.log,
    });
    // A dry run reports what it would start: paths and non-secret env values only.
    if (bool(p, "dry-run")) return { code: r.code, dryRun: true, command: r.command ?? null, tighten: r.modes ?? [] };
    return { code: r.code, quiet: true };
  }
  if (which !== "server") return { code: runParachutePlaceholder(which as "hub" | "vault", info, ctx.log), quiet: true };
  const code = await runServer({ layout, bundleRoot: ctx.bundleRoot, info, parachute: state.parachute, fetch: ctx.fetch, foreground: bool(p, "foreground"), log: ctx.log });
  return { code, quiet: true };
}

// ── signin ───────────────────────────────────────────────────────────────────

type LinkOutcome =
  | { ok: true; url: string; expiresAt: string; email: string; appOrigin: string; appOriginIsLocal: boolean }
  | { ok: false; code: ExitCode; message: string; retryAfter?: number };

/** Ask the running server for a one-time owner sign-in link (loopback + the host key). */
async function mintOwnerLink(ctx: Ctx, layout: Layout): Promise<LinkOutcome> {
  const envText = readTextOrNull(layout.envFile);
  const facts = envFacts(envText);
  const base = serverBase(facts.port);
  // Relative paths in .env are the server's: its working directory is config/.
  const keyFile = hostKeyFileFor(envText ? parseEnv(envText) : {}, layout.config);
  if (!keyFile) return { ok: false, code: EXIT.PRECONDITION, message: "this server keeps no host key (DB_PATH is in memory or HOST_KEY_FILE is empty)" };
  const key = readHostKey(keyFile);
  if ("problem" in key) {
    const live = (await probe(ctx.fetch, base, 1500)).live;
    return { ok: false, code: live ? EXIT.PRECONDITION : EXIT.NOT_RUNNING, message: live ? key.problem : "the server is not running (`prism start`)" };
  }
  const r = await requestLocalLink(ctx.fetch as unknown as SigninFetch, base, key.key);
  if (r.ok) return { ok: true, url: r.link.url, expiresAt: r.link.expiresAt, email: r.link.email, appOrigin: r.link.appOrigin, appOriginIsLocal: r.link.appOriginIsLocal };
  switch (r.kind) {
    case "unreachable":
      return { ok: false, code: EXIT.NOT_RUNNING, message: `the server does not answer on ${base} (prism start, prism status)` };
    case "unavailable":
      return { ok: false, code: EXIT.PRECONDITION, message: "local sign-in is off on this server (its log says why: prism logs)" };
    case "rate_limited":
      return { ok: false, code: EXIT.PRECONDITION, message: `too many sign-in links were asked for; try again in ${r.retryAfter ?? 600} s`, retryAfter: r.retryAfter };
    case "refused":
      return {
        ok: false,
        code: EXIT.PRECONDITION,
        message: r.status === 401 ? "the server did not accept the host key (another server on this port, or it restarted meanwhile: run prism signin again)" : "the server refused the request (it must be reached directly on this computer)",
      };
    default:
      return { ok: false, code: EXIT.ERROR, message: `unexpected answer from the server (HTTP ${r.status ?? "?"})` };
  }
}

/** Mint a link and hand it to the browser. Never returns or logs the link. */
export async function openOwnerSignin(ctx: Ctx, layout: Layout): Promise<{ ok: true; expiresAt: string } | { ok: false; code: ExitCode; message: string }> {
  if (!ctx.openUrl) return { ok: false, code: EXIT.PRECONDITION, message: "no browser can be opened here; on a headless Mac use prism signin --print" };
  const m = await mintOwnerLink(ctx, layout);
  if (!m.ok) return m;
  try {
    await ctx.openUrl(m.url);
  } catch (e) {
    return { ok: false, code: EXIT.ERROR, message: `the browser could not be opened (${(e as Error).message}); use prism signin --print` };
  }
  return { ok: true, expiresAt: m.expiresAt };
}

/**
 * `prism signin [--print]`: sign in as the server owner without email. Opens a one-time link
 * (single use, 10 minutes, this computer only) in the default browser; `--print` writes it to
 * stdout instead, for a headless Mac, with a warning on stderr.
 */
export async function cmdSignin(ctx: Ctx, p: Parsed): Promise<Result> {
  const layout = prefixOf(ctx, p);
  requireInstalled(layout);
  const print = bool(p, "print");
  if (bool(p, "dry-run")) return { code: EXIT.OK, dryRun: true, actions: [print ? "print a one-time owner sign-in link" : "open a one-time owner sign-in link in the browser"] };
  if (!print) {
    const r = await openOwnerSignin(ctx, layout);
    if (!r.ok) throw new CliError(r.code, r.message);
    return { code: EXIT.OK, opened: true, expiresAt: r.expiresAt, message: "A one-time sign-in link was opened in your browser. It works once, on this computer only, for 10 minutes." };
  }
  const m = await mintOwnerLink(ctx, layout);
  if (!m.ok) throw new CliError(m.code, m.message, m.retryAfter !== undefined ? { retryAfter: m.retryAfter } : undefined);
  // Headless use only: the link is a credential until it is used or expires.
  ctx.log(`prism signin: ${PRINTED_LINK_WARNING}`);
  const note = m.appOriginIsLocal ? undefined : `The link signs you in at this computer's own address. For daily use, sign in at ${m.appOrigin} with your password.`;
  if (note) ctx.log(`prism signin: ${note}`);
  return { code: EXIT.OK, url: m.url, expiresAt: m.expiresAt, ...(note ? { note } : {}) };
}

// ── reach ────────────────────────────────────────────────────────────────────

/** Restart the server after an .env change and wait for it (the `prism restart` path). */
export async function restartForEnv(ctx: Ctx, layout: Layout, state: HostState): Promise<{ ok: boolean; managed: boolean; reason?: string }> {
  if (!state.launchd) return { ok: false, managed: false };
  const bundle = currentBundle(layout);
  const info = readBuildInfo(bundle);
  // Only the server reads APP_ORIGIN: Parachute (when Prism owns it) keeps running.
  const [server] = writeAgents(ctx, layout, bundle, info, ["server"], false);
  const ld = launchdFor(ctx, false);
  try {
    if ((await ld.info(server!.label)).loaded) await ld.kickstart(server!.label, true);
    else await ld.bootstrap(server!.label, server!.path);
  } catch (e) {
    return { ok: false, managed: true, reason: (e as Error).message };
  }
  const h = await waitFor(ctx, layout, info.version);
  return h.ok ? { ok: true, managed: true } : { ok: false, managed: true, reason: h.reason };
}

export function reachDeps(ctx: Ctx, layout: Layout, state: HostState): ReachDeps {
  const port = serverPort(layout);
  const base = serverBase(port);
  return {
    env: ctx.env,
    exists: (path) => existsSync(path),
    run: ctx.runner,
    readEnv: () => readTextOrNull(layout.envFile),
    writeEnv: (text) => writeFileAtomic(layout.envFile, text, SECRET_FILE_MODE),
    restart: () => restartForEnv(ctx, layout, state),
    async record(body) {
      const envText = readTextOrNull(layout.envFile);
      const keyFile = hostKeyFileFor(envText ? parseEnv(envText) : {}, layout.config);
      if (!keyFile) return { ok: false, problem: "this server keeps no host key (DB_PATH is in memory or HOST_KEY_FILE is empty)" };
      const key = readHostKey(keyFile);
      if ("problem" in key) return { ok: false, problem: key.problem };
      const r = await requestReachRecord(ctx.fetch as unknown as SigninFetch, base, key.key, body);
      return r.ok ? r : { ...r, ...(r.status === undefined ? { problem: `the server does not answer on ${base} (prism status)` } : {}) };
    },
    async httpsGet(url, timeoutMs) {
      const r = await ctx.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      return { status: r.status, body };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: ctx.log,
  };
}

/**
 * `prism reach status|tailscale|funnel|off [--yes]`: make the server reachable from the
 * person's phone with Tailscale (cli/reach.ts has the rules and the exact commands).
 */
export async function cmdReach(ctx: Ctx, p: Parsed, deps?: ReachDeps): Promise<Result> {
  const sub = p.positional[0];
  if (!sub || !["status", "tailscale", "funnel", "off"].includes(sub)) throw new CliError(EXIT.USAGE, "usage: prism reach status|tailscale|funnel|off [--yes] [--dry-run]");
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  const d = deps ?? reachDeps(ctx, layout, state);
  const o = { dryRun: bool(p, "dry-run"), yes: bool(p, "yes"), port: serverPort(layout) };
  if (sub === "status") return reachStatus(d, o);
  const release = o.dryRun ? () => {} : acquireLock(layout.lock);
  try {
    if (sub === "off") return await reachOff(d, o);
    return await reachOn(d, o, sub === "funnel" ? "funnel" : "serve");
  } finally {
    release();
  }
}

// ── version ──────────────────────────────────────────────────────────────────

export async function cmdVersion(ctx: Ctx): Promise<Result> {
  const info = readBuildInfo(ctx.bundleRoot);
  return { code: EXIT.OK, version: info.version, commit: info.commit, builtAt: info.builtAt, node: info.node.version, parachute: info.parachute };
}

/** Load better-sqlite3 from a bundle's own node_modules. */
export function bundleSqlite(bundleRoot: string): OpenSqlite {
  const req = createRequire(join(bundleRoot, "app", "package.json"));
  const Database = req("better-sqlite3") as new (path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => import("./backup").SqliteDb;
  return (path, opts) => new Database(path, opts);
}

export function defaultCopyTree(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}

