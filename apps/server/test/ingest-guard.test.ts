/**
 * ClickUp / Fathom / Fireflies ingest: one pass per (source, vault) at a time.
 *
 * The 60 s tick fires whether or not the last one finished. A pass that overran
 * used to be started again beside itself, and the tick that found it running
 * recorded a SUCCESS — so a pass that hung forever read as healthy. Now the tick
 * skips a running source (no outcome → it goes `stale`), a second caller joins the
 * running pass, the manual sync routes answer 409 `busy`, and every vault call of
 * a pass is bounded.
 *
 * Nothing here reaches a real service: `globalThis.fetch` is a slow fake for the
 * upstream API AND for the vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as scheduler from "../src/worker/scheduler";
import { config } from "../src/config";
import { getVaultRegistry } from "../src/db";
import { putSecret } from "../src/secrets";
import { createApp } from "../src/app";
import { getSourceHealth, resetSourceHealth } from "../src/worker/health";
import { resetDb, makeSession, sessionCookie } from "./helpers";

type Source = "clickup" | "fathom" | "fireflies";
const RUN = { clickup: scheduler.runClickUpOnce, fathom: scheduler.runFathomOnce, fireflies: scheduler.runFirefliesOnce } as const;
const UPSTREAM: Record<Source, RegExp> = { clickup: /api\.clickup\.com/, fathom: /fathom/i, fireflies: /api\.fireflies\.ai/ };
const SECRET: Record<Source, unknown> = { clickup: { apiKey: "pk_test" }, fathom: { apiKey: "test" }, fireflies: { apiKey: "test" } };

// Looked up dynamically so this file loads — and FAILS on its assertions — against a
// scheduler without the guard. The fallback is the tick's loop as it was.
const sched = scheduler as unknown as {
  runIngestersOnce?: () => Promise<void>;
  ingestPassRunning?: (source: Source, vaultId: string) => boolean;
};
const entry = () => getVaultRegistry()[0]!;
async function tickIngesters(): Promise<void> {
  if (sched.runIngestersOnce) return sched.runIngestersOnce();
  for (const name of ["fathom", "fireflies", "clickup"] as const) {
    try {
      await RUN[name](entry());
      scheduler.noteIngestOutcome(entry().id, name, null);
    } catch (e) {
      scheduler.noteIngestOutcome(entry().id, name, e as Error);
    }
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** Upstream answers that end a pass with nothing to do. */
function upstreamAnswer(url: string): Response {
  if (/clickup\.com.*\/user$/.test(url)) return json({ user: { id: 1 } });
  if (/clickup\.com.*\/team$/.test(url)) return json({ teams: [] });
  if (/fireflies/.test(url)) return json({ data: { user: { email: "me@test.local" }, transcripts: [] } });
  return json({ items: [] });
}
/**
 * The fake network. `hold`: upstream calls wait for `release()`. `vault`: "ok" answers
 * an empty list; "hang" never answers (it only rejects when the caller's signal aborts).
 */
function fakeNetwork(o: { hold?: boolean; vault?: "ok" | "hang"; upstream?: "hang" } = {}) {
  const upstream: string[] = [];
  const vault: string[] = [];
  const waiting: Array<() => void> = [];
  let held = !!o.hold;
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (Object.values(UPSTREAM).some((re) => re.test(url))) {
      upstream.push(url);
      // A stalled upstream: no answer, ever — only the caller's own abort ends the request.
      if (o.upstream === "hang") return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
      if (held) await new Promise<void>((r) => waiting.push(r));
      return upstreamAnswer(url);
    }
    vault.push(url);
    if (o.vault === "hang") return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
    return json([]);
  }) as typeof fetch;
  return {
    upstream,
    vault,
    release() {
      held = false;
      for (const w of waiting.splice(0)) w();
    },
    restore() {
      globalThis.fetch = prev;
    },
  };
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_r, rej) => (t = setTimeout(() => rej(new Error(`hung: ${what}`)), ms)))]).finally(() => clearTimeout(t));
};
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), what);
};
const lastSuccess = async (source: Source) => (await getSourceHealth({ list: async () => [] })).find((s) => s.name === source)!.lastSuccessAt;

const logs = { warn: console.warn, error: console.error, log: console.log };
const prev = { hours: config.firefliesSyncHours, timeout: (config as { ingestVaultTimeoutMs?: number }).ingestVaultTimeoutMs, upstream: (config as { ingestUpstreamTimeoutMs?: number }).ingestUpstreamTimeoutMs };
let net: ReturnType<typeof fakeNetwork> | null = null;
beforeEach(() => {
  resetDb();
  resetSourceHealth();
  scheduler.resetIngestFailures();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  console.warn = console.error = console.log = () => {};
  // Fireflies runs only in its scheduled local hours; make every hour one.
  (config as { firefliesSyncHours: number[] }).firefliesSyncHours = Array.from({ length: 24 }, (_, h) => h);
});
afterEach(() => {
  Object.assign(console, logs);
  net?.release();
  net?.restore();
  net = null;
  (config as { firefliesSyncHours: number[] }).firefliesSyncHours = prev.hours;
  (config as { ingestVaultTimeoutMs?: number }).ingestVaultTimeoutMs = prev.timeout;
  (config as { ingestUpstreamTimeoutMs?: number }).ingestUpstreamTimeoutMs = prev.upstream;
});

