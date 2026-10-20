/**
 * `prism` — the Prism host CLI (docs/host-bundle.md). Built into `libexec/prism.mjs` by
 * packaging/host/build.mjs and run on the Node runtime inside the bundle (`bin/prism`).
 */
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, bool } from "./args";
import { CliError, EXIT } from "./exit-codes";
import { realRunner } from "./launchd";
import { realProbes } from "./doctor";
import { bundleSqlite, cmdBackup, cmdDoctor, cmdInstall, cmdLogs, cmdRun, cmdStart, cmdStatus, cmdStop, cmdUninstall, cmdUpdate, cmdVersion, cmdSignin, cmdReach, defaultCopyTree, type Ctx, type Result } from "./commands";
import type { Fetch } from "./health";
import { openInBrowser } from "../../../apps/server/scripts/lib/local-signin-client";
import { cmdToken } from "./token";
import { cmdSetup, type StepEvent } from "./setup";

const COMMON_BOOL = ["json", "dry-run", "help"] as const;
const COMMON_VALUE = ["prefix"] as const;

const SPEC: Record<string, { bool: string[]; value: string[] }> = {
  install: { bool: ["no-launchd", "no-start", "no-signin", "skip-checks", "force"], value: ["owner-email", "app-origin", "port", "parachute", "parachute-url", "parachute-vault", "parachute-token-file", "parachute-bin", "parachute-vault-bin", "parachute-home", "parachute-hub-origin"] },
  status: { bool: [], value: [] },
  start: { bool: ["no-wait"], value: ["timeout"] },
  stop: { bool: [], value: [] },
  restart: { bool: ["no-wait"], value: ["timeout"] },
  logs: { bool: ["follow"], value: ["lines", "file"] },
  backup: { bool: [], value: ["label", "keep", "parachute-home"] },
  update: { bool: ["force", "allow-unsigned"], value: ["sums", "sig", "sha256", "timeout", "parachute-home"] },
  uninstall: { bool: ["delete-data", "yes"], value: [] },
  doctor: { bool: [], value: ["port"] },
  run: { bool: ["foreground"], value: [] },
  version: { bool: [], value: [] },
  signin: { bool: ["print"], value: [] },
  reach: { bool: ["yes"], value: [] },
  token: { bool: ["force"], value: ["expires-in"] },
  setup: { bool: ["no-launchd", "no-signin"], value: ["from", "owner-email", "port", "app-origin", "parachute", "parachute-url", "parachute-vault", "parachute-bin", "parachute-vault-bin", "parachute-hub-origin", "parachute-home", "timeout"] },
  help: { bool: [], value: [] },
};

export const HELP = `prism — install and run a Prism host on this Mac

  prism setup     [--from STEP] [--owner-email E] [--no-signin]   the whole setup, resumable (steps: docs/host-bundle.md)
  prism install   [--owner-email E] [--port N] [--parachute external|stock] [--parachute-token-file F] [--no-launchd] [--no-start] [--no-signin]
  prism signin    [--print]   sign in as the owner: opens a one-time link (this Mac only, 10 minutes)
  prism reach     status|tailscale|funnel|off [--yes]   reach Prism from a phone (Tailscale serve; Funnel = public)
  prism token     mint|rotate|status [--force] [--expires-in S]   the server's vault token, written into .env (never shown)
  prism status    process, /health?live=1, /health and the version answering
  prism start | stop | restart
  prism logs      [--lines N] [--follow] [--file server|launchd|hub|hub-launchd]
  prism backup    [--label L] [--keep N]
  prism update    <prism-host-…tar.gz> [--sums SHA256SUMS] [--sig SHA256SUMS.minisig] [--force]   (SHA256SUMS signed by the release key)
  prism uninstall [--delete-data --yes]
  prism doctor    [--port N]
  prism run       server|hub|vault [--foreground]     (what the launchd agents run; hub = stock parachute serve)
  prism version

Every command takes --prefix DIR (default ~/Library/Application Support/Prism/Host),
--json (one JSON object on stdout) and --dry-run (print what would change).
Exit codes: docs/host-bundle.md.`;

export function realCtx(): Ctx {
  // <bundle>/libexec/prism.mjs → <bundle>
  const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return {
    bundleRoot,
    home: homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    env: process.env,
    runner: realRunner,
    fetch: fetch as unknown as Fetch,
    probes: realProbes,
    openSqlite: bundleSqlite,
    copyTree: defaultCopyTree,
    now: () => new Date(),
    log: (s) => process.stderr.write(s + "\n"),
    healthTimeoutMs: 120_000,
    openUrl: openInBrowser,
  };
}

