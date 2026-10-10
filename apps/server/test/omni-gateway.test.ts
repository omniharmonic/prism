/**
 * Omni gateway (`/api/omni/*`, src/routes/omni.ts + src/omni/*). Hermes is FAKED via
 * `setHermesFetchForTests` — nothing here reaches a real Hermes or the network; record
 * lookups, the tree feed, the executor and push are injected too.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.OMNI_ENABLED = "true";
// A cancel keeps asking Hermes to stop; in tests it gives up quickly.
process.env.OMNI_HERMES_STOP_RETRY_MS = "1500";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:8642";
process.env.OMNI_HERMES_KEY = "hermes-test-key-0123456789";
process.env.OMNI_SERVICE_TOKEN = "omni-service-token-0123456789";

import { config } from "../src/config";
import { omniApi, setOmniExecutorForTests } from "../src/routes/omni";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { setOmniRecordSourcesForTests, type NoteMeta } from "../src/omni/records";
import { setOmniPusherForTests, subscribeThread, threadWatched } from "../src/omni/bus";
import { turnSettled, stopOrphanedRuns } from "../src/omni/turns";
import { eventsAfter, getTurn, getThread, auditRows, resetOmniStoreForTests, runningRunIds } from "../src/omni/store";
import { approvalDigest, canonicalJson, type Executor } from "../src/omni/approvals";
import { INPROCESS_ACTOR, INPROCESS_CLIENT_KEY } from "../src/auth/actor";
import { issueDeviceToken } from "../src/auth/device";
import { db, setMembership } from "../src/db";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import type { TreeChange } from "../src/tree";
import { createHermesStub, type HermesStub, type StubAct, type StubFrame, type StubTurn } from "../scripts/lib/hermes-stub";
import { resetJobCreationsForTests } from "../src/omni/job-creations";
import { resetOmniPresenceForTests } from "../src/routes/omni";
import { HermesNormalizer, toolFailed, createdIdOf, errorCodeOf, toolRowsOf, unwrapResult } from "../src/omni/stream";

const J = { "content-type": "application/json" };
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
const hook = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
let keyN = 0;
const key = () => `omni-test-key-${Date.now()}-${++keyN}`;

// ── fake Hermes ─────────────────────────────────────────────────────────────

// The routes, the bearer check and the SSE encoding are the SAME stub the laptop dev
// gateway runs against (scripts/lib/hermes-stub.ts) — here handed to the client's fetch
// seam, with the turn each test scripts (what the agent says and which tools it calls; the
// stub turns that into the frames and the transcript rows a real Hermes produces).

interface Fake {
  calls: Array<{ method: string; path: string; auth: string | null; body: unknown }>;
  sessions: HermesStub["sessions"];
  stub: HermesStub;
  /** What the next chat/stream does. */
  turn: StubTurn;
  status: number | null;
  throwNext: boolean;
  jobs: Array<Record<string, unknown>>;
}
let fake: Fake;

function installHermes(): void {
  const stub = createHermesStub({
    key: process.env.OMNI_HERMES_KEY!,
    runId: () => "run_abc123",
    script: () => fake.turn,
    jobs: [{ id: "abcdef012345", name: "Brief", schedule: { kind: "cron", expr: "0 7 * * *", display: "0 7 * * *" }, enabled: true, secret_field: "x" }],
  });
  fake = { calls: [], sessions: stub.sessions, stub, turn: { acts: [] }, status: null, throwNext: false, jobs: stub.jobs };
  setHermesFetchForTests(async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init.headers).get("authorization");
    fake.calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, auth, body });
    assert.equal(init.redirect, "error", "the key must never follow a redirect");
    if (fake.throwNext) {
      fake.throwNext = false;
      throw new TypeError("fetch failed");
    }
    if (fake.status) return new Response(JSON.stringify({ error: { message: "no", code: "x" } }), { status: fake.status });
    const result = await stub.fetch(url, init);
    if (u.pathname === "/api/jobs" && init.method === "POST" && result.ok) {
      const answer = await result.json() as {job:Record<string,unknown>};
      const origin = { platform: "api_server", chat_id: new Headers(init.headers).get("X-Omni-Thread") ?? "api" };
      answer.job.origin = origin;
      const stored = fake.jobs.find(j => j.id === answer.job.id);
      if (stored) stored.origin = origin;
      return Response.json(answer, {status:result.status});
    }
    return result;
  });
}

const notes = new Map<string, NoteMeta>();
let treeListener: ((c: TreeChange) => void) | null = null;
let pushes: Array<[string, string]>;
let execCalls: Array<Parameters<Executor>[0]>;

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
  resetJobCreationsForTests();
  resetOmniPresenceForTests();
  installHermes();
  notes.clear();
  notes.set("n1", { id: "n1", path: "vault/tasks/call-dana", tags: ["task"], title: "Call Dana Friday", updatedAt: "2026-10-08T10:00:00Z" });
  notes.set("n2", { id: "n2", path: "vault/projects/buoy", tags: ["project"], title: null });
  setOmniRecordSourcesForTests({
    resolver: async (ref) => [...notes.values()].find((n) => (ref.id && n.id === ref.id) || (ref.path && n.path === ref.path)) ?? null,
    subscriber: async (l) => {
      treeListener = l;
      return () => {
        treeListener = null;
      };
    },
  });
  pushes = [];
  setOmniPusherForTests(async (_o, kind, id) => void pushes.push([kind, id]));
  execCalls = [];
  setOmniExecutorForTests(null);
  Object.assign(config, { actionsEmailEnabled: false, actionsCalendarEnabled: false, actionsMatrixEnabled: false });
});
after(() => {
  setHermesFetchForTests(null);
  setOmniExecutorForTests(null);
  setOmniPusherForTests(null);
});

const req = (path: string, init: RequestInit = {}, env?: Record<symbol, unknown>) => omniApi.request(path, init, env);
const post = (path: string, body: unknown, headers: Record<string, string> = owner(), env?: Record<symbol, unknown>) =>
  req(path, { method: "POST", headers, body: JSON.stringify(body) }, env);

const say = (text: string): StubAct => ({ say: text });
/** A tool call and the result Hermes stores for it (default: a success). */
const tool = (name: string, args: Record<string, unknown> = {}, result: string = JSON.stringify({ result: "ok" })): StubAct => ({ tool: name, args, result });
const raw = (event: string, data: Record<string, unknown> = {}): StubAct => ({ frame: [event, data] as StubFrame });
const turnOf = (t: StubTurn | StubAct[]): StubTurn => (Array.isArray(t) ? { acts: t } : t);
/** A run that says something and stays open until it is stopped. */
const HELD: StubTurn = { acts: [say("thinking")], end: "hold" };

