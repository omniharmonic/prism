/**
 * Import/export — independent-review findings (H1, H2, M1–M5, L1–L8), each pinned
 * by a test that fails on the code before the fix. Route-level, against the fake
 * vault; only symbols that existed before the fixes are imported, so the file
 * runs (and fails test by test) on the earlier code too.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetAttachmentsForTests, usedBytes } from "../src/attachments";
import { resetJobsForTests } from "../src/transfer/jobs";
import { setMembership, addGrant, db } from "../src/db";
import { parseFrontMatter, readZipDirectory, readZipEntry, zipSync } from "@prism/core/import-export";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const login = (email: string) => sessionCookie(makeSession(email));
const deflate = (d: Uint8Array) => deflateRawSync(d);
const JSON_H = { "content-type": "application/json" };

let fv: FakeVault;
const ENV = ["EXPORT_PACE_MS", "IMPORT_PACE_MS", "IMPORT_WRITES_PER_HOUR", "IMPORT_PREVIEWS_PER_HOUR", "EXPORT_STARTS_PER_HOUR", "EXPORT_CONVERT_TIMEOUT_MS", "IMPORT_PLAN_TIMEOUT_MS", "IMPORT_MAX_TOTAL_BYTES", "IMPORT_MAX_VERIFY", "IMPORT_MAX_HTML_FILE_BYTES"];
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.EXPORT_PACE_MS = "0";
  process.env.IMPORT_PACE_MS = "0";
  process.env.IMPORT_WRITES_PER_HOUR = "100000";
  process.env.IMPORT_PREVIEWS_PER_HOUR = "100000";
  process.env.EXPORT_STARTS_PER_HOUR = "100000";
  resetDb();
  resetTreeForTests();
  resetAttachmentsForTests();
  resetJobsForTests();
  fv = installFakeVault();
});
afterEach(() => {
  resetJobsForTests();
  fv.restore();
});

// Stop the worker threads when the file is done (looked up dynamically: they do not exist before the fix).
after(async () => {
  for (const [mod, fn] of [["../src/transfer/import", "stopImportWorker"], ["../src/transfer/export", "stopExportWorker"]] as const) {
    const m = (await import(mod)) as Record<string, unknown>;
    if (typeof m[fn] === "function") await (m[fn] as () => Promise<void>)();
  }
});

/** The longest gap between two ticks of a 10 ms timer while `work` runs: how long the event loop was held. */
async function maxLag<T>(work: () => Promise<T>): Promise<{ lag: number; value: T }> {
  let last = Date.now();
  let lag = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    lag = Math.max(lag, now - last);
    last = now;
  }, 10);
  try {
    const value = await work();
    lag = Math.max(lag, Date.now() - last);
    return { lag, value };
  } finally {
    clearInterval(timer);
  }
}
/** Generous on purpose (shared CI hosts): the blocking these replace was 2–30 SECONDS. */
const LAG_LIMIT_MS = 800;

