/**
 * Capability grants at the gateway (P1) — full-stack through the REAL Hono apps
 * (`api` and `acl`) against the fake vault, exactly like gateway.test.ts.
 *
 * What these pin down: the four choke points now ask for a CAP rather than a
 * ladder level, so access can be composed ("may add notes here but not touch the
 * ones already there", "may refile but not rewrite", "may clean up"), while every
 * cap-less grant keeps its pre-caps behavior; and retagging cannot be used to
 * escalate out of — or orphan yourself out of — your own scope.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { acl } from "../src/routes/acl";
import { config } from "../src/config";
import { addGrant, grantsForResource, type ResourceType } from "../src/db";
import type { Cap, Level } from "../src/permissions";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const J = { "content-type": "application/json" };

function req(path: string, init?: RequestInit & { cookie?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}

/** A grant carrying an explicit capability list (level is derived by the db). */
function grantCaps(email: string, resourceType: ResourceType, resource: string, caps: Cap[], level: Level = "view") {
  addGrant({ subject_type: "user", subject: email.toLowerCase(), resource_type: resourceType, resource, level, created_by: "test", caps });
}

const login = (email: string) => sessionCookie(makeSession(email));

// ----------------------------------------------------------------- create cap

test("a create-not-edit grant may POST into its scope but cannot edit what is there", async () => {
  fv.put({ id: "n1", content: "someone else's", tags: ["intake"] });
  grantCaps("kai@test.local", "tag", "intake", ["view", "create"]);
  const cookie = login("kai@test.local");

  const created = await req("/notes", { method: "POST", cookie, headers: J, body: JSON.stringify({ content: "my submission", tags: ["intake"] }) });
  assert.equal(created.status, 200, "create is allowed by the create cap");
  const body = (await created.json()) as { id: string; metadata: Record<string, unknown> };
  assert.equal(body.metadata.prism_creator, "kai@test.local", "the creator is still stamped");

  const patched = await req("/notes/n1", { method: "PATCH", cookie, headers: J, body: JSON.stringify({ content: "hijacked" }) });
  assert.equal(patched.status, 403, "no edit cap → cannot change existing content");
  assert.equal(fv.notes.get("n1")!.content, "someone else's");

  const deleted = await req("/notes/n1", { method: "DELETE", cookie });
  assert.equal(deleted.status, 403, "no delete cap, not the creator");
});

test("back-compat: a plain `edit` grant still creates (edit expands to include create)", async () => {
  grantUser("ann@test.local", "tag", "team", "edit");
  const r = await req("/notes", {
    method: "POST",
    cookie: login("ann@test.local"),
    headers: J,
    body: JSON.stringify({ content: "hi", tags: ["team"] }),
  });
  assert.equal(r.status, 200);
});

test("a caps grant without `view` cannot read (the ladder floor does not leak it)", async () => {
  fv.put({ id: "n1", content: "secret", tags: ["intake"] });
  // Degenerate but expressible: a drop-box grant. levelForCaps floors its `level`
  // column at "view" (the ladder cannot say "nothing"), so the read path MUST be
  // decided by the caps — this is the test that proves it is.
  grantCaps("blind@test.local", "tag", "intake", ["create"]);
  const cookie = login("blind@test.local");
  assert.equal(grantsForResource("tag", "intake")[0]!.level, "view", "the stored ladder projection");

  assert.equal((await req("/notes/n1", { cookie })).status, 403, "direct GET denied");
  assert.deepEqual(await (await req("/notes", { cookie })).json(), [], "list shows nothing");
  const search = await req("/search?q=secret", { cookie });
  assert.deepEqual(await search.json(), [], "search shows nothing");
  // ...but the drop-box still works.
  assert.equal((await req("/notes", { method: "POST", cookie, headers: J, body: JSON.stringify({ content: "x", tags: ["intake"] }) })).status, 200);
});

// --------------------------------------------------------------- organize cap

