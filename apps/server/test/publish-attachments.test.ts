/**
 * Wave 3 gaps #6 — attachments of PUBLISHED notes: GET /api/p/:slug/attachments/:id.
 * Anonymous and publication-scoped: only a file whose owning note is in the public
 * set AND still references it is served; a password site needs the unlock cookie;
 * the response is the same hardened one GET /api/attachments/:id builds.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { publish } from "../src/routes/publish";
import { resetTreeForTests } from "../src/tree";
import { configureAttachments } from "../src/routes/attachments";
import { resetAttachmentsForTests } from "../src/attachments";
import { hashPassword } from "../src/auth/password";
import { addGrant, createPublication } from "../src/db";
import { TRASH_TAG } from "@prism/core/pages";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const OWNER = "owner@test.local";
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetAttachmentsForTests();
  configureAttachments({ uploadsPerMinute: 100_000 });
  fv = installFakeVault();
});
afterEach(() => { fv.restore(); configureAttachments(null); });

async function upload(noteId: string, bytes = PNG, name = "pic.png"): Promise<string> {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(bytes)]), name);
  const r = await api.request(`/notes/${noteId}/attachments`, { method: "POST", headers: { cookie: sessionCookie(makeSession(OWNER)), "x-prism-upload": "1" }, body: f });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as { id: string }).id;
}
function publishTag(slug: string, tag: string, extra: { password_hash?: string | null; expires_at?: number | null } = {}) {
  createPublication({ id: slug, resource_type: "tag", resource: tag, template: "wiki", title: null, home_note_id: null, password_hash: extra.password_hash ?? null, theme: null, expires_at: extra.expires_at ?? null, created_by: OWNER });
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: tag, level: "view", created_by: "test" });
}
/** Reference the attachment from the note body, as the editor does. */
const embed = (noteId: string, attId: string) => {
  const n = fv.notes.get(noteId)!;
  fv.put({ ...n, content: `${n.content}<img src="/api/attachments/${attId}">` });
};
const get = (slug: string, id: string, headers: Record<string, string> = {}) => publish.request(`/${slug}/attachments/${id}`, { headers });

test("an anonymous reader loads an image of a published note, with the hardened headers", async () => {
  fv.put({ id: "n1", path: "wiki/alpha", tags: ["wiki"], content: "<p>Alpha</p>" });
  const id = await upload("n1");
  embed("n1", id);
  publishTag("site", "wiki");
  const r = await get("site", id);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(r.headers.get("cache-control"), "private, no-cache");
  assert.match(r.headers.get("content-disposition") ?? "", /^inline/);
  // A top-level navigation is always a download.
  const nav = await get("site", id, { "sec-fetch-dest": "document" });
  assert.match(nav.headers.get("content-disposition") ?? "", /^attachment/);
  // Range + revalidation behave like the signed-in route.
  const part = await get("site", id, { range: "bytes=0-3" });
  assert.equal(part.status, 206);
  assert.equal((await get("site", id, { "if-none-match": r.headers.get("etag")! })).status, 304);
  // The signed-in route still refuses an anonymous caller.
  assert.equal((await api.request(`/attachments/${id}`)).status, 404);
});

test("only attachments of notes IN the publication are served — one uniform 404 otherwise", async () => {
  fv.put({ id: "n1", path: "wiki/alpha", tags: ["wiki"], content: "<p>Alpha</p>" });
  fv.put({ id: "secret", path: "private/secret", tags: ["private"], content: "<p>Secret</p>" });
  fv.put({ id: "priv", path: "wiki/mine", tags: ["wiki"], content: "<p>Mine</p>", metadata: { prism_visibility: "private", prism_creator: OWNER } });
  fv.put({ id: "trashed", path: "wiki/old", tags: ["wiki"], content: "<p>Old</p>" });
  const [inSet, outOfSet, privateOne, trashedOne] = [await upload("n1"), await upload("secret"), await upload("priv"), await upload("trashed")];
  embed("n1", inSet); embed("secret", outOfSet); embed("priv", privateOne); embed("trashed", trashedOne);
  fv.put({ ...fv.notes.get("trashed")!, tags: ["wiki", TRASH_TAG] });
  publishTag("site", "wiki");
  publishTag("other", "elsewhere");

  assert.equal((await get("site", inSet)).status, 200);
  const bodies = new Set<string>();
  for (const [slug, id] of [["site", outOfSet], ["site", privateOne], ["site", trashedOne], ["other", inSet], ["site", "a_AAAAAAAAAAAAAAAAAAAAAA"], ["site", "../../etc"], ["site", "n1"]] as const) {
    const r = await get(slug, id);
    assert.equal(r.status, 404, `${slug}/${id}`);
    bodies.add(await r.text());
  }
  assert.deepEqual([...bodies], ['{"error":"not_found"}'], "missing, out-of-set, private and trashed are indistinguishable");
  assert.equal((await get("nope", inSet)).status, 404);
});

