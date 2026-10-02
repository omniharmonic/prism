import { drainFollowups, listFollowups, recoverFollowups } from "../src/agent-followups";
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
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, existsSync, utimesSync, writeFileSync } from "node:fs";
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
  DEFAULT_MAX_BUDGET_USD,
  runnerBudgetUsd,
  cliSessionFile,
  cliSessionSidecar,
  _resetDispatches,
  type SpawnedProc,
  type Spawner,
} from "../src/agent-exec";
import {
  configureAgentSessions,
  bootSweepAgentSessions,
  createSession,
  changeSessionMode,
  cancelTurn,
  startTurn,
  getTurn,
  getSession,
  eventsAfter,
  profileAllowedTools,
  buildSessionPrompt,
  transcriptPath,
  listTurns,
  purgeCliArtifacts,
  runAgentMaintenance,
  _resetAgentSessions,
  type SessionVault,
} from "../src/agent-sessions";
import { db, resolveVaultEntry, setMembership } from "../src/db";
import { issueInternalPat } from "../src/auth/pat";
import { enterAgentTool, agentToolAllowed } from "../src/agent-policy";
import type { McpPrincipal } from "../src/mcp/auth";
import { issueDeviceToken } from "../src/auth/device";
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
  minted = [];
  patMinted = [];
  patRevoked = [];
  revoked = [];
  mintFails = false;
  configureAgentSessions({
    vaultFor: () => fakeVault,
    cliProjectDir: () => join(root, "cli-project"),
    cliSessionExists: (id) => cliExists.has(id),
    purgeCliSession: (id) => purged.push(id),
    // NEVER the real `parachute auth mint-token` in tests.
    mintReadToken: async (_entry, ttl, sub) => {
      if (mintFails) throw new Error("hub unreachable");
      const jti = `jti-${minted.length + 1}`;
      minted.push({ jti, ttl, sub });
      return { token: `read-token-${jti}`, jti };
    },
    revokeToken: async (jti) => {
      revoked.push(jti);
    },
    transcriptMirror: true,
    sessionBudgetUsd: 10,
    dailyBudgetUsd: 25,
    // NEVER a real PAT in the default setup; tests that want one override these.
    mintPrismToken: (p) => {
      const id = `pat-${patMinted.length + 1}`;
      patMinted.push({ ...p, id });
      return { token: `pp_fake_${id}`, id };
    },
    revokePrismToken: (id) => void patRevoked.push(id),
    prismPort: () => 8787,
    cliRetentionDays: 14,
    eventsRetentionDays: 30,
    now: () => Date.now(),
  });
}
let patMinted: Array<{ email: string; vaultId: string; scope: string; turnId: string; id: string }> = [];
let patRevoked: string[] = [];
let minted: Array<{ jti: string; ttl: number; sub: string }>;
let revoked: string[];
let mintFails: boolean;

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

test("request identifiers recover accepted sessions and finished turns without executing twice", async () => {
  const requestId = "fixture-retry-request-0001";
  const sid = await newSession({ title: "Retry safely", profile: "vault-ro", requestId });
  assert.equal(await newSession({ title: "Retry safely", profile: "vault-ro", requestId }), sid);
  const mismatch = await agentApi.request("/sessions", { method: "POST", headers: { ...J, ...owner() }, body: JSON.stringify({ title: "Different request", profile: "vault-ro", requestId }) });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json() as { error: string }).error, "request_mismatch");
  const turnId = await runTurn(sid, "one request", "agent-stream-turn1.jsonl", { requestId });
  configureAgentSessions({ sessionBudgetUsd: 0 }); // Receipt recovery must not charge/admit again.
  const retried = await postTurn(sid, { prompt: "one request", requestId });
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { turnId, status: "done", context: [] });
  assert.equal(calls.length, 1);
  assert.equal(listTurns(sid).length, 1);
  const changed = await postTurn(sid, { prompt: "different request", requestId });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json() as { error: string }).error, "request_mismatch");
  const other = createSession({ vaultId: resolveVaultEntry().id, ownerEmail: "another@example.test", title: "Retry safely", profile: "vault-ro", requestId });
  assert.notEqual(other.id, sid, "request identifiers are scoped to the authenticated owner and vault");
});

test("a retry during admission is pending, then resolves to the one admitted turn", async () => {
  const sid = await newSession({ profile: "vault-ro" });
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  configureAgentSessions({ mintReadToken: async () => { entered(); await barrier; return { token: "read-token", jti: "retry-jti" }; } });
  const requestId = "fixture-retry-request-0002";
  const first = postTurn(sid, { prompt: "read once", requestId });
  await waiting;
  const during = await postTurn(sid, { prompt: "read once", requestId });
  assert.equal(during.status, 409);
  assert.equal((await during.json() as { error: string }).error, "request_pending");
  assert.equal(calls.length, 0);
  release();
  const accepted = await (await first).json();
  const retry = await postTurn(sid, { prompt: "read once", requestId });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), accepted);
  assert.equal(calls.length, 1);
});

test("malformed request identifiers are rejected before creating work", async () => {
  const sid = await newSession();
  for (const requestId of ["short", 123, "x".repeat(101), "unsafe/identifier/value"]) {
    assert.equal((await postTurn(sid, { prompt: "no work", requestId })).status, 400);
  }
  assert.equal(listTurns(sid).length, 0);
  assert.equal(calls.length, 0);
});

test("failed admission can retry its identifier after rollback without a phantom accepted turn", async () => {
  const sid = await newSession({ profile: "vault-ro" });
  const requestId = "fixture-retry-request-0003";
  mintFails = true;
  assert.equal((await postTurn(sid, { prompt: "read safely", requestId })).status, 503);
  assert.equal(listTurns(sid).length, 0);
  assert.equal(calls.length, 0);
  mintFails = false;
  assert.equal((await postTurn(sid, { prompt: "read safely", requestId })).status, 200);
  assert.equal(listTurns(sid).length, 1);
  assert.equal(calls.length, 1);
});

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
    turns: Array<{ finalText: string; tools: string[]; touched: Array<{ noteId: string }>; firstSeq: number | null; lastSeq: number | null }>;
    lastSeq: number;
  };
  assert.equal(detail.session.id, sid);
  // Resume points for a reconnecting client (WP3.2).
  assert.equal(detail.turns[0]!.firstSeq, 1);
  assert.equal(detail.turns[0]!.lastSeq, evs.length);
  assert.equal(detail.lastSeq, evs.length);
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

