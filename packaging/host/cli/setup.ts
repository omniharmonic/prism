/**
 * `prism setup [--json] [--from <step>] [--dry-run]` — ONE resumable, idempotent setup run, in the
 * order of the launch plan (Phase 2, "One resumable skill run"). The `prism-setup` skill drives it:
 * the agent runs it, reads one JSON event per step, asks the person only where a step says
 * `needs-person`, and resumes with `--from <step>`.
 *
 * Every step checks before it acts: a step that is already done changes nothing, so running the
 * whole thing twice is safe, and stopping anywhere loses nothing (each step reads the machine
 * afresh; there is no run state to resume from). Step ids are `RUN_STEPS` in
 * apps/server/src/setup-steps.ts — the ids the server's checklist uses where a step exists there.
 *
 * States: `done` · `skipped` (nothing to do, or a dry run / optional) · `needs-person` (its `next`
 * is one sentence to say to the person) · `failed` (its `next` says what went wrong). A blocking
 * step that is not done stops the run; the person-facing steps after the server runs are all
 * reported in one go. Nothing a step reports is a secret: never a token, link or key.
 */
import { accessSync, constants, existsSync, readFileSync, rmdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { CliError, EXIT } from "./exit-codes";
import { bool, int, str, type Parsed } from "./args";
import { DIR_MODE, SECRET_FILE_MODE, type Layout } from "./paths";
import { acquireRunLock, ensureDir, readTextOrNull, runLockState, writeFileAtomic } from "./fsutil";
import { readBuildInfo, readState, writeState, type HostState } from "./state";
import { setKeys, updateEnv } from "./hostenv";
import { probe, serverBase } from "./health";
import { runDoctor } from "./doctor";
import { reachStatus } from "./reach";
import { cmdInstall, cmdStart, currentBundle, foreignParachuteUnits, openOwnerSignin, prefixOf, reachDeps, serverPort, startStockHubAgent, type Ctx, type Result } from "./commands";
import { adminExists, chooseParachuteHome, tightenParachuteModes, vaultExists, STOCK_HUB_ORIGIN, STOCK_VAULT_URL } from "./parachute-stock";
import { waitForParachute } from "./supervisor";
import { mintAdminToken, mintIntoEnv, parachuteCallEnv, revokeWithParachute, tokenStatus, installToken, DEFAULT_TOKEN_TTL_S, ROTATE_WITHIN_DAYS } from "./token";
import { RUN_STEPS, RUN_STEP_IDS, type RunStepDef } from "../../../apps/server/src/setup-steps";
import { parseEnv } from "../../../apps/server/scripts/lib/env-file";
import { hostKeyFileFor, readHostKey, requestSetupStatus, type LocalSetupStep, type SigninFetch } from "../../../apps/server/scripts/lib/local-signin-client";
import { loadCanonicalSchemas, seedTagSchemas, type SeedOptions, type SeedResult, type TagSchemaEntry } from "../../../apps/server/scripts/lib/seed-tag-schemas";
import { parseCliJson, runParachute } from "../../../apps/server/src/parachute-cli";

// ── the runner (pure: the steps are passed in) ───────────────────────────────

export type StepState = "done" | "skipped" | "needs-person" | "failed";

/** A command the agent may offer; `who` says who runs it. */
export interface SuggestedCommand {
  who: "agent-with-consent" | "person";
  run: string;
}

export interface StepOutcome {
  state: StepState;
  /** What was found or done (one line, no secret). */
  detail?: string;
  /** The one line for the agent to say (needs-person / failed), or a follow-up for a done step. */
  next?: string;
  /** What this run changed (names only: env keys, "started", tag names). Empty = nothing. */
  changed?: string[];
  /** Commands the agent may run (with the person's yes) or hand to the person. */
  commands?: SuggestedCommand[];
  /** The exit code a failed step ends the run with. */
  code?: number;
}

export interface StepEvent extends StepOutcome {
  event: "step";
  id: string;
  title: string;
  blocking: boolean;
  skill: string;
}

export type StepImpl<C> = (rc: C) => Promise<StepOutcome>;

export interface RunSummary {
  code: number;
  dryRun: boolean;
  steps: StepEvent[];
  /** Every step that ran is done or skipped, and no blocking step is waiting. */
  complete: boolean;
  /** The step the run stopped at (a failed step, or a blocking step waiting for the person). */
  stoppedAt: string | null;
  /** Where `--from` should start next time: the stop, else the first step still waiting. */
  resumeFrom: string | null;
  /** Steps waiting for the person (`needs-person`), in order. */
  pending: string[];
  /** The one line to say next, or null when there is nothing. */
  next: string | null;
}

export async function runSteps<C>(
  defs: readonly RunStepDef[],
  impls: Record<string, StepImpl<C>>,
  rc: C,
  o: { from?: string; dryRun: boolean; emit?: (e: StepEvent) => void },
): Promise<RunSummary> {
  let start = 0;
  if (o.from !== undefined) {
    start = defs.findIndex((d) => d.id === o.from);
    if (start < 0) throw new CliError(EXIT.USAGE, `--from: unknown step "${o.from}" (steps: ${defs.map((d) => d.id).join(", ")})`);
  }
  const steps: StepEvent[] = [];
  let stoppedAt: string | null = null;
  let code: number = EXIT.OK;
  for (const def of defs.slice(start)) {
    const impl = impls[def.id];
    let out: StepOutcome;
    try {
      out = impl ? await impl(rc) : { state: "failed", detail: `no implementation for step ${def.id}`, code: EXIT.ERROR };
    } catch (e) {
      const ce = e instanceof CliError ? e : null;
      out = { state: "failed", detail: (e as Error).message, next: (e as Error).message, code: ce?.code ?? EXIT.ERROR };
    }
    const ev: StepEvent = { event: "step", id: def.id, title: def.title, blocking: def.blocking, skill: def.skill, ...out, changed: out.changed ?? [] };
    if (ev.state !== "failed") delete ev.code;
    steps.push(ev);
    o.emit?.(ev);
    if (ev.state === "failed") {
      if (code === EXIT.OK) code = out.code ?? EXIT.ERROR;
      if (!o.dryRun) {
        stoppedAt = def.id;
        break;
      }
    }
    if (ev.state === "needs-person" && def.blocking && !o.dryRun) {
      stoppedAt = def.id;
      code = EXIT.NEEDS_PERSON;
      break;
    }
  }
  const pending = steps.filter((s) => s.state === "needs-person").map((s) => s.id);
  const resumeFrom = stoppedAt ?? pending[0] ?? null;
  const at = steps.find((s) => s.id === resumeFrom) ?? steps.find((s) => s.next && s.state !== "done");
  return {
    code,
    dryRun: o.dryRun,
    steps,
    complete: stoppedAt === null && steps.every((s) => s.state !== "failed" && !(s.blocking && s.state === "needs-person")),
    stoppedAt,
    resumeFrom,
    pending,
    next: at?.next ?? null,
  };
}

// ── the real steps ───────────────────────────────────────────────────────────

/** The stock Parachute v1 measured against (launch plan §3.6). */
export const STOCK_PARACHUTE = { hub: "0.7.19", vault: "0.7.9" } as const;

/** Where the Mac client is published (`PRISM_CLIENT_DOWNLOAD_URL` overrides; owner decision). */
export const DEFAULT_CLIENT_DOWNLOAD_URL = "https://github.com/omniharmonic/prism/releases/latest";
export const CLIENT_APP_NAME = "Prism Client.app";

export interface SetupDeps {
  seed(opts: SeedOptions): Promise<SeedResult>;
  /** The canonical tag schemas: from the installed bundle, else the source tree. */
  loadSchemas(layout: Layout): Record<string, TagSchemaEntry>;
}

/** Fields the seed left out because another tag declares them with another type (names only). */
export function schemaClashes(r: SeedResult): string {
  const c = r.conflicts ?? [];
  if (!c.length) return "";
  const shown = c.slice(0, 6).map((x) => `${x.tag}.${x.field} (${x.wanted.type ?? "?"}; ${x.with} has ${x.declared.type ?? "?"})`);
  return `; ${c.length} field declaration${c.length === 1 ? "" : "s"} left out because another tag declares the same name with another type: ${shown.join(", ")}${c.length > 6 ? ", …" : ""}`;
}

export const realSetupDeps: SetupDeps = {
  seed: seedTagSchemas,
  loadSchemas(layout) {
    const inBundle = join(currentBundle(layout), "app", "packages", "core", "src", "lib", "schemas", "tag-schemas.json");
    if (existsSync(inBundle)) return (JSON.parse(readFileSync(inBundle, "utf8")) as { tags: Record<string, TagSchemaEntry> }).tags;
    return loadCanonicalSchemas();
  },
};

export interface SetupRc {
  ctx: Ctx;
  p: Parsed;
  layout: Layout;
  deps: SetupDeps;
  dryRun: boolean;
  /** `.env` changed during this run and the server has not been restarted since. */
  envChanged: boolean;
}

const installed = (rc: SetupRc): HostState | null => {
  const s = readState(rc.layout);
  return s?.current ? s : null;
};
const envText = (rc: SetupRc) => readTextOrNull(rc.layout.envFile);
const envOf = (rc: SetupRc) => parseEnv(envText(rc) ?? "");
const appOrigin = (rc: SetupRc) => envOf(rc).APP_ORIGIN || `http://localhost:${serverPort(rc.layout)}`;
const NOT_YET: StepOutcome = { state: "skipped", detail: "dry run: comes after the install" };

function writeEnv(rc: SetupRc, text: string) {
  writeFileAtomic(rc.layout.envFile, text, SECRET_FILE_MODE);
  rc.envChanged = true;
}

async function serverLive(rc: SetupRc) {
  return probe(rc.ctx.fetch, serverBase(serverPort(rc.layout)), 1500);
}

/** The server's checklist, through the host key (`POST /auth/local/setup`). */
async function checklist(rc: SetupRc): Promise<{ ok: true; steps: LocalSetupStep[] } | { ok: false; why: string }> {
  const text = envText(rc);
  const keyFile = hostKeyFileFor(text ? parseEnv(text) : {}, rc.layout.config);
  if (!keyFile) return { ok: false, why: "this server keeps no host key" };
  const key = readHostKey(keyFile);
  if ("problem" in key) return { ok: false, why: key.problem };
  const r = await requestSetupStatus(rc.ctx.fetch as unknown as SigninFetch, serverBase(serverPort(rc.layout)), key.key);
  if (r.ok) return { ok: true, steps: r.steps };
  return { ok: false, why: r.status === 404 ? "this server is older than `prism setup` (no /auth/local/setup)" : r.status ? `the server answered HTTP ${r.status}` : "the server does not answer" };
}

function parsedFor(command: string, rc: SetupRc, flags: Record<string, string | boolean>): Parsed {
  return { command, positional: [], flags: { prefix: rc.layout.prefix, ...flags } };
}

/** An executable on disk: an absolute path, or a name looked up on PATH, then `~/.bun/bin`. */
export function findExecutable(name: string, explicit: Array<string | undefined>, env: NodeJS.ProcessEnv, home: string): string | null {
  const ok = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  for (const e of explicit) {
    if (!e) continue;
    if (isAbsolute(e)) {
      if (ok(e)) return e;
      continue;
    }
    for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && isAbsolute(dir) && ok(join(dir, e))) return join(dir, e);
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && isAbsolute(dir) && ok(join(dir, name))) return join(dir, name);
  const bun = join(home, ".bun", "bin", name);
  return ok(bun) ? bun : null;
}

