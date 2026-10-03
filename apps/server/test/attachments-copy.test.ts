/**
 * Wave 3 gaps #7 — POST /api/notes/:id/attachments/copy: a duplicated page gets its
 * OWN attachment rows (re-uploaded through the vault under the copy), the copy's
 * references are rewritten, quota is respected, and a failure leaves the copy
 * pointing at nothing — never at the original's file.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { configureAttachments as configureRaw, type AttachmentsConfig } from "../src/routes/attachments";
import { resetAttachmentsForTests, getAttachment, usedBytes } from "../src/attachments";
import { TRASH_TAG, LOCK_KEY } from "@prism/core/pages";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

const configureAttachments = (over: Partial<AttachmentsConfig> | null) => configureRaw({ uploadsPerMinute: 100_000, ...(over ?? {}) });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const J = { "content-type": "application/json" };
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetAttachmentsForTests();
  configureAttachments(null);
  fv = installFakeVault();
  fv.put({ id: "orig", path: "Docs/Original", content: "<p>one</p>", tags: ["doc"] });
});
afterEach(() => { fv.restore(); configureRaw(null); });

const login = (email: string) => sessionCookie(makeSession(email));
async function upload(noteId: string, cookie = login(OWNER), bytes = PNG): Promise<string> {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(bytes)]), "pic.png");
  const r = await api.request(`/notes/${noteId}/attachments`, { method: "POST", headers: { cookie, "x-prism-upload": "1" }, body: f });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as { id: string }).id;
}
const copy = (id: string, cookie: string | null, headers: Record<string, string> = J) =>
  api.request(`/notes/${encodeURIComponent(id)}/attachments/copy`, { method: "POST", headers: { ...headers, ...(cookie ? { cookie } : {}) }, body: "{}" });
const read = (id: string, cookie: string) => api.request(`/attachments/${id}`, { headers: { cookie } });
const idsIn = (text: string) => [...text.matchAll(/\/api\/attachments\/(a_[A-Za-z0-9_-]{22})/g)].map((m) => m[1]!);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

/** What "Duplicate" does on the client: a new note with the original's body + metadata. */
function duplicate(of: string, id: string, extra: Record<string, unknown> = {}) {
  const src = fv.notes.get(of)!;
  fv.put({ id, path: `Docs/${id}`, content: src.content, tags: src.tags, metadata: { ...src.metadata }, ...extra });
}

test("a duplicated page gets its own rows, re-uploaded under the copy; references are rewritten in one CAS write", async () => {
  const a = await upload("orig");
  const b = await upload("orig");
  fv.put({ ...fv.notes.get("orig")!, content: `<p>one</p><img src="/api/attachments/${a}"><img src="/api/attachments/${a}">`, metadata: { cover: `/api/attachments/${b}`, coverY: 40, title: "Original" } });
  duplicate("orig", "dup");
  const before = fv.notes.get("dup")!.updatedAt;
  const storedBefore = fv.storage.size;

  const r = await copy("dup", login(OWNER));
  assert.equal(r.status, 200, await r.clone().text());
  const body = await json(r);
  assert.deepEqual([body.copied, body.failed, body.skipped, body.more], [2, 0, 0, false]);
  const dup = fv.notes.get("dup")!;
  assert.notEqual(dup.updatedAt, before);
  const [na] = [...new Set(idsIn(dup.content))];
  const [nb] = idsIn(String(dup.metadata!.cover));
  assert.ok(na && nb && na !== a && nb !== b && na !== nb);
  assert.equal(idsIn(dup.content).length, 2, "both references to the same file now name the one new row");
  assert.equal(dup.metadata!.coverY, 40, "untouched metadata survives the merge write");
  // New rows belong to the copy, with their own stored bytes.
  for (const id of [na!, nb!]) {
    const row = getAttachment(id)!;
    assert.equal(row.note_id, "dup");
    assert.equal(row.size, PNG.length);
    assert.equal(row.mime, "image/png");
  }
  assert.notEqual(getAttachment(na!)!.storage_path, getAttachment(a)!.storage_path);
  assert.equal(fv.storage.size, storedBefore + 2);
  assert.equal(fv.attachments.filter((x) => x.noteId === "dup").length, 2);
  assert.equal(usedBytes("primary", "dup"), PNG.length * 2);
  // The original is untouched.
  assert.deepEqual(idsIn(fv.notes.get("orig")!.content), [a, a]);
  // Running it again is a no-op (the copy only references its own rows now).
  const again = await json(await copy("dup", login(OWNER)));
  assert.deepEqual([again.copied, again.failed, again.skipped], [0, 0, 0]);
  assert.equal(fv.storage.size, storedBefore + 2);
});

