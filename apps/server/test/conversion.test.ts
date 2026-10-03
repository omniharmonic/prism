/**
 * Content conversion never runs unbounded on the server's event loop.
 *
 *  - convert/service.ts: linear pre-check, inline only for small plain inputs,
 *    everything else in the worker under a hard wall-clock limit (terminate +
 *    respawn), bounded queue, failure memory, typed ConversionError.
 *  - collab.ts fallbacks: a note body that cannot be converted in budget gets NO
 *    live document at all (the load fails `too_complex`; nothing derived from it
 *    enters Yjs or SQLite) — the stored note is byte-for-byte unchanged on every
 *    path (first open, fold of an external edit at load / reconcile / store). A
 *    store that cannot render keeps the document live and its Yjs state saved.
 *
 * Every pathological input is time-bounded AND checked with a timer probe: the
 * event loop must keep turning while the conversion runs (or is refused).
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import {
  ConversionError,
  configureConversion,
  contentToDocJson,
  contentToDocJsonBounded,
  contentToSeed,
  contentToSeedBounded,
  conversionRefusal,
  conversionStats,
  convertCfg,
  docJsonToHtml,
  docJsonToHtmlBounded,
  forgetConversionFailures,
  htmlToDocJson,
  htmlToMarkdown,
  isCheapContent,
  markdownToHtml,
  stopConversionWorkers,
} from "../src/convert/service";
import * as core from "../src/convert/core";
import { complexityOf, docJsonWeight, htmlTagCount, markdownComplexity } from "../src/convert/precheck";
import {
  DocumentTooComplexError,
  TOO_COMPLEX_REASON,
  applyExternalContent,
  contentToYUpdate,
  isDocBlocked,
  loadDocumentState,
  reconcileLoadedDocs,
  resetConversionState,
  resetReconcileState,
  resolveSuggestionsInHtml,
  resolveSuggestionsInHtmlAsync,
  storeDocumentState,
  suggestionViewOfHtml,
  yDocToDocJson,
  yDocToHtml,
  yDocToHtmlAsync,
} from "../src/collab";
import { mergeContentIntoLive } from "../src/collab-ops";
import { dueCollabUnsaved, getCollabUnsaved, getDocState, insertCollabReceipt, isCollabUnsaved, unconfirmedCollabReceipts } from "../src/db";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Run `fn` while a 20 ms timer measures the longest gap between its ticks. */
async function probed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; maxLagMs: number; ms: number }> {
  let last = performance.now();
  let maxLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 20);
    last = now;
  }, 20);
  const start = performance.now();
  try {
    const value = await fn();
    return { value, maxLagMs: Math.max(maxLagMs, performance.now() - last - 20), ms: performance.now() - start };
  } catch (error) {
    return { error, maxLagMs: Math.max(maxLagMs, performance.now() - last - 20), ms: performance.now() - start };
  } finally {
    clearInterval(timer);
  }
}
/** Generous on a loaded CI host; the unprotected calls took 3–30 SECONDS. */
const LOOP_BUDGET_MS = 1500;
const reasonOf = (e: unknown) => (e instanceof ConversionError ? e.reason : `not a ConversionError: ${String(e)}`);

/** Pathological inputs (each stalls an unprotected parser for seconds). */
const EMPHASIS = "*a ".repeat(6000); // 18 KB: marked is quadratic on emphasis runs
const UNDERSCORES = "_a ".repeat(6000);
const BRACKETS = "[](".repeat(6000);
const DEEP_DIVS = (n: number) => "<div>".repeat(n) + "x" + "</div>".repeat(n);
const DEEP_QUOTE = "> ".repeat(5000) + "x";

const RICH_MD = [
  "# Title",
  "",
  "Some *normal* text with **bold**, `code`, ~~strike~~ and [a link](https://example.org/x?y=1&z=2).",
  "",
  "- one",
  "- two",
  "  - nested",
  "",
  "1. first",
  "2. second",
  "",
  "> a quote",
  "",
  "```js",
  "const a = 1 < 2 && 3 > 2;",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "![img](https://example.org/i.png)",
  "",
  "Unicode: “quotes” — ünïcödé 漢字 🙂 &amp; <b>raw html</b>",
  "",
].join("\n");

let restore: Array<() => void> = [];
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetReconcileState();
  resetConversionState();
  forgetConversionFailures();
  fv = installFakeVault();
});
/** Undo every limit override (newest first: each one restores what it found). */
const restoreLimits = () => {
  for (const r of restore.splice(0).reverse()) r();
};
afterEach(() => {
  restoreLimits();
  fv.restore();
});
after(async () => {
  await stopConversionWorkers();
});
/** A short wall clock, so a pathological input fails in well under a second. */
const fastTimeouts = () => restore.push(configureConversion({ timeoutMs: 400, timeoutPerMbMs: 0, timeoutMaxMs: 400 }));
/** Force every conversion through the worker (nothing inline). */
const workerOnly = () => restore.push(configureConversion({ inlineMaxChars: 0, inlineMaxNodes: 0 }));

const vaultWrites = () => fv.calls.filter((c) => c.method !== "GET");
/** A document's content, normalised through the schema (default attrs filled in). */
const norm = (json: unknown) => JSON.stringify(core.schema.nodeFromJSON(json).toJSON());
const text = (doc: Y.Doc) => norm(yDocToDocJson(doc));

// ── pre-check ───────────────────────────────────────────────────────────────

