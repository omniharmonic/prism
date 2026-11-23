/**
 * NP-PF-01…09 + NP-SB-13 against a production build. Every number is recorded in
 * test-results/perf/results.json (best, median, and p50 / p95 over PERF_RUNS samples); a budget miss does NOT
 * fail the test — the report is the deliverable. See docs/roadmap/workspace-experience/PERF-RESULTS.md.
 */
import { test, expect, devices, type Page, type CDPSession } from "@playwright/test";
import { startPerfServer, signedIn, until, arm, openApp, quickOpen, record, recordSamples, stats, round, editorHas, RUNS, ORIGIN, EDITOR_TEXT, type PerfServer } from "./harness";

let server: PerfServer;
test.beforeAll(async () => { server = await startPerfServer(); });
test.afterAll(async () => { await server?.stop(); });

const TREE_ROWS = `document.querySelectorAll("[data-depth]").length`;
const heapMb = async (cdp: CDPSession) => {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
  return { heap: get("JSHeapUsedSize") / 1048576, nodes: get("Nodes"), listeners: get("JSEventListeners"), documents: get("Documents") };
};

test("PF-01 cold start to interactive editor", async ({ browser }) => {
  const editorReady = `${EDITOR_TEXT}.length > 40000`;
  // (a) empty HTTP cache: a fresh context per run.
  const cold: number[] = [];
  let transfer: unknown;
  for (let i = 0; i < RUNS; i++) {
    const ctx = await signedIn(browser, server);
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/page/${server.ids.page50k}`);
    cold.push((await until(page, editorReady)).ms);
    if (i === 0) transfer = await page.evaluate(() => {
      const r = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const js = r.filter((e) => e.name.endsWith(".js"));
      const api = r.filter((e) => /\/(api|auth|acl)\//.test(e.name));
      return { jsFiles: js.length, jsDecodedKB: Math.round(js.reduce((a, e) => a + e.decodedBodySize, 0) / 1024), jsTransferKB: Math.round(js.reduce((a, e) => a + e.transferSize, 0) / 1024), apiCalls: api.length, apiDecodedKB: Math.round(api.reduce((a, e) => a + e.decodedBodySize, 0) / 1024), biggestApi: api.sort((a, b) => b.decodedBodySize - a.decodedBodySize).slice(0, 3).map((e) => `${new URL(e.name).pathname}${new URL(e.name).search.slice(0, 40)} ${Math.round(e.decodedBodySize / 1024)} KB`) };
    });
    await ctx.close();
  }
  recordSamples("NP-PF-01", "cold load → editable 50 KB page, EMPTY HTTP cache (desktop)", cold, { note: "informational; the row's budget is warm cache", extra: transfer });
  // (b) warm HTTP cache: same context (assets are immutable-cached), a new tab per run.
  const ctx = await signedIn(browser, server);
  await (await openApp(ctx, server.ids.page50k, 40000)).close();
  const warm: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/page/${server.ids.page50k}`);
    warm.push((await until(page, editorReady)).ms);
    await page.close();
  }
  recordSamples("NP-PF-01", "cold start → editable 50 KB page, warm HTTP cache (desktop)", warm, { budget: 2000 });
  await ctx.close();
  // (c) phone proxy: iPhone 13 viewport/UA on Chromium + 4x CPU throttle. NOT an iPhone.
  const phone = await signedIn(browser, server, { ...devices["iPhone 13"], defaultBrowserType: undefined } as never);
  await (await openApp(phone, server.ids.page50k, 40000)).close();
  const slow: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await phone.newPage();
    const cdp = await phone.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.goto(`${ORIGIN}/page/${server.ids.page50k}`);
    slow.push((await until(page, editorReady, 120_000)).ms);
    await page.close();
  }
  recordSamples("NP-PF-01", "PROXY for iPhone: 390 px Chromium, 4x CPU throttle, warm cache", slow, { budget: 3000, note: "proxy only — the row needs Safari Web Inspector on a device" });
  await phone.close();
});

