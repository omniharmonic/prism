/**
 * Server-side agent executor (Phase 3 — server-first runtime; hardened in
 * Architecture v2 WP0.1). Ports the desktop's `claude -p` dispatch to Node so an
 * owner/admin can trigger agent skills from the web/mobile app, with no Mac
 * desktop running — the server is colocated with the vault + the `claude` CLI.
 *
 * Security model (this spawns a host process from an HTTP request, so it is
 * deliberately constrained — every layer below is asserted by unit tests and by
 * scripts/verify-agent-exec.ts against the CLI's own `system/init` event):
 *   - ADMIN-gated at the route (owner/admin session only — never capability/anon).
 *   - FIXED argv template — the client supplies a prompt + optional skill/note,
 *     never a command line. No shell; args are passed as an array.
 *   - NO built-in host tools: `--tools ""` removes Read/Write/Edit/Bash/Glob/Grep/
 *     WebFetch/WebSearch/Task/… entirely; `--allowedTools mcp__parachute-vault` +
 *     `--permission-mode dontAsk` auto-approves ONLY the vault MCP and denies
 *     anything else (no --dangerously-skip-permissions).
 *   - `--strict-mcp-config`: the ONLY MCP server is the per-dispatch temp config
 *     (0600 file in a 0700 mkdtemp dir, deleted when the run ends) holding the
 *     TARGET vault's scoped token — user-scope servers in ~/.claude.json (other
 *     vaults, third-party connectors) and the repo .mcp.json never load.
 *   - `--setting-sources ""` + a fixed EMPTY cwd (~/.prism/agent-cwd, 0700): no
 *     user/project settings, hooks, CLAUDE.md, or repo context reach the run.
 *   - a secret-free env ALLOWLIST (HOME/USER/LOGNAME/LANG/TMPDIR/… + a fixed
 *     PATH): the server's PARACHUTE_TOKEN/SESSION_SECRET/… are never inherited.
 *     HOME is what the CLI needs to find its subscription login.
 *   - `--no-session-persistence`: a one-shot dispatch leaves no transcript on disk.
 *
 * Capacity: a global semaphore (`AGENT_MAX_CONCURRENT`, default 1) plus a memory
 * admission check (free < `AGENT_FREE_MIN_PCT`%; macOS also absolute free swap < `AGENT_SWAP_MIN_FREE_MB`; other OS swap used > 80%, or `AGENT_SWAP_MAX_PCT` if set)
 * — excess or memory-refused dispatches wait in status "queued" with a
 * `queuedReason`, and are retried every `AGENT_ADMISSION_RETRY_MS`. They never
 * fail for capacity reasons (only a full queue, `AGENT_MAX_QUEUE`, is refused).
 *
 * The spawner, memory probe, cwd, and limits are injectable
 * (`configureAgentRunner`) so orchestration is unit-tested without the real CLI.
 */
import { spawn as realSpawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { freemem, homedir, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { VaultEntry } from "./config";

export type DispatchStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface Dispatch {
  id: string;
  vaultId: string;
  skill: string | null;
  noteId: string | null;
  status: DispatchStatus;
  /** Why a queued dispatch has not started yet (slot wait / memory pressure). */
  queuedReason: string | null;
  output: string;
  error: string | null;
  /** When the dispatch was ACCEPTED (queued). */
  startedAt: number;
  /** When the process was actually spawned (null while queued). */
  runStartedAt: number | null;
  endedAt: number | null;
}

/** What subscribers (the SSE route) receive: output DELTAS, and status changes. */
export type DispatchEvent =
  | { type: "output"; text: string }
  | { type: "status"; dispatch: Dispatch };

/** A minimal child-process shape so a fake spawner can stand in for node's. */
export interface SpawnedProc {
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  on(ev: "exit", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: string): void;
  /** OS pid (node children expose it; fakes may omit it). */
  pid?: number;
}
export type Spawner = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedProc;

// Default spawner: real claude, with stdin CLOSED (`-p` takes the prompt from
// argv; leaving stdin open makes claude wait ~3s for piped input first).
const defaultSpawner: Spawner = (cmd, args, opts) =>
  realSpawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }) as unknown as SpawnedProc;

const DISPATCH_TIMEOUT_MS = 30 * 60 * 1000; // 30 min wall clock, matches the desktop
const KILL_GRACE_MS = 10_000; // SIGKILL if a SIGTERM'd child hasn't exited
export const DEFAULT_MAX_BUDGET_USD = 1;
const MAX_OUTPUT = 2_000_000; // cap captured output so a runaway can't OOM the server

/** The MCP server name in the per-dispatch config. Tools surface to the model as
 *  `mcp__parachute-vault__<tool>`; the allowlist is the server-level rule. */
export const VAULT_MCP_NAME = "parachute-vault";
export const VAULT_MCP_ALLOW = `mcp__${VAULT_MCP_NAME}`;
/** The Prism-MCP server name (prism-* profiles, WP3.4): the server's OWN /mcp. */
export const PRISM_MCP_NAME = "prism";
export const PRISM_MCP_ALLOW = `mcp__${PRISM_MCP_NAME}`;
/** Which MCP server a run's allowlist may name. One server per run, never both. */
export type McpServerKind = "vault" | "prism";

