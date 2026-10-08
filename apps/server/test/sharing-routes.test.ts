/**
 * Sharing reads (routes/sharing.ts) and history attribution (wave 2D):
 *  - GET /api/shared-with-me lists only what was shared with the caller and is
 *    still viewable, top level only, naming the sharer by display name only;
 *  - GET /api/comments indexes comment threads across VIEWABLE pages only, and
 *    marks the caller's own comments without exposing actor ids;
 *  - GET /api/notes/:id/activity names people only for callers who may manage
 *    the page's access;
 *  - GET /api/notes/:id/access-preview warns before a move drops inherited access;
 *  - version history names the writer by kind/name, never by email, for non-owners;
 *  - collab stores stamp the writer (edit / suggestion / agent).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetPagesForTests } from "../src/pages";
import { addGrant, saveDocState, setAccount, setUserProfile, ensureUser } from "../src/db";
import { documentActorId } from "../src/human-collab";
import { noteCollabWriter, storeDocumentState } from "../src/collab";
import { versionWriter, changeValue, changeKindOf } from "../src/sharing";
import { writerIdFor } from "../src/writer-stamp";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

let fv: FakeVault;
const OWNER = "owner@test.local";
const BOB = "bob@test.local";
const CAROL = "carol@test.local";

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetPagesForTests();
  fv = installFakeVault();
  fv.put({ id: "p", path: "vault/Projects/Prism", content: "<p>page</p>" });
  fv.put({ id: "c1", path: "vault/Projects/Prism/Plan", content: "<p>child</p>" });
  fv.put({ id: "solo", path: "vault/Notes/Solo", content: "<p>solo</p>" });
  fv.put({ id: "hidden", path: "vault/Secret/Plans", content: "<p>secret</p>" });
  for (const e of [BOB, CAROL]) setAccount(e, e, "hash");
  setUserProfile(OWNER, { name: "Olive Owner" });
  setUserProfile(BOB, { name: "Bob Builder" });
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
});

const as = (email: string) => sessionCookie(makeSession(email));
const get = (path: string, cookie: string) => api.request(path, { headers: { cookie } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const pageGrant = (email: string, id: string, level: "view" | "suggest" | "edit" = "view", by = OWNER) =>
  addGrant({ subject_type: "user", subject: email, resource_type: "page", resource: id, level, created_by: by });

function docWithThread(threadId: string, items: Array<Record<string, unknown>>, resolved = false): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const t = new Y.Map<unknown>();
    t.set("id", threadId);
    t.set("quote", "page");
    t.set("resolved", resolved);
    const arr = new Y.Array<Record<string, unknown>>();
    arr.push(items);
    t.set("comments", arr);
    doc.getMap("comments").set(threadId, t);
  });
  return Y.encodeStateAsUpdate(doc);
}

// ── shared with me ───────────────────────────────────────────────────────────

test("shared-with-me lists pages shared with the caller, top level only, named by sharer name", async () => {
  pageGrant(BOB, "p");
  grantUser(BOB, "note", "solo", "suggest");
  grantUser(BOB, "note", "c1", "view"); // inside the shared page: shown under it, not at top level
  grantUser(BOB, "tag", "team", "view");
  const r = await get("/shared-with-me", as(BOB));
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.deepEqual(body.items.map((i: { id: string; scope: string }) => [i.id, i.scope]).sort(), [["p", "page"], ["solo", "note"]]);
  const p = body.items.find((i: { id: string }) => i.id === "p");
  assert.equal(p.title, "Prism");
  assert.deepEqual(p.sharedBy, { name: "Olive Owner" });
  assert.ok(!JSON.stringify(body).includes(OWNER), "the sharer's email is never sent");
  assert.ok(!JSON.stringify(body).includes("hidden"));
  assert.deepEqual(body.tags.map((t: { tag: string }) => t.tag), ["team"]);
});

test("shared-with-me: nothing for a user with no grants; 401 for links and anon; trashed/deleted pages drop out", async () => {
  assert.deepEqual((await json(await get("/shared-with-me", as(CAROL)))).items, []);
  const link = makeCapability("note", "solo", "view");
  assert.equal((await api.request("/shared-with-me", { headers: { authorization: `Capability ${link}` } })).status, 401);
  assert.equal((await api.request("/shared-with-me")).status, 401);
  grantUser(CAROL, "note", "solo", "view");
  fv.notes.delete("solo");
  resetTreeForTests();
  assert.deepEqual((await json(await get("/shared-with-me", as(CAROL)))).items, []);
});

// ── comment index ────────────────────────────────────────────────────────────

test("comment index covers viewable pages only and marks the caller's own comments", async () => {
  pageGrant(BOB, "p");
  saveDocState("c1", docWithThread("t1", [
    { author: "Bob Builder", actorId: documentActorId(`user:${BOB}`), text: "mine", createdAt: 10 },
    { author: "Olive Owner", text: "reply", createdAt: 20 },
  ]), null);
  saveDocState("hidden", docWithThread("t2", [{ author: "Olive Owner", text: "secret thread", createdAt: 30 }]), null);
  saveDocState("solo", docWithThread("t3", [{ author: "Olive Owner", text: "done", createdAt: 5 }], true), null);
  const all = await json(await get("/comments", as(BOB)));
  assert.deepEqual(all.threads.map((t: { threadId: string }) => t.threadId), ["t1"]);
  assert.ok(!JSON.stringify(all).includes("secret thread"));
  assert.ok(!JSON.stringify(all).includes("actorId") && !JSON.stringify(all).includes("h_"));
  assert.deepEqual(all.threads[0].comments.map((c: { mine: boolean }) => c.mine), [true, false]);
  const owner = await json(await get("/comments?unresolved=1", as(OWNER)));
  assert.deepEqual(owner.threads.map((t: { threadId: string }) => t.threadId), ["t2", "t1"]);
  const mine = await json(await get("/comments?mine=1", as(BOB)));
  assert.equal(mine.threads.length, 1);
  assert.equal((await get("/comments?note=hidden", as(BOB))).status, 404);
  assert.equal((await get("/comments?note=vault%2FProjects%2FPrism", as(OWNER))).status, 404, "path alias");
  assert.deepEqual((await json(await get("/comments?note=c1", as(BOB)))).threads.map((t: { threadId: string }) => t.threadId), ["t1"]);
});

// ── activity + move preview ──────────────────────────────────────────────────

test("activity names people only for callers who manage access; inherited shares carry their source", async () => {
  pageGrant(BOB, "p", "suggest");
  ensureUser(CAROL);
  addGrant({ subject_type: "user", subject: CAROL, resource_type: "note", resource: "c1", level: "view", created_by: OWNER, caps: ["view", "share"] });
  const asOwner = await json(await get("/notes/c1/activity", as(OWNER)));
  assert.equal(asOwner.sharesVisible, true);
  const inherited = asOwner.shares.find((s: { email: string }) => s.email === BOB);
  assert.deepEqual(inherited.inheritedFrom, { id: "p", title: "Prism" });
  const asBob = await json(await get("/notes/c1/activity", as(BOB)));
  assert.equal(asBob.sharesVisible, false);
  assert.deepEqual(asBob.shares, []);
  assert.ok(!JSON.stringify(asBob).includes(CAROL));
  assert.equal((await json(await get("/notes/c1/activity", as(CAROL)))).sharesVisible, true, "a share-cap holder manages access");
  assert.equal((await get("/notes/hidden/activity", as(BOB))).status, 404);
});

test("access preview: moving a sub-page out of a shared page warns who loses access", async () => {
  pageGrant(BOB, "p", "edit");
  const owner = await json(await get("/notes/c1/access-preview?parent=vault/Notes", as(OWNER)));
  assert.equal(owner.willChange, true);
  assert.equal(owner.losing, 1);
  assert.deepEqual(owner.changes.map((c: { email: string; from: string; to: string | null }) => [c.email, c.from, c.to]), [[BOB, "edit", null]]);
  const stay = await json(await get("/notes/c1/access-preview?parent=vault/Projects/Prism", as(OWNER)));
  assert.equal(stay.willChange, false);
  // Moving the shared page itself never changes what its own share gives.
  assert.equal((await json(await get("/notes/p/access-preview?parent=vault/Notes", as(OWNER)))).willChange, false);
  // A destination the caller cannot add to answers like a missing page (review M1)…
  assert.equal((await get("/notes/c1/access-preview?parent=vault/Notes", as(BOB))).status, 404);
  // …and one they can add to tells an editor without share only THAT access would change.
  fv.put({ id: "dest", path: "vault/Dest", content: "<p>dest</p>" });
  resetTreeForTests();
  addGrant({ subject_type: "user", subject: BOB, resource_type: "note", resource: "dest", level: "view", created_by: OWNER, caps: ["view", "create"] });
  pageGrant(CAROL, "p", "view");
  const bob = await json(await get("/notes/c1/access-preview?parent=vault/Dest", as(BOB)));
  assert.deepEqual(Object.keys(bob), ["willChange"]);
  assert.equal(bob.willChange, true);
  assert.equal((await get("/notes/c1/access-preview?parent=../x", as(OWNER))).status, 400);
});

// ── history attribution ──────────────────────────────────────────────────────

const stamped = (email: string, kind: "edit" | "agent" | "suggestion" | "accepted-suggestion", at = "2026-01-02T00:00:00.000Z") => ({
  prism_last_writer: email === "link" ? "link" : writerIdFor(email),
  prism_last_write_at: at,
  prism_last_change: changeValue(kind, at),
});

test("versionWriter classifies by stamp and channel; names only for signed-in viewers", () => {
  assert.deepEqual(versionWriter(stamped(BOB, "edit"), null, BOB), { kind: "person", name: "Bob Builder", self: true });
  assert.deepEqual(versionWriter(stamped(BOB, "edit"), null, null), { kind: "person", name: null, self: false }, "a link guest gets no name");
  assert.equal(versionWriter(stamped(BOB, "agent"), null, CAROL).kind, "agent");
  assert.equal(versionWriter(stamped(BOB, "accepted-suggestion"), null, CAROL).kind, "accepted-suggestion");
  assert.equal(versionWriter(stamped("link", "edit"), null, CAROL).kind, "guest");
  assert.equal(versionWriter(null, "mcp", null).kind, "agent");
  assert.deepEqual(versionWriter(null, null, null), { kind: "unknown", name: null, self: false });
  // A kind recorded for an OLDER stamp is ignored once a later stamp replaced the writer.
  const later = { ...stamped(BOB, "agent"), prism_last_write_at: "2026-01-03T00:00:00.000Z" };
  assert.equal(versionWriter(later, null, CAROL).kind, "person");
  // The CURRENT note: written again long after its stamp → changed outside Prism, never a wrong name.
  assert.equal(versionWriter(stamped(BOB, "edit"), null, CAROL, undefined, "2026-02-01T00:00:00.000Z").kind, "external");
});

test("non-owner version history names the writer by kind and name, never by email or stamp", async () => {
  pageGrant(BOB, "p", "edit");
  fv.notes.get("c1")!.metadata = stamped(OWNER, "edit");
  const patch = await api.request("/notes/c1", { method: "PATCH", headers: { cookie: as(BOB), "content-type": "application/json" }, body: JSON.stringify({ content: "<p>v2</p>", if_updated_at: fv.notes.get("c1")!.updatedAt }) });
  assert.equal(patch.status, 200);
  const r = await json(await get("/notes/c1/versions", as(BOB)));
  assert.ok(r.versions.length >= 1);
  assert.deepEqual(r.versions[0].writer, { kind: "person", name: "Olive Owner", self: false });
  assert.ok(!JSON.stringify(r).includes(OWNER) && !JSON.stringify(r).includes("prism_last_"), "no email, no stamp keys");
  // The activity read names the stamps of THIS page for a signed-in viewer (the owner path resolves raw stamps with it).
  const act = await json(await get("/notes/c1/activity", as(BOB)));
  assert.equal(act.me, writerIdFor(BOB));
  assert.equal(act.writers[writerIdFor(OWNER)], "Olive Owner");
  assert.equal(act.writers[writerIdFor(BOB)], "Bob Builder");
  assert.deepEqual(act.lastEditor, { kind: "person", name: "Bob Builder", self: true });
});

test("a collab store stamps the most recent writer (opaque id) and the kind of change", async () => {
  const doc = new Y.Doc();
  doc.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
  (doc.getXmlFragment("default").get(0) as Y.XmlElement).insert(0, [new Y.XmlText("hello")]);
  noteCollabWriter("solo", BOB, "edit");
  noteCollabWriter("solo", CAROL, "suggestion");
  await storeDocumentState("solo", doc);
  const meta = fv.notes.get("solo")!.metadata!;
  assert.equal(meta.prism_last_writer, writerIdFor(CAROL));
  assert.ok(!JSON.stringify(meta).includes("@test.local"), "no email is stored");
  assert.equal(changeKindOf(meta), "suggestion");
  assert.equal(typeof meta.prism_last_write_at, "string");
  // No recorded writer (a server-internal store) leaves the stamp alone.
  (doc.getXmlFragment("default").get(0) as Y.XmlElement).insert(0, [new Y.XmlText("x")]);
  await storeDocumentState("solo", doc);
  assert.equal(fv.notes.get("solo")!.metadata?.prism_last_writer, writerIdFor(CAROL));
});
