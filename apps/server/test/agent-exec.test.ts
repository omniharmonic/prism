/**
 * Agent executor (Phase 3, hardened in Arch v2 WP0.1) — argv template, per-vault
 * strict MCP config (contents, permissions, cleanup), secret-free env allowlist,
 * fixed cwd, claude binary resolution, the concurrency semaphore, the memory
 * admission queue, and output-delta events. Everything runs through an INJECTED
 * fake spawner + memory probe, so no real `claude` ever runs and nothing is
 * created outside the OS temp dir. The live CLI is exercised by
 * scripts/verify-agent-exec.ts (sandbox only).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildClaudeArgs,
  cliSessionFile,
  vaultMcpConfig,
  buildPrompt,
  dispatchEnv,
  ENV_ALLOWLIST,
  resolveClaudeWith,
  ensureAgentCwd,
  parseSwapUsage,
  parseMemoryPressure,
  parseMeminfo,
  admissionVerdict,
  parseSwapFreeMb,
  configureAgentRunner,
  startDispatch,
  enqueueRun,
  type RunHandle,
  getDispatch,
  listDispatches,
  cancelDispatch,
  subscribe,
  runnerStatus,
  AgentBusyError,
  VAULT_MCP_ALLOW,
  _resetDispatches,
  type SpawnedProc,
  type Spawner,
  type MemorySample,
  type DispatchEvent,
} from "../src/agent-exec";
import type { VaultEntry } from "../src/config";

const ENTRY: VaultEntry = { id: "primary", label: "Default", url: "http://localhost:1940", vault: "default", token: "tok_abc" };
const FAKE_CLAUDE = "/opt/fake/bin/claude";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A controllable fake child process. */
function fakeChild() {
  let exitCb: ((code: number | null) => void) | null = null;
  let errCb: ((e: Error) => void) | null = null;
  const outCbs: Array<(c: string) => void> = [];
  const kills: string[] = [];
  const proc: SpawnedProc = {
    stdout: { on: (_e, cb) => outCbs.push(cb as (c: string) => void) },
    stderr: { on: () => {} },
    on: (ev, cb) => {
      if (ev === "exit") exitCb = cb as (code: number | null) => void;
      if (ev === "error") errCb = cb as (e: Error) => void;
    },
    kill: (sig?: string) => {
      kills.push(sig ?? "SIGTERM");
      exitCb?.(null);
    },
  };
  return {
    proc,
    kills,
    out: (s: string) => outCbs.forEach((cb) => cb(s)),
    exit: (code: number | null) => exitCb?.(code),
    err: (e: Error) => errCb?.(e),
  };
}

interface SpawnCall {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcpPath: string;
  mcpJson: string;
  fileMode: number;
  dirMode: number;
}
/** A recording spawner: snapshots the MCP config file AT SPAWN TIME (it is
 *  deleted after the run) and hands out fresh fake children. */