// ── public: argv + MCP config (pure, unit-testable) ──────────────────────────

export type OutputFormat = "text" | "stream-json";
export interface ArgOptions {
  /** Server-internal only (the route never sets it): verify-agent-exec uses
   *  stream-json to read the CLI's `system/init` tool list. */
  outputFormat?: OutputFormat;
  /** Optional per-run spend cap (`AGENT_MAX_BUDGET_USD`). */
  maxBudgetUsd?: number | null;
  /** Durable session turn (WP3.1): `resume=false` → `--session-id <id>` (turn 1),
   *  `resume=true` → `--resume <id>`. Absent → one-shot `--no-session-persistence`.
   *  The id is ALWAYS a server-minted uuid (validated), never client text. */
  session?: { id: string; resume: boolean } | null;
  /** stream-json only: `--include-partial-messages` (live text deltas). */
  includePartial?: boolean;
  /** Tool allowlist (default: the whole vault MCP server). Every entry must be
   *  the vault server or one of its tools — anything else is refused. */
  allowedTools?: readonly string[];
  /** Which server the allowlist is for (default "vault"). "prism" = the server's
   *  own /mcp (prism-* profiles); entries must then be that server's tools. */
  server?: McpServerKind;
  /** `--model` alias (default "sonnet"). Allowlisted: never free text. */
  model?: ClaudeModel;
  /** A text-only run: NO tool is allowed (no `--allowedTools` at all). The caller
   *  also hands it an MCP config with no server (`NO_MCP_CONFIG`). */
  textOnly?: boolean;
}

/** The MCP config of a text-only run: no server at all (still `--strict-mcp-config`,
 *  so nothing from the user's or a repo's config loads either). */
export const NO_MCP_CONFIG = { mcpServers: {} } as const;