test("PF-02 open a page from the tree / ⌘K", async ({ browser }) => {
  const ctx = await signedIn(browser, server);
  const page = await openApp(ctx, server.ids.blank, 0);
  await page.waitForFunction(TREE_ROWS + " > 0");
  await page.waitForTimeout(2500); // boot traffic settles
  const names = server.ids.uncached; // 26 pages with unique one-word names (PERF_RUNS up to 26)
  expect(names.length, "one never-read page per run: raise the perf server's NAMES for a larger PERF_RUNS").toBeGreaterThanOrEqual(RUNS);
  // Uncached: a 50 KB page this browser has never read, opened from ⌘K.
  const uncached: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await quickOpen(page, `${names[i]} page`, `${names[i]} page`);
    uncached.push((await until(page, editorHas(`Uncached ${names[i]} page`, 40000))).ms);
    await page.waitForTimeout(800);
  }
  recordSamples("NP-PF-02", "open an UNCACHED 50 KB page from ⌘K (Enter → editable body painted)", uncached, { budget: 1000 });
  // Cached: pages already opened in this session, reopened from ⌘K and from the tree.
  const cached: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const name = names[(i + 1) % Math.min(RUNS, names.length)]!;
    await quickOpen(page, `${name} page`, `${name} page`);
    cached.push((await until(page, editorHas(`Uncached ${name} page`, 40000))).ms);
    await page.waitForTimeout(500);
  }
  recordSamples("NP-PF-02", "reopen a CACHED 50 KB page from ⌘K", cached, { budget: 300 });
  // From the tree: the open page's folder is revealed; click a sibling row.
  const tree: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const name = names[(i + 2) % Math.min(RUNS, names.length)]!;
    const row = page.locator(".page-tree-open", { hasText: new RegExp(`^${name} page$`) }).first();
    await row.scrollIntoViewIfNeeded();
    await arm(page, "click");
    await row.click();
    tree.push((await until(page, editorHas(`Uncached ${name} page`, 40000))).ms);
    await page.waitForTimeout(500);
  }
  recordSamples("NP-PF-02", "reopen a CACHED 50 KB page from the sidebar tree", tree, { budget: 300 });
  await ctx.close();
});

