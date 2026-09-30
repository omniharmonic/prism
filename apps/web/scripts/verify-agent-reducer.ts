/**
 * Behavioral check for the agent chat client (Arch v2 WP3.2):
 *   - the pure conversation reducer (packages/core/src/lib/agent/sessionReducer.ts):
 *     text_delta coalescing, blockId replacement by the persisted `text`, seq
 *     dedupe on replay, rebuild-after-reconnect, tool/touched/result folding;
 *   - the HTTP stream wrapper (httpAgentClient.ts `streamSessionEvents`) against a
 *     loopback SSE server: resume via ?after= and Last-Event-ID after a drop,
 *     stopping after the turn ends, and a 403 being fatal.
 *
 * Run: npm run verify:agent -w @prism/web
 *   (= node --import tsx scripts/verify-agent-reducer.ts; needs only loopback http)
 */
import http from "node:http";
import assert from "node:assert/strict";
import {
  applyAgentMessage,
  addPendingTurn,
  emptyConversation,
  seedConversation,
  activeTurn,
  shortToolName,
  turnProblem,
  type ConversationState,
} from "../../../packages/core/src/lib/agent/sessionReducer.ts";
import { streamSessionEvents } from "../../../packages/core/src/lib/agent/httpAgentClient.ts";
import { streamSSE } from "../../../packages/core/src/lib/transport/sse.ts";
import type { AgentSessionDetail, AgentStreamMessage, AgentTurn } from "../../../packages/core/src/lib/agent/sessions.ts";

let passed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`✓ ${m}`);
};
const run = (s: ConversationState, msgs: AgentStreamMessage[]) => msgs.reduce(applyAgentMessage, s);

const T = "turn-1";
// A full turn as the server emits it (persisted events carry seq; deltas don't).
const turnEvents: AgentStreamMessage[] = [
  { seq: 1, turnId: T, t: "status", status: "running" },
  { seq: 2, turnId: T, t: "init", cliSessionId: "s", model: "m", tools: [], mcp: [] },
  { turnId: T, t: "text_delta", blockId: "b1", text: "Let me " },
  { turnId: T, t: "text_delta", blockId: "b1", text: "look." },
  { seq: 3, turnId: T, t: "text", blockId: "b1", text: "Let me look." },
  { seq: 4, turnId: T, t: "tool_use", id: "tu1", name: "mcp__parachute-vault__query-notes", input: {} },
  { seq: 5, turnId: T, t: "tool_result", toolUseId: "tu1", ok: true, summary: "3 notes" },
  { seq: 6, turnId: T, t: "tool_use", id: "tu2", name: "mcp__parachute-vault__create-note", input: {} },
  { seq: 7, turnId: T, t: "tool_result", toolUseId: "tu2", ok: false, summary: "denied" },
  { seq: 8, turnId: T, t: "note_touched", noteId: "n-1", op: "update" },
  { turnId: T, t: "text_delta", blockId: "b2", text: "Done: " },
  { turnId: T, t: "text_delta", blockId: "b2", text: "**ok**" },
  { seq: 9, turnId: T, t: "text", blockId: "b2", text: "Done: **ok** [redacted]" },
  { seq: 10, turnId: T, t: "result", ok: true, costUsd: 0.0123, durationMs: 4200 },
  { seq: 11, turnId: T, t: "status", status: "done" },
];

// ── 1. text_delta coalescing + blockId replacement ──
{
  let s = addPendingTurn(emptyConversation, { id: T, prompt: "hi" });
  s = run(s, turnEvents.slice(0, 4)); // up to the two b1 deltas
  const t = s.turns[0]!;
  assert.deepEqual(t.blocks, [{ blockId: "b1", text: "Let me look.", streaming: true }]);
  ok("text_delta chunks with the same blockId concatenate into one streaming block");
  s = applyAgentMessage(s, turnEvents[4]!);
  assert.deepEqual(s.turns[0]!.blocks, [{ blockId: "b1", text: "Let me look.", streaming: false }]);
  const late = applyAgentMessage(s, { turnId: T, t: "text_delta", blockId: "b1", text: "DUP" });
  assert.equal(late, s, "a delta for a final block is ignored (same object)");
  ok("persisted text replaces the block by blockId; later deltas for it are ignored");
  s = run(s, turnEvents.slice(5));
  const d = s.turns[0]!;
  assert.equal(d.blocks[1]!.text, "Done: **ok** [redacted]", "server's scrubbed final text wins over the deltas");
  assert.equal(d.status, "done");
  assert.deepEqual(
    d.tools.map((x) => [x.name, x.ok]),
    [
      ["query-notes", true],
      ["create-note", false],
    ],
  );
  assert.deepEqual(d.touched, [{ noteId: "n-1", op: "update" }]);
  assert.equal(d.costUsd, 0.0123);
  assert.equal(d.durationMs, 4200);
  assert.equal(s.lastSeq, 11);
  assert.equal(activeTurn(s), undefined);
  ok("tools (ok/error), touched notes, cost/duration and terminal status fold in");
}

