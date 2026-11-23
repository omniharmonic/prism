/**
 * Import routes + engine (routes/import.ts, transfer/import.ts) against the fake
 * vault: dry run, write, idempotent re-run, attachments, and every refusal.
 */
import { threadCpuMs } from "./probe";
import { test, beforeEach, afterEach, after } from "node:test";
import { stopImportWorker } from "../src/transfer/import";
import { stopExportWorker } from "../src/transfer/export";
after(async () => { await stopImportWorker(); await stopExportWorker(); });
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { api } from "../src/routes/api";
import { INPROCESS_ACTOR } from "../src/auth/actor";
import { issueDeviceToken } from "../src/auth/device";
import { resetTreeForTests } from "../src/tree";
import { resetAttachmentsForTests, usedBytes } from "../src/attachments";
import { resetJobsForTests } from "../src/transfer/jobs";
import { htmlBody, importKeyAllowed, importTagAllowed } from "../src/transfer/import";
import { setMembership, createPublication, db } from "../src/db";
import { zipSync } from "@prism/core/import-export";
import { TRASH_TAG } from "@prism/core/pages";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const ADMIN = "admin@test.local";
const MEMBER = "member@test.local";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const NID = (n: number) => String(n).padStart(32, "0");
const login = (email: string) => sessionCookie(makeSession(email));
const deflate = (d: Uint8Array) => deflateRawSync(d);

function notionZip(over: Record<string, string | Uint8Array | null> = {}): Uint8Array {
  const files: Record<string, string | Uint8Array | null> = {
    [`Home ${NID(1)}.md`]: `# Home\n\nSee [Plan](Home%20${NID(1)}/Plan%20${NID(2)}.md).\n\n![diagram](Home%20${NID(1)}/diagram.png)\n`,
    [`Home ${NID(1)}/Plan ${NID(2)}.md`]: `# Plan\n\nBack to [Home](../Home%20${NID(1)}.md).\n`,
    [`Home ${NID(1)}/diagram.png`]: PNG,
    [`Home ${NID(1)}/Reading list ${NID(3)}.csv`]: "Name,Status\nDune,Done\nEmma,Reading\n",
    [`Home ${NID(1)}/Reading list ${NID(3)}/Dune ${NID(4)}.md`]: "# Dune\n\nStatus: Done\n\nA desert planet.\n",
    ...over,
  };
  return zipSync(Object.entries(files).filter(([, v]) => v !== null).map(([name, data]) => ({ name, data: data as string | Uint8Array })), { deflate });
}

let fv: FakeVault;
beforeEach(() => {
  process.env.IMPORT_PACE_MS = "0";
  process.env.IMPORT_WRITES_PER_HOUR = "100000";
  process.env.IMPORT_PREVIEWS_PER_HOUR = "100000";
  resetDb();
  resetTreeForTests();
  resetAttachmentsForTests();
  resetJobsForTests();
  fv = installFakeVault();
  fv.put({ id: "existing", path: "vault/Docs/Existing", content: "<p>mine</p>", tags: ["page"], metadata: {} });
});
afterEach(() => {
  resetJobsForTests();
  fv.restore();
});

