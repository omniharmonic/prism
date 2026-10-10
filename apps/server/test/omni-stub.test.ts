/**
 * The stub Hermes (scripts/lib/hermes-stub.ts) behind the REAL gateway — the same pair
 * `scripts/omni-dev.sh` runs on the laptop, here without sockets: the stub answers the
 * client's fetch seam and its omni-bridge calls go to the gateway's hook routes in
 * process. Pins the default script's scenarios and the stub's own HTTP rules.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.OMNI_ENABLED = "true";
// A cancel keeps asking Hermes to stop; in tests it gives up quickly.
process.env.OMNI_HERMES_STOP_RETRY_MS = "1500";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:18642";
process.env.OMNI_HERMES_KEY = "stub-test-key-0123456789abcdef";
process.env.OMNI_SERVICE_TOKEN = "stub-service-token-0123456789";
delete process.env.OMNI_PROTON_SEND;

import { config } from "../src/config";
import { omniApi } from "../src/routes/omni";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { setOmniRecordSourcesForTests } from "../src/omni/records";
import { setOmniPusherForTests } from "../src/omni/bus";
import { turnSettled } from "../src/omni/turns";
import { eventsAfter, getThread, getTurn, resetOmniStoreForTests } from "../src/omni/store";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { createHermesStub, defaultScript, httpBridge, SCENARIOS, STUB_PROPOSALS, type HermesStub, type StubTurn } from "../scripts/lib/hermes-stub";

const J = { "content-type": "application/json" };
const KEY = process.env.OMNI_HERMES_KEY!;
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
const hook = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
let stub: HermesStub;
let n = 0;

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
  setOmniRecordSourcesForTests({ resolver: async () => null, subscriber: async () => () => {} });
  setOmniPusherForTests(async () => {});
  Object.assign(config, { actionsEmailEnabled: false, actionsCalendarEnabled: false, actionsMatrixEnabled: false });
  stub = createHermesStub({
    key: KEY,
    // No pacing in tests: the same turn, all at once (a pause becomes a few milliseconds).
    script: (ctx) => quick(defaultScript(ctx)),
    // The omni-bridge plugin's calls, to the gateway's hook routes in process.
    bridge: {
      propose: async (body) => {
        const r = await omniApi.request("/hooks/propose", { method: "POST", headers: hook, body: JSON.stringify(body) });
        const j = (await r.json()) as { id?: string };
        return { ok: r.ok, status: r.status, id: j.id };
      },
      turn: async (sessionId) => {
        const r = await omniApi.request("/hooks/turn", { method: "POST", headers: hook, body: JSON.stringify({ sessionId }) });
        return { ok: r.ok, status: r.status };
      },
      approval: async (id) => {
        const r = await omniApi.request(`/hooks/approvals/${id}`, { headers: hook });
        return { ok: r.ok, status: ((await r.json()) as { status?: string }).status };
      },
      result: async (id, ok) => ({ ok: (await omniApi.request(`/hooks/approvals/${id}/result`, { method: "POST", headers: hook, body: JSON.stringify({ ok }) })).ok }),
    },
  });
  setHermesFetchForTests(stub.fetch);
});
after(() => {
  setHermesFetchForTests(null);
  setOmniPusherForTests(null);
});

/** The same turn without its pacing. */
const quick = (t: StubTurn): StubTurn => ({ ...t, delayMs: 0, startMs: t.startMs ? 60 : undefined, acts: t.acts.map((a) => ("wait" in a ? { wait: Math.max(5, Math.round(a.wait / 100)) } : a)) });
const post = (path: string, body: unknown, headers: Record<string, string> = owner()) => omniApi.request(path, { method: "POST", headers, body: JSON.stringify(body) });
const events = (id: string) => eventsAfter(id, 0).map((e) => e.payload as { t: string } & Record<string, unknown>);
const turnEvents = (id: string, turnId: string) => eventsAfter(id, 0).filter((e) => e.turnId === turnId).map((e) => e.payload as { t: string } & Record<string, unknown>);
async function thread(prompt: string): Promise<{ id: string; turnId: string }> {
  const r = await post("/threads", { prompt });
  assert.equal(r.status, 201, await r.clone().text());
  const j = (await r.json()) as { thread: { id: string }; turnId: string };
  return { id: j.thread.id, turnId: j.turnId };
}
async function turn(id: string, text: string): Promise<string> {
  const r = await post(`/threads/${id}/turns`, { text }, { ...owner(), "idempotency-key": `stub-test-${Date.now()}-${++n}` });
  assert.equal(r.status, 202, await r.clone().text());
  const turnId = ((await r.json()) as { turnId: string }).turnId;
  await turnSettled(turnId);
  return turnId;
}
const resultOf = (id: string, turnId: string) => turnEvents(id, turnId).find((e) => e.t === "result")!;

