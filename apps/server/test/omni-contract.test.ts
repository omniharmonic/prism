/**
 * The Hermes contract (scripts/lib/omni-contract.ts) against the STUB. The same checks run
 * against a real Hermes with `scripts/omni-contract.ts`; passing both is what keeps the
 * stub honest — it can no longer agree with the gateway only because one author wrote both.
 * No socket, no model, nothing outward.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHermesStub, defaultScript, type StubTurn } from "../scripts/lib/hermes-stub";
import { runContract, STUB_DRIVER, type ContractCall, type ContractResult } from "../scripts/lib/omni-contract";

const KEY = "contract-test-key-0123456789abcdef";
/** The scripted turn with its pauses shortened 100× (a 1 s step is 10 ms). */
const quick = (t: StubTurn): StubTurn => ({ ...t, delayMs: 0, startMs: t.startMs ? 80 : undefined, acts: t.acts.map((a) => ("wait" in a ? { wait: Math.max(10, Math.round(a.wait / 100)) } : a)) });

function harness() {
  const stub = createHermesStub({ key: KEY, keepaliveMs: 40, script: (ctx) => quick(defaultScript(ctx)), jobs: [] });
  const call: ContractCall = (method, path, body, o) =>
    stub.fetch(`http://127.0.0.1:18642${path}`, { method, headers: { ...(o?.auth === false ? {} : { authorization: `Bearer ${KEY}` }), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: o?.signal });
  return { stub, call };
}
const failed = (rs: ContractResult[]) => rs.filter((r) => !r.ok).map((r) => `${r.id} ${r.name} → ${r.note}`);

test("the stub meets every assumption the gateway makes about Hermes (full depth)", async () => {
  const { stub, call } = harness();
  const results = await runContract({ call, depth: "full", driver: STUB_DRIVER, jobs: true, keepalive: { silentSeconds: 30, withinMs: 250 }, settleMs: 120, turnTimeoutMs: 10_000 });
  assert.deepEqual(failed(results), []);
  assert.deepEqual(
    results.map((r) => r.id),
    ["1a", "1b", "1c", "1d", "2a", "2b", "2c", "2d", "2e", "7a", "3a", "3b", "3c", "7b", "5", "6a", "6b", "8a", "8b", "4a", "4b", "4c", "10", "9", "11"],
  );
  assert.equal(stub.sessions.size, 0, "every session the checks made was deleted");
  assert.equal(stub.jobs.length, 0, "…and every job");
});

test("depths: `safe` makes no model call; `turn` adds one plain message; a wrong key stops at once", async () => {
  const { stub, call } = harness();
  let chats = 0;
  const counting: ContractCall = (m, p, b, o) => {
    if (p.endsWith("/chat/stream")) chats++;
    return call(m, p, b, o);
  };
  const safe = await runContract({ call: counting, depth: "safe" });
  assert.deepEqual(failed(safe), []);
  assert.equal(chats, 0);
  assert.equal(safe[safe.length - 1]!.id, "7a");
  const turn = await runContract({ call: counting, depth: "turn", driver: STUB_DRIVER, settleMs: 50 });
  assert.deepEqual(failed(turn), []);
  assert.equal(chats, 2, "the plain turn, and the hang-up check");
  assert.equal(stub.sessions.size, 0);
  // The wrong key: the list is refused, and nothing else is attempted (or created).
  const wrong: ContractCall = (m, p, b, o) => stub.fetch(`http://127.0.0.1:18642${p}`, { method: m, headers: o?.auth === false ? {} : { authorization: "Bearer not-the-key-0123456789" }, body: b === undefined ? undefined : JSON.stringify(b) });
  const refused = await runContract({ call: wrong, depth: "full", driver: STUB_DRIVER });
  assert.deepEqual(refused.map((r) => [r.id, r.ok]), [["1a", true], ["1b", false]]);
  assert.ok(!JSON.stringify(refused).includes("not-the-key"), "a result never quotes a credential");
});

test("a Hermes that differs is caught: each of the first stub's assumptions fails a check", async () => {
  const { stub, call } = harness();
  // A Hermes that (as the first stub did) sends tool.failed and run.failed, and lists archived sessions.
  const old = createHermesStub({
    key: KEY,
    script: (ctx) => {
      if (ctx.message.includes("toolfail")) return { acts: [{ frame: ["tool.started", { tool_name: "t", args: {} }] }, { frame: ["tool.failed", { tool_name: "t", preview: "no" }] }, { say: "failed" }] };
      if (ctx.message.includes("stub:error")) return { acts: [{ frame: ["run.failed", { code: "auth_failed" }] }], end: "truncate" };
      return quick(defaultScript(ctx));
    },
  });
  const drifted: ContractCall = async (m, p, b, o) => {
    const res = await old.fetch(`http://127.0.0.1:18642${p}`, { method: m, headers: { ...(o?.auth === false ? {} : { authorization: `Bearer ${KEY}` }) }, body: b === undefined ? undefined : JSON.stringify(b), signal: o?.signal });
    if (m === "GET" && p.startsWith("/api/sessions?")) {
      // …and whose list still shows archived sessions.
      const j = (await res.json()) as { data: unknown[] };
      return new Response(JSON.stringify({ ...j, data: [...old.sessions.values()].map((s) => ({ id: s.id })) }), { status: 200 });
    }
    return res;
  };
  const results = await runContract({ call: drifted, depth: "full", driver: STUB_DRIVER, settleMs: 80, turnTimeoutMs: 5_000 });
  const bad = results.filter((r) => !r.ok).map((r) => r.id);
  for (const id of ["2e", "6b", "8a"]) assert.ok(bad.includes(id), `${id} should fail against a drifted Hermes (failed: ${bad.join(", ")})`);
  void stub;
});
