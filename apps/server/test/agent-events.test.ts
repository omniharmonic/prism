/**
 * stream-json → AgentEvent normalizer (Arch v2 WP3.1). Driven by REAL recorded
 * CLI output (test/fixtures/agent-stream-*.jsonl — captured from `claude` 2.1.x
 * against a local stub MCP server, then stripped of host-specific fields), plus
 * synthetic lines for redaction edge cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  StreamNormalizer,
  normalizeStream,
  redactToolInput,
  summarizeToolResult,
  scrubSecrets,
  touchedNotes,
  MAX_INPUT_JSON,
  MAX_RESULT_SUMMARY,
  type AgentEvent,
} from "../src/agent-events";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const TURN1 = fixture("agent-stream-turn1.jsonl");
const TURN2 = fixture("agent-stream-turn2-resume.jsonl");
const DENIED = fixture("agent-stream-ro-denied.jsonl");

test("normalizer: a recorded tool-using turn → init, tool_use/result pairs, note_touched, deltas, final text, result", () => {
  const evs = normalizeStream(TURN1);
  const kinds = evs.map((e) => e.t);
  assert.equal(kinds[0], "init");
  assert.deepEqual(
    kinds.filter((k) => k !== "text_delta"),
    ["init", "tool_use", "tool_result", "tool_use", "tool_result", "note_touched", "text", "result"],
  );
  const init = evs[0] as Extract<AgentEvent, { t: "init" }>;
  assert.equal(init.cliSessionId, "11111111-2222-4333-8444-555555555555");
  assert.ok(init.tools.every((t) => t.startsWith("mcp__parachute-vault__")), "only vault tools");
  assert.deepEqual(init.mcp, [{ name: "parachute-vault", status: "connected" }]);

  const uses = evs.filter((e): e is Extract<AgentEvent, { t: "tool_use" }> => e.t === "tool_use");
  assert.deepEqual(
    uses.map((u) => u.name),
    ["mcp__parachute-vault__query-notes", "mcp__parachute-vault__create-note"],
  );
  const results = evs.filter((e): e is Extract<AgentEvent, { t: "tool_result" }> => e.t === "tool_result");
  assert.deepEqual(
    results.map((r) => [r.toolUseId, r.ok]),
    uses.map((u) => [u.id, true]),
  );
  // note_touched is derived from the create-note RESULT (the new id), not the input.
  assert.deepEqual(
    evs.filter((e) => e.t === "note_touched"),
    [{ t: "note_touched", noteId: "n-1", op: "create" }],
  );
  const res = evs.at(-1) as Extract<AgentEvent, { t: "result" }>;
  assert.equal(res.ok, true);
  assert.ok(res.costUsd! > 0 && res.durationMs > 0);
});

test("normalizer: partial text deltas coalesce EXACTLY into the final text block (same blockId)", () => {
  const evs = normalizeStream(TURN1);
  const deltas = evs.filter((e): e is Extract<AgentEvent, { t: "text_delta" }> => e.t === "text_delta");
  const text = evs.find((e): e is Extract<AgentEvent, { t: "text" }> => e.t === "text")!;
  assert.ok(deltas.length > 3, "the fixture streamed several deltas");
  assert.ok(deltas.every((d) => d.blockId === text.blockId));
  assert.equal(deltas.map((d) => d.text).join(""), text.text);
});

test("normalizer: arbitrary chunking (byte-by-byte) yields the same events as whole lines", () => {
  const n = new StreamNormalizer();
  const out: AgentEvent[] = [];
  for (const ch of TURN1) out.push(...n.push(ch));
  out.push(...n.end());
  assert.deepEqual(out, normalizeStream(TURN1));
  assert.equal(n.cliSessionId, "11111111-2222-4333-8444-555555555555");
});

test("normalizer: a resumed turn (recorded) keeps the same CLI session id", () => {
  const evs = normalizeStream(TURN2);
  assert.equal((evs[0] as Extract<AgentEvent, { t: "init" }>).cliSessionId, "11111111-2222-4333-8444-555555555555");
  assert.equal(evs.find((e) => e.t === "text")?.t, "text");
});

test("normalizer: a DENIED vault write (vault-ro, recorded) is a failed tool_result and touches NO note", () => {
  const evs = normalizeStream(DENIED);
  const r = evs.find((e): e is Extract<AgentEvent, { t: "tool_result" }> => e.t === "tool_result")!;
  assert.equal(r.ok, false);
  assert.match(r.summary, /denied/i);
  assert.equal(evs.filter((e) => e.t === "note_touched").length, 0);
});

test("normalizer: error results, non-JSON noise, and unknown event types", () => {
  const lines = [
    "not json at all",
    '{"type":"rate_limit_event","rate_limit_info":{}}',
    '{"type":"system","subtype":"status","status":"requesting"}',
    '{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":0,"total_cost_usd":0,"errors":["No conversation found with session ID: x"]}',
  ].join("\n");
  const evs = normalizeStream(lines);
  assert.deepEqual(evs, [{ t: "result", ok: false, durationMs: 0, costUsd: 0, error: "No conversation found with session ID: x" }]);
});

test("redaction: secret-named keys, token-shaped values, long strings and huge inputs", () => {
  const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlc2lnbmF0dXJl";
  const red = redactToolInput({
    content: `hello Bearer abcdefghijklmnop and ${jwt}`,
    apiKey: "plain-value",
    headers: { Authorization: "Bearer x", ok: "fine" },
    password: "hunter2",
    long: "x".repeat(5000),
    nested: { deep: { deeper: { deepest: { gone: { x: 1 } } } } },
  }) as Record<string, unknown>;
  const s = JSON.stringify(red);
  assert.doesNotMatch(s, /abcdefghijklmnop|hunter2|plain-value|eyJhbGci/);
  assert.equal(red.apiKey, "[redacted]");
  assert.equal(red.password, "[redacted]");
  assert.equal((red.headers as Record<string, unknown>).Authorization, "[redacted]");
  assert.equal((red.headers as Record<string, unknown>).ok, "fine");
  assert.ok((red.long as string).length < 400, "long strings are truncated");
  const huge = redactToolInput({ notes: Array.from({ length: 20 }, (_, i) => ({ content: `q${i}`.repeat(150) })) }) as {
    _truncated?: boolean;
    preview?: string;
  };
  assert.equal(huge._truncated, true);
  assert.ok(huge.preview!.length <= MAX_INPUT_JSON);
});

test("tool_result summary: text only, scrubbed, bounded — never the raw payload", () => {
  const s = summarizeToolResult([{ type: "text", text: `token pvt_abcdefghijklmnopqrstuvwx ${"y".repeat(2000)}` }]);
  assert.doesNotMatch(s, /pvt_abcdefgh/);
  assert.ok(s.length <= MAX_RESULT_SUMMARY + 40);
  assert.equal(scrubSecrets("sk-ant-abcdefghijklmnopqrstu"), "[redacted]");
});

test("touchedNotes: create (result ids / batch / path fallback), update + delete (input ids), reads touch nothing", () => {
  assert.deepEqual(touchedNotes("create-note", {}, [{ type: "text", text: '[{"id":"a"},{"id":"b"}]' }]), [
    { noteId: "a", op: "create" },
    { noteId: "b", op: "create" },
  ]);
  assert.deepEqual(touchedNotes("create-note", { path: "p/q" }, "not json"), [{ noteId: "p/q", op: "create" }]);
  assert.deepEqual(touchedNotes("update-note", { id: "x" }, ""), [{ noteId: "x", op: "update" }]);
  assert.deepEqual(touchedNotes("delete-note", { id: "y" }, ""), [{ noteId: "y", op: "delete" }]);
  assert.deepEqual(touchedNotes("query-notes", { id: "z" }, ""), []);
});