test("an organize-only grant may retag but not edit content or create", async () => {
  fv.put({ id: "n1", content: "v1", tags: ["team", "draft"] });
  grantCaps("obi@test.local", "tag", "team", ["view", "organize"]);
  grantCaps("obi@test.local", "tag", "published", ["view", "organize"]); // the destination folder
  const cookie = login("obi@test.local");

  const r = await req("/notes/n1", {
    method: "PATCH",
    cookie,
    headers: J,
    body: JSON.stringify({ add_tags: ["published"], remove_tags: ["draft"] }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json() as { tags: string[] }).tags.sort(), ["published", "team"]);
  assert.deepEqual([...(fv.notes.get("n1")!.tags ?? [])].sort(), ["published", "team"]);
  assert.equal(fv.notes.get("n1")!.content, "v1", "content untouched by a retag");

  const content = await req("/notes/n1", { method: "PATCH", cookie, headers: J, body: JSON.stringify({ content: "v2" }) });
  assert.equal(content.status, 403, "organize is not edit");
  const created = await req("/notes", { method: "POST", cookie, headers: J, body: JSON.stringify({ content: "x", tags: ["team"] }) });
  assert.equal(created.status, 403, "organize is not create");
});

test("an `edit` grant cannot retag (organize is a separate power)", async () => {
  fv.put({ id: "n1", content: "v1", tags: ["team"] });
  grantUser("eddy@test.local", "tag", "team", "edit");
  const r = await req("/notes/n1", {
    method: "PATCH",
    cookie: login("eddy@test.local"),
    headers: J,
    body: JSON.stringify({ content: "v2", add_tags: ["secret"] }),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json() as { reason: string }).reason, "changing tags requires the organize capability");
  assert.equal(fv.notes.get("n1")!.content, "v1", "the whole request is rejected — no partial write");
});

test("organize also unlocks the note's path (previously admin-only), edit alone does not", async () => {
  fv.put({ id: "n1", content: "v1", path: "/original", tags: ["team"] });
  grantCaps("obi@test.local", "tag", "team", ["view", "edit", "organize"]);
  const r = await req("/notes/n1", { method: "PATCH", cookie: login("obi@test.local"), headers: J, body: JSON.stringify({ content: "v2", path: "/filed" }) });
  assert.equal(r.status, 200);
  assert.equal(fv.notes.get("n1")!.path, "/filed");

  fv.put({ id: "n2", content: "v1", path: "/original", tags: ["team"] });
  grantUser("eddy@test.local", "tag", "team", "edit");
  await req("/notes/n2", { method: "PATCH", cookie: login("eddy@test.local"), headers: J, body: JSON.stringify({ content: "v2", path: "/hijacked" }) });
  assert.equal(fv.notes.get("n2")!.path, "/original", "still silently dropped without organize");
});

// ------------------------------------------------- organize: anti-escalation

test("add_tags cannot smuggle a note into a scope the actor has no standing in", async () => {
  fv.put({ id: "n1", content: "v1", tags: ["team"] });
  grantCaps("obi@test.local", "tag", "team", ["view", "organize"]); // organize HERE only
  const r = await req("/notes/n1", { method: "PATCH", cookie: login("obi@test.local"), headers: J, body: JSON.stringify({ add_tags: ["executive"] }) });
  assert.equal(r.status, 403);
  assert.deepEqual((await r.json() as { tags: string[] }).tags, ["executive"]);
  assert.deepEqual(fv.notes.get("n1")!.tags, ["team"], "nothing was written");
});

test("add_tags is allowed into any scope where the actor holds create OR organize", async () => {
  fv.put({ id: "n1", content: "v1", tags: ["team"] });
  grantCaps("obi@test.local", "tag", "team", ["view", "organize"]);
  grantUser("obi@test.local", "tag", "inbox", "edit"); // edit ⊃ create → a valid destination
  const r = await req("/notes/n1", { method: "PATCH", cookie: login("obi@test.local"), headers: J, body: JSON.stringify({ add_tags: ["inbox"] }) });
  assert.equal(r.status, 200);
  assert.deepEqual([...(fv.notes.get("n1")!.tags ?? [])].sort(), ["inbox", "team"]);
});

test("remove_tags may not name a tag the note does not carry", async () => {
  fv.put({ id: "n1", content: "v1", tags: ["team"] });
  grantCaps("obi@test.local", "tag", "team", ["view", "organize"]);
  const r = await req("/notes/n1", { method: "PATCH", cookie: login("obi@test.local"), headers: J, body: JSON.stringify({ remove_tags: ["nope"] }) });
  assert.equal(r.status, 400);
  assert.match((await r.json() as { reason: string }).reason, /does not carry/);
});

test("remove_tags may not drop the actor's own access to the note (self-orphaning)", async () => {
  fv.put({ id: "n1", content: "v1", tags: ["team"] });
  grantCaps("obi@test.local", "tag", "team", ["view", "organize"]); // his ONLY route to n1
  const cookie = login("obi@test.local");
  const r = await req("/notes/n1", { method: "PATCH", cookie, headers: J, body: JSON.stringify({ remove_tags: ["team"] }) });
  assert.equal(r.status, 400);
  assert.match((await r.json() as { reason: string }).reason, /your own access/);
  assert.deepEqual(fv.notes.get("n1")!.tags, ["team"]);

  // ...but the same move is fine when another tag in the same request keeps him in.
  grantCaps("obi@test.local", "tag", "archive", ["view", "organize"]);
  const ok = await req("/notes/n1", { method: "PATCH", cookie, headers: J, body: JSON.stringify({ add_tags: ["archive"], remove_tags: ["team"] }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(fv.notes.get("n1")!.tags, ["archive"]);
});

// ----------------------------------------------------------------- delete cap

test("the delete cap deletes another person's note; a plain edit grant still cannot", async () => {
  fv.put({ id: "n1", content: "carol's", tags: ["team"], metadata: { prism_creator: "carol@test.local" } });
  fv.put({ id: "n2", content: "carol's", tags: ["team"], metadata: { prism_creator: "carol@test.local" } });

  grantUser("eddy@test.local", "tag", "team", "edit");
  assert.equal((await req("/notes/n1", { method: "DELETE", cookie: login("eddy@test.local") })).status, 403, "edit ≠ delete (2.4b unchanged)");

  grantCaps("dee@test.local", "tag", "team", ["view", "delete"]);
  assert.equal((await req("/notes/n1", { method: "DELETE", cookie: login("dee@test.local") })).status, 200);
  assert.equal(fv.notes.has("n1"), false);
  assert.equal(fv.notes.has("n2"), true);
});

test("back-compat: a creator with edit still deletes their OWN note, view-only still cannot", async () => {
  fv.put({ id: "n1", content: "bob's", tags: ["team"], metadata: { prism_creator: "bob@test.local" } });
  fv.put({ id: "n2", content: "eve's", tags: ["team"], metadata: { prism_creator: "eve@test.local" } });
  grantUser("bob@test.local", "tag", "team", "edit");
  grantUser("eve@test.local", "tag", "team", "view");
  assert.equal((await req("/notes/n1", { method: "DELETE", cookie: login("bob@test.local") })).status, 200);
  assert.equal((await req("/notes/n2", { method: "DELETE", cookie: login("eve@test.local") })).status, 403);
});

// ------------------------------------------------------------------ acl surface

const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

test("acl: PUT people with caps writes a coherent grant (level derived, caps stored)", async () => {
  const r = await acl.request("/tags/intake/people", {
    method: "PUT",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ email: "kai@x.co", caps: ["view", "create"] }), // no level → derived
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { level: string; caps: string[] };
  assert.equal(body.level, "view");
  assert.deepEqual(body.caps, ["view", "create"]);

  const [grant] = grantsForResource("tag", "intake");
  assert.deepEqual(grant!.caps, ["view", "create"]);
  assert.equal(grant!.level, "view", "the ladder projection, never inflated to edit");
});

test("acl: a supplied level cannot desynchronize from the caps", async () => {
  await acl.request("/notes/n1/people", {
    method: "PUT",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ email: "kai@x.co", level: "own", caps: ["view", "organize"] }),
  });
  const [grant] = grantsForResource("note", "n1");
  assert.equal(grant!.level, "view");
  assert.deepEqual(grant!.caps, ["view", "organize"]);
});

test("acl: an unknown capability name is a 400 (never silently dropped)", async () => {
  for (const caps of [["view", "administrate"], ["own"], [], "view"] as unknown[]) {
    const r = await acl.request("/tags/intake/people", {
      method: "PUT",
      headers: { ...J, cookie: ownerCookie() },
      body: JSON.stringify({ email: "kai@x.co", level: "view", caps }),
    });
    assert.equal(r.status, 400, `caps=${JSON.stringify(caps)}`);
  }
  assert.equal(grantsForResource("tag", "intake").length, 0);
});

test("acl: a caps-less people-grant is unchanged, and GET /grants reports caps", async () => {
  const cookie = ownerCookie();
  await acl.request("/tags/plain/people", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ email: "ann@x.co", level: "edit" }) });
  await acl.request("/tags/intake/people", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ email: "kai@x.co", caps: ["view", "create"] }) });

  const list = (await (await acl.request("/grants", { headers: { cookie } })).json()) as Array<{
    resource: string;
    level: string;
    caps: string[] | null;
  }>;
  assert.equal(list.find((g) => g.resource === "plain")!.caps, null);
  assert.equal(list.find((g) => g.resource === "plain")!.level, "edit");
  assert.deepEqual(list.find((g) => g.resource === "intake")!.caps, ["view", "create"]);
});

test("a path-only PATCH: organize applies it, edit no-ops it, view is still refused", async () => {
  fv.put({ id: "n1", content: "v1", path: "/original", tags: ["team"] });
  grantCaps("obi@test.local", "tag", "team", ["view", "organize"]);
  assert.equal((await req("/notes/n1", { method: "PATCH", cookie: login("obi@test.local"), headers: J, body: JSON.stringify({ path: "/filed" }) })).status, 200);
  assert.equal(fv.notes.get("n1")!.path, "/filed");

  grantUser("eddy@test.local", "tag", "team", "edit");
  const edit = await req("/notes/n1", { method: "PATCH", cookie: login("eddy@test.local"), headers: J, body: JSON.stringify({ path: "/hijacked" }) });
  assert.equal(edit.status, 200, "an editor's stray path change stays a silent no-op, not an error");
  assert.equal(fv.notes.get("n1")!.path, "/filed");

  grantUser("val@test.local", "tag", "team", "view");
  const view = await req("/notes/n1", { method: "PATCH", cookie: login("val@test.local"), headers: J, body: JSON.stringify({ path: "/nope" }) });
  assert.equal(view.status, 403, "a write attempt is refused, never echoed back as a 200");
});
