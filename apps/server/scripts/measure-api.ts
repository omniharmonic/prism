/**
 * Server-side timings for the performance budgets (NP-PF-04/05/06): the tree projection,
 * one page read, full-text search and the database query, against a SANDBOX server.
 *
 *   # terminal 1 — the perf fixture (real server, fake 15k-note vault, in-memory DB):
 *   cd apps/server && APP_ORIGIN=http://127.0.0.1:5364 PERF_PORT=5364 \
 *     node --import tsx --env-file=.env.test test/fixtures/perf-server.ts     # prints {"port":…,"session":"…"}
 *   # terminal 2:
 *   node --import tsx scripts/measure-api.ts --base http://127.0.0.1:5364 --session <session> [--runs 20] [--json out.json]
 *
 * `--cookie "prism_session=…"` or `--token pd_…` work too (any sandbox server).
 * REFUSES :1940 and :8787 (the live vault / prod server). Read-only apart from POST /api/query.
 */
import { writeFileSync } from "node:fs";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg("base", "")!;
const runs = Number(arg("runs", "20"));
if (!base || /:(1940|8787)(\/|$)/.test(base)) {
  console.error("Give --base of a sandbox server (never :1940 / :8787).");
  process.exit(2);
}
const headers: Record<string, string> = { Origin: base, "Accept-Encoding": "gzip" };
if (arg("token")) headers.Authorization = `Bearer ${arg("token")}`;
if (arg("cookie")) headers.cookie = arg("cookie")!;
if (arg("session")) headers.cookie = `prism_session=${arg("session")}`;

interface Sample { ms: number; bytes: number; status: number }
async function time(path: string, init: RequestInit = {}): Promise<Sample> {
  const t0 = performance.now();
  const r = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  const body = await r.arrayBuffer(); // decoded size (fetch gunzips)
  return { ms: performance.now() - t0, bytes: body.byteLength, status: r.status };
}
const q = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
const rows: Array<{ name: string; budget?: number; best: number; p50: number; p95: number; kb: number; status: number }> = [];
async function bench(name: string, fn: (i: number) => Promise<Sample>, budget?: number) {
  const samples: Sample[] = [];
  for (let i = 0; i < runs; i++) samples.push(await fn(i));
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const row = { name, budget, best: +ms[0]!.toFixed(1), p50: +q(ms, 0.5).toFixed(1), p95: +q(ms, 0.95).toFixed(1), kb: Math.round(samples[0]!.bytes / 1024), status: samples[samples.length - 1]!.status };
  rows.push(row);
  console.log(`${name.padEnd(64)} best ${String(row.best).padStart(7)}  p50 ${String(row.p50).padStart(7)}  p95 ${String(row.p95).padStart(7)} ms  ${String(row.kb).padStart(6)} KB  ${row.status}${budget ? `  (budget ${budget} ms → ${row.p95 <= budget ? "pass" : "MISS"})` : ""}`);
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const WORDS = ["almanac quorum", "harbor lantern", "granite ember", "mosaic prairie", "kettle willow", "workshop budget", "cedar notebook", "festival charter"];

const first = await time("/api/tree");
console.log(`first GET /api/tree (builds the projection): ${first.ms.toFixed(0)} ms, ${Math.round(first.bytes / 1024)} KB decoded, ${first.status}\n`);
let etag = "";
await bench("GET /api/tree (projection in memory, gzip)", async () => {
  const t0 = performance.now();
  const r = await fetch(base + "/api/tree", { headers });
  etag = r.headers.get("etag") ?? etag;
  const b = await r.arrayBuffer();
  return { ms: performance.now() - t0, bytes: b.byteLength, status: r.status };
});
await bench("GET /api/tree If-None-Match (304)", () => time("/api/tree", { headers: { "If-None-Match": etag } }));
await bench("GET /api/notes/perf-50k (50 KB page)", () => time("/api/notes/perf-50k"));
await bench("GET /api/notes/perf-50k, Cache-Control: no-cache", () => time("/api/notes/perf-50k", { headers: { "Cache-Control": "no-cache" } }));
await bench("GET /api/search?q=<two body words>&limit=30  (NP-PF-05)", (i) => time(`/api/search?q=${encodeURIComponent(WORDS[i % WORDS.length]!)}&limit=30&lean=1&r=${i}`), 500);
await bench("GET /api/search?q=<title words>&title=1", (i) => time(`/api/search?q=${encodeURIComponent(["fifty kilobyte", "ten thousand", "row database"][i % 3]!)}&title=1&limit=30&r=${i}`), 500);
await bench("POST /api/query first page of 5,000 rows  (NP-PF-06)", () => time("/api/query", json({ tags: ["perf-row"], limit: 100 })), 500);
await bench("POST /api/query sort by points desc", () => time("/api/query", json({ tags: ["perf-row"], limit: 100, sort: [{ key: "points", dir: "desc" }] })), 500);
await bench("POST /api/query filter status = Doing AND points >= 6", () => time("/api/query", json({ tags: ["perf-row"], limit: 100, filter: { match: "all", conditions: [{ key: "status", op: "eq", value: "Doing" }, { key: "points", op: "gte", value: 6 }] } })), 500);
await bench("POST /api/query search \"almanac\"", () => time("/api/query", json({ tags: ["perf-row"], limit: 100, search: "almanac" })), 500);
await bench("POST /api/query limit 500 (bulk page)", () => time("/api/query", json({ tags: ["perf-row"], limit: 500 })));

const out = arg("json");
if (out) writeFileSync(out, JSON.stringify({ base, runs, firstTree: first, rows }, null, 2));
export {};
