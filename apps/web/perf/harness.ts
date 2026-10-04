/**
 * Shared pieces of the performance run: the perf server (real Prism Server + fake
 * 15k-note vault + the production build), a signed-in browser context that never
 * leaves loopback, in-page timing probes, and the results file.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../../server");
export const RUNS = Number(process.env.PERF_RUNS ?? 5);
export const PORT = Number(process.env.PERF_PORT ?? 5363);
export const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(process.env.PERF_OUT ?? path.join(here, "../test-results/perf/results.json"));

export interface PerfServer {
  port: number;
  session: string;
  notes: number;
  bytes: number;
  ids: { page50k: string; page10kw: string; blank: string; db: string; uncached: string[] };
  words10k: number;
  blocks10k: number;
  ask<T>(cmd: Record<string, unknown>): Promise<T>;
  stop(): Promise<void>;
}

export async function startPerfServer(): Promise<PerfServer> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", "tsx", "--env-file=.env.test", "test/fixtures/perf-server.ts"], {
    cwd: serverDir,
    env: { ...process.env, APP_ORIGIN: ORIGIN, PERF_PORT: String(PORT), NODE_ENV: "test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue; // server log lines
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + String(d)).slice(-4000)));
  const next = () =>
    new Promise<string>((resolve, reject) => {
      const l = lines.shift();
      if (l !== undefined) return resolve(l);
      const t = setTimeout(() => reject(new Error(`perf server silent. stderr:\n${stderr}`)), 120_000);
      waiters.push((line) => { clearTimeout(t); resolve(line); });
    });
  const hello = JSON.parse(await next()) as Omit<PerfServer, "ask" | "stop">;
  return {
    ...hello,
    async ask<T>(cmd: Record<string, unknown>) {
      child.stdin.write(JSON.stringify(cmd) + "\n");
      return JSON.parse(await next()) as T;
    },
    async stop() {
      child.stdin.end();
      await new Promise((r) => { child.once("exit", r); setTimeout(() => { child.kill("SIGKILL"); r(null); }, 3000); });
    },
  };
}

/** A signed-in context. Anything that is not the perf server is refused (web fonts, embeds). */
export async function signedIn(browser: Browser, server: PerfServer, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  // bypassCSP: the probes build their wait conditions with `new Function` (the app's CSP has no unsafe-eval).
  const ctx = await browser.newContext({ serviceWorkers: "block", bypassCSP: true, viewport: { width: 1440, height: 900 }, ...options });
  await ctx.addCookies([{ name: "prism_session", value: server.session, domain: "127.0.0.1", path: "/" }]);
  await ctx.route((u) => !u.href.startsWith(ORIGIN), (r) => r.abort());
  await ctx.addInitScript(PROBE);
  return ctx;
}

/**
 * In-page probes (installed before any app code):
 *  - `__perf.arm()`: the NEXT trusted keydown(Enter)/click/input stamps t0;
 *  - `__perf.until(fn)`: resolves `{ms, at}` once `fn()` is truthy AND a frame was presented
 *    (rAF + a task), measured from t0 (or from navigation start when nothing was armed);
 *  - long tasks (>50 ms) and per-keystroke latency recorders.
 */