async function newThread(turn: StubTurn | StubAct[], prompt = "Create a task to call Dana Friday"): Promise<{ id: string; turnId: string }> {
  fake.turn = turnOf(turn);
  const r = await post("/threads", { prompt });
  assert.equal(r.status, 201);
  const j = (await r.json()) as { thread: { id: string }; turnId: string };
  return { id: j.thread.id, turnId: j.turnId };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const events = (threadId: string): any[] => eventsAfter(threadId, 0).map((e) => e.payload);

// ── gates ───────────────────────────────────────────────────────────────────

test("OMNI_ENABLED off → every route (hooks too) is a 404", async () => {
  process.env.OMNI_ENABLED = "false";
  try {
    assert.equal((await req("/version", { headers: owner() })).status, 404);
    assert.equal((await post("/hooks/propose", {}, hook)).status, 404);
  } finally {
    process.env.OMNI_ENABLED = "true";
  }
});

test("only the server owner by session or device token; every other actor kind is refused", async () => {
  assert.equal((await req("/version")).status, 401, "anonymous");
  const ok = await req("/version", { headers: owner() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { api: 1, minClient: "1.0" });
  const dev = issueDeviceToken(config.ownerEmail, "Omni (iPhone)", "omni-native").token;
  assert.equal((await req("/version", { headers: { authorization: `Bearer ${dev}` } })).status, 200, "owner device token");
  setMembership("primary", "member@example.test", "admin", null);
  assert.equal((await req("/version", { headers: { cookie: sessionCookie(makeSession("member@example.test")) } })).status, 403, "another account, even an admin");
  const otherDev = issueDeviceToken("member@example.test", "x", "omni-native").token;
  assert.equal((await req("/version", { headers: { authorization: `Bearer ${otherDev}` } })).status, 403, "another account's device");
  assert.equal((await req("/version", { headers: { authorization: `Capability ${makeCapability("note", "n1", "edit")}` } })).status, 403, "capability link");
  assert.equal((await req("/version", { headers: { authorization: `Bearer ${config.collabToken}` } })).status, 403, "loopback owner token");
  const mcp = { [INPROCESS_ACTOR]: { kind: "user", email: config.ownerEmail, role: "owner", vaultId: "primary", grants: [] }, [INPROCESS_CLIENT_KEY]: "mcp:pat:t1" };
  assert.equal((await req("/version", {}, mcp)).status, 403, "in-process MCP dispatch");
  assert.equal((await req("/version", { headers: { ...owner(), authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` } })).status, 200, "service token is no app credential (session decides)");
  assert.equal((await req("/version", { headers: { authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` } })).status, 401, "service token alone is anon to app routes");
});

test("mutations need JSON + same origin (live-actions CSRF guard); device tokens skip the origin check", async () => {
  const r1 = await req("/threads", { method: "POST", headers: { cookie: owner().cookie, "content-type": "text/plain" }, body: "{}" });
  assert.equal(r1.status, 415);
  const r2 = await post("/threads", { prompt: "x" }, { ...owner(), "sec-fetch-site": "cross-site" });
  assert.equal(r2.status, 403);
  const r3 = await post("/threads", { prompt: "x" }, { ...owner(), origin: "https://evil.example" });
  assert.equal(r3.status, 403);
  assert.equal(fake.calls.length, 0, "nothing reached Hermes");
});

// ── threads + streaming + cards ─────────────────────────────────────────────

const happy: StubAct[] = [
  say("Creating…"),
  tool("mcp__prism__prism_update_note", { id: "n1", if_updated_at: "x", metadata: { status: "pending", due: "2026-10-10" }, api_key: "sk-supersecretvalue1234567890" }, JSON.stringify({ result: "RAW TOOL OUTPUT secret" })),
  // The delete FAILS. Hermes' stream says `tool.completed` all the same; only the row differs.
  tool("mcp__prism__prism_delete_note", { id: "n2" }, JSON.stringify({ error: "RAW TOOL OUTPUT forbidden" })),
  say("Done — I set the due date."),
];

test("create a thread: Hermes session + streamed turn → normalized, persisted events + a record card", async () => {
  const { id, turnId } = await newThread(happy);
  assert.match(id, /^omni_[a-f0-9]{24}$/);
  await turnSettled(turnId);
  const create = fake.calls.find((c) => c.path === "/api/sessions" && c.method === "POST")!;
  assert.equal(create.auth, `Bearer ${process.env.OMNI_HERMES_KEY}`);
  const chat = fake.calls.find((c) => c.path.endsWith("/chat/stream"))!;
  assert.deepEqual(chat.body, { message: "Create a task to call Dana Friday" });
  const ev = events(id);
  // text: what the model said before its first tool. Each write tool's row is read right
  // after it completes: the update is carded, the delete's `ok` is corrected to false.
  assert.deepEqual(ev.map((e) => e.t), ["status", "init", "text", "tool_use", "tool_result", "card", "tool_use", "tool_result", "tool_result", "text", "result", "status"]);
  assert.ok(!ev.some((e) => e.t === "text_delta"), "deltas are never persisted");
  assert.deepEqual(ev[2], { t: "text", blockId: `${turnId}:b0`, text: "Creating…" });
  const use = ev[3]! as { name: string; input: Record<string, unknown> };
  assert.equal(use.name, "prism_update_note");
  assert.equal(use.input.api_key, "[redacted]");
  const card = (ev[5]! as { card: Record<string, unknown> }).card;
  assert.equal(card.noteId, "n1");
  assert.equal(card.op, "updated");
  assert.equal(card.type, "task");
  assert.equal(card.title, "Call Dana Friday");
  assert.deepEqual(card.changedKeys, ["status", "due"]);
  assert.deepEqual(card.writer, { kind: "agent", label: "Omni" });
  assert.deepEqual(card.links, { prism: `${config.appOrigin}/page/n1`, prismApp: "prism://page/n1", omni: "omni://record/n1" });
  assert.deepEqual([ev[7], ev[8]].map((e) => [(e as { toolUseId: string }).toolUseId, (e as { ok: boolean }).ok]), [[`${turnId}:t2`, true], [`${turnId}:t2`, false]], "the failed delete: announced ok, then corrected from its row");
  assert.equal(ev.filter((e) => e.t === "card").length, 1, "a FAILED write yields no card");
  assert.deepEqual(ev[9], { t: "text", blockId: `${turnId}:b1`, text: "Done — I set the due date." });
  assert.equal((ev[10] as { ok: boolean }).ok, true);
  assert.ok(!JSON.stringify(ev).includes("RAW TOOL OUTPUT"), "a tool's result is read, never forwarded");
  assert.equal(getTurn(turnId)!.status, "done");
  assert.equal(getTurn(turnId)!.runId, "run_abc123");
  assert.equal(getThread(id)!.state, "done");
  assert.deepEqual(pushes, [["OMNI_THREAD", id]], "a completed turn → one ids-only push");

  // Replay over SSE after reconnect: persisted events with ids, then the stream closes.
  const s = await req(`/threads/${id}/stream?after=2`, { headers: owner() });
  assert.equal(s.status, 200);
  const text = await s.text();
  assert.ok(!text.includes("id: 1\n") && !text.includes("id: 2\n"));
  assert.match(text, /event: tool_use\ndata: \{"seq":4,.*\nid: 4\n/);
  assert.match(text, /event: card\ndata: \{"seq":6/);
  assert.match(text, /event: status\ndata: .*"state":"done"/);

  // Thread detail: Hermes messages (tool rows keep the NAME only), cards, approvals. The
  // assistant row that only carried the second tool call has no text and is left out.
  const d = await req(`/threads/${id}`, { headers: owner() });
  const dj = (await d.json()) as { thread: { state: string; running: boolean }; messages: Array<Record<string, unknown>>; cards: unknown[] };
  assert.equal(dj.thread.state, "done");
  assert.equal(dj.thread.running, false);
  assert.equal(dj.cards.length, 1);
  assert.deepEqual(dj.messages.map((m) => [m.role, m.text ?? m.toolName]), [
    ["user", "Create a task to call Dana Friday"],
    ["assistant", "Creating…"],
    ["tool", "prism_update_note"],
    ["tool", "prism_delete_note"],
    ["assistant", "Done — I set the due date."],
  ]);
  assert.deepEqual(Object.keys(dj.messages[2]!).sort(), ["at", "id", "role", "toolName"]);
  assert.ok(!JSON.stringify(dj).includes("RAW TOOL OUTPUT"));
  // List merges Hermes sessions with local metadata.
  const l = (await (await req("/threads?state=done", { headers: owner() })).json()) as { threads: Array<{ id: string }>; hermes: string };
  assert.equal(l.hermes, "ok");
  assert.deepEqual(l.threads.map((t) => t.id), [id]);
});

test("the stream as Hermes really sends it: no tool.failed, no run.failed, the error text as the answer", async () => {
  // A failed model call after one tool: `assistant.completed` carries Hermes' error text and
  // `run.completed.messages` ends with the tool row — no answer. The text must not be shown.
  const { id, turnId } = await newThread({ acts: [say("One moment. "), tool("read_file", { path: "/x" }, JSON.stringify({ content: "", error: "File not found: /x" }))], end: "fail", failText: "API call failed after 3 retries: HTTP 429: rate limit exceeded for sk-abc" });
  await turnSettled(turnId);
  const ev = events(id);
  assert.deepEqual(ev.map((e) => e.t), ["status", "init", "text", "tool_use", "tool_result", "tool_result", "result", "status"]);
  assert.deepEqual(ev.filter((e) => e.t === "tool_result").map((e) => (e as { ok: boolean }).ok), [true, false], "a read tool's failure is learned when the run ends");
  assert.deepEqual([ev[6]!.ok, ev[6]!.errorCode], [false, "usage_limit"]);
  assert.ok(!JSON.stringify(ev).includes("rate limit exceeded"), "Hermes' error text is classified, never forwarded");
  assert.equal(getTurn(turnId)!.status, "error");
  assert.equal(getThread(id)!.state, "needs-you");
});

test("names this Hermes version never sends are still understood (other surfaces, other versions)", async () => {
  const { id, turnId } = await newThread([
    raw("run.queued"),
    raw("assistant.commentary", { text: "Let me check." }),
    raw("tool.started", { tool_name: "mcp__prism__prism_delete_note", args: { id: "n2" } }),
    raw("tool.failed", { tool_name: "mcp__prism__prism_delete_note", preview: "forbidden" }),
    raw("approval.request", { command: "rm" }),
    raw("run.failed", { code: "max_iterations" }),
  ]);
  await turnSettled(turnId);
  const ev = events(id);
  assert.deepEqual(ev.map((e) => e.t), ["status", "init", "status", "text", "tool_use", "tool_result", "status", "result", "status"]);
  assert.equal(ev[2]!.reason, "queued");
  assert.deepEqual([ev[5]!.ok, ev[5]!.summary], [false, "forbidden"]);
  assert.equal(ev[6]!.reason, "hermes_approval_requested");
  assert.equal(ev[7]!.errorCode, "iteration_limit");
  assert.ok(!ev.some((e) => e.t === "card"));
});

test("stream.ts units: Hermes' failure rule, a created id, error codes, tool rows, pairing by arguments", () => {
  // Hermes' own rule (agent/display.py `_detect_tool_failure`).
  assert.equal(toolFailed("terminal", JSON.stringify({ output: "", exit_code: 1, error: null })), true);
  assert.equal(toolFailed("terminal", JSON.stringify({ output: "error: nothing", exit_code: 0 })), false, "a terminal is judged by its exit code");
  assert.equal(toolFailed("terminal", JSON.stringify({ error: "blocked by a plugin" })), true);
  assert.equal(toolFailed("read_file", JSON.stringify({ content: "", error: "File not found" })), true);
  assert.equal(toolFailed("memory", JSON.stringify({ success: false, message: "full" })), true);
  assert.equal(toolFailed("mcp__vault__create_note", JSON.stringify({ result: JSON.stringify({ id: "n1" }) })), false);
  assert.equal(toolFailed("x", "Error: boom"), true);
  assert.equal(toolFailed("x", JSON.stringify({ result: "3 notes" })), false);
  // A create's id, through Hermes' `{"result": "<the MCP tool's text>"}` wrapping.
  assert.equal(createdIdOf(JSON.stringify({ result: JSON.stringify({ id: "01JABC", path: "a/b" }) })), "01JABC");
  assert.equal(createdIdOf(JSON.stringify({ result: JSON.stringify({ note: { id: "n-7" } }) })), "n-7");
  assert.equal(createdIdOf(JSON.stringify({ result: "created" })), undefined);
  assert.equal(createdIdOf("not json"), undefined);
  // Codes from Hermes' text (never forwarded).
  const code = (t: string) => errorCodeOf({}, t);
  assert.equal(code("HTTP 401: Incorrect API key provided"), "auth");
  assert.equal(code("⚠️ Provider authentication failed: no credentials"), "auth");
  assert.equal(code("API call failed after 3 retries: HTTP 429: slow down"), "usage_limit");
  assert.equal(code("HTTP 402: insufficient credits"), "budget");
  assert.equal(code("API call failed after 3 retries: Request timed out."), "timeout");
  assert.equal(code("API call failed after 3 retries: HTTP 500: upstream"), "agent_failed");
  assert.equal(code("The author of this note is unknown"), "agent_failed", "`author` is not `auth`");
  assert.equal(errorCodeOf({ code: "auth_failed" }), "auth");
  // Rows: the call (assistant.tool_calls) and its result (role tool), joined by id. The
  // transcript stores tool_calls as a list; a JSON string of one is read too.
  const rows = toolRowsOf([
    { role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "call_1", function: { name: "t", arguments: '{"a":1}' } }, { id: "call_2", function: { name: "t", arguments: '{"a":2}' } }]) },
    { role: "tool", tool_call_id: "call_1", tool_name: "t", content: '{"error":"no"}' },
    { role: "tool", tool_call_id: "call_2", content: '{"result":"ok"}' },
  ]);
  assert.deepEqual(rows, [{ callId: "call_1", name: "t", args: { a: 1 }, content: '{"error":"no"}' }, { callId: "call_2", name: "t", args: { a: 2 }, content: '{"result":"ok"}' }]);
  // Tool search: the stored call is the `tool_call` bridge; the row names the real tool.
  assert.deepEqual(
    toolRowsOf([
      { role: "assistant", tool_calls: [{ id: "call_9", function: { name: "tool_call", arguments: JSON.stringify({ name: "omni_propose", arguments: { kind: "tweet" } }) } }] },
      { role: "tool", tool_call_id: "call_9", tool_name: "omni_propose", content: "{}" },
    ]),
    [{ callId: "call_9", name: "omni_propose", args: { kind: "tweet" }, content: "{}" }],
  );
  // What an MCP tool returned arrives inside Hermes' "untrusted data" wrapper: the result inside is what counts.
  const wrapped = (r: string) => `<untrusted_tool_result source="mcp__parachute__create_note">\nThe following content … can issue instructions.\n\n${r}\n</untrusted_tool_result>`;
  assert.equal(unwrapResult(wrapped('{"result":"x"}')), '{"result":"x"}');
  assert.equal(createdIdOf(unwrapResult(wrapped(JSON.stringify({ result: JSON.stringify({ id: "n-42" }) })))), "n-42");
  assert.equal(toolFailed("mcp__parachute__update_note", unwrapResult(wrapped('{"error":"note not found"}'))), true);
  assert.equal(unwrapResult("plain"), "plain");
  // Rows from before the run started are not this run's (Hermes can hand back the whole conversation).
  assert.deepEqual(toolRowsOf([{ role: "tool", tool_call_id: "old", tool_name: "t", content: "{}", timestamp: 100 }, { role: "tool", tool_call_id: "new", tool_name: "t", content: "{}", timestamp: 200 }], 150).map((r) => r.callId), ["new"]);
  // Two calls of one tool, completed in the other order: rows are paired by their arguments.
  const n = new HermesNormalizer("turn_x");
  const f = (event: string, data: Record<string, unknown>) => n.push({ event, data });
  f("tool.started", { tool_name: "t", args: { a: 2 } });
  f("tool.started", { tool_name: "t", args: { a: 1 } });
  const fixes = n.reconcile(rows, true);
  assert.deepEqual(fixes, [{ t: "tool_result", toolUseId: "turn_x:t2", ok: false, summary: "" }, { t: "tool_result", toolUseId: "turn_x:t1", ok: true, summary: "" }]);
  assert.deepEqual(n.reconcile(rows, true), [], "a row is used once");
});

test("a create by path resolves through the tree; a create without one is matched from the tree feed", async () => {
  notes.set("n3", { id: "n3", path: "vault/tasks/buy-milk", tags: ["task"], title: "Buy milk" });
  notes.set("n4", { id: "n4", path: "vault/inbox/untitled", tags: ["capture"], title: "A capture" });
  const { id, turnId } = await newThread([
    tool("mcp__prism__prism_create_note", { path: "vault/tasks/buy-milk", tags: ["task"], content: "x" }),
    // The tool's own result names the new note: no path and no tree feed are needed.
    tool("mcp__parachute__create_note", { content: "z" }, JSON.stringify({ result: JSON.stringify({ id: "n4", path: "vault/inbox/untitled" }) })),
    tool("mcp__parachute_vault__create_note", { tags: ["idea"], metadata: { title: "Kelp farm" }, content: "y" }, JSON.stringify({ result: "created" })),
    say("Three notes."),
  ]);
  await turnSettled(turnId);
  let cards = events(id).filter((e) => e.t === "card").map((e) => (e as { card: Record<string, unknown> }).card);
  assert.deepEqual(cards.map((c) => [c.noteId, c.op]), [["n3", "created"], ["n4", "created"]]);
  assert.ok(treeListener, "an unresolved create watches the tree");
  // An unrelated row (other tags) is NOT attributed; the matching new row is.
  const row = (o: Partial<{ id: string; path: string; tags: string[]; title: string }>) => ({ id: "x", path: null, tags: [], updatedAt: null, creator: null, visibility: "workspace" as const, ...o });
  treeListener!({ kind: "upsert", row: row({ id: "zz", path: "vault/inbox/kelp", tags: ["email"], title: "Kelp farm" }), prev: undefined });
  treeListener!({ kind: "upsert", row: row({ id: "n9", path: "vault/ideas/kelp-farm", tags: ["idea"], title: "Kelp farm" }), prev: undefined });
  cards = events(id).filter((e) => e.t === "card").map((e) => (e as { card: Record<string, unknown> }).card);
  assert.deepEqual(cards.map((c) => [c.noteId, c.op, (c.writer as { kind: string }).kind]), [["n3", "created", "agent"], ["n4", "created", "external"], ["n9", "created", "external"]]);
});

test("Hermes failures map to codes: refused key, unreachable, not configured", async () => {
  fake.status = 401;
  const r = await post("/threads", { prompt: "x" });
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "hermes_auth" });
  fake.status = null;
  fake.throwNext = true;
  const r2 = await post("/threads", { prompt: "x" });
  assert.equal(r2.status, 502);
  assert.deepEqual(await r2.json(), { error: "hermes_unavailable" });
  const saved = process.env.OMNI_HERMES_KEY;
  delete process.env.OMNI_HERMES_KEY;
  try {
    const r3 = await post("/threads", { prompt: "x" });
    assert.equal(r3.status, 503);
    assert.deepEqual(await r3.json(), { error: "hermes_not_configured" });
  } finally {
    process.env.OMNI_HERMES_KEY = saved;
  }
  // Hermes itself throwing mid-turn (`error {message}`) ends the turn with a code, never its message.
  const { id, turnId } = await newThread({ acts: [], end: "raise", failText: "OAuth token revoked for sk-abc" });
  await turnSettled(turnId);
  const res = events(id).find((e) => e.t === "result") as Record<string, unknown>;
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "auth");
  assert.ok(!JSON.stringify(events(id)).includes("OAuth token revoked"));
  assert.equal(getTurn(turnId)!.status, "error");
  assert.equal(getThread(id)!.state, "needs-you");
});