/**
 * Installing stock Parachute (the agent, with the person's yes). No `parachute init`: it installs
 * Parachute's own launchd unit and has no flag to skip it — Prism runs the hub itself instead.
 */
export function stockParachuteCommands(): SuggestedCommand[] {
  return [
    { who: "agent-with-consent", run: "curl -fsSL https://bun.sh/install | bash" },
    { who: "agent-with-consent", run: `~/.bun/bin/bun add -g @openparachute/hub@${STOCK_PARACHUTE.hub} @openparachute/vault@${STOCK_PARACHUTE.vault}` },
  ];
}

/** Single-quote for a POSIX shell (a command the person pastes into Terminal). */
export function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The person's one Parachute step in stock mode: create the hub's admin, in Terminal (it asks for
 * the password twice). The stock CLI is a bun script (`#!/usr/bin/env bun`), and on a fresh Mac
 * bun's installer does NOT put `~/.bun/bin` on PATH (it only edits an existing `~/.zshrc`, which a
 * new account does not have) — so the command carries the CLI's folder on PATH itself (clean-VM
 * finding: without it the person got `env: bun: No such file or directory`).
 */
export function setPasswordCommand(bin: string, home: string): SuggestedCommand {
  const dir = isAbsolute(bin) ? dirname(bin) : null;
  const path = dir ? `PATH=${shq(dir)}:"$PATH" ` : "";
  return { who: "person", run: `${path}PARACHUTE_HOME=${shq(home)} ${shq(bin)} auth set-password` };
}