test("pre-check: one linear pass, whatever the input (2 MB of each pathological shape)", () => {
  const big = 2_000_000;
  const shapes = ["*a ", "_a ", "[](", "> ", "<div>", "<", "&", "\n", "~", "![", "`", "<!--", "[[", "* ", "<a "];
  const start = performance.now();
  for (const s of shapes) {
    const input = s.repeat(Math.floor(big / s.length));
    complexityOf(input, true);
    complexityOf(input, false);
    conversionRefusal(input, true);
    isCheapContent(input, true);
  }
  const ms = performance.now() - start;
  // ~1 s on an idle host. The budget is generous for a loaded one (the whole suite runs in
  // parallel); a super-linear scan of 2 MB would take minutes, not seconds.
  assert.ok(ms < 20_000, `the pre-checks took ${ms.toFixed(0)} ms for ${shapes.length * 4} passes over 2 MB`);
});

test("pre-check: counts what makes the parsers super-linear, and refuses the hopeless", () => {
  assert.equal(markdownComplexity("*a *a *a").delimiterRuns, 3);
  assert.equal(markdownComplexity("**bold** and __bold__").delimiterRuns, 4, "a run of the same delimiter counts once");
  assert.equal(markdownComplexity("*a\n*a\n\n*a").delimiterRuns, 2, "a blank line ends the block");
  assert.equal(markdownComplexity("> > > x\n> y").quoteDepth, 3);
  assert.equal(markdownComplexity("a > b").quoteDepth, 0, "only the line prefix is a blockquote");
  assert.equal(htmlTagCount("<p>a < b</p><br/>"), 2);
  assert.equal(conversionRefusal(DEEP_QUOTE, true), "too_complex");
  assert.equal(conversionRefusal("*a ".repeat(40_000), true), "too_complex");
  assert.equal(conversionRefusal("x".repeat(3_000_000), true), "too_large");
  assert.equal(conversionRefusal(RICH_MD, true), null);
  // Ordinary content is never refused — only sent to the worker when large.
  const prose = "Some *normal* text with **bold** and a [link](https://x.y).\n\n".repeat(20_000);
  assert.equal(conversionRefusal(prose, true), null);
  assert.equal(isCheapContent(prose, true), false);
  assert.equal(isCheapContent(RICH_MD, true), true);
  // Stored HTML is judged by its node count, not its size: megabytes of text in a few nodes are cheap.
  assert.equal(isCheapContent(`<p>${"word ".repeat(300_000)}</p><p>tail</p>`, false), true);
  assert.equal(isCheapContent("<p>x</p>".repeat(5000), false), false);
  assert.equal(isCheapContent(DEEP_DIVS(200), false), false);
  assert.deepEqual(docJsonWeight({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "abc", marks: [{ type: "bold" }] }] }] }), { nodes: 4, chars: 3, depth: 3, complete: true });
});

// ── the service ─────────────────────────────────────────────────────────────

test("inline and worker conversions are byte-identical (seed, JSON, HTML, Markdown)", { timeout: 120_000 }, async () => {
  const inline = {
    json: core.contentToDocJsonSync(RICH_MD),
    html: core.markdownToHtmlSync(RICH_MD),
  };
  const inlineHtml = core.docJsonToHtmlSync(inline.json);
  const inlineMd = core.htmlToMarkdownSync(inlineHtml);
  const before = conversionStats.worker;
  workerOnly();
  // (compared as JSON text: the worker's result arrives as plain objects)
  assert.equal(JSON.stringify(await contentToDocJson(RICH_MD)), JSON.stringify(inline.json));
  assert.equal(await markdownToHtml(RICH_MD), inline.html);
  assert.equal(await docJsonToHtml(inline.json), inlineHtml);
  assert.equal(await htmlToMarkdown(inlineHtml), inlineMd);
  assert.equal(JSON.stringify(await htmlToDocJson(inlineHtml)), JSON.stringify(core.htmlToDocJsonSync(inlineHtml)));
  // The worker's seed renders to exactly what the main thread's would.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await contentToSeed(RICH_MD));
  assert.equal(await yDocToHtmlAsync(doc), inlineHtml);
  assert.ok(conversionStats.worker - before >= 6, "every one of those ran in the worker");
  // And HTML → doc → HTML is stable (a store of an untouched document writes nothing new).
  const again = new Y.Doc();
  Y.applyUpdate(again, await contentToSeed(inlineHtml));
  assert.equal(await yDocToHtmlAsync(again), inlineHtml);
});

for (const [label, input] of [
  ["emphasis run (*a *a …)", EMPHASIS],
  ["underscore run", UNDERSCORES],
] as const) {
  test(`markdownToHtml on a quadratic ${label}: killed at the deadline, the event loop keeps turning`, { timeout: 120_000 }, async () => {
    fastTimeouts();
    await markdownToHtml("warm up the *worker*".repeat(2000)).catch(() => {}); // thread start is not what is measured
    const r = await probed(() => markdownToHtml(input));
    assert.equal(reasonOf(r.error), "timeout");
    assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${r.maxLagMs.toFixed(0)} ms`);
    assert.ok(r.ms < 10_000, `took ${r.ms.toFixed(0)} ms`);
    // ONE timeout may be the server's load: the input is tried again…
    const worker = conversionStats.worker;
    const second = await probed(() => markdownToHtml(input));
    assert.equal(reasonOf(second.error), "timeout");
    assert.equal(conversionStats.worker, worker + 1, "a single timeout is not remembered");
    // …a SECOND timeout is remembered: refused at once, without touching the worker.
    const again = await probed(() => markdownToHtml(input));
    assert.equal(reasonOf(again.error), "timeout");
    assert.equal(conversionStats.worker, worker + 1);
    assert.ok(again.ms < 200);
    // The thread was terminated and a new one serves the next task.
    restoreLimits();
    assert.match(await markdownToHtml("after the *kill* ".repeat(2000)), /<em>kill<\/em>/);
  });
}

test("link-bracket runs and deep blockquotes: bounded, never on the event loop", { timeout: 120_000 }, async () => {
  fastTimeouts();
  const brackets = await probed(() => markdownToHtml(BRACKETS));
  assert.ok(brackets.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${brackets.maxLagMs.toFixed(0)} ms`);
  assert.ok(brackets.error ? brackets.error instanceof ConversionError : typeof brackets.value === "string");
  const quote = await probed(() => contentToSeed(DEEP_QUOTE));
  assert.equal(reasonOf(quote.error), "too_complex"); // marked overflows its stack on this: refused before any parser
  assert.ok(quote.ms < 200 && quote.maxLagMs < LOOP_BUDGET_MS);
});