test("completion pushes even while a live SSE subscriber still watches the thread", async () => {
  const { id, turnId } = await newThread(HELD);
  const stream = await req(`/threads/${id}/stream`, { headers: owner() });
  assert.equal(stream.status, 200);
  assert.equal(threadWatched(id), true, "the stream is subscribed before completion");
  const body = stream.text();
  assert.ok(fake.stub.runs.get("run_abc123"));
  fake.stub.runs.get("run_abc123")!();
  await turnSettled(turnId);
  assert.equal(getTurn(turnId)!.status, "done");
  assert.deepEqual(pushes, [["OMNI_THREAD", id]], "a subscriber may be backgrounded or on another device");
  assert.match(await body, /"state":"done"/);
});

test("completion stays quiet if its thread disappears before notification fanout", async () => {
  const { id, turnId } = await newThread(HELD);
  await new Promise((r) => setTimeout(r, 20));
  const unsubscribe = subscribeThread(id, message => {
    if (message.event.t === "status" && message.event.state === "done") {
      db.prepare("DELETE FROM omni_threads WHERE id = ?").run(id);
    }
  });
  try {
    fake.stub.runs.get("run_abc123")!();
    await turnSettled(turnId);
    assert.equal(getThread(id), null);
    assert.deepEqual(pushes, []);
  } finally { unsubscribe(); }
});