function stockMissing(url: string): StepOutcome {
  return {
    state: "needs-person",
    detail: `no Parachute here: no \`parachute\` / \`parachute-vault\` command and nothing answers at ${url}`,
    next: "Parachute (the vault Prism keeps your notes in) is not installed. Ask the person whether you may install it (bun and Parachute, the pinned versions); with their yes run the two install commands, then run prism setup --from vault. Prism then runs Parachute itself under its own launchd agent; do not run `parachute init` (it would install Parachute's own launchd unit).",
    commands: stockParachuteCommands(),
  };
}

/** Explicit paths (launch plan §3.5): the server and later CLI calls never depend on PATH. */
function recordBins(rc: SetupRc, env: Record<string, string>, o: { hub: string | null; vaultBin: string | null; flagBin?: string; url: string; note?: string }): StepOutcome {
  const add: Array<[string, string]> = [];
  if (o.hub && !env.PARACHUTE_BIN) add.push(["PARACHUTE_BIN", o.hub]);
  if (o.vaultBin && !env.PARACHUTE_VAULT_BIN) add.push(["PARACHUTE_VAULT_BIN", o.vaultBin]);
  if (o.flagBin && o.hub && env.PARACHUTE_BIN && env.PARACHUTE_BIN !== o.hub) add.push(["PARACHUTE_BIN", o.hub]);
  if (add.length && !rc.dryRun) writeEnv(rc, setKeys(envText(rc) ?? "", add));
  return {
    state: "done",
    detail: `the vault answers at ${o.url}${o.note ? ` (${o.note})` : ""}${o.hub ? `; Parachute CLI ${o.hub}` : "; no Parachute CLI found (only needed to mint tokens)"}`,
    changed: rc.dryRun ? [] : add.map(([k]) => k),
    ...(o.hub ? {} : { next: "No `parachute` command was found: minting a vault token needs it (pass --parachute-bin <path>)." }),
  };
}

/**
 * Stock Parachute run by Prism (launch plan §3.4 fallback; cli/parachute-stock.ts): choose the
 * home (never moving existing data) → `parachute-vault create` (no mirror) when the vault does not
 * exist → tighten the known file modes → record the paths in .env and `stock` in state.json → the
 * person creates the hub's admin (`auth set-password`, Terminal) → Prism's hub agent → wait for the
 * hub's /api/ready and the vault's /health. Each part checks first, so a re-run changes nothing.
 */