test("the shared concurrency cap QUEUES a turn behind a one-shot dispatch — cancel while queued never spawns", async () => {
  const d = startDispatch(resolveVaultEntry(), { prompt: "x" }); // takes the only slot
  assert.equal(d.status, "running");
  const s2 = await newSession();
  const r = await postTurn(s2, { prompt: "b" });
  const { turnId, status } = (await r.json()) as { turnId: string; status: string };
  assert.equal(status, "queued");
  const q = eventsAfter(s2, 0).at(-1)!.event as { t: string; status: string; reason?: string };
  assert.equal(q.status, "queued");
  assert.match(q.reason!, /free agent slot/);
  const d2 = startDispatch(resolveVaultEntry(), { prompt: "y" }); // waits in the SAME queue
  assert.equal(d2.status, "queued");
  assert.ok((await agentApi.request(`/turns/${turnId}/cancel`, { method: "POST", headers: owner() })).ok);
  assert.equal(getTurn(turnId)!.status, "cancelled");
  children[0]!.exit(0); // slot frees → the second dispatch (not the cancelled turn) starts
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.args.includes("--no-session-persistence"), "the dispatch alias keeps one-shot argv");
});

test("a queue-full turn is refused 503 and rolled back (no dangling queued turn)", async () => {
  setup({ maxConcurrent: 1, maxQueue: 0 });
  startDispatch(resolveVaultEntry(), { prompt: "x" });
  const s2 = await newSession();
  const r = await postTurn(s2, { prompt: "b" });
  assert.equal(r.status, 503);
  const detail = (await (await agentApi.request(`/sessions/${s2}`, { headers: owner() })).json()) as { session: { status: string }; turns: unknown[] };
  assert.equal(detail.turns.length, 0);
  assert.equal(detail.session.status, "idle");
  // The user slot was released with the rollback: a later turn is not stuck.
  children[0]!.exit(0);
  assert.equal((await postTurn(s2, { prompt: "c" })).status, 200);
});

test("L1: at most ONE active turn per user across sessions — the next waits (FIFO) and starts when the first ends", async () => {
  setup({ maxConcurrent: 2 });
  const s1 = await newSession();
  const s2 = await newSession();
  const s3 = await newSession();
  await postTurn(s1, { prompt: "a" });
  const b = (await (await postTurn(s2, { prompt: "b" })).json()) as { turnId: string; status: string };
  const c = (await (await postTurn(s3, { prompt: "c" })).json()) as { turnId: string; status: string };
  assert.equal(b.status, "queued");
  assert.equal(calls.length, 1, "a free run slot is NOT used by the same user's second turn");
  const ev = eventsAfter(s2, 0).at(-1)!.event as { status: string; reason?: string };
  assert.match(ev.reason!, /other agent turn/);
  // Cancel the waiting b: it is skipped; c is next.
  assert.ok((await agentApi.request(`/turns/${b.turnId}/cancel`, { method: "POST", headers: owner() })).ok);
  assert.equal(getTurn(b.turnId)!.status, "cancelled");
  children[0]!.out(turnFixture("agent-stream-turn1.jsonl", s1));
  children[0]!.exit(0);
  await sleep(1);
  assert.equal(calls.length, 2);
  assert.equal(getTurn(c.turnId)!.status, "running");
  assert.equal(flag(calls[1]!.args, "--session-id"), s3);
});