test("reply: text, a tool call, the final text; the transcript is kept", async () => {
  const { id, turnId } = await thread("Hello there");
  await turnSettled(turnId);
  // What the model said before the tool is its own block; the answer is another.
  assert.deepEqual(events(id).map((e) => e.t), ["status", "init", "text", "tool_use", "tool_result", "text", "result", "status"]);
  assert.equal(events(id)[2]!.text, "Let me look. ");
  assert.equal(events(id)[3]!.name, "prism_search_notes", "the mcp__server__ prefix is dropped");
  assert.match(String(events(id)[5]!.text), /This is the stub Hermes\. You said: “Hello there”/);
  assert.equal(getTurn(turnId)!.status, "done");
  assert.match(getTurn(turnId)!.runId ?? "", /^run_[a-f0-9]{32}$/);
  const d = (await (await omniApi.request(`/threads/${id}`, { headers: owner() })).json()) as { messages: Array<{ role: string; text?: string; toolName?: string }>; thread: { messageCount: number; preview: string } };
  // Hermes' rows: user, assistant (text + the tool call), tool, assistant. Nothing is dropped
  // here because the tool-call row carries text.
  assert.deepEqual(d.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(d.messages[0]!.text, "Hello there");
  assert.equal(d.messages[2]!.toolName, "prism_search_notes");
  assert.ok(!JSON.stringify(d).includes("3 notes"), "a tool's result never reaches the app");
  assert.equal(d.thread.messageCount, 4);
});

test("approval: the stub proposes through the hook the way omni-bridge does; a send is refused while the executor is off", async () => {
  const { id, turnId } = await thread("stub:approval please draft it");
  await turnSettled(turnId);
  const ev = events(id);
  assert.deepEqual(ev.map((e) => e.t), ["status", "init", "text", "tool_use", "approval", "tool_result", "text", "result", "status"]);
  assert.equal(ev[3]!.name, "omni_propose", "the plugin's tool, by its real name");
  const ap = ev[4]!.approval as { id: string; digest: string; status: string; payload: unknown; threadId: string; executor: { name: string; enabled: boolean } };
  assert.equal(ap.status, "pending");
  assert.equal(ap.threadId, id, "the session id is the thread id");
  assert.deepEqual(ap.payload, STUB_PROPOSALS.email!.payload);
  assert.deepEqual(ap.executor, { name: "proton-send", available: true, enabled: false });
  assert.equal(getThread(id)!.state, "needs-you");
  const r = await post(`/approvals/${ap.id}/decision`, { decision: "send", digest: ap.digest }, { ...owner(), "idempotency-key": "stub-decide-0001" });
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, "executor_disabled");
  // Every kind has a draft the gateway's validator accepts.
  for (const kind of Object.keys(STUB_PROPOSALS)) {
    const t = await turn(id, `stub:approval:${kind}`);
    assert.equal(resultOf(id, t).ok, true, kind);
  }
  const kinds = events(id).filter((e) => e.t === "approval").map((e) => (e.approval as { kind: string }).kind);
  assert.deepEqual(kinds, ["email", ...Object.keys(STUB_PROPOSALS)]);
  // The gateway's own "revise" turn names the tool: the stub proposes again.
  assert.equal(defaultScript({ sessionId: id, message: "Revise the email draft. Propose the new draft with omni_propose; do not send anything.", runId: "run_x", stub }).acts.some((a) => "tool" in a && a.tool === "omni_propose"), true);
});

test("the gateway hook is down: the plugin's tool reports an error — Hermes still says tool.completed, the gateway shows it failed", async () => {
  const bridge = stub.bridge!;
  stub.bridge = { ...bridge, propose: async () => ({ ok: false, status: 0 }) };
  const { id, turnId } = await thread("stub:approval");
  await turnSettled(turnId);
  const ev = events(id);
  assert.ok(!ev.some((e) => e.t === "approval"), "nothing was proposed");
  const results = ev.filter((e) => e.t === "tool_result");
  assert.deepEqual(results.map((e) => e.ok), [true, false], "announced ok (all Hermes' stream says), then corrected from the tool's row");
  assert.equal(results[0]!.toolUseId, results[1]!.toolUseId);
  assert.equal(resultOf(id, turnId).ok, true, "the turn itself completed: the model told the person it could not propose");
});