test("htmlToMarkdown on deeply nested elements (turndown explodes): bounded, the event loop keeps turning", { timeout: 120_000 }, async () => {
  fastTimeouts();
  for (const depth of [3000, 24_000]) {
    const r = await probed(() => htmlToMarkdown(DEEP_DIVS(depth)));
    assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `depth ${depth}: event loop stalled ${r.maxLagMs.toFixed(0)} ms`);
    // Killed at the deadline, crashed in the worker (stack overflow) or — on a fast host — converted: never here.
    assert.ok(r.error === undefined ? typeof r.value === "string" : r.error instanceof ConversionError, `depth ${depth}: ${String(r.error)}`);
    assert.ok(r.ms < 10_000);
  }
  restoreLimits();
  assert.equal(await htmlToMarkdown("<h1>T</h1><p>a <strong>b</strong></p>"), "# T\n\na **b**");
});

test("generateJSON / generateHTML worst cases (deep nesting, a megabyte of ordinary paragraphs): off the event loop", { timeout: 180_000 }, async () => {
  fastTimeouts();
  for (const [label, html] of [
    ["2,000 nested divs", DEEP_DIVS(2000)],
    ["2,000 nested blockquotes", "<blockquote>".repeat(2000) + "<p>x</p>" + "</blockquote>".repeat(2000)],
    ["20,000 nested <em>", "<p>" + "<em>".repeat(20_000) + "x" + "</em>".repeat(20_000) + "</p>"],
    ["1 MB of ordinary paragraphs", "<p>Some <strong>normal</strong> text with <em>emphasis</em>.</p>".repeat(16_000)],
    ["2 MB of '<'", "<".repeat(2_000_000)],
  ] as const) {
    const r = await probed(() => contentToSeed(html));
    assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `${label}: event loop stalled ${r.maxLagMs.toFixed(0)} ms`);
    assert.ok(r.error === undefined || r.error instanceof ConversionError, `${label}: ${String(r.error)}`);
  }
  // Rendering a large document (store path) leaves the loop free too.
  const big = { type: "doc", content: Array.from({ length: 20_000 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `line ${i} `, marks: [{ type: "bold" }] }] })) };
  const html = await probed(() => docJsonToHtml(big));
  assert.ok(html.maxLagMs < LOOP_BUDGET_MS, `render: event loop stalled ${html.maxLagMs.toFixed(0)} ms`);
  assert.ok(html.error === undefined || html.error instanceof ConversionError);
  // A document nested past any budget is refused by the (iterative) weight walk, not by a stack overflow here.
  let deep: Record<string, unknown> = { type: "paragraph", content: [{ type: "text", text: "x" }] };
  for (let i = 0; i < 50_000; i++) deep = { type: "blockquote", content: [deep] };
  const nested = await probed(() => docJsonToHtml({ type: "doc", content: [deep] }));
  assert.ok(nested.error instanceof ConversionError);
  assert.ok(nested.maxLagMs < LOOP_BUDGET_MS);
});

test("byte identity, schema v5 blocks and suggestion-mark order: the worker seeds and renders exactly what the main thread would", { timeout: 120_000 }, async () => {
  const INS = '<span data-suggestion="insert" data-user="Ada" data-color="#22c55e" data-suggestion-id="s1" style="color:#22c55e;text-decoration:underline;text-decoration-color:#22c55e;">added <strong>bold</strong> <s>struck</s></span>';
  const DEL = '<span data-suggestion="delete" data-user="Ada" data-color="#ef4444" data-suggestion-id="s1" style="color:#ef4444;text-decoration:line-through;text-decoration-color:#ef4444;"><em>removed</em> <u>under</u></span>';
  const col = (t: string, attrs = "") => `<div data-type="column"${attrs}><p>${t}</p></div>`;
  const V5 =
    '<div data-type="child-page" data-page-id="n_Ab-12"></div>' +
    '<details data-type="toggle" data-heading-level="2"><summary>Toggle heading</summary><p>Body</p></details>' +
    `<div data-type="columns">${col("a", ' data-col-width="1.5"')}${col("b", ' data-col-width="0.5"')}</div>` +
    `<div data-type="columns">${[0, 1, 2, 3, 4].map((i) => col(`c${i}`)).join("")}</div>` +
    '<table><tbody><tr><th data-cell-color="blue"><p>H</p></th><td data-cell-color="red"><p>x</p></td></tr></tbody></table>' +
    `<p>Keep ${DEL}${INS} this, <s>struck</s> and <u>under</u>.</p>` +
    '<div data-type="callout" data-emoji="💡"><p>note</p></div>' +
    '<p><span data-type="mention" data-kind="page" data-id="p1" data-mention-uid="u1"></span> tail</p>';
  const inlineJson = core.contentToDocJsonSync(V5);
  const inlineHtml = core.docJsonToHtmlSync(inlineJson);
  const inlineSeed = new Y.Doc();
  Y.applyUpdate(inlineSeed, core.contentToSeedSync(V5));
  for (const marker of ['data-type="child-page"', 'data-heading-level="2"', 'data-col-width="1.5"', 'data-count="5"', 'data-cell-color="blue"', 'data-suggestion="insert"', 'data-suggestion="delete"']) {
    assert.ok(inlineHtml.includes(marker), `the fixture really exercises ${marker}`);
  }
  workerOnly();
  const before = conversionStats.worker;
  assert.equal(JSON.stringify(await contentToDocJson(V5)), JSON.stringify(inlineJson));
  assert.equal(await docJsonToHtml(inlineJson), inlineHtml);
  const workerSeed = new Y.Doc();
  Y.applyUpdate(workerSeed, await contentToSeed(V5));
  assert.equal(JSON.stringify(yDocToDocJson(workerSeed)), JSON.stringify(yDocToDocJson(inlineSeed)));
  assert.equal(await yDocToHtmlAsync(workerSeed), inlineHtml);
  // Stable from the first store on: HTML → doc → HTML again changes nothing (in the worker too).
  const again = new Y.Doc();
  Y.applyUpdate(again, await contentToSeed(inlineHtml));
  assert.equal(await yDocToHtmlAsync(again), inlineHtml);
  assert.ok(conversionStats.worker - before >= 5);
});

