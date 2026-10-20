/**
 * ClickUp / Fathom / Fireflies ingest, review round 2 — what a TIMEOUT may and may not do.
 *  3. A Fireflies pass that already uploaded audio never hands its scheduled slot back.
 *  4. A body that drips is the upstream's timeout, not a failure on our side.
 *  5. Fathom: a summary/transcript request that times out fails the meeting (the note is create-only).
 * Nothing here reaches a real service: `globalThis.fetch` is a fake for the upstream API and the vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as scheduler from "../src/worker/scheduler";
import { config } from "../src/config";
import { getVaultRegistry } from "../src/db";
import { putSecret } from "../src/secrets";
import { resetSourceHealth } from "../src/worker/health";
import { resetDb } from "./helpers";

type Source = "clickup" | "fathom" | "fireflies";
const UPSTREAM: Record<Source, RegExp> = { clickup: /api\.clickup\.com/, fathom: /fathom/i, fireflies: /api\.fireflies\.ai/ };
const SECRET: Record<Source, unknown> = { clickup: { apiKey: "pk_test" }, fathom: { apiKey: "test" }, fireflies: { apiKey: "test" } };
const entry = () => getVaultRegistry()[0]!;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_r, rej) => (t = setTimeout(() => rej(new Error(`hung: ${what}`)), ms)))]).finally(() => clearTimeout(t));
};

const logs = { warn: console.warn, error: console.error, log: console.log };
const prev = { hours: config.firefliesSyncHours, upstream: (config as { ingestUpstreamTimeoutMs?: number }).ingestUpstreamTimeoutMs };
let net: { restore(): void } | null = null;
beforeEach(() => {
  resetDb();
  resetSourceHealth();
  scheduler.resetIngestFailures();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  console.warn = console.error = console.log = () => {};
  (config as { firefliesSyncHours: number[] }).firefliesSyncHours = Array.from({ length: 24 }, (_, h) => h);
});
afterEach(() => {
  Object.assign(console, logs);
  net?.restore();
  net = null;
  (config as { firefliesSyncHours: number[] }).firefliesSyncHours = prev.hours;
  (config as { ingestUpstreamTimeoutMs?: number }).ingestUpstreamTimeoutMs = prev.upstream;
});

/** A fake network from two handlers; `net` restores it. Every call is recorded with its method + body. */
function scripted(upstream: (url: string, init: RequestInit | undefined, body: string) => Response | Promise<Response>, vaultAnswer: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () => json([])) {
  const calls = { upstream: [] as Array<{ url: string; body: string }>, vault: [] as Array<{ url: string; method: string }> };
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (Object.values(UPSTREAM).some((re) => re.test(url))) {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.upstream.push({ url, body });
      return upstream(url, init, body);
    }
    calls.vault.push({ url, method: init?.method ?? "GET" });
    return vaultAnswer(url, init);
  }) as typeof fetch;
  net = { restore: () => void (globalThis.fetch = before) };
  return calls;
}
/** Headers at once, then a body that never ends — it only errors when the caller's signal aborts. */
const drip = (init: RequestInit | undefined): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const hang = (init: RequestInit | undefined): Promise<Response> => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));

test("4: an upstream that sends headers and then DRIPS the body is an upstream timeout — fathom fails by that name, fireflies keeps its slot", async () => {
  (config as { ingestUpstreamTimeoutMs?: number }).ingestUpstreamTimeoutMs = 150;
  putSecret(entry().id, config.ownerEmail, "fathom", JSON.stringify(SECRET.fathom));
  putSecret(entry().id, config.ownerEmail, "fireflies", JSON.stringify(SECRET.fireflies));
  const calls = scripted((_url, init) => drip(init));
  await assert.rejects(within(scheduler.runFathomOnce(entry(), { force: true }), 3000, "the pass hung on a dripping body"), (e: Error) => {
    assert.equal(e.name, "UpstreamTimeoutError", `the failure is the upstream's (${e.name}: ${e.message})`);
    return true;
  });

  // Fireflies: the same drip on its listing is NOT "our side" — the slot is not handed back.
  await assert.rejects(within(scheduler.runFirefliesOnce(entry()), 3000, "the fireflies pass hung"));
  const before = calls.upstream.length;
  assert.equal(await within(scheduler.runFirefliesOnce(entry()), 3000, "a throttled call"), 0);
  assert.equal(calls.upstream.length, before, "no second pass in the slot: Fireflies was not asked again");
});