export async function dispatch(argv: string[], ctx: Ctx): Promise<{ result: Result; json: boolean; command: string }> {
  const command = argv[0] ?? "help";
  const spec = SPEC[command];
  if (!spec) throw new CliError(EXIT.USAGE, `unknown command "${command}" (prism help)`);
  const p = parseArgs(argv, { bool: [...COMMON_BOOL, ...spec.bool], value: [...COMMON_VALUE, ...spec.value] });
  const json = bool(p, "json");
  if (command === "help" || bool(p, "help")) return { result: { code: EXIT.OK, help: HELP }, json, command };
  const run: Record<string, () => Promise<Result>> = {
    install: () => cmdInstall(ctx, p),
    status: () => cmdStatus(ctx, p),
    start: () => cmdStart(ctx, p, false),
    restart: () => cmdStart(ctx, p, true),
    stop: () => cmdStop(ctx, p),
    logs: () => cmdLogs(ctx, p),
    backup: () => cmdBackup(ctx, p),
    update: () => cmdUpdate(ctx, p),
    uninstall: () => cmdUninstall(ctx, p),
    doctor: () => cmdDoctor(ctx, p),
    run: () => cmdRun(ctx, p),
    version: () => cmdVersion(ctx),
    signin: () => cmdSignin(ctx, p),
    reach: () => cmdReach(ctx, p),
    token: () => cmdToken(ctx, p),
    setup: () => cmdSetup(ctx, p),
  };
  return { result: await run[command]!(), json, command };
}

function human(command: string, r: Result): string {
  if (typeof r.help === "string") return r.help;
  if (command === "logs" && Array.isArray(r.lines)) return (r.lines as string[]).join("\n");
  // `signin --print`: the link alone on stdout (the warning went to stderr), so it can be piped.
  if (command === "signin" && typeof r.url === "string") return r.url;
  if (command === "signin" && typeof r.message === "string") return r.message;
  // `setup`: the steps were reported one by one (stderr); here only where it stands.
  if (command === "setup" && Array.isArray(r.steps)) {
    const out = [r.complete ? "Setup: every step that ran is done (or optional)." : `Setup stopped at: ${String(r.stoppedAt ?? r.resumeFrom ?? "?")}`];
    if (Array.isArray(r.pending) && r.pending.length) out.push(`waiting for the person: ${(r.pending as string[]).join(", ")}`);
    if (typeof r.next === "string") out.push(`next: ${r.next}`);
    if (r.resumeFrom) out.push(`resume: prism setup --from ${String(r.resumeFrom)}`);
    return out.join("\n");
  }
  const lines: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (k === "code" || k === "quiet") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
    } else if (v && typeof v === "object") lines.push(`${k}: ${JSON.stringify(v)}`);
    else if (v !== undefined && v !== null) lines.push(`${k}: ${String(v)}`);
  }
  return lines.join("\n");
}

const MARK: Record<string, string> = { done: "✓", skipped: "–", "needs-person": "…", failed: "✗" };

/** One line per finished step: JSON on stdout with --json (the agent reads them), else stderr. */
export function progressWriter(json: boolean, write: (stream: "stdout" | "stderr", s: string) => void): (e: Record<string, unknown>) => void {
  return (e) => {
    if (json) return write("stdout", JSON.stringify(e) + "\n");
    const ev = e as unknown as StepEvent;
    write("stderr", `${MARK[ev.state] ?? "?"} ${ev.id} — ${ev.detail ?? ev.title}${ev.state !== "done" && ev.next ? `\n    ${ev.next}` : ""}\n`);
  };
}

export async function main(argv: string[], ctx: Ctx = realCtx()): Promise<number> {
  const json = argv.includes("--json");
  const command = argv[0] ?? "help";
  if (!ctx.progress) ctx = { ...ctx, progress: progressWriter(json, (stream, s) => void process[stream].write(s)) };
  try {
    const { result } = await dispatch(argv, ctx);
    if (json) process.stdout.write(JSON.stringify({ ok: result.code === EXIT.OK, command, ...result }) + "\n");
    else if (!result.quiet) process.stdout.write(human(command, result) + "\n");
    return result.code;
  } catch (e) {
    const code = e instanceof CliError ? e.code : EXIT.ERROR;
    const message = (e as Error).message;
    if (json) process.stdout.write(JSON.stringify({ ok: false, command, code, error: message, ...(e instanceof CliError && e.detail ? { detail: e.detail } : {}) }) + "\n");
    else process.stderr.write(`prism ${command}: ${message}\n`);
    return code;
  }
}

// Run when executed (the bundled libexec/prism.mjs), not when imported by tests.
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && (entry === fileURLToPath(import.meta.url) || entry.endsWith("/libexec/prism.mjs"))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