test("failure scenarios map to the gateway's codes; Hermes' text never reaches the app", async () => {
  const { id, turnId } = await thread("first");
  await turnSettled(turnId);
  const cases: Array<[string, string]> = [
    ["stub:error", "agent_failed"],
    ["stub:error:auth_failed", "auth"],
    ["stub:error:rate_limit", "usage_limit"],
    ["stub:error:budget_exceeded", "budget"],
    ["stub:error:timeout", "timeout"],
    ["stub:raise", "agent_failed"],
    ["stub:empty", "agent_failed"],
    ["stub:drop", "hermes_unavailable"],
    ["stub:truncate", "stream_ended"],
    ["stub:http:401", "hermes_auth"],
    ["stub:http:500", "hermes_unavailable"],
  ];
  for (const [text, code] of cases) {
    const t = await turn(id, text);
    assert.equal(resultOf(id, t).errorCode, code, text);
    assert.equal(getTurn(t)!.status, "error", text);
    // A failed model call arrives as `assistant.completed` text: it must not become a `text` event.
    if (text.startsWith("stub:error") || text === "stub:empty") assert.ok(!turnEvents(id, t).some((e) => e.t === "text"), `${text}: Hermes' error text was shown as an answer`);
  }
  const all = JSON.stringify(events(id));
  for (const leak of ["simulated", "Incorrect API key", "rate limit exceeded", "insufficient credits", "No reply", "Hermes raised"]) assert.ok(!all.includes(leak), leak);
  // And the thread still works afterwards.
  assert.equal(resultOf(id, await turn(id, "again")).ok, true);
});

test("slow: holds until cancelled; the stop reaches the stub's run", async () => {
  const { id, turnId } = await thread("first");
  await turnSettled(turnId);
  const r = await post(`/threads/${id}/turns`, { text: "stub:slow:200" }, { ...owner(), "idempotency-key": "stub-slow-0001" });
  const slow = ((await r.json()) as { turnId: string }).turnId;
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(stub.runs.size, 1, "the run is open");
  assert.equal((await post(`/turns/${slow}/cancel`, {})).status, 202);
  await turnSettled(slow);
  assert.equal(resultOf(id, slow).errorCode, "cancelled");
  assert.equal(getThread(id)!.state, "waiting");
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(stub.runs.size, 0, "the run ended in the stub");
});

test("slowstart: a cancel in the run's first moments is refused by Hermes — the gateway asks again until the run stops", async () => {
  const { id, turnId } = await thread("first");
  await turnSettled(turnId);
  const stops: number[] = [];
  setHermesFetchForTests(async (url, init) => {
    const res = await stub.fetch(url, init);
    if (url.endsWith("/stop")) stops.push(res.status);
    return res;
  });
  const r = await post(`/threads/${id}/turns`, { text: "stub:slowstart" }, { ...owner(), "idempotency-key": "stub-slowstart-0001" });
  const slow = ((await r.json()) as { turnId: string }).turnId;
  await new Promise((res) => setTimeout(res, 15));
  assert.equal(stub.runs.size, 0, "the run exists but cannot be stopped yet");
  assert.equal((await post(`/turns/${slow}/cancel`, {})).status, 202);
  await turnSettled(slow);
  assert.equal(resultOf(id, slow).errorCode, "cancelled");
  assert.ok(stops.length >= 2 && stops[0] === 404 && stops[stops.length - 1] === 200, `stop answers: ${stops.join(", ")}`);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(stub.runs.size, 0, "the run was stopped — it did not go on unobserved");
  const said = (stub.transcripts.get(id) ?? []).filter((m) => m.role === "assistant").map((m) => String(m.content)).join("");
  assert.ok(!said.includes("step 120 of 120"));
});

