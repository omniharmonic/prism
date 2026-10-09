/**
 * `buildToday` (src/omni/today.ts) with a fake dispatcher: the per-section retry and the
 * error codes. First-run fix: the laptop dev vault refused / dropped one of Today's two
 * listings now and then, and the section was given up at once (`query_502`).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildToday, type Dispatch } from "../src/omni/today";
import { resetOmniStoreForTests } from "../src/omni/store";
import { resetDb } from "./helpers";

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
});

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const tagOf = (body: unknown) => ((body as { tags: string[] }).tags[0] ?? "") as "meeting" | "task";
const meeting = { id: "m1", path: "meetings/standup", metadata: { title: "Standup", date: "2026-10-09", start: "2026-10-09T15:00:00Z" } };
const task = { id: "t1", path: "tasks/call-dana", metadata: { title: "Call Dana", status: "open", due: "2026-10-10" } };

/** A dispatcher that answers each tag's calls from a script (the last answer repeats). */
function scripted(script: Record<"meeting" | "task", Array<() => Response>>): { dispatch: Dispatch; calls: string[] } {
  const calls: string[] = [];
  const n = { meeting: 0, task: 0 };
  const dispatch: Dispatch = async (path, init) => {
    assert.equal(path, "/api/query");
    assert.equal(init.method, "POST");
    const tag = tagOf(init.body);
    calls.push(tag);
    const list = script[tag];
    return list[Math.min(n[tag]++, list.length - 1)]!();
  };
  return { dispatch, calls };
}
type Today = { agenda: Array<{ noteId: string; title: string }> | null; tasks: Array<{ noteId: string }> | null; errors: Record<string, string>; needsYou: { approvals: unknown[] }; inFlight: unknown[] };
const build = async (d: Dispatch) => (await buildToday(d, "2026-10-09", { retryDelayMs: 1 })) as unknown as Today;

test("a section the vault refused once (502 vault_error) is asked again and answers", async () => {
  const { dispatch, calls } = scripted({
    meeting: [() => json({ error: "vault_error", status: 401 }, 502), () => json({ rows: [meeting] })],
    task: [() => json({ rows: [task], identity: "person" })],
  });
  const t = await build(dispatch);
  assert.deepEqual(t.errors, {});
  assert.deepEqual(t.agenda?.map((a) => [a.noteId, a.title]), [["m1", "Standup"]]);
  assert.deepEqual(t.tasks?.map((a) => a.noteId), ["t1"]);
  assert.deepEqual(calls.filter((c) => c === "meeting").length, 2, "one retry");
  assert.deepEqual(calls.filter((c) => c === "task").length, 1, "a section that worked is not asked twice");
});

test("a section that fails twice is null and named with the route's own code; the other sections still answer", async () => {
  const { dispatch, calls } = scripted({
    meeting: [() => json({ error: "vault_unreachable" }, 502)],
    task: [() => json({ rows: [task] })],
  });
  const t = await build(dispatch);
  assert.equal(t.agenda, null);
  assert.deepEqual(t.errors, { agenda: "vault_unreachable" });
  assert.deepEqual(t.tasks?.map((a) => a.noteId), ["t1"]);
  assert.deepEqual(t.needsYou.approvals, []);
  assert.deepEqual(t.inFlight, []);
  assert.equal(calls.filter((c) => c === "meeting").length, 2, "exactly one retry, then it gives up");
});

test("a refusal (4xx) is final — never retried — and a body that is not a code is not echoed", async () => {
  const { dispatch, calls } = scripted({
    meeting: [() => json({ error: "rate_limited" }, 429)],
    task: [() => new Response("<html>the vault's own words</html>", { status: 500 })],
  });
  const t = await build(dispatch);
  assert.deepEqual(t.errors, { agenda: "rate_limited", tasks: "query_500" });
  assert.equal(calls.filter((c) => c === "meeting").length, 1);
  assert.equal(calls.filter((c) => c === "task").length, 2);
});

test("a dispatcher that throws fails that section only", async () => {
  const dispatch: Dispatch = async (_p, init) => {
    if (tagOf(init.body) === "task") throw new Error("omni_not_mounted");
    return json({ rows: [meeting] });
  };
  const t = await build(dispatch);
  assert.deepEqual(t.errors, { tasks: "omni_not_mounted" });
  assert.equal(t.agenda?.length, 1);
});