async function exportZip(body: unknown, cookie = login(OWNER)) {
  const r = await api.request("/export", { method: "POST", headers: { ...JSON_H, cookie }, body: JSON.stringify(body) });
  assert.equal(r.status, 202, await r.clone().text());
  const { jobId } = (await r.json()) as { jobId: string };
  let job: Record<string, any> = {};
  for (let i = 0; i < 3000; i++) {
    job = (await (await api.request(`/export/${jobId}`, { headers: { cookie } })).json()) as Record<string, any>;
    if (job.state !== "queued" && job.state !== "running") break;
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.equal(job.state, "done", JSON.stringify(job));
  const d = await api.request(`/export/${jobId}/download`, { headers: { cookie } });
  assert.equal(d.status, 200);
  const buf = new Uint8Array(await d.arrayBuffer());
  const files = new Map<string, string>();
  for (const e of readZipDirectory(buf, { maxEntries: 1000, maxEntryBytes: 50_000_000, maxTotalBytes: 100_000_000 })) files.set(e.name, Buffer.from(readZipEntry(buf, e, (x, max) => inflateRawSync(x, { maxOutputLength: Math.max(max, 1) }))).toString("utf8"));
  return { files, job, jobId };
}

interface Opts { dryRun?: boolean; parent?: string; name?: string; cookie?: string; type?: string; query?: Record<string, string> }
function send(body: Uint8Array | string, o: Opts = {}) {
  const q = new URLSearchParams(o.query ?? {});
  if (o.dryRun === false) q.set("dryRun", "0");
  q.set("parent", o.parent ?? "vault/Imports/N");
  q.set("name", o.name ?? "Export.zip");
  return api.request(`/import?${q}`, { method: "POST", headers: { "content-type": o.type ?? "application/zip", "x-prism-import": "1", cookie: o.cookie ?? login(OWNER) }, body: body as BodyInit });
}
async function run(body: Uint8Array | string, o: Opts = {}) {
  const r = await send(body, { ...o, dryRun: false });
  assert.equal(r.status, 202, await r.clone().text());
  const { jobId } = (await r.json()) as { jobId: string };
  for (let i = 0; i < 2000; i++) {
    const j = (await (await api.request(`/import/${jobId}`, { headers: { cookie: o.cookie ?? login(OWNER) } })).json()) as Record<string, any>;
    if (j.state !== "queued" && j.state !== "running") return j;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("import did not finish");
}
const byPath = (p: string) => [...fv.notes.values()].find((n) => n.path === p);

// ── H1 ───────────────────────────────────────────────────────────────────────

test("H1: a viewer's pathological page cannot hold the event loop during an export (Markdown parser + HTML converter)", async () => {
  process.env.EXPORT_CONVERT_TIMEOUT_MS = "400";
  // Quadratic for the Markdown parser (emphasis runs)…
  fv.put({ id: "md", path: "vault/Bad/Emphasis", content: "*a ".repeat(7000), tags: ["page"], metadata: {} });
  // …and deep nesting for the DOM-based HTML→Markdown converter.
  fv.put({ id: "deep", path: "vault/Bad/Nested", content: `${"<div>".repeat(24_000)}deep text${"</div>".repeat(24_000)}`, tags: ["page"], metadata: {} });
  fv.put({ id: "ok", path: "vault/Bad/Fine", content: "<p>fine <strong>page</strong></p>", tags: ["page"], metadata: {} });
  fv.put({ id: "root", path: "vault/Bad", content: "<p>root</p>", tags: ["page"], metadata: {} });
  const html = await maxLag(() => exportZip({ scope: "page", noteId: "root", format: "html" }));
  assert.ok(html.lag < LAG_LIMIT_MS, `html export held the event loop for ${html.lag} ms`);
  const md = await maxLag(() => exportZip({ scope: "page", noteId: "root", format: "markdown" }));
  assert.ok(md.lag < LAG_LIMIT_MS, `markdown export held the event loop for ${md.lag} ms`);
  // Nothing is lost: the pages that could not be converted are there as plain text, the rest converted.
  assert.match(md.value.files.get("Bad/Nested.md")!, /deep text\n$/);
  assert.match(md.value.files.get("Bad/Fine.md")!, /fine \*\*page\*\*\n$/);
  assert.match(html.value.files.get("Bad/Emphasis.html")!, /<pre>\*a \*a /);
  assert.match(html.value.files.get("Bad/Fine.html")!, /<p>fine <strong>page<\/strong><\/p>/);
  assert.deepEqual(JSON.parse(md.value.files.get("_export.json")!).plainText, ["vault/Bad/Nested"]);
  assert.deepEqual(JSON.parse(html.value.files.get("_export.json")!).plainText.sort(), ["vault/Bad/Emphasis", "vault/Bad/Nested"]);
});

// ── H2 ───────────────────────────────────────────────────────────────────────

test("H2: a heavy import preview (unzip + hash + HTML conversion) leaves the event loop responsive", async () => {
  const para = "<p>Some ordinary paragraph of text with a <a href=\"https://example.com\">link</a>.</p>\n";
  const page = `<html><body>${para.repeat(Math.floor(300_000 / para.length))}</body></html>`;
  const files: Array<{ name: string; data: string | Uint8Array }> = [];
  for (let i = 0; i < 4; i++) files.push({ name: `Page ${i}.html`, data: page });
  // Large referenced files: inflate + CRC + SHA-256 of ~80 MB.
  const blob = new Uint8Array(20 * 1024 * 1024);
  let links = "";
  for (let i = 0; i < 4; i++) {
    files.push({ name: `files/blob${i}.bin`, data: blob });
    links += `[file ${i}](files/blob${i}.bin)\n`;
  }
  files.push({ name: "Index.md", data: links });
  const zip = zipSync(files, { deflate });
  const { lag, value: res } = await maxLag(async () => send(zip));
  assert.equal(res.status, 200, await res.clone().text());
  const preview = (await res.json()) as Record<string, any>;
  assert.equal(preview.summary.pages, 5);
  assert.equal(preview.summary.attachments, 4);
  assert.ok(lag < LAG_LIMIT_MS, `the preview held the event loop for ${lag} ms`);
});

test("H2: planning has a wall-clock budget and HTML has size and nesting caps", async () => {
  const para = "<p>Some ordinary paragraph of text.</p>\n";
  const big = `<body>${para.repeat(Math.floor(700_000 / para.length))}</body>`;
  const nested = `<body>${"<div>".repeat(5000)}x${"</div>".repeat(5000)}</body>`;
  const zip = zipSync([{ name: "Big.html", data: big }, { name: "Nested.html", data: nested }, { name: "Ok.html", data: "<body><p>ok</p></body>" }], { deflate });
  const preview = (await (await send(zip)).json()) as Record<string, any>;
  assert.deepEqual(preview.items.map((i: any) => i.path), ["vault/Imports/N/Ok"]);
  assert.deepEqual(preview.problems.map((p: any) => [p.entry, p.reason]).sort(), [["Big.html", "skipped: the HTML is too large or too complex"], ["Nested.html", "skipped: the HTML is too large or too complex"]]);
  // A plan that overruns its budget is killed and refused; the server stays up and answers the next request.
  process.env.IMPORT_PLAN_TIMEOUT_MS = "150";
  const heavy = zipSync(Array.from({ length: 16 }, (_, i) => ({ name: `P${i}.html`, data: `<body>${para.repeat(Math.floor(480_000 / para.length))}</body>` })), { deflate });
  const { lag, value: r } = await maxLag(async () => send(heavy));
  assert.equal(r.status, 413);
  assert.equal(((await r.json()) as any).error, "too_complex");
  assert.ok(lag < LAG_LIMIT_MS, `held the event loop for ${lag} ms`);
  delete process.env.IMPORT_PLAN_TIMEOUT_MS;
  assert.equal((await send(zipSync([{ name: "A.md", data: "a" }]))).status, 200);
});

// ── M1 ───────────────────────────────────────────────────────────────────────

test("M1: re-importing never stores an attachment twice, and a file that can never be attached does not make every run an update", async () => {
  const zip = (text: string) => zipSync([{ name: "P.md", data: `${text}\n\n![ok](ok.png) ![vector](a.svg)` }, { name: "ok.png", data: PNG }, { name: "a.svg", data: SVG }]);
  const first = await run(zip("one"));
  assert.deepEqual([first.created, first.attachments], [1, 1]);
  const note = byPath("vault/Imports/N/P")!;
  const after1 = { storage: fv.storage.size, used: usedBytes("primary", note.id), rows: (db.prepare("SELECT COUNT(*) AS n FROM prism_attachments").get() as { n: number }).n };
  assert.deepEqual(after1, { storage: 1, used: PNG.length, rows: 1 });
  for (let i = 0; i < 2; i++) {
    const again = await run(zip("one"));
    assert.deepEqual([again.created, again.updated, again.unchanged, again.attachments], [0, 0, 1, 0], `run ${i + 2}`);
  }
  // The source changed: the page is updated, the unchanged image is REUSED.
  const changed = await run(zip("two"));
  assert.deepEqual([changed.updated, changed.attachments], [1, 0]);
  assert.match(note.content, /^two\n\n!\[ok\]\(\/api\/attachments\/a_[\w-]{22}\) !\[vector\]\(a\.svg\)$/);
  assert.deepEqual({ storage: fv.storage.size, used: usedBytes("primary", note.id), rows: (db.prepare("SELECT COUNT(*) AS n FROM prism_attachments").get() as { n: number }).n }, after1);
});

// ── M2 ───────────────────────────────────────────────────────────────────────

test("M2: raw notes never leave as runnable file types; spreadsheet cells are formula-guarded", async () => {
  const code = (id: string, path: string, content = "x") => fv.put({ id, path, content, tags: [], metadata: { prism_type: "code" } });
  fv.put({ id: "root", path: "vault/Raw", content: "<p>r</p>", tags: ["page"], metadata: {} });
  code("h", "vault/Raw/payload.html", "<script>alert(1)</script>");
  code("b", "vault/Raw/run.bat", "calc.exe");
  code("j", "vault/Raw/app.js");
  code("s", "vault/Raw/pic.svg");
  code("c", "vault/Raw/tool.command");
  code("n", "vault/Raw/noext");
  code("p", "vault/Raw/ok.py", "print(1)");
  fv.put({ id: "sheet", path: "vault/Raw/Budget.csv", content: 'name,amount\n"=HYPERLINK(""http://evil"",""x"")",-5\n+1+1,@SUM(A1)\nplain,3.5\n', tags: [], metadata: { prism_type: "spreadsheet" } });
  const { files } = await exportZip({ scope: "page", noteId: "root", format: "markdown" });
  assert.deepEqual([...files.keys()].sort(), ["Raw.md", "Raw/Budget.csv", "Raw/app.js.txt", "Raw/noext.txt", "Raw/ok.py", "Raw/payload.html.txt", "Raw/pic.svg.txt", "Raw/run.bat.txt", "Raw/tool.command.txt", "_export.json"]);
  assert.equal(files.get("Raw/Budget.csv"), 'name,amount\r\n"\'=HYPERLINK(""http://evil"",""x"")",-5\r\n\'+1+1,\'@SUM(A1)\r\nplain,3.5\r\n');
});

// ── M3 ───────────────────────────────────────────────────────────────────────

test("M3: an HTML export is sanitised and its CSP also forbids forms and <base>", async () => {
  fv.put({
    id: "root",
    path: "vault/Page",
    tags: ["page"],
    metadata: {},
    content:
      '<p onclick="steal()">Hi <a href="https://ok.example/a">ok</a> <a href="javascript:alert(1)">js</a> <a href="jav&#x61;script:alert(2)">js2</a> <a href=" j\tavascript:alert(3)">js3</a></p>' +
      '<form action="https://evil.example"><input name="q"><button>go</button></form><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">' +
      '<img src="x.png" onerror="alert(1)"><img src="data:text/html,<script>1</script>"><svg><script>alert(1)</script></svg><iframe src="https://evil.example"></iframe>' +
      '<style>*{display:none}</style><link rel="stylesheet" href="https://evil.example/x.css"><script>alert(1)</script><object data="x"></object>',
  });
  const { files } = await exportZip({ scope: "page", noteId: "root", format: "html" });
  const html = files.get("Page.html")!;
  assert.match(html, /form-action 'none'; base-uri 'none'/);
  const body = html.slice(html.indexOf("<body>"));
  for (const bad of ["onclick", "steal", "<form", "<input", "<button", "http-equiv", "<base", "javascript", "alert", "onerror", "<svg", "<iframe", "<style", "display:none", "<link", "<script", "<object", "evil.example", "data:text"]) assert.equal(body.includes(bad), false, bad);
  assert.match(body, /<p>Hi <a href="https:\/\/ok\.example\/a">ok<\/a> <a>js<\/a> <a>js2<\/a> <a>js3<\/a><\/p>go<img src="x\.png"><img>/);
});

// ── M4 ───────────────────────────────────────────────────────────────────────

test("M4: importing under a shared page says who will see it and needs an explicit yes (or goes in private)", async () => {
  fv.put({ id: "shared", path: "vault/Team", content: "<p>t</p>", tags: ["page"], metadata: {} });
  addGrant({ vault_id: "primary", subject_type: "user", subject: MEMBER, resource_type: "page", resource: "shared", level: "view", created_by: OWNER } as never);
  addGrant({ vault_id: "primary", subject_type: "user", subject: "other@test.local", resource_type: "page", resource: "shared", level: "edit", created_by: OWNER } as never);
  const zip = zipSync([{ name: "A.md", data: "secret plans" }]);
  const preview = (await (await send(zip, { parent: "vault/Team/Inbox" })).json()) as Record<string, any>;
  assert.deepEqual(preview.audience, { sharedPage: true, people: 2, links: 0, workspace: true });
  // Without the confirmation nothing is written.
  const refused = await send(zip, { parent: "vault/Team/Inbox", dryRun: false });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as any).error, "confirm_shared");
  assert.equal(byPath("vault/Team/Inbox/A"), undefined);
  // Private to the importer: allowed without the confirmation, and the shared page's people cannot open it.
  const priv = await run(zip, { parent: "vault/Team/Inbox", query: { private: "1" } });
  assert.equal(priv.created, 1);
  const a = byPath("vault/Team/Inbox/A")!;
  assert.deepEqual([a.metadata!.prism_visibility, a.metadata!.prism_creator], ["private", OWNER]);
  assert.equal((await api.request(`/notes/${a.id}`, { headers: { cookie: login(MEMBER) } })).status, 404);
  // With the explicit confirmation it is imported, shared.
  const ok = await run(zipSync([{ name: "B.md", data: "for the team" }]), { parent: "vault/Team/Inbox", query: { confirmShared: "1" } });
  assert.equal(ok.created, 1);
  assert.equal(byPath("vault/Team/Inbox/B")!.metadata!.prism_visibility, undefined);
  assert.equal((await api.request(`/notes/${byPath("vault/Team/Inbox/B")!.id}`, { headers: { cookie: login(MEMBER) } })).status, 200);
  // An unshared destination needs no confirmation.
  const plain = (await (await send(zip, { parent: "vault/Solo" })).json()) as Record<string, any>;
  assert.deepEqual(plain.audience, { sharedPage: false, people: 0, links: 0, workspace: true });
  assert.equal((await run(zip, { parent: "vault/Solo" })).created, 1);
});