test("one turn at a time; idempotent replay; cancel stops the Hermes run", async () => {
  const { id, turnId } = await newThread(HELD);
  await new Promise((r) => setTimeout(r, 20));
  const busy = await post(`/threads/${id}/turns`, { text: "and another" }, { ...owner(), "idempotency-key": key() });
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as { turnId: string }).turnId, turnId);
  const c = await post(`/turns/${turnId}/cancel`, {});
  assert.equal(c.status, 202);
  await turnSettled(turnId);
  assert.ok(fake.calls.some((x) => x.path === "/v1/runs/run_abc123/stop"));
  assert.equal(getTurn(turnId)!.status, "cancelled");
  assert.deepEqual(pushes, [], "cancelled turns do not notify");
  assert.equal((events(id).find((e) => e.t === "result") as { errorCode: string }).errorCode, "cancelled");
  assert.equal(getThread(id)!.state, "waiting");
  // Idempotency: the same key replays the first turn instead of starting a second.
  fake.turn = { acts: [say("ok")] };
  const k = key();
  const t1 = await post(`/threads/${id}/turns`, { text: "next" }, { ...owner(), "idempotency-key": k });
  assert.equal(t1.status, 202);
  const tid = ((await t1.json()) as { turnId: string }).turnId;
  await turnSettled(tid);
  const t2 = await post(`/threads/${id}/turns`, { text: "next" }, { ...owner(), "idempotency-key": k });
  assert.equal(t2.headers.get("Idempotent-Replayed"), "true");
  assert.equal(((await t2.json()) as { turnId: string }).turnId, tid);
  assert.equal(fake.calls.filter((x) => x.path.endsWith("/chat/stream")).length, 2);
});

test("replay across several finished turns is complete (an earlier turn's status does not end the stream)", async () => {
  const { id, turnId } = await newThread([say("one")]);
  await turnSettled(turnId);
  fake.turn = { acts: [say("two")] };
  const t2 = await post(`/threads/${id}/turns`, { text: "next" }, { ...owner(), "idempotency-key": key() });
  await turnSettled(((await t2.json()) as { turnId: string }).turnId);
  const stored = eventsAfter(id, 0).map((e) => e.seq);
  assert.equal(stored.length, 10, "two turns × (status, init, text, result, status)");
  const seqs = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  const all = await (await req(`/threads/${id}/stream`, { headers: owner() })).text();
  assert.deepEqual(seqs(all), stored, "after=0 replays every stored event of both turns");
  const tail = await (await req(`/threads/${id}/stream?after=3`, { headers: owner() })).text();
  assert.deepEqual(seqs(tail), stored.filter((s) => s > 3), "…and so does a reconnect from inside the first turn");
  // A replay requested while a later turn runs carries the history AND follows the live turn to its end.
  fake.turn = { acts: [], end: "hold" };
  const t3 = ((await (await post(`/threads/${id}/turns`, { text: "third" }, { ...owner(), "idempotency-key": key() })).json()) as { turnId: string }).turnId;
  await new Promise((r) => setTimeout(r, 20));
  const live = req(`/threads/${id}/stream?after=0`, { headers: owner() });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await post(`/turns/${t3}/cancel`, {})).status, 202);
  const liveSeqs = seqs(await (await live).text());
  assert.deepEqual(liveSeqs, eventsAfter(id, 0).map((e) => e.seq));
  assert.equal(liveSeqs.length, 14);
});

// ── approvals ───────────────────────────────────────────────────────────────

const draft = { to: ["kevin@example.test"], subject: "Buoy spec", body: "Hi Kevin,\n\nAttached.\n\nBenjamin" };
async function propose(kind = "email", payload: Record<string, unknown> = draft, threadId?: string, extra: Record<string, unknown> = {}): Promise<{ id: string; digest: string }> {
  const r = await post("/hooks/propose", { kind, payload, threadId, summary: "Email Kevin", ...extra }, hook);
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()) as { id: string; digest: string };
}
const decide = (id: string, body: Record<string, unknown>, headers: Record<string, string> = { ...owner(), "idempotency-key": key() }, env?: Record<symbol, unknown>) =>
  post(`/approvals/${id}/decision`, body, headers, env);

