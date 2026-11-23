/**
 * Agent dispatch API gating (Phase 3) — the security boundary of the host-process
 * executor: only an owner/admin SESSION may reach it, and validation rejects a
 * missing prompt before anything spawns. (The happy-path dispatch spawns the real
 * claude CLI — covered by scripts/verify-agent-exec.ts, not here, so this suite
 * stays offline and never launches a process.)
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { agentApi, dispatchAllowedTools } from "../src/routes/agent";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAgentRunner, ensureAgentCwd, _resetDispatches, type SpawnedProc } from "../src/agent-exec";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => resetDb());

test("dispatch: no session → 403 (never spawns)", async () => {
  const r = await agentApi.request("/dispatch", { method: "POST", headers: J, body: JSON.stringify({ prompt: "hi" }) });
  assert.equal(r.status, 403);
});

test("dispatch: a capability link is forbidden (admin SESSION only)", async () => {
  const tok = makeCapability("note", "n1", "edit");
  const r = await agentApi.request("/dispatch", {
    method: "POST",
    headers: { ...J, authorization: `Capability ${tok}` },
    body: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(r.status, 403);
});

test("dispatch: owner session but no prompt → 400 (validated before spawn)", async () => {
  const r = await agentApi.request("/dispatch", {
    method: "POST",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ skill: "summarize" }),
  });
  assert.equal(r.status, 400);
});

test("list/stream/cancel require a session", async () => {
  assert.equal((await agentApi.request("/dispatches")).status, 403);
  assert.equal((await agentApi.request("/dispatches/abc")).status, 403);
  assert.equal((await agentApi.request("/stream/abc")).status, 403);
  assert.equal((await agentApi.request("/dispatches/abc/cancel", { method: "POST" })).status, 403);
});

test("get an unknown dispatch (owner) → 404, not a leak", async () => {
  const r = await agentApi.request("/dispatches/does-not-exist", { headers: { cookie: ownerCookie() } });
  assert.equal(r.status, 404);
});

// ── WP0.1: dispatch happy path + SSE deltas, via an injected fake spawner ─────
// (configureAgentRunner swaps the spawner/probe/cwd so nothing real runs.)

function fakeProc() {
  let exitCb: ((code: number | null) => void) | null = null;
  const outCbs: Array<(c: string) => void> = [];
  const proc: SpawnedProc = {
    stdout: { on: (_e, cb) => outCbs.push(cb as (c: string) => void) },
    stderr: { on: () => {} },
    on: (ev, cb) => {
      if (ev === "exit") exitCb = cb as (code: number | null) => void;
    },
    kill: () => exitCb?.(null),
  };
  return { proc, out: (s: string) => outCbs.forEach((cb) => cb(s)), exit: (c: number) => exitCb?.(c) };
}

function withFakeRunner(opts: { maxConcurrent?: number; maxQueue?: number } = {}) {
  _resetDispatches();
  const root = mkdtempSync(join(tmpdir(), "prism-agent-route-"));
  const procs: ReturnType<typeof fakeProc>[] = [];
  configureAgentRunner({
    spawner: () => {
      const p = fakeProc();
      procs.push(p);
      return p.proc;
    },
    cwd: () => ensureAgentCwd(join(root, "cwd")),
    claudePath: () => "/opt/fake/claude",
    memoryProbe: () => ({ swapUsedPct: 0, freePct: 90 }),
    maxConcurrent: opts.maxConcurrent ?? 1,
    maxQueue: opts.maxQueue ?? 20,
  });
  return {
    procs,
    done: () => {
      _resetDispatches();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function dispatch(prompt: string) {
  return agentApi.request("/dispatch", {
    method: "POST",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ prompt }),
  });
}

function parseSSE(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      return { event, data: JSON.parse(data) as unknown };
    });
}

test("SSE streams output DELTAS (not the accumulation) and ends with a final event", async () => {
  const fr = withFakeRunner();
  try {
    const r = await dispatch("hi");
    assert.equal(r.status, 200);
    const { id, status } = (await r.json()) as { id: string; status: string };
    assert.equal(status, "running");
    fr.procs[0]!.out("first ");
    const s = await agentApi.request(`/stream/${id}`, { headers: { cookie: ownerCookie() } });
    assert.equal(s.status, 200);
    const body = s.text();
    await new Promise((res) => setTimeout(res, 20)); // let the stream subscribe
    fr.procs[0]!.out("aaa");
    fr.procs[0]!.out("bbb");
    fr.procs[0]!.exit(0);
    const events = parseSSE(await body);
    assert.deepEqual(
      events.map((e) => e.event),
      ["snapshot", "delta", "delta", "end"],
    );
    assert.equal((events[0]!.data as { output: string }).output, "first ", "snapshot carries output so far, once");
    assert.deepEqual(events[1]!.data, { text: "aaa" });
    assert.deepEqual(events[2]!.data, { text: "bbb" });
    const end = events[3]!.data as { status: string; outputLength: number; output?: string };
    assert.equal(end.status, "done");
    assert.equal(end.outputLength, "first aaabbb".length);
    assert.equal(end.output, undefined, "the final event does not resend the whole output");
  } finally {
    fr.done();
  }
});

test("SSE on an already-terminal dispatch: snapshot + end, then closes", async () => {
  const fr = withFakeRunner();
  try {
    const { id } = (await (await dispatch("hi")).json()) as { id: string };
    fr.procs[0]!.out("x");
    fr.procs[0]!.exit(1);
    const res = await agentApi.request(`/stream/${id}`, { headers: { cookie: ownerCookie() } });
    const events = parseSSE(await res.text());
    assert.deepEqual(
      events.map((e) => e.event),
      ["snapshot", "end"],
    );
    assert.equal((events[1]!.data as { status: string }).status, "error");
  } finally {
    fr.done();
  }
});

test("a second dispatch comes back queued (not failed); a full queue → 503; runner status reports it", async () => {
  const fr = withFakeRunner({ maxConcurrent: 1, maxQueue: 1 });
  try {
    assert.equal(((await (await dispatch("a")).json()) as { status: string }).status, "running");
    const b = (await (await dispatch("b")).json()) as { status: string; queuedReason: string };
    assert.equal(b.status, "queued");
    assert.match(b.queuedReason, /free agent slot/);
    const c = await dispatch("c");
    assert.equal(c.status, 503);
    const st = (await (await agentApi.request("/runner", { headers: { cookie: ownerCookie() } })).json()) as {
      running: number;
      queued: number;
      maxConcurrent: number;
    };
    assert.deepEqual([st.running, st.queued, st.maxConcurrent], [1, 1, 1]);
    assert.equal((await agentApi.request("/runner")).status, 403, "runner status is admin-only too");
  } finally {
    fr.done();
  }
});

// ── WP4.3: a client may NARROW a one-shot dispatch to the read-only vault tools ─

test("dispatch profile: vault-ro narrows --allowedTools; default unchanged; anything else → 400", async () => {
  _resetDispatches();
  const root = mkdtempSync(join(tmpdir(), "prism-agent-route-ro-"));
  const seen: string[][] = [];
  configureAgentRunner({
    spawner: (_cmd, args) => {
      seen.push(args);
      return fakeProc().proc;
    },
    cwd: () => ensureAgentCwd(join(root, "cwd")),
    claudePath: () => "/opt/fake/claude",
    memoryProbe: () => ({ swapUsedPct: 0, freePct: 90 }),
    maxConcurrent: 5,
    maxQueue: 20,
  });
  try {
    const post = (body: unknown) =>
      agentApi.request("/dispatch", { method: "POST", headers: { ...J, cookie: ownerCookie() }, body: JSON.stringify(body) });
    assert.equal((await post({ prompt: "x", profile: "vault-rw" })).status, 400);
    assert.equal((await post({ prompt: "x", profile: "anything" })).status, 400);
    assert.equal(seen.length, 0, "a refused profile never spawns");

    assert.equal((await post({ prompt: "edit this", profile: "vault-ro" })).status, 200);
    assert.equal((await post({ prompt: "legacy" })).status, 200);
    // Spawns are async (queue admission): wait for both.
    for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 2);
    const allowed = (args: string[]) => args[args.indexOf("--allowedTools") + 1]!;
    const ro = allowed(seen[0]!).split(",");
    assert.ok(ro.length > 0 && ro.every((t) => t.startsWith("mcp__parachute-vault__")), "only vault tools");
    for (const w of ["create-note", "update-note", "delete-note"]) assert.ok(!ro.includes(`mcp__parachute-vault__${w}`), `no ${w}`);
    assert.ok(ro.includes("mcp__parachute-vault__query-notes"));
    assert.equal(allowed(seen[1]!), "mcp__parachute-vault", "default stays the whole vault server");
  } finally {
    _resetDispatches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchAllowedTools never widens", () => {
  assert.equal(dispatchAllowedTools(undefined), undefined);
  assert.equal(dispatchAllowedTools("vault-rw"), undefined);
  assert.equal(dispatchAllowedTools("skill"), undefined);
  assert.ok(dispatchAllowedTools("vault-ro")!.length > 0);
});
