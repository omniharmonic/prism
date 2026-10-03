/**
 * Fifth independent review of the conversion change (round 6) — the conversion
 * service's half. (The collab half: collab-round6.test.ts.)
 *
 *  B1  A lone `\r` is a line break to `marked` and was none to the pre-check: a
 *      body that used bare `\r` as its separator was ONE line (one node) to the
 *      inline gate and thousands of list items / millions of table cells to the
 *      parser, on the main thread.
 *  B2  A whitespace-only line holding a TAB is a table row to `marked` and ended
 *      the block for the pre-check.
 *  →   The pre-check no longer models block structure; line breaks are normalised
 *      ONCE before both it and the parser. The invariant it exists for — what the
 *      parser produces is bounded by what was counted — is asserted directly, on
 *      seeded random bodies.
 *  S1  A conversion that KILLED its worker cost the actor nothing and was not
 *      remembered.
 *  S6  Timeouts of load-path conversions were charged to whoever opened the note.
 *
 * HOSTILE SHAPES ARE NEVER CONVERTED INLINE HERE unless the pre-check (the new
 * one) calls them cheap; this file cannot be run against the old pre-check — it
 * would do on the event loop exactly what the review describes.
 */
import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as service from "../src/convert/service";
import { ConversionError, configureConversion, contentToSeed, conversionStats, forgetConversionFailures, isCheapContent, stopConversionWorkers, type ConversionWorker } from "../src/convert/service";
import * as precheck from "../src/convert/precheck";
import * as core from "../src/convert/core";
import { WorkerFailedError } from "../src/transfer/worker-pool";
import { BREAK_VARIANTS, HTML_SHAPES, MD_SHAPES, tableHead } from "./fixtures/conversion-shapes";

let restore: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const r of restore.splice(0).reverse()) await r();
  forgetConversionFailures();
});
after(async () => {
  await service.setConversionWorkerFactory(null);
  await stopConversionWorkers();
});

const LOOP_BUDGET_MS = 200;
/** Run `fn` while a 10 ms timer measures the longest gap between its ticks (the event loop's worst stall). */
async function probed<T>(fn: () => Promise<T> | T): Promise<{ value?: T; error?: unknown; maxLagMs: number; ms: number }> {
  let last = performance.now();
  let maxLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 10);
    last = now;
  }, 10);
  const start = performance.now();
  try {
    const value = await fn();
    return { value, maxLagMs: Math.max(maxLagMs, performance.now() - last - 10), ms: performance.now() - start };
  } catch (error) {
    return { error, maxLagMs: Math.max(maxLagMs, performance.now() - last - 10), ms: performance.now() - start };
  } finally {
    clearInterval(timer);
  }
}
const reasonOf = (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e) => (e instanceof ConversionError ? e.reason : `threw ${String(e)}`));
const nodesOf = (body: string) => precheck.complexityOf(precheck.normalizeLineBreaks(body), true).nodes;

// ── B1 ──────────────────────────────────────────────────────────────────────

test("B1: line breaks are normalised once, before the pre-check AND the parser — `\\r`, `\\r\\n` and `\\n` are the same input", async () => {
  assert.equal(precheck.normalizeLineBreaks("a\r\nb\rc\n\r\r\nd"), "a\nb\nc\n\n\nd");
  assert.equal(precheck.normalizeLineBreaks("no carriage returns"), "no carriage returns");
  const md = "# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const want = await service.markdownToHtml(md);
  const seed = JSON.stringify(await service.contentToDocJson(md));
  for (const br of ["\r", "\r\n"]) {
    const variant = md.replaceAll("\n", br);
    assert.deepEqual(precheck.complexityOf(precheck.normalizeLineBreaks(variant), true), precheck.complexityOf(md, true), `the pre-check sees ${JSON.stringify(br)} bodies as the \\n body`);
    assert.equal(await service.markdownToHtml(variant), want);
    assert.equal(JSON.stringify(await service.contentToDocJson(variant)), seed);
    assert.equal(core.markdownToHtmlSync(variant), want, "the core (what the worker runs) normalises too");
    assert.equal(JSON.stringify(service.contentToDocJsonBounded(variant)), seed, "…and the bounded synchronous form");
  }
  // Stored HTML likewise (a DOM parser normalises CR too; ours is handed the normalised text).
  assert.equal(JSON.stringify(await service.contentToDocJson("<p>a</p>\r<p>b</p>")), JSON.stringify(await service.contentToDocJson("<p>a</p>\n<p>b</p>")));
});