/** The claude model aliases a routing choice may name. */
export const CLAUDE_MODELS = ["sonnet", "opus", "haiku"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export const isClaudeModel = (m: unknown): m is ClaudeModel => typeof m === "string" && (CLAUDE_MODELS as readonly string[]).includes(m);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VAULT_TOOL_RE = new RegExp(`^${VAULT_MCP_ALLOW}(__[a-z][a-z0-9-]*)?$`);
const PRISM_TOOL_RE = new RegExp(`^${PRISM_MCP_ALLOW}(__[a-z][a-z0-9_]*)?$`);

/** The fixed claude argv. The prompt is the LAST arg after `--`; everything else
 *  is a constant template — the client never injects flags. */
export function buildClaudeArgs(prompt: string, mcpConfigPath: string, opts: ArgOptions = {}): string[] {
  const fmt = opts.outputFormat ?? "text";
  const server = opts.server ?? "vault";
  const allowed = opts.allowedTools ?? [server === "prism" ? PRISM_MCP_ALLOW : VAULT_MCP_ALLOW];
  const toolRe = server === "prism" ? PRISM_TOOL_RE : VAULT_TOOL_RE;
  if (opts.textOnly && opts.allowedTools !== undefined) throw new Error("a text-only run takes no tool allowlist");
  if (!opts.textOnly && (allowed.length === 0 || allowed.some((t) => !toolRe.test(t)))) {
    throw new Error(`allowedTools may only name the ${server} MCP server or its tools`);
  }
  if (opts.session && !UUID_RE.test(opts.session.id)) throw new Error("session id must be a uuid");
  if (opts.model !== undefined && !isClaudeModel(opts.model)) throw new Error("model must be one of sonnet, opus, haiku");
  const persistence = opts.session
    ? opts.session.resume
      ? ["--resume", opts.session.id]
      : ["--session-id", opts.session.id]
    : ["--no-session-persistence"];
  const args = [
    "-p",
    "--model",
    opts.model ?? "sonnet",
    "--output-format",
    fmt,
    ...(fmt === "stream-json" ? ["--verbose"] : []),
    ...(fmt === "stream-json" && opts.includePartial ? ["--include-partial-messages"] : []),
    ...persistence,
    // ONLY the per-dispatch vault MCP — ignore ~/.claude.json + repo .mcp.json servers.
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    // No built-in tools at all (no Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/Task).
    "--tools",
    "",
    // Auto-approve exactly the vault MCP; dontAsk denies everything else; nobody is prompted.
    // (A comma-joined list is one argv element — verified against CLI 2.1.x.)
    // (A text-only run allows nothing: with no MCP server and no built-in tools there is
    // no tool to name, and dontAsk denies whatever else might appear.)
    ...(opts.textOnly ? [] : ["--allowedTools", allowed.join(",")]),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    // No user/project/local settings (hooks, plugins, CLAUDE.md-bearing sources).
    "--setting-sources",
    "",
  ];
  if (opts.maxBudgetUsd != null && Number.isFinite(opts.maxBudgetUsd) && opts.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  args.push("--", prompt);
  return args;
}

/** The per-vault MCP config JSON. Points claude at THIS vault's scoped MCP with
 *  its own token, so the agent acts only on the tenant the dispatch is for. */
export function vaultMcpConfig(entry: VaultEntry): object {
  return {
    mcpServers: {
      [VAULT_MCP_NAME]: {
        type: "http",
        url: `${entry.url}/vault/${entry.vault}/mcp`,
        headers: { Authorization: `Bearer ${entry.token}` },
      },
    },
  };
}

/** The data-access preamble prepended to every dispatch (a server-side analog of
 *  the desktop PRISM_CONTEXT). Keeps the agent scoped to vault operations. */
export function buildPrompt(prompt: string, skill: string | null, noteId: string | null): string {
  const rules = [
    "You are Prism's background agent, operating ONLY on the user's Parachute vault",
    "via the parachute-vault MCP tools (query-notes, create-note, update-note, …).",
    "You have NO host file, shell, or web access. Do the requested task against the vault",
    "and report concisely what you did.",
  ].join(" ");
  const ctx = [skill ? `Skill: ${skill}.` : "", noteId ? `Active note: ${noteId}.` : ""].filter(Boolean).join(" ");
  return `${rules}\n\n${ctx}\n\n${prompt}`.trim();
}

// ── claude binary + env + cwd resolution ─────────────────────────────────────

/** Pure resolver: PATH lookup first, then the known install locations. The native
 *  installer puts the CLI at ~/.local/bin/claude (the npm-global path is legacy). */
export function resolveClaudeWith(which: () => string | null, exists: (p: string) => boolean, home: string): string {
  const onPath = which();
  if (onPath) return onPath;
  for (const p of [join(home, ".local/bin/claude"), join(home, ".npm-global/bin/claude")]) {
    if (exists(p)) return p;
  }
  return "claude"; // last resort: let spawn's PATH lookup try
}

let cachedClaude: string | null = null;
export function resolveClaude(): string {
  if (cachedClaude) return cachedClaude;
  cachedClaude = resolveClaudeWith(
    () => {
      try {
        return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null;
      } catch {
        return null;
      }
    },
    existsSync,
    homedir(),
  );
  return cachedClaude;
}

/** Non-secret variables the CLI may need. HOME is the load-bearing one (it locates
 *  ~/.claude.json and the subscription login); the locale/user/tmp vars keep the
 *  CLI's own behaviour sane. NOTHING else from the server env is passed. */
export const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"] as const;

/** The secret-free child env: allowlisted vars only, a FIXED PATH (so a hostile
 *  PATH entry can't shadow binaries), and the CLI's stream idle timeout. */
export function dispatchEnv(src: NodeJS.ProcessEnv = process.env, claudePath = resolveClaude()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) if (typeof src[k] === "string" && src[k]) env[k] = src[k];
  const home = env.HOME ?? homedir();
  env.HOME = home;
  const dirs = [
    claudePath.includes("/") ? dirname(claudePath) : null,
    join(home, ".local/bin"),
    join(home, ".npm-global/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((d): d is string => !!d);
  env.PATH = [...new Set(dirs)].join(":");
  env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = "300000";
  env.DISABLE_AUTOUPDATER = "1"; // a web-triggered run must never self-update the CLI
  // Auto-memory would read/write ~/.claude/projects/<cwd-slug>/memory/ — a context
  // source OUTSIDE the (checked-empty) cwd. Off (verified: init.memory_paths null).
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

/** The default fixed cwd for every run. */
export function defaultAgentCwd(): string {
  return process.env.AGENT_CWD?.trim() || join(homedir(), ".prism/agent-cwd");
}

/** Create the cwd lazily (0700) and REFUSE to run from a non-empty one: a file
 *  planted there (e.g. a CLAUDE.md) must never become agent context. */
export function ensureAgentCwd(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const entries = readdirSync(dir);
  if (entries.length > 0) throw new Error(`agent cwd ${dir} is not empty (${entries.length} entries) — refusing to run`);
  return dir;
}

/** Where the CLI persists a session transcript (WP3.1 finding, verified against
 *  CLI 2.1.x): NOT in the cwd — the cwd stays empty — but in
 *  `$HOME/.claude/projects/<slug>/<sessionId>.jsonl`, where <slug> is the
 *  realpath of the cwd with every non-alphanumeric char replaced by `-`. That is
 *  also why `--resume` needs the SAME cwd on every turn. The file holds raw tool
 *  results (vault content), so archiving a session deletes it. */
export function cliSessionFile(cwd: string, sessionId: string, home: string = homedir()): string {
  if (!isUuid(sessionId)) throw new Error("cli session id must be a uuid");
  return join(cliProjectDir(cwd, home), `${sessionId}.jsonl`);
}

/** The CLI's per-session SIDECAR dir (`<slug>/<id>/` — tool-results etc.). */
export function cliSessionSidecar(cwd: string, sessionId: string, home: string = homedir()): string {
  if (!isUuid(sessionId)) throw new Error("cli session id must be a uuid");
  return join(cliProjectDir(cwd, home), sessionId);
}

/** The CLI's per-cwd project dir: `$HOME/.claude/projects/<slug>`. */
export function cliProjectDir(cwd: string, home: string = homedir()): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* not created yet — the slug of the literal path */
  }
  return join(home, ".claude/projects", real.replace(/[^a-zA-Z0-9]/g, "-"));
}

export const isUuid = (s: string): boolean => UUID_RE.test(s);

// ── memory admission (injectable probe) ──────────────────────────────────────

export interface MemorySample {
  /** Swap used as % of total swap (null = no swap configured / unknown). */
  swapUsedPct: number | null;
  /** System free-memory % (null = unknown). */
  freePct: number | null;
  /** macOS only: absolute free swap in MB (null/undefined = unknown or no swap file).
   *  Its presence marks a darwin sample: swap is judged by absolute free MB, NOT
   *  by % of total (macOS grows swap on demand, so % used is meaningless there). */
  swapFreeMb?: number | null;
  /** macOS only: `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical). */
  pressureLevel?: number | null;
  /** macOS only: free MB on the swap volume (/System/Volumes/VM). macOS adds swap
   *  files on demand, so low free swap only matters when the disk can't grow it. */
  swapDiskFreeMb?: number | null;
}
export type MemoryProbe = () => MemorySample | null;

/** Parse `sysctl -n vm.swapusage` ("total = 4096.00M  used = 2597.50M  free = …"). */
export function parseSwapUsage(s: string): number | null {
  const unit = (n: string, u: string) => Number(n) * ({ K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[u.toUpperCase()] ?? 1);
  const t = /total\s*=\s*([\d.]+)([KMGT])/i.exec(s);
  const u = /used\s*=\s*([\d.]+)([KMGT])/i.exec(s);
  if (!t || !u) return null;
  const total = unit(t[1]!, t[2]!);
  if (!(total > 0)) return null; // no swap configured → not a pressure signal
  return (unit(u[1]!, u[2]!) / total) * 100;
}

/** Parse free swap in MB from `sysctl -n vm.swapusage` (null if unparseable / no swap). */
export function parseSwapFreeMb(s: string): number | null {
  const f = /free\s*=\s*([\d.]+)([KMGT])/i.exec(s);
  if (!f) return null;
  return Number(f[1]) * ({ K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[f[2]!.toUpperCase()] ?? 1);
}

/** Parse `memory_pressure -Q` ("System-wide memory free percentage: 63%"). */
export function parseMemoryPressure(s: string): number | null {
  const m = /free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(s);
  return m ? Number(m[1]) : null;
}

/** Parse Linux /proc/meminfo into a sample (MemAvailable-based free %). */
export function parseMeminfo(s: string): MemorySample {
  const kb = (k: string) => {
    const m = new RegExp(`^${k}:\\s*(\\d+)`, "m").exec(s);
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal");
  const avail = kb("MemAvailable");
  const swapTotal = kb("SwapTotal");
  const swapFree = kb("SwapFree");
  return {
    freePct: total && avail != null ? (avail / total) * 100 : null,
    swapUsedPct: swapTotal && swapFree != null ? ((swapTotal - swapFree) / swapTotal) * 100 : null,
  };
}

/** Real probe. macOS: sysctl vm.swapusage + memory_pressure -Q (os.freemem() is
 *  useless on macOS — it excludes reclaimable cache and always reads "low").
 *  Linux: /proc/meminfo. Returns null if nothing could be read. */
export const defaultMemoryProbe: MemoryProbe = () => {
  const run = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  if (process.platform === "darwin") {
    const swap = run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]);
    const mp = run("/usr/bin/memory_pressure", ["-Q"]);
    const lvl = run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    let swapDiskFreeMb: number | null = null;
    try {
      const st = statfsSync("/System/Volumes/VM");
      swapDiskFreeMb = (Number(st.bavail) * Number(st.bsize)) / (1024 * 1024);
    } catch {
      swapDiskFreeMb = null;
    }
    const level = lvl != null && /^\s*\d+\s*$/.test(lvl) ? Number(lvl) : null;
    const sample: MemorySample = {
      swapUsedPct: swap ? parseSwapUsage(swap) : null,
      freePct: mp ? parseMemoryPressure(mp) : null,
      swapFreeMb: swap ? parseSwapFreeMb(swap) : null,
      pressureLevel: level,
      swapDiskFreeMb,
    };
    return sample.swapUsedPct == null && sample.freePct == null ? null : sample;
  }
  if (process.platform === "linux") {
    try {
      return parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
    } catch {
      return null;
    }
  }
  const t = totalmem();
  return { swapUsedPct: null, freePct: t > 0 ? (freemem() / t) * 100 : null };
};

export interface AdmissionVerdict {
  ok: boolean;
  reason: string | null;
  sample: MemorySample | null;
}

/** Default absolute free-swap floor (MB) for darwin samples. */
export const DEFAULT_SWAP_MIN_FREE_MB = 512;
/** darwin: free MB the swap volume must keep before low free swap counts (macOS
 *  grows swap files on demand; it can only "exhaust" when this disk is nearly full). */
export const DARWIN_SWAP_DISK_MIN_FREE_MB = 4096;
/** Default swap-used % ceiling, applied to non-darwin samples only (unless set explicitly). */
export const DEFAULT_SWAP_MAX_PCT = 80;

/** Decide admission from a sample. An unreadable probe ADMITS (fail-open) — a
 *  broken probe must not wedge the agent forever; the concurrency cap still holds.
 *
 *  darwin sample (has `swapFreeMb` field): memory_pressure free% is the primary
 *  signal, plus an ABSOLUTE free-swap floor (`swapMinFreeMb`). Swap-used % is
 *  ignored unless `swapMaxPct` is a number (explicit AGENT_SWAP_MAX_PCT opt-in).
 *  Other platforms: swap-used % vs `swapMaxPct` (null → 80) plus free%. */
export function admissionVerdict(
  sample: MemorySample | null,
  swapMaxPct: number | null,
  freeMinPct: number,
  swapMinFreeMb: number = DEFAULT_SWAP_MIN_FREE_MB,
  /** darwin: refuse at or above this kernel pressure level (2 = warn, 4 = critical).
   *  Admission uses 2; a run already in flight with its model resident uses 4 —
   *  a 7 GB model on a 16 GB host sits at "warn" while it infers. */
  refuseAtLevel: number = 2,
): AdmissionVerdict {
  if (!sample) return { ok: true, reason: null, sample };
  const darwin = sample.swapFreeMb !== undefined;
  if (sample.freePct != null && sample.freePct < freeMinPct) {
    return { ok: false, reason: `memory pressure: ${sample.freePct.toFixed(0)}% free (< ${freeMinPct}%)`, sample };
  }
  if (darwin && sample.pressureLevel != null && sample.pressureLevel >= refuseAtLevel) {
    return { ok: false, reason: `memory pressure: kernel level ${sample.pressureLevel >= 4 ? "critical" : "warn"}`, sample };
  }
  // Low free swap on macOS is only a signal when the swap volume can't grow it
  // (2026-10-01: 466 MB "free" of a 6 GB swap with 159 GB of disk free and 73% free
  // memory stopped classify — a false alarm). Unknown disk free keeps the old rule.
  const swapCanGrow = darwin && sample.swapDiskFreeMb != null && sample.swapDiskFreeMb >= DARWIN_SWAP_DISK_MIN_FREE_MB;
  if (darwin && !swapCanGrow && sample.swapFreeMb != null && sample.swapFreeMb < swapMinFreeMb) {
    return { ok: false, reason: `swap nearly exhausted: ${sample.swapFreeMb.toFixed(0)} MB free (< ${swapMinFreeMb} MB)`, sample };
  }
  const pctLimit = swapMaxPct ?? (darwin ? null : DEFAULT_SWAP_MAX_PCT);
  if (pctLimit != null && sample.swapUsedPct != null && sample.swapUsedPct > pctLimit) {
    return { ok: false, reason: `memory pressure: swap ${sample.swapUsedPct.toFixed(0)}% used (> ${pctLimit}%)`, sample };
  }
  return { ok: true, reason: null, sample };
}

// ── runner config ─────────────────────────────────────────────────────────────

const num = (v: string | undefined, d: number) => {
  const n = v == null || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Explicit-only numeric env: unset/blank/garbage → null. */
export const optNum = (v: string | undefined): number | null => {
  const n = v == null || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface RunnerConfig {
  spawner: Spawner;
  memoryProbe: MemoryProbe;
  /** Resolves (and prepares) the run's cwd. Default: ensureAgentCwd(~/.prism/agent-cwd). */
  cwd: () => string;
  claudePath: () => string;
  maxConcurrent: number;
  maxQueue: number;
  /** null = AGENT_SWAP_MAX_PCT unset (darwin: no % guard; linux: 80). */
  swapMaxPct: number | null;
  swapMinFreeMb: number;
  freeMinPct: number;
  admissionRetryMs: number;
  timeoutMs: number;
  maxBudgetUsd: number | null;
}

function defaultConfig(): RunnerConfig {
  // Default 1.00 USD per turn/process; set AGENT_MAX_BUDGET_USD=0 to disable.
  const budget = num(process.env.AGENT_MAX_BUDGET_USD, DEFAULT_MAX_BUDGET_USD);
  return {
    spawner: defaultSpawner,
    memoryProbe: defaultMemoryProbe,
    cwd: () => ensureAgentCwd(defaultAgentCwd()),
    claudePath: resolveClaude,
    maxConcurrent: Math.max(1, Math.floor(num(process.env.AGENT_MAX_CONCURRENT, 1))),
    maxQueue: Math.max(0, Math.floor(num(process.env.AGENT_MAX_QUEUE, 20))),
    swapMaxPct: optNum(process.env.AGENT_SWAP_MAX_PCT),
    swapMinFreeMb: num(process.env.AGENT_SWAP_MIN_FREE_MB, DEFAULT_SWAP_MIN_FREE_MB),
    freeMinPct: num(process.env.AGENT_FREE_MIN_PCT, 15),
    admissionRetryMs: Math.max(250, num(process.env.AGENT_ADMISSION_RETRY_MS, 15_000)),
    timeoutMs: DISPATCH_TIMEOUT_MS,
    maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
  };
}

let cfg: RunnerConfig = defaultConfig();

/** Override runner settings (tests; a future settings UI). Unspecified keys keep
 *  their current value. */
export function configureAgentRunner(partial: Partial<RunnerConfig>): void {
  cfg = { ...cfg, ...partial };
}


/** The runner's fixed cwd as currently configured (prepared lazily). Falls back
 *  to the default path if preparing it throws (e.g. it is non-empty) — callers
 *  only need the PATH (to locate the CLI's per-cwd session store). */
export function runnerCwdPath(): string {
  try {
    return cfg.cwd();
  } catch {
    return defaultAgentCwd();
  }
}

/** The runner's current per-run spend cap (callers building argv read it). */
export function runnerBudgetUsd(): number | null {
  return cfg.maxBudgetUsd;
}

// ── generic run queue (shared by one-shot dispatches and session turns) ─────
//
// ONE semaphore + memory-admission queue for every `claude` process this server
// spawns: a one-shot dispatch and a session turn compete for the same slots, so
// the concurrency cap and the memory guard hold across both.

export interface RunEndInfo {
  /** Process exit code (null: killed / never spawned). */
  code: number | null;
  /** Spawn failure, process error, timeout, or non-zero exit (null on success / cancel). */
  error: string | null;
  /** The run was cancelled via its handle (queued or running). */
  cancelled: boolean;
}

export interface RunSpec {
  entry: VaultEntry;
  /** Override the per-run MCP config (default: the vault MCP for `entry`). Called
   *  at SPAWN time, so a credential minted inside is never created for a run that
   *  is cancelled while queued. */
  mcpConfig?: () => object;
  /** Build the argv, given the per-run 0600 MCP config path. */
  args: (mcpConfigPath: string) => string[];
  spawner?: Spawner;
  /** The run is waiting (called when the reason changes). */
  onQueued?: (reason: string) => void;
  /** A slot + memory admitted the run; called just BEFORE spawning. */
  onStart?: () => void;
  /** The child was spawned (pid when the spawner exposes one). */
  onSpawned?: (pid: number | null) => void;
  onData?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Called exactly once, whatever happens (including a queued cancel). */
  onEnd: (info: RunEndInfo) => void;
}

export interface RunHandle {
  readonly id: string;
  state(): "queued" | "running" | "ended";
  /** Cancel a queued (dropped) or running (SIGTERM, SIGKILL after grace) run. */
  cancel(): boolean;
}

interface Run {
  id: string;
  spec: RunSpec;
  state: "queued" | "running" | "ended";
  reason: string | null;
  child: SpawnedProc | null;
  cancelled: boolean;
  timedOut: boolean;
  finish: ((info: RunEndInfo) => void) | null;
}

const queue: Run[] = [];
let running = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastAdmission: AdmissionVerdict | null = null;
let generation = 0; // bumped by _resetDispatches so a stale child can't touch new state

/** Thrown when the waiting queue is full (the routes map it to 503). */
export class AgentBusyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AgentBusyError";
  }
}

/** Accept a run. It starts now (slot free + memory admitted) or waits queued.
 *  Throws AgentBusyError only when the waiting queue is full. */
export function enqueueRun(spec: RunSpec): RunHandle {
  // Only a run that could start right now (empty queue + free slot) bypasses the
  // bound — so memory-refused runs can't grow the queue without limit.
  const startsNow = queue.length === 0 && running < cfg.maxConcurrent;
  if (!startsNow && queue.length >= cfg.maxQueue) {
    throw new AgentBusyError(`agent queue full (${queue.length} waiting)`);
  }
  const run: Run = {
    id: randomUUID(),
    spec,
    state: "queued",
    reason: null,
    child: null,
    cancelled: false,
    timedOut: false,
    finish: null,
  };
  queue.push(run);
  pump();
  return {
    id: run.id,
    state: () => run.state,
    cancel: () => cancelRun(run),
  };
}

function cancelRun(run: Run): boolean {
  if (run.state === "ended") return false;
  run.cancelled = true;
  if (run.state === "queued") {
    const i = queue.indexOf(run);
    if (i >= 0) queue.splice(i, 1);
    run.state = "ended";
    safe(() => run.spec.onEnd({ code: null, error: null, cancelled: true }));
    return true;
  }
  const child = run.child;
  if (!child) {
    run.finish?.({ code: null, error: null, cancelled: true });
    return true;
  }
  child.kill("SIGTERM");
  // The slot is released on exit; if SIGTERM is ignored, force it.
  if ((run.state as Run["state"]) !== "ended") {
    setTimeout(() => run.state !== "ended" && child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }
  return true;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`[agent] run callback threw: ${(e as Error).message}`);
  }
}

function setReason(run: Run, reason: string): void {
  if (run.reason === reason) return;
  run.reason = reason;
  safe(() => run.spec.onQueued?.(reason));
}

/** Start as many queued runs as slots + memory allow; otherwise record why each
 *  waits and (for memory refusals) schedule a re-check. */
function pump(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  while (queue.length > 0 && running < cfg.maxConcurrent) {
    let sample: MemorySample | null = null;
    try {
      sample = cfg.memoryProbe();
    } catch {
      sample = null; // a throwing probe is "unknown" → fail-open
    }
    const verdict = admissionVerdict(sample, cfg.swapMaxPct, cfg.freeMinPct, cfg.swapMinFreeMb);
    lastAdmission = verdict;
    if (!verdict.ok) {
      for (const r of queue) setReason(r, verdict.reason!);
      retryTimer = setTimeout(pump, cfg.admissionRetryMs);
      retryTimer.unref();
      return;
    }
    launch(queue.shift()!);
  }
  for (const r of queue) setReason(r, `waiting for a free agent slot (${running}/${cfg.maxConcurrent} running)`);
}

function launch(run: Run): void {
  const { spec } = run;
  running++;
  run.state = "running";
  run.reason = null;
  const gen = generation;
  let mcpDir: string | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const finish = (info: RunEndInfo) => {
    if (run.state === "ended") return;
    run.state = "ended";
    if (timeout) clearTimeout(timeout);
    if (mcpDir) {
      try {
        rmSync(mcpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    safe(() => spec.onEnd(info));
    if (gen !== generation) return;
    running--;
    pump();
  };
  run.finish = finish;

  safe(() => spec.onStart?.());
  // onStart may have cancelled the run (e.g. its owner went away) — never spawn then.
  if ((run.state as Run["state"]) === "ended") return;

  let child: SpawnedProc;
  try {
    const cwd = cfg.cwd();
    // 0700 dir from mkdtemp + 0600 file: only this server user can read the token.
    mcpDir = mkdtempSync(join(tmpdir(), "prism-agent-"));
    const mcpPath = join(mcpDir, "mcp.json");
    writeFileSync(mcpPath, JSON.stringify(spec.mcpConfig ? spec.mcpConfig() : vaultMcpConfig(spec.entry)), { mode: 0o600 });
    const claude = cfg.claudePath();
    const args = spec.args(mcpPath);
    child = (spec.spawner ?? cfg.spawner)(claude, args, { cwd, env: dispatchEnv(process.env, claude) });
  } catch (e) {
    finish({ code: null, error: `failed to spawn claude: ${(e as Error).message}`, cancelled: run.cancelled });
    return;
  }
  run.child = child;
  safe(() => spec.onSpawned?.(typeof child.pid === "number" ? child.pid : null));

  child.stdout?.on("data", (c) => spec.onData?.(c.toString(), "stdout"));
  child.stderr?.on("data", (c) => spec.onData?.(c.toString(), "stderr"));

  timeout = setTimeout(() => {
    if (run.state !== "running") return;
    run.timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => run.state !== "ended" && child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, cfg.timeoutMs);
  timeout.unref(); // never keep the process alive just for a pending run timeout

  child.on("error", (err) => {
    finish({ code: null, error: err.message, cancelled: run.cancelled });
  });
  child.on("exit", (code) => {
    const error = run.cancelled
      ? null
      : run.timedOut
        ? "timed out after 30m"
        : code === 0
          ? null
          : `claude exited ${code}`;
    finish({ code, error, cancelled: run.cancelled });
  });
}

/** Runner snapshot for the status endpoint (no run contents). */
export function runnerStatus(): {
  running: number;
  queued: number;
  maxConcurrent: number;
  maxQueue: number;
  admission: AdmissionVerdict | null;
} {
  return { running, queued: queue.length, maxConcurrent: cfg.maxConcurrent, maxQueue: cfg.maxQueue, admission: lastAdmission };
}

// ── one-shot dispatches (the /api/agent/dispatch alias + the skill scheduler) ─

export interface DispatchOptions {
  /** Per-dispatch spawner override (else the runner's). */
  spawner?: Spawner;
  /** Server-internal (never from the route): see ArgOptions.outputFormat. */
  outputFormat?: OutputFormat;
  /** Server-internal: restrict the run to these vault tools (the `skill` profile).
   *  Default: the whole vault MCP server (legacy one-shot behaviour). */
  allowedTools?: readonly string[];
  /** Server-internal: the `--model` alias (interactive routing, parity A). */
  model?: ClaudeModel;
  /** A text-only run (`profile: "text"`): no MCP server, no tools, the prompt exactly
   *  as given (no vault preamble, no note id). */
  textOnly?: boolean;
}

const dispatches = new Map<string, Dispatch>();
const handles = new Map<string, RunHandle>();
type Listener = (ev: DispatchEvent) => void;
const listeners = new Map<string, Set<Listener>>();

function fire(id: string, ev: DispatchEvent): void {
  for (const cb of [...(listeners.get(id) ?? [])]) cb(ev);
}
function emitStatus(d: Dispatch): void {
  fire(d.id, { type: "status", dispatch: d });
}

export function getDispatch(id: string): Dispatch | null {
  return dispatches.get(id) ?? null;
}
/** Recent dispatches for a vault (newest first), capped. */
export function listDispatches(vaultId: string, limit = 50): Dispatch[] {
  return [...dispatches.values()]
    .filter((d) => d.vaultId === vaultId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}
/** Subscribe to a dispatch's events (output deltas + status changes, for SSE).
 *  Returns an unsubscribe fn. */
export function subscribe(id: string, cb: Listener): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
}

export function cancelDispatch(id: string): boolean {
  const d = dispatches.get(id);
  const h = handles.get(id);
  if (!d || !h) return false;
  if (d.status !== "queued" && d.status !== "running") return false;
  // Mark first so the run's onEnd (sync for a queued/fake child) is a no-op.
  d.status = "cancelled";
  d.queuedReason = null;
  d.endedAt = Date.now();
  emitStatus(d);
  h.cancel();
  return true;
}

/** Accept a dispatch for `entry`'s vault. Returns immediately with status
 *  "running" (a slot was free and memory admitted) or "queued" (it will start
 *  when both allow). Throws AgentBusyError only when the waiting queue is full. */
export function startDispatch(
  entry: VaultEntry,
  req: { prompt: string; skill?: string | null; noteId?: string | null },
  opts: DispatchOptions = {},
): Dispatch {
  const d: Dispatch = {
    id: randomUUID(),
    vaultId: entry.id,
    skill: req.skill ?? null,
    noteId: req.noteId ?? null,
    status: "queued",
    queuedReason: null,
    output: "",
    error: null,
    startedAt: Date.now(),
    runStartedAt: null,
    endedAt: null,
  };
  const prompt = opts.textOnly ? req.prompt : buildPrompt(req.prompt, d.skill, d.noteId);
  dispatches.set(d.id, d);
  let h: RunHandle;
  try {
    h = enqueueRun({
      entry,
      spawner: opts.spawner,
      ...(opts.textOnly ? { mcpConfig: () => NO_MCP_CONFIG } : {}),
      args: (mcpPath) => buildClaudeArgs(prompt, mcpPath, { outputFormat: opts.outputFormat, maxBudgetUsd: cfg.maxBudgetUsd, allowedTools: opts.textOnly ? undefined : opts.allowedTools, model: opts.model, textOnly: opts.textOnly }),
      onQueued: (reason) => {
        if (d.status !== "queued") return;
        d.queuedReason = reason;
        emitStatus(d);
      },
      onStart: () => {
        d.status = "running";
        d.queuedReason = null;
        d.runStartedAt = Date.now();
        emitStatus(d);
      },
      onData: (text) => {
        if (d.output.length >= MAX_OUTPUT) return;
        d.output += text;
        fire(d.id, { type: "output", text });
      },
      onEnd: ({ code, error }) => {
        if (d.status !== "running") return; // cancelled (already marked)
        d.status = code === 0 && !error ? "done" : "error";
        if (d.status === "error") d.error = error ?? `claude exited ${code}`;
        d.endedAt = Date.now();
        emitStatus(d);
      },
    });
  } catch (e) {
    dispatches.delete(d.id);
    throw e;
  }
  handles.set(d.id, h);
  return d;
}

/**
 * A one-shot dispatch that is NOT a claude process (parity A: an interactive
 * skill routed to the local model). It lives in the same registry, so
 * `GET /dispatches/:id`, the SSE stream and `/cancel` work unchanged; `run`
 * gets an AbortSignal that `cancelDispatch` fires. It never takes a claude run
 * slot (the local path has its own admission guard).
 */
export function startExternalDispatch(
  entry: VaultEntry,
  req: { skill?: string | null; noteId?: string | null },
  run: (signal: AbortSignal) => Promise<string>,
): Dispatch {
  const now = Date.now();
  const d: Dispatch = {
    id: randomUUID(),
    vaultId: entry.id,
    skill: req.skill ?? null,
    noteId: req.noteId ?? null,
    status: "running",
    queuedReason: null,
    output: "",
    error: null,
    startedAt: now,
    runStartedAt: now,
    endedAt: null,
  };
  const ac = new AbortController();
  let state: "running" | "ended" = "running";
  dispatches.set(d.id, d);
  handles.set(d.id, {
    id: d.id,
    state: () => state,
    cancel: () => {
      if (state === "ended") return false;
      ac.abort();
      return true;
    },
  });
  const gen = generation;
  void (async () => {
    let out = "";
    let err: string | null = null;
    try {
      out = await run(ac.signal);
    } catch (e) {
      err = (e as Error)?.message ?? String(e);
    }
    state = "ended";
    if (gen !== generation || d.status !== "running") return; // cancelled (already marked) or reset
    if (err === null) {
      d.output = out.slice(0, MAX_OUTPUT);
      if (d.output) fire(d.id, { type: "output", text: d.output });
      d.status = "done";
    } else {
      d.status = "error";
      d.error = err;
    }
    d.endedAt = Date.now();
    emitStatus(d);
  })();
  return d;
}

/** Test-only: clear the in-memory registry + queue and restore default config. */
export function _resetDispatches(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  dispatches.clear();
  handles.clear();
  listeners.clear();
  queue.length = 0;
  running = 0;
  generation++;
  lastAdmission = null;
  cfg = defaultConfig();
}