test("card, toolfail and blocked: a card only for a write whose row says it worked", async () => {
  setOmniRecordSourcesForTests({ resolver: async (ref) => (ref.id === "n1" ? { id: "n1", path: "vault/tasks/x", tags: ["task"], title: "X", updatedAt: "2026-10-08T10:00:00Z" } : null), subscriber: async () => () => {} });
  const { id, turnId } = await thread("stub:card:n1");
  await turnSettled(turnId);
  const card = events(id).find((e) => e.t === "card")!.card as { noteId: string; op: string };
  assert.deepEqual([card.noteId, card.op], ["n1", "updated"]);
  assert.deepEqual(events(id).map((e) => e.t), ["status", "init", "tool_use", "tool_result", "card", "text", "result", "status"], "the card arrives while the turn runs");

  // The same tool, failing: Hermes' stream is identical; only the tool's row differs.
  const f = await turn(id, "stub:toolfail:n1");
  const fe = turnEvents(id, f);
  assert.deepEqual(fe.map((e) => e.t), ["status", "init", "tool_use", "tool_result", "tool_result", "text", "result", "status"]);
  assert.deepEqual(fe.filter((e) => e.t === "tool_result").map((e) => e.ok), [true, false]);
  assert.ok(!fe.some((e) => e.t === "card"), "a failed write yields no card");
  assert.equal(events(id).filter((e) => e.t === "card").length, 1);

  // A tool a plugin vetoed (omni-bridge refusing `terminal`): Hermes sends no frame for it.
  const b = await turn(id, "stub:blocked");
  assert.deepEqual(turnEvents(id, b).map((e) => e.t), ["status", "init", "text", "result", "status"]);
  assert.equal(resultOf(id, b).ok, true);
  // The stored call of an MCP tool is the `tool_call` bridge; the rows still pair up.
  const stored = (stub.transcripts.get(id) ?? []).find((m) => Array.isArray(m.tool_calls))!.tool_calls as Array<{ function: { name: string } }>;
  assert.equal(stored[0]!.function.name, "tool_call");
  for (const name of Object.keys(SCENARIOS)) assert.ok(defaultScript({ sessionId: id, message: `stub:${name}`, runId: "run_x", stub }), name);
});

