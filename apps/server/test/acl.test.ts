/**
 * The /acl management surface backs the share dialog and is strictly OWNER
 * ONLY. Tested here: non-owners are rejected wholesale; the owner can grant
 * people access, mint capability links, and — critically — revoke a link so its
 * grant disappears (instant revocation); plus input validation.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { grantsForCapability, capabilitiesForResource, grantsForResource } from "../src/db";
import { verifyCapability } from "../src/auth/capability";
import {
  installFakeVault,
  resetDb,
  makeSession,
  sessionCookie,
  type FakeVault,
} from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";
const ownerCookie = () => sessionCookie(makeSession(OWNER));

const ownerReq = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cookie", ownerCookie());
  return acl.request(path, { ...init, headers });
};

test("every /acl route is owner-only (anon → 403)", async () => {
  assert.equal((await acl.request("/users")).status, 403);
  assert.equal((await acl.request("/notes/n1/links", { method: "POST", body: "{}" })).status, 403);
  assert.equal((await acl.request("/tags/x/people", { method: "PUT", body: "{}" })).status, 403);
});

test("a signed-in NON-owner is also rejected", async () => {
  const headers = new Headers();
  headers.set("cookie", sessionCookie(makeSession("intruder@test.local")));
  assert.equal((await acl.request("/users", { headers })).status, 403);
});

test("the desktop owner token (Bearer COLLAB_TOKEN) is accepted by /acl", async () => {
  const { config } = await import("../src/config");
  assert.ok(config.collabToken, "COLLAB_TOKEN must be set in .env.test");
  const headers = new Headers();
  headers.set("authorization", `Bearer ${config.collabToken}`);
  assert.equal((await acl.request("/users", { headers })).status, 200);
});

test("a bogus Bearer token is NOT treated as the owner on /acl", async () => {
  const headers = new Headers();
  headers.set("authorization", "Bearer not-the-collab-token");
  assert.equal((await acl.request("/users", { headers })).status, 403);
});

test("owner can grant a person access to a note", async () => {
  const r = await ownerReq("/notes/n1/people", {
    method: "PUT",
    body: JSON.stringify({ email: "Friend@Example.com", level: "comment" }),
  });
  assert.equal(r.status, 200);
  const grants = grantsForResource("note", "n1");
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.subject, "friend@example.com"); // normalized lowercase
  assert.equal(grants[0]!.level, "comment");
});

test("granting the same person again updates the level (no duplicate)", async () => {
  await ownerReq("/notes/n1/people", { method: "PUT", body: JSON.stringify({ email: "f@x.co", level: "view" }) });
  await ownerReq("/notes/n1/people", { method: "PUT", body: JSON.stringify({ email: "f@x.co", level: "edit" }) });
  const grants = grantsForResource("note", "n1");
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.level, "edit");
});

test("people-grant input is validated (bad email/level → 400)", async () => {
  assert.equal((await ownerReq("/notes/n1/people", { method: "PUT", body: JSON.stringify({ email: "nope", level: "view" }) })).status, 400);
  assert.equal((await ownerReq("/notes/n1/people", { method: "PUT", body: JSON.stringify({ email: "a@b.co", level: "admin" }) })).status, 400);
});

test("owner can mint a capability link, and it carries a verifiable token", async () => {
  const r = await ownerReq("/notes/n1/links", { method: "POST", body: JSON.stringify({ level: "view", label: "public" }) });
  assert.equal(r.status, 200);
  const link = (await r.json()) as { id: string; url: string; level: string };
  assert.equal(link.level, "view");

  // The capability + its grant both exist...
  assert.equal(capabilitiesForResource("note", "n1").length, 1);
  assert.equal(grantsForCapability(link.id).length, 1);

  // ...and the URL embeds a token that verifies back to the capability id.
  const token = new URL(link.url).searchParams.get("t")!;
  assert.equal(verifyCapability(token)?.id, link.id);
});

test("deleting a link revokes it instantly: capability and grant are gone", async () => {
  const created = await ownerReq("/notes/n1/links", { method: "POST", body: JSON.stringify({ level: "edit" }) });
  const link = (await created.json()) as { id: string };
  assert.equal(grantsForCapability(link.id).length, 1);

  const del = await ownerReq(`/notes/n1/links/${link.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);

  // Revocation removes the grant the token resolves to — so even a still-valid
  // (unexpired, correctly-signed) token now authorizes nothing.
  assert.equal(grantsForCapability(link.id).length, 0);
  assert.equal(capabilitiesForResource("note", "n1").length, 0);
});

test("link-mint input is validated (bad level → 400)", async () => {
  const r = await ownerReq("/notes/n1/links", { method: "POST", body: JSON.stringify({ level: "superuser" }) });
  assert.equal(r.status, 400);
});

test("owner sees the full sharing picture for a note (people + links + tag access)", async () => {
  fv.put({ id: "n1", content: "# Title\nbody", tags: ["team"] });
  await ownerReq("/notes/n1/people", { method: "PUT", body: JSON.stringify({ email: "p@x.co", level: "view" }) });
  await ownerReq("/notes/n1/links", { method: "POST", body: JSON.stringify({ level: "comment" }) });
  await ownerReq("/tags/team/people", { method: "PUT", body: JSON.stringify({ email: "teammate@x.co", level: "edit" }) });

  const r = await ownerReq("/notes/n1");
  assert.equal(r.status, 200);
  const view = (await r.json()) as {
    note: { title: string; tags: string[] };
    people: Array<{ email: string }>;
    links: unknown[];
    tagAccess: Array<{ tag: string; email?: string }>;
  };
  assert.equal(view.note.title, "Title"); // derived from first heading line
  assert.deepEqual(view.note.tags, ["team"]);
  assert.equal(view.people.length, 1);
  assert.equal(view.links.length, 1);
  assert.ok(view.tagAccess.some((t) => t.tag === "team" && t.email === "teammate@x.co"));
});
