/**
 * Export routes + engine (routes/export.ts, transfer/export.ts) against the fake
 * vault: what a ZIP contains for whom, and every way the routes refuse.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import { stopImportWorker } from "../src/transfer/import";
import { stopExportWorker } from "../src/transfer/export";
after(async () => { await stopImportWorker(); await stopExportWorker(); });
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { existsSync } from "node:fs";
import { api } from "../src/routes/api";
import { INPROCESS_ACTOR } from "../src/auth/actor";
import { issueDeviceToken } from "../src/auth/device";
import { resetTreeForTests } from "../src/tree";
import { resetAttachmentsForTests } from "../src/attachments";
import { configureAttachments } from "../src/routes/attachments";
import { resetJobsForTests } from "../src/transfer/jobs";
import { parseFrontMatter, readZipDirectory, readZipEntry } from "@prism/core/import-export";
import { TRASH_TAG } from "@prism/core/pages";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const OTHER = "other@test.local";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const login = (email: string) => sessionCookie(makeSession(email));
const JSON_H = { "content-type": "application/json" };

let fv: FakeVault;
beforeEach(() => {
  process.env.EXPORT_PACE_MS = "0";
  resetDb();
  resetTreeForTests();
  resetAttachmentsForTests();
  resetJobsForTests();
  configureAttachments({ uploadsPerMinute: 100_000 });
  fv = installFakeVault();
  fv.put({ id: "root", path: "vault/Projects/Prism", content: "<h2>About</h2><p>The <strong>project</strong> page.</p>", tags: ["page", "proj"], metadata: { title: "Prism", status: "active", prism_creator: OWNER, prism_last_writer: "u_abc", prism_locked: true, gov_sig: "x", _hidden: 1 } });
  fv.put({ id: "plan", path: "vault/Projects/Prism/Plan", content: "The **plan** in Markdown.\n\n[[vault/Projects/Prism]]", tags: ["page", "proj"], metadata: {} });
  fv.put({ id: "week", path: "vault/Projects/Prism/Plan/Week 1", content: "<p>First week.</p>", tags: ["page", "proj"], metadata: {} });
  fv.put({ id: "secret", path: "vault/Projects/Prism/Secret", content: "<p>TOP SECRET</p>", tags: ["page"], metadata: { prism_creator: OTHER, prism_visibility: "private" } });
  fv.put({ id: "gone", path: "vault/Projects/Prism/Old", content: "<p>TRASHED BODY</p>", tags: ["page", "proj", TRASH_TAG], metadata: { prism_trashed_at: "2026-01-01T00:00:00Z" } });
  fv.put({ id: "hidden", path: "vault/Projects/Prism/Hidden", content: "<p>NOT SHARED</p>", tags: ["page"], metadata: {} });
  fv.put({ id: "sheet", path: "vault/Data/Budget.csv", content: "a,b\n1,2\n", tags: ["spreadsheet"], metadata: { prism_type: "spreadsheet" } });
  fv.put({ id: "elsewhere", path: "vault/Journal/Day", content: "<p>Journal.</p>", tags: ["page"], metadata: {} });
});
afterEach(() => {
  resetJobsForTests();
  fv.restore();
});

const post = (body: unknown, cookie = login(OWNER), headers: Record<string, string> = {}) =>
  api.request("/export", { method: "POST", headers: { ...JSON_H, cookie, ...headers }, body: JSON.stringify(body) });

async function waitDone(id: string, cookie: string): Promise<Record<string, any>> {
  for (let i = 0; i < 400; i++) {
    const r = await api.request(`/export/${id}`, { headers: { cookie } });
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, any>;
    if (j.state !== "queued" && j.state !== "running") return j;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("export did not finish");
}
async function exportZip(body: unknown, cookie = login(OWNER)) {
  const r = await post(body, cookie);
  assert.equal(r.status, 202, await r.clone().text());
  const { jobId } = (await r.json()) as { jobId: string };
  const job = await waitDone(jobId, cookie);
  assert.equal(job.state, "done", JSON.stringify(job));
  const d = await api.request(`/export/${jobId}/download`, { headers: { cookie } });
  assert.equal(d.status, 200);
  const buf = new Uint8Array(await d.arrayBuffer());
  const entries = readZipDirectory(buf, { maxEntries: 1000, maxEntryBytes: 50_000_000, maxTotalBytes: 100_000_000 });
  const files = new Map<string, string>();
  for (const e of entries) files.set(e.name, Buffer.from(readZipEntry(buf, e, (x, max) => inflateRawSync(x, { maxOutputLength: Math.max(max, 1) }))).toString("utf8"));
  return { job, files, res: d, jobId, raw: buf, entries };
}
async function uploadPng(noteId: string, cookie = login(OWNER)): Promise<string> {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(PNG)]), "Team photo (1).png");
  const r = await api.request(`/notes/${noteId}/attachments?kind=image`, { method: "POST", headers: { cookie, "x-prism-upload": "1" }, body: f });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as { id: string }).id;
}

test("a page with sub-pages exports as a Markdown ZIP: nesting, front matter, converted HTML, no hidden notes", async () => {
  const { files, job, res } = await exportZip({ scope: "page", noteId: "root", format: "markdown" });
  assert.deepEqual([...files.keys()].sort(), ["Prism.md", "Prism/Hidden.md", "Prism/Plan.md", "Prism/Plan/Week 1.md", "_export.json"]);
  assert.equal(job.fileName, "Prism.zip");
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition")!, /^attachment; filename="Prism.zip"/);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const root = parseFrontMatter(files.get("Prism.md")!);
  // Properties survive; identity + system keys never leave.
  assert.deepEqual(Object.keys(root.data).sort(), ["created", "status", "tags", "title", "updated"]);
  assert.deepEqual([root.data.title, root.data.status, root.data.tags], ["Prism", "active", ["page", "proj"]]);
  assert.equal(root.body, "# Prism\n\n## About\n\nThe **project** page.\n");
  assert.match(files.get("Prism/Plan.md")!, /# Plan\n\nThe \*\*plan\*\* in Markdown\.\n\n\[\[vault\/Projects\/Prism\]\]\n$/);
  const all = [...files.values()].join("\n");
  for (const leak of ["TOP SECRET", "TRASHED BODY", "Secret", "Old", OTHER, "u_abc", "prism_", "gov_sig", "Journal"]) assert.equal(all.includes(leak), false, leak);
  assert.deepEqual(JSON.parse(files.get("_export.json")!).skipped, []);
});

test("without sub-pages only the page itself; HTML format is a standalone file that cannot run script", async () => {
  fv.notes.get("root")!.content = "<p>Hi</p><script>alert(1)</script>";
  const { files } = await exportZip({ scope: "page", noteId: "root", format: "html", subpages: false });
  assert.deepEqual([...files.keys()].sort(), ["Prism.html", "_export.json"]);
  const html = files.get("Prism.html")!;
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  assert.match(html, /<h1>Prism<\/h1>\n<p>Hi<\/p>/);
  // Markdown pages are rendered for the HTML format.
  const md = await exportZip({ scope: "page", noteId: "plan", format: "html" });
  assert.match(md.files.get("Plan.html")!, /<strong>plan<\/strong>/);
});

test("images: included once, links rewritten to relative paths; another page's image only when that page is viewable", async () => {
  const own = await uploadPng("root");
  const foreign = await uploadPng("secret", login(OWNER)); // owner uploads into someone's private page? owner role floor does not reach it
  fv.notes.get("root")!.content = `<p><img src="/api/attachments/${own}"></p>`;
  fv.notes.get("week")!.content = `![again](/api/attachments/${own}) ![theirs](/api/attachments/${foreign}) ![bogus](/api/attachments/a_0000000000000000000000)`;
  const { files, job, entries } = await exportZip({ scope: "page", noteId: "root", format: "markdown" });
  const att = [...files.keys()].filter((n) => n.startsWith("_attachments/"));
  assert.equal(att.length, 1);
  assert.match(att[0]!, /^_attachments\/Team photo \(1\)-[A-Za-z0-9_-]{8}\.png$/);
  assert.equal(job.attachments, 1);
  assert.equal(entries.find((e) => e.name === att[0])!.size, PNG.length);
  const enc = att[0]!.split("/").map((s) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
  assert.ok(files.get("Prism.md")!.includes(`![](${enc})`), files.get("Prism.md"));
  const week = files.get("Prism/Plan/Week 1.md")!;
  assert.ok(week.includes(`![again](../../${enc})`), week);
  // Not viewable / unknown: the link is left untouched and nothing is added.
  assert.ok(week.includes(`![theirs](/api/attachments/${foreign})`));
  assert.ok(week.includes("![bogus](/api/attachments/a_0000000000000000000000)"));
  // attachments:false leaves every link alone.
  const bare = await exportZip({ scope: "page", noteId: "root", format: "markdown", attachments: false });
  assert.equal([...bare.files.keys()].some((n) => n.startsWith("_attachments/")), false);
});

test("a member exports only what they can view; a page they cannot view answers 404 like a missing one", async () => {
  grantUser(MEMBER, "tag", "proj", "view");
  const cookie = login(MEMBER);
  const { files } = await exportZip({ scope: "page", noteId: "root", format: "markdown" }, cookie);
  // "Hidden" lacks the shared tag: absent, uncounted, unmentioned.
  assert.deepEqual([...files.keys()].sort(), ["Prism.md", "Prism/Plan.md", "Prism/Plan/Week 1.md", "_export.json"]);
  assert.equal([...files.values()].join("\n").includes("NOT SHARED"), false);
  assert.deepEqual(JSON.parse(files.get("_export.json")!).skipped, []);
  for (const id of ["hidden", "secret", "gone", "nope", "vault/Projects/Prism", "Prism"]) {
    const r = await post({ scope: "page", noteId: id, format: "markdown" }, cookie);
    assert.equal(r.status, 404, id);
    assert.deepEqual(await r.json(), { error: "not_found" });
  }
  // The whole workspace is the owner's and admins' to export.
  assert.equal((await post({ scope: "vault", format: "markdown" }, cookie)).status, 403);
});

test("access lost between the listing and the read is honoured (the fresh note decides)", async () => {
  grantUser(MEMBER, "tag", "proj", "view");
  const cookie = login(MEMBER);
  // Warm the projection, then change the note behind it: the cached row still says "proj".
  assert.equal((await api.request("/tree", { headers: { cookie } })).status, 200);
  const plan = fv.notes.get("plan")!;
  plan.tags = ["page"];
  plan.content = "NO LONGER SHARED";
  const { files } = await exportZip({ scope: "page", noteId: "root", format: "markdown" }, cookie);
  assert.equal(files.has("Prism/Plan.md"), false);
  assert.equal([...files.values()].join("\n").includes("NO LONGER SHARED"), false);
  assert.deepEqual(JSON.parse(files.get("_export.json")!).skipped, [], "a note that became unviewable is not reported either");
});

test("vault export: the whole tree with raw kinds, minus the Trash and other people's private notes", async () => {
  const { files, job } = await exportZip({ scope: "vault", format: "markdown" });
  assert.deepEqual([...files.keys()].sort(), [
    "_export.json",
    "vault/Data/Budget.csv",
    "vault/Journal/Day.md",
    "vault/Projects/Prism.md",
    "vault/Projects/Prism/Hidden.md",
    "vault/Projects/Prism/Plan.md",
    "vault/Projects/Prism/Plan/Week 1.md",
  ]);
  assert.equal(files.get("vault/Data/Budget.csv"), "a,b\r\n1,2\r\n");
  assert.match(job.fileName, /^default-export-\d{4}-\d\d-\d\d\.zip$/);
  assert.equal(job.total, 6);
  assert.equal(job.done, 6);
  const all = [...files.values()].join("\n");
  assert.equal(all.includes("TOP SECRET"), false);
  assert.equal(all.includes("TRASHED BODY"), false);
});

test("who may call: people only; CSRF; strict bodies; jobs are private to their account", async () => {
  const body = { scope: "page", noteId: "root", format: "markdown" };
  assert.equal((await api.request("/export", { method: "POST", headers: JSON_H, body: JSON.stringify(body) })).status, 401);
  const link = makeCapability("note", "root", "edit");
  assert.equal((await api.request(`/export?t=${link}`, { method: "POST", headers: JSON_H, body: JSON.stringify(body) })).status, 401);
  // An in-process MCP actor (even the owner's) is refused.
  const env = { [INPROCESS_ACTOR]: { kind: "user", email: OWNER, role: "owner", vaultId: "primary", grants: [] } };
  assert.equal((await api.request("/export", { method: "POST", headers: JSON_H, body: JSON.stringify(body) }, env as never)).status, 403);
  // CSRF: a non-JSON content type, a cross-site fetch, a foreign origin.
  assert.equal((await api.request("/export", { method: "POST", headers: { cookie: login(OWNER), "content-type": "text/plain" }, body: JSON.stringify(body) })).status, 415);
  assert.equal((await post(body, login(OWNER), { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post(body, login(OWNER), { origin: "https://evil.example" })).status, 403);
  // A device token is a person too (no cookie, no origin rule).
  const dev = issueDeviceToken(OWNER, "Test device", "prism-client");
  const viaDevice = await api.request("/export", { method: "POST", headers: { ...JSON_H, authorization: `Bearer ${dev.token}`, origin: "https://evil.example" }, body: JSON.stringify(body) });
  assert.equal(viaDevice.status, 202, await viaDevice.clone().text());
  await waitDoneBearer(((await viaDevice.json()) as { jobId: string }).jobId, dev.token);
  for (const bad of [{ ...body, scope: "all" }, { ...body, format: "pdf" }, { ...body, subpages: "yes" }, { ...body, force: true }, []]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api.request("/export", { method: "POST", headers: { ...JSON_H, cookie: login(OWNER) }, body: "x".repeat(20_000) })).status, 413);

  // Another account cannot see, download or cancel the job.
  grantUser(MEMBER, "tag", "proj", "view");
  const r = await post(body);
  const { jobId } = (await r.json()) as { jobId: string };
  await waitDone(jobId, login(OWNER));
  for (const cookie of [login(MEMBER), ""]) {
    const headers: Record<string, string> = cookie ? { cookie } : {};
    assert.equal((await api.request(`/export/${jobId}`, { headers })).status, cookie ? 404 : 401);
    assert.equal((await api.request(`/export/${jobId}/download`, { headers })).status, cookie ? 404 : 401);
    assert.equal((await api.request(`/export/${jobId}`, { method: "DELETE", headers })).status, cookie ? 404 : 401);
  }
  assert.equal((await api.request(`/export/not-an-id/download`, { headers: { cookie: login(OWNER) } })).status, 404);
  assert.equal((await api.request(`/export/${jobId}`, { method: "DELETE", headers: { cookie: login(OWNER), origin: "https://evil.example" } })).status, 403);
  // The owner deletes it: gone, and its file with it.
  assert.equal((await api.request(`/export/${jobId}`, { method: "DELETE", headers: { cookie: login(OWNER) } })).status, 200);
  assert.equal((await api.request(`/export/${jobId}`, { headers: { cookie: login(OWNER) } })).status, 404);
});
async function waitDoneBearer(id: string, token: string) {
  for (let i = 0; i < 400; i++) {
    const j = (await (await api.request(`/export/${id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { state: string };
    if (j.state !== "queued" && j.state !== "running") return;
    await new Promise((res) => setTimeout(res, 5));
  }
}

test("bounds: page count, byte budget (job fails, temp file removed), one running export per account", async () => {
  process.env.EXPORT_MAX_NOTES = "3";
  try {
    assert.equal((await post({ scope: "vault", format: "markdown" })).status, 413);
  } finally {
    delete process.env.EXPORT_MAX_NOTES;
  }
  process.env.EXPORT_MAX_BYTES = "5000";
  try {
    fv.notes.get("plan")!.content = "incompressible ".concat(Array.from({ length: 4000 }, (_, i) => (i * 7919).toString(36)).join(""));
    const r = await post({ scope: "page", noteId: "root", format: "markdown" });
    const { jobId } = (await r.json()) as { jobId: string };
    const job = await waitDone(jobId, login(OWNER));
    assert.deepEqual([job.state, job.error, job.fileName], ["error", "too_large", null]);
    assert.equal((await api.request(`/export/${jobId}/download`, { headers: { cookie: login(OWNER) } })).status, 409);
  } finally {
    delete process.env.EXPORT_MAX_BYTES;
  }
  // A second export while one runs → 409 with the running job's id.
  process.env.EXPORT_PACE_MS = "40";
  const first = await post({ scope: "vault", format: "markdown" });
  const firstId = ((await first.json()) as { jobId: string }).jobId;
  const second = await post({ scope: "page", noteId: "root", format: "markdown" });
  assert.equal(second.status, 409);
  assert.equal(((await second.json()) as { jobId: string }).jobId, firstId);
  // Cancel mid-run: the job ends cancelled and leaves no file.
  assert.equal((await api.request(`/export/${firstId}`, { method: "DELETE", headers: { cookie: login(OWNER) } })).status, 200);
  process.env.EXPORT_PACE_MS = "0";
  const done = await waitDone(firstId, login(OWNER));
  assert.equal(done.state, "cancelled");
  assert.equal((await api.request(`/export/${firstId}/download`, { headers: { cookie: login(OWNER) } })).status, 409);
});

test("file names are safe and unique whatever the page paths are", async () => {
  fv.put({ id: "w1", path: "vault/Weird/a:b*c", content: "one", tags: ["page"], metadata: {} });
  fv.put({ id: "w2", path: "vault/Weird/a?b|c", content: "two", tags: ["page"], metadata: {} });
  fv.put({ id: "w3", path: "vault/Weird/CON", content: "three", tags: ["page"], metadata: {} });
  fv.put({ id: "w0", path: "vault/Weird", content: "<p>parent</p>", tags: ["page"], metadata: { title: "T\n---\nx: 1" } });
  const { files } = await exportZip({ scope: "page", noteId: "w0", format: "markdown" });
  assert.deepEqual([...files.keys()].sort(), ["Weird.md", "Weird/_CON.md", "Weird/a_b_c (2).md", "Weird/a_b_c.md", "_export.json"]);
  const fm = parseFrontMatter(files.get("Weird.md")!);
  assert.equal(fm.data.title, "T\n---\nx: 1");
  assert.equal(fm.data.x, undefined, "a title cannot inject a front-matter key");
});
