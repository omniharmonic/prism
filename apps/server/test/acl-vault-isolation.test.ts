import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { resolveLevel, docNameFor } from "../src/collab";
import {
  addGrant,
  addVaultEntry,
  setMembership,
  createCapability,
  capabilitiesForResource,
  grantsForCapability,
} from "../src/db";
import { signCapability } from "../src/auth/capability";
import {
  installFakeVault,
  resetDb,
  makeSession,
  sessionCookie,
  type FakeVault,
} from "./helpers";
const OWNER = "owner@test.local",
  ADMIN = "admin@test.local",
  SHARER = "sharer@test.local";
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  addVaultEntry({
    id: "team-b",
    label: "Team B",
    url: "http://vault.test",
    vault: "team-b",
    token: "t",
  });
  setMembership("team-b", ADMIN, "admin", OWNER);
  fv.put({
    id: "same",
    content: "Primary private title",
    tags: ["primary-tag"],
    metadata: { keep: "primary" },
  });
  fv.putIn("team-b", {
    id: "same",
    content: "Secondary title",
    tags: ["secondary-tag"],
    metadata: { keep: "secondary", prism_creator: ADMIN },
  });
});
afterEach(() => fv.restore());
function req(
  path: string,
  {
    email = ADMIN,
    vault = "team-b",
    ...init
  }: RequestInit & { email?: string; vault?: string } = {},
) {
  return acl.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie(makeSession(email)),
      "X-Prism-Vault": vault,
      ...init.headers,
    },
  });
}
function link(id: string, vault: string, note = "same") {
  const exp = Date.now() + 60_000;
  createCapability({
    id,
    resource_type: "note",
    resource: note,
    level: "edit",
    label: id,
    expires_at: exp,
  });
  addGrant({
    vault_id: vault,
    subject_type: "link",
    subject: id,
    resource_type: "note",
    resource: note,
    level: "edit",
    created_by: OWNER,
  });
  return signCapability({ id, exp });
}
function person(email: string, vault: string) {
  addGrant({
    vault_id: vault,
    subject_type: "user",
    subject: email,
    resource_type: "note",
    resource: "same",
    level: "view",
    caps: ["view", "share"],
    created_by: OWNER,
  });
}
test("sharing details stay in the selected vault for admins and scoped sharers", async () => {
  person("primary@test.local", "primary");
  person(SHARER, "team-b");
  link("primary-link", "primary");
  link("secondary-link", "team-b");
  for (const email of [ADMIN, SHARER]) {
    const r = await req("/notes/same", { email });
    assert.equal(r.status, 200);
    const access = (await r.json()) as {
      note: { title: string; tags: string[] };
      people: { email: string; caps: string[] }[];
      links: { id: string }[];
    };
    assert.equal(access.note.title, "Secondary title");
    assert.deepEqual(access.note.tags, ["secondary-tag"]);
    assert.deepEqual(
      access.people.map((p) => p.email),
      [SHARER],
    );
    assert.deepEqual(access.people[0]!.caps, ["view", "share"]);
    assert.deepEqual(
      access.links.map((l) => l.id),
      email === ADMIN ? ["secondary-link"] : [],
    );
  }
});
test("link revocation requires the exact vault and note grant", async () => {
  link("primary-link", "primary");
  link("other-note-link", "team-b", "other");
  link("secondary-link", "team-b");
  for (const id of ["primary-link", "other-note-link"]) {
    assert.equal(
      (await req(`/notes/same/links/${id}`, { method: "DELETE" })).status,
      404,
    );
    assert.equal(grantsForCapability(id).length, 1);
  }
  assert.equal(
    (await req("/notes/same/links/secondary-link", { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal(grantsForCapability("secondary-link").length, 0);
  assert.deepEqual(
    capabilitiesForResource("note", "same").map((c) => c.id),
    ["primary-link"],
  );
});
test("a capability cannot open the same note ID in a different vault over collaboration", async () => {
  const primary = link("primary-link", "primary"),
    secondary = link("secondary-link", "team-b");
  assert.equal(
    await resolveLevel(docNameFor("team-b", "same"), primary, null),
    null,
  );
  assert.equal(await resolveLevel("same", secondary, null), null);
  assert.equal(await resolveLevel("same", primary, null), "edit");
  assert.equal(
    await resolveLevel(docNameFor("team-b", "same"), secondary, null),
    "edit",
  );
});
test("tag changes touch only the selected vault's note", async () => {
  assert.equal(
    (
      await req("/notes/same/tags", {
        method: "POST",
        body: JSON.stringify({ tag: "shared" }),
      })
    ).status,
    200,
  );
  assert.deepEqual(fv.notes.get("same")!.tags, ["primary-tag"]);
  assert.deepEqual(fv.addVault("team-b").get("same")!.tags, [
    "secondary-tag",
    "shared",
  ]);
  assert.equal(
    (await req("/notes/same/tags/shared", { method: "DELETE" })).status,
    200,
  );
  assert.deepEqual(fv.addVault("team-b").get("same")!.tags, ["secondary-tag"]);
});
test("visibility writes use a delta and revision, and do not force retry conflicts", async () => {
  const initial = fv.addVault("team-b").get("same")!.updatedAt;
  assert.equal(
    (
      await req("/notes/same/visibility", {
        method: "PUT",
        body: JSON.stringify({ isPrivate: true }),
      })
    ).status,
    200,
  );
  const calls = fv.calls.filter((c) => c.method === "PATCH");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.body, {
    metadata: { prism_visibility: "private" },
    if_updated_at: initial,
  });
  assert.deepEqual(fv.addVault("team-b").get("same")!.metadata, {
    keep: "secondary",
    prism_creator: ADMIN,
    prism_visibility: "private",
  });
  assert.deepEqual(fv.notes.get("same")!.metadata, { keep: "primary" });
  fv.conflictOnNextWrite = true;
  assert.equal(
    (
      await req("/notes/same/visibility", {
        method: "PUT",
        body: JSON.stringify({ isPrivate: false }),
      })
    ).status,
    409,
  );
  assert.equal(
    fv.calls.filter((c) => c.method === "PATCH").length,
    2,
    "no forced retry",
  );
  assert.equal(
    fv.addVault("team-b").get("same")!.metadata?.prism_visibility,
    "private",
  );
});
test("invalid link bodies cannot create capabilities", async () => {
  const bodies = [
    "{",
    "null",
    "[]",
    ...[
      { level: "edit", expiresInDays: 0 },
      { level: "view", expiresInDays: -1 },
      { level: "view", expiresInDays: "30" },
      { level: "view", expiresInDays: 366 },
      { level: "view", label: 7 },
      { level: "view", label: "a".repeat(201) },
    ].map((v) => JSON.stringify(v)),
  ];
  for (const body of bodies)
    assert.equal(
      (await req("/notes/same/links", { method: "POST", body })).status,
      400,
      body,
    );
  assert.equal(capabilitiesForResource("note", "same").length, 0);
  assert.equal(
    (
      await req("/notes/same/links", {
        method: "POST",
        body: JSON.stringify({
          level: "view",
          expiresInDays: 1,
          label: "Review",
        }),
      })
    ).status,
    200,
  );
});
test("unknown vault and changed actor fail before any management mutation", async () => {
  const init = { method: "POST", body: JSON.stringify({ level: "edit" }) };
  assert.equal(
    (
      await req("/notes/same/links", {
        ...init,
        vault: "removed-vault",
        email: OWNER,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req("/notes/same/links", {
        ...init,
        headers: { "X-Prism-Write-Actor": `user:${OWNER}` },
      })
    ).status,
    409,
  );
  assert.equal(capabilitiesForResource("note", "same").length, 0);
});

test("sharing serializes legacy level capabilities and narrows sharer grant choices", async () => {
  addGrant({
    vault_id: "team-b",
    subject_type: "user",
    subject: "legacy@test.local",
    resource_type: "note",
    resource: "same",
    level: "view",
    created_by: OWNER,
  });
  person(SHARER, "team-b");
  const response = await req("/notes/same", { email: SHARER });
  assert.equal(response.status, 200);
  const access = (await response.json()) as {
    people: { email: string; caps: string[] }[];
    allowedLevels: string[];
    canManageLinks: boolean;
  };
  assert.deepEqual(
    access.people.find((p) => p.email === "legacy@test.local")!.caps,
    ["view"],
  );
  assert.deepEqual(access.allowedLevels, ["view"]);
  assert.equal(access.canManageLinks, false);
});