test("L1: the per-session cumulative budget refuses new turns once reached (409 budget_exceeded); per-turn default cap is $1", async () => {
  const sid = await newSession();
  db.prepare("UPDATE agent_sessions SET cost_usd = 10.5 WHERE id = ?").run(sid);
  const r = await postTurn(sid, { prompt: "more" });
  assert.equal(r.status, 409);
  const body = (await r.json()) as { error: string; detail: string };
  assert.equal(body.error, "budget_exceeded");
  assert.match(body.detail, /AGENT_SESSION_BUDGET_USD/);
  assert.equal(calls.length, 0);
  _resetDispatches(); // back to env defaults (.env.test sets no AGENT_MAX_BUDGET_USD)
  assert.equal(runnerBudgetUsd(), DEFAULT_MAX_BUDGET_USD);
  assert.equal(DEFAULT_MAX_BUDGET_USD, 1);
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

test("profiles: vault-ro allowlists ONLY read tools; vault-rw is an EXPLICIT list without admin tools; bad profile 400", async () => {
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
  const rwList = flag(calls[1]!.args, "--allowedTools")!.split(",");
  assert.deepEqual(
    rwList,
    ["query-notes", "create-note", "update-note", "delete-note", "list-tags", "find-path", "vault-info", "doctor", "read-attachment", "request-attachment-download"].map(
      (t) => `mcp__parachute-vault__${t}`,
    ),
  );
  assert.ok(!rwList.includes("mcp__parachute-vault"), "never the whole server");
  for (const admin of ["update-tag", "delete-tag", "rename-tag", "merge-tags", "prune-schema", "manage-token", "request-attachment-upload"]) {
    assert.ok(!profileAllowedTools("vault-rw").includes(`mcp__parachute-vault__${admin}`), admin);
  }
  const bad = await agentApi.request("/sessions", { method: "POST", headers: { ...J, ...owner() }, body: JSON.stringify({ profile: "root" }) });
  assert.equal(bad.status, 400);
});

test("M4: a vault-ro turn runs on a minted READ-scoped token (in its MCP config), revoked at turn end; a vault-rw turn never mints", async () => {
  const ro = await newSession({ profile: "vault-ro" });
  await postTurn(ro, { prompt: "read" });
  assert.equal(minted.length, 1);
  assert.equal(minted[0]!.sub, `agent-session:${ro}`);
  assert.ok(minted[0]!.ttl >= 3600);
  const mcp = JSON.parse(calls[0]!.mcpJson) as { mcpServers: Record<string, { headers: { Authorization: string } }> };
  assert.equal(mcp.mcpServers["parachute-vault"]!.headers.Authorization, "Bearer read-token-jti-1");
  assert.deepEqual(revoked, []);
  children[0]!.exit(0);
  await sleep(1);
  assert.deepEqual(revoked, ["jti-1"]);
  const rw = await newSession();
  await postTurn(rw, { prompt: "w" });
  assert.equal(minted.length, 1);
  assert.doesNotMatch(calls[1]!.mcpJson, /read-token/);
});

test("M4: a failed read-token mint fails the vault-ro turn CLOSED (503, rolled back, nothing spawned)", async () => {
  mintFails = true;
  const ro = await newSession({ profile: "vault-ro" });
  const r = await postTurn(ro, { prompt: "read" });
  assert.equal(r.status, 503);
  assert.match(((await r.json()) as { detail: string }).detail, /read-only vault token/);
  assert.equal(calls.length, 0);
  const d = (await (await agentApi.request(`/sessions/${ro}`, { headers: owner() })).json()) as { turns: unknown[]; session: { status: string } };
  assert.equal(d.turns.length, 0);
  assert.equal(d.session.status, "idle");
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

test("archiving a session with a running turn cancels it first, then drops its rows", async () => {
  const sid = await newSession();
  const { turnId } = (await (await postTurn(sid, { prompt: "x" })).json()) as { turnId: string };
  await agentApi.request(`/sessions/${sid}`, { method: "DELETE", headers: owner() });
  assert.deepEqual(children[0]!.kills, ["SIGTERM"]);
  assert.equal(getTurn(turnId), null, "turn rows are deleted on archive");
  assert.equal(getSession(sid)!.status, "archived");
});

test("M3: a child that outlives the archive (SIGTERM ignored) purges AGAIN at exit — no rows, no events, no transcript overwrite", async () => {
  const sid = await newSession();
  await runTurn(sid, "first", "agent-stream-turn1.jsonl");
  const writesBefore = vaultWrites.length;
  await postTurn(sid, { prompt: "second" });
  const c = children[1]!;
  // Make kill() NOT exit (a real child exits asynchronously).
  c.proc.kill = (sig?: string) => void c.kills.push(sig ?? "SIGTERM");
  await agentApi.request(`/sessions/${sid}`, { method: "DELETE", headers: owner() });
  assert.deepEqual(purged, [sid]);
  c.out(turnFixture("agent-stream-turn2-resume.jsonl", sid)); // late output
  c.exit(null);
  await sleep(5);
  assert.deepEqual(purged, [sid, sid], "purged again in the turn's onEnd");
  assert.equal(eventsAfter(sid, 0).length, 0);
  assert.equal(listTurns(sid).length, 0);
  assert.equal(vaultWrites.length, writesBefore, "no transcript write for an archived session");
  // The per-user slot was released too.
  const s2 = await newSession();
  assert.equal((await postTurn(s2, { prompt: "next" })).status, 200);
});

test("M2: purge removes the CLI transcript AND its sidecar dir; ids are uuid-validated before any fs op", () => {
  const dir = join(root, "cli-project");
  const id = "0b7c2f4e-1a2b-4c3d-8e9f-001122334455";
  mkdirSync(join(dir, id, "tool-results"), { recursive: true });
  writeFileSync(join(dir, id, "tool-results", "r.txt"), "raw");
  writeFileSync(join(dir, `${id}.jsonl`), "{}");
  writeFileSync(join(dir, "keep.jsonl"), "{}");
  purgeCliArtifacts(dir, id);
  assert.equal(existsSync(join(dir, id)), false);
  assert.equal(existsSync(join(dir, `${id}.jsonl`)), false);
  purgeCliArtifacts(dir, "../keep"); // not a uuid → no-op
  purgeCliArtifacts(dir, "keep");
  assert.equal(existsSync(join(dir, "keep.jsonl")), true);
  assert.throws(() => cliSessionFile(dir, "../../etc/passwd"), /uuid/);
  assert.throws(() => cliSessionSidecar(dir, "x"), /uuid/);
});

test("M2 + L3: maintenance sweeps old orphan CLI artifacts (never a live session's, a recent one, or non-uuid names) and prunes old events with seq staying monotonic", async () => {
  const dir = join(root, "cli-project");
  mkdirSync(dir, { recursive: true });
  const live = await newSession();
  const old = new Date(Date.now() - 20 * 86_400_000);
  const orphan = "0b7c2f4e-1a2b-4c3d-8e9f-00112233aaaa";
  const recent = "0b7c2f4e-1a2b-4c3d-8e9f-00112233bbbb";
  for (const [name, isDir] of [
    [`${orphan}.jsonl`, false],
    [orphan, true],
    [`${live}.jsonl`, false],
    [`${recent}.jsonl`, false],
    ["memory", true],
  ] as const) {
    const p = join(dir, name);
    if (isDir) mkdirSync(p, { recursive: true });
    else writeFileSync(p, "{}");
    if (name !== `${recent}.jsonl`) utimesSync(p, old, old);
  }
  // Old events on the live session.
  await runTurn(live, "x", "agent-stream-turn1.jsonl");
  const lastSeq = eventsAfter(live, 0).at(-1)!.seq;
  db.prepare("UPDATE agent_events SET at = ? WHERE session_id = ?").run(Date.now() - 40 * 86_400_000, live);
  const r = runAgentMaintenance();
  assert.equal(r.removedCliArtifacts, 2);
  assert.ok(r.prunedEvents >= lastSeq);
  assert.deepEqual(readdirSync(dir).sort(), [`${live}.jsonl`, `${recent}.jsonl`, "memory"].sort());
  assert.equal(eventsAfter(live, 0).length, 0);
  await runTurn(live, "y", "agent-stream-turn2-resume.jsonl");
  assert.equal(eventsAfter(live, 0)[0]!.seq, lastSeq + 1, "seq never restarts after pruning");
});

test("L3: archive deletes the session's turns + events (session row + transcript note kept)", async () => {
  const sid = await newSession();
  await runTurn(sid, "x", "agent-stream-turn1.jsonl");
  const tx = getSession(sid)!.transcript_note_id;
  assert.ok(tx);
  await agentApi.request(`/sessions/${sid}`, { method: "DELETE", headers: owner() });
  assert.equal(eventsAfter(sid, 0).length, 0);
  assert.equal(listTurns(sid).length, 0);
  assert.equal(getSession(sid)!.transcript_note_id, tx);
  assert.ok(vaultNotes.has(tx!), "the vault transcript note is not deleted");
});

test("L3: text events are scrubbed of token-shaped secrets before persist/stream/mirror", async () => {
  const sid = await newSession();
  await postTurn(sid, { prompt: "x" });
  const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlc2lnbmF0dXJl";
  const msg = { type: "assistant", message: { id: "m1", content: [{ type: "text", text: `your token is ${jwt}` }] } };
  children[0]!.out(JSON.stringify(msg) + "\n");
  children[0]!.exit(0);
  await sleep(5);
  const text = eventsAfter(sid, 0).find((e) => e.event.t === "text")!.event as { text: string };
  assert.doesNotMatch(text.text, /eyJhbGci/);
  assert.match(text.text, /\[redacted\]/);
  assert.doesNotMatch(String(vaultWrites.at(-1)!.p.content), /eyJhbGci/);
});

test("M1: transcript is PRIVATE to the owner (prism_creator + prism_visibility); AGENT_TRANSCRIPT_MIRROR=off writes nothing", async () => {
  const sid = await newSession();
  await runTurn(sid, "x", "agent-stream-turn1.jsonl");
  const meta = vaultWrites[0]!.p.metadata as Record<string, unknown>;
  assert.equal(meta.prism_creator, config.ownerEmail.toLowerCase());
  assert.equal(meta.prism_visibility, "private");
  configureAgentSessions({ transcriptMirror: false });
  const s2 = await newSession();
  await runTurn(s2, "y", "agent-stream-turn1.jsonl");
  assert.equal(vaultWrites.length, 1);
});

test("H1 (defense in depth): open-note context requires `view` on the note — someone else's PRIVATE note → 403, rolled back", async () => {
  vaultNotes.set("priv", {
    id: "priv",
    content: "PRIVATE BODY",
    path: "p",
    metadata: { prism_creator: "someone-else@example.test", prism_visibility: "private" },
    createdAt: "",
    updatedAt: null,
    tags: [],
  });
  vaultNotes.set("open", { id: "open", content: "OPEN BODY", path: "o", metadata: null, createdAt: "", updatedAt: null, tags: [] });
  const s1 = await newSession({ noteId: "priv" });
  const r = await postTurn(s1, { prompt: "x" });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(listTurns(s1).length, 0);
  const s2 = await newSession({ noteId: "open" });
  assert.equal((await postTurn(s2, { prompt: "x" })).status, 200);
  assert.match(calls[0]!.args.at(-1)!, /OPEN BODY/);
  // Internal callers without an access context never inline note content.
  const s3 = createSession({ vaultId: resolveVaultEntry().id, ownerEmail: "other@example.test", noteId: "open" });
  children[0]!.exit(0);
  await startTurn(s3.id, resolveVaultEntry(), { prompt: "y" });
  assert.doesNotMatch(calls[1]!.args.at(-1)!, /OPEN BODY/);
  assert.match(calls[1]!.args.at(-1)!, /Active note: open\./);
});

test("attached notes are bounded, recorded, refreshed for a new turn, and not reread on retry", async () => {
  const source: Note = { id: "source", path: "Research", content: "A".repeat(9000), metadata: null, tags: [], createdAt: "", updatedAt: "2026-10-01T10:00:00Z" };
  vaultNotes.set(source.id, source);
  const sid = await newSession();
  const requestId = "context-retry-0001";
  const turnId = await runTurn(sid, "Read the attachment", "agent-stream-turn1.jsonl", { contextNoteIds: [source.id], requestId });
  const detail = await (await agentApi.request(`/sessions/${sid}`, { headers: owner() })).json() as any;
  assert.deepEqual(detail.turns[0].context, [{ noteId: source.id, characters: 8000, truncated: true, updatedAt: source.updatedAt }]);
  assert.equal(detail.turns[0].context_json, undefined);
  assert.ok(calls[0]!.args.at(-1)!.includes("A".repeat(8000)));
  assert.ok(!calls[0]!.args.at(-1)!.includes("A".repeat(8001)));
  source.content = "CHANGED SAVED TEXT";
  source.updatedAt = "2026-10-01T11:00:00Z";
  const retry = await (await postTurn(sid, { prompt: "Read the attachment", contextNoteIds: [source.id], requestId })).json() as any;
  assert.equal(retry.turnId, turnId);
  assert.equal(retry.context[0].characters, 8000);
  assert.equal(calls.length, 1);
  assert.equal((await postTurn(sid, { prompt: "Read the attachment", contextNoteIds: [], requestId })).status, 409);
  await runTurn(sid, "Read it again", "agent-stream-turn2-resume.jsonl", { contextNoteIds: [source.id] });
  assert.match(calls[1]!.args.at(-1)!, /CHANGED SAVED TEXT/);
});

test("unavailable or forbidden attachments fail before execution and release admission", async () => {
  const source: Note = { id: "private-source", path: "PRIVATE NAME", content: "PRIVATE BODY", metadata: { prism_visibility: "private", prism_creator: "someone-else@example.test" }, tags: [], createdAt: "", updatedAt: null };
  vaultNotes.set(source.id, source);
  const sid = await newSession();
  for (const id of [source.id, "missing-source"]) {
    const result = await postTurn(sid, { prompt: "Read this", contextNoteIds: [id] });
    assert.equal(result.status, 409);
    assert.doesNotMatch(await result.text(), /PRIVATE NAME|PRIVATE BODY/);
    assert.equal(listTurns(sid).length, 0);
    assert.equal(calls.length, 0);
  }
  await assert.rejects(() => startTurn(sid, resolveVaultEntry(), { prompt: "No access context", contextNoteIds: [source.id] }), /unavailable/);
  assert.equal(listTurns(sid).length, 0);
  assert.equal((await postTurn(sid, { prompt: "Without attachment" })).status, 200);
});

test("attachment validation rejects malformed, duplicate and excessive sources", async () => {
  const sid = await newSession();
  for (const contextNoteIds of ["source", [""], [null], ["with space"], ["same", "same"], ["a", "b", "c", "d", "e", "f"]]) {
    assert.equal((await postTurn(sid, { prompt: "Read", contextNoteIds })).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal(listTurns(sid).length, 0);
});

test("H1: ALL agent routes are SERVER-OWNER only — an admin (and member) gets 403; an owner device token passes", async () => {
  const vid = resolveVaultEntry().id;
  setMembership(vid, "admin@example.test", "admin", "test");
  setMembership(vid, "member@example.test", "member", "test");
  for (const email of ["admin@example.test", "member@example.test"]) {
    const h = { cookie: sessionCookie(makeSession(email)) };
    for (const [path, method] of [
      ["/dispatch", "POST"],
      ["/dispatches", "GET"],
      ["/runner", "GET"],
      ["/sessions", "POST"],
      ["/sessions", "GET"],
      ["/sessions/x/turns", "POST"],
      ["/sessions/x/stream", "GET"],
      ["/turns/x/cancel", "POST"],
      ["/sessions/x", "DELETE"],
    ] as const) {
      const r = await agentApi.request(path, { method, headers: { ...J, ...h }, body: method === "POST" ? JSON.stringify({ prompt: "p" }) : undefined });
      assert.equal(r.status, 403, `${email} ${method} ${path}`);
    }
  }
  assert.equal(calls.length, 0);
  const dev = issueDeviceToken(config.ownerEmail, "phone", "test-client");
  const r = await agentApi.request("/sessions", { method: "POST", headers: { ...J, authorization: `Bearer ${dev.token}` }, body: "{}" });
  assert.equal(r.status, 200);
});

test("validation: missing prompt 400 (never spawns); unknown session 404", async () => {
  const sid = await newSession();
  assert.equal((await postTurn(sid, {})).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await postTurn("nope", { prompt: "x" })).status, 404);
  await assert.rejects(() => startTurn("nope", resolveVaultEntry(), { prompt: "x" }));
});

// ── WP3.3: turn end → exactly one push per subscription, ids only ────────────
test("push: a finished turn sends one ids-only push per subscription; a failing sender never breaks the turn", async () => {
  const { configurePush, saveSubscription, _resetPush } = await import("../src/push");
  const sent: Array<{ endpoint: string; payload: string }> = [];
  let boom = false;
  configurePush({
    keys: { publicKey: "pub", privateKey: "priv", subject: "mailto:o@test.local" },
    sender: async (sub, payload) => {
      sent.push({ endpoint: sub.endpoint, payload });
      if (boom) throw new Error("push service down");
      return { statusCode: 201 };
    },
  });
  try {
    for (const n of [1, 2]) saveSubscription({ email: config.ownerEmail, endpoint: `https://push.test/${n}`, p256dh: "k", auth: "a" });
    const sid = await newSession();
    const turnId = await runTurn(sid, "SECRET PROMPT TEXT", "agent-stream-turn1.jsonl");
    await sleep(5);
    assert.equal(sent.length, 2);
    for (const s of sent) {
      assert.deepEqual(JSON.parse(s.payload), { type: "agent-turn", sessionId: sid, turnId, status: "done" });
      assert.ok(!s.payload.includes("SECRET"));
    }
    boom = true;
    sent.length = 0;
    await runTurn(sid, "again", "agent-stream-turn2-resume.jsonl");
    assert.equal(getTurn(turnId)?.status, "done");
    assert.equal(listTurns(sid).at(-1)?.status, "done"); // turn completed despite the push failure
  } finally {
    _resetPush();
  }
});

// ── WP3.4: profiles, daily budget, billing ───────────────────────────────────

test("WP3.4 skill profile: sessions can't pick it; its allowlist has no delete-note", async () => {
  const bad = await agentApi.request("/sessions", { method: "POST", headers: { ...J, ...owner() }, body: JSON.stringify({ profile: "skill" }) });
  assert.equal(bad.status, 400);
  assert.ok(!profileAllowedTools("skill").includes("mcp__parachute-vault__delete-note"));
});

test("WP3.4 prism-* profiles are refused (400) until AGENT_PRISM_PROFILES=true", async () => {
  const r = await agentApi.request("/sessions", { method: "POST", headers: { ...J, ...owner() }, body: JSON.stringify({ profile: "prism-ro" }) });
  assert.equal(r.status, 400);
  const lim = (await (await agentApi.request("/limits", { headers: owner() })).json()) as { profiles: string[]; defaultProfile: string };
  assert.deepEqual(lim.profiles, ["vault-ro", "vault-rw"]);
  assert.equal(lim.defaultProfile, "vault-ro");
});

test("WP3.4 prism-ro turn: per-turn PAT (scope read) minted at spawn into a /mcp config, prism allowlist, NO vault token, revoked at turn end", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  try {
    const sid = await newSession({ profile: "prism-ro" });
    const r = await postTurn(sid, { prompt: "what changed?" });
    assert.equal(r.status, 200);
    assert.equal(patMinted.length, 1);
    assert.equal(patMinted[0]!.scope, "read");
    assert.equal(patMinted[0]!.email, config.ownerEmail.toLowerCase());
    assert.equal(minted.length, 0, "no vault read token for prism profiles");
    const c = calls[0]!;
    const mcp = JSON.parse(c.mcpJson) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
    assert.deepEqual(Object.keys(mcp.mcpServers), ["prism"]);
    assert.equal(mcp.mcpServers.prism!.url, "http://127.0.0.1:8787/mcp");
    assert.equal(mcp.mcpServers.prism!.headers.Authorization, "Bearer pp_fake_pat-1");
    assert.doesNotMatch(c.mcpJson, /parachute|read-token/);
    assert.equal(flag(c.args, "--allowedTools"), profileAllowedTools("prism-ro").join(","));
    assert.match(c.args.at(-1)!, /prism MCP tools[\s\S]*READ-ONLY/);
    assert.ok(!c.args.join(" ").includes("pp_fake"), "the token is never in argv");
    assert.deepEqual(patRevoked, []);
    children[0]!.exit(0);
    await sleep(1);
    assert.deepEqual(patRevoked, ["pat-1"], "revoked at turn end");
    assert.ok(!existsSync(c.mcpPath), "config file removed");
  } finally {
    delete process.env.AGENT_PRISM_PROFILES;
  }
});

test("WP3.4 prism-rw: write-scope PAT; cancel while WAITING never mints; cancel while running revokes", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  try {
    const a = await newSession({ profile: "prism-rw" });
    await postTurn(a, { prompt: "one" });
    assert.equal(patMinted[0]!.scope, "write");
    const b = await newSession({ profile: "prism-ro" });
    const r = await postTurn(b, { prompt: "waits behind the user slot" });
    const { turnId } = (await r.json()) as { turnId: string };
    assert.equal(patMinted.length, 1, "queued turn has no credential yet");
    await agentApi.request(`/turns/${turnId}/cancel`, { method: "POST", headers: owner() });
    assert.equal(patMinted.length, 1, "cancelled while queued: still nothing minted");
    await agentApi.request(`/turns/${listTurns(a)[0]!.id}/cancel`, { method: "POST", headers: owner() });
    await sleep(5);
    assert.deepEqual(patRevoked, ["pat-1"]);
  } finally {
    delete process.env.AGENT_PRISM_PROFILES;
  }
});

test("WP3.4 a prism session whose profile was switched off server-side is refused 409 profile_unavailable", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  const sid = await newSession({ profile: "prism-ro" });
  delete process.env.AGENT_PRISM_PROFILES;
  const r = await postTurn(sid, { prompt: "x" });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, "profile_unavailable");
  assert.equal(patMinted.length, 0);
});

test("WP3.4 daily budget: spend accrues per user, 409 daily_budget_exceeded at the cap, survives ARCHIVING, shown in /limits", async () => {
  configureAgentSessions({ dailyBudgetUsd: 0.02 }); // the turn1 fixture costs ~$0.0177
  const sid = await newSession();
  await runTurn(sid, "one", "agent-stream-turn1.jsonl");
  let lim = (await (await agentApi.request("/limits", { headers: owner() })).json()) as {
    billing: string;
    session: { limitUsd: number };
    daily: { limitUsd: number; spentUsd: number; remainingUsd: number; resetsAt: number };
  };
  assert.equal(lim.session.limitUsd, 10);
  assert.equal(lim.daily.limitUsd, 0.02);
  assert.ok(lim.daily.spentUsd > 0.017 && lim.daily.spentUsd < 0.018);
  assert.ok(Math.abs(lim.daily.remainingUsd - (0.02 - lim.daily.spentUsd)) < 1e-9);
  assert.ok(lim.daily.resetsAt > Date.now());
  // Under the cap → a second turn still starts and pushes spend over it.
  const sid2 = await newSession();
  const r2 = await postTurn(sid2, { prompt: "two" });
  assert.equal(r2.status, 200);
  children.at(-1)!.out(turnFixture("agent-stream-turn1.jsonl", sid2));
  children.at(-1)!.exit(0);
  await sleep(5);
  // Over the cap → refused, on a NEW session too, and nothing spawned.
  const before = calls.length;
  const sid3 = await newSession();
  const r3 = await postTurn(sid3, { prompt: "three" });
  assert.equal(r3.status, 409);
  const body = (await r3.json()) as { error: string; detail: string };
  assert.equal(body.error, "daily_budget_exceeded");
  assert.match(body.detail, /AGENT_DAILY_BUDGET_USD/);
  assert.equal(calls.length, before);
  assert.equal(listTurns(sid3).length, 0, "no turn row left behind");
  // Archiving deletes turn rows but must NOT reset the day's spend.
  await agentApi.request(`/sessions/${sid}`, { method: "DELETE", headers: owner() });
  await agentApi.request(`/sessions/${sid2}`, { method: "DELETE", headers: owner() });
  assert.equal((await postTurn(sid3, { prompt: "still refused" })).status, 409);
  lim = (await (await agentApi.request("/limits", { headers: owner() })).json()) as typeof lim;
  assert.equal(lim.daily.remainingUsd, 0);
});

test("WP3.4 daily budget only counts since LOCAL midnight and is per user; null disables it", async () => {
  const email = config.ownerEmail.toLowerCase();
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ins = db.prepare("INSERT INTO agent_cost_log (turn_id, owner_email, cost_usd, at) VALUES (?,?,?,?)");
  ins.run("old", email, 99, midnight - 1000);
  ins.run("other", "someone@else.org", 99, midnight + 1000);
  ins.run("today", email, 3, midnight + 1000);
  const { dailySpentUsd } = await import("../src/agent-sessions");
  assert.equal(dailySpentUsd(email, midnight + 5000), 3);
  configureAgentSessions({ dailyBudgetUsd: 3 });
  const sid = await newSession();
  assert.equal((await postTurn(sid, { prompt: "x" })).status, 409);
  configureAgentSessions({ dailyBudgetUsd: null });
  assert.equal((await postTurn(sid, { prompt: "x" })).status, 200);
});

test("WP3.4 billing mode rides on /runner and /limits (subscription → label the cost as an estimate)", async () => {
  const { configureBilling, probeBilling } = await import("../src/agent-billing");
  configureBilling(async () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
  const unknown = (await (await agentApi.request("/runner", { headers: owner() })).json()) as { billing: string };
  assert.equal(unknown.billing, "unknown", "not probed yet");
  await probeBilling();
  const r = (await (await agentApi.request("/runner", { headers: owner() })).json()) as { billing: string; running: number };
  assert.equal(r.billing, "subscription");
  assert.equal(r.running, 0);
  const l = (await (await agentApi.request("/limits", { headers: owner() })).json()) as { billing: string };
  assert.equal(l.billing, "subscription");
  configureBilling();
});

test("WP3.4 /limits is owner-only like the rest of /api/agent", async () => {
  assert.equal((await agentApi.request("/limits")).status, 403);
});


function turnPrincipal(turnId: string): McpPrincipal {
  const pat = issueInternalPat({ email: config.ownerEmail, vaultId: "primary", scope: "write", turnId });
  return { via: "pat", credentialId: pat.row.id, agentTurnId: turnId, readOnly: false, expiresAt: pat.row.expires_at, vaultBound: true,
    actor: { kind: "user", email: config.ownerEmail, vaultId: "primary", role: "owner", grants: [] } };
}

test("session permissions persist independently, snapshot each turn, and reject stale changes", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  try {
    const sid = await newSession({ permissionMode: "suggest" });
    const other = await newSession({ permissionMode: "read-write" });
    assert.equal(getSession(sid)!.profile, "prism-suggest");
    const r = await postTurn(sid, { prompt: "Propose a correction" });
    assert.equal(r.status, 200);
    const { turnId } = await r.json() as { turnId: string };
    const snapshot = db.prepare("SELECT permission_mode, policy_version, profile FROM agent_turns WHERE id = ?").get(turnId);
    assert.deepEqual(snapshot, { permission_mode: "suggest", policy_version: 1, profile: "prism-suggest" });
    cancelTurn(turnId);
    const updated = changeSessionMode(sid, "read-only", 1);
    assert.equal(updated.permission_mode, "read-only");
    assert.equal(updated.policy_version, 2);
    assert.equal(getSession(other)!.permission_mode, "read-write");
    assert.throws(() => changeSessionMode(sid, "read-write", 1), /changed elsewhere/);
    const reloaded = await agentApi.request(`/sessions/${sid}`, { headers: owner() });
    assert.equal((await reloaded.json() as any).session.permission_mode, "read-only");
  } finally { delete process.env.AGENT_PRISM_PROFILES; }
});

test("suggest-only turn credentials cannot invoke alternate direct-write or administrative tools", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  try {
    const sid = await newSession({ permissionMode: "suggest" });
    const result = await postTurn(sid, { prompt: "Suggest only" });
    const { turnId } = await result.json() as { turnId: string };
    const principal = turnPrincipal(turnId);
    assert.equal(agentToolAllowed(principal, "prism_get_note"), true);
    assert.equal(agentToolAllowed(principal, "prism_suggest_edit"), true);
    assert.equal(agentToolAllowed(principal, "prism_add_comment"), true);
    for (const name of ["prism_update_note", "prism_create_note", "prism_restore_version", "prism_resolve_comment", "prism_share", "prism_vote", "prism_sheet_update"]) {
      assert.equal(agentToolAllowed(principal, name), false, name);
      assert.throws(() => enterAgentTool(principal, name), /no longer permits/);
    }
    cancelTurn(turnId);
    assert.equal(agentToolAllowed(principal, "prism_suggest_edit"), false);
  } finally { delete process.env.AGENT_PRISM_PROFILES; }
});

