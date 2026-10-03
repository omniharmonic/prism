/**
 * Page-subtree grants (NP-CO-09): "sharing a page shares its sub-pages".
 *
 * A `page` grant is anchored on a note ID and reaches the page plus every note
 * under its CURRENT path. Pinned here, through the real gateway, pages API, ACL
 * router, tree projection, collab socket authorization and SSE:
 *  - descendants inherit; siblings sharing a name prefix do not;
 *  - moving a sub-page OUT (pages API) drops its inherited access, moving it back
 *    restores it; moving the SHARED page keeps its subtree shared (the grant
 *    follows the id); a new page at the anchor's OLD path inherits nothing;
 *  - the nearest shared ancestor wins (restrict / expand a child explicitly);
 *  - private pages and trashed anchors never inherit;
 *  - per-note and tag grants behave exactly as before.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { acl } from "../src/routes/acl";
import { resolveLevel } from "../src/collab";
import { ensureTree, resetTreeForTests } from "../src/tree";
import { resetPagesForTests } from "../src/pages";
import { addGrant, setAccount, getVaultRegistry, grantsForResource } from "../src/db";
import { effectiveCaps, effectiveLevel, setPageAnchorResolver, type NoteRef } from "../src/permissions";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";
import type { Grant } from "../src/db";

let fv: FakeVault;
const OWNER = "owner@test.local";
const BOB = "bob@test.local";
const CAROL = "carol@test.local";
const J = { "content-type": "application/json" };

beforeEach(async () => {
  resetDb();
  resetTreeForTests();
  resetPagesForTests();
  fv = installFakeVault();
  fv.put({ id: "p", path: "vault/Projects/Prism", content: "<p>page</p>", tags: ["team"] });
  fv.put({ id: "c1", path: "vault/Projects/Prism/Plan", content: "<p>child</p>" });
  fv.put({ id: "c2", path: "vault/Projects/Prism/Plan/Week 1", content: "<p>grandchild</p>" });
  fv.put({ id: "sib", path: "vault/Projects/Prismatic", content: "<p>not a child</p>" });
  fv.put({ id: "dest", path: "vault/Archive", content: "<p>archive</p>" });
  for (const e of [BOB, CAROL]) setAccount(e, e, "hash");
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
});

const as = (email: string) => sessionCookie(makeSession(email));
function req(app: typeof api | typeof acl, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return app.request(path, { ...init, headers });
}
const get = (path: string, who: string) => req(api, path, { cookie: as(who) });
const status = async (path: string, who: string) => (await get(path, who)).status;
const move = (id: string, parent: string) =>
  req(api, `/notes/${id}/move`, { method: "POST", cookie: as(OWNER), headers: J, body: JSON.stringify({ newParentPath: parent, if_updated_at: fv.notes.get(id)!.updatedAt }) });
const pageGrant = (email: string, id: string, level: Grant["level"]) =>
  addGrant({ subject_type: "user", subject: email, resource_type: "page", resource: id, level, created_by: OWNER });

// ── pure semantics ───────────────────────────────────────────────────────────

test("pure: a page grant reaches the anchor, its descendants, and nothing else; unknown anchor = id only", () => {
  const anchors = new Map([["p", "a/b"]]);
  const prev = setPageAnchorResolver((_v, id) => (anchors.has(id) ? { path: anchors.get(id)! } : null));
  try {
    const g: Grant[] = [{ id: "g", vault_id: "primary", subject_type: "user", subject: BOB, resource_type: "page", resource: "p", level: "edit", created_by: null, created_at: 0, expires_at: null, caps: null }];
    const ref = (id: string, path: string, extra: Partial<NoteRef> = {}): NoteRef => ({ id, tags: [], path, ...extra });
    assert.equal(effectiveLevel(g, ref("p", "a/b"), null), "edit");
    assert.equal(effectiveLevel(g, ref("x", "a/b/c"), null), "edit");
    assert.equal(effectiveLevel(g, ref("y", "a/b/c/d"), null), "edit");
    assert.equal(effectiveLevel(g, ref("z", "a/bc"), null), null, "a sibling sharing the prefix");
    assert.equal(effectiveLevel(g, ref("z", "a"), null), null, "the parent");
    assert.equal(effectiveLevel(g, { id: "x", tags: [] }, null), null, "a ref without a path never inherits");
    assert.equal(effectiveLevel(g, ref("x", "a/b/c", { visibility: "private", creator: "someone" }), null), null, "private never inherits");
    assert.equal(effectiveLevel(g, ref("p", "a/b", { visibility: "private", creator: "someone" }), null), "edit", "a page grant ON a private page is an explicit share");
    anchors.delete("p");
    assert.equal(effectiveLevel(g, ref("x", "a/b/c"), null), null, "unknown anchor → descendants fail closed");
    assert.equal(effectiveLevel(g, ref("p", "a/b"), null), "edit", "…but the anchor itself still matches by id");
  } finally {
    setPageAnchorResolver(prev);
  }
});

test("pure: the nearest shared ancestor wins among page grants; other grant kinds still union", () => {
  const anchors = new Map([["p", "a"], ["c", "a/b"]]);
  const prev = setPageAnchorResolver((_v, id) => (anchors.has(id) ? { path: anchors.get(id)! } : null));
  try {
    const mk = (resource: string, level: Grant["level"], type: Grant["resource_type"] = "page"): Grant => ({ id: resource + level, vault_id: "primary", subject_type: "user", subject: BOB, resource_type: type, resource, level, created_by: null, created_at: 0, expires_at: null, caps: null });
    const restricted = [mk("p", "edit"), mk("c", "view")];
    assert.equal(effectiveLevel(restricted, { id: "c", tags: [], path: "a/b" }, null), "view", "restricted on the child");
    assert.equal(effectiveLevel(restricted, { id: "d", tags: [], path: "a/b/d" }, null), "view", "…and below it");
    assert.equal(effectiveLevel(restricted, { id: "e", tags: [], path: "a/e" }, null), "edit", "siblings keep the parent's");
    const expanded = [mk("p", "view"), mk("c", "edit")];
    assert.ok(effectiveCaps(expanded, { id: "d", tags: [], path: "a/b/d" }, null).has("edit"), "expanded on the child");
    const withTag = [...restricted, mk("team", "edit", "tag")];
    assert.equal(effectiveLevel(withTag, { id: "c", tags: ["team"], path: "a/b" }, null), "edit", "a tag grant is not restricted by a page grant");
  } finally {
    setPageAnchorResolver(prev);
  }
});

// ── through the gateway ──────────────────────────────────────────────────────

test("sharing a page shares its sub-pages (read, list, tree) but not siblings", async () => {
  pageGrant(BOB, "p", "view");
  for (const id of ["p", "c1", "c2"]) assert.equal(await status(`/notes/${id}`, BOB), 200, id);
  assert.equal(await status("/notes/sib", BOB), 403);
  assert.equal(await status("/notes/dest", BOB), 403);
  const list = (await (await get("/notes", BOB)).json()) as Array<{ id: string }>;
  assert.deepEqual(list.map((n) => n.id).sort(), ["c1", "c2", "p"]);
  const tree = (await (await get("/tree", BOB)).json()) as Array<{ id: string }>;
  assert.deepEqual(tree.map((n) => n.id).sort(), ["c1", "c2", "p"]);
  // Writes need the level: view → no PATCH.
  const patch = await req(api, "/notes/c1", { method: "PATCH", cookie: as(BOB), headers: J, body: JSON.stringify({ content: "x", if_updated_at: fv.notes.get("c1")!.updatedAt }) });
  assert.equal(patch.status, 403);
});

test("the first request after boot already sees sub-pages (the tree is warmed before deciding)", async () => {
  pageGrant(BOB, "p", "view");
  resetTreeForTests(); // nothing loaded
  assert.equal(await status("/notes/c2", BOB), 200);
});

test("moving a sub-page OUT via the pages API drops inherited access; moving it back restores it", async () => {
  pageGrant(BOB, "p", "edit");
  await ensureTree(getVaultRegistry()[0]!);
  assert.equal(await status("/notes/c1", BOB), 200);
  assert.equal((await move("c1", "vault/Archive")).status, 200);
  assert.equal(fv.notes.get("c1")!.path, "vault/Archive/Plan");
  assert.equal(await status("/notes/c1", BOB), 403, "moved out → no longer inherited");
  assert.equal(await status("/notes/c2", BOB), 403, "its own sub-pages went with it");
  const tree = (await (await get("/tree", BOB)).json()) as Array<{ id: string }>;
  assert.deepEqual(tree.map((n) => n.id), ["p"]);
  assert.equal((await move("c1", "vault/Projects/Prism")).status, 200);
  assert.equal(await status("/notes/c1", BOB), 200, "moved back in → inherited again");
  assert.equal(await status("/notes/c2", BOB), 200);
});

test("moving the SHARED page keeps its subtree shared; a new page at the old path inherits nothing", async () => {
  pageGrant(BOB, "p", "view");
  assert.equal((await move("p", "vault/Archive")).status, 200);
  assert.equal(fv.notes.get("c2")!.path, "vault/Archive/Prism/Plan/Week 1");
  for (const id of ["p", "c1", "c2"]) assert.equal(await status(`/notes/${id}`, BOB), 200, id);
  fv.put({ id: "imposter", path: "vault/Projects/Prism/Secret", content: "<p>new</p>" });
  assert.equal(await status("/notes/imposter", BOB), 403, "the grant followed the page id, not its old path");
});

test("moving a page INTO a shared page grants it; private and trashed are never inherited", async () => {
  pageGrant(BOB, "p", "view");
  assert.equal(await status("/notes/sib", BOB), 403);
  assert.equal((await move("sib", "vault/Projects/Prism")).status, 200);
  assert.equal(await status("/notes/sib", BOB), 200);
  fv.put({ id: "priv", path: "vault/Projects/Prism/Mine", content: "<p>x</p>", metadata: { prism_creator: OWNER, prism_visibility: "private" } });
  assert.equal(await status("/notes/priv", BOB), 403, "a private page inside a shared page stays private");
  const trash = await req(api, "/notes/p/trash", { method: "POST", cookie: as(OWNER), headers: J, body: "{}" });
  assert.equal(trash.status, 200);
  // A trashed page shares nothing with LIVE notes under its old path (its own trashed
  // group stays reachable for whoever may restore it — review M-D).
  fv.put({ id: "after", path: "vault/Projects/Prism/After", content: "<p>created while the page is in the Trash</p>" });
  resetTreeForTests();
  assert.equal(await status("/notes/after", BOB), 403, "a trashed page shares nothing");
  const tree = (await (await get("/tree", BOB)).json()) as Array<{ id: string }>;
  assert.deepEqual(tree.map((n) => n.id), [], "nothing trashed is listed");
});

test("nearest ancestor wins through the gateway: restrict a child to view, expand another to edit", async () => {
  pageGrant(BOB, "p", "edit");
  pageGrant(BOB, "c1", "view");
  const patch = (id: string) => req(api, `/notes/${id}`, { method: "PATCH", cookie: as(BOB), headers: J, body: JSON.stringify({ content: "<p>edited</p>", if_updated_at: fv.notes.get(id)!.updatedAt }) });
  assert.equal((await patch("c2")).status, 403, "restricted below c1");
  assert.equal((await patch("p")).status, 200, "edit on the parent itself");
  pageGrant(CAROL, "p", "view");
  pageGrant(CAROL, "c1", "edit");
  const carol = (id: string) => req(api, `/notes/${id}`, { method: "PATCH", cookie: as(CAROL), headers: J, body: JSON.stringify({ content: "<p>c</p>", if_updated_at: fv.notes.get(id)!.updatedAt }) });
  assert.equal((await carol("c2")).status, 200, "expanded below c1");
  assert.equal((await carol("p")).status, 403);
});

test("note and tag grants are untouched by page grants", async () => {
  grantUser(BOB, "note", "c1", "view");
  assert.equal(await status("/notes/c1", BOB), 200);
  assert.equal(await status("/notes/c2", BOB), 403, "a per-NOTE grant never reaches sub-pages");
  grantUser(CAROL, "tag", "team", "view");
  assert.equal(await status("/notes/p", CAROL), 200);
  assert.equal(await status("/notes/c1", CAROL), 403, "a tag grant reaches only tagged notes");
});

test("collab socket authorization honours page grants (and stops at a moved-out page)", async () => {
  pageGrant(BOB, "p", "suggest");
  const cookie = as(BOB);
  assert.equal(await resolveLevel("c2", "session", cookie), "suggest");
  assert.equal(await resolveLevel("sib", "session", cookie), null);
  assert.equal((await move("c1", "vault/Archive")).status, 200);
  assert.equal(await resolveLevel("c2", "session", cookie), null);
});

// ── the share dialog's API ───────────────────────────────────────────────────

test("PUT /acl/notes/:id/people scope=page shares the subtree; GET shows inherited access with its source", async () => {
  const owner = as(OWNER);
  const put = await req(acl, "/notes/p/people", { method: "PUT", cookie: owner, headers: J, body: JSON.stringify({ email: BOB, level: "suggest", scope: "page" }) });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { scope: string }).scope, "page");
  assert.equal(grantsForResource("page", "p").length, 1);
  assert.equal(await status("/notes/c2", BOB), 200);
  const onChild = (await (await req(acl, "/notes/c2", { cookie: owner })).json()) as {
    inherited: Array<{ email: string; level: string; from: { id: string; title: string } }>;
    parent: { id: string; title: string };
    people: unknown[];
    owner: { email: string | null; name: string | null };
  };
  assert.deepEqual(onChild.inherited.map((p) => [p.email, p.level, p.from.id, p.from.title]), [[BOB, "suggest", "p", "Prism"]]);
  assert.deepEqual(onChild.parent, { id: "c1", title: "Plan" });
  assert.equal(onChild.people.length, 0);
  assert.equal(onChild.owner.email, OWNER);
  // Restrict on the child: an own page grant replaces the inherited row.
  await req(acl, "/notes/c1/people", { method: "PUT", cookie: owner, headers: J, body: JSON.stringify({ email: BOB, level: "view", scope: "page" }) });
  const c1 = (await (await req(acl, "/notes/c1", { cookie: owner })).json()) as { inherited: unknown[]; people: Array<{ email: string; scope: string; level: string }> };
  assert.equal(c1.inherited.length, 0);
  assert.deepEqual(c1.people.map((p) => [p.email, p.scope, p.level]), [[BOB, "page", "view"]]);
  // Switching to "this page only" replaces the page grant (one grant per person per page).
  await req(acl, "/notes/c1/people", { method: "PUT", cookie: owner, headers: J, body: JSON.stringify({ email: BOB, level: "view", scope: "note" }) });
  assert.equal(grantsForResource("page", "c1").length, 0);
  assert.equal(grantsForResource("note", "c1").length, 1);
  // DELETE removes both kinds.
  await req(acl, "/notes/p/people/" + encodeURIComponent(BOB), { method: "DELETE", cookie: owner });
  assert.equal(grantsForResource("page", "p").length, 0);
});

test("a scoped sharer can make a page share only when they can share every sub-page; never by alias or on a private page", async () => {
  addGrant({ subject_type: "user", subject: CAROL, resource_type: "note", resource: "p", level: "view", created_by: OWNER, caps: ["view", "share"] });
  const carol = as(CAROL);
  const refused = await req(acl, "/notes/p/people", { method: "PUT", cookie: carol, headers: J, body: JSON.stringify({ email: BOB, level: "view", scope: "page" }) });
  assert.equal(refused.status, 403);
  const body = (await refused.json()) as Record<string, unknown>;
  assert.ok(!JSON.stringify(body).includes("c1") && !("count" in body), "no sub-page ids or counts");
  // With share on the whole subtree (a page grant carrying share), it is allowed.
  addGrant({ subject_type: "user", subject: CAROL, resource_type: "page", resource: "p", level: "view", created_by: OWNER, caps: ["view", "share"] });
  const ok = await req(acl, "/notes/p/people", { method: "PUT", cookie: carol, headers: J, body: JSON.stringify({ email: BOB, level: "view", scope: "page" }) });
  assert.equal(ok.status, 200);
  fv.put({ id: "priv2", path: "vault/Mine", content: "<p>x</p>", metadata: { prism_creator: OWNER, prism_visibility: "private" } });
  const priv = await req(acl, "/notes/priv2/people", { method: "PUT", cookie: as(OWNER), headers: J, body: JSON.stringify({ email: BOB, level: "view", scope: "page" }) });
  assert.equal(priv.status, 400);
  assert.equal((await req(acl, "/notes/vault%2FProjects%2FPrism", { cookie: as(OWNER) })).status, 404, "a path alias is not the note");
});

test("MCP collab access and sync export visibility honour page grants", async () => {
  const { collabAccess } = await import("../src/mcp/tool-collab");
  const { viewableBy } = await import("../src/worker/sync-visibility");
  pageGrant(BOB, "p", "suggest");
  await ensureTree(getVaultRegistry()[0]!);
  const grants = (await import("../src/db")).grantsForUser(BOB);
  const c2 = fv.notes.get("c2")!;
  assert.equal(collabAccess({ grants, role: "guest", email: BOB }, { id: c2.id, tags: c2.tags, metadata: c2.metadata, path: c2.path }).level, "suggest");
  assert.equal(collabAccess({ grants, role: "guest", email: BOB }, { id: "sib", tags: [], metadata: null, path: "vault/Projects/Prismatic" }).level, null);
  const can = viewableBy(BOB, "primary");
  assert.equal(can(c2 as never), true);
  assert.equal(can(fv.notes.get("sib") as never), false);
});

test("SSE invalidation: a page grant holder receives ids under the shared page only", async () => {
  const { eventFor } = await import("../src/events");
  pageGrant(BOB, "p", "view");
  await ensureTree(getVaultRegistry()[0]!);
  const grants = (await import("../src/db")).grantsForUser(BOB);
  const canView = (r: NoteRef) => effectiveCaps(grants, r, null, BOB).has("view");
  const row = (id: string, path: string) => ({ id, path, tags: [], updatedAt: null, creator: null, visibility: "workspace" as const });
  assert.ok(eventFor({ kind: "upsert", row: row("c9", "vault/Projects/Prism/New"), prev: undefined } as never, canView));
  assert.equal(eventFor({ kind: "upsert", row: row("s9", "vault/Projects/Prismatic/New"), prev: undefined } as never, canView), null);
});