for (const source of ["clickup", "fathom", "fireflies"] as const) {
  test(`${source}: a tick that finds the pass still running skips it and records NO outcome — a hung pass can only go stale`, async () => {
    putSecret(entry().id, config.ownerEmail, source, JSON.stringify(SECRET[source]));
    net = fakeNetwork({ hold: true });
    const first = tickIngesters(); // this tick's pass is now stuck in its first upstream call
    await until(() => net!.upstream.length === 1, "the pass reached the upstream API");
    assert.equal(sched.ingestPassRunning?.(source, entry().id), true, "the pass is registered as running");

    // The next tick (60 s later, the pass still stuck).
    await within(tickIngesters(), 2000, "the second tick waited on the stuck pass");
    assert.equal(net.upstream.length, 1, "no second pass was started");
    assert.equal(await lastSuccess(source), null, "the tick that found it running recorded nothing");

    net.release();
    await within(first, 2000, "the first pass after its upstream answered");
    assert.equal(sched.ingestPassRunning?.(source, entry().id), false, "the guard is released");
    assert.notEqual(await lastSuccess(source), null, "the pass itself reports once it really finished");
  });
}

test("a second caller while a pass runs JOINS it — the upstream API is asked once, both get the same answer", async () => {
  putSecret(entry().id, config.ownerEmail, "clickup", JSON.stringify(SECRET.clickup));
  net = fakeNetwork({ hold: true });
  const a = scheduler.runClickUpOnce(entry(), { force: true });
  await until(() => net!.upstream.length === 1, "the pass reached the upstream API");
  const b = scheduler.runClickUpOnce(entry(), { force: true }); // forced: the slot throttle does not stop it
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(net.upstream.filter((u) => /\/user$/.test(u)).length, 1, "one pass, not two beside each other");
  net.release();
  assert.deepEqual(await within(Promise.all([a, b]), 2000, "the joined passes"), [0, 0]);
});

test("the manual sync routes answer 409 busy while a pass runs (never a second pass, never queued)", async () => {
  const app = createApp();
  const cookie = sessionCookie(makeSession(config.ownerEmail));
  for (const source of ["clickup", "fathom", "fireflies"] as const) {
    putSecret(entry().id, config.ownerEmail, source, JSON.stringify(SECRET[source]));
    net = fakeNetwork({ hold: true });
    const running = RUN[source](entry(), { force: true });
    await until(() => net!.upstream.length === 1, `${source}: the pass reached the upstream API`);
    const res = await within(
      Promise.resolve(app.request(`/api/integrations/${source}/sync`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: config.appOrigin } })),
      2000,
      `${source}: the route waited on the running pass`,
    );
    assert.equal(res.status, 409, source);
    assert.equal(((await res.json()) as { error: string }).error, "busy");
    assert.equal(net.upstream.length, 1, `${source}: nothing more was asked upstream`);
    net.release();
    await within(running, 2000, `${source}: the pass`);
    net.restore();
    net = null;
  }
});

for (const source of ["clickup", "fathom", "fireflies"] as const) {
  test(`${source}: a vault that never answers fails the pass at INGEST_VAULT_TIMEOUT_MS and frees the guard`, async () => {
    putSecret(entry().id, config.ownerEmail, source, JSON.stringify(SECRET[source]));
    (config as { ingestVaultTimeoutMs?: number }).ingestVaultTimeoutMs = 150;
    net = fakeNetwork({ vault: "hang" });
    const t0 = Date.now();
    await assert.rejects(within(RUN[source](entry(), { force: true }), 3000, "the pass hung on the vault"), (e: Error) => !/^hung:/.test(e.message));
    assert.ok(Date.now() - t0 < 2500);
    assert.ok(net.vault.length >= 1, "the pass did call the vault");
    assert.equal(sched.ingestPassRunning?.(source, entry().id), false);
  });
}

// ── review round S2: a stalled UPSTREAM must not hold the guard for ever ──────

for (const source of ["clickup", "fathom", "fireflies"] as const) {
  test(`${source}: an upstream that never answers fails the pass at INGEST_UPSTREAM_TIMEOUT_MS, records a failure and frees the guard`, async () => {
    putSecret(entry().id, config.ownerEmail, source, JSON.stringify(SECRET[source]));
    (config as { ingestUpstreamTimeoutMs?: number }).ingestUpstreamTimeoutMs = 150;
    net = fakeNetwork({ upstream: "hang" });
    // Through the tick: the outcome it records is what /acl/workers shows.
    await within(tickIngesters(), 3000, "the tick hung on the upstream");
    assert.ok(net.upstream.length >= 1);
    assert.equal(sched.ingestPassRunning?.(source, entry().id), false, "the guard is free again");
    const health = (await getSourceHealth({ list: async () => [] })).find((s) => s.name === source)!;
    // Fireflies swallows a failed identity lookup and fails on the listing that follows; either way it is a failure.
    assert.equal(health.failureStreak, 1, "a recorded failure — not silence");
    assert.match(String(health.lastError), /did not answer within/);
    assert.equal(health.lastSuccessAt, null);
  });
}

test("fireflies: a pass that died on OUR side (the vault listing timed out) hands its scheduled slot back — at most twice", async () => {
  putSecret(entry().id, config.ownerEmail, "fireflies", JSON.stringify(SECRET.fireflies));
  (config as { ingestVaultTimeoutMs?: number }).ingestVaultTimeoutMs = 100;
  net = fakeNetwork({ vault: "hang" });
  const listings = () => net!.upstream.length;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = listings();
    await assert.rejects(within(scheduler.runFirefliesOnce(entry()), 3000, "the pass hung on the vault"));
    assert.ok(listings() > before, `attempt ${attempt} ran (the slot was not spent by the failure before it)`);
  }
  // The slot was handed back twice; the third failure keeps it — no retry storm against the API.
  const before = listings();
  assert.equal(await within(scheduler.runFirefliesOnce(entry()), 3000, "a throttled call"), 0);
  assert.equal(listings(), before, "the fourth call in the slot does not touch Fireflies");
});
