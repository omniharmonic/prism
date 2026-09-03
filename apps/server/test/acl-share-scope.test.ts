/**
 * Scoped sharing (P2) — the `share` capability, which P1 defined and nothing
 * enforced, becomes real on exactly five /acl routes.
 *
 * The shape being pinned down: /acl stays an admin surface, with a single
 * carve-out — a signed-in user who holds `share` on ONE note (or ONE tag) may
 * manage that resource's people grants and nothing else. Two anti-escalation
 * rules ride on top, because "may share this" must not become "may promote
 * myself" or "may add strangers to the workspace":
 *   (a) you cannot hand out capabilities you do not hold;
 *   (b) you cannot pull a person with no account into the workspace.
 *
 * Full-stack through the real `acl` and `api` Hono apps against the fake vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { api } from "../src/routes/api";
import { addGrant, setAccount, grantsForResource, type ResourceType } from "../src/db";
import type { Cap, Level } from "../src/permissions";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  fv.put({ id: "n1", content: "<p>team doc</p>", tags: ["team"] });
  fv.put({ id: "n2", content: "<p>other doc</p>", tags: ["finance"] });
  // Everyone in these tests already has an account, except NEWCOMER.
  for (const e of [SHARER, TAG_SHARER, EDITOR, RECIPIENT]) setAccount(e, e, "hash");
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local"; // OWNER_EMAIL in .env.test → role "owner"
const SHARER = "sam@test.local"; // view+share on note n1
const TAG_SHARER = "tara@test.local"; // view+share on tag "team"
const EDITOR = "eve@test.local"; // edit on n1, but no share
const RECIPIENT = "rec@test.local"; // has an account
const NEWCOMER = "new@test.local"; // has none

const J = { "content-type": "application/json" };
const login = (email: string) => sessionCookie(makeSession(email));

function req(app: typeof acl | typeof api, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return app.request(path, { ...init, headers });
}
const aclReq = (path: string, init: RequestInit & { cookie?: string } = {}) => req(acl, path, init);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json();

function grantCaps(email: string, resourceType: ResourceType, resource: string, caps: Cap[], level: Level = "view") {
  addGrant({ subject_type: "user", subject: email.toLowerCase(), resource_type: resourceType, resource, level, created_by: "test", caps });
}

// ── the capability works ──────────────────────────────────────────────────────

test("a share-cap holder grants view on THEIR note, and the recipient's access is real", async () => {
  grantCaps(SHARER, "note", "n1", ["view", "share"]);

  const res = await aclReq("/notes/n1/people", {
    method: "PUT",
    cookie: login(SHARER),
    headers: J,
    body: JSON.stringify({ email: RECIPIENT, level: "view" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await body(res)).invited, false, "an existing account is not re-invited");

  // The grant is real, attributed to the sharer, and carries actual access.
  const g = grantsForResource("note", "n1").find((x) => x.subject === RECIPIENT)!;
  assert.equal(g.level, "view");
  assert.equal(g.created_by, SHARER, "the audit says who actually shared it");
  assert.equal((await req(api, "/notes/n1", { cookie: login(RECIPIENT) })).status, 200);

  // …and can be taken back by the same person.
  assert.equal(
    (await aclReq(`/notes/n1/people/${encodeURIComponent(RECIPIENT)}`, { method: "DELETE", cookie: login(SHARER) })).status,
    200,
  );
  assert.equal((await req(api, "/notes/n1", { cookie: login(RECIPIENT) })).status, 403);
});

test("a tag share-cap holder shares the whole folder", async () => {
  grantCaps(TAG_SHARER, "tag", "team", ["view", "share"]);
  const cookie = login(TAG_SHARER);

  const res = await aclReq("/tags/team/people", {
    method: "PUT",
    cookie,
    headers: J,
    body: JSON.stringify({ email: RECIPIENT, level: "view" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await req(api, "/notes/n1", { cookie: login(RECIPIENT) })).status, 200, "the tag grant reaches the note");
  assert.equal((await req(api, "/notes/n2", { cookie: login(RECIPIENT) })).status, 403, "and no further");

  assert.equal(
    (await aclReq(`/tags/team/people/${encodeURIComponent(RECIPIENT)}`, { method: "DELETE", cookie })).status,
    200,
  );
  assert.equal(grantsForResource("tag", "team").some((g) => g.subject === RECIPIENT), false);
});

test("the sharing picture (GET /acl/notes/:id) opens to a share-cap holder", async () => {
  grantCaps(SHARER, "note", "n1", ["view", "share"]);
  const res = await aclReq("/notes/n1", { cookie: login(SHARER) });
  assert.equal(res.status, 200);
  assert.equal((await body(res)).note.id, "n1");
});

// ── anti-escalation ───────────────────────────────────────────────────────────

test("subset rule: you cannot hand out capabilities you do not hold", async () => {
  grantCaps(SHARER, "note", "n1", ["view", "share"]);
  const cookie = login(SHARER);

  const viaLevel = await aclReq("/notes/n1/people", {
    method: "PUT",
    cookie,
    headers: J,
    body: JSON.stringify({ email: RECIPIENT, level: "edit" }),
  });
  assert.equal(viaLevel.status, 403, "a level expands to caps, and those must be a subset too");
  assert.match((await body(viaLevel)).reason, /cannot grant capabilities you do not hold/);

  const viaCaps = await aclReq("/notes/n1/people", {
    method: "PUT",
    cookie,
    headers: J,
    body: JSON.stringify({ email: RECIPIENT, caps: ["view", "delete"] }),
  });
  assert.equal(viaCaps.status, 403, "naming the caps explicitly is no way around it");

  // Sharing the `share` cap itself IS within the subset — delegation is allowed,
  // escalation is not.
  const ok = await aclReq("/notes/n1/people", {
    method: "PUT",
    cookie,
    headers: J,
    body: JSON.stringify({ email: RECIPIENT, caps: ["view", "share"] }),
  });
  assert.equal(ok.status, 200);
  assert.equal(grantsForResource("note", "n1").filter((g) => g.subject === RECIPIENT).length, 1);
});

test("a non-admin cannot invite someone who has no account", async () => {
  grantCaps(SHARER, "note", "n1", ["view", "share"]);
  const res = await aclReq("/notes/n1/people", {
    method: "PUT",
    cookie: login(SHARER),
    headers: J,
    body: JSON.stringify({ email: NEWCOMER, level: "view" }),
  });
  assert.equal(res.status, 403);
  assert.equal((await body(res)).reason, "inviting new people requires an admin");
  assert.equal(
    grantsForResource("note", "n1").some((g) => g.subject === NEWCOMER),
    false,
    "no grant was written for the stranger",
  );
});

// ── everything else stays shut ────────────────────────────────────────────────

test("no share cap → 403 on all five routes, however much edit access you have", async () => {
  grantUser(EDITOR, "note", "n1", "edit");
  grantUser(EDITOR, "tag", "team", "edit");
  const cookie = login(EDITOR);
  const payload = JSON.stringify({ email: RECIPIENT, level: "view" });

  const calls: Array<[string, RequestInit & { cookie?: string }]> = [
    ["/notes/n1/people", { method: "PUT", cookie, headers: J, body: payload }],
    [`/notes/n1/people/${encodeURIComponent(RECIPIENT)}`, { method: "DELETE", cookie }],
    ["/notes/n1", { cookie }],
    ["/tags/team/people", { method: "PUT", cookie, headers: J, body: payload }],
    [`/tags/team/people/${encodeURIComponent(RECIPIENT)}`, { method: "DELETE", cookie }],
  ];
  for (const [path, init] of calls) {
    assert.equal((await aclReq(path, init)).status, 403, `${init.method ?? "GET"} ${path}`);
  }
  assert.equal(grantsForResource("note", "n1").some((g) => g.subject === RECIPIENT), false);
});

test("the share cap opens ONE resource, not the /acl surface", async () => {
  grantCaps(SHARER, "note", "n1", ["view", "share"]);
  const cookie = login(SHARER);
  // A different note, and an unrelated admin route.
  assert.equal((await aclReq("/notes/n2", { cookie })).status, 403);
  assert.equal((await aclReq("/users", { cookie })).status, 403);
  assert.equal((await aclReq("/members", { cookie })).status, 403);
  assert.equal((await aclReq("/notes/n1/links", { method: "POST", cookie, headers: J, body: JSON.stringify({ level: "view" }) })).status, 403);
  assert.equal((await aclReq("/grants", { cookie })).status, 403);
});

test("anonymous and capability-link actors never reach the share routes", async () => {
  const anon = await aclReq("/notes/n1/people", { method: "PUT", headers: J, body: JSON.stringify({ email: RECIPIENT, level: "view" }) });
  assert.equal(anon.status, 403);
});

// ── the admin path is unchanged ───────────────────────────────────────────────

test("admin sharing is untouched: any level, any resource, auto-invite intact", async () => {
  const cookie = login(OWNER);
  const invited = await aclReq("/notes/n2/people", {
    method: "PUT",
    cookie,
    headers: J,
    body: JSON.stringify({ email: NEWCOMER, level: "edit" }),
  });
  assert.equal(invited.status, 200);
  const b = await body(invited);
  assert.equal(b.invited, true, "the auto-invite path is still admin-only, and still works");
  assert.ok(String(b.inviteUrl).includes("/accept-invite"));
  assert.equal(grantsForResource("note", "n2").find((g) => g.subject === NEWCOMER)!.level, "edit");

  assert.equal((await aclReq("/users", { cookie })).status, 200, "and the rest of /acl is still theirs");
});