test("B1: a body that uses a lone `\\r` as its line separator is counted line by line — never one 'line' on the main thread", async () => {
  const items = "- a\r".repeat(6000); // 24 KB: 6,000 list items for marked
  assert.ok(items.length <= 24_000);
  assert.ok(nodesOf(items) >= 6000, `counted ${nodesOf(items)} nodes`);
  assert.equal(isCheapContent(items, true), false, "6,000 list items are not 'obviously tiny'");
  assert.throws(() => service.contentToSeedBounded(items), (e) => e instanceof ConversionError && e.reason === "too_large", "the synchronous form refuses it");
  // The review's table: ~3.4 M cells from 24 KB.
  const cells = "|a".repeat(300) + "\r" + "|-".repeat(300) + "\r" + "a\r".repeat(11_400);
  assert.ok(cells.length <= 24_100, `${cells.length} bytes`);
  assert.ok(nodesOf(cells) >= 3_400_000, `counted ${nodesOf(cells)} nodes`);
  assert.equal(isCheapContent(cells, true), false);
  assert.equal(service.conversionRefusal(cells, true), "too_many_nodes", "refused up front, by name");
  const before = { ...conversionStats };
  await assert.rejects(contentToSeed(cells), (e) => e instanceof ConversionError && e.reason === "too_many_nodes");
  assert.equal(conversionStats.inline, before.inline, "not converted inline");
  assert.equal(conversionStats.worker, before.worker, "not handed to a worker either");
  // Even a caller that skipped the normalisation is safe: `\r` ends a line for the counter itself.
  assert.ok(precheck.markdownComplexity(items).nodes >= 6000);
  assert.ok(precheck.markdownComplexity(cells).nodes >= 3_400_000);
});

// ── B2 ──────────────────────────────────────────────────────────────────────

test("B2: no kind of blank line ends a table for the pre-check — tab-only, space+tab, NBSP, form-feed lines are rows", () => {
  for (const [label, blank] of [["tab", "\t\n"], ["space + tab", " \t\n"], ["NBSP", " \n"], ["form feed", "\f\n"], ["spaces", "  \n"], ["empty", "\n"], ["quote marker", ">\n"]] as const) {
    const bomb = tableHead(61) + blank.repeat(Math.floor(23_700 / blank.length)) + "x\n";
    assert.ok(bomb.length <= 24_000, `${label}: ${bomb.length} bytes`);
    assert.ok(nodesOf(bomb) >= 61 * (bomb.split("\n").length - 3), `${label}: counted ${nodesOf(bomb)} nodes for ${bomb.split("\n").length} lines × 61 columns`);
    assert.equal(isCheapContent(bomb, true), false, `${label}-only lines after a 61-column header`);
    // Up front (no thread spent): refused when the lines really are rows for marked. An empty or
    // spaces-only line DOES end a table there — those bodies are thousands of blank lines, for the worker.
    const rows = label !== "spaces" && label !== "empty";
    assert.equal(service.conversionRefusal(bomb, true), rows ? "too_many_nodes" : null, `${label}: ${rows ? "refused up front" : "not a table bomb — convertible"}`);
  }
  // The refusal bounds cells PER TABLE: a long ordinary note with a small table near its top is not refused
  // (the inline gate's document-wide bound would be 2 × 6 × 6,000 "cells").
  const longNote = "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n\n" + "a line of prose\n\n".repeat(3000);
  assert.equal(service.conversionRefusal(longNote, true), null, "a long note with one small table is convertible");
  assert.equal(isCheapContent(longNote, true), false);
  assert.ok(precheck.complexityOf(longNote, true).nodes > precheck.complexityOf(longNote, true).parseNodes);
  // A delimiter row ANYWHERE counts — far below the top, inside a list item, inside a quote, behind a `\r`.
  assert.equal(isCheapContent("word\n".repeat(20) + tableHead(40) + "x\n".repeat(20), true), false);
  assert.equal(isCheapContent("- " + "|a".repeat(40) + "\n  " + "|-".repeat(40) + "\n" + "  x\n".repeat(20), true), false);
  assert.equal(isCheapContent("> " + "|a".repeat(40) + "\n> " + "|-".repeat(40) + "\n" + "> x\n".repeat(20), true), false);
  assert.equal(isCheapContent("|a".repeat(40) + "\r" + "|-".repeat(40) + "\r" + "x\r".repeat(20), true), false);
  // What people write stays inline: a small table, a rule, a time range, pipes in prose.
  assert.equal(isCheapContent("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n", true), true);
  assert.equal(isCheapContent("intro\n\n---\n\n" + "a line of prose\n".repeat(60), true), true, "a rule is not a delimiter row");
  assert.equal(isCheapContent("9:00 - 10:30\n" + "a line of prose\n".repeat(60), true), true, "a time range is not a delimiter row");
  assert.equal(isCheapContent("x | y\n".repeat(100), true), true, "pipes without a delimiter row are text");
});