// ── M5 ───────────────────────────────────────────────────────────────────────

test("M5: pages named like the archive's own files do not break an export", async () => {
  fv.put({ id: "e", path: "_export.json", content: "{}", tags: [], metadata: { prism_type: "code" } });
  fv.put({ id: "a", path: "_attachments/notes", content: "<p>mine</p>", tags: ["page"], metadata: {} });
  fv.put({ id: "ok", path: "vault/Ok", content: "<p>ok</p>", tags: ["page"], metadata: {} });
  const { files, job } = await exportZip({ scope: "vault", format: "markdown" });
  assert.equal(job.state, "done");
  assert.deepEqual([...files.keys()].sort(), ["__attachments/notes.md", "__export.json", "_export.json", "vault/Ok.md"]);
  assert.equal(JSON.parse(files.get("_export.json")!).pages, 3);
  assert.equal(files.get("__export.json"), "{}");
});

// ── lows ─────────────────────────────────────────────────────────────────────

test("L1: an unpacked wrapper part counts against the unpacked budget, and no upload is read while an import runs", async () => {
  const inner = zipSync([{ name: "A.md", data: "x".repeat(1200) }]); // stored: ≈1.3 KB
  const wrapper = zipSync([{ name: "Export-Part-1.zip", data: inner }]);
  process.env.IMPORT_MAX_TOTAL_BYTES = "2048";
  assert.equal((await send(wrapper)).status, 413, "1.3 KB part + 1.2 KB inside > 2 KB");
  delete process.env.IMPORT_MAX_TOTAL_BYTES;
  assert.equal((await send(wrapper)).status, 200);
  process.env.IMPORT_PACE_MS = "60";
  const started = await send(zipSync(Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.md`, data: "x" }))), { dryRun: false });
  assert.equal(started.status, 202);
  assert.equal((await send(wrapper)).status, 409, "a preview is not read while a job holds an upload");
});

test("L3: an export is not handed over once the account has lost the access it was built with", async () => {
  fv.put({ id: "root", path: "vault/Proj", content: "<p>body</p>", tags: ["proj"], metadata: {} });
  grantUser(MEMBER, "tag", "proj", "view");
  const cookie = login(MEMBER);
  const r = await api.request("/export", { method: "POST", headers: { ...JSON_H, cookie }, body: JSON.stringify({ scope: "page", noteId: "root", format: "markdown" }) });
  const { jobId } = (await r.json()) as { jobId: string };
  for (let i = 0; i < 2000; i++) {
    const j = (await (await api.request(`/export/${jobId}`, { headers: { cookie } })).json()) as { state: string };
    if (j.state === "done") break;
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.equal((await api.request(`/export/${jobId}/download`, { headers: { cookie } })).status, 200);
  db.prepare("DELETE FROM grants WHERE subject = ?").run(MEMBER);
  assert.equal((await api.request(`/export/${jobId}/download`, { headers: { cookie } })).status, 404);
  // An admin's workspace export, after the role is gone.
  setMembership("primary", "admin@test.local", "admin", OWNER);
  const admin = login("admin@test.local");
  const v = await exportZip({ scope: "vault", format: "markdown" }, admin);
  setMembership("primary", "admin@test.local", "member", OWNER);
  assert.equal((await api.request(`/export/${v.jobId}/download`, { headers: { cookie: admin } })).status, 404);
});

test("L4 + L5: imported text cannot become markup, script-ish links become text, YAML flow lists are tags", async () => {
  const html = '<body><p>&lt;script&gt;alert(1)&lt;/script&gt; and &lt;img src=x onerror=alert(1)&gt;</p><p><a href="javascript:alert(1)">click</a> <a href="https://ok.example/x">fine</a> <a href="vbscript:x">vb</a></p></body>';
  await run(html, { name: "H.html", type: "text/html", parent: "vault/Imports" });
  const h = byPath("vault/Imports/H")!.content;
  assert.equal(/(^|[^\\])<(script|img)/.test(h), false, h);
  assert.ok(h.includes("\\<script>alert(1)\\</script>"), h);
  assert.equal(/\]\((javascript|vbscript):/i.test(h), false, h);
  assert.ok(h.includes("click") && h.includes("[fine](https://ok.example/x)") && h.includes("vb"), h);
  const md = "---\ntags: [alpha, beta, 'two words']\n---\n\n[a](javascript:alert(1)) ![i](data:image/svg+xml;base64,AAAA) [m](mailto:a@b.co) [s](https://s.example) [r](#here) [f](file:///etc/passwd)";
  await run(md, { name: "M.md", type: "text/markdown", parent: "vault/Imports" });
  const m = byPath("vault/Imports/M")!;
  assert.deepEqual(m.tags, ["alpha", "beta", "two words"]);
  assert.equal(m.content, "a i [m](mailto:a@b.co) [s](https://s.example) [r](#here) f");
});

test("L7: verifying changed pages is bounded; beyond the bound they are conflicts, never blind overwrites", async () => {
  const zip = (t: string) => zipSync([{ name: "A.md", data: `a ${t}` }, { name: "B.md", data: `b ${t}` }, { name: "C.md", data: `c ${t}` }]);
  await run(zip("1"));
  process.env.IMPORT_MAX_VERIFY = "2";
  const preview = (await (await send(zip("2"))).json()) as Record<string, any>;
  assert.deepEqual(preview.items.map((i: any) => i.action), ["update", "update", "conflict"]);
  assert.match(preview.items[2].reason, /too many changed pages/);
  const gets = fv.calls.filter((c) => c.method === "GET" && /\/notes\/new-/.test(c.path)).length;
  assert.equal(gets, 2, "one read per verified page, none beyond the bound");
});

test("L8: a member cannot write the importer's stamp onto a note (so an admin's import can never be steered onto it)", async () => {
  fv.put({ id: "mine", path: "vault/Imports/N/A", content: "member's own page", tags: ["proj"], metadata: {} });
  grantUser(MEMBER, "tag", "proj", "edit");
  const cookie = login(MEMBER);
  const note = fv.notes.get("mine")!;
  const forged = { v: 1, src: "0".repeat(24), hash: "x", body: "y" };
  const p = await api.request("/notes/mine", { method: "PATCH", headers: { ...JSON_H, cookie }, body: JSON.stringify({ metadata: { prism_import: forged, colour: "red" }, if_updated_at: note.updatedAt }) });
  assert.ok(p.status < 300, await p.clone().text());
  assert.equal(note.metadata!.colour, "red");
  assert.equal(note.metadata!.prism_import, undefined);
  const c = await api.request("/notes", { method: "POST", headers: { ...JSON_H, cookie }, body: JSON.stringify({ content: "x", path: "vault/Imports/N/B", tags: ["proj"], metadata: { prism_import: forged } }) });
  if (c.status < 300) assert.equal(byPath("vault/Imports/N/B")!.metadata?.prism_import, undefined);
  const props = await api.request("/properties/mine", { method: "POST", headers: { ...JSON_H, cookie }, body: JSON.stringify({ set: { prism_import: forged } }) });
  assert.ok(props.status >= 400);
  // The admin's import then treats the page as someone's own: a conflict, untouched.
  const job = await run(zipSync([{ name: "A.md", data: "imported" }]));
  assert.deepEqual([job.conflicts, job.created], [1, 0]);
  assert.equal(note.content, "member's own page");
});