test("hooks: loopback + service token only; propose stores the full draft, digest-bound, and pushes", async () => {
  assert.equal((await post("/hooks/propose", { kind: "email", payload: draft }, { ...J, authorization: "Bearer wrong-token-wrong-token" })).status, 403);
  assert.equal((await post("/hooks/propose", { kind: "email", payload: draft }, { ...hook, "x-forwarded-for": "203.0.113.9" })).status, 403, "not over the tunnel");
  assert.equal((await post("/hooks/propose", { kind: "email", payload: draft }, owner())).status, 403, "an owner session is not the service");
  assert.equal((await post("/hooks/propose", { kind: "send-money", payload: {} }, hook)).status, 400);
  const p = await propose();
  assert.equal(p.digest, approvalDigest("email", draft));
  assert.deepEqual(pushes, [["OMNI_APPROVAL", p.id]]);
  const g = (await (await req(`/approvals/${p.id}`, { headers: owner() })).json()) as { approval: Record<string, unknown> };
  assert.deepEqual(g.approval.payload, draft, "full payload, never truncated");
  assert.equal(g.approval.status, "pending");
  assert.deepEqual(g.approval.executor, { name: "proton-send", available: true, enabled: false }, "option B: proton_send.py, off until OMNI_PROTON_SEND is set");
  // Key order does not change the digest.
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
});

test("decide: wrong digest, agent origin, missing key and a disabled executor are all refused; nothing sends", async () => {
  setOmniExecutorForTests(async (o) => {
    execCalls.push(o);
    return { status: "sent", detail: { messageId: "<m@x>" } };
  });
  const p = await propose();
  assert.equal((await decide(p.id, { decision: "send", digest: "0".repeat(64) })).status, 409, "wrong digest");
  const down = await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "idempotency-key": key(), "x-prism-action-origin": "agent" });
  assert.equal(down.status, 403);
  assert.equal(((await down.json()) as { error: string }).error, "human_origin_required");
  const mcp = { [INPROCESS_ACTOR]: { kind: "user", email: config.ownerEmail, role: "owner", vaultId: "primary", grants: [] }, [INPROCESS_CLIENT_KEY]: "mcp:pat:t1" };
  assert.equal((await decide(p.id, { decision: "send", digest: p.digest }, { ...J, "idempotency-key": key() }, mcp)).status, 403, "MCP never decides");
  assert.equal((await decide(p.id, { decision: "send", digest: p.digest }, owner())).status, 400, "Idempotency-Key required");
  const dis = await decide(p.id, { decision: "send", payloadHash: p.digest });
  assert.equal(dis.status, 503);
  assert.equal(((await dis.json()) as { error: string }).error, "executor_disabled");
  assert.equal(execCalls.length, 0);
  const still = (await (await req(`/approvals/${p.id}`, { headers: owner() })).json()) as { approval: { status: string } };
  assert.equal(still.approval.status, "pending", "a disabled executor leaves it pending");
  const t = await propose("tweet", { text: "hello" });
  const un = await decide(t.id, { decision: "send", digest: t.digest });
  assert.equal(((await un.json()) as { error: string }).error, "executor_disabled");
  const audit = auditRows().map((r) => [r.action, r.status, r.error]);
  assert.ok(audit.some((a) => a[2] === "digest_mismatch") && audit.some((a) => a[2] === "human_origin_required") && audit.some((a) => a[2] === "executor_disabled"));
  assert.ok(!JSON.stringify(auditRows()).includes("kevin@"), "audit: ids + digests only");
});

test("decide send: executes ONCE through the executor; replay with the same key; another key → already decided", async (t) => {
  Object.assign(config, { actionsEmailEnabled: true });
  process.env.OMNI_PROTON_SEND = process.execPath; // any existing absolute file = "configured"
  t.after(() => delete process.env.OMNI_PROTON_SEND);
  setOmniExecutorForTests(async (o) => {
    execCalls.push(o);
    return { status: "sent", detail: { executor: "prism-live-actions:email", httpStatus: 200 } };
  });
  const { id: threadId, turnId } = await newThread([say("ok")]);
  await turnSettled(turnId);
  const p = await propose("email", draft, threadId);
  const k = key();
  const r = await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "idempotency-key": k });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { approval: { status: string } }).approval.status, "sent");
  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0]!.payload, draft);
  assert.ok(execCalls[0]!.headers.cookie, "the decider's own credential is what the executor presents");
  const again = await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "idempotency-key": k });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("Idempotent-Replayed"), "true");
  const other = await decide(p.id, { decision: "send", digest: p.digest });
  assert.equal(other.status, 409);
  assert.equal(execCalls.length, 1, "never twice");
  assert.ok(events(threadId).some((e) => e.t === "approval" && (e as { approval: { status: string } }).approval.status === "sent"));
});

test("approvals expire; edit makes a new digest and retires the old one; cancel and revise", async () => {
  const p = await propose("email", draft, undefined, { expiresInSec: 60 });
  const db = (await import("../src/db")).db;
  db.prepare("UPDATE omni_approvals SET expires_at = ? WHERE id = ?").run(Date.now() - 1, p.id);
  const ex = await decide(p.id, { decision: "send", digest: p.digest });
  assert.equal(ex.status, 410);
  const p2 = await propose();
  const edited = { ...draft, body: "Hi Kevin,\n\nSpec attached, v2.\n\nBenjamin" };
  const e = await req(`/approvals/${p2.id}`, { method: "PUT", headers: owner(), body: JSON.stringify({ digest: p2.digest, payload: edited }) });
  assert.equal(e.status, 201);
  const ej = (await e.json()) as { approval: { id: string; digest: string; revises: string } };
  assert.notEqual(ej.approval.digest, p2.digest);
  assert.equal(ej.approval.revises, p2.id);
  assert.equal((await decide(p2.id, { decision: "send", digest: p2.digest })).status, 409, "the old draft is gone");
  assert.equal((await decide(ej.approval.id, { decision: "send", digest: p2.digest })).status, 409, "the old digest does not approve the edit");
  const c = await decide(ej.approval.id, { decision: "cancel", digest: ej.approval.digest });
  assert.equal(c.status, 200);
  assert.equal(((await c.json()) as { approval: { status: string } }).approval.status, "cancelled");
  const pend = (await (await req("/approvals?status=pending", { headers: owner() })).json()) as { approvals: unknown[] };
  assert.equal(pend.approvals.length, 0);
});

// ── hooks/turn, jobs, today ─────────────────────────────────────────────────

test("agent-initiated turn: unread + an ids-only push + a notice on /events", async () => {
  fake.sessions.set("api_1700_abcd1234", { id: "api_1700_abcd1234", title: "Heartbeat" });
  const r = await post("/hooks/turn", { sessionId: "api_1700_abcd1234" }, hook);
  assert.equal(r.status, 202);
  assert.equal(getThread("api_1700_abcd1234")!.unread, 1);
  assert.deepEqual(pushes, [["OMNI_THREAD", "api_1700_abcd1234"]]);
  const l = (await (await req("/threads", { headers: owner() })).json()) as { threads: Array<{ id: string; unread: number; title: string }> };
  assert.deepEqual(l.threads.map((t) => [t.id, t.unread, t.title]), [["api_1700_abcd1234", 1, "Heartbeat"]]);
  // While the app's own turn runs on a thread, a notice for it is not news: no unread, no push.
  const live = await newThread(HELD);
  await new Promise((res) => setTimeout(res, 20));
  pushes.length = 0;
  const quiet = await post("/hooks/turn", { sessionId: live.id }, hook);
  assert.deepEqual([quiet.status, await quiet.json()], [202, { ok: true, threadId: live.id, ignored: "turn_running" }]);
  assert.deepEqual([getThread(live.id)!.unread, pushes], [0, []]);
  await post(`/turns/${live.turnId}/cancel`, {});
  await turnSettled(live.turnId);
});

