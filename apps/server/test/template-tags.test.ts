/**
 * Review round 3 — templates and the gateway.
 *  BLOCKER: `metadata.prism_template_tags` is re-applied as TAGS when a page is made
 *  from the template, so a non-owner may only write values they could add as tags.
 *  A non-owner note tagged `template` is forced private. A member may save a private
 *  template under Templates/ without any tag grant. Overwriting batches are bounded.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { config } from "../src/config";
import { addGrant, createPublication, setMembership } from "../src/db";
import { resetTreeForTests } from "../src/tree";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

const OWNER = config.ownerEmail;
const ADA = "ada@test.local";
const MEM = "member@test.local";
const GUEST = "guest@test.local";
const J = { "content-type": "application/json", "x-prism-editor-schema": "99" };
let fv: FakeVault;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  fv = installFakeVault();
  grantUser(ADA, "tag", "team", "edit");
  grantUser(ADA, "tag", "template", "edit");
  // `wiki` is published; `finance` is another group's shared tag. Ada has standing in neither.
  createPublication({ id: "site", resource_type: "tag", resource: "wiki", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "wiki", level: "view", created_by: "test" });
  grantUser("cfo@test.local", "tag", "finance", "edit");
  setMembership("primary", MEM, "member", OWNER);
});
afterEach(() => { fv.restore(); resetTreeForTests(); });

const as = (email: string) => ({ ...J, cookie: sessionCookie(makeSession(email)) });
const patch = (id: string, email: string, body: unknown) => api.request(`/notes/${id}`, { method: "PATCH", headers: as(email), body: JSON.stringify(body) });
const create = (email: string, body: unknown) => api.request("/notes", { method: "POST", headers: as(email), body: JSON.stringify(body) });
const stamp = (id: string) => fv.notes.get(id)!.updatedAt;

test("BLOCKER: a non-owner PATCH of prism_template_tags follows the tag rules (governed/published → 403; own or free tags pass; restating passes)", async () => {
  fv.put({ id: "tpl", path: "Templates/Shared", content: "<p>t</p>", tags: ["template"], metadata: { title: "Shared", prism_template_tags: ["finance"] } });
  for (const bad of [["wiki"], ["finance", "wiki"], ["team", "wiki"], ["#wiki"], [" wiki "]]) {
    const r = await patch("tpl", ADA, { metadata: { prism_template_tags: bad }, if_updated_at: stamp("tpl") });
    assert.equal(r.status, 403, JSON.stringify(bad));
    assert.equal(((await r.json()) as { error: string }).error, "forbidden");
  }
  assert.equal((await patch("tpl", ADA, { metadata: { prism_template_tags: ["agent-skill"] }, if_updated_at: stamp("tpl") })).status, 403, "system tag");
  assert.equal((await patch("tpl", ADA, { metadata: { prism_template_tags: ["prism-trashed"] }, if_updated_at: stamp("tpl") })).status, 403, "trash tag");
  for (const invalid of ["wiki", [7], Array.from({ length: 21 }, (_, i) => `t${i}`), [""], { a: 1 }]) {
    assert.equal((await patch("tpl", ADA, { metadata: { prism_template_tags: invalid }, if_updated_at: stamp("tpl") })).status, 400, JSON.stringify(invalid));
  }
  assert.deepEqual(fv.notes.get("tpl")!.metadata!.prism_template_tags, ["finance"], "nothing was written");
  // Restating the stored value (an editor round-trips metadata) is not a change.
  assert.equal((await patch("tpl", ADA, { metadata: { prism_template_tags: ["finance"], title: "Shared 2" }, if_updated_at: stamp("tpl") })).status, 200);
  // Tags she may add (create in `team`) and tags nobody's access hangs on are fine — stored canonical.
  assert.equal((await patch("tpl", ADA, { metadata: { prism_template_tags: ["team", "#ideas"] }, if_updated_at: stamp("tpl") })).status, 200);
  assert.deepEqual(fv.notes.get("tpl")!.metadata!.prism_template_tags, ["team", "ideas"]);
  // The owner is not bound by this (the passthrough).
  assert.equal((await patch("tpl", OWNER, { metadata: { prism_template_tags: ["wiki"] } })).status, 200);
});

test("BLOCKER: a non-owner CREATE carrying prism_template_tags follows the same rule, and a `template` note is forced private", async () => {
  const refused = await create(ADA, { content: "<p>x</p>", path: "Templates/Evil", tags: ["template"], metadata: { prism_template_tags: ["wiki"] } });
  assert.equal(refused.status, 403);
  assert.equal([...fv.notes.values()].some((n) => n.path === "Templates/Evil"), false);
  // A template posted WITHOUT privacy (a hand-made request) is stored private to its creator.
  const ok = await create(ADA, { content: "<p>x</p>", path: "Templates/Mine", tags: ["template"], metadata: { prism_template_tags: ["team"], status: "draft" } });
  assert.equal(ok.status, 200, await ok.clone().text());
  const stored = [...fv.notes.values()].find((n) => n.path === "Templates/Mine")!;
  assert.equal(stored.metadata!.prism_visibility, "private");
  assert.equal(stored.metadata!.prism_creator, ADA);
  assert.deepEqual(stored.metadata!.prism_template_tags, ["team"]);
  // Also when `template` is one tag among others she may use.
  assert.equal((await create(ADA, { content: "x", path: "Team/T", tags: ["team", "template"] })).status, 200);
  assert.equal([...fv.notes.values()].find((n) => n.path === "Team/T")!.metadata!.prism_visibility, "private");
  // An ordinary page is not forced private.
  assert.equal((await create(ADA, { content: "x", path: "Team/Page", tags: ["team"] })).status, 200);
  assert.equal([...fv.notes.values()].find((n) => n.path === "Team/Page")!.metadata!.prism_visibility, undefined);
});

test("should-fix 1: a MEMBER with no tag grant may save a private template under Templates/ — and nothing wider", async () => {
  const ok = await create(MEM, { content: "<p>mine</p>", path: "Templates/My template", tags: ["template"], metadata: { title: "My template" } });
  assert.equal(ok.status, 200, await ok.clone().text());
  const stored = [...fv.notes.values()].find((n) => n.path === "Templates/My template")!;
  assert.equal(stored.metadata!.prism_visibility, "private");
  assert.equal(stored.metadata!.prism_creator, MEM);
  assert.deepEqual(stored.tags, ["template"]);
  // Only that exact shape: one segment below Templates/, only the `template` tag.
  assert.equal((await create(MEM, { content: "x", path: "Templates/a/b", tags: ["template"] })).status, 403, "deeper");
  assert.equal((await create(MEM, { content: "x", path: "Elsewhere/T", tags: ["template"] })).status, 403, "another folder");
  assert.equal((await create(MEM, { content: "x", tags: ["template"] })).status, 403, "no path");
  assert.equal((await create(MEM, { content: "x", path: "Templates/T2", tags: ["template", "finance"] })).status, 403, "a governed tag beside it");
  // Guests (no workspace role) and anonymous callers: no.
  assert.equal((await create(GUEST, { content: "x", path: "Templates/G", tags: ["template"] })).status, 403);
  assert.equal((await api.request("/notes", { method: "POST", headers: J, body: JSON.stringify({ content: "x", path: "Templates/A", tags: ["template"] }) })).status, 403);
});

test("should-fix 4: an overwriting batch is checked whole — paths through the tree projection, a cap instead of truncation", async () => {
  fv.put({ id: "n", path: "Team/N", content: "c", tags: ["team"], metadata: { prism_locked: true } });
  for (let i = 0; i < 30; i++) fv.put({ id: `p${i}`, path: `Team/P${i}`, content: "x", tags: ["team"] });
  const owner = as(OWNER);
  assert.equal((await api.request("/tree", { headers: owner })).status, 200); // the projection is loaded
  const items = (n: number, extra: unknown[] = []) => [...Array.from({ length: n }, (_, i) => ({ path: `Team/P${i % 30}`, content: "y", if_exists: "update" })), ...extra];
  // 30 existing unlocked paths: no per-item vault read.
  let before = fv.calls.length;
  const ok = await api.request("/notes", { method: "POST", headers: owner, body: JSON.stringify({ notes: items(30) }) });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(fv.calls.slice(before).filter((c) => c.method === "GET").length, 0, "paths resolved from the tree projection");
  // The locked page is found by path whatever its letter case, with no vault read either.
  before = fv.calls.length;
  assert.equal((await api.request("/notes", { method: "POST", headers: owner, body: JSON.stringify({ notes: items(5, [{ path: "team/n", content: "over", if_exists: "replace" }]) }) })).status, 423);
  assert.equal(fv.calls.slice(before).length, 0);
  // Past the cap the batch is refused, not partly checked: the locked page hides at the end.
  const big = await api.request("/notes", { method: "POST", headers: owner, body: JSON.stringify({ notes: items(501, [{ path: "Team/N", content: "over", if_exists: "replace" }]) }) });
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { error: string }).error, "batch_too_large");
  assert.equal(fv.notes.get("n")!.content, "c");
  // A large batch that overwrites nothing is not this rule's business.
  assert.equal((await api.request("/notes", { method: "POST", headers: owner, body: JSON.stringify({ notes: Array.from({ length: 600 }, (_, i) => ({ path: `Bulk/N${i}`, content: "n" })) }) })).status, 200);
});