test("a file the page no longer references is not public; a files property or cover counts as a reference", async () => {
  fv.put({ id: "n1", path: "wiki/alpha", tags: ["wiki"], content: "<p>Alpha</p>" });
  fv.put({ id: "n2", path: "wiki/beta", tags: ["wiki"], content: "<p>Beta</p>" });
  const removed = await upload("n1");
  const cover = await upload("n2");
  const file = await upload("n2", PDF, "report.pdf");
  fv.put({ ...fv.notes.get("n2")!, metadata: { cover: `/api/attachments/${cover}`, files: [`[report.pdf](/api/attachments/${file})`] } });
  publishTag("site", "wiki");
  assert.equal((await get("site", removed)).status, 404, "uploaded, never (or no longer) in the page");
  assert.equal((await get("site", cover)).status, 200);
  const pdf = await get("site", file);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'self'");
  assert.equal(pdf.headers.get("x-frame-options"), "SAMEORIGIN");
  // An attachment id referenced from ANOTHER published page is not served through it:
  // the row's own note must reference it.
  fv.put({ ...fv.notes.get("n2")!, content: `<img src="/api/attachments/${removed}">` });
  assert.equal((await get("site", removed)).status, 404);
});

test("a password site needs the unlock cookie; an expired or excluded page serves nothing", async () => {
  fv.put({ id: "n1", path: "wiki/alpha", tags: ["wiki"], content: "<p>Alpha</p>" });
  const id = await upload("n1");
  embed("n1", id);
  publishTag("locked", "wiki", { password_hash: hashPassword("open sesame") });
  assert.equal((await get("locked", id)).status, 401);
  const auth = await publish.request("/locked/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "open sesame" }) });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await get("locked", id, { cookie })).status, 200);
  // Another site's cookie does not unlock this one.
  assert.equal((await get("locked", id, { cookie: cookie.replace("pub_locked", "pub_other") })).status, 401);
});

test("an expired publication serves nothing", async () => {
  fv.put({ id: "n1", path: "wiki/alpha", tags: ["wiki"], content: "<p>Alpha</p>" });
  const id = await upload("n1");
  embed("n1", id);
  publishTag("dead", "wiki", { expires_at: Date.now() - 1000 });
  assert.equal((await get("dead", id)).status, 404);
});

test("review low 8: a small global in-flight cap — a held stream makes the next public read wait, then 503", async () => {
  const { configurePublicAttachments } = await import("../src/routes/publish");
  fv.put({ id: "n1", path: "wiki/alpha", tags: ["wiki"], content: "<p>Alpha</p>" });
  const id = await upload("n1");
  embed("n1", id);
  publishTag("site", "wiki");
  configurePublicAttachments({ maxInflight: 1, waitMs: 30 });
  try {
    const held = await get("site", id); // body not read: the slot is still taken
    assert.equal(held.status, 200);
    const refused = await get("site", id);
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "2");
    await held.arrayBuffer(); // finished → slot released
    const next = await get("site", id);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
    // A cancelled download releases its slot too.
    const cancelled = await get("site", id);
    assert.equal(cancelled.status, 200);
    await cancelled.body!.cancel();
    const after = await get("site", id);
    assert.equal(after.status, 200);
    await after.arrayBuffer();
    // 304 / errors never hold a slot.
    assert.equal((await get("site", "a_AAAAAAAAAAAAAAAAAAAAAA")).status, 404);
    assert.equal((await get("site", id, { "if-none-match": `"${id}"` })).status, 304);
    const last = await get("site", id);
    assert.equal(last.status, 200);
    await last.arrayBuffer();
  } finally {
    configurePublicAttachments(null);
  }
});