test("jobs: list (allowlisted fields) and pause through Hermes; bad ids never reach it", async () => {
  const l = (await (await req("/jobs", { headers: owner() })).json()) as { jobs: Array<Record<string, unknown>> };
  assert.deepEqual(l.jobs, [{ id: "abcdef012345", name: "Brief", schedule: { kind: "cron", expr: "0 7 * * *", display: "0 7 * * *" }, enabled: true }]);
  const p = await post("/jobs/abcdef012345/pause", {});
  assert.equal(p.status, 200);
  assert.equal(((await p.json()) as { job: { enabled: boolean } }).job.enabled, false);
  const before = fake.calls.length;
  assert.equal((await post("/jobs/../../x/pause", {})).status, 404);
  assert.equal((await post("/jobs/abcdef012345/delete", {})).status, 404);
  assert.equal(fake.calls.length, before);
});

test("today degrades per section: approvals + in-flight still answer when the query routes are unreachable", async () => {
  const p = await propose();
  const r = await req("/today?date=2026-10-08", { headers: owner() });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { date: string; agenda: unknown; tasks: unknown; needsYou: { approvals: Array<{ id: string }> }; errors: Record<string, string> };
  assert.equal(j.date, "2026-10-08");
  assert.equal(j.agenda, null);
  assert.ok(j.errors.agenda && j.errors.tasks);
  assert.deepEqual(j.needsYou.approvals.map((a) => a.id), [p.id]);
  assert.equal((await req("/today?date=tomorrow", { headers: owner() })).status, 400);
});

// ── first-run fix: a thread Hermes no longer has ────────────────────────────────────────

const DONE: StubAct[] = [say("ok")];
type ListedThread = { id: string; gone: boolean; archived: boolean; title: string | null };
const listThreadsOf = async (q = "") => ((await (await req(`/threads${q}`, { headers: owner() })).json()) as { threads: ListedThread[]; hermes: string });

test("a thread Hermes forgot: the list marks it gone, opening it is a clear 404, and it can be removed (archived locally)", async () => {
  const kept = await newThread(DONE);
  await turnSettled(kept.turnId);
  const lost = await newThread(DONE);
  await turnSettled(lost.turnId);
  // Hermes loses one session (a reset, a prune; the dev stub restarting without its file).
  fake.sessions.delete(lost.id);

  const l = await listThreadsOf();
  assert.equal(l.hermes, "ok");
  assert.deepEqual(Object.fromEntries(l.threads.map((t) => [t.id, t.gone])), { [kept.id]: false, [lost.id]: true });

  // Opening it: the documented 404 not_found, flagged, and nothing is read as unread-cleared.
  const open = await req(`/threads/${lost.id}`, { headers: owner() });
  assert.equal(open.status, 404);
  assert.deepEqual(await open.json(), { error: "not_found", detail: "the agent no longer has this conversation", gone: true });
  // An id NEITHER side knows is the plain 404 (no `gone`: there is no row to remove).
  assert.deepEqual(await (await req("/threads/omni_neverexisted", { headers: owner() })).json(), { error: "not_found" });

  // Remove it from the list: the gateway's own row is archived; Hermes is not written to.
  const before = fake.calls.length;
  const rm = await req(`/threads/${lost.id}`, { method: "PATCH", headers: owner(), body: JSON.stringify({ archived: true }) });
  assert.equal(rm.status, 200);
  const removed = ((await rm.json()) as { thread: ListedThread }).thread;
  assert.equal(removed.archived, true);
  assert.equal(removed.gone, true);
  assert.deepEqual(fake.calls.slice(before).map((c) => `${c.method} ${c.path}`), [`GET /api/sessions/${lost.id}`], "only the lookup; no PATCH reaches Hermes");
  assert.deepEqual((await listThreadsOf()).threads.map((t) => t.id), [kept.id]);
  assert.deepEqual((await listThreadsOf("?archived=1")).threads.map((t) => t.id).sort(), [kept.id, lost.id].sort());

  // A PATCH for an id neither side knows still creates nothing.
  const none = await req("/threads/omni_neverexisted", { method: "PATCH", headers: owner(), body: JSON.stringify({ archived: true }) });
  assert.equal(none.status, 404);
  assert.equal(getThread("omni_neverexisted"), null);
});

test("gone is only claimed on proof: not while Hermes is unreachable, not from a truncated list, not for a thread with a turn running", async () => {
  const a = await newThread(DONE);
  await turnSettled(a.turnId);
  fake.sessions.delete(a.id);
  // Hermes unreachable: local rows are listed, none is called gone.
  fake.throwNext = true;
  const down = await listThreadsOf();
  assert.equal(down.hermes, "unavailable");
  assert.deepEqual(down.threads.map((t) => [t.id, t.gone]), [[a.id, false]]);
  // More sessions than one page: the list is not complete, so absence proves nothing.
  for (let i = 0; i < 201; i++) fake.sessions.set(`api_${i}_abcd1234`, { id: `api_${i}_abcd1234`, title: null, last_active: 1700000000 + i });
  const truncated = await listThreadsOf();
  assert.equal(truncated.threads.find((t) => t.id === a.id)?.gone, false);
  for (let i = 0; i < 201; i++) fake.sessions.delete(`api_${i}_abcd1234`);
  assert.equal((await listThreadsOf()).threads.find((t) => t.id === a.id)?.gone, true);
  // A thread whose turn is running here is alive, whatever the list says.
  const live = await newThread({ acts: [], end: "hold" });
  fake.sessions.delete(live.id);
  assert.equal((await listThreadsOf()).threads.find((t) => t.id === live.id)?.gone, false);
  await post(`/turns/${live.turnId}/cancel`, {});
  await turnSettled(live.turnId);
});

// ── what a real Hermes does that the first stub did not (v0.20.5, scripts/omni-contract.ts) ──

test("titles: Hermes wants them unique and ≤ 100 characters — the gateway keeps its own and never fails for it", async () => {
  const a = await newThread(DONE, "Call Dana");
  await turnSettled(a.turnId);
  const b = await newThread(DONE, "Call Dana");
  await turnSettled(b.turnId);
  const creates = fake.calls.filter((c) => c.method === "POST" && c.path === "/api/sessions").map((c) => (c.body as { title?: string }).title);
  assert.deepEqual(creates, ["Call Dana", "Call Dana", undefined], "refused for its title (invalid_title), then created untitled");
  assert.equal(fake.sessions.get(b.id)!.title, null);
  const l = await listThreadsOf();
  assert.deepEqual(l.threads.map((t) => t.title), ["Call Dana", "Call Dana"], "both threads carry the title the person gave");
  // Renaming to a title another session has: Hermes refuses, the gateway's row takes it; the pin still reaches Hermes.
  const r = await req(`/threads/${b.id}`, { method: "PATCH", headers: owner(), body: JSON.stringify({ title: "Call Dana", pinned: true }) });
  assert.equal(r.status, 200);
  const t = ((await r.json()) as { thread: { title: string; pinned: boolean } }).thread;
  assert.deepEqual([t.title, t.pinned], ["Call Dana", true]);
  assert.equal(fake.sessions.get(b.id)!.pinned, true);
  // A long title: Hermes gets its first 100 characters, the gateway the whole of it.
  const long = "x".repeat(150);
  const r2 = await req(`/threads/${a.id}`, { method: "PATCH", headers: owner(), body: JSON.stringify({ title: long }) });
  assert.equal(((await r2.json()) as { thread: { title: string } }).thread.title, long);
  assert.equal(String(fake.sessions.get(a.id)!.title).length, 100);
});

