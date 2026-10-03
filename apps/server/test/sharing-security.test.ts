/**
 * Security review of wave 2D (page-subtree grants) — one failing-first test per finding.
 *
 *  C1  a page grantee with `organize` must not rename/move a shared page over
 *      existing notes (PATCH path is refused for non-owners; MCP path changes go
 *      through the pages move route; the move route refuses placing EXISTING
 *      notes under a moved page-grant anchor without `share` on them).
 *  H1  moving notes INTO a page shared with others needs `share` on them.
 *  M1  access-preview is no oracle: the parent must be a viewable page the
 *      caller can add to; hidden ancestors never count.
 *  M2  scoped sharers cannot reduce/remove access an admin granted.
 *  M3  the writer stamp is server-owned: refused on non-owner writes, stripped
 *      from every non-owner note response.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { api } from "../src/routes/api";
import { acl } from "../src/routes/acl";
import { createApp } from "../src/app";
import { resetTreeForTests } from "../src/tree";
import { resetPagesForTests } from "../src/pages";
import { issuePat } from "../src/auth/pat";
import { addGrant, setAccount, grantsForResource } from "../src/db";
import type { Cap } from "../src/permissions";
import { changeKindOf } from "../src/sharing";
import { writerIdFor } from "../src/writer-stamp";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

let fv: FakeVault;
const OWNER = "owner@test.local";
const BOB = "bob@test.local";
const CAROL = "carol@test.local";
const DAVE = "dave@test.local";
const J = { "content-type": "application/json" };

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetPagesForTests();
  fv = installFakeVault();
  for (const e of [BOB, CAROL, DAVE]) setAccount(e, e, "hash");
  // The shared page and its sub-page.
  fv.put({ id: "p", path: "vault/Team/Plan", content: "<p>plan</p>" });
  fv.put({ id: "p1", path: "vault/Team/Plan/Notes", content: "<p>notes</p>" });
  // A page Bob may add to, which holds notes Bob must never see (no note at "Secret").
  fv.put({ id: "inbox", path: "vault/Inbox", content: "<p>inbox</p>" });
  fv.put({ id: "mail", path: "vault/Inbox/Secret/Mail", content: "<p>private mail</p>" });
  fv.put({ id: "mail2", path: "vault/Inbox/Secret/More", content: "<p>more mail</p>" });
  // Carol's own page and a page shared with Dave.
  fv.put({ id: "draft", path: "vault/Carol/Draft", content: "<p>carol's draft</p>" });
  fv.put({ id: "carol", path: "vault/Carol", content: "<p>carol</p>" });
  fv.put({ id: "q", path: "vault/Shared", content: "<p>shared with dave</p>" });
  fv.put({ id: "q1", path: "vault/Shared/Existing", content: "<p>already shared</p>" });
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
});

const as = (email: string) => sessionCookie(makeSession(email));
const req = (app: typeof api | typeof acl, path: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return app.request(path, { ...init, headers });
};
const grantCaps = (email: string, type: "page" | "note", id: string, caps: Cap[], by = OWNER) =>
  addGrant({ subject_type: "user", subject: email, resource_type: type, resource: id, level: "view", caps, created_by: by });
const move = (who: string, id: string, body: Record<string, unknown>) =>
  req(api, `/notes/${id}/move`, { method: "POST", cookie: as(who), headers: J, body: JSON.stringify({ if_updated_at: fv.notes.get(id)!.updatedAt, ...body }) });
const status = async (who: string, id: string) => (await req(api, `/notes/${id}`, { cookie: as(who) })).status;

// ── C1 ───────────────────────────────────────────────────────────────────────

test("C1: a non-owner cannot change a note's path through PATCH (moves go through the pages API)", async () => {
  grantCaps(BOB, "page", "p", ["view", "edit", "organize"]);
  const r = await req(api, "/notes/p", { method: "PATCH", cookie: as(BOB), headers: J, body: JSON.stringify({ path: "vault", if_updated_at: fv.notes.get("p")!.updatedAt }) });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, "move_required");
  assert.equal(fv.notes.get("p")!.path, "vault/Team/Plan");
  // Restating the current path is a no-op, not an error.
  const same = await req(api, "/notes/p", { method: "PATCH", cookie: as(BOB), headers: J, body: JSON.stringify({ content: "<p>x</p>", path: "vault/Team/Plan", if_updated_at: fv.notes.get("p")!.updatedAt }) });
  assert.equal(same.status, 200);
});

test("C1: moving a shared page over existing notes needs `share` on them (and they stay hidden)", async () => {
  grantCaps(BOB, "page", "p", ["view", "edit", "organize"]);
  grantCaps(BOB, "note", "inbox", ["view", "create"]);
  assert.equal(await status(BOB, "mail"), 404);
  const r = await move(BOB, "p", { newPath: "vault/Inbox/Secret" });
  assert.equal(r.status, 403);
  const body = JSON.stringify(await r.json());
  assert.ok(!body.includes("mail") && !body.includes("Mail"), "the refusal names no hidden note");
  assert.equal(fv.notes.get("p")!.path, "vault/Team/Plan");
  assert.equal(await status(BOB, "mail"), 404);
  // An admin may (audited); the owner's move is not refused.
  const owner = await move(OWNER, "p", { newPath: "vault/Inbox/Secret" });
  assert.equal(owner.status, 200);
});

test("C1: the MCP update tool moves through the pages route (same refusal)", async () => {
  grantCaps(BOB, "page", "p", ["view", "edit", "organize"]);
  grantCaps(BOB, "note", "inbox", ["view", "create"]);
  const app = createApp();
  const token = issuePat({ email: BOB, vaultId: "primary", scope: "write" }).token;
  const ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const r = new Request(input, init);
    const h = new Headers(r.headers);
    h.set("authorization", `Bearer ${token}`);
    h.set("cf-connecting-ip", ip);
    h.set("x-forwarded-for", ip);
    const u = new URL(r.url);
    return app.request(u.pathname + u.search, { method: r.method, headers: h, body: r.method === "POST" ? await r.text() : undefined });
  };
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  const res = (await client.callTool({ name: "prism_update_note", arguments: { id: "p", path: "vault/Inbox/Secret", if_updated_at: fv.notes.get("p")!.updatedAt } })) as { isError?: boolean };
  assert.equal(res.isError, true);
  assert.equal(fv.notes.get("p")!.path, "vault/Team/Plan");
  // A permitted move through the tool works and goes through the move route.
  grantCaps(BOB, "note", "carol", ["view", "create"]);
  const ok = (await client.callTool({ name: "prism_update_note", arguments: { id: "p", path: "vault/Carol/Plan", if_updated_at: fv.notes.get("p")!.updatedAt } })) as { isError?: boolean };
  assert.notEqual(ok.isError, true, JSON.stringify(ok));
  assert.equal(fv.notes.get("p")!.path, "vault/Carol/Plan");
  assert.equal(fv.notes.get("p1")!.path, "vault/Carol/Plan/Notes", "the subtree moved with it (the pages route, not a bare PATCH)");
  await client.close();
});

// ── H1 ───────────────────────────────────────────────────────────────────────

test("H1: moving a note into a page shared with others needs `share` on it; inside the same share it does not", async () => {
  grantCaps(DAVE, "page", "q", ["view"]);
  grantCaps(CAROL, "note", "draft", ["view", "edit", "organize"]);
  grantCaps(CAROL, "note", "q", ["view", "create"]);
  const r = await move(CAROL, "draft", { newParentPath: "vault/Shared" });
  assert.equal(r.status, 403);
  assert.equal(fv.notes.get("draft")!.path, "vault/Carol/Draft");
  assert.equal(await status(DAVE, "draft"), 404);
  // With share on the moved note, allowed.
  grantCaps(CAROL, "note", "draft", ["view", "edit", "organize", "share"]);
  assert.equal((await move(CAROL, "draft", { newParentPath: "vault/Shared" })).status, 200);
  assert.equal(await status(DAVE, "draft"), 200);
  // Moving within the same shared page needs nothing extra.
  grantCaps(CAROL, "note", "q1", ["view", "edit", "organize"]);
  grantCaps(CAROL, "note", "draft", ["view", "create"]);
  assert.equal((await move(CAROL, "q1", { newParentPath: "vault/Shared/Draft" })).status, 200);
});

// ── M1 ───────────────────────────────────────────────────────────────────────

test("M1: access-preview needs a viewable destination page the caller can add to; hidden ancestors never count", async () => {
  grantCaps(DAVE, "page", "q", ["view"]);
  grantCaps(DAVE, "page", "inbox", ["view"]);
  grantCaps(CAROL, "note", "draft", ["view", "edit", "organize", "share"]);
  const hidden = await req(api, "/notes/draft/access-preview?parent=vault/Inbox", { cookie: as(CAROL) });
  const missing = await req(api, "/notes/draft/access-preview?parent=vault/Nowhere", { cookie: as(CAROL) });
  assert.equal(hidden.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await hidden.json(), await missing.json(), "indistinguishable");
  // Viewable but no create/organize there → also 404.
  grantCaps(CAROL, "note", "q", ["view"]);
  assert.equal((await req(api, "/notes/draft/access-preview?parent=vault/Shared", { cookie: as(CAROL) })).status, 404);
  grantCaps(CAROL, "note", "q", ["view", "create"]);
  const ok = (await (await req(api, "/notes/draft/access-preview?parent=vault/Shared", { cookie: as(CAROL) })).json()) as { willChange: boolean; changes?: Array<{ email: string | null }> };
  assert.equal(ok.willChange, true);
  // A share-holder sees WHO by display name only; the email is for administrators (review L-4).
  assert.deepEqual(ok.changes?.map((c) => c.email), [null]);
  const admin = (await (await req(api, "/notes/draft/access-preview?parent=vault/Shared", { cookie: as(OWNER) })).json()) as { changes?: Array<{ email: string }> };
  assert.deepEqual(admin.changes?.map((c) => c.email), [DAVE]);
});

// ── M2 ───────────────────────────────────────────────────────────────────────

test("M2: a scoped sharer cannot replace, narrow or delete access an admin granted", async () => {
  grantCaps(CAROL, "page", "p", ["view", "comment", "suggest", "edit", "share"]);
  grantCaps(DAVE, "page", "p", ["view", "comment", "suggest", "edit"]); // admin-made
  const carol = as(CAROL);
  const narrow = await req(acl, "/notes/p/people", { method: "PUT", cookie: carol, headers: J, body: JSON.stringify({ email: DAVE, level: "view", scope: "page" }) });
  assert.equal(narrow.status, 403);
  const asNote = await req(acl, "/notes/p/people", { method: "PUT", cookie: carol, headers: J, body: JSON.stringify({ email: DAVE, level: "edit", scope: "note" }) });
  assert.equal(asNote.status, 403);
  const del = await req(acl, `/notes/p/people/${encodeURIComponent(DAVE)}`, { method: "DELETE", cookie: carol });
  assert.equal(del.status, 403);
  assert.equal(grantsForResource("page", "p").filter((g) => g.subject === DAVE).length, 1);
  // Restricting an inherited higher access on a sub-page is a reduction too.
  const sub = await req(acl, "/notes/p1/people", { method: "PUT", cookie: carol, headers: J, body: JSON.stringify({ email: DAVE, level: "view", scope: "page" }) });
  assert.equal(sub.status, 403);
  // Carol can still share with someone new, and manage what she created.
  assert.equal((await req(acl, "/notes/p/people", { method: "PUT", cookie: carol, headers: J, body: JSON.stringify({ email: BOB, level: "view", scope: "page" }) })).status, 200);
  assert.equal((await req(acl, `/notes/p/people/${encodeURIComponent(BOB)}`, { method: "DELETE", cookie: carol })).status, 200);
  assert.equal(grantsForResource("page", "p").filter((g) => g.subject === BOB).length, 0);
});

// ── M3 ───────────────────────────────────────────────────────────────────────

test("M3: non-owners cannot write the writer stamp and never receive it", async () => {
  grantCaps(BOB, "page", "p", ["view", "edit"]);
  fv.notes.get("p")!.metadata = { prism_last_writer: CAROL, prism_last_change: "edit", prism_last_write_at: "2026-01-01T00:00:00.000Z" };
  // A client value for any attribution key is dropped; the server's own stamp is stored.
  for (const key of ["prism_last_writer", "prism_last_change", "prism_last_write_at"]) {
    const r = await req(api, "/notes/p", { method: "PATCH", cookie: as(BOB), headers: J, body: JSON.stringify({ metadata: { [key]: "forged" }, if_updated_at: fv.notes.get("p")!.updatedAt }) });
    assert.equal(r.status, 200, key);
    const meta = fv.notes.get("p")!.metadata!;
    assert.ok(!JSON.stringify(meta).includes("forged"), key);
    assert.equal(meta.prism_last_writer, writerIdFor(BOB));
    assert.equal(changeKindOf(meta), "edit");
  }
  // /api/properties refuses the keys outright.
  for (const key of ["prism_last_writer", "prism_last_change", "prism_last_write_at"]) {
    const r = await req(api, "/properties/p", { method: "POST", cookie: as(BOB), headers: J, body: JSON.stringify({ set: { [key]: "forged" } }) });
    assert.equal(r.status, 400, key);
  }
  fv.notes.get("p")!.metadata = { prism_last_writer: writerIdFor(CAROL), prism_last_change: "edit@2026-01-01T00:00:00.000Z", prism_last_write_at: "2026-01-01T00:00:00.000Z" };
  const created = await req(api, "/notes", { method: "POST", cookie: as(BOB), headers: J, body: JSON.stringify({ content: "x", path: "vault/Team/Plan/New", metadata: { prism_last_writer: "forged", prism_last_change: "agent" } }) });
  if (created.status === 200) {
    const n = (await created.json()) as { id: string };
    assert.notEqual(fv.notes.get(n.id)!.metadata?.prism_last_writer, "forged");
    assert.notEqual(fv.notes.get(n.id)!.metadata?.prism_last_change, "agent");
  }
  const leaks = (o: unknown) => /prism_last_(writer|change|write_at)|carol@test|u_[0-9a-f]{16}/.test(JSON.stringify(o));
  assert.equal(leaks(await (await req(api, "/notes/p", { cookie: as(BOB) })).json()), false, "GET");
  assert.equal(leaks(await (await req(api, "/notes", { cookie: as(BOB) })).json()), false, "list");
  const patched = await req(api, "/notes/p", { method: "PATCH", cookie: as(BOB), headers: J, body: JSON.stringify({ content: "<p>v2</p>", if_updated_at: fv.notes.get("p")!.updatedAt }) });
  assert.equal(leaks(await patched.json()), false, "PATCH response");
  const versions = await (await req(api, "/notes/p/versions", { cookie: as(BOB) })).json();
  assert.equal(leaks(versions), false, "versions");
  fv.notes.get("p")!.metadata = { ...fv.notes.get("p")!.metadata, prism_trashed_by: OWNER };
  await req(api, "/notes/p", { method: "PATCH", cookie: as(BOB), headers: J, body: JSON.stringify({ content: "<p>v3</p>", if_updated_at: fv.notes.get("p")!.updatedAt }) });
  assert.ok(!JSON.stringify(await (await req(api, "/notes/p/versions", { cookie: as(BOB) })).json()).includes("prism_trashed_by"), "version rows drop prism_trashed_by");
});

// ── LOW ──────────────────────────────────────────────────────────────────────

test("LOW: a page grantee's /api/notes listing is budgeted per caller", async () => {
  grantCaps(BOB, "page", "p", ["view"]);
  let last = 200;
  for (let i = 0; i < 31; i++) last = (await req(api, "/notes", { cookie: as(BOB) })).status;
  assert.equal(last, 429);
  // Someone without page shares is not budgeted by this limiter.
  grantCaps(CAROL, "note", "q", ["view"]);
  for (let i = 0; i < 35; i++) last = (await req(api, "/notes", { cookie: as(CAROL) })).status;
  assert.equal(last, 200);
});

test("LOW: a moved shared page's sub-pages are reachable at once (anchors resolve from the live tree write-through)", async () => {
  grantCaps(BOB, "page", "p", ["view"]);
  assert.equal(await status(BOB, "p1"), 200);
  assert.equal((await move(OWNER, "p", { newParentPath: "vault/Carol" })).status, 200);
  assert.equal(await status(BOB, "p1"), 200);
  fv.put({ id: "ghost", path: "vault/Team/Plan/Ghost", content: "<p>at the old path</p>" });
  assert.equal(await status(BOB, "ghost"), 404);
});

// ════════════════════════════════════════════════════════════════════════════
// Re-review (round 2)
// ════════════════════════════════════════════════════════════════════════════

const postJ = (who: string, path: string, body: unknown = {}) => req(api, path, { method: "POST", cookie: as(who), headers: J, body: JSON.stringify(body) });
const leaf = (who: string) => as(who);
void leaf;

test("H-A: restoring a trashed shared page over notes that appeared under its path needs `share` on them", async () => {
  grantCaps(DAVE, "page", "p", ["view"]);
  grantCaps(BOB, "page", "p", ["view", "edit", "organize", "delete"]);
  assert.equal((await postJ(BOB, "/notes/p/trash")).status, 200);
  // While P is in the Trash, a note appears under its old path (created by the owner or any other path).
  fv.put({ id: "late", path: "vault/Team/Plan/Late", content: "<p>not for sharing</p>" });
  resetTreeForTests();
  assert.equal(await status(DAVE, "late"), 404, "a trashed page shares nothing");
  assert.equal(await status(BOB, "late"), 404);
  const r = await postJ(BOB, "/trash/p/restore");
  assert.equal(r.status, 403);
  assert.ok(!JSON.stringify(await r.json()).toLowerCase().includes("late"));
  assert.equal(await status(DAVE, "late"), 404);
  // The owner may restore (audited); from then on the page shares what is under it.
  assert.equal((await postJ(OWNER, "/trash/p/restore")).status, 200);
});

test("H-A: a non-owner cannot move a page under a trashed page's path", async () => {
  grantCaps(BOB, "page", "p", ["view", "edit", "organize", "delete"]);
  grantCaps(CAROL, "note", "draft", ["view", "edit", "organize", "share"]);
  fv.put({ id: "live", path: "vault/Team/Plan/Live", content: "<p>live page under the trashed one</p>" });
  grantCaps(CAROL, "note", "live", ["view", "create"]);
  assert.equal((await postJ(BOB, "/notes/p/trash")).status, 200);
  fv.notes.get("live")!.tags = [];
  fv.notes.get("live")!.metadata = null;
  resetTreeForTests();
  const r = await move(CAROL, "draft", { newParentPath: "vault/Team/Plan/Live" });
  assert.equal(r.status, 403);
  assert.equal(fv.notes.get("draft")!.path, "vault/Carol/Draft");
});

test("H-B: moving a note under your OWN page share must not grow your caps on it without `share`", async () => {
  grantCaps(CAROL, "note", "draft", ["view", "edit", "organize"]);
  grantCaps(CAROL, "page", "q", ["view", "edit", "create", "share", "delete"]);
  const r = await move(CAROL, "draft", { newParentPath: "vault/Shared" });
  assert.equal(r.status, 403, "organize + share-on-your-own-page must not become share on the note");
  assert.equal(fv.notes.get("draft")!.path, "vault/Carol/Draft");
  // No growth → allowed: a note she already fully controls.
  grantCaps(CAROL, "note", "carol", ["view", "edit", "organize", "create", "share", "delete"]);
  assert.equal((await move(CAROL, "carol", { newParentPath: "vault/Shared" })).status, 403, "the sub-page `draft` would still grow");
  grantCaps(CAROL, "note", "draft", ["view", "edit", "organize", "create", "share", "delete"]);
  assert.equal((await move(CAROL, "carol", { newParentPath: "vault/Shared" })).status, 200);
});

test("M-C: a tag sharer cannot lower or remove an admin-made tag grant, but manages grants they made (L-5)", async () => {
  fv.notes.get("p")!.tags = ["team"];
  addGrant({ subject_type: "user", subject: CAROL, resource_type: "tag", resource: "team", level: "view", caps: ["view", "comment", "suggest", "edit", "share"], created_by: OWNER });
  addGrant({ subject_type: "user", subject: DAVE, resource_type: "tag", resource: "team", level: "edit", created_by: OWNER });
  const carol = as(CAROL);
  const put = (email: string, level: string) => req(acl, "/tags/team/people", { method: "PUT", cookie: carol, headers: J, body: JSON.stringify({ email, level }) });
  assert.equal((await put(DAVE, "view")).status, 403);
  assert.equal((await req(acl, `/tags/team/people/${encodeURIComponent(DAVE)}`, { method: "DELETE", cookie: carol })).status, 403);
  assert.equal(grantsForResource("tag", "team").find((g) => g.subject === DAVE)!.level, "edit");
  assert.equal((await put(BOB, "suggest")).status, 200);
  assert.equal((await put(BOB, "view")).status, 200, "her own grant: lowering is hers to do");
  assert.equal((await req(acl, `/tags/team/people/${encodeURIComponent(BOB)}`, { method: "DELETE", cookie: carol })).status, 200);
  // Same on a page: a grant she made may be lowered by her.
  grantCaps(CAROL, "page", "p", ["view", "comment", "suggest", "edit", "share"]);
  const page = (level: string) => req(acl, "/notes/p/people", { method: "PUT", cookie: carol, headers: J, body: JSON.stringify({ email: BOB, level, scope: "page" }) });
  assert.equal((await page("suggest")).status, 200);
  assert.equal((await page("view")).status, 200);
});

test("M-C: a move that would LOWER someone's access on existing notes (nearest shared page wins) needs an admin", async () => {
  grantCaps(DAVE, "page", "p", ["view", "comment", "suggest", "edit"]); // admin-made: edit on everything under Plan
  fv.put({ id: "doc", path: "vault/Team/Plan/Sub/Doc", content: "<p>dave edits this</p>" });
  fv.put({ id: "a", path: "vault/Carol/Anchor", content: "<p>carol's page</p>" });
  grantCaps(CAROL, "page", "p", ["view", "edit", "create", "organize", "share"]);
  grantCaps(CAROL, "note", "a", ["view", "edit", "organize", "share"]);
  addGrant({ subject_type: "user", subject: DAVE, resource_type: "page", resource: "a", level: "view", created_by: CAROL });
  const r = await move(CAROL, "a", { newPath: "vault/Team/Plan/Sub" });
  assert.equal(r.status, 403);
  assert.equal(fv.notes.get("a")!.path, "vault/Carol/Anchor");
  const patch = await req(api, "/notes/doc", { method: "PATCH", cookie: as(DAVE), headers: J, body: JSON.stringify({ content: "<p>still mine to edit</p>", if_updated_at: fv.notes.get("doc")!.updatedAt }) });
  assert.equal(patch.status, 200);
});

test("M-D: a page-grant holder who trashed a page can see it in the Trash and restore it", async () => {
  grantCaps(BOB, "page", "p", ["view", "edit", "organize", "delete"]);
  assert.equal((await postJ(BOB, "/notes/p/trash")).status, 200);
  const trash = (await (await req(api, "/trash", { cookie: as(BOB) })).json()) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
  assert.ok(JSON.stringify(trash).includes('"p"'));
  const r = await postJ(BOB, "/trash/p/restore");
  assert.equal(r.status, 200);
  assert.equal(await status(BOB, "p1"), 200);
});

test("M-A: /api/query never shows an email for a writer without a display name, nor the raw change kind", async () => {
  const { writerIdFor } = await import("../src/writer-stamp");
  const { ensureUser } = await import("../src/db");
  ensureUser("noname@test.local");
  fv.notes.get("p")!.tags = ["task"];
  const at = new Date().toISOString();
  fv.notes.get("p")!.metadata = { title: "T", prism_last_writer: writerIdFor("noname@test.local"), prism_last_write_at: at, prism_last_change: `agent@${at}` };
  fv.notes.get("p")!.updatedAt = at;
  grantCaps(BOB, "page", "p", ["view"]);
  addGrant({ subject_type: "user", subject: BOB, resource_type: "tag", resource: "task", level: "view", created_by: OWNER });
  const q = await postJ(BOB, "/query", { tags: ["task"] });
  assert.equal(q.status, 200);
  const text = JSON.stringify(await q.json());
  assert.ok(!text.includes("noname@test.local"), "no email fallback for a non-admin viewer");
  assert.ok(!text.includes("prism_last_change"));
  assert.ok(text.includes('"p"'));
});

test("M-B: a non-admin never receives prism_creator (an email); they get `_creator {me, name}` instead", async () => {
  const { setUserProfile } = await import("../src/db");
  setUserProfile(CAROL, { name: "Carol C" });
  fv.notes.get("p")!.metadata = { prism_creator: CAROL };
  fv.notes.get("p1")!.metadata = { prism_creator: BOB };
  fv.notes.get("p1")!.content = "<p>plan notes</p>";
  grantCaps(BOB, "page", "p", ["view", "edit", "share"]);
  const one = (await (await req(api, "/notes/p", { cookie: as(BOB) })).json()) as { metadata: Record<string, unknown>; _creator: unknown };
  assert.equal(one.metadata.prism_creator, undefined);
  assert.deepEqual(one._creator, { me: false, name: "Carol C" });
  const mine = (await (await req(api, "/notes/p1", { cookie: as(BOB) })).json()) as { _creator: { me: boolean } };
  assert.equal(mine._creator.me, true);
  for (const path of ["/notes", "/search?q=plan"]) {
    const body = JSON.stringify(await (await req(api, path, { cookie: as(BOB) })).json());
    assert.ok(!body.includes(CAROL), path); // (the caller's OWN address may stay on their own notes)
  }
  const aclNote = (await (await req(acl, "/notes/p", { cookie: as(BOB) })).json()) as { note: { creator?: unknown; createdByMe?: boolean } };
  assert.equal(aclNote.note.creator ?? null, null);
  assert.equal(aclNote.note.createdByMe, false);
  // The owner is unchanged.
  const owner = (await (await req(acl, "/notes/p", { cookie: as(OWNER) })).json()) as { note: { creator?: unknown } };
  assert.equal(owner.note.creator, CAROL);
  // A round-trip PATCH (metadata without the creator) still works for an editor.
  const patch = await req(api, "/notes/p", { method: "PATCH", cookie: as(BOB), headers: J, body: JSON.stringify({ metadata: { ...one.metadata, title: "x" }, if_updated_at: fv.notes.get("p")!.updatedAt }) });
  assert.equal(patch.status, 200);
  assert.equal(fv.notes.get("p")!.metadata!.prism_creator, CAROL);
});

test("L-2: createCapsAt gives a page-share holder with `create` the right to add a sub-page (and nothing under a trashed page)", async () => {
  const { createCapsAt } = await import("../src/sharing");
  const { grantsForUser } = await import("../src/db");
  grantCaps(BOB, "page", "p", ["view", "create"]);
  const bob = { kind: "user" as const, email: BOB, role: "guest" as const, vaultId: "primary", grants: grantsForUser(BOB) };
  assert.ok((await createCapsAt(bob, "vault/Team/Plan/New page")).has("create"));
  assert.ok((await createCapsAt(bob, "vault/Team/Plan/Notes/Deeper")).has("create"));
  assert.equal((await createCapsAt(bob, "vault/Team/Other")).has("create"), false);
  assert.equal((await createCapsAt(bob, "vault/Team/Planning")).has("create"), false);
  assert.equal((await postJ(OWNER, "/notes/p/trash")).status, 200);
  assert.equal((await createCapsAt(bob, "vault/Team/Plan/New page")).size, 0, "nothing can be created under a trashed page");
});

test("L-3: a page grantee's truncated /api/notes listing says so and can be paged", async () => {
  for (let i = 0; i < 27; i++) {
    fv.put({ id: `s${i}`, path: `vault/Many/S${String(i).padStart(2, "0")}`, content: "x" });
    fv.put({ id: `s${i}c`, path: `vault/Many/S${String(i).padStart(2, "0")}/Child`, content: "x" });
    grantCaps(DAVE, "page", `s${i}`, ["view"]);
  }
  const first = await req(api, "/notes", { cookie: as(DAVE) });
  assert.equal(first.headers.get("x-prism-truncated"), "shared-pages");
  assert.equal(first.headers.get("x-prism-shared-pages-next"), "25");
  const second = await req(api, "/notes?shared_pages_offset=25", { cookie: as(DAVE) });
  assert.equal(second.headers.get("x-prism-truncated"), null);
});

test("L-4: inherited access lists only ancestors the caller can view, with emails for admins only", async () => {
  fv.put({ id: "deep", path: "vault/Team/Plan/Notes/Deep", content: "x" });
  grantCaps(DAVE, "page", "p", ["view"]); // on the grandparent
  const { setUserProfile } = await import("../src/db");
  setUserProfile(DAVE, { name: "Dave D" });
  // Carol can share `deep` but cannot view its ancestors.
  grantCaps(CAROL, "note", "deep", ["view", "share"]);
  const carol = (await (await req(acl, "/notes/deep", { cookie: as(CAROL) })).json()) as { inherited: unknown[]; parent: unknown };
  assert.deepEqual(carol.inherited, []);
  assert.equal(carol.parent, null);
  // With view on the ancestors she sees the inherited person by NAME, no email.
  grantCaps(CAROL, "page", "p", ["view", "share"]);
  const seen = (await (await req(acl, "/notes/deep", { cookie: as(CAROL) })).json()) as { inherited: Array<{ name: string; email: string | null }> };
  assert.ok(seen.inherited.some((i) => i.name === "Dave D"));
  assert.ok(seen.inherited.every((i) => i.email === null), "no emails for a non-admin");
  assert.ok(!JSON.stringify(seen.inherited).includes("@test.local"));
  const owner = (await (await req(acl, "/notes/deep", { cookie: as(OWNER) })).json()) as { inherited: Array<{ email: string }> };
  assert.ok(owner.inherited.some((i) => i.email === DAVE));
});

// ── integration with the create allowlist (main 632abe9) ─────────────────────
test("create: a page-share holder with `create` adds a sub-page through POST /notes; view-only cannot", async () => {
  grantCaps(BOB, "page", "p", ["view", "create"]);
  grantCaps(DAVE, "page", "p", ["view"]);
  const ok = await postJ(BOB, "/notes", { path: "vault/Team/Plan/Bob's page", content: "<p>hi</p>" });
  assert.ok(ok.status === 200 || ok.status === 201, `created (${ok.status})`);
  const made = (await ok.json()) as { id: string };
  assert.equal(await status(DAVE, made.id), 200, "the new sub-page inherits the page share");
  // Deeper, under a sub-page of the shared page.
  assert.equal((await postJ(BOB, "/notes", { path: "vault/Team/Plan/Notes/Deeper", content: "x" })).status, 200);
  // View-only on the page: refused, nothing written.
  const before = fv.notes.size;
  assert.equal((await postJ(DAVE, "/notes", { path: "vault/Team/Plan/Dave's page", content: "x" })).status, 403);
  // Outside the shared page Bob has no standing.
  assert.equal((await postJ(BOB, "/notes", { path: "vault/Team/Other", content: "x" })).status, 403);
  assert.equal((await postJ(BOB, "/notes", { path: "vault/Team/Planning", content: "x" })).status, 403);
  assert.equal(fv.notes.size, before);
});

test("create: a plain folder under a page shared with others needs `create` there (no drop-in by tag standing)", async () => {
  const { addGrant: grant } = await import("../src/db");
  grantCaps(DAVE, "page", "q", ["view"]);
  // Carol may create in tag `team`, but has no standing in the shared page.
  grant({ subject_type: "user", subject: CAROL, resource_type: "tag", resource: "team", level: "edit", created_by: OWNER });
  const before = fv.notes.size;
  const r = await postJ(CAROL, "/notes", { path: "vault/Shared/Folder/Dropped", tags: ["team"], content: "x" });
  assert.equal(r.status, 404, "an unviewable shared ancestor answers like a missing place");
  assert.equal(fv.notes.size, before);
  // With `create` on the shared page it works, folder or not.
  grantCaps(CAROL, "page", "q", ["view", "create"]);
  assert.equal((await postJ(CAROL, "/notes", { path: "vault/Shared/Folder/Dropped", tags: ["team"], content: "x" })).status, 200);
  // A plain folder nobody shares stays free for a tag member.
  assert.equal((await postJ(CAROL, "/notes", { path: "vault/Loose/Folder/Mine", tags: ["team"], content: "x" })).status, 200);
});

test("create: nothing is created under a trashed shared page", async () => {
  grantCaps(BOB, "page", "p", ["view", "create"]);
  assert.equal((await postJ(OWNER, "/notes/p/trash")).status, 200);
  const before = fv.notes.size;
  const r = await postJ(BOB, "/notes", { path: "vault/Team/Plan/Late", content: "x" });
  assert.ok(r.status === 409 || r.status === 403 || r.status === 404, `refused (${r.status})`);
  assert.equal(fv.notes.size, before);
});