async function ensureStock(rc: SetupRc, state: HostState, o: { hub: string; vaultBin: string; vaultName: string; url: string }): Promise<StepOutcome> {
  const env = envOf(rc);
  const { home, reason } = chooseParachuteHome({ configured: str(rc.p, "parachute-home") ?? (env.PARACHUTE_HOME || undefined), userHome: rc.ctx.home, layout: rc.layout });
  const where = `${home} (${reason === "existing" ? "your existing Parachute data, left where it is" : reason === "prism-owned" ? "inside the Prism install" : "as configured"})`;
  const needVault = !vaultExists(home, o.vaultName);
  const needAdmin = !adminExists(home);
  const keys: Array<[string, string]> = [];
  if (env.PARACHUTE_BIN !== o.hub) keys.push(["PARACHUTE_BIN", o.hub]);
  if (env.PARACHUTE_VAULT_BIN !== o.vaultBin) keys.push(["PARACHUTE_VAULT_BIN", o.vaultBin]);
  if (env.PARACHUTE_HOME !== home) keys.push(["PARACHUTE_HOME", home]);
  if (rc.dryRun) {
    const plan = [
      `Prism runs stock Parachute with PARACHUTE_HOME ${where}`,
      ...(needVault ? [`create the vault "${o.vaultName}" (parachute-vault create --no-mirror)`] : []),
      ...(needAdmin ? ["the person creates Parachute's admin (auth set-password, in Terminal)"] : []),
      ...(state.launchd ? ["load Prism's hub agent (parachute serve, loopback, ports 1939/1940)"] : []),
    ];
    return { state: "skipped", detail: `dry run: would ${plan.join("; ")}` };
  }

  const changed: string[] = [];
  if (!existsSync(home)) {
    ensureDir(home, DIR_MODE);
    changed.push("parachute-home");
  }
  if (needVault) {
    const { parentEnv, config } = parachuteCallEnv(rc.ctx.env, envText(rc));
    try {
      await runParachute("vault", ["create", o.vaultName, "--no-mirror", "--json"], { parentEnv: { ...parentEnv, PARACHUTE_HOME: home }, config: { ...config, bin: o.hub, vaultBin: o.vaultBin, home } });
    } catch (e) {
      return { state: "failed", code: EXIT.PRECONDITION, detail: (e as Error).message, next: `Creating the vault "${o.vaultName}" failed (parachute-vault create): ${(e as Error).message}` };
    }
    if (!vaultExists(home, o.vaultName)) return { state: "failed", code: EXIT.PRECONDITION, detail: `parachute-vault create ran but ${home}/vault/data/${o.vaultName} is not there`, next: "The vault was not created where Prism expected it; look at the command's output by running it once by hand with PARACHUTE_HOME set." };
    changed.push("vault-created");
  }
  if (tightenParachuteModes(home).length) changed.push("parachute-file-modes");
  if (keys.length) {
    writeEnv(rc, setKeys(envText(rc) ?? "", keys));
    changed.push(...keys.map(([k]) => k));
  }
  if (state.parachute !== "stock") {
    state.parachute = "stock";
    state.updatedAt = rc.ctx.now().toISOString();
    writeState(rc.layout, state);
    changed.push("parachute-mode:stock");
  }
  if (needAdmin) {
    return {
      state: "needs-person",
      changed,
      detail: `stock Parachute at ${where}; no admin account yet`,
      next: "Parachute needs an admin account before Prism starts it. The person runs the command below in Terminal: it asks for a password twice (they type it there, never in this conversation), then asks to confirm creating the admin \"owner\" (they answer y). Then run prism setup --from vault.",
      commands: [setPasswordCommand(o.hub, home)],
    };
  }

  const ready = () => waitForParachute("stock", { hub: STOCK_HUB_ORIGIN, vault: o.url }, { fetch: rc.ctx.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() }, { embeddedMs: 0, externalMs: 0 });
  if (!state.launchd) {
    if ((await ready()).ready) return { state: "done", changed, detail: `stock Parachute answers (hub ${STOCK_HUB_ORIGIN}, vault ${o.url}); PARACHUTE_HOME ${where}` };
    return { state: "needs-person", changed, next: "This install runs without launchd: start Parachute with `prism run hub --foreground` in a Terminal (keep it open), then run prism setup --from vault." };
  }
  if ((await ready()).ready) return { state: "done", changed, detail: `stock Parachute runs under Prism's hub agent (hub ${STOCK_HUB_ORIGIN}, vault ${o.url}); PARACHUTE_HOME ${where}` };
  try {
    await startStockHubAgent(rc.ctx, rc.layout, { dryRun: false, restart: false });
  } catch (e) {
    return { state: "failed", code: EXIT.ERROR, changed, detail: (e as Error).message, next: `Prism's hub agent could not be loaded: ${(e as Error).message}` };
  }
  changed.push("hub-agent");
  const waited = await waitForParachute("stock", { hub: STOCK_HUB_ORIGIN, vault: o.url }, { fetch: rc.ctx.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() }, { embeddedMs: rc.ctx.healthTimeoutMs, externalMs: 0 });
  if (!waited.ready) {
    return { state: "failed", code: EXIT.DEGRADED, changed, detail: `the hub agent is loaded but Parachute did not become ready within ${Math.round(rc.ctx.healthTimeoutMs / 1000)} s`, next: "Prism started Parachute but its hub (/api/ready) or vault (/health) did not answer: prism logs --file hub --lines 50 says why." };
  }
  return { state: "done", changed, detail: `stock Parachute started under Prism's hub agent (hub ${STOCK_HUB_ORIGIN}, vault ${o.url}); PARACHUTE_HOME ${where}` };
}

