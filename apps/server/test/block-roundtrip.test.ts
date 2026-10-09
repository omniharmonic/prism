/**
 * NP-ED-24 — "block round-trip through publish and export": every block type of
 * NP-ED-08 … NP-ED-19 (test/fixtures/parity-blocks.ts) goes through
 *
 *   1. the server's stored-HTML round trip (what a live document saves),
 *   2. the publishing API (`GET /api/p/:slug/notes/:id` — the anonymous reader's data),
 *   3. the Markdown export and the HTML export (`POST /api/export`),
 *   4. an agent edit with `prism_update_note` — on a stored page and on a page that is
 *      open in the live editor (the three-way merge through Yjs),
 *
 * and each block must still be there afterwards. Failures are collected per pipeline so
 * one run names every block that does not survive. The published PAGE (what the wiki
 * renderer shows after sanitising) is asserted in the browser:
 * apps/web/e2e-fixtures/parity3-publication.spec.ts.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import * as Y from "yjs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readZipDirectory, readZipEntry } from "@prism/core/import-export";
import { createApp } from "../src/app";
import { api } from "../src/routes/api";
import { publish } from "../src/routes/publish";
import { addGrant, createPublication } from "../src/db";
import { issuePat } from "../src/auth/pat";
import { contentToYUpdateAsync, docNameFor, hocuspocus, resetReconcileState, yDocToHtmlAsync } from "../src/collab";
import { resetTreeForTests } from "../src/tree";
import { resetJobsForTests } from "../src/transfer/jobs";
import { stopExportWorker } from "../src/transfer/export";
import { stopImportWorker } from "../src/transfer/import";
import { stopConversionWorkers } from "../src/convert/service";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";
import { PARITY_BLOCKS, PARITY_PAGE_HTML } from "./fixtures/parity-blocks";

after(async () => { await stopImportWorker(); await stopExportWorker(); await stopConversionWorkers(); });

const OWNER = "owner@test.local";
const T0 = "2026-02-01T00:00:00.000Z";
const login = () => sessionCookie(makeSession(OWNER));

/** What the editor stores for the page (HTML → Yjs → HTML, the server's own code). */
async function storedForm(html: string): Promise<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await contentToYUpdateAsync(html));
  return yDocToHtmlAsync(doc);
}
/** Blocks of the fixture whose stored form is missing from `html`. */
const missingStored = (html: string): string[] =>
  PARITY_BLOCKS.filter((b) => b.stored.some((s) => !html.includes(s))).map((b) => `${b.row} ${b.name}: ${b.stored.filter((s) => !html.includes(s)).join(" | ")}`);

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let STORED: string;
const savedDebounce = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };

beforeEach(async () => {
  process.env.EXPORT_PACE_MS = "0";
  resetDb();
  resetTreeForTests();
  resetJobsForTests();
  resetReconcileState();
  fv = installFakeVault();
  app = createApp();
  STORED = await storedForm(PARITY_PAGE_HTML);
  fv.put({ id: "rt", path: "vault/Wiki/Round trip", tags: ["wiki"], content: STORED, metadata: { title: "Round trip" }, updatedAt: T0 });
});
afterEach(() => {
  Object.assign(hocuspocus.configuration, savedDebounce);
  resetJobsForTests();
  fv.restore();
});

test("stored HTML: every block type keeps its stored form, and the form is stable", async () => {
  assert.deepEqual(missingStored(STORED), []);
  assert.equal(await storedForm(STORED), STORED, "a second save writes the same bytes");
  // The fixture IS the stored form (so the publication browser fixture serves exactly what the vault holds).
  assert.equal(PARITY_PAGE_HTML, STORED, "test/fixtures/parity-blocks.ts must be written in the stored form");
});