test("downgrade blocks new calls immediately and waits for an admitted tool to finish", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  let release: (() => void) | undefined;
  try {
    const sid = await newSession({ permissionMode: "read-write" });
    const result = await postTurn(sid, { prompt: "Edit" });
    const { turnId } = await result.json() as { turnId: string };
    const principal = turnPrincipal(turnId);
    release = enterAgentTool(principal, "prism_update_note");
    const pending = changeSessionMode(sid, "read-only", 1);
    assert.equal(pending.pending_mode, "read-only");
    assert.equal(pending.permission_mode, "read-write", "do not claim a downgrade before a mutation drains");
    assert.equal(agentToolAllowed(principal, "prism_update_note"), false);
    assert.ok(patRevoked.length > 0, "revoke the runner credential before confirmation");
    assert.equal((await postTurn(sid, { prompt: "Another turn" })).status, 409);
    release();
    const applied = getSession(sid)!;
    assert.equal(applied.pending_mode, null);
    assert.equal(applied.permission_mode, "read-only");
    assert.equal(applied.policy_version, 2);
    assert.equal(agentToolAllowed(principal, "prism_update_note"), false);
    const audit = db.prepare("SELECT state FROM agent_policy_audit WHERE session_id = ? ORDER BY id").all(sid);
    assert.deepEqual(audit, [{ state: "pending" }, { state: "applied" }]);
  } finally { release?.(); delete process.env.AGENT_PRISM_PROFILES; }
});