const PROBE = `(() => {
  const P = (window.__perf = { t0: null, armed: false, longTasks: [], keys: [], frames: [] });
  const stamp = (e) => { if (P.armed && e.isTrusted) { P.t0 = performance.now(); P.armed = false; } };
  addEventListener("keydown", (e) => { if (e.key === "Enter" || P.armAny) stamp(e); }, true);
  addEventListener("click", stamp, true);
  addEventListener("input", (e) => { if (P.armInput) { P.armed = true; stamp(e); P.armInput = false; } }, true);
  P.arm = (kind) => { P.t0 = null; P.armed = kind !== "input"; P.armInput = kind === "input"; P.armAny = kind === "key"; };
  P.painted = () => new Promise((r) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => r(performance.now()); c.port2.postMessage(0); }));
  P.until = (fn, timeout = 60000) => new Promise((resolve, reject) => {
    const started = performance.now();
    let done = false;
    const check = async () => {
      if (done) return;
      let ok = false;
      try { ok = !!fn(); } catch {}
      if (!ok) { if (performance.now() - started > timeout) { done = true; mo.disconnect(); reject(new Error("perf.until timeout")); } return; }
      done = true; mo.disconnect(); clearInterval(iv);
      const at = await P.painted();
      resolve({ ms: at - (P.t0 ?? 0), at, t0: P.t0 });
    };
    const mo = new MutationObserver(check);
    mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    const iv = setInterval(check, 50);
    check();
  });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
  // Keystroke → next presented frame, and keystroke → end of the synchronous handling.
  addEventListener("keydown", (e) => {
    if (!P.recordKeys || !e.isTrusted) return;
    const t0 = performance.now();
    const rec = { queued: t0 - e.timeStamp, work: 0, paint: 0 };
    P.keys.push(rec);
    setTimeout(() => { rec.work = performance.now() - t0; }, 0);
    requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => { rec.paint = performance.now() - e.timeStamp; }; c.port2.postMessage(0); });
  }, true);
  P.fps = (el, px, ms) => new Promise((resolve) => {
    const frames = []; const start = performance.now(); let last = start; const from = el.scrollTop;
    const step = (now) => {
      frames.push(now - last); last = now;
      const k = Math.min(1, (now - start) / ms);
      el.scrollTop = from + px * k;
      if (k < 1) requestAnimationFrame(step);
      else { frames.shift(); const total = frames.reduce((a, b) => a + b, 0); const sorted = [...frames].sort((a, b) => a - b);
        resolve({ fps: (frames.length * 1000) / total, frames: frames.length, p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted[sorted.length - 1], over20: frames.filter((f) => f > 20).length, scrolled: el.scrollTop - from }); }
    };
    requestAnimationFrame(step);
  });
})();`;

export interface Until { ms: number; at: number; t0: number | null }
/** Wait (in the page) for a condition, timed from the armed input or from navigation start. */
export async function until(page: Page, fn: string, timeout = 60_000): Promise<Until> {
  try {
    return await page.evaluate(([f, t]) => (window as unknown as { __perf: { until(fn: () => unknown, t: number): Promise<Until> } }).__perf.until(new Function(`return (${f})`) as () => unknown, t as number), [fn, timeout] as const);
  } catch (error) {
    const shot = path.join(path.dirname(OUT), `fail-${Date.now()}.png`);
    mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`${(error as Error).message}\n  condition: ${fn}\n  screenshot: ${shot}`);
  }
}
export const arm = (page: Page, kind: "click" | "enter" | "input" | "key" = "click") => page.evaluate((k) => (window as unknown as { __perf: { arm(k: string): void } }).__perf.arm(k), kind);

/** A visible, editable editor holds `text` and at least `minLen` characters (tabs keep older editors mounted). */
export const editorHas = (text: string, minLen = 0) => `[...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].some((e) => e.offsetParent !== null && (e.textContent ?? "").length >= ${minLen} && (e.textContent ?? "").includes(${JSON.stringify(text)}))`;
/** Text of the document editor on screen. */
export const EDITOR_TEXT = `(document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent ?? "")`;

// ── statistics + the results file ────────────────────────────────────────────
export const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
export function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  // Nearest-rank percentiles: p95 of 20 samples is the 19th smallest, p05 the smallest.
  const rank = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))]!;
  return { best: round(s[0]!, 1), median: round(s[Math.floor((s.length - 1) / 2)]!, 1), p50: round(rank(0.5), 1), p05: round(rank(0.05), 1), p95: round(rank(0.95), 1), worst: round(s[s.length - 1]!, 1), n: s.length, samples: s.map((x) => round(x, 1)) };
}
/** The checklist's method for the budget rows: p50 AND p95 over at least this many runs (`PERF_RUNS=20`). */
export const METHOD_RUNS = 20;
export const loadAvg = () => { try { return execSync("uptime").toString().trim().replace(/^.*load averages?:\s*/, ""); } catch { return "?"; } };

