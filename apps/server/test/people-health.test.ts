/** The `people-link` health source (worker/health.ts): quiet by default. */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSourceHealth, evaluateAlerts, resetSourceHealth } from "../src/worker/health";
import { enqueueCandidate } from "../src/identity-store";
import { _resetLinkJob, startLinkJob, type LinkJobVault } from "../src/people-link-job";
import { resetDb } from "./helpers";

const list = async () => [];
const find = async () => (await getSourceHealth({ list })).find((h) => h.name === "people-link");
const okVault: LinkJobVault = { listNotes: async () => [], updateNote: async () => ({}) as never };
const badVault: LinkJobVault = { listNotes: async () => { throw new Error("vault down token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"); }, updateNote: async () => ({}) as never };
const run = async (v: LinkJobVault, dryRun = true) => {
  _resetLinkJob();
  await startLinkJob(v, "primary", { dryRun, owner: { emails: [] }, paceMs: 0 }).done;
};

beforeEach(() => {
  resetDb();
  resetSourceHealth();
  _resetLinkJob();
});

test("absent until a job has run or something is queued", async () => {
  assert.equal(await find(), undefined);
});

test("reports queue depth and the last job; never stale; alerts only after repeated job errors", async () => {
  enqueueCandidate({ vaultId: "primary", sourceNoteId: "n1", relationship: "email-from", key: { kind: "email", value: "x@example.test" }, candidateIds: ["a", "b"], reason: "ambiguous-key", origin: "test" });
  let h = (await find())!;
  assert.deepEqual({ status: h.status, kind: h.kind, stale: h.staleAfterMs, open: h.detail!.openCandidates, last: h.detail!.lastJobStatus }, { status: "ok", kind: "server", stale: 0, open: 1, last: null });
  assert.ok(!JSON.stringify(h).includes("x@example.test"), "counts only");

  await run(okVault);
  h = (await find())!;
  assert.deepEqual({ status: h.status, last: h.detail!.lastJobStatus, dry: h.detail!.lastJobDryRun, streak: h.failureStreak }, { status: "ok", last: "done", dry: true, streak: 0 });
  assert.ok(h.lastSuccessAt);
  // A year later it is still not "stale": a quiet queue is not an outage.
  const later = (await getSourceHealth({ list, now: Date.now() + 365 * 86_400_000 })).find((x) => x.name === "people-link")!;
  assert.equal(later.status, "ok");

  await run(badVault);
  await run(badVault);
  h = (await find())!;
  assert.deepEqual({ status: h.status, streak: h.failureStreak, last: h.detail!.lastJobStatus }, { status: "ok", streak: 2, last: "error" });
  assert.ok(!h.lastError!.includes("abcdefghijklmnopqrstuvwxyz"), "the error is scrubbed");
  const sent: string[] = [];
  const flags = new Map<string, string>();
  const deps = { send: async (_t: string, subject: string) => void sent.push(subject), writeNote: async () => {}, getFlag: (_v: string, n: string) => flags.get(n) ?? null, setFlag: (_v: string, n: string, val: string) => void flags.set(n, val) };
  assert.deepEqual((await evaluateAlerts([h], { force: true, deps })).alerted, [], "two failed runs do not alert");

  await run(badVault);
  h = (await find())!;
  assert.equal(h.status, "failing");
  assert.deepEqual((await evaluateAlerts([h], { force: true, deps })).alerted, ["people-link"]);
  assert.deepEqual((await evaluateAlerts([h], { force: true, deps })).alerted, [], "once per episode");

  await run(okVault);
  h = (await find())!;
  assert.deepEqual({ status: h.status, streak: h.failureStreak }, { status: "ok", streak: 0 });
});