test("5: fathom — a summary request that TIMES OUT fails the meeting; the note is written whole by the next pass, never summary-less for good", async () => {
  (config as { ingestUpstreamTimeoutMs?: number }).ingestUpstreamTimeoutMs = 150;
  putSecret(entry().id, config.ownerEmail, "fathom", JSON.stringify(SECRET.fathom));
  let summaryHangs = true;
  const posted: string[] = [];
  const calls = scripted(
    (url, init) => {
      if (/\/meetings\?/.test(url)) return json({ items: [{ recording_id: 77, title: "Planning", created_at: new Date().toISOString() }] });
      if (/\/summary$/.test(url)) return summaryHangs ? hang(init) : json({ markdown: "## Decisions\n\nShip it." });
      if (/\/transcript$/.test(url)) return json({ transcript: [{ speaker: "Ana", text: "Shall we ship it?" }] });
      return json({});
    },
    (_url, init) => {
      if (init?.method === "POST") {
        posted.push(String(init.body));
        return json({ id: "n1", content: "", path: "p", createdAt: "t", updatedAt: "t" });
      }
      return json([]);
    },
  );
  await assert.rejects(within(scheduler.runFathomOnce(entry(), { force: true }), 3000, "the pass hung on the summary"), /did not answer within/);
  assert.deepEqual(posted, [], "no note was created from half of the meeting");
  assert.ok(calls.upstream.some((c) => /\/summary$/.test(c.url)));

  summaryHangs = false;
  assert.equal(await within(scheduler.runFathomOnce(entry(), { force: true }), 3000, "the second pass"), 1);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /Ship it\./, "the summary is in the note");
  assert.match(posted[0]!, /Shall we ship it\?/, "…and so is the transcript");
});

test("3: fireflies — a pass that UPLOADED audio and then died on our side keeps its slot: no second upload minutes later", { timeout: 30_000 }, async () => {
  putSecret(entry().id, config.ownerEmail, "fireflies", JSON.stringify(SECRET.fireflies));
  const calls = scripted((_url, _init, body) => {
    if (/uploadAudio/.test(body)) return json({ data: { uploadAudio: { success: true } } });
    if (/transcripts\(/.test(body)) return json({ data: { transcripts: [{ id: "t-empty", title: "Standup", date: Date.now(), audio_url: "https://cdn.fireflies.test/a.mp3", host_email: "me@test.local", organizer_email: "me@test.local" }] } });
    if (/transcript\(id/.test(body)) return json({ data: { transcript: {} } }); // recorded, never transcribed
    return json({ data: { user: { email: "me@test.local", minutes_consumed: 1 } } });
  });
  const uploads = () => calls.upstream.filter((c) => /uploadAudio/.test(c.body)).length;
  // The pass dies on OUR side right after the upload (here: while reporting it).
  console.log = (...a: unknown[]) => {
    if (/RECOVERED/.test(String(a[0]))) throw new Error("our side broke after the upload");
  };
  await assert.rejects(within(scheduler.runFirefliesOnce(entry()), 12_000, "the first pass"), /our side broke/);
  assert.equal(uploads(), 1, "the audio was handed to Fireflies once");

  const before = calls.upstream.length;
  await within(scheduler.runFirefliesOnce(entry()), 12_000, "the next tick").catch(() => undefined);
  assert.equal(uploads(), 1, "…and not again in the same slot");
  assert.equal(calls.upstream.length, before, "the slot was kept: Fireflies was not asked anything");
});