test("an archived thread is not `gone`: Hermes leaves archived sessions out of its list (and archives old ones itself)", async () => {
  const a = await newThread(DONE);
  await turnSettled(a.turnId);
  const b = await newThread(DONE);
  await turnSettled(b.turnId);
  // Archived from the app.
  assert.equal((await req(`/threads/${a.id}`, { method: "PATCH", headers: owner(), body: JSON.stringify({ archived: true }) })).status, 200);
  assert.equal(fake.sessions.get(a.id)!.archived, true);
  // Archived by Hermes on its own (its auto-archive sweep): the gateway's row does not know.
  fake.sessions.get(b.id)!.archived = true;
  assert.deepEqual((await listThreadsOf()).threads.map((t) => t.id), [], "neither is in the default list");
  const all = (await listThreadsOf("?archived=1")).threads;
  assert.deepEqual(all.map((t) => [t.id, t.gone, t.archived]).sort(), [[a.id, false, true], [b.id, false, true]].sort(), "both are there, archived, not gone");
  // Opening one still works, and un-archiving brings it back.
  assert.equal((await req(`/threads/${b.id}`, { headers: owner() })).status, 200);
  assert.equal((await req(`/threads/${b.id}`, { method: "PATCH", headers: owner(), body: JSON.stringify({ archived: false }) })).status, 200);
  assert.deepEqual((await listThreadsOf()).threads.map((t) => [t.id, t.gone]), [[b.id, false]]);
  // The lookups are remembered: a polled list does not ask Hermes again for every archived thread.
  const before = fake.calls.length;
  await listThreadsOf("?archived=1");
  await listThreadsOf("?archived=1");
  assert.deepEqual(fake.calls.slice(before).map((c) => c.path.split("?")[0]), ["/api/sessions", "/api/sessions"]);
});

test("jobs: a skill goes to Hermes as `skills`; a job Hermes will not take is the request's fault (400), not an outage", async () => {
  const r = await post("/jobs", { name: "Brief", schedule: "0 7 * * *", skill: "omni-briefing" }, { ...owner(), "idempotency-key": key() });
  assert.equal(r.status, 201);
  const sent = fake.calls.find((c) => c.method === "POST" && c.path === "/api/jobs")!.body as Record<string, unknown>;
  assert.deepEqual(sent, { name: "Brief", schedule: "0 7 * * *", skills: ["omni-briefing"], deliver: "local" });
  const job = ((await r.json()) as { job: { schedule: { display: string }; skills: string[]; state: string } }).job;
  assert.deepEqual([job.schedule.display, job.skills, job.state], ["0 7 * * *", ["omni-briefing"], "scheduled"]);
  const bad = await post("/jobs", { name: "Brief", schedule: "whenever", prompt: "hello" }, { ...owner(), "idempotency-key": key() });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as {error:string}).error, "hermes_rejected");
  // Pause: disabled + paused, and still listed (the gateway asks with include_disabled).
  const id = fake.jobs.find((j) => j.name === "Brief" && Array.isArray(j.skills))!.id as string;
  const p = ((await (await post(`/jobs/${id}/pause`, {})).json()) as { job: { enabled: boolean; state: string } }).job;
  assert.deepEqual([p.enabled, p.state], [false, "paused"]);
  const l = (await (await req("/jobs", { headers: owner() })).json()) as { jobs: Array<{ id: string }> };
  assert.ok(l.jobs.some((j) => j.id === id));
});

test("a cancel that lands before Hermes has named the run waits for the run id, then stops it", async () => {
  fake.turn = HELD;
  const inner = fake.stub.fetch;
  setHermesFetchForTests(async (url, init) => {
    fake.calls.push({ method: init.method ?? "GET", path: new URL(url).pathname, auth: null, body: undefined });
    // The chat response (and with it the first frame) takes a moment to arrive.
    if (url.endsWith("/chat/stream")) await new Promise((r) => setTimeout(r, 80));
    return inner(url, init);
  });
  const r = await post("/threads", { prompt: "x" });
  const { thread, turnId } = (await r.json()) as { thread: { id: string }; turnId: string };
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(getTurn(turnId)!.runId, null, "no frame yet: the run has no id here");
  assert.equal((await post(`/turns/${turnId}/cancel`, {})).status, 202);
  await turnSettled(turnId);
  assert.equal((events(thread.id).find((e) => e.t === "result") as { errorCode: string }).errorCode, "cancelled");
  assert.ok(fake.calls.some((c) => c.path === "/v1/runs/run_abc123/stop"), "the run was stopped by id");
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(fake.stub.runs.size, 0, "…and is not running in Hermes any more");
});

test("a run the gateway gives up on (Hermes silent past the idle limit) is stopped, not left running", async () => {
  process.env.OMNI_HERMES_STREAM_IDLE_MS = "60";
  try {
    const { id, turnId } = await newThread({ acts: [{ wait: 5_000 }, say("too late")] });
    await turnSettled(turnId);
    assert.equal((events(id).find((e) => e.t === "result") as { errorCode: string }).errorCode, "hermes_timeout");
    assert.ok(fake.calls.some((c) => c.path === "/v1/runs/run_abc123/stop"));
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(fake.stub.runs.size, 0);
  } finally {
    delete process.env.OMNI_HERMES_STREAM_IDLE_MS;
  }
});

test("after a restart: the runs of turns left `running` are asked to stop", async () => {
  const { turnId } = await newThread(HELD);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(runningRunIds(), ["run_abc123"]);
  stopOrphanedRuns(runningRunIds());
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(fake.stub.runs.size, 0, "the run ended in Hermes");
  await turnSettled(turnId);
});

test("the turn is read to Hermes' own end of stream (`done`), not hung up on at run.completed", async () => {
  let sawEnd = false;
  const inner = fake.stub.fetch;
  setHermesFetchForTests(async (url, init) => {
    const res = await inner(url, init);
    if (!url.endsWith("/chat/stream") || !res.body) return res;
    const reader = res.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          const c = await reader.read();
          if (c.done) {
            sawEnd = true;
            return ctrl.close();
          }
          ctrl.enqueue(c.value);
        },
        cancel: () => void reader.cancel(),
      }),
      { status: res.status, headers: res.headers },
    );
  });
  const { turnId } = await newThread([say("ok")]);
  await turnSettled(turnId);
  assert.equal(sawEnd, true);
  assert.equal(getTurn(turnId)!.status, "done");
});

test("health: Hermes reachability, whether the plugin's hooks can be reached, and who would send — no secret", async () => {
  assert.equal((await req("/health")).status, 401, "owner only, like every app route");
  const saved = config.trustLocal;
  try {
    Object.assign(config, { trustLocal: true });
    const ok = (await (await req("/health", { headers: owner() })).json()) as Record<string, unknown>;
    assert.equal(ok.hermes, "ok");
    assert.deepEqual(ok.hooks, { serviceToken: true, trustLocal: true, ready: true });
    assert.deepEqual((ok.executors as Record<string, unknown>).email, { name: "proton-send", available: true, enabled: false });
    assert.deepEqual((ok.executors as Record<string, unknown>).tweet, { name: "approved-tweet", available: true, enabled: false });
    assert.equal(ok.runningTurns, 0);
    assert.ok(!JSON.stringify(ok).includes(process.env.OMNI_SERVICE_TOKEN!) && !JSON.stringify(ok).includes(process.env.OMNI_HERMES_KEY!));
    // The server does not trust loopback (an https origin without TRUST_LOCAL): the plugin's calls would be refused.
    Object.assign(config, { trustLocal: false });
    assert.deepEqual(((await (await req("/health", { headers: owner() })).json()) as { hooks: unknown }).hooks, { serviceToken: true, trustLocal: false, ready: false });
    fake.status = 401;
    assert.equal(((await (await req("/health", { headers: owner() })).json()) as { hermes: string }).hermes, "hermes_auth");
    fake.status = null;
    fake.throwNext = true;
    assert.equal(((await (await req("/health", { headers: owner() })).json()) as { hermes: string }).hermes, "hermes_unavailable");
  } finally {
    Object.assign(config, { trustLocal: saved });
  }
});

