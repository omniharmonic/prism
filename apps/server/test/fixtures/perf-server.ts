/**
 * Performance fixture (NP-PF, group 3C): the REAL Prism Server — gateway, tree
 * projection, /api/search, /api/query, collab socket — serving a PRODUCTION web build
 * (WEB_ROOT, default ../web/dist) over an in-memory fake vault seeded with a synthetic
 * 15k-note workspace (10,000 mixed notes + 5,000 database rows + the test pages). Never touches a real vault or the live DB (.env.test → :memory:).
 *
 *   cd apps/web && npx vite build
 *   cd apps/server && APP_ORIGIN=http://127.0.0.1:5363 PERF_PORT=5363 \
 *     node --import tsx --env-file=.env.test test/fixtures/perf-server.ts
 *
 * Prints ONE JSON line once listening: { port, session, ids: {...}, notes, bytes }.
 * stdin (one JSON per line → one JSON line back): {op:"calls"} vault calls since the
 * last reset grouped by "METHOD path", {op:"reset"}, {op:"note", id}. Exits on stdin end.
 *
 * The fake vault's note LIST is replaced here by one that behaves like vault 0.7.9 for
 * what matters to timing: `include_content=false`, `limit`/`offset`, `sort`, `tag`,
 * `path_prefix`, `path`, `search`, `include_metadata` — and, like the real vault, a list
 * WITHOUT `include_content=false` returns every body. It is an in-memory filter, so
 * vault-side time is a LOWER bound (no SQLite, no schema validation).
 *
 * Seed (fictional; PERF_NOTES / PERF_ROWS override the sizes):
 *   10,000 notes shaped like the real vault (messages, email, meetings, people, tasks,
 *   projects 2–5 levels deep), ~1 KB bodies; `perf-50k` (50 KB prose), `perf-10kw`
 *   (10,000 words, 200+ blocks incl. callout/toggle/columns/table/attachment/embed/
 *   bookmark/TOC/database block), `perf-db` (database over 5,000 `perf-row` notes).
 */
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createApp } from "../../src/app";
import { attachCollab } from "../../src/collab";
import { setUserProfile } from "../../src/db";
import { installFakeVault, makeSession, type FakeNote } from "../helpers";

const N = Number(process.env.PERF_NOTES ?? 10000);
const ROWS = Number(process.env.PERF_ROWS ?? 5000);
const PORT = Number(process.env.PERF_PORT ?? 5363);
const OWNER = "owner@test.local";

const fv = installFakeVault();

