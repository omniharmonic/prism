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
import { configureAttachments } from "../src/routes/attachments";
import { resetAttachmentsForTests, sanitizeName, contentDisposition } from "../src/attachments";
import { sniffAttachment, looksActive } from "../src/media/sniff-file";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("  \n<!DOCTYPE html><html><script>alert(1)</script></html>");
const ZIPISH = Buffer.from("PK\x03\x04 some opaque archive bytes", "latin1");
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
  assert.equal(r.headers.get("cache-control"), "private, max-age=300");
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
  configureAttachments(null); // drop the 30 s owning-note cache
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
  assert.equal(sniffAttachment(Buffer.from("ID3\x03\x00", "latin1")), "audio/mpeg");
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