const steps: Record<string, StepImpl<SetupRc>> = {
  async machine(rc) {
    const state = readState(rc.layout);
    const port = int(rc.p, "port", 1024, 65535) ?? serverPort(rc.layout);
    const live = state ? (await serverLive(rc)).live : false;
    const checks = await runDoctor(rc.ctx.probes, { ports: live ? [] : [port], prefix: rc.layout.prefix });
    const failed = checks.filter((c) => !c.ok && c.fatal);
    if (failed.length) {
      const why = failed.map((c) => c.detail).join("; ");
      return { state: "failed", code: EXIT.PRECONDITION, detail: why, next: `This Mac cannot host Prism: ${why}.` };
    }
    return { state: "done", detail: checks.map((c) => c.detail).join("; ") };
  },

  async install(rc) {
    const state = installed(rc);
    if (state) return { state: "done", detail: `Prism ${state.current} is installed at ${rc.layout.prefix}` };
    const email = str(rc.p, "owner-email");
    if (!email) {
      return {
        state: "needs-person",
        next: "Ask the person which email address their owner account should use (it is their sign-in name, not a secret), then run prism setup --owner-email <email> --from install.",
      };
    }
    const flags: Record<string, string | boolean> = { "owner-email": email, "no-start": true, "no-signin": true, "skip-checks": true };
    for (const k of ["port", "app-origin", "parachute", "parachute-url", "parachute-vault", "parachute-bin", "parachute-vault-bin", "parachute-hub-origin", "parachute-home"]) {
      const v = str(rc.p, k);
      if (v !== undefined) flags[k] = v;
    }
    if (bool(rc.p, "no-launchd")) flags["no-launchd"] = true;
    if (rc.dryRun) flags["dry-run"] = true;
    const r = await cmdInstall(rc.ctx, parsedFor("install", rc, flags));
    if (rc.dryRun) return { state: "skipped", detail: `dry run: would install Prism at ${rc.layout.prefix} (${((r.actions as string[]) ?? []).length} actions)` };
    if (r.code !== EXIT.OK) return { state: "failed", code: r.code, detail: String(r.message ?? "install failed"), next: String(r.message ?? "The install did not finish: prism status --json says more.") };
    rc.envChanged = false; // nothing runs yet; the server step starts it with this .env
    return { state: "done", detail: `installed Prism ${String(r.version)} at ${rc.layout.prefix}`, changed: ["installed"] };
  },

  async vault(rc) {
    const state = installed(rc);
    if (!state) return NOT_YET;
    const env = envOf(rc);
    const url = (env.PARACHUTE_URL || "http://127.0.0.1:1940").replace(/\/+$/, "");
    const vaultName = env.PARACHUTE_VAULT || "default";
    const info = readBuildInfo(currentBundle(rc.layout));

    if (state.parachute === "embedded" && info.parachute.bundled) {
      // Prism owns Parachute: its bootstrap (launch plan E4) is idempotent and writes nothing to stdout we keep.
      if (rc.dryRun) return { state: "skipped", detail: "dry run: would run the bundled Parachute's bootstrap (embedded mode)" };
      const { parentEnv, config } = parachuteCallEnv(rc.ctx.env, envText(rc));
      const bin = join(currentBundle(rc.layout), "parachute", "bin", "parachute");
      try {
        const { stdout } = await runParachute("hub", ["bootstrap", "--embedded", "--json"], { parentEnv: { ...parentEnv, PARACHUTE_HOME: env.PARACHUTE_HOME || rc.layout.parachuteHome }, config: { ...config, bin, home: env.PARACHUTE_HOME || rc.layout.parachuteHome } });
        const j = parseCliJson<{ created?: unknown }>(stdout);
        return { state: "done", detail: j?.created === true ? "the bundled Parachute was bootstrapped" : "the bundled Parachute was already bootstrapped", changed: j?.created === true ? ["parachute-bootstrap"] : [] };
      } catch (e) {
        return { state: "failed", code: EXIT.PRECONDITION, detail: (e as Error).message, next: "The bundled Parachute could not be bootstrapped (`parachute bootstrap --embedded`); prism logs and the message above say why." };
      }
    }

    const answers = (u: string) =>
      rc.ctx
        .fetch(u, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.status === 200)
        .catch(() => false);
    const vaultUp = await answers(`${url}/health`);
    const flagBin = str(rc.p, "parachute-bin");
    const flagVaultBin = str(rc.p, "parachute-vault-bin");
    const hub = findExecutable("parachute", [flagBin, env.PARACHUTE_BIN, rc.ctx.env.PARACHUTE_BIN], rc.ctx.env, rc.ctx.home);
    const vaultBin = findExecutable("parachute-vault", [flagVaultBin, env.PARACHUTE_VAULT_BIN, rc.ctx.env.PARACHUTE_VAULT_BIN], rc.ctx.env, rc.ctx.home);
    // Parachute's OWN launchd units (read-only `launchctl print` + the plist): when they are here,
    // Parachute runs itself and Prism reuses it — never a second hub.
    const theirs = await foreignParachuteUnits(rc.ctx);
    const theirLabels = theirs.map((u) => u.label).join(", ");

    if (state.parachute === "stock") {
      if (theirs.length) {
        return {
          state: "failed",
          code: EXIT.PRECONDITION,
          detail: `Prism's hub agent and Parachute's own launchd unit (${theirLabels}) are both installed`,
          next: `Two Parachute hubs would fight over port 1939: Prism runs one (stock mode) and Parachute's own unit ${theirLabels} is installed too. Ask the person which to keep. To keep Prism's, the person removes Parachute's unit (launchctl bootout gui/${rc.ctx.uid}/${theirs[0]!.label}, then moves its plist out of ~/Library/LaunchAgents); then run prism setup --from vault.`,
          commands: theirs.map((u) => ({ who: "person" as const, run: `launchctl bootout gui/${rc.ctx.uid}/${u.label}` })),
        };
      }
      if (!hub || !vaultBin) return stockMissing(url);
      return ensureStock(rc, state, { hub, vaultBin, vaultName, url });
    }

    const hubUp = !vaultUp && !theirs.length ? await answers(`${STOCK_HUB_ORIGIN}/health`) : false;
    if (theirs.length || vaultUp || hubUp) {
      // Reuse what runs: Parachute's own unit, or a Parachute someone else started.
      const who = theirs.length ? `Parachute's own launchd unit (${theirLabels}) runs it; Prism reuses it and installs no hub of its own` : "Prism did not start it; it is reused as it is";
      if (!vaultUp) {
        return {
          state: "needs-person",
          detail: `${who}, but its vault does not answer at ${url}`,
          next: theirs.length
            ? `Parachute's own launchd unit is installed but its vault does not answer at ${url}. The person restarts it (launchctl kickstart -k gui/${rc.ctx.uid}/${theirs[0]!.label}) or looks at Parachute's log; then run prism setup --from vault.`
            : `A Parachute hub answers on port 1939 but its vault does not answer at ${url}; Prism will not start a second hub. The person starts or stops that Parachute; then run prism setup --from vault.`,
          ...(theirs.length ? { commands: [{ who: "person" as const, run: `launchctl kickstart -k gui/${rc.ctx.uid}/${theirs[0]!.label}` }] } : {}),
        };
      }
      return recordBins(rc, env, { hub, vaultBin, flagBin, url, note: who });
    }

    // Nothing runs and Parachute has no unit of its own: Prism runs stock Parachute itself.
    if (!hub || !vaultBin) return stockMissing(url);
    if (url !== STOCK_VAULT_URL || str(rc.p, "parachute") === "external") {
      return {
        state: "needs-person",
        detail: `Parachute is installed (${hub}) but its vault does not answer at ${url}`,
        next: `Parachute is installed but nothing answers at ${url}. Prism runs stock Parachute itself only at the default address (${STOCK_VAULT_URL}); start the Parachute at ${url} (or set PARACHUTE_URL back to the default), then run prism setup --from vault.`,
      };
    }
    return ensureStock(rc, state, { hub, vaultBin, vaultName, url });
  },

  async secrets(rc) {
    if (!installed(rc)) return NOT_YET;
    const text = envText(rc) ?? "";
    // Adds only what is missing; an existing SECRETS_KEY / GOVERNANCE_SIGNING_SECRET is never replaced.
    const u = updateEnv(rc.layout, text, {});
    if (u.added.length === 0) return { state: "done", detail: "every server secret is set (SECRETS_KEY included)" };
    if (rc.dryRun) return { state: "skipped", detail: `dry run: would add ${u.added.join(", ")}` };
    writeEnv(rc, u.text);
    return { state: "done", detail: `added ${u.added.join(", ")} (nothing existing was replaced)`, changed: u.added };
  },

  async "vault-token"(rc) {
    const state = installed(rc);
    if (!state) return NOT_YET;
    const s = await tokenStatus(rc.ctx, rc.layout);
    if (s.fine) {
      const days = s.token?.expiresInDays;
      return {
        state: "done",
        detail: `${s.token?.scope ?? "a vault token"}${s.token?.exp ? `, expires ${s.token.exp.slice(0, 10)}` : ""}${s.vault === "unreachable" ? " (not checked: the vault does not answer)" : ""}`,
        ...(days !== null && days !== undefined && days < ROTATE_WITHIN_DAYS ? { next: "The vault token expires soon: run prism token rotate." } : {}),
      };
    }
    if (rc.dryRun) return { state: "skipped", detail: `dry run: would mint a vault write token into ${rc.layout.envFile}${s.set ? " (the current one does not work)" : ""}` };
    const prev = installToken(rc.layout);
    try {
      const out = await mintIntoEnv(rc.ctx, rc.layout, state, { ttlSeconds: DEFAULT_TOKEN_TTL_S, requireVerified: false });
      if (out.previous?.jti && out.previous.jti !== out.minted.jti) await revokeWithParachute(rc.ctx, prev.envText, out.previous.jti).catch(() => {});
      rc.envChanged = !(out.restart.ran && out.restart.ok);
      return {
        state: "done",
        detail: `minted ${out.minted.scope ?? "a write token"} (jti ${out.minted.jti ?? "?"}, expires ${out.minted.exp?.slice(0, 10) ?? "?"}) into .env${out.verdict === "unreachable" ? "; not checked (the vault does not answer)" : ""}`,
        changed: ["PARACHUTE_TOKEN"],
      };
    } catch (e) {
      const ce = e instanceof CliError ? e : null;
      return { state: "failed", code: ce?.code ?? EXIT.ERROR, detail: (e as Error).message, next: (e as Error).message };
    }
  },

  async schemas(rc) {
    if (!installed(rc)) return NOT_YET;
    const t = installToken(rc.layout);
    if (!t.token) return rc.dryRun ? { state: "skipped", detail: "dry run: after the vault token" } : { state: "failed", code: EXIT.PRECONDITION, detail: "no vault token", next: "No vault token is set: run prism setup --from vault-token." };
    const schemas = rc.deps.loadSchemas(rc.layout);
    const base = { vaultUrl: t.parachuteUrl, vault: t.vault, token: t.token, schemas };
    let plan: SeedResult;
    try {
      plan = await rc.deps.seed({ ...base, dryRun: true });
    } catch (e) {
      return { state: "failed", code: EXIT.ERROR, detail: (e as Error).message, next: `The vault's tag schemas could not be read: ${(e as Error).message}` };
    }
    const todo = [...plan.created, ...plan.updated];
    if (todo.length === 0) return { state: "done", detail: `all ${Object.keys(schemas).length} tag schemas are in the vault${schemaClashes(plan)}` };
    if (rc.dryRun) return { state: "skipped", detail: `dry run: would add ${plan.created.length} and update ${plan.updated.length} tag schemas` };
    let admin: string;
    try {
      admin = await mintAdminToken(rc.ctx, rc.layout);
    } catch (e) {
      return { state: "failed", code: EXIT.PRECONDITION, detail: (e as Error).message, next: `Seeding the tag schemas needs a short-lived admin token from the Parachute CLI, and minting it failed: ${(e as Error).message}` };
    }
    try {
      const r = await rc.deps.seed({ ...base, adminToken: admin, dryRun: false });
      return { state: "done", detail: `tag schemas: ${r.created.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged${schemaClashes(r)}`, changed: [...r.created, ...r.updated] };
    } catch (e) {
      return { state: "failed", code: EXIT.ERROR, detail: (e as Error).message, next: (e as Error).message };
    }
  },

  async server(rc) {
    const state = installed(rc);
    if (!state) return NOT_YET;
    const pr = await serverLive(rc);
    const version = readBuildInfo(currentBundle(rc.layout)).version;
    if (!state.launchd) {
      if (pr.live) return { state: "done", detail: `running (not under launchd), version ${pr.version ?? "?"}`, ...(rc.envChanged ? { next: "The .env changed: restart the server (prism run server) so it reads it." } : {}) };
      return { state: "needs-person", next: "This install runs without launchd: start the server with `prism run server --foreground` in a Terminal, then run prism setup --from server." };
    }
    if (pr.live && pr.version === version && !rc.envChanged) return { state: "done", detail: `running, version ${version}${pr.vault === false ? " (it cannot reach the vault)" : ""}` };
    if (rc.dryRun) return { state: "skipped", detail: `dry run: would ${pr.live ? "restart" : "start"} the server` };
    const timeout = int(rc.p, "timeout", 1, 3600);
    const r: Result = await cmdStart(rc.ctx, parsedFor("start", rc, timeout ? { timeout: String(timeout) } : {}), pr.live);
    if (r.code === EXIT.OK) {
      rc.envChanged = false;
      return { state: "done", detail: `${pr.live ? "restarted" : "started"}; version ${version} answers`, changed: [pr.live ? "restarted" : "started"] };
    }
    const why = String(r.message ?? (r.health as { reason?: string } | undefined)?.reason ?? "not healthy");
    return { state: "failed", code: r.code, detail: why, next: `The server did not become healthy (${why}): prism logs --lines 50 says why.` };
  },

  async owner(rc) {
    if (!installed(rc)) return NOT_YET;
    if (!(await serverLive(rc)).live) return rc.dryRun ? { state: "skipped", detail: "dry run: after the server starts" } : { state: "needs-person", next: "The server is not running, so the owner cannot sign in yet: run prism setup --from server." };
    const cl = await checklist(rc);
    const step = cl.ok ? cl.steps.find((s) => s.id === "owner") : undefined;
    if (step?.done) return { state: "done", detail: "the owner has a password" };
    if (rc.dryRun || bool(rc.p, "no-signin")) return { state: "needs-person", ...(cl.ok ? {} : { detail: `checklist not readable: ${cl.why}` }), next: "The owner signs in on this Mac with `prism signin` and sets a password; then run prism setup --from owner." };
    const opened = await openOwnerSignin(rc.ctx, rc.layout);
    if (opened.ok) {
      return {
        state: "needs-person",
        detail: `a one-time sign-in link was opened in the browser (valid until ${opened.expiresAt})`,
        changed: ["signin-link-opened"],
        next: "A one-time sign-in link just opened in the browser on this Mac. Ask the person to sign in there and set a password; then run prism setup --from owner.",
      };
    }
    return { state: "needs-person", detail: opened.message, next: `Ask the person to run \`prism signin\` on this Mac and set a password (${opened.message}); then run prism setup --from owner.` };
  },

  async "mac-client"(rc) {
    if (!installed(rc)) return NOT_YET;
    const dirs = (rc.ctx.env.PRISM_APPLICATIONS_DIRS ?? `/Applications${delimiter}${join(rc.ctx.home, "Applications")}`).split(delimiter).filter(Boolean);
    const at = dirs.map((d) => join(d, CLIENT_APP_NAME)).find((p) => existsSync(p));
    if (at) return { state: "done", detail: `${at} is installed; sign in there to ${appOrigin(rc)}` };
    const url = rc.ctx.env.PRISM_CLIENT_DOWNLOAD_URL || DEFAULT_CLIENT_DOWNLOAD_URL;
    return { state: "needs-person", next: `Prism Client (the Mac app) is not installed: the person downloads it from ${url}, moves it to Applications, opens it and enters this server's address, ${appOrigin(rc)}.` };
  },

  async device(rc) {
    if (!installed(rc)) return NOT_YET;
    const cl = (await serverLive(rc)).live ? await checklist(rc) : null;
    const step = cl?.ok ? cl.steps.find((s) => s.id === "device") : undefined;
    if (step?.done) return { state: "done", detail: "an app is signed in to this server" };
    return {
      state: "needs-person",
      ...(step?.detail ? { detail: step.detail } : {}),
      next: "To add a phone: the person installs Prism on it, then follows the device step of the checklist (Workspace settings → Server on this Mac), which shows how to pair it. A phone needs the https address from the reachable step.",
    };
  },

  async reachable(rc) {
    const state = installed(rc);
    if (!state) return NOT_YET;
    const cl = (await serverLive(rc)).live ? await checklist(rc) : null;
    const step = cl?.ok ? cl.steps.find((s) => s.id === "reachable") : undefined;
    if (step?.done) return { state: "done", detail: `reachable at ${appOrigin(rc)}` };
    const r = await reachStatus(reachDeps(rc.ctx, rc.layout, state), { dryRun: true, yes: false, port: serverPort(rc.layout) });
    const next = typeof r.next === "string" ? r.next : step?.detail ?? "Run prism reach status to see what is missing.";
    return { state: "needs-person", ...(step?.detail ? { detail: step.detail } : {}), next };
  },

  async integrations(rc) {
    if (!installed(rc)) return NOT_YET;
    const cl = (await serverLive(rc)).live ? await checklist(rc) : null;
    const connected = cl?.ok ? cl.steps.filter((s) => (s.id.startsWith("integration:") || s.id === "email") && s.done).map((s) => s.id) : [];
    const next = "Optional: ask the person whether to connect mail, calendar, messages or meeting transcripts; each is entered in the app (Workspace settings → Server → Connections), never in this chat.";
    return connected.length ? { state: "done", detail: `connected: ${connected.join(", ")}`, next } : { state: "skipped", detail: "none connected (optional)", next };
  },
};