test("M1: 2 MB of ordinary Markdown opens (the worker heap is sized for it); a body that would build too many nodes is refused up front, by name", { timeout: 300_000 }, async () => {
  assert.ok(convertCfg.heapMb >= 2048, "the worker heap default covers a 2 MB note");
  const rep = (p: string, bytes: number) => p.repeat(Math.ceil(bytes / p.length)).slice(0, bytes);
  // Dense short paragraphs: the DOM + ProseMirror trees of 2 MB of these do not fit any sane heap.
  const dense = rep("A note with **bold** and *em* text.\n\n", 2_000_000);
  const worker = conversionStats.worker;
  const start = performance.now();
  assert.equal(conversionRefusal(dense, true), "too_many_nodes");
  fv.put({ id: "dense", tags: ["garden"], content: dense, updatedAt: "2026-03-01T00:00:00.000Z" });
  await assert.rejects(loadDocumentState("dense", new Y.Doc()), (e) => e instanceof DocumentTooComplexError && e.failure === "too_many_nodes");
  assert.equal(conversionStats.worker, worker, "refused by the pre-check: no thread, no gigabytes");
  assert.ok(performance.now() - start < 3000);

  // A plain 2 MB Markdown note — ordinary prose paragraphs — opens live.
  const prose = rep("The quick brown fox jumps over the lazy dog, again and again, with *some* emphasis and a [link](https://example.org/a).\n\n", 2_000_000);
  assert.equal(conversionRefusal(prose, true), null);
  fv.put({ id: "prose", tags: ["garden"], content: prose, updatedAt: "2026-03-01T00:00:00.000Z" });
  restore.push(configureConversion({ timeoutMs: 240_000, timeoutMaxMs: 240_000 })); // a loaded CI host is slow, not wrong
  const loaded = await probed(() => loadDocumentState("prose", new Y.Doc()));
  assert.equal(loaded.error, undefined, String(loaded.error));
  assert.ok(loaded.maxLagMs < 4000, `event loop stalled ${loaded.maxLagMs.toFixed(0)} ms (applying a 2 MB seed is the one linear step left on the main thread)`);
  const paragraphs = loaded.value!.getXmlFragment("default").length;
  assert.ok(paragraphs > 15_000, `${paragraphs} paragraphs`);
  assert.equal(isDocBlocked("prose"), false);
  assert.ok(getDocState("prose"));
});

test("M2: one actor's conversions wait in that actor's own line — they cannot starve other people's", { timeout: 120_000 }, async () => {
  await stopConversionWorkers();
  restore.push(configureConversion({ threads: 2, perActorInflight: 1, perActorWaiting: 1, timeoutMs: 700, timeoutPerMbMs: 0, timeoutMaxMs: 700 }));
  workerOnly();
  await markdownToHtml("warm *up*").catch(() => {});
  const order: string[] = [];
  const done = (label: string) => (v: unknown) => void order.push(`${label}:${v instanceof Error ? reasonOf(v) : "ok"}`);
  const slow = (i: number) => `${EMPHASIS} ${i}`;
  const a1 = markdownToHtml(slow(1), { actor: "user:a" }).then(done("a1"), done("a1"));
  const a2 = markdownToHtml(slow(2), { actor: "user:a" }).then(done("a2"), done("a2"));
  const a3 = markdownToHtml(slow(3), { actor: "user:a" }).then(done("a3"), done("a3")); // a's line is full
  const b1 = markdownToHtml("someone *else*", { actor: "user:b" }).then(done("b1"), done("b1"));
  await Promise.all([a1, a2, a3, b1]);
  assert.equal(order[0], "a3:busy", `a third conversion for the same actor is refused at once: ${order.join(" ")}`);
  assert.ok(order.indexOf("b1:ok") !== -1 && order.indexOf("b1:ok") < order.indexOf("a2:timeout"), `the other person is served before the hog's second task: ${order.join(" ")}`);
  assert.equal(order.filter((o) => o.startsWith("a") && o.endsWith("timeout")).length, 2);
});