test("S5: nesting is bounded by a line's WHOLE leading run — indentation after `>` or a list marker counts, and so does depth × lines", () => {
  const depth = (md: string) => precheck.complexityOf(md, true).nestDepth;
  assert.ok(depth("> " + "  ".repeat(60) + "- x") >= 60, "indentation after a quote marker");
  assert.ok(depth("- " + "  ".repeat(60) + "- x") >= 60, "indentation after a list marker");
  assert.ok(depth(" ".repeat(120) + "- x") >= 60, "any blank is indentation");
  let s5 = "";
  for (let i = 0; i < 150; i++) s5 += "> " + "  ".repeat(i) + "- x\n";
  assert.ok(s5.length <= 24_000, `${s5.length} bytes`);
  assert.equal(isCheapContent(s5, true), false, "the review's shape: ~150 nested lists from 23 KB");
  // 120 lines, each opening 30 containers: lines × depth, as multiplicative as a table.
  const deep = ("> ".repeat(30) + "x\n\n").repeat(120);
  assert.ok(nodesOf(deep) >= 120 * 30, `counted ${nodesOf(deep)}`);
  assert.equal(isCheapContent(deep, true), false);
});

// ── every audited shape × every kind of line break ──────────────────────────

/** The largest input of a shape the pre-check calls cheap (0 = none), by bisection — never beyond the inline byte cap. */
function largestCheap(make: (n: number) => string, markdown: boolean): string | null {
  let lo = 8;
  let hi = 26_000;
  if (!isCheapContent(make(lo), markdown)) return null;
  while (hi - lo > 32) {
    const mid = (lo + hi) >> 1;
    if (isCheapContent(make(mid), markdown)) lo = mid;
    else hi = mid;
  }
  return make(lo);
}