export const SETUP_STEP_IMPLS = steps;

/**
 * The `vault` step on its own, for `prism install` over kept data (cmdInstall): the same code as
 * `prism setup --from vault`, so stock Parachute's hub agent is restored (or a running Parachute
 * reused) exactly the way setup would — never a second implementation. `p` is install's parsed
 * command line (the step reads --parachute-bin / --parachute-vault-bin / --parachute-home).
 */
export async function runVaultStep(ctx: Ctx, p: Parsed, layout: Layout): Promise<StepOutcome> {
  return steps.vault!({ ctx, p, layout, deps: realSetupDeps, dryRun: false, envChanged: false });
}

/** `prism setup [--from STEP] [--owner-email E] [--no-signin] [--dry-run] [--json]`. */
/**
 * `prism setup [--from STEP] [--owner-email E] [--no-signin] [--dry-run] [--json]`.
 *
 * One run at a time per install: a run-wide lock (`<prefix>/.setup.lock`, {pid, startedAt,
 * command}) is taken first. Held by a live process → refused, exit 4, the holder in `detail.lock`.
 * Left by a process that is gone → taken over (`lock.tookOver`). Released when the run ends, and
 * on process exit. A dry run takes no lock and reports where it stands (`lock.state`).
 */
export async function cmdSetup(ctx: Ctx, p: Parsed, deps: SetupDeps = realSetupDeps): Promise<Result> {
  const layout = prefixOf(ctx, p);
  const rc: SetupRc = { ctx, p, layout, deps, dryRun: bool(p, "dry-run"), envChanged: false };
  let lock: Record<string, unknown>;
  let release = () => {};
  if (rc.dryRun) {
    const st = runLockState(layout.setupLock);
    lock = st.state === "held" ? { state: "held", path: st.path, ...st.holder } : { state: st.state, path: st.path };
  } else {
    // The lock lives in the install folder; a first run creates that folder for it (and removes it
    // again if the run wrote nothing else into it).
    const madePrefix = !existsSync(layout.prefix);
    if (madePrefix) ensureDir(layout.prefix, DIR_MODE);
    let l: ReturnType<typeof acquireRunLock>;
    try {
      l = acquireRunLock(layout.setupLock, { command: "prism setup", now: ctx.now() });
    } catch (e) {
      if (madePrefix) rmdirQuiet(layout.prefix);
      throw e;
    }
    lock = { state: "held-by-this-run", path: layout.setupLock, pid: l.info.pid, startedAt: l.info.startedAt, ...(l.tookOver ? { tookOver: l.tookOver } : {}) };
    release = () => {
      l.release();
      if (madePrefix) rmdirQuiet(layout.prefix);
    };
  }
  try {
    const summary = await runSteps(RUN_STEPS, steps, rc, { from: str(p, "from"), dryRun: rc.dryRun, emit: ctx.progress ? (e) => ctx.progress!(e as unknown as Record<string, unknown>) : undefined });
    return { ...summary, prefix: layout.prefix, stepIds: RUN_STEP_IDS, lock };
  } finally {
    release();
  }
}

/** Remove a folder only if it is empty. */
function rmdirQuiet(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    /* not empty, or gone */
  }
}