test("PF-03 typing in a 10k-word, 200-block page", async ({ browser }) => {
  const ctx = await signedIn(browser, server);
  const page = await openApp(ctx, server.ids.page10kw, 50000);
  await page.waitForTimeout(3000);
  const shape = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror[contenteditable="true"]')!;
    const has = (sel: string) => pm.querySelectorAll(sel).length;
    return { blocks: pm.children.length, words: (pm.textContent ?? "").split(/\s+/).length, callout: has('[data-type="callout"]'), toggle: has("details"), columns: has('[data-type="columns"]'), table: has("table"), attachment: has('[data-type="attachment"]'), embed: has('[data-type="embed"]'), bookmark: has('[data-type="bookmark"]'), toc: has('[data-type="toc"]'), database: has("[data-prism-database]"), dom: document.querySelectorAll("*").length };
  });
  const p50s: number[] = [], works: number[] = [], maxLong: number[] = [], longCounts: number[] = [];
  let all: Array<{ work: number; paint: number }> = [];
  for (let run = 0; run < RUNS; run++) {
    // Caret into a paragraph in the middle of the document.
    const target = page.locator('.ProseMirror[contenteditable="true"] > p').nth(60 + run * 7);
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await page.keyboard.press("End");
    await page.waitForTimeout(600);
    await page.evaluate(() => { const P = (window as never as { __perf: { keys: unknown[]; longTasks: unknown[]; recordKeys: boolean } }).__perf; P.keys = []; P.longTasks = []; P.recordKeys = true; });
    await page.keyboard.type(" The quick brown fox jumps over the lazy dog, twice. And once more for luck", { delay: 45 });
    await page.waitForTimeout(400);
    const got = await page.evaluate(() => { const P = (window as never as { __perf: { keys: Array<{ work: number; paint: number }>; longTasks: Array<{ duration: number }>; recordKeys: boolean } }).__perf; P.recordKeys = false; return { keys: P.keys.filter((k) => k.paint > 0), long: P.longTasks.map((l) => l.duration) }; });
    all = all.concat(got.keys);
    const paints = stats(got.keys.map((k) => k.paint));
    p50s.push(paints.median);
    works.push(stats(got.keys.map((k) => k.work)).median);
    maxLong.push(got.long.length ? Math.max(...got.long) : 0);
    longCounts.push(got.long.length);
  }
  const paints = stats(all.map((k) => k.paint));
  record({ id: "NP-PF-03", metric: "keystroke → next painted frame, p50 (live collab editor)", unit: "ms", budget: 16, best: Math.min(...p50s), median: stats(p50s).median, samples: p50s, note: `all ${paints.n} keystrokes: p50 ${paints.median}, p95 ${paints.p95}, worst ${paints.worst}; includes waiting for the next 60 Hz frame (0–16.7 ms)`, extra: shape });
  record({ id: "NP-PF-03", metric: "keystroke → synchronous handling done, p50", unit: "ms", best: Math.min(...works), median: stats(works).median, samples: works });
  record({ id: "NP-PF-03", metric: "longest task while typing (budget: none > 50 ms)", unit: "ms", budget: 50, best: Math.min(...maxLong), median: stats(maxLong).median, samples: maxLong, note: `long tasks per 75-key run: ${longCounts.join(", ")}` });
  // Live collab echo: a second tab on the same document sees the keystroke.
  const other = await openApp(ctx, server.ids.page10kw, 50000);
  await other.waitForTimeout(1500);
  const echo: number[] = [];
  const para = page.locator('.ProseMirror[contenteditable="true"] > p').nth(20);
  await page.bringToFront();
  await para.scrollIntoViewIfNeeded();
  await para.click();
  await page.keyboard.press("End");
  for (let i = 0; i < Math.max(RUNS, 10); i++) {
    const token = `qz${i}x`;
    const seen = other.evaluate((t) => new Promise<number>((resolve) => {
      const pm = document.querySelector('.ProseMirror[contenteditable="true"]')!;
      const check = () => { if ((pm.textContent ?? "").includes(t)) { mo.disconnect(); resolve(Date.now()); } };
      const mo = new MutationObserver(check);
      mo.observe(pm, { subtree: true, childList: true, characterData: true });
      check();
    }), token);
    await page.keyboard.type(token.slice(0, -1));
    await page.evaluate(() => { addEventListener("keydown", () => { (window as never as { __sent: number }).__sent = Date.now(); }, { once: true, capture: true }); });
    await page.keyboard.type("x");
    const sent = await page.evaluate(() => (window as never as { __sent: number }).__sent);
    echo.push((await seen) - sent);
    await page.waitForTimeout(200);
  }
  recordSamples("NP-PF-03", "live collab echo: keystroke in tab A → visible in tab B (same machine, real Hocuspocus)", echo, { note: "both tabs in one browser; background-tab timers are not throttled in headless" });
  await ctx.close();
});