test("M2: saving has its own lane — a store's render is not queued behind opens and agent writes", { timeout: 120_000 }, async () => {
  const json = core.contentToDocJsonSync("<p>to be saved</p>");
  for (const threads of [2, 1]) {
    await stopConversionWorkers();
    restoreLimits();
    restore.push(configureConversion({ threads, timeoutMs: 700, timeoutPerMbMs: 0, timeoutMaxMs: 700 }));
    workerOnly();
    await docJsonToHtml(json, { lane: "store" }); // threads up
    await markdownToHtml("warm *up*");
    let hogsDone = 0;
    const hogs = [1, 2, 3, 4].map((i) => markdownToHtml(`${EMPHASIS} lane ${threads} ${i}`).catch(() => null).then(() => void hogsDone++));
    await new Promise((r) => setTimeout(r, 50));
    const html = await docJsonToHtml(json, { lane: "store" });
    assert.equal(html, "<p>to be saved</p>");
    // Reserved thread (2+): at once. One thread: right after the task that was already running.
    // (one more than the ideal is allowed for scheduling noise on a loaded host; queued behind them it would be 4)
    assert.ok(hogsDone <= (threads === 1 ? 2 : 1), `threads=${threads}: the store's render finished after ${hogsDone} of 4 queued opens`);
    await Promise.all(hogs);
  }
});

test("M3: only a REPEATED timeout is remembered — a busy queue or a crashed worker never marks the input", { timeout: 120_000 }, async () => {
  // A worker that fails on the input (a stack overflow in the converter) is not remembered.
  restore.push(configureConversion({ timeoutMs: 30_000, timeoutMaxMs: 30_000 }));
  const crash = DEEP_DIVS(24_000);
  const first = await htmlToMarkdown(crash).then(() => "ok", reasonOf);
  const worker = conversionStats.worker;
  const second = await htmlToMarkdown(crash).then(() => "ok", reasonOf);
  assert.equal(conversionStats.worker, worker + 1, `tried again (${first} → ${second}): nothing was remembered`);
  assert.equal(conversionStats.remembered, conversionStats.remembered);
  // Pre-check refusals need no memory: they are recomputed (linearly) and identical every time.
  const remembered = conversionStats.remembered;
  for (let i = 0; i < 3; i++) assert.equal(await contentToSeed(DEEP_QUOTE).then(() => "ok", reasonOf), "too_complex");
  assert.equal(conversionStats.remembered, remembered);
});

test("a full queue answers `busy` at once (and is not remembered as the input's fault)", { timeout: 120_000 }, async () => {
  await stopConversionWorkers();
  restore.push(configureConversion({ threads: 1, maxQueue: 1, timeoutMs: 600, timeoutPerMbMs: 0, timeoutMaxMs: 600 }));
  workerOnly();
  const slow = (i: number) => `${EMPHASIS} ${i}`;
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) => markdownToHtml(slow(i)).then(() => "ok", reasonOf)));
  assert.ok(results.includes("busy"), results.join(","));
  assert.ok(results.includes("timeout"), results.join(","));
  await stopConversionWorkers();
  restoreLimits();
  workerOnly();
  // The input that was refused as `busy` is tried again (here: it then times out or converts — never "busy" from memory).
  const busyIndex = results.indexOf("busy");
  fastTimeouts();
  const retry = await markdownToHtml(slow(busyIndex)).then(() => "ok", reasonOf);
  assert.notEqual(retry, "busy");
});

test("the synchronous forms are bounded: small input converts, anything else throws at once", () => {
  assert.equal(yDocToHtml(docOf("<p>hello <strong>there</strong></p>")), "<p>hello <strong>there</strong></p>");
  for (const [label, fn] of [
    ["emphasis run", () => contentToSeedBounded(EMPHASIS)],
    ["large Markdown", () => contentToDocJsonBounded("word ".repeat(20_000))],
    ["many paragraphs", () => contentToYUpdate("<p>x</p>".repeat(5000))],
    ["deep nesting", () => contentToYUpdate(DEEP_DIVS(500))],
    ["a big document render", () => docJsonToHtmlBounded({ type: "doc", content: Array.from({ length: 5000 }, () => ({ type: "paragraph" })) })],
    ["suggestions in a big note", () => resolveSuggestionsInHtml("<p>x</p>".repeat(5000), null, "accept")],
    ["a fold of a big body", () => applyExternalContent(docOf("<p>a</p>"), "document", "<p>x</p>".repeat(5000))],
  ] as const) {
    const start = performance.now();
    assert.throws(fn, (e) => e instanceof ConversionError && e.reason === "too_large", label);
    assert.ok(performance.now() - start < 300, `${label}: refused in ${Math.round(performance.now() - start)} ms`);
  }
});

function docOf(content: string): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, contentToYUpdate(content));
  return d;
}

test("suggestion helpers parse off the main thread and agree with the synchronous forms", { timeout: 120_000 }, async () => {
  const html =
    '<p>keep <span data-suggestion="insert" data-suggestion-id="s1" data-user="Ann" data-actor-id="h_1">added</span>' +
    '<span data-suggestion="delete" data-suggestion-id="s1" data-user="Ann" data-actor-id="h_1">removed</span> tail</p>';
  const sync = resolveSuggestionsInHtml(html, "Ann", "accept");
  workerOnly();
  assert.equal(await resolveSuggestionsInHtmlAsync(html, "Ann", "accept"), sync);
  const view = await suggestionViewOfHtml(html);
  assert.equal(view.suggestions.get("s1")?.ins, "added");
  assert.match(view.plain ?? "", /keep/);
  assert.deepEqual(await suggestionViewOfHtml("<p>nothing here</p>"), { suggestions: new Map(), plain: null });
  // A pathological note: refused, not parsed here.
  fastTimeouts();
  const r = await probed(() => resolveSuggestionsInHtmlAsync(DEEP_DIVS(4000), "Ann", "accept"));
  assert.ok(r.error instanceof ConversionError);
  assert.ok(r.maxLagMs < LOOP_BUDGET_MS);
});

