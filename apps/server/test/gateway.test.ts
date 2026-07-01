/**
 * The permission gateway — the single trust boundary for the web/shared path.
 * These are full-stack tests through the real Hono `api` app: an actor is
 * resolved from a session cookie or capability token, authorization runs, and
 * only then is the (faked) vault reached. The invariants under test are the
 * ones a leak would violate:
 *   - anon/non-owner never see the raw vault, only what their grants allow
 *   - the owner gets a transparent, token-bearing passthrough
 *   - writes require the right level; structure stays owner-controlled
 *   - every unlisted /api path is denied (deny-by-default)
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import {
  installFakeVault,
  resetDb,
  makeSession,
  sessionCookie,
  grantUser,
  makeCapability,
  type FakeVault,
} from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";

function req(path: string, init?: RequestInit & { cookie?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}
const ownerReq = (path: string, init?: RequestInit) =>
  req(path, { ...init, cookie: sessionCookie(makeSession(OWNER)) });

// ---------------------------------------------------------------- anonymous

test("anon GET /notes returns an empty list, NOT the vault", async () => {
  fv.put({ id: "n1", content: "secret", tags: ["private"] });
  const r = await req("/notes");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test("anon GET /notes/:id on a real note is forbidden", async () => {
  fv.put({ id: "n1", content: "secret", tags: ["private"] });
  const r = await req("/notes/n1");
  assert.equal(r.status, 403);
});

test("anon write attempts are forbidden", async () => {
  assert.equal((await req("/notes", { method: "POST", body: "{}" })).status, 403);
  fv.put({ id: "n1", content: "x", tags: [] });
  assert.equal((await req("/notes/n1", { method: "DELETE" })).status, 403);
});

// -------------------------------------------------------------------- owner

test("owner GET /notes is a transparent passthrough to the full vault", async () => {
  fv.put({ id: "n1", content: "a", tags: ["x"] });
  fv.put({ id: "n2", content: "b", tags: ["y"] });
  const r = await ownerReq("/notes");
  assert.equal(r.status, 200);
  const body = (await r.json()) as unknown[];
  assert.equal(body.length, 2);
  // The vault was reached WITH the server-held bearer token...
  const vaultCall = fv.calls.find((c) => c.path.endsWith("/api/notes"));
  assert.equal(vaultCall?.authorization, "Bearer test-vault-token");
  // ...and the token is never echoed back to the client.
  assert.equal(r.headers.get("authorization"), null);
});

test("owner can create, patch, and delete (passthrough write)", async () => {
  const created = await ownerReq("/notes", { method: "POST", body: JSON.stringify({ content: "hi", tags: ["t"] }) });
  assert.equal(created.status, 200);
  const note = (await created.json()) as { id: string };
  assert.ok(note.id);

  const patched = await ownerReq(`/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ content: "edited", path: "/moved" }) });
  assert.equal(patched.status, 200);
  // Owner CAN restructure (path applied) — passthrough sends it verbatim.
  const patchCall = fv.calls.find((c) => c.method === "PATCH");
  assert.equal((patchCall?.body as { path?: string }).path, "/moved");

  const del = await ownerReq(`/notes/${note.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
});

test("owner reaches arbitrary vault paths via passthrough (not the 403 catch-all)", async () => {
  const r = await ownerReq("/some/vault/feature");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { passthrough: "/some/vault/feature", method: "GET" });
});

// ------------------------------------------------------ capability (link) view

test("a view capability on a tag sees only that tag's notes", async () => {
  fv.put({ id: "n1", content: "shared one", tags: ["proj"] });
  fv.put({ id: "n2", content: "shared two", tags: ["proj"] });
  fv.put({ id: "n3", content: "private", tags: ["secret"] });
  const t = makeCapability("tag", "proj", "view");
  const r = await req(`/notes?t=${encodeURIComponent(t)}`);
  const body = (await r.json()) as Array<{ id: string }>;
  assert.deepEqual(body.map((n) => n.id).sort(), ["n1", "n2"]);
});

test("a view capability gets the granted note with its level, but 403 on others", async () => {
  fv.put({ id: "n1", content: "shared", tags: ["proj"] });
  fv.put({ id: "n3", content: "private", tags: ["secret"] });
  const t = makeCapability("tag", "proj", "view");

  const ok = await req(`/notes/n1?t=${encodeURIComponent(t)}`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { _level: string })._level, "view");

  const denied = await req(`/notes/n3?t=${encodeURIComponent(t)}`);
  assert.equal(denied.status, 403);
});

test("a view capability cannot write (below edit)", async () => {
  fv.put({ id: "n1", content: "shared", tags: ["proj"] });
  const t = makeCapability("tag", "proj", "view");
  const r = await req(`/notes/n1?t=${encodeURIComponent(t)}`, { method: "PATCH", body: JSON.stringify({ content: "hax" }) });
  assert.equal(r.status, 403);
  assert.equal(fv.notes.get("n1")!.content, "shared"); // unchanged
});

// --------------------------------------------------------- signed-in collaborator

test("an edit grant lets a non-owner change content, but NOT restructure (path locked)", async () => {
  fv.put({ id: "n1", content: "v1", path: "/original", tags: ["team"] });
  grantUser("alice@test.local", "tag", "team", "edit");
  const cookie = sessionCookie(makeSession("alice@test.local"));

  const r = await req("/notes/n1", { method: "PATCH", cookie, body: JSON.stringify({ content: "v2", path: "/hijacked" }) });
  assert.equal(r.status, 200);
  const note = fv.notes.get("n1")!;
  assert.equal(note.content, "v2"); // content edit applied
  assert.equal(note.path, "/original"); // path change dropped for non-owner
});

test("a view grant cannot write", async () => {
  fv.put({ id: "n1", content: "v1", tags: ["team"] });
  grantUser("bob@test.local", "tag", "team", "view");
  const cookie = sessionCookie(makeSession("bob@test.local"));
  const r = await req("/notes/n1", { method: "PATCH", cookie, body: JSON.stringify({ content: "v2" }) });
  assert.equal(r.status, 403);
});

test("an individually granted note appears in the non-owner's list", async () => {
  fv.put({ id: "n1", content: "just this one", tags: ["untagged-for-acl"] });
  grantUser("carol@test.local", "note", "n1", "view");
  const cookie = sessionCookie(makeSession("carol@test.local"));
  const r = await req("/notes", { cookie });
  const body = (await r.json()) as Array<{ id: string }>;
  assert.deepEqual(body.map((n) => n.id), ["n1"]);
});

test("non-owners cannot create or delete notes", async () => {
  fv.put({ id: "n1", content: "x", tags: ["team"] });
  grantUser("dave@test.local", "tag", "team", "edit"); // edit on a tag ≠ delete others' notes
  const cookie = sessionCookie(makeSession("dave@test.local"));
  assert.equal((await req("/notes", { method: "POST", cookie, body: JSON.stringify({ content: "y" }) })).status, 403);
  assert.equal((await req("/notes/n1", { method: "DELETE", cookie })).status, 403);
});

test("a member may delete their OWN note (creator + edit), but never someone else's (2.4b)", async () => {
  fv.put({ id: "n1", content: "bob's", tags: ["team"], metadata: { prism_creator: "bob@test.local" } });
  fv.put({ id: "n2", content: "carol's", tags: ["team"], metadata: { prism_creator: "carol@test.local" } });
  grantUser("bob@test.local", "tag", "team", "edit"); // edit on the folder, and he authored n1
  const cookie = sessionCookie(makeSession("bob@test.local"));
  assert.equal((await req("/notes/n1", { method: "DELETE", cookie })).status, 200, "his own note → deletable");
  assert.equal((await req("/notes/n2", { method: "DELETE", cookie })).status, 403, "carol's note → forbidden even with edit");
});

test("delete needs edit, not just view — a creator with only view can't delete", async () => {
  fv.put({ id: "n1", content: "mine", tags: ["team"], metadata: { prism_creator: "eve@test.local" } });
  grantUser("eve@test.local", "tag", "team", "view"); // creator, but only view
  const cookie = sessionCookie(makeSession("eve@test.local"));
  assert.equal((await req("/notes/n1", { method: "DELETE", cookie })).status, 403);
});

// ----------------------------------------------------------- search & tags

test("search results are filtered to what the actor may view", async () => {
  fv.put({ id: "n1", content: "find me here", tags: ["proj"] });
  fv.put({ id: "n2", content: "find me too", tags: ["secret"] });
  const t = makeCapability("tag", "proj", "view");
  const r = await req(`/search?q=find&t=${encodeURIComponent(t)}`);
  const body = (await r.json()) as Array<{ id: string }>;
  assert.deepEqual(body.map((n) => n.id), ["n1"]);
});

test("the tag list is filtered to the actor's granted tags", async () => {
  fv.tags = [
    { name: "proj", count: 3 },
    { name: "secret", count: 9 },
  ];
  const t = makeCapability("tag", "proj", "view");
  const r = await req(`/tags?t=${encodeURIComponent(t)}`);
  const body = (await r.json()) as Array<{ tag: string }>;
  assert.deepEqual(body.map((x) => x.tag), ["proj"]);
});

// --------------------------------------------------------- deny-by-default

test("any unlisted /api path is denied for non-owners (deny-by-default)", async () => {
  const r = await req("/graph/export");
  assert.equal(r.status, 403);
  // And the vault was never touched for that path.
  assert.equal(fv.calls.some((c) => c.path.includes("/graph")), false);
});