function recordingSpawner() {
  const calls: SpawnCall[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawner: Spawner = (cmd, args, opts) => {
    const mcpPath = args[args.indexOf("--mcp-config") + 1]!;
    calls.push({
      cmd,
      args,
      cwd: opts.cwd,
      env: opts.env,
      mcpPath,
      mcpJson: readFileSync(mcpPath, "utf8"),
      fileMode: statSync(mcpPath).mode & 0o777,
      dirMode: statSync(dirname(mcpPath)).mode & 0o777,
    });
    const fc = fakeChild();
    children.push(fc);
    return fc.proc;
  };
  return { spawner, calls, children };
}

let cwdRoot: string;
let probeSample: MemorySample | null;
const neverSpawn: Spawner = () => {
  throw new Error("test did not inject a spawner");
};

beforeEach(() => {
  _resetDispatches();
  cwdRoot = mkdtempSync(join(tmpdir(), "prism-agent-test-"));
  probeSample = { swapUsedPct: 10, freePct: 60 };
  configureAgentRunner({
    spawner: neverSpawn, // never the real CLI in tests
    cwd: () => ensureAgentCwd(join(cwdRoot, "agent-cwd")),
    claudePath: () => FAKE_CLAUDE,
    memoryProbe: () => probeSample,
    maxConcurrent: 1,
    maxQueue: 20,
    admissionRetryMs: 20,
    maxBudgetUsd: null,
  });
});
afterEach(() => {
  _resetDispatches();
  rmSync(cwdRoot, { recursive: true, force: true });
});

// ── argv ──────────────────────────────────────────────────────────────────────

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("argv: strict vault-only MCP, no built-in tools, dontAsk allowlist, no settings, prompt last", () => {
  const args = buildClaudeArgs("do a thing", "/tmp/x/mcp.json");
  assert.equal(args[0], "-p");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(flagValue(args, "--mcp-config"), "/tmp/x/mcp.json");
  assert.equal(flagValue(args, "--tools"), "", "--tools \"\" removes every built-in tool");
  assert.equal(flagValue(args, "--allowedTools"), "mcp__parachute-vault");
  assert.equal(VAULT_MCP_ALLOW, "mcp__parachute-vault");
  assert.equal(flagValue(args, "--permission-mode"), "dontAsk");
  assert.equal(flagValue(args, "--permission-prompts"), "none");
  assert.equal(flagValue(args, "--setting-sources"), "");
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(flagValue(args, "--output-format"), "text");
  // The old permissive flags are gone.
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--disallowedTools"));
  assert.ok(!args.includes("--add-dir"));
  // tail: `-- <prompt>` — the prompt is the final arg, after the end-of-options marker.
  assert.deepEqual(args.slice(-2), ["--", "do a thing"]);
  assert.equal(args.filter((a) => a === "--").length, 1);
});

test("argv: a flag-looking prompt stays a positional after `--`", () => {
  const args = buildClaudeArgs("--dangerously-skip-permissions --tools default", "/tmp/m.json");
  assert.equal(args.at(-1), "--dangerously-skip-permissions --tools default");
  assert.equal(args.at(-2), "--");
  assert.equal(args.indexOf("--dangerously-skip-permissions"), -1);
});

test("argv: stream-json adds --verbose; a budget cap is appended before `--`", () => {
  const args = buildClaudeArgs("p", "/tmp/m.json", { outputFormat: "stream-json", maxBudgetUsd: 0.5 });
  assert.equal(flagValue(args, "--output-format"), "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.equal(flagValue(args, "--max-budget-usd"), "0.5");
  assert.ok(args.indexOf("--max-budget-usd") < args.indexOf("--"));
  assert.ok(!buildClaudeArgs("p", "/m").includes("--max-budget-usd"));
  assert.ok(!buildClaudeArgs("p", "/m").includes("--verbose"));
});

test("vaultMcpConfig holds exactly one server: the target vault, with its own token", () => {
  const cfg = vaultMcpConfig(ENTRY) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> };
  assert.deepEqual(Object.keys(cfg.mcpServers), ["parachute-vault"]);
  assert.equal(cfg.mcpServers["parachute-vault"]!.url, "http://localhost:1940/vault/default/mcp");
  assert.equal(cfg.mcpServers["parachute-vault"]!.headers.Authorization, "Bearer tok_abc");
});

test("buildPrompt prepends the vault-only rules + skill/note context", () => {
  const p = buildPrompt("summarize", "summarize", "note-1");
  assert.match(p, /parachute-vault MCP tools/);
  assert.match(p, /Skill: summarize/);
  assert.match(p, /Active note: note-1/);
  assert.match(p, /summarize$/);
});

// ── env / binary / cwd ─────────────────────────────────────────────────────────

test("dispatchEnv is an allowlist: no server secrets, no nested-session marker, fixed PATH", () => {
  const src: NodeJS.ProcessEnv = {
    HOME: "/home/u",
    USER: "u",
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp/u",
    PATH: "/evil/bin:/usr/bin",
    PARACHUTE_TOKEN: "secret-1",
    SESSION_SECRET: "secret-2",
    CAPABILITY_SECRET: "secret-3",
    SECRETS_KEY: "secret-4",
    RESEND_API_KEY: "secret-5",
    ANTHROPIC_API_KEY: "secret-6",
    COLLAB_TOKEN: "secret-7",
    CLAUDECODE: "1",
    NODE_OPTIONS: "--require /evil.js",
    DYLD_INSERT_LIBRARIES: "/evil.dylib",
  };
  const env = dispatchEnv(src, "/home/u/.local/bin/claude");
  const allowed = new Set<string>([...ENV_ALLOWLIST, "PATH", "CLAUDE_STREAM_IDLE_TIMEOUT_MS", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]);
  for (const k of Object.keys(env)) assert.ok(allowed.has(k), `unexpected env var ${k}`);
  for (const v of Object.values(env)) assert.doesNotMatch(String(v), /secret-|evil/);
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.USER, "u");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "auto-memory (a context source outside the cwd) is off");
  assert.ok(env.PATH!.startsWith("/home/u/.local/bin:"), "claude's own dir first");
  assert.ok(env.PATH!.split(":").includes("/usr/bin"));
});