test("PF-04 sidebar tree at 15k notes", async ({ browser }) => {
  const render: number[] = [], total: number[] = [], expand: number[] = [];
  let fps: unknown[] = [], rows = 0, fetchInfo: unknown;
  for (let i = 0; i < RUNS; i++) {
    const ctx = await signedIn(browser, server);
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/page/${server.ids.blank}`);
    const first = await until(page, TREE_ROWS + " > 3");
    const tree = await page.evaluate(() => { const e = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find((r) => r.name.endsWith("/api/tree")); return e ? { end: e.responseEnd, ms: e.responseEnd - e.startTime, transferKB: Math.round(e.transferSize / 1024), decodedKB: Math.round(e.decodedBodySize / 1024) } : null; });
    total.push(first.at);
    if (tree) render.push(first.at - tree.end);
    fetchInfo = tree;
    await page.waitForTimeout(1500);
    // Expand the largest folder (messages → telegram: 3,000 pages in one folder).
    await page.locator('.page-tree-disclosure[aria-label="Expand messages"]').click();
    await page.waitForTimeout(300);
    const before = await page.evaluate(TREE_ROWS) as number;
    await arm(page, "click");
    await page.locator('.page-tree-disclosure[aria-label="Expand telegram"]').click();
    expand.push((await until(page, `${TREE_ROWS} > ${before + 100}`)).ms);
    rows = await page.evaluate(TREE_ROWS) as number;
    await page.waitForTimeout(500);
    fps.push(await page.evaluate(() => {
      let s: HTMLElement | null = document.querySelector("[data-depth]");
      while (s && !(s.scrollHeight > s.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      return (window as never as { __perf: { fps(el: HTMLElement, px: number, ms: number): Promise<unknown> } }).__perf.fps(s!, Math.min(s!.scrollHeight - s!.clientHeight, 30000), 2000);
    }));
    await ctx.close();
  }
  recordSamples("NP-PF-04", "tree data received → sidebar tree painted (collapsed, lazily expanded)", render, { budget: 500, extra: fetchInfo });
  recordSamples("NP-PF-04", "navigation start → sidebar tree painted (cold cache, incl. app boot + GET /api/tree)", total, { note: "informational" });
  recordSamples("NP-PF-04", `expand a folder of 3,000 pages (click → rows painted; ${rows} rows in the DOM after)`, expand, { budget: 500 });
  const f = fps as Array<{ fps: number; p95: number; worst: number; over20: number; frames: number }>;
  record({ id: "NP-PF-04", metric: `scroll the expanded tree (${rows} rows), frames per second`, unit: "fps", budget: 55, higherIsBetter: true, best: round(Math.max(...f.map((x) => x.fps)), 1), median: stats(f.map((x) => x.fps)).median, samples: f.map((x) => round(x.fps, 1)), note: `p95 frame ${round(stats(f.map((x) => x.p95)).median, 1)} ms, worst ${round(Math.max(...f.map((x) => x.worst)), 1)} ms; headless Chromium at 60 Hz`, extra: f });
});

test("PF-05 ⌘K titles/recents and server full-text", async ({ browser }) => {
  const ctx = await signedIn(browser, server);
  const page = await openApp(ctx, server.ids.page50k, 40000);
  await page.waitForFunction(TREE_ROWS + " > 0");
  await page.waitForTimeout(2500);
  const open: number[] = [], titles: number[] = [], fulltext: number[] = [], serverMs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await arm(page, "key");
    await page.keyboard.press("Meta+k");
    open.push((await until(page, `document.querySelectorAll("#prism-command-results [role=option]").length > 0`)).ms);
    // Title query: the last character typed → a row naming the page.
    const title = ["Fifty kilobyte", "Ten thousand wor", "Row databas", "Uncached", "Blank"][i % 5]!;
    await page.keyboard.press("Meta+a");
    await arm(page, "input");
    await page.keyboard.insertText(title); // ONE input event: nothing matching is on screen before it
    titles.push((await until(page, `[...document.querySelectorAll("#prism-command-results [role=option]")].some((o) => o.textContent.toLowerCase().includes(${JSON.stringify(title.toLowerCase().slice(0, 8))}))`)).ms);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // Full text: two body words; the row must show a snippet from the server.
    const q = [["almanac", "quorum"], ["harbor", "lantern"], ["granite", "ember"], ["mosaic", "prairie"], ["kettle", "willow"]][i % 5]!;
    await page.keyboard.press("Meta+k");
    await page.locator("#prism-command-results").waitFor();
    await page.keyboard.press("Meta+a");
    await page.keyboard.type(`${q[0]} ${q[1]!.slice(0, -1)}`, { delay: 20 });
    await arm(page, "input");
    await page.keyboard.type(q[1]!.slice(-1));
    const done = await until(page, `performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/search?") && r.name.includes(${JSON.stringify(q[1])}) && r.responseEnd > 0).length > 0 && [...document.querySelectorAll("#prism-command-results [role=option]")].some((o) => o.textContent.toLowerCase().includes(${JSON.stringify(q[1])}))`, 20000);
    fulltext.push(done.ms);
    const entry = await page.evaluate((w) => { const e = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((r) => r.name.includes("/api/search?") && r.name.includes(w)).pop(); return e ? e.responseEnd - e.startTime : 0; }, q[1]!);
    serverMs.push(entry);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  recordSamples("NP-PF-05", "⌘K pressed → recents/commands painted", open, { budget: 150 });
  recordSamples("NP-PF-05", "title typed (one input event) → matching title row painted", titles, { budget: 150 });
  recordSamples("NP-PF-05", "last keystroke → server full-text rows painted (incl. the input debounce)", fulltext, { budget: 500 });
  recordSamples("NP-PF-05", "GET /api/search request time as seen by the browser", serverMs, { note: "fake vault: an in-memory substring filter over 15k bodies" });
  await ctx.close();
});

test("PF-06 database with 5,000 rows", async ({ browser }) => {
  const first: number[] = [], sort: number[] = [], filter: number[] = [];
  const fps: Array<{ fps: number; p95: number; worst: number }> = [];
  let info: unknown;
  for (let i = 0; i < RUNS; i++) {
    const ctx = await signedIn(browser, server);
    if (i === 0) await (await openApp(ctx, server.ids.blank, 0)).close(); // warm HTTP cache for the app shell
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/page/${server.ids.db}`);
    first.push((await until(page, `document.querySelectorAll(".db-table tbody tr").length > 50`)).ms);
    await page.waitForTimeout(1200);
    info = await page.evaluate(() => ({ rowsInDom: document.querySelectorAll(".db-table tbody tr").length, dom: document.querySelectorAll("*").length, queries: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((r) => r.name.endsWith("/api/query")).map((r) => Math.round(r.responseEnd - r.startTime)) }));
    // Sort by a column from its header menu.
    await page.locator(".db-th", { hasText: "Points" }).click();
    const firstTitle = await page.locator(".db-table tbody tr .db-row-open").first().textContent();
    await arm(page, "click");
    await page.locator(".db-menu").getByText(i % 2 ? "Sort ascending" : "Sort descending").click(); // the view's sort is saved, so alternate
    sort.push((await until(page, `document.querySelector(".db-table tbody tr .db-row-open")?.textContent !== ${JSON.stringify(firstTitle)} && document.querySelectorAll(".db-table tbody tr").length > 50`)).ms);
    await page.waitForTimeout(600);
    // Search-filter the view (typed text → server query → rows).
    const search = page.getByRole("searchbox").or(page.getByPlaceholder(/search/i)).filter({ visible: true }).last();
    if (await search.count()) {
      await search.click();
      await search.pressSequentially("almana", { delay: 20 });
      await arm(page, "input");
      await search.pressSequentially("c");
      filter.push((await until(page, `(() => { const t = [...document.querySelectorAll(".db-table tbody tr .db-row-open")]; return t.length > 0 && t.every((e) => e.textContent.toLowerCase().includes("almanac")); })()`, 15000).catch(() => ({ ms: NaN }))).ms);
      await search.fill("");
      await page.waitForTimeout(500);
    }
    fps.push(await page.evaluate(() => { const s = document.querySelector<HTMLElement>(".db-scroll")!; return (window as never as { __perf: { fps(el: HTMLElement, px: number, ms: number): Promise<{ fps: number; p95: number; worst: number }> } }).__perf.fps(s, s.scrollHeight - s.clientHeight, 2000); }));
    await ctx.close();
  }
  recordSamples("NP-PF-06", "navigation start → first 100 rows of a 5,000-row database painted (warm HTTP cache after run 1)", first, { budget: 1500, extra: info });
  recordSamples("NP-PF-06", "sort change (header menu → re-sorted rows painted)", sort, { budget: 500 });
  if (filter.filter((x) => !Number.isNaN(x)).length) recordSamples("NP-PF-06", "search filter (last keystroke → filtered rows painted)", filter.filter((x) => !Number.isNaN(x)), { budget: 500 });
  record({ id: "NP-PF-06", metric: "scroll the table (one 100-row page loaded), frames per second", unit: "fps", budget: 55, higherIsBetter: true, best: round(Math.max(...fps.map((x) => x.fps)), 1), median: stats(fps.map((x) => x.fps)).median, samples: fps.map((x) => round(x.fps, 1)), note: `p95 frame ${round(stats(fps.map((x) => x.p95)).median, 1)} ms, worst ${round(Math.max(...fps.map((x) => x.worst)), 1)} ms` });
});

test("PF-07 memory proxy: JS heap over repeated page opens", async ({ browser }) => {
  const opens = Number(process.env.PERF_SOAK_OPENS ?? 50);
  const ctx = await signedIn(browser, server);
  const page = await openApp(ctx, server.ids.blank, 0);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.waitForFunction(TREE_ROWS + " > 0");
  await page.waitForTimeout(4000);
  const series: Array<{ opens: number; heap: number; nodes: number; listeners: number }> = [];
  const snap = async (n: number) => { const m = await heapMb(cdp); series.push({ opens: n, heap: round(m.heap, 1), nodes: m.nodes, listeners: m.listeners }); };
  await snap(0);
  const pages: Array<[string, string, string]> = [
    ...server.ids.uncached.slice(0, 6).map((name) => [`${name} page`, `${name} page`, `Uncached ${name} page`] as [string, string, string]),
    ["Ten thousand wor", "Ten thousand words", "Ten thousand words"],
    ["Fifty kilobyte", "Fifty kilobyte page", "Fifty kilobyte page"],
  ];
  for (let n = 1; n <= opens; n++) {
    const [q, row, text] = pages[n % pages.length]!;
    await quickOpen(page, q, row);
    await until(page, editorHas(text, 1000));
    await page.waitForTimeout(250);
    // One tab at a time, like a phone: close the others so retained tabs are not the "leak".
    if (n % 10 === 0) { await page.waitForTimeout(1500); await snap(n); }
  }
  await page.waitForTimeout(20_000);
  await snap(opens + 0.5);
  const firstHalf = series.find((s) => s.opens >= opens / 2)!;
  const last = series[series.length - 1]!;
  const slope = (last.heap - firstHalf.heap) / (opens / 2);
  record({ id: "NP-PF-07", metric: `WEB PROXY: JS heap after ${opens} page opens (forced GC), desktop Chromium`, unit: "MB", budget: 300, best: last.heap, median: last.heap, note: `heap series ${series.map((s) => `${s.opens}:${s.heap}`).join(" → ")} MB; second-half growth ${round(slope, 2)} MB/open; DOM nodes ${series.map((s) => s.nodes).join(" → ")}. JS heap only — not process RSS, not iOS; the row itself is device-only (Xcode Instruments)`, extra: series });
  await ctx.close();
});

test("PF-09 idle clients: no polling storm", async ({ browser }) => {
  const seconds = Number(process.env.PERF_IDLE_S ?? 120);
  const ctx = await signedIn(browser, server);
  const pages: Page[] = [];
  for (const id of [server.ids.page50k, server.ids.db, server.ids.blank]) pages.push(await openApp(ctx, id, 0).catch(async () => { const p = await ctx.newPage(); await p.goto(`${ORIGIN}/page/${id}`); return p; }));
  await pages[1]!.locator(".db-table tbody tr").first().waitFor();
  await pages[0]!.waitForTimeout(15_000); // boot traffic settles
  const seen: Record<string, number> = {};
  let total = 0;
  for (const p of pages) p.on("request", (r) => { const u = new URL(r.url()); if (!/^\/(api|auth|acl)\//.test(u.pathname)) return; total++; const k = `${r.method()} ${u.pathname.replace(/\/notes\/[^/]+/, "/notes/:id")}`; seen[k] = (seen[k] ?? 0) + 1; });
  await server.ask({ op: "reset" });
  await pages[0]!.waitForTimeout(seconds * 1000);
  const vault = await server.ask<{ total: number; by: Record<string, { n: number; ms: number; bytes: number }> }>({ op: "calls" });
  const perMin = (n: number) => round((n * 60) / seconds, 2);
  record({ id: "NP-PF-09", metric: `3 idle tabs, ${seconds} s: browser → server requests per minute`, unit: "req/min", best: perMin(total), median: perMin(total), note: Object.entries(seen).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join("; ") || "none", extra: seen });
  record({ id: "NP-PF-09", metric: `3 idle tabs, ${seconds} s: server → vault calls per minute`, unit: "calls/min", best: perMin(vault.total), median: perMin(vault.total), note: Object.entries(vault.by).map(([k, v]) => `${k} ×${v.n} (${round(v.bytes / 1024)} KB)`).join("; ") || "none", extra: vault.by });
  await ctx.close();
});

test("SB-13 new page in one action", async ({ browser }) => {
  const ctx = await signedIn(browser, server);
  const page = await openApp(ctx, server.ids.blank, 0);
  await page.waitForFunction(TREE_ROWS + " > 0");
  await page.waitForTimeout(2500);
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await arm(page, "click");
    await page.getByRole("button", { name: "New page", exact: true }).first().click();
    samples.push((await until(page, `document.activeElement?.getAttribute("aria-label") === "Document title" && document.activeElement.value?.startsWith("Untitled")`)).ms);
    await page.waitForTimeout(1200);
  }
  recordSamples("NP-SB-13", "sidebar New page click → Untitled page with the title focused", samples, { budget: 300 });
  expect(samples.length).toBe(RUNS);
  await ctx.close();
});