test("OMNI_EXECUTORS=off: nothing Omni proposes is sent, even with every family flag on", async (t) => {
  Object.assign(config, { actionsEmailEnabled: true, actionsCalendarEnabled: true, actionsMatrixEnabled: true });
  process.env.OMNI_PROTON_SEND = process.execPath;
  process.env.OMNI_EXECUTORS = "off";
  t.after(() => {
    delete process.env.OMNI_PROTON_SEND;
    delete process.env.OMNI_EXECUTORS;
  });
  setOmniExecutorForTests(async (o) => {
    execCalls.push(o);
    return { status: "sent", detail: {} };
  });
  const h = (await (await req("/health", { headers: owner() })).json()) as { executors: Record<string, { enabled: boolean }> };
  // Every sender is off. `command` is not a sender (Hermes runs its own paused call; OMNI_COMMAND_APPROVALS is its switch).
  assert.deepEqual(Object.entries(h.executors).map(([k, e]) => [k, e.enabled]), [["email", false], ["email-reply", false], ["message", false], ["calendar-rsvp", false], ["calendar-invite", false], ["tweet", false], ["wallet-proposal", false], ["command", true]]);
  for (const [kind, payload] of [["email", draft], ["message", { roomId: "!r:example.test", body: "hi" }], ["calendar-invite", { title: "Sync", start: "2026-10-09T17:00:00Z", end: "2026-10-09T17:30:00Z" }]] as const) {
    const p = await propose(kind, payload as Record<string, unknown>);
    const r = await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "idempotency-key": key() });
    assert.equal(r.status, 503, kind);
    assert.equal(((await r.json()) as { error: string }).error, "executor_disabled", kind);
  }
  assert.equal(execCalls.length, 0, "no executor was called");
  // Without the switch the same flags would send.
  delete process.env.OMNI_EXECUTORS;
  const p = await propose();
  assert.equal((await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "idempotency-key": key() })).status, 200);
  assert.equal(execCalls.length, 1);
});

test("run.completed that carries the WHOLE conversation: an earlier turn's failed write does not touch this turn's", async () => {
  const now = Date.now() / 1000;
  const { id, turnId } = await newThread([
    raw("tool.started", { tool_name: "mcp__prism__prism_update_note", args: { id: "n1", metadata: { status: "done" } } }),
    raw("tool.completed", { tool_name: "mcp__prism__prism_update_note" }),
    raw("assistant.completed", { content: "Updated." }),
    raw("run.completed", {
      messages: [
        // An hour ago, the same tool failed — in another turn.
        { role: "assistant", content: "", tool_calls: [{ id: "call_old", function: { name: "mcp__prism__prism_update_note", arguments: "{}" } }], timestamp: now - 3600 },
        { role: "tool", tool_call_id: "call_old", tool_name: "mcp__prism__prism_update_note", content: '{"error":"locked"}', timestamp: now - 3600 },
        // This turn.
        { role: "assistant", content: "", tool_calls: [{ id: "call_new", function: { name: "mcp__prism__prism_update_note", arguments: '{"id":"n1"}' } }], timestamp: now + 1 },
        { role: "tool", tool_call_id: "call_new", tool_name: "mcp__prism__prism_update_note", content: '{"result":"ok"}', timestamp: now + 1 },
        { role: "assistant", content: "Updated.", timestamp: now + 2 },
      ],
    }),
  ]);
  await turnSettled(turnId);
  const ev = events(id);
  assert.deepEqual(ev.filter((e) => e.t === "tool_result").map((e) => (e as { ok: boolean }).ok), [true], "not corrected by the old failure");
  assert.equal(ev.filter((e) => e.t === "card").length, 1);
});

test("approved tweet uses the exact human-reviewed draft once; no send before approval", async (t) => {
  const { setTweetSpawnerForTests } = await import("../src/omni/tweet-send");
  process.env.OMNI_TWEET_SEND = process.execPath;
  setOmniExecutorForTests(null);
  const inputs: string[] = [];
  setTweetSpawnerForTests(async (_cmd, _args, options) => {
    inputs.push(options.input);
    return { code: 0, signal: null, stdout: '{"status":"sent","postId":"123"}', stderr: "", timedOut: false };
  });
  t.after(() => { delete process.env.OMNI_TWEET_SEND; setTweetSpawnerForTests(null); });
  const text = '  Exact approved tweet.\nNo rewrite.  ';
  const p = await propose("tweet", { text });
  assert.equal(inputs.length, 0);
  assert.equal((await decide(p.id, { decision: "send", digest: "0".repeat(64) })).status, 409);
  assert.equal((await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "x-prism-action-origin": "agent", "idempotency-key": key() })).status, 403);
  assert.equal(inputs.length, 0);
  const headers = { ...owner(), "idempotency-key": key() };
  const result = await decide(p.id, { decision: "send", digest: p.digest }, headers);
  assert.equal(result.status, 200);
  assert.equal(((await result.json()) as { approval: { status: string } }).approval.status, "sent");
  assert.deepEqual(inputs, [JSON.stringify({ text })]);
  await decide(p.id, { decision: "send", digest: p.digest }, headers);
  assert.equal(inputs.length, 1, "replayed tap never reposts");
});

test("jobs run refuses script jobs and jobs without approval routing", async () => {
 fake.jobs[0].no_agent = true; fake.jobs[0].script = "/reviewed/sweep.py";
 assert.equal((await post("/jobs/abcdef012345/run", {})).status,403);
 delete fake.jobs[0].no_agent; delete fake.jobs[0].script;
 fake.jobs[0].deliver="local"; fake.jobs[0].origin={platform:"api_server",chat_id:"api"};
 assert.equal((await post("/jobs/abcdef012345/run", {})).status,409);
 assert.equal(fake.calls.some(c=>c.path.endsWith("/run")),false);
});
test("jobs edits refuse script runners and unsupported fields", async () => {
 fake.jobs[0].no_agent=true;
 assert.equal((await req("/jobs/abcdef012345",{method:"PUT",headers:owner(),body:JSON.stringify({prompt:"replace script"})})).status,403);
 assert.equal((await req("/jobs/abcdef012345",{method:"PUT",headers:owner(),body:JSON.stringify({script:"/tmp/x"})})).status,400);
 assert.equal(fake.calls.some(c=>c.method==="PATCH"),false);
});
test("job creation rejects outward delivery before reaching Hermes", async () => {
 assert.equal((await post("/jobs",{name:"Outbound",schedule:"0 8 * * *",prompt:"hello",deliver:"telegram"})).status,400);
 assert.equal(fake.calls.some(c=>c.method==="POST"&&c.path==="/api/jobs"),false);
});

test("legacy resume and edit cannot enable unguarded recurring actions", async () => {
 fake.jobs[0].deliver="local"; fake.jobs[0].origin={platform:"api_server",chat_id:"api"};
 assert.equal((await post("/jobs/abcdef012345/resume",{})).status,409);
 assert.equal((await req("/jobs/abcdef012345",{method:"PUT",headers:owner(),body:JSON.stringify({name:"Changed"})})).status,409);
 fake.jobs[0].monitor={script:"unreviewed.sh"};
 assert.equal((await post("/jobs/abcdef012345/run",{})).status,403);
 assert.equal(fake.calls.some(c=>c.path.endsWith("/resume") || c.path.endsWith("/run") || c.method==="PATCH"),false);
});
test("job creation retries retain a single approval conversation and job", async () => {
 const headers={...owner(),"idempotency-key":key()};
 const body={name:"Local job",schedule:"0 8 * * *",prompt:"Review tasks"};
 const first=await post("/jobs",body,headers);
 assert.equal(first.status,201);
 const created=await first.json() as {job:{id:string;origin:{chat_id:string};deliver:string};threadId:string};
 assert.equal(created.job.deliver,"local");
 assert.equal(created.job.origin.chat_id,created.threadId);
 assert.equal(getThread(created.threadId)?.state,"scheduled");
 const retry=await post("/jobs",body,headers);
 assert.equal(retry.status,201); assert.deepEqual(await retry.json(),created);
 assert.equal(fake.calls.filter(c=>c.method==="POST"&&c.path==="/api/jobs").length,1);
 assert.equal((await post("/jobs",{...body,prompt:"Different"},headers)).status,409);
});