export interface Row {
  id: string;
  metric: string;
  budget?: number;
  unit: string;
  best: number;
  median: number;
  samples?: number[];
  /** From `samples`: the median and the tail (95th percentile; the 5th for higher-is-better metrics such as fps). */
  p50?: number;
  p95?: number;
  n?: number;
  /**
   * Fewer than METHOD_RUNS samples (a quick run): best ≤ budget AND median ≤ budget → pass;
   * best ≤ budget only → pass(best); else miss — and the row is marked "(n < 20)".
   * With METHOD_RUNS or more: p50 AND p95 within budget → pass; p50 only → "pass (p50 only)"; else MISS.
   */
  verdict?: string;
  note?: string;
  load?: string;
  extra?: unknown;
}
export function record(row: Omit<Row, "verdict" | "load"> & { higherIsBetter?: boolean }): Row {
  const ok = (v: number) => (row.budget === undefined ? true : row.higherIsBetter ? v >= row.budget : v <= row.budget);
  const st = row.samples?.length ? stats(row.samples) : null;
  const p50 = st ? st.p50 : undefined;
  const p95 = st ? (row.higherIsBetter ? st.p05 : st.p95) : undefined;
  const n = st?.n;
  const byMethod = n !== undefined && n >= METHOD_RUNS && p50 !== undefined && p95 !== undefined;
  const verdict = row.budget === undefined ? "info"
    : byMethod ? (ok(p50!) && ok(p95!) ? "pass" : ok(p50!) ? "pass (p50 only)" : "MISS")
    : `${ok(row.median) ? "pass" : ok(row.best) ? "pass (best only)" : "MISS"}${n !== undefined ? ` (n=${n} < ${METHOD_RUNS}: not the row's method)` : ""}`;
  const out: Row = { ...row, ...(st ? { p50, p95, n } : {}), verdict, load: loadAvg() };
  delete (out as { higherIsBetter?: boolean }).higherIsBetter;
  mkdirSync(path.dirname(OUT), { recursive: true });
  const all: Row[] = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Row[]) : [];
  const i = all.findIndex((r) => r.id === row.id && r.metric === row.metric);
  if (i >= 0) all[i] = out; else all.push(out);
  writeFileSync(OUT, JSON.stringify(all, null, 2));
  console.log(`\n[perf] ${row.id} ${row.metric}: best ${out.best} ${row.unit}, median ${out.median} ${row.unit}${st ? `, p50 ${p50} / ${row.higherIsBetter ? "p05" : "p95"} ${p95} ${row.unit} over ${n} runs` : ""}${row.budget !== undefined ? ` (budget ${row.higherIsBetter ? "≥" : "≤"} ${row.budget}) → ${verdict}` : ""}  load ${out.load}${row.note ? `  — ${row.note}` : ""}`);
  return out;
}
export const recordSamples = (id: string, metric: string, samples: number[], rest: Partial<Row> & { higherIsBetter?: boolean } = {}) => {
  const s = stats(samples);
  return record({ id, metric, unit: "ms", best: rest.higherIsBetter ? s.worst : s.best, median: s.median, samples: s.samples, ...rest });
};

/** Open the app on a page and wait until its editor holds the body. */
export async function openApp(ctx: BrowserContext, pageId: string, minText = 1): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/page/${pageId}`);
  await until(page, `${EDITOR_TEXT}.length >= ${minText}`);
  return page;
}
/** ⌘K → type → wait for a result naming `expect` → Enter (armed) . */
export async function quickOpen(page: Page, query: string, expect: string): Promise<void> {
  await page.keyboard.press("Meta+k");
  await page.locator("#prism-command-results").waitFor();
  await page.keyboard.press("Meta+a"); // the bar can reopen with the previous query in it
  await page.keyboard.type(query);
  // The list settles in two steps (ranked, then blended with keyword hits) and is briefly
  // empty in between; Enter on an empty list does nothing by design. Wait for the settled list.
  const option = page.locator("#prism-command-results [role=option]", { hasText: expect, hasNotText: "Ask your agent" }).first();
  await option.waitFor();
  await page.waitForTimeout(700);
  await option.waitFor();
  await arm(page, "enter");
  await page.keyboard.press("Enter");
}
