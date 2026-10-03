/**
 * Wave 3 gaps #1 — which editor a suggest-level person gets.
 *
 * The gateway stamps `_review: "governance"` beside `_caps` only when the caller
 * cannot edit AND a grant conferring suggest/create on the note was compiled by
 * governance. A plain "can suggest" share carries no stamp → the client keeps the
 * note in the live suggest-only editor. The stamp is a hint; it never adds a cap.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { addGrant, type ResourceType } from "../src/db";
import { governedReview, type Cap } from "../src/permissions";
import { resetTreeForTests } from "../src/tree";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => { resetDb(); resetTreeForTests(); fv = installFakeVault(); });
afterEach(() => { fv.restore(); resetTreeForTests(); });

const get = (path: string, cookie?: string) => api.request(path, cookie ? { headers: { cookie } } : undefined);
const login = (email: string) => sessionCookie(makeSession(email));
const gov = (email: string, type: ResourceType, resource: string, caps: Cap[]) =>
  addGrant({ subject_type: "user", subject: email, resource_type: type, resource, level: "view", created_by: "governance:role-1", caps });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

test("a plain suggest share carries no review stamp (live suggest editor)", async () => {
  fv.put({ id: "n1", content: "<p>hi</p>", tags: ["team"] });
  grantUser("sam@test.local", "note", "n1", "suggest");
  const note = await json(await get("/notes/n1", login("sam@test.local")));
  assert.ok(note._caps.includes("suggest") && !note._caps.includes("edit"));
  assert.equal(note._review, undefined);
  const list = await json(await get("/notes", login("sam@test.local")));
  assert.equal(list.find((n: { id: string }) => n.id === "n1")._review, undefined);
});

test("suggest from a governance role is stamped for review, on the note and in lists", async () => {
  fv.put({ id: "n1", content: "<p>hi</p>", tags: ["medicine"] });
  fv.put({ id: "n2", content: "<p>other</p>", tags: ["other"] });
  gov("gia@test.local", "tag", "medicine", ["view", "comment", "suggest"]);
  grantUser("gia@test.local", "note", "n2", "suggest");
  const cookie = login("gia@test.local");
  assert.equal((await json(await get("/notes/n1", cookie)))._review, "governance");
  // The governance grant is scoped to its tag: another page shared plainly is not governed.
  assert.equal((await json(await get("/notes/n2", cookie)))._review, undefined);
  const list = await json(await get("/notes", cookie));
  assert.equal(list.find((n: { id: string }) => n.id === "n1")._review, "governance");
});

test("an editor is never stamped, whatever governance also grants", async () => {
  fv.put({ id: "n1", content: "x", tags: ["medicine"] });
  gov("ed@test.local", "tag", "medicine", ["view", "suggest", "create"]);
  grantUser("ed@test.local", "note", "n1", "edit");
  const note = await json(await get("/notes/n1", login("ed@test.local")));
  assert.ok(note._caps.includes("edit"));
  assert.equal(note._review, undefined);
});

test("the stamp never widens access and never reaches a capability link", async () => {
  fv.put({ id: "n1", content: "x", tags: ["medicine"] });
  fv.put({ id: "hidden", content: "x", tags: ["secret"] });
  gov("gia@test.local", "tag", "medicine", ["view", "suggest"]);
  assert.equal((await get("/notes/hidden", login("gia@test.local"))).status, 404);
  const link = makeCapability("note", "n1", "suggest");
  const viaLink = await json(await api.request(`/notes/n1?t=${encodeURIComponent(link)}`));
  assert.equal(viaLink._caps, undefined);
  assert.equal(viaLink._review, undefined);
});

test("governedReview: private notes only count grants on the note itself", () => {
  const g = (resource_type: ResourceType, resource: string, created_by: string, caps: Cap[]) =>
    ({ id: "g", vault_id: "primary", subject_type: "user", subject: "a@test.local", resource_type, resource, level: "view", created_by, created_at: 0, expires_at: null, caps }) as never;
  const priv = { id: "n1", tags: ["medicine"], visibility: "private" as const, creator: "o@test.local" };
  assert.equal(governedReview([g("tag", "medicine", "governance:r", ["view", "suggest"])], priv, null, "a@test.local"), false);
  assert.equal(governedReview([g("note", "n1", "governance:r", ["view", "suggest"])], priv, null, "a@test.local"), true);
  // view-only governance grant: nothing to review.
  assert.equal(governedReview([g("tag", "medicine", "governance:r", ["view"])], { id: "n1", tags: ["medicine"] }, null, "a@test.local"), false);
  // create (drop-box role) counts.
  assert.equal(governedReview([g("tag", "medicine", "governance:r", ["view", "create"])], { id: "n1", tags: ["medicine"] }, null, "a@test.local"), true);
});
