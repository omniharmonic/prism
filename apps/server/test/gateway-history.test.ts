/**
 * Version history at the gateway — full-stack through the real `api` Hono app
 * against the fake vault. Non-owners read a note's history with `view` and
 * restore with `edit`; restore needs the reviewed `if_updated_at`; a restore may
 * not change who can see the note; vault attribution never reaches non-owners;
 * a pre-history (0.6.x) vault's 404 passes through so clients fall back.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const J = { "content-type": "application/json" };
const login = (email: string) => sessionCookie(makeSession(email));

function req(path: string, init?: RequestInit & { cookie?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}

/** A note with two saved versions: "v1" → "v2" → current "v3". */
async function noteWithHistory(tags = ["team"], metadata: Record<string, unknown> | null = null) {
  fv.put({ id: "n1", content: "v1", tags, metadata });
  grantUser("owner-proxy@test.local", "tag", tags[0]!, "edit");
  const cookie = login("owner-proxy@test.local");
  for (const content of ["v2", "v3"]) {
    const r = await req("/notes/n1", { method: "PATCH", cookie, headers: J, body: JSON.stringify({ content }) });
    assert.equal(r.status, 200);
  }
  resetGrants();
}

function resetGrants() {
  // Keep notes/versions; drop the setup grant so each test grants exactly what it needs.
  resetDb();
}

test("a viewer lists and reads versions, without vault attribution", async () => {
  await noteWithHistory();
  grantUser("viv@test.local", "tag", "team", "view");
  const cookie = login("viv@test.local");

  const list = await req("/notes/n1/versions", { cookie });
  assert.equal(list.status, 200);
  const page = (await list.json()) as { versions: Array<Record<string, unknown>>; total: number };
  assert.equal(page.total, 2);
  assert.equal(page.versions[0]!.version_ix, 1, "newest first");
  assert.ok(!("actor" in page.versions[0]!) && !("via" in page.versions[0]!), "provenance stripped");

  const one = await req("/notes/n1/versions/0", { cookie });
  assert.equal(one.status, 200);
  const v = (await one.json()) as Record<string, unknown>;
  assert.equal(v.content, "v1");
  assert.ok(!("actor" in v));
});

test("no grant → 403 on history; a malformed index → 400", async () => {
  await noteWithHistory();
  const stranger = login("nobody@test.local");
  assert.equal((await req("/notes/n1/versions", { cookie: stranger })).status, 403);
  grantUser("viv@test.local", "tag", "team", "view");
  assert.equal((await req("/notes/n1/versions/abc", { cookie: login("viv@test.local") })).status, 400);
});

test("a viewer cannot restore; an editor can, with the reviewed updatedAt", async () => {
  await noteWithHistory();
  grantUser("viv@test.local", "tag", "team", "view");
  grantUser("ed@test.local", "tag", "team", "edit");
  const current = fv.notes.get("n1")!;

  const denied = await req("/notes/n1/restore", {
    method: "POST",
    cookie: login("viv@test.local"),
    headers: J,
    body: JSON.stringify({ version_ix: 0, if_updated_at: current.updatedAt }),
  });
  assert.equal(denied.status, 403);
  assert.equal(fv.notes.get("n1")!.content, "v3");

  const ok = await req("/notes/n1/restore", {
    method: "POST",
    cookie: login("ed@test.local"),
    headers: J,
    body: JSON.stringify({ version_ix: 0, if_updated_at: current.updatedAt }),
  });
  assert.equal(ok.status, 200);
  assert.equal(fv.notes.get("n1")!.content, "v1");
  assert.equal(fv.versions.get("n1")!.at(-1)!.content, "v3", "the replaced text is itself a version (undoable)");
});

test("restore without if_updated_at → 428; with a stale one → 409; nothing written", async () => {
  await noteWithHistory();
  grantUser("ed@test.local", "tag", "team", "edit");
  const cookie = login("ed@test.local");

  const missing = await req("/notes/n1/restore", { method: "POST", cookie, headers: J, body: JSON.stringify({ version_ix: 0 }) });
  assert.equal(missing.status, 428);

  const stale = await req("/notes/n1/restore", {
    method: "POST",
    cookie,
    headers: J,
    body: JSON.stringify({ version_ix: 0, if_updated_at: "2020-01-01T00:00:00.000Z" }),
  });
  assert.equal(stale.status, 409);
  assert.equal(fv.notes.get("n1")!.content, "v3");
});

test("a non-owner restore may not change who can see the note", async () => {
  // The note was workspace-visible, then made private; restoring the old
  // version would re-share it.
  fv.put({ id: "n1", content: "v1", tags: ["team"], metadata: { prism_visibility: "workspace", prism_creator: "ed@test.local" } });
  grantUser("ed@test.local", "tag", "team", "edit");
  const cookie = login("ed@test.local");
  await req("/notes/n1", {
    method: "PATCH",
    cookie,
    headers: J,
    body: JSON.stringify({ content: "v2", metadata: { prism_visibility: "private", prism_creator: "ed@test.local" } }),
  });
  const before = fv.calls.length;
  const r = await req("/notes/n1/restore", {
    method: "POST",
    cookie,
    headers: J,
    body: JSON.stringify({ version_ix: 0, if_updated_at: fv.notes.get("n1")!.updatedAt }),
  });
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { reason: string }).reason, /prism_visibility/);
  assert.ok(!fv.calls.slice(before).some((c) => c.path.endsWith("/restore")), "the vault restore was never called");
  assert.equal(fv.notes.get("n1")!.content, "v2");
});

test("a pre-history (0.6.x) vault's 404 passes through so clients fall back", async () => {
  await noteWithHistory();
  fv.historySupported = false;
  grantUser("viv@test.local", "tag", "team", "view");
  const r = await req("/notes/n1/versions", { cookie: login("viv@test.local") });
  assert.equal(r.status, 404);
});