test("an active turn cannot gain authority, and legacy turns must stop before migration", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  try {
    for (const params of [{ permissionMode: "read-only" }, { profile: "vault-rw" }]) {
      const sid = await newSession(params);
      const { turnId } = await (await postTurn(sid, { prompt: "Keep working" })).json() as { turnId: string };
      assert.throws(() => changeSessionMode(sid, "suggest", 1), /Stop the running turn/);
      assert.equal(getSession(sid)!.pending_mode, null);
      cancelTurn(turnId);
      assert.equal(changeSessionMode(sid, "suggest", 1).profile, "prism-suggest");
    }
  } finally { delete process.env.AGENT_PRISM_PROFILES; }
});

test("permission API validates modes and versions and enforces session ownership", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  try {
    const sid = await newSession({ permissionMode: "read-only" });
    const patch = (body: unknown, headers = owner()) => agentApi.request(`/sessions/${sid}/permissions`, { method: "PATCH", headers: { ...J, ...headers }, body: JSON.stringify(body) });
    const mismatch = await agentApi.request(`/sessions/${sid}/permissions`, { method: "PATCH", headers: { ...J, ...owner(), "X-Prism-Write-Actor": "user:other@test.local" }, body: JSON.stringify({ mode: "read-write", expectedVersion: 1 }) });
    assert.equal(mismatch.status, 409);
    assert.equal(getSession(sid)!.permission_mode, "read-only");
    assert.equal((await patch({ mode: "root", expectedVersion: 1 })).status, 400);
    assert.equal((await patch({ mode: "read-write" })).status, 400);
    assert.equal((await patch({ mode: "suggest", expectedVersion: 1 }, { cookie: sessionCookie(makeSession("guest@test.local")) })).status, 403);
    assert.equal((await patch({ mode: "suggest", expectedVersion: 1 })).status, 200);
    assert.equal((await patch({ mode: "read-write", expectedVersion: 1 })).status, 409);
    delete process.env.AGENT_PRISM_PROFILES;
    assert.equal((await patch({ mode: "read-write", expectedVersion: 2 })).status, 409);
  } finally { delete process.env.AGENT_PRISM_PROFILES; }
});

