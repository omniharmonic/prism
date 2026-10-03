/**
 * Content conversion never runs unbounded on the server's event loop.
 *
 *  - convert/service.ts: linear pre-check, inline only for small plain inputs,
 *    everything else in the worker under a hard wall-clock limit (terminate +
 *    respawn), bounded queue, failure memory, typed ConversionError.
 *  - collab.ts fallbacks: a note body that cannot be converted in budget opens as
 *    a read-only plain-text view (lossless text) that is NEVER persisted — the
 *    stored note is byte-for-byte unchanged on every path (first open, fold of an
 *    external edit at load / reconcile / store).
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
  DEGRADED_NOTICE,
  applyExternalContent,
  carriesDegradedSeed,
  carriesForeignDegradedSeed,
  contentToYUpdate,
  degradedDocJson,
  degradedSeed,
  isDegradedClientId,
  isDocDegraded,
  loadDocumentState,
  reconcileLoadedDocs,
  resetDegradedState,
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
import { getDocState } from "../src/db";
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
  resetDegradedState();
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
const degradedText = (body: string) => norm(degradedDocJson(body));

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
  assert.ok(ms < 4000, `the pre-checks took ${ms.toFixed(0)} ms for ${shapes.length * 4} passes over 2 MB`);
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
    // Remembered: the same input is refused at once, without touching the worker.
    const worker = conversionStats.worker;
    const again = await probed(() => markdownToHtml(input));
    assert.equal(reasonOf(again.error), "timeout");
    assert.equal(conversionStats.worker, worker);
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

// ── the degraded (plain-text) document ──────────────────────────────────────

test("degradedDocJson: the note's text, line for line — never parsed, nothing lost", () => {
  const src = "# not a heading\n*a *a *a\n\n<div>literal & text</div>\r\nlast";
  const json = degradedDocJson(src) as { content: Array<{ type: string; content?: Array<{ text: string; marks?: unknown[] }> }> };
  assert.equal(json.content[0]!.content![0]!.text, DEGRADED_NOTICE);
  const lines = json.content.slice(1).map((p) => p.content?.[0]?.text ?? "");
  assert.deepEqual(lines, ["# not a heading", "*a *a *a", "", "<div>literal & text</div>", "last"]);
  assert.ok(json.content.slice(1).every((p) => p.type === "paragraph" && !p.content?.[0]?.marks), "plain paragraphs, no marks");
  // Thousands of lines → ONE code block holding the text verbatim (a few Yjs items, not millions).
  const many = Array.from({ length: 5000 }, (_, i) => `line ${i} *x`).join("\n");
  const block = degradedDocJson(many) as { content: Array<{ type: string; content?: Array<{ text: string }> }> };
  assert.equal(block.content.length, 2);
  assert.equal(block.content[1]!.type, "codeBlock");
  assert.equal(block.content[1]!.content![0]!.text, many);
  // Stored HTML that cannot be parsed is shown as its text.
  const html = degradedDocJson("<p>one</p><p>two &amp; three</p>") as { content: Array<{ content?: Array<{ text: string }> }> };
  assert.deepEqual(html.content.slice(1).map((p) => p.content?.[0]?.text ?? "").filter(Boolean), ["one", "two & three"]);
  // Linear and small, whatever it is handed.
  const start = performance.now();
  for (const s of ["\n".repeat(2_000_000), "*a ".repeat(700_000), DEEP_DIVS(200_000), "<".repeat(2_000_000)]) {
    const update = degradedSeed(s);
    assert.ok(update.byteLength < 6_000_000);
  }
  assert.ok(performance.now() - start < 6000, `seeds took ${Math.round(performance.now() - start)} ms`);
});

test("the degraded seed is fingerprinted: a reserved client id no real client can draw, recognisable in any sync payload", () => {
  const seed = degradedSeed(EMPHASIS);
  assert.deepEqual(seed, degradedSeed(EMPHASIS), "deterministic");
  const degraded = new Y.Doc();
  Y.applyUpdate(degraded, seed);
  assert.equal(carriesDegradedSeed(degraded), true);
  assert.ok([...degraded.store.clients.keys()].every((id) => isDegradedClientId(id) && id >= 2 ** 33));
  assert.equal(isDegradedClientId(new Y.Doc().clientID), false);
  assert.equal(isDegradedClientId(2 ** 32 - 1), false);

  const healthy = docOf("<p>healthy</p>");
  assert.equal(carriesDegradedSeed(healthy), false);
  // What a stale tab would send: its state vector (step 1), its state (step 2), an update.
  assert.equal(carriesForeignDegradedSeed(healthy, 0, Y.encodeStateVector(degraded)), true);
  assert.equal(carriesForeignDegradedSeed(healthy, 1, Y.encodeStateAsUpdate(degraded)), true);
  assert.equal(carriesForeignDegradedSeed(healthy, 2, seed), true);
  // The same degraded document talking to itself is fine; so is ordinary traffic.
  assert.equal(carriesForeignDegradedSeed(degraded, 0, Y.encodeStateVector(degraded)), false);
  assert.equal(carriesForeignDegradedSeed(healthy, 0, Y.encodeStateVector(docOf("<p>other</p>"))), false);
  assert.equal(carriesForeignDegradedSeed(healthy, 2, Y.encodeStateAsUpdate(docOf("<p>other</p>"))), false);
  // A different degraded state (the note changed) is foreign to a degraded document too.
  const other = new Y.Doc();
  Y.applyUpdate(other, degradedSeed(UNDERSCORES));
  assert.equal(carriesForeignDegradedSeed(degraded, 0, Y.encodeStateVector(other)), true);
  assert.equal(carriesForeignDegradedSeed(healthy, 0, new Uint8Array([255, 255, 255])), false, "garbage is Yjs's to refuse");
});

// ── collab: first open ──────────────────────────────────────────────────────

for (const [label, body] of [
  ["a Markdown emphasis bomb", EMPHASIS],
  ["a blockquote 5,000 deep", DEEP_QUOTE],
  ["stored HTML nested 4,000 deep", DEEP_DIVS(4000)],
] as const) {
  test(`opening ${label} live: read-only plain text, the loop stays free, and NOTHING is ever written`, { timeout: 120_000 }, async () => {
    fastTimeouts();
    fv.put({ id: "bomb", tags: ["garden"], content: body, updatedAt: "2026-03-01T00:00:00.000Z" });
    const loaded = await probed(() => loadDocumentState("bomb", new Y.Doc()));
    assert.equal(loaded.error, undefined);
    assert.ok(loaded.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${loaded.maxLagMs.toFixed(0)} ms`);
    const doc = loaded.value!;
    assert.equal(isDocDegraded("bomb"), true);
    assert.equal(carriesDegradedSeed(doc), true);
    assert.equal(text(doc), degradedText(body), "the plain-text view of exactly this body");
    assert.equal(getDocState("bomb"), null, "no CRDT snapshot of the degraded form");
    assert.deepEqual(vaultWrites(), []);

    // A store of it — debounce, unload, flush, with or without "edits" — writes nothing anywhere.
    doc.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
    await storeDocumentState("bomb", doc);
    assert.deepEqual(vaultWrites(), []);
    assert.equal(getDocState("bomb"), null);
    assert.equal(fv.notes.get("bomb")!.content, body, "the stored note is byte-for-byte unchanged");

    // Even with every flag lost, the seed's fingerprint keeps it out of the vault and out of SQLite.
    resetDegradedState();
    await storeDocumentState("bomb", doc);
    assert.deepEqual(vaultWrites(), []);
    assert.equal(getDocState("bomb"), null);
    assert.equal(fv.notes.get("bomb")!.content, body);

    // Re-opening does not burn the worker again (failure memory) and is still degraded.
    const worker = conversionStats.worker;
    const again = await probed(() => loadDocumentState("bomb", new Y.Doc()));
    assert.equal(conversionStats.worker, worker);
    assert.ok(again.ms < 1000);
    assert.equal(isDocDegraded("bomb"), true);

    // Fixing the note heals the document at its next load: ordinary seeding, ordinary snapshot.
    fv.put({ id: "bomb", tags: ["garden"], content: "now *fine*", updatedAt: "2026-03-02T00:00:00.000Z" });
    const healed = await loadDocumentState("bomb", new Y.Doc());
    assert.equal(isDocDegraded("bomb"), false);
    assert.equal(carriesDegradedSeed(healed), false);
    assert.equal(yDocToHtml(healed), "<p>now <em>fine</em></p>");
    assert.ok(getDocState("bomb"));
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
  assert.equal(isDocDegraded("big"), false);
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

test("load with stored state + an unconvertible external edit: degraded, the snapshot and the note untouched", { timeout: 120_000 }, async () => {
  fastTimeouts();
  fv.put({ id: "n1", tags: ["garden"], content: "<p>first version</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  await loadDocumentState("n1", new Y.Doc());
  const snapshot = getDocState("n1")!;
  fv.put({ id: "n1", tags: ["garden"], content: EMPHASIS, updatedAt: "2026-03-05T00:00:00.000Z" });
  const calls = fv.calls.length;
  const doc = await loadDocumentState("n1", new Y.Doc());
  assert.equal(isDocDegraded("n1"), true);
  assert.equal(text(doc), degradedText(EMPHASIS), "shows the note's CURRENT text, not the stale snapshot");
  assert.deepEqual(getDocState("n1")!.state, snapshot.state, "the older CRDT snapshot is kept as it was");
  assert.equal(getDocState("n1")!.sourceUpdatedAt, snapshot.sourceUpdatedAt);
  await storeDocumentState("n1", doc);
  assert.deepEqual(fv.calls.slice(calls).filter((c) => c.method !== "GET"), []);
  assert.equal(fv.notes.get("n1")!.content, EMPHASIS);
});

test("reconcile: an external edit that cannot be converted is never folded in and never overwritten", { timeout: 120_000 }, async () => {
  fastTimeouts();
  fv.put({ id: "n2", tags: ["garden"], content: "<p>live text</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n2", new Y.Doc());
  const before = text(doc);
  fv.put({ id: "n2", tags: ["garden"], content: EMPHASIS, updatedAt: "2026-03-05T00:00:00.000Z" });
  const tick = await probed(() => reconcileLoadedDocs({ documents: new Map([["n2", doc]]) }));
  assert.equal(tick.error, undefined);
  assert.ok(tick.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${tick.maxLagMs.toFixed(0)} ms`);
  assert.equal(text(doc), before, "the live document was not touched");
  assert.equal(isDocDegraded("n2"), true, "flagged: read-only, and never stored again");
  // A human edit that raced in, then the store: the vault keeps the external body.
  doc.getXmlFragment("default").delete(0, 1);
  await storeDocumentState("n2", doc);
  assert.deepEqual(vaultWrites(), []);
  assert.equal(fv.notes.get("n2")!.content, EMPHASIS, "the external edit is intact");
  // Later ticks are cheap and change nothing.
  await reconcileLoadedDocs({ documents: new Map([["n2", doc]]) });
  assert.equal(text(doc).includes("live text"), false);
  assert.equal(fv.notes.get("n2")!.content, EMPHASIS);
});

test("store: the clobber guard cannot fold an unconvertible external edit → the vault copy wins, nothing is overwritten", { timeout: 120_000 }, async () => {
  fastTimeouts();
  fv.put({ id: "n3", tags: ["garden"], content: "<p>live text</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n3", new Y.Doc());
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("typed by a human")]);
  doc.getXmlFragment("default").insert(1, [para]);
  fv.put({ id: "n3", tags: ["garden"], content: UNDERSCORES, updatedAt: "2026-03-05T00:00:00.000Z" });
  const stored = await probed(() => storeDocumentState("n3", doc));
  assert.equal(stored.error, undefined);
  assert.ok(stored.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${stored.maxLagMs.toFixed(0)} ms`);
  assert.deepEqual(vaultWrites(), [], "the live state was NOT written over the newer note");
  assert.equal(fv.notes.get("n3")!.content, UNDERSCORES);
  assert.equal(isDocDegraded("n3"), true);
  // The snapshot is kept without a source version (as after a failed vault write) — the next load starts from the note.
  assert.equal(getDocState("n3")!.sourceUpdatedAt, null);
  const reopened = await loadDocumentState("n3", new Y.Doc());
  assert.equal(text(reopened), degradedText(UNDERSCORES));
  assert.equal(fv.notes.get("n3")!.content, UNDERSCORES);
});

test("store: a document that cannot be rendered in budget is not written, and is flagged instead of silently unsaved", { timeout: 120_000 }, async () => {
  fv.put({ id: "n4", tags: ["garden"], content: "<p>small</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n4", new Y.Doc());
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("grown past what can be rendered")]);
  doc.getXmlFragment("default").insert(1, [para]);
  // The renderer's budget is exceeded (here: by shrinking the budget).
  restore.push(configureConversion({ inlineMaxNodes: 0, maxChars: 4 }));
  const stored = await probed(() => storeDocumentState("n4", doc));
  assert.equal(stored.error, undefined, "a store never throws");
  assert.ok(stored.maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${stored.maxLagMs.toFixed(0)} ms`);
  assert.deepEqual(vaultWrites(), []);
  assert.equal(fv.notes.get("n4")!.content, "<p>small</p>");
  assert.equal(isDocDegraded("n4"), true, "flagged: sockets go read-only and the document reopens from the note");
  // The live state is kept as a snapshot with no source version (as after a failed vault write).
  assert.equal(getDocState("n4")!.sourceUpdatedAt, null);
  // A busy converter is NOT the document's fault: the store waits for a slot, then writes — nothing is flagged.
  restoreLimits();
  resetDegradedState();
  fv.put({ id: "n5", tags: ["garden"], content: "<p>small</p>", updatedAt: "2026-03-01T00:00:00.000Z" });
  const other = await loadDocumentState("n5", new Y.Doc());
  other.getXmlFragment("default").insert(1, [new Y.XmlElement("paragraph")]);
  await stopConversionWorkers();
  restore.push(configureConversion({ inlineMaxNodes: 0, threads: 1, maxQueue: 1, timeoutMs: 600, timeoutPerMbMs: 0, timeoutMaxMs: 600 }));
  const busyBefore = conversionStats.busy;
  const hog = [0, 1, 2].map((i) => markdownToHtml(`${EMPHASIS} hog ${i}`).catch(() => null));
  await storeDocumentState("n5", other);
  await Promise.all(hog);
  assert.ok(conversionStats.busy > busyBefore, "the converter really was saturated");
  assert.equal(isDocDegraded("n5"), false);
  assert.equal(fv.notes.get("n5")!.content, "<p>small</p><p></p>", "stored once a slot was free");
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