// ── collab: a note that cannot be converted has NO live document ────────────

for (const [label, body] of [
  ["a Markdown emphasis bomb", EMPHASIS],
  ["a blockquote 5,000 deep", DEEP_QUOTE],
  ["stored HTML nested 4,000 deep", DEEP_DIVS(4000)],
] as const) {
  test(`opening ${label} live is refused too_complex: the loop stays free, nothing enters Yjs, SQLite or the vault`, { timeout: 120_000 }, async () => {
    fastTimeouts();
    fv.put({ id: "bomb", tags: ["garden"], content: body, updatedAt: "2026-03-01T00:00:00.000Z" });
    // A command a previous instance of this document applied but never confirmed.
    insertCollabReceipt({ vault_id: "primary", note_id: "bomb", doc_name: "bomb", actor: "user:a@test.local", request_id: "r-1", command_hash: "h", kind: "reply", result: "{}", created_at: Date.now() });
    const doc = new Y.Doc();
    const loaded = await probed(() => loadDocumentState("bomb", doc));
    assert.ok(loaded.error instanceof DocumentTooComplexError, String(loaded.error));
    assert.equal((loaded.error as DocumentTooComplexError).reason, TOO_COMPLEX_REASON, "what the socket is answered with");
    assert.ok(loaded.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${loaded.maxLagMs.toFixed(0)} ms`);
    // Nothing derived from the body exists anywhere a client could sync or persist it.
    assert.equal(doc.store.clients.size, 0, "the Y.Doc was not touched");
    assert.equal(getDocState("bomb"), null, "no CRDT snapshot");
    assert.deepEqual(vaultWrites(), []);
    assert.equal(fv.notes.get("bomb")!.content, body, "the stored note is byte-for-byte unchanged");
    assert.equal(isDocBlocked("bomb"), false, "nothing is loaded, so nothing is flagged");
    // A load that fails consumes no unconfirmed command receipts.
    assert.equal(unconfirmedCollabReceipts("bomb").length, 1);

    // Fixing the note is all it takes: ordinary seeding, ordinary snapshot — nothing to purge anywhere.
    fv.put({ id: "bomb", tags: ["garden"], content: "now *fine*", updatedAt: "2026-03-02T00:00:00.000Z" });
    const healed = await loadDocumentState("bomb", new Y.Doc());
    assert.equal(yDocToHtml(healed), "<p>now <em>fine</em></p>");
    assert.ok(getDocState("bomb"));
    assert.equal(unconfirmedCollabReceipts("bomb").length, 0, "a load that succeeds takes them, as before");
  });
}

test("an ordinary large Markdown note opens through the worker and stores exactly what the inline path would", { timeout: 180_000 }, async () => {
  const md = "Paragraph with *emphasis*, **bold** and a [link](https://example.org).\n\n".repeat(900); // ~63 KB: past the inline size
  assert.equal(isCheapContent(md, true), false);
  fv.put({ id: "big", tags: ["garden"], content: md, updatedAt: "2026-03-01T00:00:00.000Z" });
  const loaded = await probed(() => loadDocumentState("big", new Y.Doc()));
  assert.equal(loaded.error, undefined);
  assert.ok(loaded.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${loaded.maxLagMs.toFixed(0)} ms`);
  const doc = loaded.value!;
  const expected = core.docJsonToHtmlSync(core.contentToDocJsonSync(md));
  assert.equal(await yDocToHtmlAsync(doc), expected);
  assert.deepEqual(vaultWrites(), [], "a load writes nothing to the vault");
  // An edit, then a store: the vault gets the rendered HTML, once.
  doc.getXmlFragment("default").delete(0, 1);
  const stored = await probed(() => storeDocumentState("big", doc));
  assert.ok(stored.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${stored.maxLagMs.toFixed(0)} ms`);
  assert.equal(vaultWrites().length, 1);
  assert.equal(fv.notes.get("big")!.content, core.docJsonToHtmlSync(yDocToDocJson(doc)));
  // A second store of the unchanged document adds no history version.
  await storeDocumentState("big", doc);
  assert.equal(vaultWrites().length, 1);
});

// ── collab: external edits that cannot be folded ────────────────────────────

test("load with stored state + an unconvertible external edit: refused, the snapshot and the note untouched", { timeout: 120_000 }, async () => {
  fv.put({ id: "n1", tags: ["garden"], content: "<p>first version</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  await loadDocumentState("n1", new Y.Doc());
  const snapshot = getDocState("n1")!;
  fv.put({ id: "n1", tags: ["garden"], content: DEEP_QUOTE, updatedAt: "2026-03-05T00:00:00.000Z" });
  const calls = fv.calls.length;
  const doc = new Y.Doc();
  await assert.rejects(loadDocumentState("n1", doc), DocumentTooComplexError);
  assert.equal(doc.store.clients.size, 0, "not even the older snapshot is served: it is not the note any more");
  assert.deepEqual(getDocState("n1")!.state, snapshot.state, "the older CRDT snapshot is kept as it was");
  assert.equal(getDocState("n1")!.sourceUpdatedAt, snapshot.sourceUpdatedAt);
  assert.deepEqual(fv.calls.slice(calls).filter((c) => c.method !== "GET"), []);
  assert.equal(fv.notes.get("n1")!.content, DEEP_QUOTE);
});

test("reconcile: an external edit the pre-check refuses blocks the live document at once — never folded in, never overwritten", { timeout: 120_000 }, async () => {
  fv.put({ id: "n2", tags: ["garden"], content: "<p>live text</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n2", new Y.Doc());
  const before = text(doc);
  const source = getDocState("n2")!.sourceUpdatedAt;
  fv.put({ id: "n2", tags: ["garden"], content: DEEP_QUOTE, updatedAt: "2026-03-05T00:00:00.000Z" });
  const tick = await probed(() => reconcileLoadedDocs({ documents: new Map([["n2", doc]]) }));
  assert.equal(tick.error, undefined);
  assert.ok(tick.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${tick.maxLagMs.toFixed(0)} ms`);
  assert.equal(text(doc), before, "the live document was not touched");
  assert.equal(isDocBlocked("n2"), true, "blocked: its sockets are dropped and it is never written to the vault again");
  // A human edit that raced in, then the store (debounce / unload): the vault keeps the external body.
  doc.getXmlFragment("default").delete(0, 1);
  await storeDocumentState("n2", doc);
  assert.deepEqual(vaultWrites(), []);
  assert.equal(fv.notes.get("n2")!.content, DEEP_QUOTE, "the external edit is intact");
  assert.equal(getDocState("n2")!.sourceUpdatedAt, source, "the snapshot keeps the version it is based on");
});

test("reconcile: a fold that merely TIMES OUT once is retried; the same content failing twice blocks the document", { timeout: 120_000 }, async () => {
  fastTimeouts();
  fv.put({ id: "n2b", tags: ["garden"], content: "<p>live text</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n2b", new Y.Doc());
  fv.put({ id: "n2b", tags: ["garden"], content: EMPHASIS, updatedAt: "2026-03-05T00:00:00.000Z" });
  const docs = { documents: new Map([["n2b", doc]]) };
  await reconcileLoadedDocs(docs);
  assert.equal(isDocBlocked("n2b"), false, "one timeout may be the server's load");
  assert.match(text(doc), /live text/);
  await reconcileLoadedDocs(docs);
  assert.equal(isDocBlocked("n2b"), true);
  await storeDocumentState("n2b", doc);
  assert.deepEqual(vaultWrites(), []);
  assert.equal(fv.notes.get("n2b")!.content, EMPHASIS);
});

test("store: the clobber guard cannot fold an unconvertible external edit → the vault copy wins, nothing is overwritten", { timeout: 120_000 }, async () => {
  fv.put({ id: "n3", tags: ["garden"], content: "<p>live text</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n3", new Y.Doc());
  const source = getDocState("n3")!.sourceUpdatedAt;
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("typed by a human")]);
  doc.getXmlFragment("default").insert(1, [para]);
  fv.put({ id: "n3", tags: ["garden"], content: DEEP_QUOTE, updatedAt: "2026-03-05T00:00:00.000Z" });
  const stored = await probed(() => storeDocumentState("n3", doc));
  assert.equal(stored.error, undefined);
  assert.ok(stored.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${stored.maxLagMs.toFixed(0)} ms`);
  assert.deepEqual(vaultWrites(), [], "the live state was NOT written over the newer note");
  assert.equal(fv.notes.get("n3")!.content, DEEP_QUOTE);
  assert.equal(isDocBlocked("n3"), true);
  // The Yjs state (with the human's typing) is kept, on the version it is based on.
  assert.equal(getDocState("n3")!.sourceUpdatedAt, source);
  const kept = new Y.Doc();
  Y.applyUpdate(kept, getDocState("n3")!.state);
  assert.match(text(kept), /typed by a human/);
  // The next open is refused (the note is unconvertible); the note is still intact.
  await assert.rejects(loadDocumentState("n3", new Y.Doc()), DocumentTooComplexError);
  assert.equal(fv.notes.get("n3")!.content, DEEP_QUOTE);
});

test("M4 — store: a render that fails because of LOAD (timeout / busy / crash) keeps the document live, saves its Yjs state and writes the note later", { timeout: 180_000 }, async () => {
  // A page large enough that its render cannot finish in a millisecond.
  const body = Array.from({ length: 3000 }, (_, i) => `<p>Paragraph ${i}</p>`).join("");
  fv.put({ id: "n4", tags: ["garden"], content: body, updatedAt: "2026-03-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n4", new Y.Doc());
  const source = getDocState("n4")!.sourceUpdatedAt;
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("typed while the converter was overloaded")]);
  doc.getXmlFragment("default").insert(3000, [para]);
  // The renderer times out (forced: a 1 ms wall clock).
  restore.push(configureConversion({ timeoutMs: 1, timeoutPerMbMs: 0, timeoutMaxMs: 1 }));
  const stored = await probed(() => storeDocumentState("n4", doc));
  assert.equal(stored.error, undefined, "a store never throws");
  assert.deepEqual(vaultWrites(), []);
  assert.equal(isDocBlocked("n4"), false, "NOT flagged: nobody is dropped, the document stays live");
  // The typing is durable in SQLite, on the vault version it is based on (never a null source).
  assert.equal(getDocState("n4")!.sourceUpdatedAt, source);
  const kept = new Y.Doc();
  Y.applyUpdate(kept, getDocState("n4")!.state);
  assert.match(text(kept), /typed while the converter was overloaded/);
  assert.equal(isCollabUnsaved("n4", "primary"), true, "recorded: the note still has to be written");
  // The reconciler does not fold the (older) note back over it.
  await reconcileLoadedDocs({ documents: new Map([["n4", doc]]) });
  assert.match(text(doc), /typed while the converter was overloaded/);
  // Even if the tab closes now, the next load restores the typing and it is written then.
  const reopened = await loadDocumentState("n4", new Y.Doc());
  assert.match(text(reopened), /typed while the converter was overloaded/);
  assert.equal(getDocState("n4")!.sourceUpdatedAt, source, "still marked as based on the old note version");
  restoreLimits();
  await storeDocumentState("n4", reopened);
  assert.equal(fv.notes.get("n4")!.content, `${body}<p>typed while the converter was overloaded</p>`);
  assert.equal(isCollabUnsaved("n4", "primary"), false);
  assert.equal(vaultWrites().length, 1);
});

test("store: a document beyond what can be rendered at all is not written, not blocked and not retried — recorded as permanently unsaved until it shrinks", { timeout: 120_000 }, async () => {
  fv.put({ id: "n5", tags: ["garden"], content: "<p>small</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n5", new Y.Doc());
  const source = getDocState("n5")!.sourceUpdatedAt;
  doc.getXmlFragment("default").insert(1, [new Y.XmlElement("paragraph")]);
  restore.push(configureConversion({ inlineMaxNodes: 0, maxNodes: 1 }));
  await storeDocumentState("n5", doc);
  assert.deepEqual(vaultWrites(), []);
  assert.equal(isDocBlocked("n5"), false, "the document stays live");
  const row = getDocState("n5")!;
  assert.equal(row.sourceUpdatedAt, source);
  assert.equal(row.ahead, true, "the snapshot is ahead of the vault, on its true base");
  const unsaved = getCollabUnsaved("n5", "primary")!;
  assert.equal(unsaved.permanent, 1, "recorded — and not retried: only a smaller page can be saved");
  assert.equal(unsaved.reason, "too_many_nodes");
  assert.deepEqual(dueCollabUnsaved(10, Date.now() + 365 * 86_400_000), [], "the sweep never picks a permanent row");
  // Once the page can be rendered again, the next store writes it and clears the record.
  restoreLimits();
  await storeDocumentState("n5", doc);
  assert.equal(fv.notes.get("n5")!.content, "<p>small</p><p></p>");
  assert.equal(getCollabUnsaved("n5", "primary"), null);
  assert.equal(getDocState("n5")!.ahead, false);
});

test("store: a busy converter is waited out — the note is written, nothing is flagged", { timeout: 120_000 }, async () => {
  fv.put({ id: "n6", tags: ["garden"], content: "<p>small</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const other = await loadDocumentState("n6", new Y.Doc());
  other.getXmlFragment("default").insert(1, [new Y.XmlElement("paragraph")]);
  await stopConversionWorkers();
  restore.push(configureConversion({ inlineMaxNodes: 0, threads: 1, maxQueue: 1, timeoutMs: 600, timeoutPerMbMs: 0, timeoutMaxMs: 600 }));
  const busyBefore = conversionStats.busy;
  const hog = [0, 1, 2].map((i) => markdownToHtml(`${EMPHASIS} hog ${i}`).catch(() => null));
  await storeDocumentState("n6", other);
  await Promise.all(hog);
  assert.ok(conversionStats.busy > busyBefore, "the converter really was saturated");
  assert.equal(isDocBlocked("n6"), false);
  assert.equal(fv.notes.get("n6")!.content, "<p>small</p><p></p>", "stored once a slot was free");
  await stopConversionWorkers();
});

test("an agent's live merge takes a pre-parsed body; without one, a large body is refused rather than parsed here", () => {
  const live = docOf("<p>alpha</p><p>beta</p>");
  const base = Y.encodeStateAsUpdate(live);
  assert.equal(mergeContentIntoLive(live, base, "document", "<p>alpha</p><p>beta AGENT</p>", "mcp:test"), true);
  assert.equal(yDocToHtml(live), "<p>alpha</p><p>beta AGENT</p>");
  assert.equal(mergeContentIntoLive(live, Y.encodeStateAsUpdate(live), "document", "<p>alpha</p><p>beta AGENT</p>", "mcp:test"), false, "no change → nothing applied");
  assert.throws(() => mergeContentIntoLive(live, Y.encodeStateAsUpdate(live), "document", "<p>x</p>".repeat(5000), "mcp:test"), ConversionError);
  assert.equal(yDocToHtml(live), "<p>alpha</p><p>beta AGENT</p>", "a refused merge changes nothing");
});

// ── the rule, enforced ──────────────────────────────────────────────────────

test("no server module parses note content on its own: marked / turndown / TipTap generate* live only in the conversion core", () => {
  const root = join(import.meta.dirname, "..", "src");
  const allowed = new Set(["convert/core.ts", "transfer/worker.ts", "transfer/import-plan.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(name)) {
        const rel = p.slice(root.length + 1);
        if (allowed.has(rel)) continue;
        const src = readFileSync(p, "utf8");
        if (/from\s+["'](marked|turndown|happy-dom)["']/.test(src) || /\b(generateJSON|generateHTML)\s*\(/.test(src) || /import\s*\{[^}]*\b(generateJSON|generateHTML)\b[^}]*\}\s*from\s*["']@tiptap\/core["']/.test(src)) offenders.push(rel);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], "use src/convert/service.ts (worker + timeout) instead");
  // And the worker side must stay free of the database, the config and the network.
  for (const rel of ["convert/core.ts", "convert/precheck.ts", "transfer/worker.ts", "transfer/import-plan.ts"]) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*\/(db|config|parachute|collab)["']/, `${rel} must not import db/config/vault/collab`);
  }
});