test("captured document and file context remains exact across saved edits and request retries", async () => {
  const source: Note = { id: "snapshot-source", path: "Source", content: "SAVED BODY", metadata: null, tags: [], createdAt: "", updatedAt: "2026-10-01T10:00:00Z" };
  vaultNotes.set(source.id, source);
  const sid = await newSession();
  const contextSnapshots = [
    {kind:"selection",noteId:source.id,label:"Selected source",text:"UNSAVED PASSAGE",capturedAt:"2026-10-01T10:05:00Z",baseUpdatedAt:source.updatedAt,truncated:false},
    {kind:"file",label:"private-fixture.txt",text:"QUOTED FILE TEXT",capturedAt:"2026-10-01T10:05:00Z",truncated:false},
  ];
  const requestId = "snapshot-retry-0001";
  const turnId = await runTurn(sid, "Discuss these", "agent-stream-turn1.jsonl", { contextSnapshots, requestId });
  const detail = await (await agentApi.request(`/sessions/${sid}`, {headers: owner()})).json() as any;
  assert.deepEqual(detail.turns[0].context.map((c:any)=>c.snapshot),contextSnapshots);
  const prompt=calls[0]!.args.at(-1)!;
  assert.match(prompt,/UNSAVED PASSAGE/); assert.match(prompt,/QUOTED FILE TEXT/); assert.match(prompt,/NOT the current saved vault content/);
  assert.equal(detail.turns[0].prompt,"Discuss these");
  source.content="LATER SAVED BODY";
  const retry = await (await postTurn(sid,{prompt:"Discuss these",contextSnapshots,requestId})).json() as any;
  assert.equal(retry.turnId,turnId); assert.equal(calls.length,1);
  assert.equal((await postTurn(sid,{prompt:"Discuss these",contextSnapshots:[{...contextSnapshots[0],text:"Changed snapshot"}],requestId})).status,409);
});