// ── 2. replay dedupe: re-applying everything changes nothing ──
{
  const once = run(addPendingTurn(emptyConversation, { id: T, prompt: "hi" }), turnEvents);
  const twice = run(once, turnEvents.filter((e) => e.seq !== undefined));
  assert.deepEqual(twice, once);
  ok("a replay of already-applied seqs is a no-op");
}

// ── 3. drop mid-turn → reconnect with Last-Event-ID → identical final state ──
{
  const base = addPendingTurn(emptyConversation, { id: T, prompt: "hi" });
  const straight = run(base, turnEvents);
  // Connection 1 dies after seq 5 (deltas for b2 were never seen).
  let s = run(base, turnEvents.slice(0, 7));
  assert.equal(s.lastSeq, 5);
  // Connection 2: server replays seq > 5 (persisted only — deltas are live-only) + an overlap.
  const replay = turnEvents.filter((e) => e.seq !== undefined && e.seq > 4);
  s = run(s, replay);
  assert.deepEqual(s, straight);
  ok("reconnect from the last persisted seq (with overlap) converges to the uninterrupted state");
}

// ── 4. seedConversation: finished turns from the summary, in-flight turn rebuilt ──
{
  const done: AgentTurn = {
    id: "turn-0",
    session_id: "sid",
    prompt: "first",
    note_id: null,
    status: "done",
    pid: 1,
    exit_code: 0,
    error: null,
    cost_usd: 0.5,
    started_at: 1000,
    ended_at: 4000,
    finalText: "earlier answer",
    tools: ["query-notes"],
    touched: [],
    firstSeq: 1,
    lastSeq: 6,
  };
  const running: AgentTurn = { ...done, id: T, prompt: "hi", status: "running", finalText: "partial", tools: ["query-notes"], cost_usd: null, ended_at: null, firstSeq: 7, lastSeq: 9 };
  const detail: AgentSessionDetail = {
    session: { id: "sid" } as AgentSessionDetail["session"],
    turns: [done, running],
    lastSeq: 9,
  };
  const { state, streamAfter } = seedConversation(detail);
  assert.equal(streamAfter, 6, "resume just before the in-flight turn's first event");
  assert.equal(state.lastSeq, 6);
  assert.equal(state.turns[0]!.blocks[0]!.text, "earlier answer");
  assert.equal(state.turns[0]!.durationMs, 3000);
  assert.deepEqual(state.turns[1]!.blocks, [], "in-flight turn is reset, then rebuilt by the replay");
  const shifted = turnEvents.map((e) => (e.seq !== undefined ? { ...e, seq: e.seq + 6 } : e));
  const rebuilt = run(state, shifted.filter((e) => e.seq !== undefined));
  assert.deepEqual(
    rebuilt.turns[1]!.blocks.map((b) => b.text),
    ["Let me look.", "Done: **ok** [redacted]"],
  );
  assert.equal(rebuilt.turns[1]!.tools.length, 2, "no duplicate tool chips after the rebuild");
  ok("seedConversation resumes at firstSeq-1 and the replay rebuilds the running turn exactly");

  const idle = seedConversation({ ...detail, turns: [done], lastSeq: 6 });
  assert.equal(idle.streamAfter, null, "nothing in flight → no stream");
  assert.equal(idle.state.lastSeq, 6);
  const fresh = seedConversation({ ...detail, turns: [done, { ...running, firstSeq: null, lastSeq: null }], lastSeq: 6 });
  assert.equal(fresh.streamAfter, 6, "a queued turn with no events resumes after everything persisted");
  ok("idle sessions open no stream; a queued turn resumes after the session's last seq");
}