test("B1/B2: every audited shape, with every kind of line break, is either not cheap or converts inline without stalling the loop", { timeout: 400_000 }, async () => {
  await contentToSeed("<p>warm</p>"); // module + JIT warm-up is not what is measured
  await contentToSeed("warm *up*\n\n- a\n\n| a |\n|-|\n| b |\n");
  const worst: Array<[string, number, number]> = [];
  let measured = 0;
  let refused = 0;
  for (const [kind, shapes, markdown] of [["Markdown", MD_SHAPES, true], ["HTML", HTML_SHAPES, false]] as const) {
    for (const [label, make] of shapes) {
      if (!make(400).includes("\n")) continue; // one line: no variant differs from the shape itself (round 5's test)
      for (const [variant, vary] of BREAK_VARIANTS) {
        const name = `${kind}, ${label}, ${variant}`;
        const shape = (n: number) => vary(make(n));
        // Whatever is cheap is MEASURED: the largest cheap input of the shape, and the shape at the
        // sizes the reviews used when the pre-check calls it cheap there (a "line break" that is
        // none to any parser makes some shapes one long line — cheap, and it must really be).
        const inputs = new Set<string>();
        const largest = largestCheap(shape, markdown);
        if (largest !== null) inputs.add(largest);
        for (const size of [12_000, 24_000]) {
          const at = shape(size).slice(0, size);
          if (isCheapContent(at, markdown)) inputs.add(at);
        }
        if (inputs.size === 0) refused++;
        for (const input of inputs) {
          assert.ok(input.length <= 24_100, `${name}: inline input is ${input.length} bytes`);
          const before = conversionStats.inline;
          const r = await probed(() => contentToSeed(input));
          assert.ok(r.error === undefined || r.error instanceof ConversionError, `${name}: ${String(r.error)}`);
          assert.equal(conversionStats.inline, before + 1, `${name}: converted inline`);
          measured++;
          worst.push([`${name} (${input.length} B)`, Math.round(r.maxLagMs), Math.round(r.ms)]);
          assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `${name}: ${input.length} bytes inline stalled the loop ${r.maxLagMs.toFixed(0)} ms`);
        }
      }
    }
  }
  worst.sort((a, b) => b[1] - a[1]);
  console.log(`round 6 shapes × line breaks: ${measured} inputs measured inline, ${refused} shape variants never inline; worst (lag ms, total ms):`, JSON.stringify(worst.slice(0, 8)));
});
// ── the invariant itself, on random input ───────────────────────────────────

/** mulberry32: a seeded PRNG (the test must find the same bodies every run). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABET = ["|", "-", ":", "\t", "\r", "\n", ">", "*", "_", "[", "]", "(", ")", "<", ">", "&", "#", " ", "a"];
/** Fragments that build structure when repeated (what uniform characters almost never do). */
const FRAGMENTS = ["|a", "|-", "|", "-|", ":-|", "- ", "> ", "  ", "\t", "1. ", "* ", "a\n", "\n", "\r", "\r\n", "\t\n", " \n", "x\n", "- a\n", "> a\n", "*a ", "_a ", "[a](", "[", "`a ", "<a ", "</a>", "<!--", "-->", "&amp;", "a ", "# ", "\n\n", "---\n", "===\n", "```\n", "    ", " ", "\f", " "];
function randomBody(rand: () => number): string {
  const max = 16 + Math.floor(rand() * rand() * 4000); // skewed small: most bodies should reach the inline path
  let out = "";
  if (rand() < 0.4) {
    while (out.length < max) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  } else {
    // Runs of fragments: a header-like run, a delimiter-like run, many short rows…
    while (out.length < max) {
      const f = FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]!;
      const pick = rand();
      const times = 1 + Math.floor(rand() * (pick < 0.5 ? 4 : pick < 0.8 ? 40 : 300));
      out += f.repeat(times);
      if (rand() < 0.3) out += rand() < 0.5 ? "\n" : "\r";
    }
  }
  return out.slice(0, 4096);
}