test("snapshot admission validates bounds and current note access before any execution", async () => {
  const sid = await newSession();
  const snapshot={kind:"document",noteId:"missing-source",label:"Source",text:"CAPTURED PRIVATE TEXT",capturedAt:"2026-10-01T10:05:00Z",truncated:false};
  for(const contextSnapshots of [null,{},[{...snapshot,text:"x".repeat(8001)}],[{...snapshot,capturedAt:"invalid"}],[{...snapshot,noteId:undefined}],Array(4).fill(snapshot),[{...snapshot,kind:"file"}]]){
    assert.equal((await postTurn(sid,{prompt:"Discuss",contextSnapshots})).status,400);
  }
  const denied=await postTurn(sid,{prompt:"Discuss",contextSnapshots:[snapshot]});
  assert.equal(denied.status,409); assert.doesNotMatch(await denied.text(),/CAPTURED PRIVATE TEXT/);
  assert.equal(calls.length,0);assert.equal(listTurns(sid).length,0);
  vaultNotes.set("missing-source",{id:"missing-source",path:"PRIVATE",content:"PRIVATE",tags:[],metadata:{prism_visibility:"private",prism_creator:"other@example.test"},createdAt:"",updatedAt:null});
  assert.equal((await postTurn(sid,{prompt:"Discuss",contextSnapshots:[snapshot]})).status,409);
  assert.equal(listTurns(sid).length,0);
});

