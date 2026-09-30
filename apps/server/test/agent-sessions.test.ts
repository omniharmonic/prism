/**
 * Durable agent sessions (Arch v2 WP3.1) — routes + runner, end to end through an
 * INJECTED fake spawner that replays REAL recorded stream-json fixtures. No real
 * `claude` runs, no network, nothing outside the OS temp dir. Covers: event
 * persistence with monotonic seq, --session-id → --resume on the same fixed cwd,
 * SSE replay (?after=N + Last-Event-ID), 409 on a concurrent turn, cancel, the
 * shared concurrency cap, boot sweep, profiles, auth, the transcript note, and
 * that every WP0.1 isolation guarantee still holds for session turns.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentApi } from "../src/routes/agent";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import {
  configureAgentRunner,
  ensureAgentCwd,
  startDispatch,
  ENV_ALLOWLIST,
  _resetDispatches,
  type SpawnedProc,
  type Spawner,
} from "../src/agent-exec";
import {
  configureAgentSessions,
  bootSweepAgentSessions,
  createSession,
  startTurn,
  getTurn,
  getSession,
  eventsAfter,
  profileAllowedTools,
  buildSessionPrompt,
  transcriptPath,
  _resetAgentSessions,
  type SessionVault,
} from "../src/agent-sessions";
import { resolveVaultEntry } from "../src/db";
import type { Note } from "../src/parachute";

const J = { "content-type": "application/json" };
const owner = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const FIX_SID = "11111111-2222-4333-8444-555555555555";
/** A recorded turn, re-keyed to the session under test. */
const turnFixture = (name: string, sid: string) => fixture(name).replaceAll(FIX_SID, sid);

// ── fakes ────────────────────────────────────────────────────────────────────

interface FakeChild {
  proc: SpawnedProc;
  kills: string[];
  out(s: string): void;
  err(s: string): void;
  exit(code: number | null): void;
}
function fakeChild(): FakeChild {
  let exitCb: ((code: number | null) => void) | null = null;
  const outCbs: Array<(c: string) => void> = [];
  const errCbs: Array<(c: string) => void> = [];
  const kills: string[] = [];
  const proc: SpawnedProc = {
    pid: 4242,
    stdout: { on: (_e, cb) => outCbs.push(cb as (c: string) => void) },
    stderr: { on: (_e, cb) => errCbs.push(cb as (c: string) => void) },
    on: (ev, cb) => {
      if (ev === "exit") exitCb = cb as (code: number | null) => void;
    },
    kill: (sig?: string) => {
      kills.push(sig ?? "SIGTERM");
      exitCb?.(null);
    },
  };
  return {
    proc,
    kills,
    out: (s) => outCbs.forEach((cb) => cb(s)),
    err: (s) => errCbs.forEach((cb) => cb(s)),
    exit: (c) => exitCb?.(c),
  };
}

interface SpawnCall {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcpPath: string;
  mcpJson: string;
  fileMode: number;
}

let root: string;
let calls: SpawnCall[];
let children: FakeChild[];
let purged: string[];
let cliExists: Set<string>;
let vaultNotes: Map<string, Note>;
let vaultWrites: Array<{ op: "create" | "update"; id?: string; p: Record<string, unknown> }>;