test("property: for random bodies the pre-check calls cheap, the parser's output is bounded by what was counted, and the conversion stays in budget", { timeout: 400_000 }, async () => {
  await contentToSeed("warm *up*\n\n- a\n\n| a |\n|-|\n| b |\n");
  const rand = prng(0x5eed_0006);
  const TAGS_PER_NODE = 2; // measured worst: 1.00 — a counted node is at most an element (a line also counts the containers it opens)
  const BUDGET_MS = 200;
  let cheapBodies = 0;
  let worstRatio = 0;
  let worstMs = 0;
  const failures: string[] = [];
  for (let i = 0; i < 600; i++) {
    const body = randomBody(rand);
    const text = precheck.normalizeLineBreaks(body);
    // (1) as Markdown: what marked makes of it is bounded by the count.
    if (isCheapContent(body, true)) {
      const nodes = precheck.complexityOf(text, true).nodes;
      const html = core.markdownToHtmlSync(text);
      const tags = precheck.htmlTagCount(html);
      const ratio = tags / Math.max(1, nodes);
      if (ratio > worstRatio) worstRatio = ratio;
      if (tags > TAGS_PER_NODE * nodes) failures.push(`#${i}: ${tags} elements from ${nodes} counted nodes (${body.length} B): ${JSON.stringify(body.slice(0, 120))}`);
    }
    // (2) as the service would take it (a body that starts with `<` is stored HTML): inline, in budget.
    const markdown = !core.isStoredHtml(text);
    if (!isCheapContent(body, markdown)) continue;
    cheapBodies++;
    let ms = Infinity;
    for (let attempt = 0; attempt < 2 && ms >= BUDGET_MS; attempt++) {
      const before = conversionStats.inline;
      const started = performance.now();
      await contentToSeed(body).catch((e) => assert.ok(e instanceof ConversionError, String(e)));
      ms = Math.min(ms, performance.now() - started);
      assert.equal(conversionStats.inline, before + 1, `#${i}: converted inline`);
    }
    if (ms > worstMs) worstMs = ms;
    if (ms >= BUDGET_MS) failures.push(`#${i}: ${ms.toFixed(0)} ms inline (${body.length} B): ${JSON.stringify(body.slice(0, 120))}`);
  }
  console.log(`property: ${cheapBodies}/600 random bodies were cheap; worst elements-per-counted-node ${worstRatio.toFixed(2)}, worst inline conversion ${worstMs.toFixed(0)} ms`);
  assert.ok(cheapBodies >= 120, `only ${cheapBodies} random bodies were cheap — the generator no longer exercises the inline path`);
  assert.deepEqual(failures, []);
});

// ── S1 / S6 ─────────────────────────────────────────────────────────────────

/** A conversion "thread" that answers every task as `outcome` says (no real thread, no load). */
function fakeWorkers(outcome: (message: { content?: string }) => "ok" | "die" | "never-up"): { runs: number; make: () => ConversionWorker } {
  const state = {
    runs: 0,
    make: (): ConversionWorker => ({
      pending: 0,
      run<T>(message: unknown): Promise<T> {
        state.runs++;
        const what = outcome(message as { content?: string });
        if (what === "ok") return Promise.resolve("<p>ok</p>" as unknown as T);
        return Promise.reject(new WorkerFailedError("worker_failed", "worker_failed", undefined, what === "die"));
      },
      flush() {},
      async stop() {},
    }),
  };
  return state;
}
/** Ordinary content that is not "tiny": handed to the (fake) worker. */
const prose = (tag: string) => `${tag} ` + "word ".repeat(6000);

test("S1: content that KILLED a conversion thread is remembered by its hash — the same body is refused without a thread, whoever sends it", async () => {
  const fake = fakeWorkers((m) => (m.content?.startsWith("killer") ? "die" : "ok"));
  await service.setConversionWorkerFactory(fake.make);
  restore.push(() => service.setConversionWorkerFactory(null));
  restore.push(configureConversion({ breakerFailures: 0, actorBreakerFailures: 0 }));
  const killer = prose("killer");
  const first = await service.markdownToHtml(killer, { actor: "user:mallory" }).then(() => null, (e) => e as ConversionError);
  assert.ok(first instanceof ConversionError && first.reason === "failed" && first.killedWorker, "the thread died while running it");
  const runs = fake.runs;
  const remembered = conversionStats.remembered;
  assert.equal(await reasonOf(service.markdownToHtml(killer, { actor: "user:mallory" })), "failed");
  assert.equal(await reasonOf(service.markdownToHtml(killer, { actor: "user:alice" })), "failed", "…whoever sends it");
  assert.equal(await reasonOf(service.markdownToHtml(killer)), "failed");
  assert.equal(fake.runs, runs, "no thread was handed the body again");
  assert.equal(conversionStats.remembered, remembered + 3);
  assert.equal(await reasonOf(service.markdownToHtml(prose("fine"))), "ok", "other content converts");
  // Far longer than a timeout's memory: still refused after the ordinary TTL would have passed.
  forgetConversionFailures();
  restore.push(configureConversion({ failureTtlMs: 40, killerTtlMs: 60_000 }));
  assert.equal(await reasonOf(service.markdownToHtml(killer)), "failed");
  await new Promise((r) => setTimeout(r, 120));
  const again = fake.runs;
  assert.equal(await reasonOf(service.markdownToHtml(killer)), "failed");
  assert.equal(fake.runs, again, "still remembered after the timeout TTL");
});

