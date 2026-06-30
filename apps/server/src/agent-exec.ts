/**
 * Server-side agent executor (Phase 3 — server-first runtime). Ports the
 * desktop's `claude -p` dispatch (Rust `spawn_claude_process`) to Node so an
 * owner/admin can trigger agent skills from the web/mobile app, with no Mac
 * desktop running — the server is colocated with the vault + the `claude` CLI.
 *
 * Security model (this gains the power to spawn a host process from an HTTP
 * request, so it is deliberately constrained):
 *   - ADMIN-gated at the route (owner/admin session only — never capability/anon).
 *   - FIXED argv template — the client supplies a prompt + optional skill/note,
 *     never a command line. No shell; args are passed as an array.
 *   - host-mutating/reading tools are DISALLOWED (`Write,Edit,Bash,Glob,Grep`);
 *     the agent can only reach the vault through the per-vault MCP config.
 *   - the MCP config is written PER ACTIVE VAULT with that vault's scoped token,
 *     so a dispatch acts only on the tenant it was issued for.
 *
 * The spawner is injectable so the orchestration (argv, registry, status,
 * streaming) is unit-tested without invoking the real CLI; a live check
 * (scripts/verify-agent-exec.ts) exercises the real `claude`.
 */
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import type { VaultEntry } from "./config";

export type DispatchStatus = "running" | "done" | "error" | "cancelled";

export interface Dispatch {
  id: string;
  vaultId: string;
  skill: string | null;
  noteId: string | null;
  status: DispatchStatus;
  output: string;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** A minimal child-process shape so a fake spawner can stand in for node's. */
export interface SpawnedProc {
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  on(ev: "exit", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: string): void;
}
export type Spawner = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedProc;

// Default spawner: real claude, with stdin CLOSED (`-p` takes the prompt from
// argv; leaving stdin open makes claude wait ~3s for piped input first).
const defaultSpawner: Spawner = (cmd, args, opts) =>
  realSpawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }) as unknown as SpawnedProc;

const DISPATCH_TIMEOUT_MS = 30 * 60 * 1000; // 30 min, matches the desktop
const MAX_OUTPUT = 2_000_000; // cap captured output so a runaway can't OOM the server

// ── public: argv + MCP config (pure, unit-testable) ──────────────────────────

/** The fixed claude argv. The prompt is the LAST arg after `--`; everything else
 *  is a constant template — the client never injects flags. */
export function buildClaudeArgs(prompt: string, mcpConfigPath: string): string[] {
  return [
    "-p",
    "--model",
    "sonnet",
    "--dangerously-skip-permissions",
    // Restrict to the vault MCP: no host file/shell tools from a web-triggered run.
    "--disallowedTools",
    "Write,Edit,Bash,Glob,Grep",
    "--mcp-config",
    mcpConfigPath,
    "--",
    prompt,
  ];
}

/** The per-vault MCP config JSON (mirrors the desktop's write_managed_mcp_config
 *  + the repo .mcp.json shape). Points claude at THIS vault's scoped MCP with its
 *  own token, so the agent acts only on the tenant the dispatch is for. */