test("the stub's own rules: bearer on every route, Hermes' error shapes, sessions, jobs, runs", async () => {
  const call = (method: string, path: string, body?: unknown, key: string | null = KEY) =>
    stub.fetch(`http://127.0.0.1:18642${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
  for (const path of ["/api/sessions", "/api/jobs", "/api/sessions/x/messages", "/v1/runs/run_x/stop"]) {
    const none = await call(path.includes("stop") ? "POST" : "GET", path, undefined, null);
    assert.equal(none.status, 401, path);
    assert.equal(await code(none), "gateway_auth_failed");
    assert.equal((await call("GET", path, undefined, `${KEY}x`)).status, 401, path);
  }
  const c = await call("POST", "/api/sessions", { id: "omni_abc", title: "T" });
  assert.equal(c.status, 201);
  const made = ((await c.json()) as { session: Record<string, unknown> }).session;
  assert.equal(made.id, "omni_abc");
  assert.ok(!("last_active" in made), "a single session carries no last_active (only the list does)");
  assert.equal(await code(await call("POST", "/api/sessions", { id: "omni_abc" })), "session_exists");
  // Titles are unique across every session, and at most 100 characters.
  const dup = await call("POST", "/api/sessions", { id: "omni_def", title: "T" });
  assert.equal(dup.status, 400);
  assert.equal(await code(dup), "invalid_title");
  assert.equal((await call("POST", "/api/sessions", { id: "omni_def" })).status, 201);
  assert.equal(await code(await call("PATCH", "/api/sessions/omni_def", { title: "T" })), "invalid_title");
  assert.equal(await code(await call("PATCH", "/api/sessions/omni_def", { title: "x".repeat(101) })), "invalid_title");
  assert.equal(await code(await call("PATCH", "/api/sessions/omni_def", { state: "done" })), "unsupported_session_field");
  assert.equal(await code(await call("PATCH", "/api/sessions/omni_def", { pinned: "yes" })), "invalid_session_field");
  assert.equal(await code(await call("POST", "/api/sessions", { id: "../etc" })), "invalid_session_id");
  const minted = ((await (await call("POST", "/api/sessions", {})).json()) as { session: { id: string } }).session.id;
  assert.match(minted, /^api_\d+_[a-f0-9]{8}$/);
  const miss = await call("GET", "/api/sessions/nope");
  assert.equal(miss.status, 404);
  assert.equal(await code(miss), "session_not_found");
  assert.equal((await call("POST", "/api/sessions/nope/chat/stream", { message: "x" })).status, 404);
  assert.equal(await code(await call("POST", "/api/sessions/omni_abc/chat/stream", {})), "missing_message");
  const p = (await (await call("PATCH", "/api/sessions/omni_abc", { pinned: true, title: "New" })).json()) as { session: { pinned: boolean; title: string } };
  assert.deepEqual([p.session.pinned, p.session.title], [true, "New"]);
  // The list: newest first, pins added past the limit, archived sessions left out.
  stub.sessions.get(minted)!.last_active = Date.now() / 1000 + 60;
  const list = (await (await call("GET", "/api/sessions?limit=1&offset=0")).json()) as { data: Array<{ id: string; last_active: number }>; has_more: boolean; limit: number };
  assert.deepEqual([list.data.map((s) => s.id).sort(), list.has_more, list.limit], [[minted, "omni_abc"].sort(), true, 1]);
  assert.equal(typeof list.data[0]!.last_active, "number");
  assert.equal((await call("PATCH", "/api/sessions/omni_def", { archived: true })).status, 200);
  const all = (await (await call("GET", "/api/sessions?limit=200")).json()) as { data: Array<{ id: string }> };
  assert.ok(!all.data.some((s) => s.id === "omni_def"), "an archived session is not listed");
  assert.equal((await call("GET", "/api/sessions/omni_def")).status, 200, "…but is still there");
  assert.equal(await code(await call("GET", "/api/sessions/omni_abc/messages?order=sideways")), "invalid_pagination");
  assert.equal(await code(await call("POST", "/v1/runs/run_missing/stop", {})), "run_not_found");
  // Jobs: Hermes' shapes and its odd statuses.
  const created = await call("POST", "/api/jobs", { name: "J", schedule: "0 8 * * *", prompt: "p" });
  assert.equal(created.status, 200);
  const j = (await created.json()) as { job: { id: string; schedule: { kind: string; display: string }; state: string } };
  assert.match(j.job.id, /^[a-f0-9]{12}$/);
  assert.deepEqual([j.job.schedule.kind, j.job.schedule.display, j.job.state], ["cron", "0 8 * * *", "scheduled"]);
  const lone = await call("POST", "/api/jobs", { name: "K", schedule: "0 8 * * *", skill: "omni-briefing" });
  assert.equal(lone.status, 500, "`skill` alone is ignored: nothing to run");
  assert.match(((await lone.json()) as { error: string }).error, /^Cron job has nothing to run/);
  assert.equal((await call("POST", "/api/jobs", { name: "K", schedule: "every 2h", skills: ["omni-briefing"] })).status, 200);
  const bad = await call("POST", "/api/jobs", { name: "K", schedule: "whenever", prompt: "p" });
  assert.equal(bad.status, 500);
  assert.match(((await bad.json()) as { error: string }).error, /^Invalid schedule/);
  assert.deepEqual(await (await call("POST", "/api/jobs", { schedule: "0 8 * * *" })).json(), { error: "Name is required" });
  const paused = ((await (await call("POST", `/api/jobs/${j.job.id}/pause`, {})).json()) as { job: { enabled: boolean; state: string; paused_at: string | null } }).job;
  assert.deepEqual([paused.enabled, paused.state, typeof paused.paused_at], [false, "paused", "string"]);
  assert.equal(((await (await call("GET", "/api/jobs")).json()) as { jobs: unknown[] }).jobs.length, 1, "a paused job needs include_disabled");
  assert.equal(((await (await call("GET", "/api/jobs?include_disabled=true")).json()) as { jobs: unknown[] }).jobs.length, 2);
  assert.deepEqual(await (await call("DELETE", `/api/jobs/${j.job.id}`)).json(), { ok: true });
  assert.equal((await call("GET", `/api/jobs/${j.job.id}`)).status, 404);
  assert.equal((await call("GET", "/api/jobs/not-an-id")).status, 400);
  assert.equal((await call("GET", "/api/anything-else")).status, 404);
  assert.throws(() => createHermesStub({ key: "short" }));
  // The bridge sends the service token to a loopback gateway only.
  assert.throws(() => httpBridge("https://prism.example.com", "x".repeat(32)));
  assert.throws(() => httpBridge("http://192.168.1.10:8797", "x".repeat(32)));
  assert.throws(() => httpBridge("http://localhost:8797", "x".repeat(32)));
  assert.ok(httpBridge("http://127.0.0.1:8797", "x".repeat(32)));
});

// ── a tool call paused for approval (kind `command`) ─────────────────────────────────────

type Card = { id: string; kind: string; status: string; digest: string; threadId: string; payload: Record<string, unknown>; executor: { name: string; enabled: boolean }; decidedVia: string | null };
/** Start `stub:command` on a thread and wait until its approval card is on the stream. */
async function pausedCommand(id: string): Promise<{ turnId: string; card: Card }> {
  const r = await post(`/threads/${id}/turns`, { text: "stub:command:fast" }, { ...owner(), "idempotency-key": `stub-cmd-${Date.now()}-${++n}` });
  assert.equal(r.status, 202);
  const turnId = ((await r.json()) as { turnId: string }).turnId;
  for (let i = 0; i < 200; i++) {
    const ev = turnEvents(id, turnId).concat(events(id).filter((e) => e.t === "approval"));
    const card = events(id).filter((e) => e.t === "approval").map((e) => e.approval as Card).filter((a) => a.kind === "command" && a.status === "pending").pop();
    if (card && ev.length) return { turnId, card };
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("no command approval appeared");
}
const decideCmd = (card: Card, decision: string, extra: Record<string, string> = {}) =>
  post(`/approvals/${card.id}/decision`, { decision, digest: card.digest }, { ...owner(), "idempotency-key": `stub-cmd-decide-${Date.now()}-${++n}`, ...extra });

test("command approval: the call is paused, the card shows the exact command, Approve once lets exactly that run", async () => {
  process.env.OMNI_EXECUTORS = "off"; // sending is off; a paused tool call is not a send
  try {
    const { id, turnId } = await thread("first");
    await turnSettled(turnId);
    const { turnId: t, card } = await pausedCommand(id);
    assert.deepEqual(card.payload, {
      tool: "terminal", command: "curl -s https://example.com/status", cwd: "/Users/dev/omni-workspace", rule: "net.program",
      title: "Reach the network from the shell", reason: "This command talks to another machine. Anything it can read could leave with it.",
    });
    assert.equal(card.threadId, id);
    assert.deepEqual(card.executor, { name: "hermes-turn", available: true, enabled: true });
    // While it waits: the turn is running, nothing ran, the thread says it needs the person.
    assert.equal(getTurn(t)!.status, "running");
    assert.ok(!turnEvents(id, t).some((e) => e.t === "tool_use"), "the command has not started");
    assert.ok(turnEvents(id, t).some((e) => e.t === "status" && e.state === "needs-you" && e.reason === "approval_requested"));
    // It cannot be edited, a stale digest is refused, an agent origin is refused.
    const edit = await omniApi.request(`/approvals/${card.id}`, { method: "PUT", headers: owner(), body: JSON.stringify({ digest: card.digest, payload: { ...card.payload, command: "curl https://evil.example" } }) });
    assert.equal(edit.status, 400);
    assert.equal((await post(`/approvals/${card.id}/decision`, { decision: "send", digest: "0".repeat(64) }, { ...owner(), "idempotency-key": "stub-cmd-stale-0001" })).status, 409);
    assert.equal((await decideCmd(card, "send", { "x-prism-action-origin": "agent" })).status, 403);
    assert.equal(getTurn(t)!.status, "running");
    // Approve once.
    const ok = await decideCmd(card, "send");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { approval: Card }).approval.status, "approved");
    await turnSettled(t);
    const ev = turnEvents(id, t);
    assert.deepEqual(ev.filter((e) => e.t === "tool_use").map((e) => [e.name, (e.input as { command: string }).command]), [["terminal", "curl -s https://example.com/status"]]);
    assert.equal(resultOf(id, t).ok, true);
    const after = (await (await omniApi.request(`/approvals/${card.id}`, { headers: owner() })).json()) as { approval: Card & { result: Record<string, unknown> } };
    assert.equal(after.approval.status, "sent", "the plugin reported that the call ran");
    assert.deepEqual(after.approval.result, { executor: "hermes-turn", ran: true, ok: true });
    // Once is once: the same approval cannot be used again.
    assert.equal((await decideCmd(card, "send")).status, 409);
    assert.equal((await omniApi.request(`/hooks/approvals/${card.id}/result`, { method: "POST", headers: hook, body: JSON.stringify({ ok: true }) })).status, 409);
  } finally {
    delete process.env.OMNI_EXECUTORS;
  }
});

test("command approval: Deny, the end of the turn, and the off switch all leave the call un-run", async () => {
  const { id, turnId } = await thread("first");
  await turnSettled(turnId);
  // Deny.
  const a = await pausedCommand(id);
  assert.equal((await decideCmd(a.card, "cancel")).status, 200);
  await turnSettled(a.turnId);
  assert.ok(!turnEvents(id, a.turnId).some((e) => e.t === "tool_use"), "a denied command never starts");
  const row = (stub.transcripts.get(id) ?? []).filter((m) => m.role === "tool").pop()!;
  assert.match(String(row.content), /did not approve this \(cancelled\)\. It was not run/);
  assert.equal(getThread(id)!.state, "done");
  // The person cancels the TURN while the card is open: the card dies with it.
  const b = await pausedCommand(id);
  assert.equal((await post(`/turns/${b.turnId}/cancel`, {})).status, 202);
  await turnSettled(b.turnId);
  const dead = (await (await omniApi.request(`/approvals/${b.card.id}`, { headers: owner() })).json()) as { approval: Card };
  assert.deepEqual([dead.approval.status, dead.approval.decidedVia], ["cancelled", "turn-ended"]);
  assert.equal((await decideCmd(b.card, "send")).status, 409, "approving after the turn ended runs nothing");
  assert.ok(!turnEvents(id, b.turnId).some((e) => e.t === "tool_use"));
  // OMNI_COMMAND_APPROVALS=off: nothing paused can be approved.
  process.env.OMNI_COMMAND_APPROVALS = "off";
  try {
    const c = await pausedCommand(id);
    const r = await decideCmd(c.card, "send");
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, "executor_disabled");
    await post(`/turns/${c.turnId}/cancel`, {});
    await turnSettled(c.turnId);
  } finally {
    delete process.env.OMNI_COMMAND_APPROVALS;
  }
});

test("command approval hooks: service token only; status, result and withdraw; what a card may carry", async () => {
  const propose = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    omniApi.request("/hooks/propose", { method: "POST", headers: hook, body: JSON.stringify({ kind: "command", payload, ...extra }) });
  const base = { tool: "write_file", rule: "write.outside", reason: "Writes a file outside the workspace." };
  const r = await propose({ ...base, input: { path: "/Users/x/notes.md", content: "hello" }, origin: "cron", extra: "dropped" }, { expiresInSec: 120 });
  assert.equal(r.status, 201);
  const id = ((await r.json()) as { id: string }).id;
  const view = (await (await omniApi.request(`/approvals/${id}`, { headers: owner() })).json()) as { approval: Card };
  assert.deepEqual(view.approval.payload, { ...base, input: { path: "/Users/x/notes.md", content: "hello" }, origin: "cron" }, "only the listed fields survive");
  // The hook: no token → 403; a session is not a hook credential; another kind is not served.
  assert.equal((await omniApi.request(`/hooks/approvals/${id}`)).status, 403);
  assert.equal((await omniApi.request(`/hooks/approvals/${id}`, { headers: owner() })).status, 403);
  assert.deepEqual(await (await omniApi.request(`/hooks/approvals/${id}`, { headers: hook })).json(), { id, status: "pending", digest: view.approval.digest, decidedVia: null });
  assert.equal((await omniApi.request("/hooks/approvals/apr_nope", { headers: hook })).status, 404);
  const email = await omniApi.request("/hooks/propose", { method: "POST", headers: hook, body: JSON.stringify({ kind: "email", payload: { to: ["a@example.com"], subject: "s", body: "b" } }) });
  assert.equal((await omniApi.request(`/hooks/approvals/${((await email.json()) as { id: string }).id}`, { headers: hook })).status, 404);
  // A result before approval is refused; withdraw takes the question back.
  assert.equal((await omniApi.request(`/hooks/approvals/${id}/result`, { method: "POST", headers: hook, body: JSON.stringify({ ok: true }) })).status, 409);
  assert.deepEqual(await (await omniApi.request(`/hooks/approvals/${id}/withdraw`, { method: "POST", headers: hook, body: "{}" })).json(), { id, status: "cancelled" });
  assert.equal(((await (await omniApi.request(`/hooks/approvals/${id}`, { headers: hook })).json()) as { decidedVia: string }).decidedVia, "withdrawn");
  // Validation.
  for (const bad of [{ ...base }, { ...base, input: [] }, { ...base, command: "x", origin: "telegram" }, { tool: "terminal", command: "ls" }, { ...base, input: { blob: "x".repeat(70_000) } }]) {
    assert.equal((await propose(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  // A failed run is recorded as failed.
  const f = ((await (await propose({ ...base, command: "pm2 restart prism-server", tool: "terminal" })).json()) as { id: string; digest: string });
  assert.equal((await post(`/approvals/${f.id}/decision`, { decision: "send", digest: f.digest }, { ...owner(), "idempotency-key": "stub-cmd-fail-0001" })).status, 200);
  assert.deepEqual(await (await omniApi.request(`/hooks/approvals/${f.id}/result`, { method: "POST", headers: hook, body: JSON.stringify({ ok: false }) })).json(), { id: f.id, status: "failed" });
});

// ── first-run fix: the stub remembers its sessions across a restart ─────────────────────

import { fileStubStore, type StubState } from "../scripts/lib/hermes-stub";

/** An in-memory "disk" with the three calls `fileStubStore` makes. */
function fakeDisk() {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    fs: {
      readFileSync: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
      writeFileSync: (p: string, data: string, o: { mode: number }) => {
        files.set(p, data);
        modes.set(p, o.mode);
      },
      renameSync: (a: string, b: string) => {
        files.set(b, files.get(a)!);
        files.delete(a);
      },
    },
  };
}
const stubCall = (s: HermesStub, method: string, path: string, body?: unknown) =>
  s.fetch(`http://127.0.0.1:18642${path}`, { method, headers: { authorization: `Bearer ${KEY}`, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });

test("with a store, a restarted stub still has its sessions, transcripts and job changes", async () => {
  const disk = fakeDisk();
  const seedJobs = () => [{ id: "0a1b2c3d4e5f", name: "Brief", schedule: { kind: "cron", expr: "0 7 * * *", display: "0 7 * * *" }, enabled: true, state: "scheduled" }];
  const first = createHermesStub({ key: KEY, jobs: seedJobs(), store: fileStubStore("/dev/state.json", disk.fs, 0), script: () => ({ acts: [{ say: "the answer" }] }) });
  assert.equal((await stubCall(first, "POST", "/api/sessions", { id: "omni_aaaaaaaaaaaaaaaaaaaaaaaa", title: "Before the restart" })).status, 201);
  const chat = await stubCall(first, "POST", "/api/sessions/omni_aaaaaaaaaaaaaaaaaaaaaaaa/chat/stream", { message: "hello there" });
  await chat.text();
  assert.equal((await stubCall(first, "PATCH", "/api/sessions/omni_aaaaaaaaaaaaaaaaaaaaaaaa", { pinned: true })).status, 200);
  assert.equal((await stubCall(first, "POST", "/api/jobs/0a1b2c3d4e5f/pause")).status, 200);
  assert.equal(disk.modes.get("/dev/state.json.tmp"), 0o600, "written owner-only, through a temp file that is renamed into place");
  assert.ok(disk.files.has("/dev/state.json"));
  assert.ok(!disk.files.has("/dev/state.json.tmp"));
  assert.doesNotMatch(disk.files.get("/dev/state.json")!, new RegExp(KEY), "the key is never written");

  // The restart: a new stub on the same file, seeded with the same default jobs.
  const second = createHermesStub({ key: KEY, jobs: seedJobs(), store: fileStubStore("/dev/state.json", disk.fs, 0) });
  const s = (await (await stubCall(second, "GET", "/api/sessions/omni_aaaaaaaaaaaaaaaaaaaaaaaa")).json()) as { session: { title: string; pinned: boolean; message_count: number } };
  assert.deepEqual([s.session.title, s.session.pinned, s.session.message_count], ["Before the restart", true, 2]);
  const m = (await (await stubCall(second, "GET", "/api/sessions/omni_aaaaaaaaaaaaaaaaaaaaaaaa/messages")).json()) as { data: Array<{ role: string; content: string }> };
  assert.deepEqual(m.data.map((x) => [x.role, x.content]), [["user", "hello there"], ["assistant", "the answer"]]);
  const jobs = (await (await stubCall(second, "GET", "/api/jobs?include_disabled=true")).json()) as { jobs: Array<{ id: string; enabled: boolean }> };
  assert.deepEqual(jobs.jobs.map((j) => [j.id, j.enabled]), [["0a1b2c3d4e5f", false]], "the pause survived; the seed list did not overwrite it");
});

test("without a store (the test suite's setting) nothing is written; a missing or damaged state file starts empty", async () => {
  const disk = fakeDisk();
  const plain = createHermesStub({ key: KEY });
  await stubCall(plain, "POST", "/api/sessions", { id: "omni_bbbbbbbbbbbbbbbbbbbbbbbb" });
  assert.equal(disk.files.size, 0);
  disk.files.set("/dev/bad.json", "{not json");
  assert.equal(createHermesStub({ key: KEY, store: fileStubStore("/dev/bad.json", disk.fs, 0) }).sessions.size, 0);
  disk.files.set("/dev/old.json", JSON.stringify({ version: 0, sessions: [{ id: "x" }] } as unknown as StubState));
  assert.equal(createHermesStub({ key: KEY, store: fileStubStore("/dev/old.json", disk.fs, 0) }).sessions.size, 0, "an unknown version is ignored");
  assert.equal(createHermesStub({ key: KEY, store: fileStubStore("/dev/none.json", disk.fs, 0) }).sessions.size, 0);
});