async function publishAndExport() {
  // ── publish: the anonymous reader's data is the stored page, block for block ──
  createPublication({ id: "rt-site", resource_type: "tag", resource: "wiki", template: "wiki", title: "RT", home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER });
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "wiki", level: "view", created_by: "test" });
  const pub = await publish.request("/rt-site/notes/rt");
  assert.equal(pub.status, 200);
  const published = (await pub.json()) as { content: string };
  assert.deepEqual(missingStored(published.content), [], "published content");
  assert.equal(published.content, STORED, "publishing serves the stored page unchanged");

  // ── export: Markdown and HTML ──
  const exportFile = async (format: "markdown" | "html"): Promise<string> => {
    const cookie = login();
    const start = await api.request("/export", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ scope: "page", noteId: "rt", format, subpages: false, attachments: false }) });
    assert.equal(start.status, 202, await start.clone().text());
    const { jobId } = (await start.json()) as { jobId: string };
    for (let i = 0; ; i++) {
      const job = (await (await api.request(`/export/${jobId}`, { headers: { cookie } })).json()) as { state: string };
      if (job.state !== "queued" && job.state !== "running") { assert.equal(job.state, "done", JSON.stringify(job)); break; }
      assert.ok(i < 2000, "export did not finish");
      await new Promise((r) => setTimeout(r, 5));
    }
    const zip = new Uint8Array(await (await api.request(`/export/${jobId}/download`, { headers: { cookie } })).arrayBuffer());
    const entries = readZipDirectory(zip, { maxEntries: 100, maxEntryBytes: 5_000_000, maxTotalBytes: 10_000_000 });
    const files = new Map(entries.map((e) => [e.name, Buffer.from(readZipEntry(zip, e, (x, max) => inflateRawSync(x, { maxOutputLength: Math.max(max, 1) }))).toString("utf8")]));
    const manifest = JSON.parse(files.get("_export.json") ?? "{}") as { plainText?: string[] };
    assert.deepEqual(manifest.plainText ?? [], [], "the page was converted, not exported as plain text");
    const name = format === "markdown" ? "Round trip.md" : "Round trip.html";
    assert.ok(files.has(name), `${name} in ${[...files.keys()].join(", ")}`);
    return files.get(name)!;
  };
  const md = await exportFile("markdown");
  const html = await exportFile("html");
  // Every block is still a block in both files (to-do state, tables, captions and card
  // descriptions included — the Markdown export's block rules, transfer/export-markdown.ts).
  const lost = (kind: "markdown" | "html_export", file: string) =>
    PARITY_BLOCKS.filter((b) => b[kind].some((re) => !re.test(file))).map((b) => `${b.row} ${b.name}: ${b[kind].filter((re) => !re.test(file)).join(" , ")}`);
  assert.deepEqual(lost("markdown", md), [], `Markdown export lost blocks. The file was:\n${md}`);
  assert.deepEqual(lost("html_export", html), [], `HTML export lost blocks. The file was:\n${html}`);
  // Nothing is DROPPED by either export: every word a block holds (its text, a caption, a card's
  // title and description) is still in the file.
  const dropped = (file: string) =>
    PARITY_BLOCKS.flatMap((b) => (b.html.match(/RT [a-z A-Z]+|rt-notes\.txt|const rt = /g) ?? []).map((w) => w.trim()).filter((w) => !file.includes(w)).map((w) => `${b.row} ${b.name}: “${w}”`));
  assert.deepEqual(dropped(md), [], `Markdown export dropped content. The file was:\n${md}`);
  assert.deepEqual(dropped(html), [], `HTML export dropped content. The file was:\n${html}`);
}

test("block round-trip through publish and export", async () => {
  await publishAndExport();
});

// ── an agent edit (Prism MCP) ────────────────────────────────────────────────

async function agent(): Promise<Client> {
  const ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const token = issuePat({ email: OWNER, vaultId: "primary", scope: "write" }).token;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    h.set("cf-connecting-ip", ip);
    h.set("x-forwarded-for", ip);
    h.set("authorization", `Bearer ${token}`);
    const u = new URL(req.url);
    return app.request(u.pathname + u.search, { method: req.method, headers: h, body: req.method === "POST" ? await req.text() : undefined });
  };
  const client = new Client({ name: "roundtrip", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  return client;
}
async function tool(cl: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await cl.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name}: ${JSON.stringify(r.structuredContent ?? r.content)}`);
  return r.structuredContent;
}
const EDIT_FROM = "RT paragraph with";
const EDIT_TO = "RT paragraph, edited by the agent, with";

test("block round-trip through a prism_update_note edit (stored page)", async () => {
  const cl = await agent();
  const got = await tool(cl, "prism_get_note", { id: "rt" });
  // What the agent reads is the stored page, with every block in it.
  assert.deepEqual(missingStored(got.note?.content ?? got.content), []);
  const before: string = got.note?.content ?? got.content;
  assert.ok(before.includes(EDIT_FROM));
  const out = await tool(cl, "prism_update_note", { id: "rt", content: before.replace(EDIT_FROM, EDIT_TO), if_updated_at: T0 });
  assert.ok(out);
  const after = fv.notes.get("rt")!.content;
  assert.ok(after.includes(EDIT_TO), "the edit landed");
  assert.deepEqual(missingStored(after), [], "every other block is untouched");
  assert.equal(after, STORED.replace(EDIT_FROM, EDIT_TO), "nothing else changed");
});

test("block round-trip through a prism_update_note edit (page open in the live editor)", async () => {
  hocuspocus.configuration.debounce = 60_000;
  hocuspocus.configuration.maxDebounce = 120_000;
  const name = docNameFor("primary", "rt");
  // Someone has the page open: the server holds its live document.
  const human = await hocuspocus.openDirectConnection(name, {});
  try {
    assert.ok(hocuspocus.documents.has(name));
    assert.deepEqual(missingStored(await yDocToHtmlAsync(human.document!)), [], "the live document holds every block");
    const cl = await agent();
    const got = await tool(cl, "prism_get_note", { id: "rt" });
    const before: string = got.note?.content ?? got.content;
    const updatedAt: string = got.note?.updatedAt ?? got.updatedAt;
    const out = await tool(cl, "prism_update_note", { id: "rt", content: before.replace(EDIT_FROM, EDIT_TO), if_updated_at: updatedAt });
    assert.deepEqual(out.collab, { live: true, changed: true }, JSON.stringify(out));
    // The live document took the edit and still holds every block …
    const live = await yDocToHtmlAsync(human.document!);
    assert.ok(live.includes(EDIT_TO), "the edit reached the live document");
    assert.deepEqual(missingStored(live), [], "live document after the agent edit");
  } finally {
    await human.disconnect();
  }
  // … and so does the page as it was written back to the vault.
  const after = fv.notes.get("rt")!.content;
  assert.ok(after.includes(EDIT_TO), "the edit was saved");
  assert.deepEqual(missingStored(after), [], "stored page after the live agent edit");
  assert.equal(after, STORED.replace(EDIT_FROM, EDIT_TO));
});