export function vaultMcpConfig(entry: VaultEntry): object {
  return {
    mcpServers: {
      "parachute-vault": {
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
    "You have NO host file or shell access. Do the requested task against the vault",
    "and report concisely what you did.",
  ].join(" ");
  const ctx = [skill ? `Skill: ${skill}.` : "", noteId ? `Active note: ${noteId}.` : ""].filter(Boolean).join(" ");
  return `${rules}\n\n${ctx}\n\n${prompt}`.trim();
}

// ── claude binary + env resolution (mirrors the Rust fallbacks) ───────────────

let cachedClaude: string | null = null;
export function resolveClaude(): string {
  if (cachedClaude) return cachedClaude;
  // 1) which claude  2) ~/.npm-global/bin/claude  3) bare "claude" (PATH at spawn)
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    if (p) return (cachedClaude = p);
  } catch {
    /* not on PATH for `which` — try known locations */
  }
  const npmGlobal = join(homedir(), ".npm-global/bin/claude");
  cachedClaude = npmGlobal;
  return cachedClaude;
}

/** Repo root (where .mcp.json + CLAUDE.md live) — two up from apps/server. */
export function prismRoot(): string {
  return resolve(process.cwd().endsWith("apps/server") ? join(process.cwd(), "../..") : process.cwd());
}

/** Env with the nested-session marker stripped (else claude refuses to run), and
 *  a broadened PATH so a launchd/pm2-minimal env still finds node-installed bins. */
function dispatchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== "CLAUDECODE") env[k] = v;
  const extra = [join(homedir(), ".npm-global/bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":");
  env.PATH = `${env.PATH ?? ""}:${extra}`;
  return env;
}

// ── registry + dispatch ──────────────────────────────────────────────────────

const dispatches = new Map<string, Dispatch>();
const procs = new Map<string, SpawnedProc>();
type Listener = (d: Dispatch) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(id: string): void {
  const d = dispatches.get(id);
  if (!d) return;
  for (const cb of listeners.get(id) ?? []) cb(d);
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
/** Subscribe to a dispatch's updates (for SSE). Returns an unsubscribe fn. */
export function subscribe(id: string, cb: Listener): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
}

export function cancelDispatch(id: string): boolean {
  const d = dispatches.get(id);
  const p = procs.get(id);
  if (!d || d.status !== "running") return false;
  p?.kill("SIGTERM");
  d.status = "cancelled";
  d.endedAt = Date.now();
  emit(id);
  return true;
}

/** Start a dispatch for `entry`'s vault. Returns the dispatch id immediately;
 *  status/output stream via getDispatch/subscribe. `spawner` is injectable. */
export function startDispatch(
  entry: VaultEntry,
  req: { prompt: string; skill?: string | null; noteId?: string | null },
  spawner: Spawner = defaultSpawner,
): Dispatch {
  const id = randomUUID();
  const d: Dispatch = {
    id,
    vaultId: entry.id,
    skill: req.skill ?? null,
    noteId: req.noteId ?? null,
    status: "running",
    output: "",
    error: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  dispatches.set(id, d);

  const mcpPath = join(tmpdir(), `prism-mcp-${entry.id}-${id}.json`);
  writeFileSync(mcpPath, JSON.stringify(vaultMcpConfig(entry)), { mode: 0o600 });
  const cleanup = () => {
    try {
      rmSync(mcpPath, { force: true });
    } catch {
      /* best effort */
    }
  };

  const args = buildClaudeArgs(buildPrompt(req.prompt, d.skill, d.noteId), mcpPath);
  let child: SpawnedProc;
  try {
    child = spawner(resolveClaude(), args, { cwd: prismRoot(), env: dispatchEnv() });
  } catch (e) {
    d.status = "error";
    d.error = `failed to spawn claude: ${(e as Error).message}`;
    d.endedAt = Date.now();
    cleanup();
    emit(id);
    return d;
  }
  procs.set(id, child);

  const append = (chunk: Buffer | string) => {
    if (d.output.length < MAX_OUTPUT) d.output += chunk.toString();
    emit(id);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const timeout = setTimeout(() => {
    if (d.status === "running") {
      d.error = "timed out after 30m";
      child.kill("SIGTERM");
    }
  }, DISPATCH_TIMEOUT_MS);
  timeout.unref(); // never keep the process alive just for a pending dispatch timeout

  child.on("error", (err) => {
    if (d.status !== "running") return;
    d.status = "error";
    d.error = err.message;
    d.endedAt = Date.now();
    clearTimeout(timeout);
    cleanup();
    procs.delete(id);
    emit(id);
  });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    cleanup();
    procs.delete(id);
    if (d.status === "cancelled") return; // already terminal
    d.status = code === 0 ? "done" : "error";
    if (code !== 0 && !d.error) d.error = `claude exited ${code}`;
    d.endedAt = Date.now();
    emit(id);
  });

  return d;
}

/** Test-only: clear the in-memory registry between cases. */
export function _resetDispatches(): void {
  dispatches.clear();
  procs.clear();
  listeners.clear();
}
