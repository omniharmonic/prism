/**
 * The stub Hermes (scripts/lib/hermes-stub.ts) behind the REAL gateway — the same pair
 * `scripts/omni-dev.sh` runs on the laptop, here without sockets: the stub answers the
 * client's fetch seam and its omni-bridge calls go to the gateway's hook routes in
 * process. Pins the default script's scenarios and the stub's own HTTP rules.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.OMNI_ENABLED = "true";
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
    // No pacing in tests: the same frames, all at once.
    script: (ctx) => {
      const t = defaultScript(ctx) as StubTurn;
      return { ...t, delayMs: 0, steps: t.steps.map((s) => ({ ...s, waitMs: s.waitMs ? 1 : undefined })) };
    },
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
    },
  });
  setHermesFetchForTests(stub.fetch);
});
after(() => {
  setHermesFetchForTests(null);
  setOmniPusherForTests(null);
});

const post = (path: string, body: unknown, headers: Record<string, string> = owner()) => omniApi.request(path, { method: "POST", headers, body: JSON.stringify(body) });
const events = (id: string) => eventsAfter(id, 0).map((e) => e.payload as { t: string } & Record<string, unknown>);
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
const resultOf = (id: string, turnId: string) => eventsAfter(id, 0).filter((e) => e.turnId === turnId).map((e) => e.payload as Record<string, unknown>).find((e) => e.t === "result")!;

test("reply: streamed chunks, a tool call, the final text; the transcript is kept", async () => {
  const { id, turnId } = await thread("Hello there");
  await turnSettled(turnId);
  assert.deepEqual(events(id).map((e) => e.t), ["status", "init", "text", "tool_use", "tool_result", "text", "result", "status"]);
  assert.match(String(events(id)[5]!.text), /This is the stub Hermes\. You said: “Hello there”/);
  assert.equal(getTurn(turnId)!.status, "done");
  assert.match(getTurn(turnId)!.runId ?? "", /^run_[a-f0-9]{16}$/);
  const d = (await (await omniApi.request(`/threads/${id}`, { headers: owner() })).json()) as { messages: Array<{ role: string; text: string }>; thread: { messageCount: number; preview: string } };
  assert.deepEqual(d.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(d.messages[0]!.text, "Hello there");
  assert.equal(d.thread.messageCount, 2);
});

test("approval: the stub proposes through the hook the way omni-bridge would; a send is refused while the executor is off", async () => {
  const { id, turnId } = await thread("stub:approval please draft it");
  await turnSettled(turnId);
  const ev = events(id);
  assert.deepEqual(ev.map((e) => e.t), ["status", "init", "text", "tool_use", "approval", "tool_result", "text", "result", "status"]);
  assert.equal(ev[3]!.name, "omni_propose");
  const ap = ev[4]!.approval as { id: string; digest: string; status: string; payload: unknown; executor: { name: string; enabled: boolean } };
  assert.equal(ap.status, "pending");
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
  assert.equal(defaultScript({ sessionId: id, message: "Revise the email draft. Propose the new draft with omni_propose; do not send anything.", runId: "run_x", stub }).steps.some((s) => s.frame?.[0] === "tool.started"), true);
});

test("failure scenarios map to the gateway's codes; Hermes' text never reaches the app", async () => {
  const { id, turnId } = await thread("first");
  await turnSettled(turnId);
  const cases: Array<[string, string]> = [
    ["stub:error", "agent_failed"],
    ["stub:error:auth_failed", "auth"],
    ["stub:error:rate_limit", "usage_limit"],
    ["stub:error:max_iterations", "iteration_limit"],
    ["stub:drop", "hermes_unavailable"],
    ["stub:truncate", "stream_ended"],
    ["stub:http:401", "hermes_auth"],
    ["stub:http:500", "hermes_unavailable"],
  ];
  for (const [text, code] of cases) {
    const t = await turn(id, text);
    assert.equal(resultOf(id, t).errorCode, code, text);
    assert.equal(getTurn(t)!.status, "error", text);
  }
  assert.ok(!JSON.stringify(events(id)).includes("simulated"));
  // And the thread still works afterwards.
  assert.equal(resultOf(id, await turn(id, "again")).ok, true);
});

test("slow: holds until cancelled; the stop reaches the stub's run", async () => {
  const { id, turnId } = await thread("first");
  await turnSettled(turnId);
  const r = await post(`/threads/${id}/turns`, { text: "stub:slow:2" }, { ...owner(), "idempotency-key": "stub-slow-0001" });
  const slow = ((await r.json()) as { turnId: string }).turnId;
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(stub.runs.size, 1, "the run is open");
  assert.equal((await post(`/turns/${slow}/cancel`, {})).status, 202);
  await turnSettled(slow);
  assert.equal(resultOf(id, slow).errorCode, "cancelled");
  assert.equal(getThread(id)!.state, "waiting");
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(stub.runs.size, 0, "the run ended in the stub");
});

test("card, hermes-approval, queued and empty scenarios", async () => {
  setOmniRecordSourcesForTests({ resolver: async (ref) => (ref.id === "n1" ? { id: "n1", path: "vault/tasks/x", tags: ["task"], title: "X", updatedAt: "2026-10-08T10:00:00Z" } : null), subscriber: async () => () => {} });
  const { id, turnId } = await thread("stub:card:n1");
  await turnSettled(turnId);
  const card = events(id).find((e) => e.t === "card")!.card as { noteId: string; op: string };
  assert.deepEqual([card.noteId, card.op], ["n1", "updated"]);
  const h = await turn(id, "stub:hermes-approval");
  assert.ok(eventsAfter(id, 0).some((e) => e.turnId === h && (e.payload as { reason?: string }).reason === "hermes_approval_requested"));
  const q = await turn(id, "stub:queued");
  assert.ok(eventsAfter(id, 0).some((e) => e.turnId === q && (e.payload as { reason?: string }).reason === "queued"));
  assert.equal(resultOf(id, await turn(id, "stub:empty")).ok, true);
  for (const name of Object.keys(SCENARIOS)) assert.ok(defaultScript({ sessionId: id, message: `stub:${name}`, runId: "run_x", stub }), name);
});

test("the stub's own rules: bearer on every route, OpenAI-shaped errors, sessions, jobs, runs", async () => {
  const call = (method: string, path: string, body?: unknown, key: string | null = KEY) =>
    stub.fetch(`http://127.0.0.1:18642${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const path of ["/api/sessions", "/api/jobs", "/api/sessions/x/messages", "/v1/runs/run_x/stop"]) {
    assert.equal((await call(path.includes("stop") ? "POST" : "GET", path, undefined, null)).status, 401, path);
    assert.equal((await call("GET", path, undefined, `${KEY}x`)).status, 401, path);
  }
  const c = await call("POST", "/api/sessions", { id: "omni_abc", title: "T" });
  assert.equal(c.status, 201);
  assert.equal(((await c.json()) as { session: { id: string } }).session.id, "omni_abc");
  assert.equal((await call("POST", "/api/sessions", { id: "omni_abc" })).status, 409);
  const minted = ((await (await call("POST", "/api/sessions", {})).json()) as { session: { id: string } }).session.id;
  assert.match(minted, /^api_\d+_[a-f0-9]{8}$/);
  const miss = await call("GET", "/api/sessions/nope");
  assert.equal(miss.status, 404);
  assert.equal(((await miss.json()) as { error: { code: string } }).error.code, "session_not_found");
  assert.equal((await call("POST", "/api/sessions/nope/chat/stream", { message: "x" })).status, 404);
  assert.equal((await call("POST", "/api/sessions/omni_abc/chat/stream", {})).status, 400);
  const p = (await (await call("PATCH", "/api/sessions/omni_abc", { pinned: true, title: "New" })).json()) as { session: { pinned: boolean; title: string } };
  assert.deepEqual([p.session.pinned, p.session.title], [true, "New"]);
  const list = (await (await call("GET", "/api/sessions?limit=1&offset=0")).json()) as { data: unknown[]; has_more: boolean };
  assert.deepEqual([list.data.length, list.has_more], [1, true]);
  assert.equal((await call("POST", "/v1/runs/run_missing/stop", {})).status, 404);
  const j = (await (await call("POST", "/api/jobs", { name: "J", schedule: "0 8 * * *", prompt: "p" })).json()) as { job: { id: string } };
  assert.match(j.job.id, /^[a-f0-9]{12}$/);
  assert.equal(((await (await call("POST", `/api/jobs/${j.job.id}/pause`, {})).json()) as { job: { enabled: boolean } }).job.enabled, false);
  assert.equal(((await (await call("GET", "/api/jobs")).json()) as { jobs: unknown[] }).jobs.length, 0, "disabled jobs need include_disabled");
  assert.equal(((await (await call("GET", "/api/jobs?include_disabled=true")).json()) as { jobs: unknown[] }).jobs.length, 1);
  assert.equal((await call("DELETE", `/api/jobs/${j.job.id}`)).status, 200);
  assert.equal((await call("GET", `/api/jobs/${j.job.id}`)).status, 404);
  assert.equal((await call("GET", "/api/anything-else")).status, 404);
  assert.throws(() => createHermesStub({ key: "short" }));
  // The bridge sends the service token to a loopback gateway only.
  assert.throws(() => httpBridge("https://prism.example.com", "x".repeat(32)));
  assert.throws(() => httpBridge("http://192.168.1.10:8797", "x".repeat(32)));
  assert.throws(() => httpBridge("http://localhost:8797", "x".repeat(32)));
  assert.ok(httpBridge("http://127.0.0.1:8797", "x".repeat(32)));
});