test("a viewer of the copy who cannot see the original loads the copy's files", async () => {
  const a = await upload("orig");
  fv.put({ ...fv.notes.get("orig")!, content: `<img src="/api/attachments/${a}">` });
  duplicate("orig", "dup", { tags: ["shared"] });
  grantUser(MEMBER, "note", "dup", "view");
  // Before the copy: the member sees the page but not the original's file.
  assert.equal((await read(a, login(MEMBER))).status, 404);
  assert.equal((await copy("dup", login(OWNER))).status, 200);
  const [fresh] = idsIn(fv.notes.get("dup")!.content);
  assert.equal((await read(fresh!, login(MEMBER))).status, 200);
  assert.equal((await read(a, login(MEMBER))).status, 404, "the original's file is still not theirs");
});

test("quota: a file that does not fit is not copied and the copy points at nothing", async () => {
  const a = await upload("orig");
  const b = await upload("orig");
  fv.put({ ...fv.notes.get("orig")!, content: `<img src="/api/attachments/${a}"><img src="/api/attachments/${b}">` });
  duplicate("orig", "dup");
  configureAttachments({ noteQuotaBytes: PNG.length + 1 });
  const body = await json(await copy("dup", login(OWNER)));
  assert.deepEqual([body.copied, body.failed], [1, 1]);
  const ids = idsIn(fv.notes.get("dup")!.content);
  assert.equal(ids.length, 2);
  assert.ok(!ids.includes(a) && !ids.includes(b), "neither reference still names the original's rows");
  assert.deepEqual(ids.map((id) => !!getAttachment(id)), [true, false]);
  assert.equal((await read(ids[1]!, login(OWNER))).status, 404);
  assert.equal(usedBytes("primary", "dup"), PNG.length);
});

test("a vault failure while attaching leaves a dangling reference and a recorded orphan", async () => {
  const a = await upload("orig");
  fv.put({ ...fv.notes.get("orig")!, content: `<img src="/api/attachments/${a}">` });
  duplicate("orig", "dup");
  fv.failNextAttach = true;
  const body = await json(await copy("dup", login(OWNER)));
  assert.deepEqual([body.copied, body.failed], [0, 1]);
  const [id] = idsIn(fv.notes.get("dup")!.content);
  assert.notEqual(id, a);
  assert.equal(getAttachment(id!), null);
});

test("permissions: edit on the copy, view on the file's page; nothing is learned about unviewable notes", async () => {
  fv.put({ id: "hidden", path: "Private/Hidden", content: "<p>x</p>", tags: ["secret"] });
  const visible = await upload("orig");
  const secret = await upload("hidden");
  fv.put({ id: "dup", path: "Docs/dup", tags: ["team"], content: `<img src="/api/attachments/${visible}"><img src="/api/attachments/${secret}"><img src="/api/attachments/a_AAAAAAAAAAAAAAAAAAAAAA">` });
  grantUser(MEMBER, "tag", "team", "edit");
  grantUser(MEMBER, "note", "orig", "view");
  const cookie = login(MEMBER);

  const body = await json(await copy("dup", cookie));
  assert.deepEqual([body.copied, body.failed, body.skipped], [1, 0, 2], "unviewable owner and unknown id are one indistinguishable count");
  const ids = idsIn(fv.notes.get("dup")!.content);
  assert.equal(ids[1], secret, "a reference the caller may not copy is left exactly as it was");
  assert.equal(ids[2], "a_AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(getAttachment(ids[0]!)!.note_id, "dup");
  assert.equal(fv.attachments.filter((x) => x.noteId === "dup").length, 1);

  // No edit on the destination → 403; cannot view it → 404, exactly like a missing id or an alias.
  grantUser("viewer@test.local", "note", "dup", "view");
  assert.equal((await copy("dup", login("viewer@test.local"))).status, 403);
  for (const id of ["dup", "nope", "Docs/dup"]) assert.equal((await copy(id, login("stranger@test.local"))).status, 404, id);
  assert.equal((await copy("Docs/dup", login(OWNER))).status, 404, "a path alias is never acted on");
  // Trashed / locked destination.
  fv.put({ ...fv.notes.get("dup")!, metadata: { [LOCK_KEY]: true } });
  assert.equal((await copy("dup", cookie)).status, 409);
  fv.put({ ...fv.notes.get("dup")!, metadata: {}, tags: ["team", TRASH_TAG] });
  assert.equal((await copy("dup", cookie)).status, 404);
});

test("CSRF, credentials: JSON only, same-site refused, anonymous and capability links refused", async () => {
  fv.put({ id: "dup", path: "Docs/dup", tags: ["team"], content: "<p>x</p>" });
  const cookie = login(OWNER);
  assert.equal((await copy("dup", cookie, { "content-type": "text/plain" })).status, 415);
  assert.equal((await copy("dup", cookie, { ...J, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await copy("dup", cookie, { ...J, origin: "https://evil.example" })).status, 403);
  assert.equal((await copy("dup", null)).status, 401);
  const link = makeCapability("note", "dup", "edit");
  assert.equal((await api.request(`/notes/dup/attachments/copy?t=${encodeURIComponent(link)}`, { method: "POST", headers: J, body: "{}" })).status, 401);
  assert.equal((await copy("dup", cookie)).status, 200);
});
