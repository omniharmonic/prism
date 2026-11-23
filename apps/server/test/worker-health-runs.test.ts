/**
 * `/acl/workers` reports RUNS, not ticks (2026-11).
 *
 * On production every source showed the same `lastSuccessAt` — the last tick — a
 * vault with no credential included, and Fireflies read `ok` while every one of its
 * runs failed: each ingester returns early on the ticks it has nothing to do (no
 * credential, not its slot or hour), and those early returns were recorded as
 * successes, which also reset the failure streak between real runs.
 *
 * Here: a skipped tick records nothing; a real run's success / failure is recorded
 * with lastErrorAt and consecutive failures; a refused key / plan is `failing` at
 * once; the record survives a restart. Nothing reaches a real service: fetch is a
 * fake for both the Fireflies GraphQL endpoint and the vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as scheduler from "../src/worker/scheduler";
import { config } from "../src/config";
import { getVaultRegistry } from "../src/db";
import { putSecret } from "../src/secrets";
import { getSourceHealth, recordSourceOutcome, resetSourceHealth, isPermanentError, type SourceHealth } from "../src/worker/health";
import { passSkipped, resetPassSkips } from "../src/worker/pass-skip";
import { resetDb } from "./helpers";

const entry = () => getVaultRegistry()[0]!;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const health = async (): Promise<Map<string, SourceHealth>> => new Map((await getSourceHealth({ list: async () => [] })).map((h) => [h.name, h]));

/** Fake network: Fireflies answers as the FREE plan does to a paid-only field. */
function fakeNetwork(fireflies: (query: string) => Response) {
  const prev = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/api\.fireflies\.ai/.test(url)) {
      const q = (JSON.parse(String(init?.body)) as { query: string }).query;
      queries.push(q);
      return fireflies(q);
    }
    return json([]); // the vault: empty
  }) as typeof fetch;
  return { queries, restore: () => void (globalThis.fetch = prev) };
}

const logs = { warn: console.warn, error: console.error, log: console.log };
const prevHours = config.firefliesSyncHours;
let net: { restore(): void } | null = null;
beforeEach(() => {
  resetDb();
  resetSourceHealth();
  resetPassSkips();
  scheduler.resetIngestFailures();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  console.warn = console.error = console.log = () => {};
  (config as { firefliesSyncHours: number[] }).firefliesSyncHours = Array.from({ length: 24 }, (_, h) => h);
});
afterEach(() => {
  Object.assign(console, logs);
  net?.restore();
  net = null;
  (config as { firefliesSyncHours: number[] }).firefliesSyncHours = prevHours;
});

test("a tick with nothing to do records NO success: no credential → lastSuccessAt stays null", async () => {
  net = fakeNetwork(() => json({ data: {} }));
  await scheduler.runIngestersOnce();
  await scheduler.runIngestersOnce();
  const h = await health();
  for (const src of ["matrix", "clickup", "fathom", "fireflies"]) {
    assert.equal(h.get(src)!.lastSuccessAt, null, `${src}: a skipped tick is not a success`);
    assert.equal(h.get(src)!.lastRunAt, null, `${src}: nor a run`);
    assert.equal(h.get(src)!.status, "disabled");
  }
});

test("fireflies on the free plan (old query): failing at the FIRST refused run, and skipped ticks keep it failing", async () => {
  putSecret(entry().id, config.ownerEmail, "fireflies", JSON.stringify({ apiKey: "k" }));
  // Every Fireflies call refused for the plan — what production saw after the downgrade.
  net = fakeNetwork(() => json({ errors: [{ message: "You need to be subscribed to a paid plan", code: "paid_required" }] }));
  await scheduler.runIngestersOnce();
  let ff = (await health()).get("fireflies")!;
  assert.equal(ff.status, "failing", "a refused plan is not `ok`");
  assert.equal(ff.failureStreak, 1);
  assert.equal(ff.consecutiveFailures, 1);
  assert.equal(ff.lastSuccessAt, null);
  assert.ok(ff.lastErrorAt && ff.lastRunAt);
  assert.match(ff.lastError!, /paid plan/);

  // The next ticks are in the same slot: nothing runs, nothing is recorded.
  await scheduler.runIngestersOnce();
  await scheduler.runIngestersOnce();
  ff = (await health()).get("fireflies")!;
  assert.equal(ff.status, "failing");
  assert.equal(ff.failureStreak, 1, "a skipped tick neither adds to nor resets the streak");
  assert.equal(ff.lastSuccessAt, null, "a skipped tick is not a success");
});

test("fireflies on the free plan (new query): the run succeeds and only then is lastSuccessAt set", async () => {
  putSecret(entry().id, config.ownerEmail, "fireflies", JSON.stringify({ apiKey: "k" }));
  const n = fakeNetwork((q) =>
    /\b(audio_url|video_url|analytics)\b/.test(q)
      ? json({ errors: [{ message: "You need to be subscribed to a pro or higher plan to query audio_url.", code: "paid_required" }] })
      : json({ data: { user: { email: "me@test.local", minutes_consumed: 1, num_transcripts: 0 }, transcripts: [] } }),
  );
  net = n;
  await scheduler.runIngestersOnce();
  const ff = (await health()).get("fireflies")!;
  assert.equal(ff.status, "ok");
  assert.ok(ff.lastSuccessAt);
  assert.equal(ff.failureStreak, 0);
  assert.ok(n.queries.some((q) => /transcripts\(/.test(q)), "the list ran");
  assert.ok(!n.queries.some((q) => /audio_url/.test(q)), "no paid-only field asked for");
});

test("ordinary failures: `failing` after WORKER_FAIL_STREAK real runs even with skipped ticks in between", async () => {
  const v = entry().id;
  for (let i = 0; i < config.workerFailStreak; i++) {
    recordSourceOutcome(v, "clickup", new Error("fetch failed"));
    // what a skipped tick does now: mark, and the scheduler records nothing
    passSkipped(v, "clickup");
  }
  putSecret(v, config.ownerEmail, "clickup", JSON.stringify({ apiKey: "pk" }));
  const c = (await health()).get("clickup")!;
  assert.equal(c.failureStreak, config.workerFailStreak);
  assert.equal(c.status, "failing");
});

test("the record survives a restart: a source that was failing is still failing, its last success kept", async () => {
  const v = entry().id;
  putSecret(v, config.ownerEmail, "fathom", JSON.stringify({ apiKey: "k" }));
  const t0 = Date.now() - 3_600_000;
  recordSourceOutcome(v, "fathom", null, t0);
  recordSourceOutcome(v, "fathom", Object.assign(new Error("fathom http 401"), { status: 401 }));
  resetSourceHealth(); // the process restarts: memory gone, the settings table is not
  const f = (await health()).get("fathom")!;
  assert.equal(f.lastSuccessAt, new Date(t0).toISOString());
  assert.equal(f.status, "failing", "a refused credential is permanent");
  assert.equal(f.failureStreak, 1);
});

test("isPermanentError: auth / plan refusals yes; transport errors no", () => {
  assert.equal(isPermanentError(Object.assign(new Error("x"), { status: 403 })), true);
  assert.equal(isPermanentError(new Error("fireflies graphql: You need to be subscribed to a paid plan")), true);
  assert.equal(isPermanentError(Object.assign(new Error("whatever"), { permanent: true })), true);
  assert.equal(isPermanentError(new Error("fetch failed")), false);
  assert.equal(isPermanentError(new Error("clickup did not answer within 30 s")), false);
});