// ── 5. copy + helpers ──
{
  assert.equal(shortToolName("mcp__parachute-vault__update-note"), "update-note");
  const base = { id: "x", prompt: "", noteId: null, blocks: [], tools: [], touched: [], startedAt: null };
  assert.match(turnProblem({ ...base, status: "interrupted" })!.text, /Interrupted/);
  assert.match(turnProblem({ ...base, status: "error", error: "session budget exceeded" })!.text, /spending cap/);
  assert.equal(turnProblem({ ...base, status: "done" }), null);
  const unknown = applyAgentMessage(emptyConversation, { seq: 3, turnId: "other", t: "status", status: "running" });
  assert.equal(unknown.turns[0]!.id, "other", "an event for an unseen turn (another device) adds a placeholder");
  ok("turn problem copy, tool-name shortening, unknown-turn placeholder");
}

// ── 6. streamSessionEvents over a loopback SSE server ──
const reqs: Array<{ url: string; lastEventId?: string }> = [];
let conn = 0;
const server = http.createServer((req, res) => {
  reqs.push({ url: req.url ?? "", lastEventId: req.headers["last-event-id"] as string | undefined });
  if (req.url?.startsWith("/denied")) {
    res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
    return;
  }
  conn++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (seq: number | null, t: string, data: object) =>
    res.write(`${seq !== null ? `id: ${seq}\n` : ""}event: ${t}\ndata: ${JSON.stringify({ ...(seq !== null ? { seq } : {}), turnId: T, ...data })}\n\n`);
  if (conn === 1) {
    res.write("retry: 20\n\n");
    ev(4, "status", { t: "status", status: "running" });
    ev(null, "text_delta", { t: "text_delta", blockId: "b", text: "hel" });
    ev(5, "text", { t: "text", blockId: "b", text: "hello" });
    setTimeout(() => res.destroy(), 20); // network drop mid-turn
  } else if (conn === 2) {
    ev(6, "result", { t: "result", ok: true, durationMs: 10 });
    ev(7, "status", { t: "status", status: "done" });
    setTimeout(() => res.end(), 20); // server closes: nothing in flight
  } else {
    setTimeout(() => res.end(), 5); // replay empty, nothing in flight
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };
const origin = `http://127.0.0.1:${port}`;
const sse = (path: string, o: Parameters<typeof streamSSE>[1]) => streamSSE(`${origin}${path}`, { ...o, retryMs: 20 });

{
  let st = addPendingTurn(emptyConversation, { id: T, prompt: "hi" });
  st = { ...st, lastSeq: 3 };
  const errors: string[] = [];
  await new Promise<void>((resolve) => {
    streamSessionEvents(sse, "/stream", 3, { "X-Prism-Vault": "v1" }, {
      onEvent: (m) => {
        st = applyAgentMessage(st, m);
      },
      onError: (e) => errors.push(e.message),
      onClose: resolve,
    });
  });
  assert.equal(reqs[0]!.url, "/stream?after=3", "first request resumes with ?after=");
  assert.equal(reqs[1]!.lastEventId, "5", "reconnect after the drop sends Last-Event-ID = last persisted seq (deltas carry no id)");
  assert.equal(st.turns[0]!.blocks[0]!.text, "hello");
  assert.equal(st.turns[0]!.status, "done");
  assert.equal(st.lastSeq, 7);
  assert.ok(errors.length >= 1, "the drop was reported as retryable");
  assert.equal(reqs.length, 3, "one probe after the clean close, then the stream stops (no polling loop)");
  ok("stream: ?after resume, Last-Event-ID reconnect after a drop, stops after the turn ends");
}
{
  let fatal: { willRetry: boolean } | null = null;
  await new Promise<void>((resolve) => {
    streamSessionEvents(sse, "/denied", 0, {}, {
      onEvent: () => {},
      onError: (_e, info) => (fatal = info),
      onClose: resolve,
    });
  });
  assert.deepEqual(fatal, { willRetry: false });
  ok("stream: 403 is fatal (no retry) and closes");
}
{
  // Unsubscribe mid-stream closes exactly once.
  let closes = 0;
  const unsub = streamSessionEvents(sse, "/stream", 0, {}, { onEvent: () => {}, onClose: () => closes++ });
  unsub();
  unsub();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(closes, 1);
  ok("stream: unsubscribe is idempotent");
}

server.close();
console.log(`\nverify-agent-reducer: ${passed} checks passed`);