test("resolveClaude: PATH lookup first, then ~/.local/bin, then ~/.npm-global, then bare", () => {
  const none = () => false;
  assert.equal(resolveClaudeWith(() => "/usr/local/bin/claude", () => true, "/h"), "/usr/local/bin/claude");
  assert.equal(resolveClaudeWith(() => null, (p) => p === "/h/.local/bin/claude", "/h"), "/h/.local/bin/claude");
  assert.equal(
    resolveClaudeWith(() => null, (p) => p === "/h/.local/bin/claude" || p === "/h/.npm-global/bin/claude", "/h"),
    "/h/.local/bin/claude",
    "~/.local/bin wins over the legacy npm-global path",
  );
  assert.equal(resolveClaudeWith(() => null, (p) => p === "/h/.npm-global/bin/claude", "/h"), "/h/.npm-global/bin/claude");
  assert.equal(resolveClaudeWith(() => null, none, "/h"), "claude");
});

test("ensureAgentCwd creates a 0700 dir lazily and refuses a non-empty one", () => {
  const dir = join(cwdRoot, "fresh", "agent-cwd");
  assert.equal(existsSync(dir), false);
  assert.equal(ensureAgentCwd(dir), dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  writeFileSync(join(dir, "CLAUDE.md"), "planted");
  assert.throws(() => ensureAgentCwd(dir), /not empty/);
});

test("spawn: fixed cwd, allowlisted env, 0600 strict MCP config holding only the target vault — removed after exit", () => {
  const rec = recordingSpawner();
  const d = startDispatch(ENTRY, { prompt: "hi" }, { spawner: rec.spawner });
  assert.equal(d.status, "running");
  assert.equal(rec.calls.length, 1);
  const call = rec.calls[0]!;
  assert.equal(call.cmd, FAKE_CLAUDE);
  assert.equal(call.cwd, join(cwdRoot, "agent-cwd"));
  assert.equal(statSync(call.cwd).mode & 0o777, 0o700);
  const allowed = new Set<string>([...ENV_ALLOWLIST, "PATH", "CLAUDE_STREAM_IDLE_TIMEOUT_MS", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]);
  for (const k of Object.keys(call.env)) assert.ok(allowed.has(k), `unexpected env var ${k}`);
  assert.equal(call.env.PARACHUTE_TOKEN, undefined);
  assert.equal(call.env.SESSION_SECRET, undefined);
  // MCP config: exactly the target vault, private file in a private dir.
  assert.deepEqual(JSON.parse(call.mcpJson), vaultMcpConfig(ENTRY));
  assert.equal(call.fileMode, 0o600);
  assert.equal(call.dirMode, 0o700);
  assert.ok(existsSync(call.mcpPath));
  assert.ok(call.args.includes("--strict-mcp-config"));
  rec.children[0]!.exit(0);
  assert.equal(existsSync(call.mcpPath), false, "config file deleted after the run");
  assert.equal(existsSync(dirname(call.mcpPath)), false, "temp dir deleted after the run");
});

test("the MCP config is also removed on child error and on cancel", () => {
  const rec = recordingSpawner();
  configureAgentRunner({ maxConcurrent: 2 });
  const a = startDispatch(ENTRY, { prompt: "a" }, { spawner: rec.spawner });
  const b = startDispatch(ENTRY, { prompt: "b" }, { spawner: rec.spawner });
  rec.children[0]!.err(new Error("EPIPE"));
  assert.equal(getDispatch(a.id)!.status, "error");
  assert.equal(existsSync(rec.calls[0]!.mcpPath), false);
  assert.equal(cancelDispatch(b.id), true);
  assert.equal(existsSync(rec.calls[1]!.mcpPath), false);
  assert.deepEqual(rec.children[1]!.kills, ["SIGTERM"]);
});

// ── lifecycle ───────────────────────────────────────────────────────────────────

test("dispatch: running → done on exit 0, capturing stdout", () => {
  const fc = fakeChild();
  const d = startDispatch(ENTRY, { prompt: "hi" }, { spawner: () => fc.proc });
  assert.equal(d.status, "running");
  assert.ok(d.runStartedAt);
  fc.out("created 2 notes");
  fc.exit(0);
  const after = getDispatch(d.id)!;
  assert.equal(after.status, "done");
  assert.match(after.output, /created 2 notes/);
  assert.ok(after.endedAt && after.endedAt >= after.startedAt);
});

test("dispatch: non-zero exit → error", () => {
  const fc = fakeChild();
  const d = startDispatch(ENTRY, { prompt: "boom" }, { spawner: () => fc.proc });
  fc.exit(1);
  const after = getDispatch(d.id)!;
  assert.equal(after.status, "error");
  assert.match(after.error ?? "", /exited 1/);
});

test("dispatch: spawn error → error (never stuck running) and the slot is released", () => {
  const d = startDispatch(ENTRY, { prompt: "x" }, {
    spawner: () => {
      throw new Error("ENOENT claude");
    },
  });
  assert.equal(d.status, "error");
  assert.match(d.error ?? "", /failed to spawn|ENOENT/);
  assert.equal(runnerStatus().running, 0);
});

test("dispatch: a non-empty cwd refuses to spawn (error, slot released)", () => {
  const rec = recordingSpawner();
  ensureAgentCwd(join(cwdRoot, "agent-cwd"));
  writeFileSync(join(cwdRoot, "agent-cwd", "CLAUDE.md"), "planted");
  const d = startDispatch(ENTRY, { prompt: "x" }, { spawner: rec.spawner });
  assert.equal(d.status, "error");
  assert.match(d.error ?? "", /not empty/);
  assert.equal(rec.calls.length, 0);
  assert.equal(runnerStatus().running, 0);
});

test("dispatch: cancel terminates a running dispatch", () => {
  const fc = fakeChild();
  const d = startDispatch(ENTRY, { prompt: "long" }, { spawner: () => fc.proc });
  assert.equal(cancelDispatch(d.id), true);
  assert.equal(getDispatch(d.id)!.status, "cancelled");
  assert.equal(cancelDispatch(d.id), false); // a second cancel is a no-op
  assert.equal(runnerStatus().running, 0);
});

test("dispatch: the wall-clock timeout kills the child → error", async () => {
  configureAgentRunner({ timeoutMs: 15 });
  const fc = fakeChild();
  const d = startDispatch(ENTRY, { prompt: "slow" }, { spawner: () => fc.proc });
  await sleep(40);
  assert.equal(getDispatch(d.id)!.status, "error");
  assert.match(getDispatch(d.id)!.error ?? "", /timed out/);
  assert.deepEqual(fc.kills, ["SIGTERM"]);
});

test("listDispatches is scoped per vault, newest first", () => {
  configureAgentRunner({ maxConcurrent: 5 });
  startDispatch(ENTRY, { prompt: "a" }, { spawner: () => fakeChild().proc });
  startDispatch({ ...ENTRY, id: "vault-b" }, { prompt: "b" }, { spawner: () => fakeChild().proc });
  assert.equal(listDispatches("primary").length, 1);
  assert.equal(listDispatches("vault-b").length, 1);
  assert.equal(listDispatches("primary")[0]!.vaultId, "primary");
});

// ── semaphore ─────────────────────────────────────────────────────────────────

test("semaphore: with AGENT_MAX_CONCURRENT=1 the second dispatch waits queued, then runs", () => {
  const rec = recordingSpawner();
  const a = startDispatch(ENTRY, { prompt: "a" }, { spawner: rec.spawner });
  const b = startDispatch(ENTRY, { prompt: "b" }, { spawner: rec.spawner });
  assert.equal(a.status, "running");
  assert.equal(b.status, "queued");
  assert.match(b.queuedReason ?? "", /free agent slot \(1\/1/);
  assert.equal(rec.calls.length, 1, "the queued dispatch has not spawned");
  assert.deepEqual(runnerStatus().running, 1);
  assert.deepEqual(runnerStatus().queued, 1);
  rec.children[0]!.exit(0);
  assert.equal(getDispatch(b.id)!.status, "running");
  assert.equal(getDispatch(b.id)!.queuedReason, null);
  assert.equal(rec.calls.length, 2);
  rec.children[1]!.exit(0);
  assert.equal(getDispatch(b.id)!.status, "done");
  assert.equal(runnerStatus().running, 0);
});

test("semaphore: a larger cap runs dispatches in parallel", () => {
  configureAgentRunner({ maxConcurrent: 2 });
  const rec = recordingSpawner();
  const a = startDispatch(ENTRY, { prompt: "a" }, { spawner: rec.spawner });
  const b = startDispatch(ENTRY, { prompt: "b" }, { spawner: rec.spawner });
  const c = startDispatch(ENTRY, { prompt: "c" }, { spawner: rec.spawner });
  assert.deepEqual([a.status, b.status, c.status], ["running", "running", "queued"]);
});

test("semaphore: cancelling a queued dispatch removes it — it never spawns", () => {
  const rec = recordingSpawner();
  startDispatch(ENTRY, { prompt: "a" }, { spawner: rec.spawner });
  const b = startDispatch(ENTRY, { prompt: "b" }, { spawner: rec.spawner });
  assert.equal(cancelDispatch(b.id), true);
  assert.equal(getDispatch(b.id)!.status, "cancelled");
  rec.children[0]!.exit(0);
  assert.equal(rec.calls.length, 1);
  assert.equal(runnerStatus().queued, 0);
});

test("a full waiting queue is refused with AgentBusyError", () => {
  configureAgentRunner({ maxQueue: 1 });
  const rec = recordingSpawner();
  startDispatch(ENTRY, { prompt: "a" }, { spawner: rec.spawner });
  startDispatch(ENTRY, { prompt: "b" }, { spawner: rec.spawner });
  assert.throws(() => startDispatch(ENTRY, { prompt: "c" }, { spawner: rec.spawner }), AgentBusyError);
});

test("the queue bound also holds while memory pressure (not a busy slot) is what blocks", () => {
  configureAgentRunner({ maxQueue: 2 });
  probeSample = { swapUsedPct: 99, freePct: 50 };
  const rec = recordingSpawner();
  assert.equal(startDispatch(ENTRY, { prompt: "a" }, { spawner: rec.spawner }).status, "queued");
  assert.equal(startDispatch(ENTRY, { prompt: "b" }, { spawner: rec.spawner }).status, "queued");
  assert.throws(() => startDispatch(ENTRY, { prompt: "c" }, { spawner: rec.spawner }), AgentBusyError);
  assert.equal(rec.calls.length, 0);
});

// ── memory admission ─────────────────────────────────────────────────────────

test("admission: swap > 80% keeps the dispatch queued with a reason; it starts once pressure clears", async () => {
  const rec = recordingSpawner();
  probeSample = { swapUsedPct: 91, freePct: 50 };
  const d = startDispatch(ENTRY, { prompt: "x" }, { spawner: rec.spawner });
  assert.equal(d.status, "queued");
  assert.match(d.queuedReason ?? "", /swap 91% used \(> 80%\)/);
  assert.equal(rec.calls.length, 0);
  assert.equal(runnerStatus().admission?.ok, false);
  await sleep(50); // retries while still pressured
  assert.equal(getDispatch(d.id)!.status, "queued");
  assert.equal(rec.calls.length, 0);
  probeSample = { swapUsedPct: 40, freePct: 50 };
  await sleep(60);
  assert.equal(getDispatch(d.id)!.status, "running");
  assert.equal(getDispatch(d.id)!.queuedReason, null);
  assert.equal(rec.calls.length, 1);
});

test("admission: free memory < 15% queues; thresholds are configurable", () => {
  const rec = recordingSpawner();
  probeSample = { swapUsedPct: 0, freePct: 10 };
  const d = startDispatch(ENTRY, { prompt: "x" }, { spawner: rec.spawner });
  assert.equal(d.status, "queued");
  assert.match(d.queuedReason ?? "", /10% free \(< 15%\)/);
  cancelDispatch(d.id);
  configureAgentRunner({ freeMinPct: 5 });
  assert.equal(startDispatch(ENTRY, { prompt: "y" }, { spawner: rec.spawner }).status, "running");
});

test("admission: an unreadable or throwing probe fails OPEN (the concurrency cap still holds)", () => {
  const rec = recordingSpawner();
  probeSample = null;
  assert.equal(startDispatch(ENTRY, { prompt: "a" }, { spawner: rec.spawner }).status, "running");
  rec.children[0]!.exit(0);
  configureAgentRunner({
    memoryProbe: () => {
      throw new Error("sysctl missing");
    },
  });
  assert.equal(startDispatch(ENTRY, { prompt: "b" }, { spawner: rec.spawner }).status, "running");
});

test("admissionVerdict boundaries", () => {
  assert.equal(admissionVerdict({ swapUsedPct: 80, freePct: 15 }, 80, 15).ok, true, "at the threshold is allowed");
  assert.equal(admissionVerdict({ swapUsedPct: 80.5, freePct: 50 }, 80, 15).ok, false);
  assert.equal(admissionVerdict({ swapUsedPct: null, freePct: 14 }, 80, 15).ok, false);
  assert.equal(admissionVerdict({ swapUsedPct: null, freePct: null }, 80, 15).ok, true);
});

test("memory probe parsers (macOS sysctl / memory_pressure, Linux meminfo)", () => {
  assert.equal(parseSwapUsage("total = 4096.00M  used = 3276.80M  free = 819.20M  (encrypted)")?.toFixed(0), "80");
  assert.equal(parseSwapUsage("total = 2.00G  used = 512.00M  free = 1.50G")?.toFixed(0), "25");
  assert.equal(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M"), null, "no swap is not pressure");
  assert.equal(parseSwapUsage("garbage"), null);
  assert.equal(parseMemoryPressure("The system has …\nSystem-wide memory free percentage: 63%\n"), 63);
  assert.equal(parseMemoryPressure("nope"), null);
  const m = parseMeminfo("MemTotal: 1000 kB\nMemFree: 50 kB\nMemAvailable: 250 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n");
  assert.equal(m.freePct, 25);
  assert.equal(m.swapUsedPct, 75);
  assert.equal(parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 900 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n").swapUsedPct, null);
});

// ── events (feed the SSE deltas) ──────────────────────────────────────────────

test("subscribers get output DELTAS (each chunk once), then status changes", () => {
  const fc = fakeChild();
  const d = startDispatch(ENTRY, { prompt: "x" }, { spawner: () => fc.proc });
  const events: DispatchEvent[] = [];
  subscribe(d.id, (ev) => events.push(ev));
  fc.out("aaa");
  fc.out("bbb");
  fc.exit(0);
  const outputs = events.filter((e) => e.type === "output").map((e) => (e as { text: string }).text);
  assert.deepEqual(outputs, ["aaa", "bbb"], "never the accumulated output");
  const last = events.at(-1)!;
  assert.equal(last.type, "status");
  assert.equal((last as { dispatch: { status: string } }).dispatch.status, "done");
});

test("a queued dispatch emits status events as it moves to running", () => {
  const rec = recordingSpawner();
  startDispatch(ENTRY, { prompt: "a" }, { spawner: rec.spawner });
  const b = startDispatch(ENTRY, { prompt: "b" }, { spawner: rec.spawner });
  const statuses: string[] = [];
  subscribe(b.id, (ev) => ev.type === "status" && statuses.push(ev.dispatch.status));
  rec.children[0]!.exit(0);
  rec.children[1]!.exit(0);
  assert.deepEqual(statuses, ["running", "done"]);
});

// ── WP3.1: session argv + the CLI's per-cwd session store ────────────────────

test("argv (sessions): --session-id / --resume replace --no-session-persistence; ids must be uuids; allowlist is vault-only", () => {
  const id = "0b7c2f4e-1a2b-4c3d-8e9f-001122334455";
  const first = buildClaudeArgs("p", "/m", { outputFormat: "stream-json", includePartial: true, session: { id, resume: false } });
  assert.equal(flagValue(first, "--session-id"), id);
  assert.ok(!first.includes("--no-session-persistence") && !first.includes("--resume"));
  assert.ok(first.includes("--include-partial-messages"));
  const next = buildClaudeArgs("p", "/m", { outputFormat: "stream-json", session: { id, resume: true } });
  assert.equal(flagValue(next, "--resume"), id);
  assert.ok(!next.includes("--session-id"));
  assert.ok(!buildClaudeArgs("p", "/m", { includePartial: true }).includes("--include-partial-messages"), "partials need stream-json");
  assert.throws(() => buildClaudeArgs("p", "/m", { session: { id: "--dangerously-skip-permissions", resume: true } }), /uuid/);
  assert.throws(() => buildClaudeArgs("p", "/m", { allowedTools: ["Bash"] }), /vault MCP/);
  assert.throws(() => buildClaudeArgs("p", "/m", { allowedTools: ["mcp__other-vault__query-notes"] }), /vault MCP/);
  assert.throws(() => buildClaudeArgs("p", "/m", { allowedTools: [] }), /vault MCP/);
  const ro = buildClaudeArgs("p", "/m", { allowedTools: ["mcp__parachute-vault__query-notes", "mcp__parachute-vault__list-tags"] });
  assert.equal(flagValue(ro, "--allowedTools"), "mcp__parachute-vault__query-notes,mcp__parachute-vault__list-tags");
});

test("cliSessionFile: $HOME/.claude/projects/<realpath(cwd), non-alphanumerics → '-'>/<id>.jsonl — NOT inside the cwd", () => {
  const id = "0b7c2f4e-1a2b-4c3d-8e9f-001122334455";
  assert.equal(cliSessionFile("/nonexistent/x/.prism/agent-cwd", id, "/h"), `/h/.claude/projects/-nonexistent-x--prism-agent-cwd/${id}.jsonl`);
  const f = cliSessionFile(join(cwdRoot, "agent-cwd"), id, "/h");
  assert.ok(f.startsWith("/h/.claude/projects/"), "the session store lives outside the cwd, so the emptiness guard still holds");
});

test("launch: a run cancelled from inside its own onStart never spawns, and its slot is released", () => {
  const rec = recordingSpawner();
  configureAgentRunner({ spawner: rec.spawner });
  startDispatch(ENTRY, { prompt: "holder" }); // takes the only slot
  let h: RunHandle | null = null;
  const ends: Array<{ cancelled: boolean }> = [];
  h = enqueueRun({
    entry: ENTRY,
    args: (m) => buildClaudeArgs("p", m),
    onStart: () => h!.cancel(),
    onEnd: (i) => ends.push(i),
  });
  assert.equal(h.state(), "queued");
  rec.children[0]!.exit(0); // slot frees → h launches → onStart cancels it
  assert.equal(rec.calls.length, 1, "the cancelled run was never spawned");
  assert.deepEqual(ends, [{ code: null, error: null, cancelled: true }]);
  assert.equal(runnerStatus().running, 0);
});

// ── WP0.1b: platform-aware admission ─────────────────────────────────────────

test("admission darwin: high swap % but healthy memory_pressure free% is admitted", () => {
  const v = admissionVerdict({ swapUsedPct: 95, freePct: 27, swapFreeMb: 2000 }, null, 15, 512);
  assert.equal(v.ok, true);
});

test("admission darwin: low free% refused, reason names memory pressure", () => {
  const v = admissionVerdict({ swapUsedPct: 10, freePct: 12, swapFreeMb: 4000 }, null, 15, 512);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "memory pressure: 12% free (< 15%)");
});

test("admission darwin: low absolute free swap refused, reason names swap", () => {
  const v = admissionVerdict({ swapUsedPct: 50, freePct: 40, swapFreeMb: 300 }, null, 15, 512);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "swap nearly exhausted: 300 MB free (< 512 MB)");
});

test("admission darwin: explicit swapMaxPct is still honoured as an extra guard", () => {
  const s = { swapUsedPct: 95, freePct: 40, swapFreeMb: 2000 };
  assert.equal(admissionVerdict(s, 97, 15, 512).ok, true, "stopgap 97 harmless");
  const v = admissionVerdict(s, 90, 15, 512);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /swap 95% used \(> 90%\)/);
});

test("admission linux (no swapFreeMb): % behaviour unchanged, default 80", () => {
  assert.equal(admissionVerdict({ swapUsedPct: 85, freePct: 50 }, null, 15).ok, false);
  assert.equal(admissionVerdict({ swapUsedPct: 75, freePct: 50 }, null, 15).ok, true);
  assert.equal(admissionVerdict({ swapUsedPct: 85, freePct: 50 }, 90, 15).ok, true);
});

test("parseSwapFreeMb", () => {
  assert.equal(parseSwapFreeMb("total = 4096.00M  used = 2597.50M  free = 1498.50M  (encrypted)"), 1498.5);
  assert.equal(parseSwapFreeMb("total = 2.00G  used = 1.00G  free = 1.00G"), 1024);
  assert.equal(parseSwapFreeMb("garbage"), null);
});
