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
  assert.equal(await status(BOB, "mail"), 403);
  const r = await move(BOB, "p", { newPath: "vault/Inbox/Secret" });
  assert.equal(r.status, 403);
  const body = JSON.stringify(await r.json());
  assert.ok(!body.includes("mail") && !body.includes("Mail"), "the refusal names no hidden note");
  assert.equal(fv.notes.get("p")!.path, "vault/Team/Plan");
  assert.equal(await status(BOB, "mail"), 403);
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
  assert.equal(await status(DAVE, "draft"), 403);
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
  const ok = (await (await req(api, "/notes/draft/access-preview?parent=vault/Shared", { cookie: as(CAROL) })).json()) as { willChange: boolean; changes?: Array<{ email: string }> };
  assert.equal(ok.willChange, true);
  assert.deepEqual(ok.changes?.map((c) => c.email), [DAVE]);
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
  assert.equal(await status(BOB, "ghost"), 403);
});