// ── deterministic text ───────────────────────────────────────────────────────
let rngState = 0x2f6e2b1;
const rnd = () => {
  rngState = (Math.imul(rngState ^ (rngState >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0;
  return ((rngState >>> 0) % 100000) / 100000;
};
const WORDS = "river meadow workshop budget harvest signal garden council ledger orchard commons village letter season bridge market canyon thread pattern summit lantern archive compass kettle willow granite ember harbor atlas mosaic prairie cedar notebook journey horizon quorum charter steward watershed festival almanac".split(" ");
const word = () => WORDS[Math.floor(rnd() * WORDS.length)]!;
const words = (n: number) => Array.from({ length: n }, word).join(" ");
const sentence = (n: number) => { const s = words(n); return s[0]!.toUpperCase() + s.slice(1) + "."; };
const title = () => { const s = words(2 + Math.floor(rnd() * 3)); return s[0]!.toUpperCase() + s.slice(1); };
const iso = (i: number) => new Date(Date.UTC(2026, 8, 30, 12, 0, 0) - i * 61_000).toISOString();

// ── seed ─────────────────────────────────────────────────────────────────────
let made = 0;
// PERF_TITLES=all: EVERY note carries a title (not its file name) and an alias — the worst
// case for the size of GET /api/tree, which emits both.
const TITLED = process.env.PERF_TITLES === "all";
const put = (n: Partial<FakeNote> & { id: string }) => {
  made++;
  const metadata = TITLED ? { ...(n.metadata ?? {}), title: `${title()} (${made})`, aliases: [`${words(2)} ${made}`] } : n.metadata;
  return fv.put({ createdAt: iso(made + 5000), updatedAt: iso(made), ...n, ...(metadata ? { metadata } : {}) });
};
const body = (paragraphs: number) => Array.from({ length: paragraphs }, () => `<p>${sentence(18 + Math.floor(rnd() * 30))}</p>`).join("");

const plan: Array<[share: number, make: (i: number) => Partial<FakeNote>]> = [
  [0.30, (i) => ({ path: `vault/messages/telegram/${title()} ${i}`, tags: ["message-thread", i % 3 ? "triaged" : "important"], metadata: { type: "message-thread", platform: "telegram", lastMessageAt: iso(i), messageCount: 3 + (i % 40) }, content: Array.from({ length: 8 }, (_, k) => `[2026-09-${String(10 + (k % 18)).padStart(2, "0")} 10:${String(k).padStart(2, "0")}] ${title()}: ${sentence(12)}`).join("\n") })],
  [0.22, (i) => ({ path: `vault/messages/email/${title().toLowerCase().replace(/ /g, "-")}-${i.toString(16)}`, tags: ["email"], metadata: { type: "email", subject: title(), from: `person${i % 400}@example.test`, isUnread: i % 5 === 0, labels: ["INBOX"] }, content: `${sentence(20)}\n\n${sentence(40)}\n\n${sentence(30)}` })],
  [0.10, (i) => ({ path: `vault/meetings/2026-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}/${title()} ${i}`, tags: ["meeting"], metadata: { type: "meeting", title: title(), date: `2026-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}` }, content: `<h2>Agenda</h2>${body(2)}<h2>Meeting Notes</h2>${body(3)}` })],
  [0.10, (i) => ({ path: `vault/people/${title()} ${i}`, tags: ["person"], metadata: { type: "person", name: title(), email: `person${i}@example.test` }, content: body(1) })],
  [0.08, (i) => ({ path: `vault/tasks/clickup/${title()} ${i}`, tags: ["task", "clickup"], metadata: { status: ["todo", "doing", "done"][i % 3], priority: ["none", "low", "high"][i % 3], due: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}` }, content: body(1) })],
  [0.20, (i) => {
    const depth = 1 + (i % 4);
    const dirs = Array.from({ length: depth }, (_, d) => `${["Projects", "Areas", "Library", "Journal", "Research"][(i >> d) % 5]}${d ? ` ${(i >> (d + 2)) % 12}` : ""}`);
    return { path: `${dirs.join("/")}/${title()} ${i}`, tags: [["note"], ["writing"], ["research"], ["project"], []][i % 5]!, metadata: { type: "document", ...(i % 9 === 0 ? { icon: "📄" } : {}) }, content: `<h2>${title()}</h2>${body(3 + (i % 4))}` };
  }],
];
let idx = 0;
for (const [share, make] of plan) {
  const count = Math.round(N * share);
  for (let k = 0; k < count; k++, idx++) put({ id: `n${idx.toString(36).padStart(5, "0")}`, ...make(idx) });
}

// 50 KB prose page (NP-PF-02).
let fifty = "<h1>Fifty kilobyte page</h1>";
while (Buffer.byteLength(fifty) < 50_000) fifty += `<h2>${title()}</h2>${body(4)}<ul><li><p>${sentence(12)}</p></li><li><p>${sentence(12)}</p></li></ul>`;
put({ id: "perf-50k", path: "Perf/Fifty kilobyte page", tags: ["note"], metadata: { type: "document" }, content: fifty });
// A second 50 KB page so "uncached" opens have a body the browser has never seen.
// One per run of PF-02's "uncached" loop: 26 names so the row's method (PERF_RUNS=20) has a never-read page for every sample.
const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Xray", "Yankee", "Zulu"];
for (const name of NAMES) put({ id: `perf-50k-${name.toLowerCase()}`, path: `Perf/Uncached/${name} page`, tags: ["note"], metadata: { type: "document" }, content: fifty.replace("Fifty kilobyte page", `Uncached ${name} page`) });

// 10,000 words in 200+ blocks, with every newer block kind (NP-PF-03).
const special = [
  `<div data-type="toc"></div>`,
  `<div data-type="callout" data-emoji="💡"><p>${sentence(30)}</p></div>`,
  `<details data-type="toggle"><summary>${sentence(6)}</summary><p>${sentence(40)}</p></details>`,
  `<div data-type="columns"><div data-type="column"><p>${sentence(30)}</p></div><div data-type="column"><p>${sentence(30)}</p></div></div>`,
  `<table><tbody><tr><th><p>Item</p></th><th><p>Owner</p></th><th><p>State</p></th></tr>${Array.from({ length: 6 }, () => `<tr><td><p>${words(3)}</p></td><td><p>${words(2)}</p></td><td><p>${words(1)}</p></td></tr>`).join("")}</tbody></table>`,
  `<div data-type="attachment" data-kind="file" data-src="https://files.example.test/report.zip" data-name="report.zip" data-size="20481" data-mime="application/zip"><a href="https://files.example.test/report.zip">report.zip</a></div>`,
  `<div data-type="embed" data-url="https://example.test/not-a-provider"><a href="https://example.test/not-a-provider">Embed</a></div>`,
  `<div data-type="bookmark" data-url="https://example.test/article" data-title="An article" data-description="${sentence(10)}" data-site="Example"><a href="https://example.test/article">An article</a></div>`,
  `<div data-prism-database="perf-db" data-view="table"></div>`,
  `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>${sentence(8)}</p></div></li><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>${sentence(8)}</p></div></li></ul>`,
  `<pre><code class="language-ts">const total = rows.reduce((a, r) =&gt; a + r.points, 0);\nexport default total;</code></pre>`,
  `<blockquote><p>${sentence(25)}</p></blockquote>`,
];
const blocks: string[] = ["<h1>Ten thousand words</h1>"];
let wordCount = 0;
for (let b = 0; wordCount < 10_000 || blocks.length < 205; b++) {
  if (b % 16 === 15) blocks.push(special[Math.floor(b / 16) % special.length]!);
  else if (b % 10 === 0) blocks.push(`<h2>${title()} ${b}</h2>`);
  else { const n = 50 + Math.floor(rnd() * 20); wordCount += n; blocks.push(`<p>${sentence(n)}</p>`); }
}
put({ id: "perf-10kw", path: "Perf/Ten thousand words", tags: ["note"], metadata: { type: "document" }, content: blocks.join("") });
put({ id: "perf-blank", path: "Perf/Blank", tags: ["note"], metadata: { type: "document" }, content: "" });

// 5,000-row database (NP-PF-06).
const STATUS = ["Backlog", "Next", "Doing", "Review", "Done"];
for (let r = 0; r < ROWS; r++) {
  put({ id: `row${r.toString(36).padStart(4, "0")}`, path: `Perf/Rows/${title()} ${r}`, tags: ["perf-row"], content: r % 50 === 0 ? body(1) : "", metadata: { status: STATUS[r % 5], points: r % 13, due: `2026-${String(1 + (r % 12)).padStart(2, "0")}-${String(1 + (r % 28)).padStart(2, "0")}`, owner: `Person ${r % 37}`, done: r % 5 === 4 } });
}
put({ id: "perf-db", path: "Perf/Row database", tags: [], content: "", metadata: { prism_type: "database", title: "Row database", prism_database: { version: 1, source: { tags: ["perf-row"] }, views: [{ id: "table", name: "All rows", type: "table", visible: ["status", "points", "due", "owner", "done"] }, { id: "board", name: "By status", type: "board", groupBy: "status" }] } } });

const SCHEMAS = [
  { name: "perf-row", count: ROWS, description: "Performance fixture rows", fields: { status: { type: "string", enum: STATUS }, points: { type: "number" }, due: { type: "string" }, owner: { type: "string" }, done: { type: "boolean" } } },
  { name: "task", count: 0, description: "Tasks", fields: { status: { type: "string", enum: ["todo", "doing", "done"] }, priority: { type: "string", enum: ["none", "low", "high"] }, due: { type: "string" } } },
];
const tagCounts = () => {
  const m = new Map<string, number>();
  for (const n of fv.notes.values()) for (const t of n.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
};

// ── a vault-shaped list + the few routes the owner passthrough reaches ───────
let calls: Array<{ key: string; ms: number; bytes: number }> = [];
const inner = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const m = url.pathname.match(/^\/vault\/default\/api(\/.*)$/);
  if (!m) return inner(input, init);
  const sub = m[1]!;
  const method = (init?.method ?? "GET").toUpperCase();
  const t0 = performance.now();
  const done = (res: Response, bytes = 0) => { calls.push({ key: `${method} ${sub.replace(/\/notes\/[^/]+/, "/notes/:id")}${method === "GET" && sub === "/notes" ? (url.searchParams.get("include_content") === "false" ? " (lean)" : url.searchParams.has("search") ? " (search)" : " (WITH BODIES)") : ""}`, ms: performance.now() - t0, bytes }); return res; };
  const json = (v: unknown) => { const s = JSON.stringify(v); return done(new Response(s, { headers: { "content-type": "application/json" } }), s.length); };
  if (method === "GET" && sub === "/tags") {
    const counts = tagCounts();
    const known = new Map(SCHEMAS.map((s) => [s.name, s]));
    return json([...counts].map(([name, count]) => ({ name, count, description: known.get(name)?.description ?? null, fields: known.get(name)?.fields ?? {} })));
  }
  if (method === "GET" && sub === "/graph") return json({ nodes: [], edges: [] });
  if (method === "GET" && (sub === "/vault" || sub === "/vault/info" || sub === "/stats" || sub === "/vault/stats")) return json({ name: "Perf vault", description: "", stats: { totalNotes: fv.notes.size, totalTags: tagCounts().size, totalLinks: 0 }, totalNotes: fv.notes.size, totalTags: tagCounts().size, totalLinks: 0 });
  if (method === "GET" && sub === "/notes") {
    const q = url.searchParams;
    const tags = q.getAll("tag");
    const prefix = q.get("path_prefix")?.toLowerCase();
    const exact = q.get("path");
    const search = q.get("search")?.toLowerCase();
    let list = [...fv.notes.values()];
    if (tags.length) list = list.filter((n) => tags.every((t) => (n.tags ?? []).includes(t)));
    if (prefix) list = list.filter((n) => !!n.path && n.path.toLowerCase().startsWith(prefix));
    if (exact) list = list.filter((n) => n.path === exact);
    if (search) { const terms = search.split(/\s+/).filter(Boolean); list = list.filter((n) => { const hay = `${n.path ?? ""}\n${n.content}`.toLowerCase(); return terms.every((t) => hay.includes(t)); }); }
    const dir = q.get("sort") === "asc" ? 1 : -1;
    list.sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? -dir : (a.updatedAt ?? "") > (b.updatedAt ?? "") ? dir : 0));
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 100);
    list = list.slice(offset, offset + limit);
    const lean = q.get("include_content") === "false";
    const only = q.get("include_metadata")?.split(",").filter(Boolean);
    return json(list.map((n) => ({ ...n, ...(lean ? { content: undefined } : {}), ...(only && n.metadata ? { metadata: Object.fromEntries(only.filter((k) => k in n.metadata!).map((k) => [k, n.metadata![k]])) } : {}) })));
  }
  const res = await inner(input, init);
  return done(res);
}) as typeof fetch;

setUserProfile(OWNER, { name: "Olive Owner" });
const app = createApp();
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  let bytes = 0;
  for (const n of fv.notes.values()) bytes += n.content.length;
  process.stdout.write(JSON.stringify({ port: info.port, session: makeSession(OWNER), notes: fv.notes.size, bytes, ids: { page50k: "perf-50k", page10kw: "perf-10kw", blank: "perf-blank", db: "perf-db", uncached: NAMES }, words10k: wordCount, blocks10k: blocks.length }) + "\n");
});
attachCollab(server as unknown as Server);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    try {
      const cmd = JSON.parse(line) as { op: string; id?: string };
      if (cmd.op === "reset") { calls = []; fv.calls.length = 0; process.stdout.write(JSON.stringify({ op: "reset" }) + "\n"); }
      else if (cmd.op === "calls") {
        const by: Record<string, { n: number; ms: number; bytes: number }> = {};
        for (const c of calls) { const e = (by[c.key] ??= { n: 0, ms: 0, bytes: 0 }); e.n++; e.ms += c.ms; e.bytes += c.bytes; }
        process.stdout.write(JSON.stringify({ op: "calls", total: calls.length, by }) + "\n");
      } else if (cmd.op === "note") process.stdout.write(JSON.stringify({ op: "note", note: fv.notes.get(cmd.id ?? "") ?? null }) + "\n");
    } catch { process.stdout.write(JSON.stringify({ op: "error" }) + "\n"); }
  }
});
process.stdin.on("end", () => { server.close(); process.exit(0); });