interface Opts { dryRun?: boolean; parent?: string | null; name?: string; cookie?: string; headers?: Record<string, string>; type?: string; noHeader?: boolean }
function send(body: Uint8Array | string, o: Opts = {}, env?: unknown) {
  const q = new URLSearchParams();
  if (o.dryRun === false) q.set("dryRun", "0");
  if (o.parent !== null) q.set("parent", o.parent ?? "vault/Imports/Notion");
  q.set("name", o.name ?? "Export.zip");
  const headers = new Headers({ "content-type": o.type ?? "application/zip", ...(o.headers ?? {}) });
  if (o.cookie !== "") headers.set("cookie", o.cookie ?? login(OWNER));
  if (!o.noHeader) headers.set("x-prism-import", "1");
  return api.request(`/import?${q}`, { method: "POST", headers, body: body as BodyInit }, env as never);
}
async function run(body: Uint8Array | string, o: Opts = {}) {
  const r = await send(body, { ...o, dryRun: false });
  assert.equal(r.status, 202, await r.clone().text());
  const { jobId } = (await r.json()) as { jobId: string };
  const cookie = o.cookie ?? login(OWNER);
  for (let i = 0; i < 400; i++) {
    const j = (await (await api.request(`/import/${jobId}`, { headers: { cookie } })).json()) as Record<string, any>;
    if (j.state !== "queued" && j.state !== "running") return j;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("import did not finish");
}
const byPath = (p: string) => [...fv.notes.values()].find((n) => n.path === p);
const writes = () => fv.calls.filter((c) => c.method !== "GET").length;

test("dry run is the default: a full summary and not one vault write", async () => {
  const before = fv.notes.size;
  const r = await send(notionZip(), {});
  assert.equal(r.status, 200, await r.clone().text());
  const p = (await r.json()) as Record<string, any>;
  assert.equal(p.dryRun, true);
  assert.equal(p.destination, "vault/Imports/Notion");
  assert.deepEqual(p.summary, { pages: 2, databases: 1, rows: 2, attachments: 1, links: 2, create: 5, update: 0, unchanged: 0, conflict: 0, ignored: 0 });
  assert.deepEqual(p.items.map((i: any) => [i.kind, i.action, i.path]), [
    ["page", "create", "vault/Imports/Notion/Home"],
    ["page", "create", "vault/Imports/Notion/Home/Plan"],
    ["database", "create", "vault/Imports/Notion/Home/Reading list"],
    ["row", "create", "vault/Imports/Notion/Home/Reading list/Dune"],
    ["row", "create", "vault/Imports/Notion/Home/Reading list/Emma"],
  ]);
  assert.equal(fv.notes.size, before);
  assert.equal(writes(), 0);
  assert.equal(fv.storage.size, 0);
});

test("import writes nested pages, wikilinks, an attached image and a database; a re-run changes nothing", async () => {
  const job = await run(notionZip());
  assert.deepEqual([job.state, job.created, job.updated, job.conflicts, job.attachments, job.failed], ["done", 5, 0, 0, 1, []]);
  const home = byPath("vault/Imports/Notion/Home")!;
  assert.equal(job.firstId, home.id);
  const att = home.content.match(/!\[diagram\]\((\/api\/attachments\/a_[A-Za-z0-9_-]{22})\)/);
  assert.ok(att, home.content);
  assert.ok(home.content.startsWith("See [[vault/Imports/Notion/Home/Plan]].\n\n"), home.content);
  assert.equal(byPath("vault/Imports/Notion/Home/Plan")!.content, "Back to [[vault/Imports/Notion/Home]].\n");
  // The image is a real attachment of the page (vault storage + index row), sniffed as PNG.
  assert.equal(fv.storage.size, 1);
  assert.match([...fv.storage.keys()][0]!, /\.png$/);
  assert.equal(fv.attachments[0]!.noteId, home.id);
  assert.equal(usedBytes("primary", home.id), PNG.length);
  const served = await api.request(att![1]!.replace("/api", ""), { headers: { cookie: login(OWNER) } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  // The database: a database note + tagged rows with typed-by-name properties.
  const dbNote = byPath("vault/Imports/Notion/Home/Reading list")!;
  const tag = (dbNote.metadata!.prism_database as any).source.tags[0];
  assert.equal(dbNote.metadata!.prism_type, "database");
  const dune = byPath("vault/Imports/Notion/Home/Reading list/Dune")!;
  assert.deepEqual([dune.tags, dune.metadata!.title, dune.metadata!.status, dune.content], [[tag], "Dune", "Done", "A desert planet.\n"]);
  assert.deepEqual(byPath("vault/Imports/Notion/Home/Reading list/Emma")!.metadata!.status, "Reading");
  // Stamped by the importer; no identity or visibility is invented.
  assert.match(String(home.metadata!.prism_last_writer), /^u_/);
  assert.equal(home.metadata!.prism_creator, undefined);

  // Re-run: nothing written, nothing duplicated.
  const notes = fv.notes.size;
  const w = writes();
  const preview = (await (await send(notionZip())).json()) as Record<string, any>;
  assert.deepEqual([preview.summary.create, preview.summary.update, preview.summary.unchanged, preview.summary.conflict], [0, 0, 5, 0]);
  const again = await run(notionZip());
  assert.deepEqual([again.state, again.created, again.updated, again.unchanged, again.attachments], ["done", 0, 0, 5, 0]);
  assert.equal(fv.notes.size, notes);
  assert.equal(writes(), w);
  assert.equal(fv.storage.size, 1);
});

test("re-run after the source changed: unedited pages update (CAS); pages edited in Prism are conflicts", async () => {
  await run(notionZip());
  const plan = byPath("vault/Imports/Notion/Home/Plan")!;
  const home = byPath("vault/Imports/Notion/Home")!;
  home.content += "\nSomeone wrote here.";
  const changed = notionZip({
    [`Home ${NID(1)}.md`]: "# Home\n\nRewritten upstream.\n",
    [`Home ${NID(1)}/Plan ${NID(2)}.md`]: "# Plan\n\nNew plan text.\n",
  });
  const preview = (await (await send(changed)).json()) as Record<string, any>;
  assert.deepEqual(preview.items.slice(0, 2).map((i: any) => [i.action, i.reason]), [["conflict", "edited since it was imported"], ["update", undefined]]);
  const job = await run(changed);
  assert.deepEqual([job.created, job.updated, job.unchanged, job.conflicts], [0, 1, 3, 1]);
  assert.equal(byPath("vault/Imports/Notion/Home/Plan")!.id, plan.id);
  assert.equal(plan.content, "New plan text.\n");
  assert.ok(home.content.endsWith("Someone wrote here."), "the edited page is left alone");
});

test("a path already held by someone's page is never overwritten; trashed and protected locations are refused", async () => {
  fv.put({ id: "held", path: "vault/Imports/Notion/Home", content: "<p>hand made</p>", tags: ["page"], metadata: {} });
  fv.put({ id: "bin", path: "vault/Imports/Notion/Home/Plan", content: "x", tags: ["page", TRASH_TAG], metadata: {} });
  const job = await run(notionZip());
  assert.equal(job.conflicts, 2);
  assert.equal(fv.notes.get("held")!.content, "<p>hand made</p>");
  assert.equal(fv.notes.get("bin")!.content, "x");
  assert.equal([...fv.notes.values()].filter((n) => n.path === "vault/Imports/Notion/Home").length, 1);
  // Destination roots that are not the importer's to write.
  for (const [parent, status] of [["vault/messages/x", 403], ["vault/agent/skills", 403], ["vault/people", 403], ["../up", 400], ["", 400], ["a/".repeat(14) + "b", 400]] as const) {
    const r = await send(notionZip(), { parent });
    assert.equal(r.status, status, parent);
  }
  // Under a trashed page.
  fv.put({ id: "tr", path: "vault/Old", content: "", tags: [TRASH_TAG], metadata: {} });
  assert.equal((await send(notionZip(), { parent: "vault/Old/In" })).status, 409);
});

test("tags and properties from a file never grant, publish, or impersonate", async () => {
  grantUser(MEMBER, "tag", "shared-tag", "view");
  createPublication({ id: "site", resource_type: "tag", resource: "public-tag", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER });
  createPublication({ id: "folder", resource_type: "path", resource: "vault/Published", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  // A published folder is not an import destination (it would publish every page).
  assert.equal((await send(notionZip(), { parent: "vault/Published/In" })).status, 403);
  for (const t of ["agent-skill", "#agent-skill", " governance-config", "person", "meeting", "email", "prism-trashed", "shared-tag", "public-tag", "merged-stub", "", "a\u0001b"]) assert.equal(importTagAllowed("primary", t), null, JSON.stringify(t));
  assert.equal(importTagAllowed("primary", "#recipes"), "recipes");
  for (const k of ["prism_visibility", "prism_creator", "prism_import", "gov_sig", "_x", "skillName", "runner", "lastRun", "calendarEventId", "messageId", "source", "source_id", "type", "enabled", "layout", "__proto__", "bad key"]) assert.equal(importKeyAllowed(k), false, k);
  assert.equal(importKeyAllowed("status"), true);

  const md = '---\ntags: ["recipes", "agent-skill", "shared-tag", "public-tag"]\nstatus: "draft"\nprism_visibility: "private"\nprism_creator: "ceo@corp"\nskillName: "x"\nenabled: true\nrunner: "server"\n---\n\nBody';
  const job = await run(md, { name: "Note.md", type: "text/markdown", parent: "vault/Imports" });
  assert.equal(job.created, 1);
  const note = byPath("vault/Imports/Note")!;
  assert.deepEqual(note.tags, ["recipes"]);
  assert.deepEqual(Object.keys(note.metadata!).filter((k) => !k.startsWith("prism_last") && k !== "prism_import").sort(), ["status"]);
  assert.deepEqual(job.problems.map((p: any) => p.reason).sort(), ["tag not applied: agent-skill", "tag not applied: public-tag", "tag not applied: shared-tag"]);
});

test("attachments: active content, oversize and non-image 'images' are not stored; the page still imports", async () => {
  process.env.ATTACHMENT_IMAGE_MAX_BYTES = "2000";
  try {
    const big = Buffer.concat([PNG, Buffer.alloc(4000)]);
    const zip = zipSync([
      { name: "P.md", data: "![svg](a.svg) ![big](big.png) ![fake](fake.png) [script](x.html) ![ok](ok.png) [up](../../etc/passwd)" },
      { name: "a.svg", data: SVG },
      { name: "big.png", data: big },
      { name: "fake.png", data: "<html><script>alert(1)</script></html>" },
      { name: "x.html", data: "<script>alert(1)</script>" },
      { name: "ok.png", data: PNG },
    ]);
    const job = await run(zip);
    assert.equal(job.state, "done");
    assert.equal(job.attachments, 1);
    assert.equal(fv.storage.size, 1);
    const p = byPath("vault/Imports/Notion/P")!;
    assert.match(p.content, /^!\[svg\]\(a\.svg\) !\[big\]\(big\.png\) !\[fake\]\(fake\.png\) \[\[vault\/Imports\/Notion\/x\|script\]\] !\[ok\]\(\/api\/attachments\/a_[\w-]{22}\) \[up\]\(\.\.\/\.\.\/etc\/passwd\)$/);
    assert.equal(job.problems.filter((x: any) => x.reason.startsWith("not attached")).length, 3);
    // Files that can never be attached are settled: the page is complete and a later run changes nothing.
    const stamp = p.metadata!.prism_import as { hash?: string; assets: Record<string, string> };
    assert.equal(typeof stamp.hash, "string");
    assert.deepEqual(Object.values(stamp.assets).filter((v) => v === "x").length, 3);
    const again = await run(zip);
    assert.deepEqual([again.unchanged, again.attachments], [2, 0]);
  } finally {
    delete process.env.ATTACHMENT_IMAGE_MAX_BYTES;
  }
});

test("hostile archives are refused before anything is unpacked or written", async () => {
  const z = (files: Array<{ name: string; data: string | Uint8Array }>) => zipSync(files, { deflate });
  // Zip bomb by declared size.
  process.env.IMPORT_MAX_TOTAL_BYTES = "100000";
  try {
    const r = await send(z([{ name: "a.md", data: new Uint8Array(200_000) }]));
    assert.equal(r.status, 413);
    assert.equal(((await r.json()) as any).error, "too_large");
  } finally {
    delete process.env.IMPORT_MAX_TOTAL_BYTES;
  }
  process.env.IMPORT_MAX_ENTRIES = "3";
  try {
    assert.equal((await send(z(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.md`, data: "x" }))))).status, 413);
  } finally {
    delete process.env.IMPORT_MAX_ENTRIES;
  }
  // A lying size (inflates past its declaration) fails as a corrupt entry, as a 400.
  const bomb = Buffer.from(z([{ name: "a.md", data: new Uint8Array(100_000) }]));
  bomb.writeUInt32LE(10, bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  const lying = await send(bomb);
  assert.equal(lying.status, 400);
  // Zip slip: the entry is ignored and reported; nothing lands outside the destination.
  const slip = Buffer.from(zipSync([{ name: "aa/aa/evil.md", data: "pwn" }, { name: "ok.md", data: "fine" }]));
  for (let at = slip.indexOf("aa/aa/evil.md"); at !== -1; at = slip.indexOf("aa/aa/evil.md", at + 1)) slip.write("../../evil.md", at, "latin1");
  const job = await run(slip);
  assert.equal(job.created, 1);
  assert.deepEqual(job.problems, [{ entry: "../../evil.md", reason: "ignored: unsafe path" }]);
  assert.deepEqual([...fv.notes.values()].map((n) => n.path).sort(), ["vault/Docs/Existing", "vault/Imports/Notion/ok"]);
  // Truncated / garbage / unsupported uploads.
  assert.equal((await send(Buffer.from(notionZip()).subarray(0, 300))).status, 400);
  assert.equal((await send("just text", { name: "x.exe", type: "application/octet-stream" })).status, 415);
  assert.equal((await send(new Uint8Array(0))).status, 400);
  process.env.IMPORT_MAX_BYTES = "2000";
  try {
    assert.equal((await send(new Uint8Array(5000))).status, 413);
  } finally {
    delete process.env.IMPORT_MAX_BYTES;
  }
  assert.equal(writes(), 1, "only the one good page was written");
});

test("a Notion wrapper archive (parts inside one zip) is unpacked one level, sharing the budget", async () => {
  const wrapper = zipSync([{ name: "Export-Part-1.zip", data: notionZip() }]);
  const p = (await (await send(wrapper)).json()) as Record<string, any>;
  assert.equal(p.summary.create, 5);
  // Zip in zip in zip is not followed: the inner archive is just an ignored file.
  const deep = zipSync([{ name: "Part.zip", data: wrapper }]);
  const d = (await (await send(deep)).json()) as Record<string, any>;
  assert.equal(d.summary.create, 0);
  process.env.IMPORT_MAX_TOTAL_BYTES = "2000";
  try {
    // The part itself is small (deflated); what it unpacks to is what counts.
    const heavy = zipSync([{ name: "Export-Part-1.zip", data: notionZip({ "Big.md": "x".repeat(3000) }) }]);
    assert.ok(heavy.length < 2000);
    assert.equal((await send(heavy)).status, 413);
  } finally {
    delete process.env.IMPORT_MAX_TOTAL_BYTES;
  }
});

test("single files: Markdown, HTML (script removed, stored as Markdown) and CSV", async () => {
  const html = await run('<html><head><title>T</title><style>p{}</style></head><body><h2>Hi</h2><p>Text <b>bold</b></p><script>alert(1)</script><iframe src="https://evil"></iframe><img src="x" onerror="alert(1)"></body></html>', { name: "Page one.html", type: "text/html", parent: "vault/Imports" });
  assert.equal(html.created, 1);
  const page = byPath("vault/Imports/Page one")!;
  assert.match(page.content, /^## Hi\n\nText \*\*bold\*\*/);
  for (const bad of ["script", "alert", "iframe", "onerror", "<style", "p{}"]) assert.equal(page.content.includes(bad), false, bad);
  const csv = await run("Name,Rating\nA,5\nB,3\n", { name: "Books.csv", type: "text/csv", parent: "vault/Imports" });
  assert.deepEqual([csv.created, csv.state], [3, "done"]);
  assert.equal(byPath("vault/Imports/Books")!.metadata!.prism_type, "database");
  assert.equal(byPath("vault/Imports/Books/A")!.metadata!.rating, "5");
});

test("who may import: owner and admins, as people, with the CSRF header and a same-site origin", async () => {
  setMembership("primary", ADMIN, "admin", OWNER);
  setMembership("primary", MEMBER, "member", OWNER);
  grantUser(MEMBER, "vault", "primary", "edit");
  const zip = notionZip();
  assert.equal((await send(zip, { cookie: login(ADMIN) })).status, 200);
  assert.equal((await send(zip, { cookie: login(MEMBER) })).status, 403);
  assert.equal((await send(zip, { cookie: login("stranger@test.local") })).status, 403);
  assert.equal((await send(zip, { cookie: "" })).status, 401);
  const link = makeCapability("vault", "primary", "edit");
  assert.equal((await api.request(`/import?t=${link}&name=a.zip`, { method: "POST", headers: { "content-type": "application/zip", "x-prism-import": "1" }, body: zip as BodyInit })).status, 401);
  const env = { [INPROCESS_ACTOR]: { kind: "user", email: OWNER, role: "owner", vaultId: "primary", grants: [] } };
  assert.equal((await send(zip, { cookie: "" }, env)).status, 403);
  // CSRF.
  assert.equal((await send(zip, { noHeader: true })).status, 403);
  assert.equal((await send(zip, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await send(zip, { headers: { "sec-fetch-site": "same-site" } })).status, 403);
  assert.equal((await send(zip, { headers: { origin: "https://evil.example" } })).status, 403);
  for (const type of ["multipart/form-data; boundary=x", "application/x-www-form-urlencoded", "text/plain", "application/json"]) assert.equal((await send(zip, { type })).status, 415, type);
  const dev = issueDeviceToken(OWNER, "Mac", "prism-client");
  assert.equal((await send(zip, { cookie: "", headers: { authorization: `Bearer ${dev.token}`, origin: "https://evil.example" } })).status, 200);
  assert.equal(writes(), 0, "every refusal and every dry run wrote nothing");

  // Jobs are private; a second write while one runs is refused.
  process.env.IMPORT_PACE_MS = "40";
  const first = await send(zip, { dryRun: false });
  assert.equal(first.status, 202);
  const { jobId } = (await first.json()) as { jobId: string };
  assert.equal((await send(zip, { dryRun: false, cookie: login(ADMIN) })).status, 409);
  assert.equal((await api.request(`/import/${jobId}`, { headers: { cookie: login(ADMIN) } })).status, 404);
  assert.equal((await api.request(`/import/${jobId}`, { headers: { cookie: login(MEMBER) } })).status, 403);
  assert.equal((await api.request(`/import/${jobId}`, { method: "DELETE", headers: { cookie: login(OWNER), origin: "https://evil.example" } })).status, 403);
  assert.equal((await api.request(`/import/${jobId}`, { method: "DELETE", headers: { cookie: login(OWNER) } })).status, 200);
  process.env.IMPORT_PACE_MS = "0";
  for (let i = 0; i < 400; i++) {
    const j = (await (await api.request(`/import/${jobId}`, { headers: { cookie: login(OWNER) } })).json()) as { state: string };
    if (j.state === "cancelled") break;
    assert.notEqual(j.state, "done");
    await new Promise((res) => setTimeout(res, 5));
  }
  // Cancelled half-way: running it again finishes the job without duplicates.
  const rest = await run(zip);
  assert.equal(rest.state, "done");
  assert.equal(rest.created + rest.unchanged + rest.updated, 5);
  assert.equal([...fv.notes.values()].filter((n) => n.path?.startsWith("vault/Imports/Notion/")).length, 5);
  // One audit row per write run, counts only.
  const audit = db.prepare("SELECT action, target FROM action_audit WHERE action = 'admin.import'").all() as Array<{ target: string }>;
  assert.equal(audit.length, 2);
  for (const a of audit) assert.equal(/Home|Notion|vault\//.test(a.target), false);
});

test("rate limits: previews and writes are counted per account", async () => {
  process.env.IMPORT_PREVIEWS_PER_HOUR = "2";
  const cookie = login("limited-admin@test.local");
  setMembership("primary", "limited-admin@test.local", "admin", OWNER);
  assert.equal((await send(notionZip(), { cookie })).status, 200);
  assert.equal((await send(notionZip(), { cookie })).status, 200);
  const r = await send(notionZip(), { cookie });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
});

test("htmlBody: the page part of a document, linear on hostile input", () => {
  assert.equal(htmlBody("<!doctype html><HTML><head><title>x</title></head><BODY class='a'><p>hi</p></BODY></html>"), "<p>hi</p>");
  assert.equal(htmlBody("<head><style>x</style></head><p>after</p>"), "<p>after</p>");
  assert.equal(htmlBody("<p>fragment</p><bodyguard>"), "<p>fragment</p><bodyguard>");
  const t0 = threadCpuMs(); // CPU time of this thread (./probe), not the wall clock
  htmlBody("<".repeat(400_000));
  htmlBody("<bod".repeat(100_000));
  htmlBody("</head".repeat(100_000));
  assert.ok(threadCpuMs() - t0 < 1500);
});