test("S1: a thread that never CAME UP says nothing about the input — not remembered, not charged", async () => {
  const fake = fakeWorkers(() => "never-up");
  await service.setConversionWorkerFactory(fake.make);
  restore.push(() => service.setConversionWorkerFactory(null));
  restore.push(configureConversion({ breakerFailures: 0, actorBreakerFailures: 2 }));
  const body = prose("innocent");
  for (let i = 0; i < 4; i++) {
    const e = await service.markdownToHtml(body, { actor: "user:alice" }).then(() => null, (x) => x as ConversionError);
    assert.ok(e instanceof ConversionError && e.reason === "failed" && !e.killedWorker, `try ${i}: attempted, failed, not blamed on the input`);
  }
  assert.equal(fake.runs, 4, "every try reached a thread: nothing was remembered, nobody was penalised");
});

test("S1: killing workers is charged to the ACTOR — after a few, that actor alone is answered busy (it cannot stay the shared breaker's failing trial)", async () => {
  const fake = fakeWorkers((m) => (m.content?.startsWith("killer") ? "die" : "ok"));
  await service.setConversionWorkerFactory(fake.make);
  restore.push(() => service.setConversionWorkerFactory(null));
  restore.push(configureConversion({ breakerFailures: 0, actorBreakerFailures: 3, actorCooldownMs: 60_000, actorCooldownMaxMs: 60_000 }));
  const mallory = { actor: "user:mallory" };
  const reasons: string[] = [];
  for (let i = 0; i < 4; i++) reasons.push(await reasonOf(service.markdownToHtml(prose(`killer ${i}`), mallory))); // distinct content each time
  assert.deepEqual(reasons, ["failed", "failed", "failed", "busy"], "three dead workers, then this actor is told to come back later");
  const runs = fake.runs;
  assert.equal(await reasonOf(service.markdownToHtml(prose("fine"), mallory)), "busy", "even good content, until the cool-down is over");
  assert.equal(fake.runs, runs, "no thread used for the penalised actor");
  assert.equal(await reasonOf(service.markdownToHtml(prose("fine"), { actor: "user:alice" })), "ok", "nobody else is affected");
});

test("S6: a conversion marked `charge: false` (opening a STORED note) is never held against the actor — a submitted one is", async () => {
  const fake = fakeWorkers((m) => (m.content?.startsWith("killer") ? "die" : "ok"));
  await service.setConversionWorkerFactory(fake.make);
  restore.push(() => service.setConversionWorkerFactory(null));
  restore.push(configureConversion({ breakerFailures: 0, actorBreakerFailures: 3, actorCooldownMs: 60_000, actorCooldownMaxMs: 60_000 }));
  const victim = { actor: "user:victim", charge: false };
  for (let i = 0; i < 5; i++) assert.equal(await reasonOf(service.markdownToHtml(prose(`killer note ${i}`), victim)), "failed", "the notes someone else wrote fail to open…");
  assert.equal(await reasonOf(service.markdownToHtml(prose("their own page"), { actor: "user:victim" })), "ok", "…and the person who opened them is not cooling down");
  // What the same person SUBMITS is charged as before.
  const reasons: string[] = [];
  for (let i = 0; i < 4; i++) reasons.push(await reasonOf(service.markdownToHtml(prose(`killer write ${i}`), { actor: "user:victim" })));
  assert.deepEqual(reasons, ["failed", "failed", "failed", "busy"]);
});
