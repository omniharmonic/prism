/**
 * `buildToday` (src/omni/today.ts) with a fake dispatcher: the per-section retry and the
 * error codes. First-run fix: the laptop dev vault refused / dropped one of Today's two
 * listings now and then, and the section was given up at once (`query_502`).
 */
import { Hono } from "hono";
import { mountOmni, omniApi } from "../src/routes/omni";
import { makeSession, sessionCookie } from "./helpers";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildToday, buildTasksPage, resetTodayTitlesForTests, type Dispatch } from "../src/omni/today";
import { resetOmniStoreForTests } from "../src/omni/store";
import { resetDb } from "./helpers";
import { encodeCursor, decodeCursor, type QuerySpec } from "@prism/core/database";

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
  resetTodayTitlesForTests();
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

test("task pages include all visible tasks and keep status filters and use opaque cursor with a fixed bound", async () => {
  const calls: QuerySpec[] = [];
  let next: string | undefined;
  const dispatch: Dispatch = async (path, init) => {
    assert.equal(path, "/api/query");
    assert.equal(init.method, "POST");
    const spec = init.body as QuerySpec;
    calls.push(spec);
    assert.equal(spec.assignedToMe, undefined);
    assert.equal(spec.includeTypedTasks, true);
    assert.equal(spec.limit, 50);
    assert.deepEqual(spec.tags, ["task"]);
    assert.deepEqual(spec.filter, { match: "all", conditions: [{ key: "status", op: "nin", value: ["completed", "cancelled", "archived", "done"] }] });
    assert.equal(decodeCursor(spec), calls.length === 1 ? 0 : 50);
    next ??= encodeCursor(50, spec);
    return json({ rows: [task], next: calls.length === 1 ? next : null, total: 51, limited: true, truncated: true, identity: "person" });
  };
  const first = await buildTasksPage(dispatch);
  assert.equal(first.next, next); assert.equal(first.total, 51);
  assert.equal(first.limited, true); assert.equal(first.truncated, true);
  assert.equal(first.identity, "person");
  assert.equal((first.tasks as Array<{ noteId: string }>)[0]?.noteId, "t1");
  const second = await buildTasksPage(dispatch, next);
  assert.equal(second.next, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.cursor, next);
});

test("task page retries a transient read but never converts a failed read into an empty full inventory", async () => {
  let calls = 0;
  const dispatch: Dispatch = async () => { calls++; return json({ error: "vault_error" }, 502); };
  await assert.rejects(buildTasksPage(dispatch, undefined, { retryDelayMs: 1 }), /vault_error/);
  assert.equal(calls, 2);
});


test("Omni task dispatcher preserves selected vault and caller credentials", async t => {
  const enabled = process.env.OMNI_ENABLED;
  process.env.OMNI_ENABLED = "true";
  t.after(() => { if (enabled === undefined) delete process.env.OMNI_ENABLED; else process.env.OMNI_ENABLED = enabled; });
  const app = new Hono();
  const cookie = sessionCookie(makeSession("owner@test.local"));
  app.post("/api/query", async c => {
    assert.equal(c.req.header("x-prism-vault"), "selected-vault");
    assert.equal(c.req.header("cookie"), cookie);
    assert.equal((await c.req.json()).includeTypedTasks, true);
    return c.json({ rows: [task], next: null });
  });
  app.route("/api/omni", omniApi);
  mountOmni(app);
  const response = await app.request("/api/omni/tasks", { headers: { cookie, "x-prism-vault": "selected-vault" } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(((await response.json()) as { tasks: Array<{ noteId: string }> }).tasks[0]?.noteId, "t1");
});

test("readable titles: an untitled row is named by its first H1 (read once per revision), else its path leaf in words", async () => {
  const reads: string[] = [];
  const bodies: Record<string, string | null> = { t1: "Intro line\n\n# Call **Dana** about the lease\n", t2: "no heading", m1: "# Ops sync" };
  const dispatch: Dispatch = async (path, init) => {
    if (init.method === "GET") {
      const id = decodeURIComponent(path.split("/").pop()!);
      reads.push(id);
      return bodies[id] === null ? json({ error: "not_found" }, 404) : json({ id, content: bodies[id] });
    }
    return tagOf(init.body) === "meeting"
      ? json({ rows: [{ id: "m1", path: "meetings/ops-sync", updatedAt: "u1", metadata: { date: "2026-10-09", start: "2026-10-09T15:00:00Z" } }] })
      : json({ rows: [
          { id: "t1", path: "tasks/app-2-app-2-defined", updatedAt: "u1", metadata: { status: "open" } },
          { id: "t2", path: "tasks/file_the-taxes", updatedAt: "u1", metadata: { status: "open" } },
          { id: "t3", path: "tasks/titled", updatedAt: "u1", metadata: { title: "Already titled", status: "open" } },
        ] });
  };
  const t = (await buildToday(dispatch, "2026-10-09", { retryDelayMs: 1 })) as unknown as { agenda: Array<{ title: string; start: string }>; tasks: Array<{ noteId: string; title: string }> };
  assert.deepEqual(t.tasks.map((x) => x.title), ["Call Dana about the lease", "File the taxes", "Already titled"]);
  assert.deepEqual(t.agenda.map((x) => [x.title, x.start]), [["Ops sync", "2026-10-09T15:00:00Z"]]);
  assert.deepEqual(reads.sort(), ["m1", "t1", "t2"], "titled rows are never read");
  await buildToday(dispatch, "2026-10-09", { retryDelayMs: 1 });
  assert.equal(reads.length, 3, "an unchanged note is read once");
});
