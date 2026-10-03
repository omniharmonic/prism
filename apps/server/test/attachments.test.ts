/**
 * Attachments (routes/attachments.ts): upload into vault storage, serve after a
 * view check on the owning note, sniffing, CSRF, caps, size and rate limits.
 * Runs the REAL gateway app against the fake vault (helpers.ts storage fakes).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { createApp } from "../src/app";
import { issueDeviceToken } from "../src/auth/device";
import { INPROCESS_ACTOR, INPROCESS_CLIENT_KEY } from "../src/auth/actor";
import { TRASH_TAG, LOCK_KEY } from "@prism/core/pages";
import { resetTreeForTests } from "../src/tree";
import { configureAttachments as configureRaw, type AttachmentsConfig } from "../src/routes/attachments";
// One owner account uploads across the whole file: lift the per-minute rate unless a test sets it.
const configureAttachments = (over: Partial<AttachmentsConfig> | null) => configureRaw({ uploadsPerMinute: 100_000, ...(over ?? {}) });
import { resetAttachmentsForTests, sanitizeName, contentDisposition, purgeAttachmentsForNote, usedBytes } from "../src/attachments";
import { sniffAttachment, looksActive, mpegFrameLength } from "../src/media/sniff-file";
import { addVaultEntry, addGrant, db } from "../src/db";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("  \n<!DOCTYPE html><html><script>alert(1)</script></html>");
const ZIPISH = Buffer.from("PK\x03\x04 some opaque archive bytes", "latin1");
// One MPEG-1 Layer III frame header: 128 kbit/s, 44.1 kHz, no padding → 417 bytes.
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const STRANGER = "stranger@test.local";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetAttachmentsForTests();
  configureAttachments(null);
  fv = installFakeVault();
  fv.put({ id: "n1", path: "Docs/One", content: "<p>one</p>", tags: ["doc"], metadata: { title: "One" } });
});
afterEach(() => fv.restore());

const login = (email: string) => sessionCookie(makeSession(email));

function form(bytes: Buffer, name = "pic.png"): FormData {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(bytes)]), name);
  return f;
}
function upload(noteId: string, bytes: Buffer, opts: { name?: string; kind?: string; cookie?: string; headers?: Record<string, string>; noHeader?: boolean } = {}, env?: unknown) {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (!opts.noHeader) headers.set("x-prism-upload", "1");
  const q = opts.kind ? `?kind=${opts.kind}` : "";
  return api.request(`/notes/${encodeURIComponent(noteId)}/attachments${q}`, { method: "POST", headers, body: form(bytes, opts.name) }, env as never);
}
function get(id: string, init: { cookie?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return api.request(`/attachments/${id}`, { headers });
}
async function ownerUpload(bytes = PNG, name = "pic.png", kind?: string) {
  const r = await upload("n1", bytes, { cookie: login(OWNER), name, kind });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()) as { id: string; url: string; name: string; mimeType: string; size: number };
}

test("owner uploads a PNG: vault storage + note attachment, then GET streams it with rebuilt headers", async () => {
  const body = await ownerUpload(PNG, "My photo.png", "image");
  assert.match(body.id, /^a_[A-Za-z0-9_-]{22}$/);
  assert.equal(body.url, `/api/attachments/${body.id}`);
  assert.deepEqual([body.name, body.mimeType, body.size], ["My photo.png", "image/png", PNG.length]);
  // Server-chosen vault filename, never the client's; never auto-transcribed.
  const stored = [...fv.storage.keys()];
  assert.equal(stored.length, 1);
  assert.match(stored[0]!, /\.png$/);
  assert.equal(stored[0]!.includes("photo"), false);
  assert.deepEqual(fv.attachments[0]!.body, { path: stored[0], mimeType: "image/png", transcribe: false });
  assert.equal(fv.notes.get("n1")!.content, "<p>one</p>", "an upload never writes the note");

  const r = await get(body.id, { cookie: login(OWNER) });
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(r.headers.get("cache-control"), "private, no-cache");
  assert.equal(r.headers.get("vary"), "Authorization, Cookie");
  assert.equal(r.headers.get("etag"), `"${body.id}"`);
  const again = await get(body.id, { cookie: login(OWNER), headers: { "if-none-match": `"${body.id}"` } });
  assert.equal(again.status, 304);
  assert.equal((await get(body.id, { headers: { "if-none-match": `"${body.id}"` } })).status, 404, "304 only after the access check");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.match(r.headers.get("content-disposition")!, /^inline; filename="My photo.png"; filename\*=UTF-8''My%20photo.png$/);
});

test("Range is forwarded: 206 with Content-Range", async () => {
  const { id } = await ownerUpload();
  const r = await get(id, { cookie: login(OWNER), headers: { range: "bytes=0-7" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 0-7/${PNG.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG.subarray(0, 8));
  const bad = await get(id, { cookie: login(OWNER), headers: { range: "bytes=9999-" } });
  assert.equal(bad.status, 416);
});

test("SVG is refused by bytes and by extension; HTML disguised as .png is refused for image and file", async () => {
  const c = login(OWNER);
  assert.equal((await upload("n1", SVG, { cookie: c, name: "x.png" })).status, 415);
  assert.equal((await upload("n1", SVG, { cookie: c, name: "x.png", kind: "image" })).status, 415);
  assert.equal((await upload("n1", ZIPISH, { cookie: c, name: "harmless.svg" })).status, 415);
  assert.equal((await upload("n1", ZIPISH, { cookie: c, name: "x.html." })).status, 415);
  assert.equal((await upload("n1", HTML, { cookie: c, name: "x.png", kind: "image" })).status, 415);
  assert.equal((await upload("n1", HTML, { cookie: c, name: "x.png" })).status, 415);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<?xml version='1.0'?><svg/>")]);
  assert.equal((await upload("n1", bom, { cookie: c, name: "x.dat" })).status, 415);
  assert.equal((await upload("n1", PDF, { cookie: c, name: "x.pdf", kind: "image" })).status, 415, "kind=image takes images only");
  assert.equal((await upload("n1", Buffer.alloc(0), { cookie: c, name: "x.png" })).status, 400);
  assert.equal(fv.storage.size, 0);
});

test("unknown bytes are an octet-stream download; PDF is inline + same-origin framable", async () => {
  const c = login(OWNER);
  const zip = await ownerUpload(ZIPISH, "archive.zip");
  assert.equal(zip.mimeType, "application/octet-stream");
  const r = await get(zip.id, { cookie: c });
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.match(r.headers.get("content-disposition")!, /^attachment;/);
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");

  const pdf = await ownerUpload(PDF, "report.pdf");
  assert.equal(pdf.mimeType, "application/pdf");
  // Through the full app so the global header middleware runs too.
  const full = await createApp().request(`/api/attachments/${pdf.id}`, { headers: { cookie: c } });
  assert.equal(full.status, 200);
  assert.match(full.headers.get("content-disposition")!, /^inline;/);
  assert.equal(full.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'self'");
  assert.equal(full.headers.get("x-frame-options"), "SAMEORIGIN");
  const png = await ownerUpload();
  const fullPng = await createApp().request(`/api/attachments/${png.id}`, { headers: { cookie: c } });
  assert.equal(fullPng.headers.get("x-frame-options"), "DENY");
});

test("a viewer cannot upload (403) but can read; a stranger gets 404s identical to nonexistent", async () => {
  const { id } = await ownerUpload();
  grantUser(MEMBER, "note", "n1", "view");
  const viewer = login(MEMBER);
  const up = await upload("n1", PNG, { cookie: viewer });
  assert.equal(up.status, 403);
  assert.equal((await get(id, { cookie: viewer })).status, 200);

  const stranger = login(STRANGER);
  const a = await upload("n1", PNG, { cookie: stranger });
  const b = await upload("nope", PNG, { cookie: stranger });
  assert.deepEqual([a.status, await a.text()], [b.status, await b.text()]);
  assert.equal(a.status, 404);
  const g1 = await get(id, { cookie: stranger });
  const g2 = await get("a_AAAAAAAAAAAAAAAAAAAAAA", { cookie: stranger });
  assert.deepEqual([g1.status, await g1.text()], [g2.status, await g2.text()]);
  assert.equal(g1.status, 404);
  // Signed out: 404 too (no oracle).
  assert.equal((await get(id)).status, 404);
  assert.equal((await upload("n1", PNG)).status, 401);
});

test("an editor can upload; someone else's private note is 404 even with a grant", async () => {
  grantUser(MEMBER, "note", "n1", "edit");
  const r = await upload("n1", PNG, { cookie: login(MEMBER) });
  assert.equal(r.status, 201);
  fv.put({ id: "p1", content: "", tags: ["doc"], metadata: { prism_creator: "other@test.local", prism_visibility: "private" } });
  grantUser(MEMBER, "tag", "doc", "edit"); // a workspace (tag) grant never reaches a private page
  assert.equal((await upload("p1", PNG, { cookie: login(MEMBER) })).status, 404);
});

test("trashed → 404 for non-owners (upload and read); locked → 409; a path alias → 404", async () => {
  const { id } = await ownerUpload();
  grantUser(MEMBER, "note", "n1", "edit");
  const m = login(MEMBER);
  fv.notes.get("n1")!.metadata = { title: "One", [LOCK_KEY]: true };
  assert.equal((await upload("n1", PNG, { cookie: m })).status, 409);
  assert.equal((await upload("n1", PNG, { cookie: login(OWNER) })).status, 201, "owner may still add to a locked page");
  fv.notes.get("n1")!.metadata = { title: "One" };
  fv.notes.get("n1")!.tags = ["doc", TRASH_TAG];
  configureAttachments(null); // drop the owning-note cache
  assert.equal((await upload("n1", PNG, { cookie: m })).status, 404);
  assert.equal((await get(id, { cookie: m })).status, 404);
  assert.equal((await upload("Docs/One", PNG, { cookie: login(OWNER) })).status, 404);
  assert.equal((await upload("One", PNG, { cookie: login(OWNER) })).status, 404, "a title alias resolving to another id is refused");
});

test("CSRF: custom header required, multipart only, cross-site refused unless a device bearer", async () => {
  const c = login(OWNER);
  assert.equal((await upload("n1", PNG, { cookie: c, noHeader: true })).status, 403);
  const json = await api.request("/notes/n1/attachments", { method: "POST", headers: { cookie: c, "x-prism-upload": "1", "content-type": "application/json" }, body: "{}" });
  assert.equal(json.status, 415);
  assert.equal((await upload("n1", PNG, { cookie: c, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await upload("n1", PNG, { cookie: c, headers: { origin: "https://evil.example" } })).status, 403);
  const { token } = issueDeviceToken(OWNER, "Mac", "prism-client");
  const d = await upload("n1", PNG, { headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "cross-site", origin: "tauri://localhost" } });
  assert.equal(d.status, 201);
  const { id } = (await d.json()) as { id: string };
  assert.equal((await get(id, { headers: { authorization: `Bearer ${token}` } })).status, 200, "device bearer reads too");
});

test("body over the cap → 413; rate limit → 429", async () => {
  configureAttachments({ maxImageBytes: 1000, maxBytes: 2000 });
  const big = Buffer.concat([PNG, Buffer.alloc(30_000)]);
  const r = await upload("n1", big, { cookie: login(OWNER), kind: "image" });
  assert.equal(r.status, 413);
  assert.equal(((await r.json()) as { error: string }).error, "too_large");
  configureAttachments({ uploadsPerMinute: 2 });
  grantUser("rate@test.local", "note", "n1", "edit"); // a fresh rate-limit bucket
  const c = login("rate@test.local");
  assert.equal((await upload("n1", PNG, { cookie: c })).status, 201);
  assert.equal((await upload("n1", PNG, { cookie: c })).status, 201);
  assert.equal((await upload("n1", PNG, { cookie: c })).status, 429);
});

test("capability links: edit link uploads, view link reads; MCP in-process is refused", async () => {
  const { id } = await ownerUpload();
  const edit = makeCapability("note", "n1", "edit");
  const r = await upload("n1", PNG, { headers: { authorization: `Capability ${edit}` } });
  assert.equal(r.status, 201);
  const view = makeCapability("note", "n1", "view");
  assert.equal((await upload("n1", PNG, { headers: { authorization: `Capability ${view}` } })).status, 403);
  assert.equal((await get(id, { headers: { authorization: `Capability ${view}` } })).status, 200);
  const other = makeCapability("note", "zz", "view");
  assert.equal((await get(id, { headers: { authorization: `Capability ${other}` } })).status, 404);
  const env = { [INPROCESS_ACTOR]: { kind: "user", email: OWNER, role: "owner", vaultId: "primary", grants: [] }, [INPROCESS_CLIENT_KEY]: "mcp:pat:x" };
  assert.equal((await upload("n1", PNG, {}, env)).status, 403);
});

test("sniffing, active-content detection, name sanitising, Content-Disposition", () => {
  assert.equal(sniffAttachment(Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"), MP3_FRAME])), "audio/mpeg");
  assert.equal(sniffAttachment(Buffer.from("OggS\x00", "latin1")), "audio/ogg");
  assert.equal(sniffAttachment(Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ", "latin1")), "audio/wav");
  assert.equal(sniffAttachment(Buffer.from("fLaC\x00", "latin1")), "audio/flac");
  assert.equal(sniffAttachment(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0])), "video/webm");
  assert.equal(sniffAttachment(Buffer.from("\x00\x00\x00\x20ftypisom\x00\x00", "latin1")), "video/mp4");
  assert.equal(sniffAttachment(Buffer.from("\x00\x00\x00\x20ftypM4A \x00\x00", "latin1")), "audio/mp4");
  assert.equal(sniffAttachment(Buffer.from("\x00\x00\x00\x14ftypqt  \x00\x00", "latin1")), "video/quicktime");
  assert.equal(sniffAttachment(PDF), "application/pdf");
  assert.equal(sniffAttachment(ZIPISH), null);
  assert.equal(looksActive(Buffer.from("\n\t <SVG viewBox='0 0 1 1'>")), true);
  assert.equal(looksActive(Buffer.from("<iframe src=x>")), true);
  assert.equal(looksActive(Buffer.from("hello <svg>")), false);
  assert.equal(sanitizeName('../../etc/"pa\r\nss\\wd".txt'), "wd.txt");
  assert.equal(sanitizeName("\u0000"), "file");
  assert.equal(sanitizeName("x".repeat(500)).length, 200);
  assert.equal(contentDisposition("attachment", "résumé \"x\".pdf"), `attachment; filename="r_sum_ _x_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22x%22.pdf`);
});

// ── security review fixes ────────────────────────────────────────────────────

test("M1: a non-primary vault's attachment is authorized against ITS vault, with no X-Prism-Vault on the read", async () => {
  addVaultEntry({ id: "team-b", label: "Team B", url: "http://vault.test", vault: "team-b", token: "t" });
  fv.putIn("team-b", { id: "b1", path: "B/One", content: "", tags: ["bdoc"], metadata: {} });
  const up = await upload("b1", PNG, { cookie: login(OWNER), headers: { "x-prism-vault": "team-b" } });
  assert.equal(up.status, 201, await up.clone().text());
  const { id } = (await up.json()) as { id: string };
  // A person whose only access is a grant on that note IN vault B.
  addGrant({ subject_type: "user", subject: MEMBER, resource_type: "note", resource: "b1", level: "view", created_by: OWNER, vault_id: "team-b" } as never);
  const r = await get(id, { cookie: login(MEMBER) }); // exactly what an <img> sends: no vault header
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  // Access only in the primary vault (same note id, same tag there) → 404.
  fv.put({ id: "b1", content: "", tags: ["bdoc"] });
  grantUser(STRANGER, "note", "b1", "edit");
  grantUser(STRANGER, "tag", "bdoc", "edit");
  assert.equal((await get(id, { cookie: login(STRANGER) })).status, 404);
  // A capability link from another vault never crosses over.
  const primaryLink = makeCapability("note", "b1", "view");
  assert.equal((await get(id, { headers: { authorization: `Capability ${primaryLink}` } })).status, 404);
  // An in-process MCP actor bound to the primary vault is not re-bound.
  const env = { [INPROCESS_ACTOR]: { kind: "user", email: MEMBER, role: "guest", vaultId: "primary", grants: [] }, [INPROCESS_CLIENT_KEY]: "mcp:pat:x" };
  assert.equal((await api.request(`/attachments/${id}`, {}, env as never)).status, 404);
});

test("M4: per-note and per-vault quotas → 413 quota_exceeded with only the scope", async () => {
  configureAttachments({ noteQuotaBytes: PNG.length * 2 + 1 });
  const c = login(OWNER);
  assert.equal((await upload("n1", PNG, { cookie: c })).status, 201);
  assert.equal((await upload("n1", PNG, { cookie: c })).status, 201);
  const over = await upload("n1", PNG, { cookie: c });
  assert.equal(over.status, 413);
  assert.deepEqual(await over.json(), { error: "quota_exceeded", scope: "note" });
  fv.put({ id: "n2", content: "", tags: [] });
  assert.equal((await upload("n2", PNG, { cookie: c })).status, 201, "another note has its own quota");
  configureAttachments({ vaultQuotaBytes: PNG.length * 3 + 1 });
  const vault = await upload("n2", PNG, { cookie: c });
  assert.equal(vault.status, 413);
  assert.deepEqual(await vault.json(), { error: "quota_exceeded", scope: "vault" });
  assert.equal(usedBytes("primary"), PNG.length * 3);
});

test("M4: capability-link uploads get a smaller cap and a lower rate, keyed by the link", async () => {
  configureAttachments({ linkMaxBytes: 500, linkUploadsPerMinute: 2 });
  const edit = makeCapability("note", "n1", "edit");
  const h = { authorization: `Capability ${edit}` };
  const big = await upload("n1", Buffer.concat([PNG, Buffer.alloc(20_000)]), { headers: h });
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { limit: number }).limit, 500);
  // (the refused upload above spent one of the two)
  assert.equal((await upload("n1", PNG, { headers: h })).status, 201);
  assert.equal((await upload("n1", PNG, { headers: h })).status, 429);
  // A signed-in person is unaffected by the link limits.
  assert.equal((await upload("n1", Buffer.concat([PNG, Buffer.alloc(20_000)]), { cookie: login(OWNER) })).status, 201);
});

test("M4: uploads beyond the global concurrency cap wait, then 503 busy", async () => {
  configureAttachments({ maxConcurrentUploads: 1, uploadWaitMs: 30 });
  const real = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/storage/upload")) await gate;
    return real(input as never, init);
  }) as typeof fetch;
  try {
    const c = login(OWNER);
    const first = upload("n1", PNG, { cookie: c });
    await new Promise((r) => setTimeout(r, 20));
    const second = await upload("n1", PNG, { cookie: c });
    assert.equal(second.status, 503);
    assert.deepEqual(await second.json(), { error: "busy" });
    release();
    assert.equal((await first).status, 201);
  } finally {
    globalThis.fetch = real;
  }
});

test("M4: a failed attach after a successful vault upload is recorded as an orphan, never served", async () => {
  fv.failNextAttach = true;
  const r = await upload("n1", PNG, { cookie: login(OWNER) });
  assert.equal(r.status, 502);
  const rows = db.prepare("SELECT id, status, storage_path, size FROM prism_attachments").all() as Array<{ id: string; status: string; storage_path: string; size: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "orphan_attach_failed");
  assert.ok(fv.storage.has(rows[0]!.storage_path), "the bytes are in vault storage");
  assert.equal((await get(rows[0]!.id, { cookie: login(OWNER) })).status, 404);
  assert.equal(usedBytes("primary"), PNG.length, "orphans still count against the quota");
});

test("delete order: a FAILED vault delete leaves the page's attachments intact and downloadable after restore", async () => {
  const { id, url } = await ownerUpload();
  fv.notes.get("n1")!.tags = ["doc", TRASH_TAG];
  fv.failNextNoteDelete = true;
  const del = await api.request("/trash/n1", { method: "DELETE", headers: { cookie: login(OWNER), "content-type": "application/json" } });
  assert.equal(del.status, 502, await del.clone().text());
  // Nothing was purged: the vault row, the stored file and our row are all still there.
  assert.equal(fv.attachments.length, 1);
  assert.equal(fv.storage.size, 1);
  assert.equal((db.prepare("SELECT status FROM prism_attachments WHERE id = ?").get(id) as { status: string }).status, "live");
  // Restore the page: its media still loads.
  fv.notes.get("n1")!.tags = ["doc"];
  const got = await api.request(url.replace(/^\/api/, ""), { headers: { cookie: login(OWNER) } });
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(await got.arrayBuffer()).equals(PNG), true);
});

test("delete order: after a SUCCESSFUL delete the attachments are purged; what cannot be purged is recorded for the sweep", async () => {
  const { id } = await ownerUpload();
  fv.notes.get("n1")!.tags = ["doc", TRASH_TAG];
  const del = await api.request("/trash/n1", { method: "DELETE", headers: { cookie: login(OWNER), "content-type": "application/json" } });
  assert.ok(del.status === 200 || del.status === 204, `delete → ${del.status} ${await del.clone().text()}`);
  assert.equal(fv.notes.has("n1"), false);
  // The vault cascades the attachment row with the note but leaves the file: the purge after
  // the delete cannot unlink it, so the row is an ORPHAN (never served again, never thrown).
  const row = db.prepare("SELECT status, flagged_at, storage_path FROM prism_attachments WHERE id = ?").get(id) as { status: string; flagged_at: string | null; storage_path: string };
  assert.equal(row.status, "orphan_note_deleted");
  assert.ok(row.flagged_at);
  assert.ok(row.storage_path, "the storage path is kept so the bytes can be reclaimed");
  assert.equal((await api.request(`/attachments/${id}`, { headers: { cookie: login(OWNER) } })).status, 404);
  // The owner sweep reports recorded orphans (ids + sizes only), including a failed attach.
  fv.put({ id: "n3", content: "", tags: [] });
  fv.failNextAttach = true;
  assert.equal((await upload("n3", PNG, { cookie: login(OWNER) })).status, 502);
  const sweep = await api.request("/attachments/sweep", { method: "POST", headers: { cookie: login(OWNER), "content-type": "application/json" }, body: "{}" });
  const body = (await sweep.json()) as { recorded: Array<{ id: string; noteId: string; size: number; reason: string }>; recordedBytes: number };
  assert.deepEqual(body.recorded.map((r) => [r.noteId, r.reason]).sort(), [["n1", "note_deleted"], ["n3", "attach_failed"]]);
  assert.equal(body.recorded.find((r) => r.noteId === "n1")!.id, id);
  assert.equal(body.recordedBytes, PNG.length * 2);
  // purgeAttachmentsForNote itself (a note that still exists): vault rows deleted → files unlinked → "deleted".
  fv.put({ id: "n4", content: "", tags: [] });
  const again = await upload("n4", PNG, { cookie: login(OWNER) });
  const id4 = ((await again.json()) as { id: string }).id;
  assert.deepEqual(await purgeAttachmentsForNote("primary", "n4"), { deleted: 1, orphaned: 0 });
  assert.equal((db.prepare("SELECT status FROM prism_attachments WHERE id = ?").get(id4) as { status: string }).status, "deleted");
});

test("M4: owner sweep — dry run reports unreferenced attachments (ids only); a real run flags them, bytes stay", async () => {
  const used = await ownerUpload(PNG, "used.png");
  const cover = await ownerUpload(PNG, "cover.png");
  const loose = await ownerUpload(PNG, "secret-name.png");
  fv.notes.get("n1")!.content = `<p>x</p><img src="${used.url}">`;
  fv.notes.get("n1")!.metadata = { title: "One", cover: cover.url };
  const sweep = (body: unknown, cookie = login(OWNER), headers: Record<string, string> = {}) =>
    api.request("/attachments/sweep", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  grantUser(MEMBER, "note", "n1", "edit");
  assert.equal((await sweep({}, login(MEMBER))).status, 403);
  assert.equal((await sweep({}, login(OWNER), { "sec-fetch-site": "cross-site" })).status, 403);
  const dry = await sweep({});
  assert.equal(dry.status, 200);
  const d = (await dry.json()) as { dryRun: boolean; checked: number; orphans: Array<Record<string, unknown>>; next: string | null };
  assert.equal(d.dryRun, true);
  assert.equal(d.checked, 3);
  assert.deepEqual(d.orphans, [{ id: loose.id, noteId: "n1", size: PNG.length, reason: "unreferenced" }]);
  assert.equal(JSON.stringify(d).includes("secret-name"), false);
  assert.equal((db.prepare("SELECT status FROM prism_attachments WHERE id = ?").get(loose.id) as { status: string }).status, "live", "dry run writes nothing");
  const real = await sweep({ dryRun: false });
  assert.equal(((await real.json()) as { orphans: unknown[] }).orphans.length, 1);
  assert.equal((db.prepare("SELECT status FROM prism_attachments WHERE id = ?").get(loose.id) as { status: string }).status, "orphan_unreferenced");
  assert.equal(fv.storage.size, 3, "the sweep never deletes bytes");
  assert.equal((await get(loose.id, { cookie: login(OWNER) })).status, 200, "a flagged attachment still serves (the block may be restored from history)");
});

test("LOW: a top-level navigation is always a download; a PDF is inline only for the app's frame", async () => {
  const c = login(OWNER);
  const png = await ownerUpload();
  const pdf = await ownerUpload(PDF, "report.pdf");
  const disp = async (id: string, dest?: string) => (await get(id, { cookie: c, headers: dest === undefined ? {} : { "sec-fetch-dest": dest } })).headers.get("content-disposition")!;
  assert.match(await disp(png.id, "image"), /^inline;/);
  assert.match(await disp(png.id, "document"), /^attachment;/);
  assert.match(await disp(pdf.id, "document"), /^attachment;/);
  assert.match(await disp(pdf.id, "iframe"), /^inline;/);
  assert.match(await disp(pdf.id), /^inline;/);
  assert.match(await disp(pdf.id, "image"), /^attachment;/);
});

test("LOW: bidi controls are stripped from filenames", () => {
  assert.equal(sanitizeName("invoice\u202Efdp.exe"), "invoicefdp.exe");
  assert.equal(sanitizeName("a\u2066b\u2069c\u200Ed\u200Fe\u061Cf\u202Ag\u202C.txt"), "abcdefg.txt");
});

test("LOW: MPEG audio needs two consecutive frames (or ID3 + a frame); UTF-16 HTML is active content, not audio", async () => {
  assert.equal(mpegFrameLength(MP3_FRAME, 0), 417);
  assert.equal(sniffAttachment(Buffer.concat([MP3_FRAME, MP3_FRAME])), "audio/mpeg");
  assert.equal(sniffAttachment(MP3_FRAME), null, "one frame header alone is not enough");
  assert.equal(sniffAttachment(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, 0x41), Buffer.from("not a frame")])), null);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<html><script>alert(1)</script></html>", "utf16le")]);
  assert.equal(sniffAttachment(utf16), null);
  assert.equal(looksActive(utf16), true);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("<x-custom onload=alert(1)>", "utf16le").swap16()]);
  assert.equal(looksActive(utf16be), true, "any UTF-16 text starting with < is markup");
  const c = login(OWNER);
  assert.equal((await upload("n1", utf16, { cookie: c, name: "song.mp3" })).status, 415);
  assert.equal((await upload("n1", utf16, { cookie: c, name: "song.mp3", kind: "image" })).status, 415);
  const ok = await upload("n1", Buffer.concat([MP3_FRAME, MP3_FRAME]), { cookie: c, name: "song.mp3" });
  assert.equal(((await ok.json()) as { mimeType: string }).mimeType, "audio/mpeg");
});

test("LOW: the owning-note cache is at most 5 s — a trashed page stops serving without a restart", async (t) => {
  const { id } = await ownerUpload();
  grantUser(MEMBER, "note", "n1", "view");
  const m = login(MEMBER);
  t.mock.timers.enable({ apis: ["Date"] });
  assert.equal((await get(id, { cookie: m })).status, 200);
  fv.notes.get("n1")!.tags = ["doc", TRASH_TAG];
  t.mock.timers.tick(5_001);
  assert.equal((await get(id, { cookie: m })).status, 404);
});

test("system notes take no uploads from a non-owner, whatever their grants", async () => {
  fv.put({ id: "skill1", path: "Docs/Skill", content: "prompt", tags: ["doc", "agent-skill"] });
  fv.put({ id: "meet1", path: "vault/meetings/2026-01-01/Sync", content: "m", tags: ["doc"] });
  grantUser(MEMBER, "tag", "doc", "own");
  const c = login(MEMBER);
  assert.equal((await upload("n1", PNG, { cookie: c })).status, 201, "an ordinary note still takes the upload");
  assert.equal((await upload("skill1", PNG, { cookie: c })).status, 403, "a true system note");
  assert.equal((await upload("meet1", PNG, { cookie: c })).status, 201, "a meeting note is an ordinary editable page");
});