const queueFollowup=(sid:string,body:Record<string,unknown>)=>agentApi.request(`/sessions/${sid}/followups`,{method:'POST',headers:{...J,...owner()},body:JSON.stringify({policyVersion:getSession(sid)?.policy_version,...body})});
const patchFollowup=(sid:string,id:string,body:Record<string,unknown>)=>agentApi.request(`/sessions/${sid}/followups/${id}`,{method:'PATCH',headers:{...J,...owner()},body:JSON.stringify({policyVersion:getSession(sid)?.policy_version,...body})});
test('durable follow-ups stay editable until admission and execute once after the current turn',async()=>{
 const sid=await newSession();await postTurn(sid,{prompt:'First'});
 const body={prompt:'Original follow-up',requestId:'followup-request-0001'};
 const first=await queueFollowup(sid,body);assert.equal(first.status,200);const row=(await first.json() as any).followup;
 assert.equal((await (await queueFollowup(sid,body)).json() as any).followup.id,row.id);
 assert.equal((await queueFollowup(sid,{...body,prompt:'Different request'})).status,409);
 const edited=await patchFollowup(sid,row.id,{version:row.version,action:'edit',payload:{prompt:'Edited follow-up'}});assert.equal(edited.status,200);
 assert.equal((await patchFollowup(sid,row.id,{version:row.version,action:'cancel'})).status,409);
 await drainFollowups(sid);assert.equal(calls.length,1);assert.equal(listFollowups(sid)[0]?.payload.prompt,'Edited follow-up');
 children[0]!.out(turnFixture('agent-stream-turn1.jsonl',sid));children[0]!.exit(0);
 await drainFollowups(sid);assert.equal(calls.length,2);assert.match(calls[1]!.args.at(-1)!,/Edited follow-up/);
 await drainFollowups(sid);assert.equal(calls.length,2);assert.equal(listFollowups(sid).length,0);
 assert.equal((await (await queueFollowup(sid,body)).json() as any).followup.status,'accepted');
});
test('cancelled turns pause follow-ups; deliberate review can resume with current permissions',async()=>{
 const sid=await newSession();const first=await (await postTurn(sid,{prompt:'First'})).json() as any;
 const queued=(await (await queueFollowup(sid,{prompt:'Next',requestId:'followup-request-0002'})).json() as any).followup;
 cancelTurn(first.turnId);await drainFollowups(sid);
 let row=listFollowups(sid)[0]!;assert.equal(row.status,'blocked');assert.equal(calls.length,1);
 const resumed=await patchFollowup(sid,queued.id,{version:row.version,action:'resume',payload:row.payload});assert.equal(resumed.status,200);
 await drainFollowups(sid);assert.equal(calls.length,2);assert.equal(listFollowups(sid).length,0);
});
test('permission changes and source revocations cannot silently execute queued context',async()=>{
 const sid=await newSession();await postTurn(sid,{prompt:'First'});
 await queueFollowup(sid,{prompt:'Next',requestId:'followup-request-0003',contextNoteIds:['missing-note']});
 children[0]!.out(turnFixture('agent-stream-turn1.jsonl',sid));children[0]!.exit(0);
 await drainFollowups(sid);assert.equal(calls.length,1);assert.equal(listFollowups(sid)[0]!.status,'blocked');
 const row=listFollowups(sid)[0]!;
 await patchFollowup(sid,row.id,{version:row.version,action:'resume',payload:{prompt:'No sources'}});
 db.prepare('UPDATE agent_sessions SET policy_version=policy_version+1 WHERE id=?').run(sid);
 await drainFollowups(sid);assert.equal(calls.length,1);assert.match(listFollowups(sid)[0]!.error!,/permissions changed/);
});
test('follow-up recovery blocks uncertain admissions, and archive removes queued payloads',async()=>{
 const sid=await newSession();await postTurn(sid,{prompt:'First'});
 await queueFollowup(sid,{prompt:'Waiting',requestId:'followup-request-0004'});
 recoverFollowups();assert.equal(listFollowups(sid)[0]!.status,'blocked');
 const row=listFollowups(sid)[0]!;
 assert.equal((await patchFollowup(sid,row.id,{version:row.version,action:'cancel'})).status,200);
 assert.equal(listFollowups(sid).length,0);
 const queued=(await (await queueFollowup(sid,{prompt:'Another',requestId:'followup-request-0005'})).json() as any).followup;
 const turn=await (await postTurn(sid,{prompt:'Impossible simultaneous'})).json() as any;assert.equal(turn.error,'conflict');
 db.prepare("UPDATE agent_followups SET status='dispatching' WHERE id=?").run(queued.id);
 recoverFollowups();assert.equal(listFollowups(sid)[0]!.status,'blocked');
 await agentApi.request(`/sessions/${sid}`,{method:'DELETE',headers:owner()});
 assert.equal((db.prepare('SELECT count(*) AS n FROM agent_followups WHERE session_id=?').get(sid) as any).n,0);
});

test('successful turn completion automatically drains the durable queue without an open client',async()=>{
 const sid=await newSession();await postTurn(sid,{prompt:'First'});
 await queueFollowup(sid,{prompt:'Automatic next',requestId:'followup-auto-0001'});
 children[0]!.out(turnFixture('agent-stream-turn1.jsonl',sid));children[0]!.exit(0);
 for(let i=0;i<50&&calls.length<2;i++)await sleep(10);
 assert.equal(calls.length,2);assert.match(calls[1]!.args.at(-1)!,/Automatic next/);
 const accepted=db.prepare('SELECT * FROM agent_followups WHERE session_id=?').get(sid) as any;
 assert.equal(accepted.status,'accepted');assert.equal(accepted.payload,'{"prompt":""}');
 db.prepare("UPDATE agent_followups SET status='dispatching' WHERE id=?").run(accepted.id);
 recoverFollowups();await drainFollowups(sid);
 assert.equal(listFollowups(sid).length,0);assert.equal(calls.length,2);
});
test('queue capacity, actor isolation and stale permission reviews fail before admission',async()=>{
 const sid=await newSession();await postTurn(sid,{prompt:'First'});
 assert.equal((await queueFollowup(sid,{prompt:'Wrong mode',requestId:'followup-mode-0001',policyVersion:0})).status,409);
 assert.equal(listFollowups(sid).length,0);
 for(let i=0;i<10;i++)assert.equal((await queueFollowup(sid,{prompt:`Queued ${i}`,requestId:`followup-capacity-${i}`})).status,200);
 assert.equal((await queueFollowup(sid,{prompt:'Overflow',requestId:'followup-overflow-1'})).status,409);
 assert.equal((await queueFollowup(sid,{prompt:'x'.repeat(50001),requestId:'followup-oversize-1'})).status,400);
 const denied=await agentApi.request(`/sessions/${sid}/followups`);assert.equal(denied.status,403);
 recoverFollowups();const row=listFollowups(sid)[0]!;
 assert.equal((await patchFollowup(sid,row.id,{version:row.version,action:'resume',policyVersion:0,payload:row.payload})).status,409);
 assert.equal(listFollowups(sid)[0]!.status,'blocked');assert.equal(calls.length,1);
});
