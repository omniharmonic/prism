/**
 * Pages API (src/pages.ts) through the real gateway app and the fake vault:
 * subtree move, Trash, auto-purge and synced preferences. Invariants:
 *  - a move re-roots the page AND its descendants, one CAS path PATCH each, refuses
 *    its own subtree, protected locations and occupied paths before writing anything,
 *    and reports a partial failure that a second call (fromPath) finishes;
 *  - non-owners need `organize` on every moved note; trash/restore/delete need the
 *    gateway's delete rule on every note; refusals never name notes they can't see;
 *  - trashed pages vanish from the tree, lists and search, come back on restore, and
 *    only something already in the Trash can be deleted for good;
 *  - preferences are per user × vault, bounded, revisioned, and never serve an id
 *    the caller can no longer view.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { runTrashPurgeOnce, resetPagesForTests } from "../src/pages";
import { db } from "../src/db";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";
import { TRASH_TAG } from "@prism/core/pages";

let fv: FakeVault;
const OWNER = "owner@test.local";
const J = { "content-type": "application/json" };

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetPagesForTests();
  fv = installFakeVault();
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
  delete process.env.TRASH_PURGE_ENABLED;
});

function req(path: string, init?: RequestInit & { cookie?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}
const as = (email: string) => sessionCookie(makeSession(email));
const post = (path: string, body: unknown, cookie: string) => req(path, { method: "POST", cookie, headers: J, body: JSON.stringify(body) });
const path = (id: string) => fv.notes.get(id)?.path;
const patches = () => fv.calls.filter((c) => c.method === "PATCH");

function seedTree() {
  fv.put({ id: "p", path: "vault/Projects/Prism", content: "page", tags: ["team"] });
  fv.put({ id: "c1", path: "vault/Projects/Prism/Plan", content: "child", tags: ["team"] });
  fv.put({ id: "c2", path: "vault/Projects/Prism/Plan/Week 1", content: "grandchild", tags: ["team"] });
  fv.put({ id: "sib", path: "vault/Projects/Prismatic", content: "not a child", tags: ["team"] });
  fv.put({ id: "dest", path: "vault/Archive", content: "archive page", tags: ["team"] });
}

// ── move ──────────────────────────────────────────────────────────────────────

test("owner moves a page with its whole subtree, one CAS PATCH per note, shallowest first", async () => {
  seedTree();
  const cookie = as(OWNER);
  const r = await post("/notes/p/move", { newParentPath: "vault/Archive", if_updated_at: fv.notes.get("p")!.updatedAt }, cookie);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { moved: Array<{ id: string; to: string }>; path: string; wikilinks: string };
  assert.equal(body.path, "vault/Archive/Prism");
  assert.deepEqual(body.moved.map((m) => m.id), ["p", "c1", "c2"]);
  assert.equal(path("p"), "vault/Archive/Prism");
  assert.equal(path("c1"), "vault/Archive/Prism/Plan");
  assert.equal(path("c2"), "vault/Archive/Prism/Plan/Week 1");
  assert.equal(path("sib"), "vault/Projects/Prismatic", "a sibling sharing the prefix is not a child");
  assert.equal(body.wikilinks, "vault_cascade");
  for (const call of patches()) {
    const b = call.body as Record<string, unknown>;
    assert.equal(typeof b.if_updated_at, "string", "every path write is CAS");
    assert.ok(!("content" in b) && !("force" in b), "path-only, never forced, never content");
  }
  // The tree projection follows the writes.
  const tree = (await (await req("/tree", { cookie })).json()) as Array<{ id: string; path: string }>;
  assert.equal(tree.find((e) => e.id === "c2")!.path, "vault/Archive/Prism/Plan/Week 1");
});

test("moving to the top level keeps the vault's path convention; newPath renames", async () => {
  seedTree();
  const cookie = as(OWNER);
  const r = await post("/notes/c1/move", { newParentPath: "", if_updated_at: fv.notes.get("c1")!.updatedAt }, cookie);
  assert.equal(r.status, 200);
  assert.equal(path("c1"), "vault/Plan");
  assert.equal(path("c2"), "vault/Plan/Week 1");
  const r2 = await post("/notes/c1/move", { newPath: "vault/Roadmap", if_updated_at: fv.notes.get("c1")!.updatedAt }, cookie);
  assert.equal(r2.status, 200);
  assert.equal(path("c2"), "vault/Roadmap/Week 1");
});

test("refusals happen before any write: own subtree, conflict, protected, missing stamp, bad path", async () => {
  seedTree();
  fv.put({ id: "taken", path: "vault/Archive/Prism/Plan", content: "x" });
  fv.put({ id: "mail", path: "vault/messages/email/hello-123", content: "mail", tags: ["email"] });
  const cookie = as(OWNER);
  const stamp = fv.notes.get("p")!.updatedAt;
  const inside = await post("/notes/p/move", { newParentPath: "vault/Projects/Prism/Plan", if_updated_at: stamp }, cookie);
  assert.equal(inside.status, 400);
  assert.equal(((await inside.json()) as { error: string }).error, "into_own_subtree");
  const clash = await post("/notes/p/move", { newParentPath: "vault/Archive", if_updated_at: stamp }, cookie);
  assert.equal(clash.status, 409);
  assert.deepEqual(await clash.json(), { error: "path_conflict", path: "vault/Archive/Prism/Plan", reason: "A page already exists at vault/Archive/Prism/Plan." });
  assert.equal((await post("/notes/mail/move", { newParentPath: "vault/Archive", if_updated_at: "x" }, cookie)).status, 403);
  assert.equal((await post("/notes/sib/move", { newParentPath: "vault/messages", if_updated_at: fv.notes.get("sib")!.updatedAt }, cookie)).status, 403);
  assert.equal((await post("/notes/sib/move", { newParentPath: "vault/Archive" }, cookie)).status, 428);
  assert.equal((await post("/notes/sib/move", { newParentPath: "../etc", if_updated_at: "x" }, cookie)).status, 400);
  assert.equal(patches().length, 0, "nothing was written");
});

test("a stale page is refused whole; a later descendant failure is partial and resumable", async () => {
  seedTree();
  const cookie = as(OWNER);
  const stale = await post("/notes/p/move", { newParentPath: "vault/Archive", if_updated_at: "2000-01-01T00:00:00.000Z" }, cookie);
  assert.equal(stale.status, 409);
  assert.equal(path("p"), "vault/Projects/Prism");

  // Fail every PATCH of the grandchild once (both the CAS attempt and its retry).
  const inner = globalThis.fetch;
  let failing = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (failing && init?.method === "PATCH" && url.endsWith("/notes/c2")) return new Response("boom", { status: 500 });
    return inner(input, init);
  }) as typeof fetch;
  const partial = await post("/notes/p/move", { newParentPath: "vault/Archive", if_updated_at: fv.notes.get("p")!.updatedAt }, cookie);
  assert.equal(partial.status, 207);
  const body = (await partial.json()) as { error: string; moveId: string; moved: Array<{ id: string }>; failed: { id: string }; resume: { moveId: string; newPath: string } };
  assert.equal(body.error, "partial_move");
  assert.deepEqual(body.moved.map((m) => m.id), ["p", "c1"]);
  assert.equal(body.failed.id, "c2");
  assert.deepEqual(body.resume, { moveId: body.moveId, newPath: "vault/Archive/Prism" });
  assert.equal(path("c2"), "vault/Projects/Prism/Plan/Week 1");

  failing = false;
  const resumed = await post("/notes/p/move", { moveId: body.moveId, if_updated_at: fv.notes.get("p")!.updatedAt }, cookie);
  assert.equal(resumed.status, 200);
  assert.equal(path("c2"), "vault/Archive/Prism/Plan/Week 1");
  globalThis.fetch = inner;
});

test("non-owners need organize on every moved note; links and anon cannot move", async () => {
  seedTree();
  fv.put({ id: "hidden", path: "vault/Projects/Prism/Secret", content: "s", tags: ["private-team"] });
  grantUser("ed@test.local", "tag", "team", "edit");
  const ed = await post("/notes/sib/move", { newParentPath: "vault/Archive", if_updated_at: fv.notes.get("sib")!.updatedAt }, as("ed@test.local"));
  assert.equal(ed.status, 403, "edit does not confer organize (same rule as a gateway path PATCH)");

  grantUser("org@test.local", "tag", "team", "own");
  const ok = await post("/notes/sib/move", { newParentPath: "vault/Archive", if_updated_at: fv.notes.get("sib")!.updatedAt }, as("org@test.local"));
  assert.equal(ok.status, 200);
  const blocked = await post("/notes/p/move", { newParentPath: "vault/Archive", if_updated_at: fv.notes.get("p")!.updatedAt }, as("org@test.local"));
  assert.equal(blocked.status, 403);
  const b = (await blocked.json()) as Record<string, unknown>;
  assert.ok(!("blocked" in b), "no count of notes they can't see");
  assert.ok(!JSON.stringify(b).includes("hidden") && !JSON.stringify(b).includes("Secret"));

  const cap = makeCapability("tag", "team", "own");
  assert.equal((await req("/notes/p/move", { method: "POST", headers: { ...J, authorization: `Capability ${cap}` }, body: "{}" })).status, 403);
  assert.equal((await req("/notes/p/move", { method: "POST", headers: J, body: "{}" })).status, 401);
});

// ── trash ─────────────────────────────────────────────────────────────────────

test("trash hides a page and its subtree everywhere; restore brings the group back", async () => {
  seedTree();
  const cookie = as(OWNER);
  const r = await post("/notes/p/trash", {}, cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as { trashed: string[] }).trashed, ["p", "c1", "c2"]);
  for (const id of ["p", "c1", "c2"]) {
    const n = fv.notes.get(id)!;
    assert.ok(n.tags!.includes(TRASH_TAG), `${id} tagged`);
    assert.equal(n.metadata!.prism_trashed_root, "p");
    assert.equal(n.metadata!.prism_trashed_by, OWNER);
    assert.equal(n.content.length > 0, true, "content untouched");
  }
  const tree = (await (await req("/tree", { cookie })).json()) as Array<{ id: string }>;
  assert.deepEqual(tree.map((e) => e.id).sort(), ["dest", "sib"]);

  const list = (await (await req("/trash", { cookie })).json()) as { items: Array<{ id: string; descendants: number; title: string; trashedBy: string }>; retentionDays: number; autoPurge: boolean };
  assert.deepEqual(list.items.map((i) => [i.id, i.descendants, i.title]), [["p", 2, "Prism"]]);
  assert.equal(list.items[0]!.trashedBy, OWNER);
  assert.equal(list.retentionDays, 30);
  assert.equal(list.autoPurge, false);

  const restored = await post("/trash/p/restore", {}, cookie);
  assert.equal(restored.status, 200);
  for (const id of ["p", "c1", "c2"]) {
    const n = fv.notes.get(id)!;
    assert.ok(!n.tags!.includes(TRASH_TAG));
    assert.ok(!("prism_trashed_at" in (n.metadata ?? {})), "trash metadata cleared");
  }
  const after = (await (await req("/tree", { cookie })).json()) as Array<{ id: string }>;
  assert.equal(after.length, 5);
});

test("non-owner lists and search never include trashed pages; creators may trash their own", async () => {
  seedTree();
  fv.put({ id: "mine", path: "vault/Projects/Mine", content: "findme mine", tags: ["team"], metadata: { prism_creator: "ed@test.local" } });
  grantUser("ed@test.local", "tag", "team", "edit");
  const ed = as("ed@test.local");
  assert.equal((await post("/notes/sib/trash", {}, ed)).status, 403, "an editor can't trash someone else's page");
  assert.equal((await post("/notes/mine/trash", {}, ed)).status, 200);
  const notes = (await (await req("/notes", { cookie: ed })).json()) as Array<{ id: string }>;
  assert.ok(!notes.some((n) => n.id === "mine"));
  const found = (await (await req("/search?q=findme", { cookie: ed })).json()) as Array<{ id: string }>;
  assert.equal(found.length, 0);
  const trash = (await (await req("/trash", { cookie: ed })).json()) as { items: Array<{ id: string; canRestore: boolean }> };
  assert.deepEqual(trash.items.map((i) => [i.id, i.canRestore]), [["mine", true]]);
  // A viewer-only colleague sees nothing to restore.
  grantUser("viv@test.local", "tag", "team", "view");
  const viv = (await (await req("/trash", { cookie: as("viv@test.local") })).json()) as { items: Array<{ canRestore: boolean; trashedBy: string | null }> };
  assert.deepEqual(viv.items.map((i) => [i.canRestore, i.trashedBy]), [[false, null]], "no restore, no other person's email");
  assert.equal((await post("/trash/mine/restore", {}, as("viv@test.local"))).status, 403);
});

test("delete permanently is two-step and removes the whole group; protected notes can't be trashed", async () => {
  seedTree();
  fv.put({ id: "thread", path: "vault/messages/chat/room", content: "chat", tags: ["message-thread"] });
  fv.put({ id: "gov", path: "Governance/config", content: "x", tags: ["governance-config"] });
  const cookie = as(OWNER);
  assert.equal((await post("/notes/thread/trash", {}, cookie)).status, 403);
  assert.equal((await post("/notes/gov/trash", {}, cookie)).status, 403);
  assert.equal((await req("/trash/p", { method: "DELETE", cookie })).status, 409, "not in trash yet");
  assert.equal(fv.notes.has("p"), true);
  await post("/notes/p/trash", {}, cookie);
  const del = await req("/trash/p", { method: "DELETE", cookie });
  assert.equal(del.status, 200);
  assert.deepEqual(((await del.json()) as { deleted: string[] }).deleted, ["c2", "c1", "p"], "deepest first");
  assert.ok(!fv.notes.has("p") && !fv.notes.has("c1") && !fv.notes.has("c2"));
  assert.ok(fv.notes.has("sib"));
});

test("auto-purge is off by default and deletes only pages past the retention window", async () => {
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();
  fv.put({ id: "old", path: "Old", content: "x", tags: [TRASH_TAG], metadata: { prism_trashed_at: old } });
  fv.put({ id: "new", path: "New", content: "x", tags: [TRASH_TAG], metadata: { prism_trashed_at: fresh } });
  // Only notes trashed through the trash route (the ledger) are ever purged.
  for (const [id, at] of [["old", old], ["new", fresh], ["live", old]] as const) db.prepare("INSERT INTO page_trash_ledger (vault_id, note_id, root_id, trashed_at, trashed_by) VALUES ('primary', ?, ?, ?, 'x')").run(id, id, at);
  fv.put({ id: "nostamp", path: "NoStamp", content: "x", tags: [TRASH_TAG], metadata: {} });
  fv.put({ id: "live", path: "Live", content: "x", tags: [], metadata: { prism_trashed_at: old } });
  assert.deepEqual(await runTrashPurgeOnce(), { purged: 0, failed: 0, skipped: 0 });
  assert.equal(fv.notes.size, 4);
  process.env.TRASH_PURGE_ENABLED = "true";
  const out = await runTrashPurgeOnce();
  assert.equal(out.purged, 1);
  assert.deepEqual([...fv.notes.keys()].sort(), ["live", "new", "nostamp"]);
});

// ── preferences ───────────────────────────────────────────────────────────────

test("preferences round-trip per user with revision CAS", async () => {
  seedTree();
  const cookie = as(OWNER);
  const empty = (await (await req("/me/preferences", { cookie })).json()) as { preferences: { favorites: string[] }; revision: number };
  assert.deepEqual(empty.preferences.favorites, []);
  assert.equal(empty.revision, 0);
  const put = await req("/me/preferences", { method: "PUT", cookie, headers: J, body: JSON.stringify({ ifRevision: 0, preferences: { favorites: ["p", "p", "sib"], recents: ["c1"], sidebar: { collapsed: ["recent", "bogus"] } } }) });
  assert.equal(put.status, 200);
  const saved = (await put.json()) as { preferences: { favorites: string[]; recents: string[]; sidebar: { collapsed: string[] } }; revision: number; items: Record<string, { title: string }> };
  assert.deepEqual(saved.preferences.favorites, ["p", "sib"]);
  assert.deepEqual(saved.preferences.sidebar.collapsed, ["recent"]);
  assert.equal(saved.revision, 1);
  assert.equal(saved.items.p!.title, "Prism");
  const stale = await req("/me/preferences", { method: "PUT", cookie, headers: J, body: JSON.stringify({ ifRevision: 0, preferences: { favorites: [] } }) });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "conflict", revision: 1 });
  // Another user starts empty.
  const other = (await (await req("/me/preferences", { cookie: as("ed@test.local") })).json()) as { preferences: { favorites: string[] } };
  assert.deepEqual(other.preferences.favorites, []);
});

test("preferences never serve ids the caller can't view, trashed or deleted ones", async () => {
  seedTree();
  fv.put({ id: "secret", path: "vault/Secret", content: "s", tags: ["private-team"] });
  grantUser("ed@test.local", "tag", "team", "edit");
  const ed = as("ed@test.local");
  await req("/me/preferences", { method: "PUT", cookie: ed, headers: J, body: JSON.stringify({ preferences: { favorites: ["secret", "p", "sib", "gone"], recents: ["secret", "c1"] } }) });
  const owner = as(OWNER);
  await post("/notes/sib/trash", {}, owner);
  const got = (await (await req("/me/preferences", { cookie: ed })).json()) as { preferences: { favorites: string[]; recents: string[] }; items: Record<string, unknown> };
  assert.deepEqual(got.preferences.favorites, ["p"]);
  assert.deepEqual(got.preferences.recents, ["c1"]);
  assert.ok(!("secret" in got.items));
  assert.ok(!JSON.stringify(got).includes("Secret"));
});

test("preferences are bounded and need a signed-in user", async () => {
  const cookie = as(OWNER);
  const huge = await req("/me/preferences", { method: "PUT", cookie, headers: J, body: JSON.stringify({ preferences: { favorites: ["x".repeat(70_000)] } }) });
  assert.equal(huge.status, 413);
  const many = Array.from({ length: 300 }, (_, i) => `id-${i}`);
  const put = await req("/me/preferences", { method: "PUT", cookie, headers: J, body: JSON.stringify({ preferences: { favorites: many, recents: many } }) });
  assert.equal(put.status, 200);
  assert.equal((await req("/me/preferences", { method: "PUT", cookie, headers: J, body: "{" })).status, 400);
  assert.equal((await req("/me/preferences")).status, 401);
  const cap = makeCapability("tag", "team", "view");
  assert.equal((await req("/me/preferences", { headers: { authorization: `Capability ${cap}` } })).status, 401);
});


test("require_leaf refuses a child added after caller preflight without any Trash writes", async () => {
  fv.put({ id: "leaf", path: "vault/Leaf", content: "Root", tags: ["team"] });
  const revision = fv.notes.get("leaf")!.updatedAt;
  const preflight = await req("/notes?path_prefix=vault/Leaf/", { cookie: as(OWNER) });
  assert.equal(preflight.status, 200);
  fv.put({ id: "late", path: "vault/Leaf/Late child", content: "Preserve", tags: ["team"] });
  const response = await post("/notes/leaf/trash", { if_updated_at: revision, require_leaf: true }, as(OWNER));
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).error, "has_descendants");
  assert.equal(patches().length, 0);
  assert.ok(!fv.notes.get("leaf")!.tags!.includes(TRASH_TAG));
  assert.ok(!fv.notes.get("late")!.tags!.includes(TRASH_TAG));
});

test("require_leaf rechecks the subtree inside the mutation lock", async () => {
  fv.put({ id: "leaf", path: "vault/Leaf", content: "Root", tags: ["team"] });
  const revision = fv.notes.get("leaf")!.updatedAt;
  const original = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const response = await original(input, init);
    if (url.pathname.endsWith("/notes") && url.searchParams.get("path_prefix") === "vault/Leaf" && ++reads === 1) {
      fv.put({ id: "late", path: "vault/Leaf/Late child", content: "Preserve", tags: ["team"] });
    }
    return response;
  };
  try {
    const response = await post("/notes/leaf/trash", { if_updated_at: revision, require_leaf: true }, as(OWNER));
    assert.equal(response.status, 409); assert.equal(reads, 2); assert.equal(patches().length, 0);
  } finally { globalThis.fetch = original; }
});


test("require_leaf only writes the root after an initially live child disappears", async () => {
  fv.put({id:"leaf",path:"vault/Leaf",tags:["team"]});fv.put({id:"child",path:"vault/Leaf/Child",tags:["team"]});
  const original=globalThis.fetch;let reads=0;
  globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);const response=await original(input,init);
    if(url.pathname.endsWith("/notes")&&url.searchParams.get("path_prefix")==="vault/Leaf"&&++reads===1){fv.notes.get("child")!.tags!.push(TRASH_TAG);fv.notes.get("child")!.updatedAt="2026-10-10T12:00:00.000Z";}return response;};
  try {const response=await post("/notes/leaf/trash",{if_updated_at:fv.notes.get("leaf")!.updatedAt,require_leaf:true},as(OWNER));assert.equal(response.status,200);assert.deepEqual(patches().map(c=>c.path.split("/").pop()),["leaf"]);}finally{globalThis.fetch=original;}
});