const fakeVault: SessionVault = {
  getNote: async (id) => {
    const n = vaultNotes.get(id);
    if (!n) throw new Error("404");
    return n;
  },
  createNote: async (p) => {
    vaultWrites.push({ op: "create", p: p as Record<string, unknown> });
    const n: Note = { id: `tx-${vaultWrites.length}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, createdAt: "", updatedAt: null, tags: p.tags ?? [] };
    vaultNotes.set(n.id, n);
    return n;
  },
  updateNote: async (id, p) => {
    if (!vaultNotes.has(id)) throw new Error("404");
    vaultWrites.push({ op: "update", id, p: p as Record<string, unknown> });
    return vaultNotes.get(id)!;
  },
};

function setup(opts: { maxConcurrent?: number; maxQueue?: number } = {}) {
  _resetDispatches();
  _resetAgentSessions();
  root = mkdtempSync(join(tmpdir(), "prism-agent-sess-"));
  calls = [];
  children = [];
  purged = [];
  cliExists = new Set();
  vaultNotes = new Map();
  vaultWrites = [];
  const spawner: Spawner = (_cmd, args, o) => {
    const mcpPath = args[args.indexOf("--mcp-config") + 1]!;
    calls.push({ args, cwd: o.cwd, env: o.env, mcpPath, mcpJson: readFileSync(mcpPath, "utf8"), fileMode: statSync(mcpPath).mode & 0o777 });
    const c = fakeChild();
    children.push(c);
    return c.proc;
  };
  configureAgentRunner({
    spawner,
    cwd: () => ensureAgentCwd(join(root, "agent-cwd")),
    claudePath: () => "/opt/fake/bin/claude",
    memoryProbe: () => ({ swapUsedPct: 0, freePct: 90 }),
    maxConcurrent: opts.maxConcurrent ?? 1,
    maxQueue: opts.maxQueue ?? 20,
    admissionRetryMs: 20,
    maxBudgetUsd: 0.75,
  });
  configureAgentSessions({
    vaultFor: () => fakeVault,
    cliSessionExists: (id) => cliExists.has(id),
    purgeCliSession: (id) => purged.push(id),
  });
}

beforeEach(() => {
  resetDb();
  setup();
});
afterEach(() => {
  _resetDispatches();
  _resetAgentSessions();
  rmSync(root, { recursive: true, force: true });
});

const flag = (args: string[], f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

async function newSession(body: Record<string, unknown> = {}, headers = owner()): Promise<string> {
  const r = await agentApi.request("/sessions", { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  return ((await r.json()) as { sessionId: string }).sessionId;
}
async function postTurn(sid: string, body: Record<string, unknown>, headers = owner()) {
  return agentApi.request(`/sessions/${sid}/turns`, { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });
}
/** Run a full turn from a recorded fixture; returns the turn id. */
async function runTurn(sid: string, prompt: string, fx: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await postTurn(sid, { prompt, ...extra });
  assert.equal(r.status, 200);
  const { turnId } = (await r.json()) as { turnId: string };
  const c = children.at(-1)!;
  c.out(turnFixture(fx, sid));
  c.exit(0);
  await sleep(5); // let the async transcript mirror land
  return turnId;
}

interface SSE {
  id: string | null;
  event: string;
  data: Record<string, unknown>;
}
function parseSSE(text: string): SSE[] {
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith(":"))
    .map((b) => ({
      id: /^id: (.*)$/m.exec(b)?.[1] ?? null,
      event: /^event: (.*)$/m.exec(b)?.[1] ?? "message",
      data: JSON.parse(
        b
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n"),
      ) as Record<string, unknown>,
    }));
}

// ── tests ────────────────────────────────────────────────────────────────────

test("create → turn → normalized events persisted with a monotonic seq; deltas NOT persisted; turn done", async () => {
  const sid = await newSession({ title: "Fruit" });
  const turnId = await runTurn(sid, "find apples, add pears", "agent-stream-turn1.jsonl");
  const evs = eventsAfter(sid, 0);
  assert.deepEqual(
    evs.map((e) => e.seq),
    evs.map((_, i) => i + 1),
    "seq is 1..n with no gaps",
  );
  assert.ok(evs.every((e) => e.turnId === turnId));
  const kinds = evs.map((e) => e.event.t);
  assert.ok(!kinds.includes("text_delta"), "text deltas are coalesced, never persisted");
  assert.deepEqual(kinds, ["status", "init", "tool_use", "tool_result", "tool_use", "tool_result", "note_touched", "text", "result", "status"]);
  assert.deepEqual(evs[0]!.event, { t: "status", status: "running" });
  assert.deepEqual(evs.at(-1)!.event, { t: "status", status: "done" });
  const t = getTurn(turnId)!;
  assert.equal(t.status, "done");
  assert.equal(t.pid, 4242);
  assert.equal(t.exit_code, 0);
  assert.ok(t.cost_usd! > 0.017 && t.cost_usd! < 0.018);
  const s = getSession(sid)!;
  assert.equal(s.status, "idle");
  assert.equal(s.cli_session_id, sid, "init's session_id recorded");

  const detail = (await (await agentApi.request(`/sessions/${sid}`, { headers: owner() })).json()) as {
    session: { id: string };
    turns: Array<{ finalText: string; tools: string[]; touched: Array<{ noteId: string }> }>;
  };
  assert.equal(detail.session.id, sid);
  assert.match(detail.turns[0]!.finalText, /created `demo\/pears`/);
  assert.deepEqual(detail.turns[0]!.tools, ["query-notes", "create-note"]);
  assert.deepEqual(detail.turns[0]!.touched, [{ noteId: "n-1", op: "create" }]);
});

test("turn 1 uses --session-id, turn 2 uses --resume with the SAME id and the SAME fixed cwd; cost is the cumulative delta", async () => {
  const sid = await newSession();
  await runTurn(sid, "first", "agent-stream-turn1.jsonl");
  const t2 = await runTurn(sid, "second", "agent-stream-turn2-resume.jsonl");
  assert.equal(calls.length, 2);
  const [a, b] = calls;
  assert.equal(flag(a!.args, "--session-id"), sid);
  assert.equal(flag(a!.args, "--resume"), undefined);
  assert.equal(flag(b!.args, "--resume"), sid);
  assert.equal(flag(b!.args, "--session-id"), undefined);
  assert.equal(a!.cwd, b!.cwd, "--resume looks the session up per project dir — cwd must be stable");
  assert.equal(a!.cwd, join(root, "agent-cwd"));
  for (const c of calls) {
    assert.ok(!c.args.includes("--no-session-persistence"), "sessions persist (one-shot dispatch keeps the flag)");
    assert.equal(flag(c.args, "--output-format"), "stream-json");
    assert.ok(c.args.includes("--verbose") && c.args.includes("--include-partial-messages"));
  }
  // total_cost_usd is cumulative across --resume: turn 2's own cost is the delta.
  const cost2 = getTurn(t2)!.cost_usd!;
  assert.ok(Math.abs(cost2 - (0.019018 - 0.0177278)) < 1e-9, `turn 2 cost ${cost2}`);
  assert.equal(getSession(sid)!.cost_usd, 0.019018);
});

test("--resume is used when the CLI already holds the conversation even if init was never recorded", async () => {
  const sid = await newSession();
  cliExists.add(sid); // e.g. turn 1 died after the CLI wrote its transcript
  await postTurn(sid, { prompt: "retry" });
  assert.equal(flag(calls[0]!.args, "--resume"), sid);
});

test("open note: content goes into the FIRST turn only (bounded), later turns never re-send it", async () => {
  vaultNotes.set("note-1", { id: "note-1", content: "SECRET-PLAN body " + "z".repeat(20_000), path: "plans/one", metadata: null, createdAt: "", updatedAt: null, tags: [] });
  const sid = await newSession({ noteId: "note-1" });
  await runTurn(sid, "summarize", "agent-stream-turn1.jsonl");
  await runTurn(sid, "and again", "agent-stream-turn2-resume.jsonl");
  const p1 = calls[0]!.args.at(-1)!;
  const p2 = calls[1]!.args.at(-1)!;
  assert.match(p1, /<open_note>\nSECRET-PLAN body/);
  assert.ok(p1.length < 9_500, "note context is bounded");
  assert.match(p1, /summarize$/);
  assert.doesNotMatch(p2, /SECRET-PLAN|open_note/);
  assert.match(p2, /and again$/);
  assert.equal(buildSessionPrompt("x", { profile: "vault-rw", firstTurn: false, noteId: "n9" }).includes("Active note: n9."), true);
});

test("SSE: ?after=N replays EXACTLY the missed persisted events, then live (deltas without id), closing on turn end", async () => {
  const sid = await newSession();
  await runTurn(sid, "first", "agent-stream-turn1.jsonl");
  const turn1Count = eventsAfter(sid, 0).length;
  // Start turn 2 but leave it running.
  const r = await postTurn(sid, { prompt: "second" });
  const { turnId } = (await r.json()) as { turnId: string };
  const persistedNow = eventsAfter(sid, 0).length; // + the "running" status
  assert.equal(persistedNow, turn1Count + 1);

  const N = 4;
  const res = await agentApi.request(`/sessions/${sid}/stream?after=${N}`, { headers: owner() });
  assert.equal(res.status, 200);
  const body = res.text();
  await sleep(10);
  children.at(-1)!.out(turnFixture("agent-stream-turn2-resume.jsonl", sid));
  children.at(-1)!.exit(0);
  const got = parseSSE(await body);

  const withId = got.filter((e) => e.id != null);
  const seqs = withId.map((e) => Number(e.id));
  const all = eventsAfter(sid, 0);
  assert.deepEqual(
    seqs,
    all.filter((e) => e.seq > N).map((e) => e.seq),
    "every persisted event after N, exactly once, in order",
  );
  assert.ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1));
  const deltas = got.filter((e) => e.event === "text_delta");
  assert.ok(deltas.length >= 1, "live deltas are streamed");
  assert.ok(deltas.every((d) => d.id === null && d.data.turnId === turnId));
  const last = withId.at(-1)!;
  assert.equal(last.event, "status");
  assert.equal(last.data.status, "done");
  assert.equal(last.data.turnId, turnId);
});

test("SSE: Last-Event-ID resumes the same way; a stream with nothing in flight closes after the replay", async () => {
  const sid = await newSession();
  await runTurn(sid, "first", "agent-stream-turn1.jsonl");
  const total = eventsAfter(sid, 0).length;
  const res = await agentApi.request(`/sessions/${sid}/stream`, { headers: { ...owner(), "last-event-id": String(total - 2) } });
  const got = parseSSE(await res.text());
  assert.deepEqual(
    got.map((e) => Number(e.id)),
    [total - 1, total],
  );
  const none = parseSSE(await (await agentApi.request(`/sessions/${sid}/stream?after=${total}`, { headers: owner() })).text());
  assert.deepEqual(none, []);
});

test("409 while a turn is running; a new turn is accepted once it ends", async () => {
  const sid = await newSession();
  const r1 = await postTurn(sid, { prompt: "one" });
  assert.equal(r1.status, 200);
  const r2 = await postTurn(sid, { prompt: "two" });
  assert.equal(r2.status, 409);
  assert.equal(((await r2.json()) as { turnId: string }).turnId, ((await r1.json()) as { turnId: string }).turnId);
  children[0]!.out(turnFixture("agent-stream-turn1.jsonl", sid));
  children[0]!.exit(0);
  assert.equal((await postTurn(sid, { prompt: "three" })).status, 200);
  assert.equal(calls.length, 2, "the 409'd turn never spawned");
});

test("cancel a running turn: SIGTERM, turn cancelled, session idle, terminal status event", async () => {
  const sid = await newSession();
  const { turnId } = (await (await postTurn(sid, { prompt: "long" })).json()) as { turnId: string };
  const r = await agentApi.request(`/turns/${turnId}/cancel`, { method: "POST", headers: owner() });
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(children[0]!.kills, ["SIGTERM"]);
  assert.equal(getTurn(turnId)!.status, "cancelled");
  assert.equal(getSession(sid)!.status, "idle");
  assert.deepEqual(eventsAfter(sid, 0).at(-1)!.event, { t: "status", status: "cancelled" });
  const again = await agentApi.request(`/turns/${turnId}/cancel`, { method: "POST", headers: owner() });
  assert.deepEqual(await again.json(), { ok: false });
});

test("the shared concurrency cap QUEUES a second session's turn (and a dispatch) — cancel while queued never spawns", async () => {
  const s1 = await newSession();
  const s2 = await newSession();
  await postTurn(s1, { prompt: "a" });
  const r = await postTurn(s2, { prompt: "b" });
  const { turnId, status } = (await r.json()) as { turnId: string; status: string };
  assert.equal(status, "queued");
  const q = eventsAfter(s2, 0).at(-1)!.event as { t: string; status: string; reason?: string };
  assert.equal(q.status, "queued");
  assert.match(q.reason!, /free agent slot/);
  // A one-shot dispatch waits in the SAME queue.
  const d = startDispatch(resolveVaultEntry(), { prompt: "x" });
  assert.equal(d.status, "queued");
  assert.ok((await agentApi.request(`/turns/${turnId}/cancel`, { method: "POST", headers: owner() })).ok);
  assert.equal(getTurn(turnId)!.status, "cancelled");
  children[0]!.exit(0); // slot frees → the dispatch (not the cancelled turn) starts
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.args.includes("--no-session-persistence"), "the dispatch alias keeps one-shot argv");
});

test("a queue-full turn is refused 503 and rolled back (no dangling queued turn)", async () => {
  setup({ maxConcurrent: 1, maxQueue: 0 });
  const s1 = await newSession();
  const s2 = await newSession();
  await postTurn(s1, { prompt: "a" });
  const r = await postTurn(s2, { prompt: "b" });
  assert.equal(r.status, 503);
  const detail = (await (await agentApi.request(`/sessions/${s2}`, { headers: owner() })).json()) as { session: { status: string }; turns: unknown[] };
  assert.equal(detail.turns.length, 0);
  assert.equal(detail.session.status, "idle");
});

test("a failing turn (non-zero exit + error result + stderr) → status error with a scrubbed message", async () => {
  const sid = await newSession();
  await postTurn(sid, { prompt: "x" });
  children[0]!.out('{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":0,"errors":["boom"]}\n');
  children[0]!.err("Error: Bearer abcdefghijklmnopqrstu failed\n");
  children[0]!.exit(1);
  const t = (await (await agentApi.request(`/sessions/${sid}`, { headers: owner() })).json()) as { turns: Array<{ status: string; error: string }> };
  assert.equal(t.turns[0]!.status, "error");
  assert.match(t.turns[0]!.error, /claude exited 1/);
  assert.match(t.turns[0]!.error, /boom/);
  assert.doesNotMatch(t.turns[0]!.error, /abcdefghijklmnop/);
});

test("boot sweep: an in-flight turn from a dead process becomes interrupted; its session idle; a status event says why", async () => {
  const sid = await newSession();
  const { turnId } = (await (await postTurn(sid, { prompt: "x" })).json()) as { turnId: string };
  // Simulate the restart: the in-memory runner is gone, the rows remain.
  _resetDispatches();
  _resetAgentSessions();
  assert.equal(getTurn(turnId)!.status, "running");
  assert.deepEqual(bootSweepAgentSessions(), { interrupted: 1 });
  assert.equal(getTurn(turnId)!.status, "interrupted");
  assert.equal(getSession(sid)!.status, "idle");
  const last = eventsAfter(sid, 0).at(-1)!;
  assert.equal(last.turnId, turnId);
  assert.equal((last.event as { status: string }).status, "interrupted");
  assert.deepEqual(bootSweepAgentSessions(), { interrupted: 0 }, "idempotent");
});

test("profiles: vault-ro allowlists ONLY read tools in argv; vault-rw the whole vault server; bad profile 400", async () => {
  const ro = await newSession({ profile: "vault-ro" });
  await postTurn(ro, { prompt: "read" });
  assert.equal(
    flag(calls[0]!.args, "--allowedTools"),
    "mcp__parachute-vault__query-notes,mcp__parachute-vault__list-tags,mcp__parachute-vault__find-path,mcp__parachute-vault__vault-info,mcp__parachute-vault__doctor",
  );
  assert.doesNotMatch(flag(calls[0]!.args, "--allowedTools")!, /create|update|delete/);
  assert.match(calls[0]!.args.at(-1)!, /READ-ONLY/);
  children[0]!.exit(0);
  const rw = await newSession();
  await postTurn(rw, { prompt: "write" });
  assert.equal(flag(calls[1]!.args, "--allowedTools"), "mcp__parachute-vault");
  assert.deepEqual(profileAllowedTools("vault-rw"), ["mcp__parachute-vault"]);
  const bad = await agentApi.request("/sessions", { method: "POST", headers: { ...J, ...owner() }, body: JSON.stringify({ profile: "root" }) });
  assert.equal(bad.status, 400);
});

test("WP0.1 guarantees hold for session turns: strict MCP (0600, target vault only, removed after), no host tools, dontAsk, no settings, env allowlist, budget cap", async () => {
  const sid = await newSession();
  await postTurn(sid, { prompt: "x" });
  const c = calls[0]!;
  assert.ok(c.args.includes("--strict-mcp-config"));
  assert.equal(flag(c.args, "--tools"), "");
  assert.equal(flag(c.args, "--permission-mode"), "dontAsk");
  assert.equal(flag(c.args, "--permission-prompts"), "none");
  assert.equal(flag(c.args, "--setting-sources"), "");
  assert.equal(flag(c.args, "--max-budget-usd"), "0.75");
  assert.ok(!c.args.includes("--dangerously-skip-permissions"));
  assert.equal(c.args.at(-2), "--", "the prompt is the last arg after --");
  const mcp = JSON.parse(c.mcpJson) as { mcpServers: Record<string, { url: string }> };
  assert.deepEqual(Object.keys(mcp.mcpServers), ["parachute-vault"]);
  assert.equal(c.fileMode, 0o600);
  const allowed = new Set<string>([...ENV_ALLOWLIST, "PATH", "CLAUDE_STREAM_IDLE_TIMEOUT_MS", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]);
  for (const k of Object.keys(c.env)) assert.ok(allowed.has(k), `unexpected env var ${k}`);
  assert.equal(c.env.PARACHUTE_TOKEN, undefined);
  children[0]!.exit(0);
  assert.equal(existsSync(dirname(c.mcpPath)), false, "per-turn MCP config removed at turn end");
});

test("the session id in argv is always the server uuid — never client text", async () => {
  const sid = await newSession({ title: "--dangerously-skip-permissions" });
  await postTurn(sid, { prompt: "--tools default" });
  const args = calls[0]!.args;
  assert.match(flag(args, "--session-id")!, /^[0-9a-f-]{36}$/);
  assert.equal(args.filter((a) => a === "--tools").length, 1);
  assert.equal(args.indexOf("--dangerously-skip-permissions"), -1);
});

test("auth: no session, a capability link, and a non-admin user are all 403; another user's session is 404", async () => {
  const cap = makeCapability("note", "n1", "edit");
  for (const [path, method] of [
    ["/sessions", "POST"],
    ["/sessions", "GET"],
    ["/sessions/x", "GET"],
    ["/sessions/x/turns", "POST"],
    ["/sessions/x/stream", "GET"],
    ["/turns/x/cancel", "POST"],
    ["/sessions/x", "DELETE"],
  ] as const) {
    assert.equal((await agentApi.request(path, { method, headers: J, body: method === "POST" ? "{}" : undefined })).status, 403, `${method} ${path} anon`);
    const capRes = await agentApi.request(path, { method, headers: { ...J, authorization: `Capability ${cap}` }, body: method === "POST" ? "{}" : undefined });
    assert.equal(capRes.status, 403, `${method} ${path} capability`);
    const guest = { cookie: sessionCookie(makeSession("guest@example.test")) };
    assert.equal((await agentApi.request(path, { method, headers: { ...J, ...guest }, body: method === "POST" ? "{}" : undefined })).status, 403, `${method} ${path} guest`);
  }
  const other = createSession({ vaultId: resolveVaultEntry().id, ownerEmail: "someone-else@example.test" });
  assert.equal((await agentApi.request(`/sessions/${other.id}`, { headers: owner() })).status, 404);
  assert.equal((await postTurn(other.id, { prompt: "x" })).status, 404);
  assert.equal((await agentApi.request(`/sessions/${other.id}/stream`, { headers: owner() })).status, 404);
  const list = (await (await agentApi.request("/sessions", { headers: owner() })).json()) as unknown[];
  assert.equal(list.length, 0, "another user's session is not listed");
});

test("transcript: one vault note per session (agent-session + agent-dispatch), prompts + replies + tool names + touched ids, never tool results", async () => {
  const sid = await newSession({ title: "Fruit Stand!" });
  await runTurn(sid, "find apples, add pears", "agent-stream-turn1.jsonl");
  assert.equal(vaultWrites.length, 1);
  const w = vaultWrites[0]!;
  assert.equal(w.op, "create");
  const s = getSession(sid)!;
  const date = new Date(s.created_at).toISOString().slice(0, 10);
  assert.equal(w.p.path, `vault/agent/sessions/${date}/fruit-stand-${sid.slice(0, 8)}`);
  assert.equal(w.p.path, transcriptPath(s, null));
  assert.deepEqual(w.p.tags, ["agent-session", "agent-dispatch"]);
  assert.equal(w.p.ifExists, "update");
  const meta = w.p.metadata as Record<string, unknown>;
  assert.equal(meta.type, "agent-dispatch");
  assert.equal(meta.status, "completed");
  assert.equal(meta.sessionId, sid);
  assert.equal(meta.runner, "server");
  const content = String(w.p.content);
  assert.match(content, /find apples, add pears/);
  assert.match(content, /\*\*Tools:\*\* query-notes, create-note/);
  assert.match(content, /`n-1` \(create\)/);
  assert.match(content, /created `demo\/pears`/);
  assert.doesNotMatch(content, /"tags":\["demo"\]|\{"id":"n-1"/, "raw tool results never reach the transcript");
  assert.equal(s.transcript_note_id, "tx-1");

  await runTurn(sid, "second", "agent-stream-turn2-resume.jsonl");
  assert.equal(vaultWrites.length, 2);
  assert.equal(vaultWrites[1]!.op, "update");
  assert.equal(vaultWrites[1]!.id, "tx-1");
  assert.match(String(vaultWrites[1]!.p.content), /## Turn 2/);
});

test("archive: DELETE marks archived, purges the CLI transcript, hides it from the list, and refuses new turns", async () => {
  const sid = await newSession();
  await runTurn(sid, "x", "agent-stream-turn1.jsonl");
  const r = await agentApi.request(`/sessions/${sid}`, { method: "DELETE", headers: owner() });
  assert.equal(r.status, 200);
  assert.equal(getSession(sid)!.status, "archived");
  assert.deepEqual(purged, [sid]);
  assert.equal(((await (await agentApi.request("/sessions", { headers: owner() })).json()) as unknown[]).length, 0);
  assert.equal(((await (await agentApi.request("/sessions?archived=1", { headers: owner() })).json()) as unknown[]).length, 1);
  assert.equal((await postTurn(sid, { prompt: "more" })).status, 409);
});

test("archiving a session with a running turn cancels it first", async () => {
  const sid = await newSession();
  const { turnId } = (await (await postTurn(sid, { prompt: "x" })).json()) as { turnId: string };
  await agentApi.request(`/sessions/${sid}`, { method: "DELETE", headers: owner() });
  assert.equal(getTurn(turnId)!.status, "cancelled");
  assert.deepEqual(children[0]!.kills, ["SIGTERM"]);
});

test("validation: missing prompt 400 (never spawns); unknown session 404", async () => {
  const sid = await newSession();
  assert.equal((await postTurn(sid, {})).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await postTurn("nope", { prompt: "x" })).status, 404);
  await assert.rejects(() => startTurn("nope", resolveVaultEntry(), { prompt: "x" }));
});
