/**
 * Non-owner writes are built from ALLOWLISTS, never from the caller's raw body.
 *
 * The bug this pins (security hotfix): `POST /api/notes` for a member checked the
 * cap and sanitised metadata on the TOP-LEVEL fields, then forwarded the whole body
 * to the vault — which also honours `notes: [...]` (batch), per-item `if_exists`,
 * `id`, `links`, `created_at`. One `create` grant on one tag was enough to overwrite
 * or retag any note in the vault and to forge creator/visibility/lock/trash keys.
 *
 * Through the real gateway app and the fake vault, which honours those keys the way
 * vault 0.7.9 does (test/helpers.ts) so a forwarded raw body would really land.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetPagesForTests } from "../src/pages";
import { createPublication, createVaultMirror, addGrant } from "../src/db";
import { insertGitHubConfig } from "../src/worker/sync-store";
import type { Cap } from "../src/permissions";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault, type FakeNote } from "./helpers";
import { TRASH_TAG } from "@prism/core/pages";

let fv: FakeVault;
const OWNER = "owner@test.local";
const MEM = "mem@test.local";
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
});

function req(path: string, init?: RequestInit & { cookie?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}
const as = (email: string) => sessionCookie(makeSession(email));
const post = (path: string, body: unknown, cookie: string) => req(path, { method: "POST", cookie, headers: J, body: JSON.stringify(body) });
const patch = (id: string, body: unknown, cookie: string) => req(`/notes/${id}`, { method: "PATCH", cookie, headers: J, body: JSON.stringify(body) });
const stamp = (id: string) => fv.notes.get(id)!.updatedAt;
const vaultPosts = () => fv.calls.filter((c) => c.method === "POST" && c.path.endsWith("/api/notes"));
const vaultWrites = () => fv.calls.filter((c) => c.method !== "GET");
const snapshot = () => JSON.stringify([...fv.notes.values()]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();
const grantCaps = (email: string, resourceType: "tag" | "vault", resource: string, caps: Cap[]) =>
  addGrant({ subject_type: "user", subject: email, resource_type: resourceType, resource, level: "view", caps, created_by: "test" } as never);

/** A member who may create inside #team, a note they can see and one they cannot. */
function seed(): { mem: string; seen: FakeNote; hidden: FakeNote } {
  grantUser(MEM, "tag", "team", "edit");
  const seen = fv.put({ id: "v-seen", path: "Team/Victim", content: "seen original", tags: ["team"], metadata: { prism_creator: "other@test.local" } });
  const hidden = fv.put({ id: "v-hidden", path: "Secret/Plan", content: "hidden original", tags: ["secret"], metadata: { prism_creator: OWNER, prism_visibility: "private" } });
  return { mem: as(MEM), seen, hidden };
}

// ── the reported attack ───────────────────────────────────────────────────────

test("batch `notes` cannot overwrite or retag a note the member cannot even see", async () => {
  const { mem } = seed();
  const before = snapshot();
  const r = await post("/notes", {
    content: "decoy",
    tags: ["team"],
    notes: [
      { path: "Secret/Plan", if_exists: "replace", content: "pwned", tags: ["team"], metadata: { prism_creator: MEM, prism_visibility: "workspace", prism_locked: true, prism_trashed_at: "2020-01-01T00:00:00.000Z", prism_last_writer: "u_forged" } },
      { path: "Team/Victim", if_exists: "update", content: "pwned too", tags: ["team"] },
    ],
  }, mem);
  assert.equal(r.status, 400);
  assert.equal((await json(r)).error, "invalid_request");
  assert.equal(vaultPosts().length, 0, "nothing reaches the vault");
  assert.equal(snapshot(), before, "no note changed");
  assert.deepEqual(fv.notes.get("v-hidden")!.tags, ["secret"], "not retagged into the member's folder");
});

test("a batch of only `notes` (no top-level tags) is refused the same way", async () => {
  const { mem } = seed();
  const before = snapshot();
  const r = await post("/notes", { notes: [{ content: "x", tags: ["team"], path: "Team/New" }] }, mem);
  assert.ok(r.status === 400 || r.status === 403);
  assert.equal(vaultPosts().length, 0);
  assert.equal(snapshot(), before);
});

for (const mode of ["replace", "update", "ignore"] as const) {
  test(`if_exists: "${mode}" on a victim path — viewable and hidden answer identically, victim untouched`, async () => {
    const { mem } = seed();
    const before = snapshot();
    const a = await post("/notes", { content: "pwned", tags: ["team"], path: "Team/Victim", if_exists: mode }, mem);
    const b = await post("/notes", { content: "pwned", tags: ["team"], path: "Secret/Plan", if_exists: mode }, mem);
    assert.equal(a.status, 400);
    assert.equal(b.status, a.status);
    assert.deepEqual(await json(b), await json(a));
    assert.equal(vaultPosts().length, 0);
    assert.equal(snapshot(), before);
  });
}

test("a taken path is one generic 409 whether or not the member can view the holder", async () => {
  const { mem } = seed();
  const before = snapshot();
  const a = await post("/notes", { content: "mine", tags: ["team"], path: "Team/Victim" }, mem);
  const b = await post("/notes", { content: "mine", tags: ["team"], path: "secret/plan" }, mem);
  assert.equal(a.status, 409);
  assert.equal(b.status, 409);
  const [ja, jb] = [await json(a), await json(b)];
  assert.equal(ja.path, "Team/Victim", "echoes only the path the caller sent");
  assert.equal(jb.path, "secret/plan", "…in the caller's own spelling, not the holder's");
  delete ja.path;
  delete jb.path;
  assert.deepEqual(ja, jb);
  assert.ok(!JSON.stringify([ja, jb]).includes("original"), "no content of the holder");
  assert.ok(!("current" in ja), "the vault's conflict body is not passed through");
  assert.equal(snapshot(), before);
  for (const call of vaultPosts()) assert.equal((call.body as { if_exists?: string }).if_exists, "error", "always fail-if-exists");
});

test("a member cannot choose the id of the note", async () => {
  const { mem } = seed();
  const r = await post("/notes", { content: "x", tags: ["team"], id: "v-hidden" }, mem);
  assert.equal(r.status, 400);
  const r2 = await post("/notes", { content: "x", tags: ["team"], id: "chosen-id" }, mem);
  assert.equal(r2.status, 400);
  assert.ok(!fv.notes.has("chosen-id"));
  assert.equal(fv.notes.get("v-hidden")!.content, "hidden original");
  assert.equal(vaultPosts().length, 0);
});

test("every key outside content/path/tags/metadata is refused, and the refusal names no values", async () => {
  const { mem } = seed();
  const extras: Record<string, unknown> = {
    links: [{ target: "v-hidden", relationship: "SECRETVALUE" }],
    created_at: "1999-01-01T00:00:00.000Z",
    createdAt: "1999-01-01T00:00:00.000Z",
    updated_at: "1999-01-01T00:00:00.000Z",
    force: true,
    extension: "SECRETVALUE",
    if_updated_at: "SECRETVALUE",
    anything_else: "SECRETVALUE",
  };
  for (const [k, v] of Object.entries(extras)) {
    const r = await post("/notes", { content: "x", tags: ["team"], [k]: v }, mem);
    assert.equal(r.status, 400, k);
    const text = await r.text();
    assert.equal(JSON.parse(text).error, "invalid_request", k);
    assert.ok(!text.includes("SECRETVALUE") && !text.includes("1999"), `${k}: no value echoed`);
  }
  assert.equal(vaultPosts().length, 0);
});

test("field types are checked before anything is sent", async () => {
  const { mem } = seed();
  for (const body of [
    { content: { a: 1 }, tags: ["team"] },
    { content: "x", tags: "team" },
    { content: "x", tags: ["team", 7] },
    { content: "x", tags: ["team"], metadata: ["a"] },
    { content: "x", tags: ["team"], metadata: "m" },
    { content: "x", tags: ["team"], path: 7 },
    { content: "x", tags: ["team"], path: { a: 1 } },
  ]) {
    const r = await post("/notes", body, mem);
    assert.ok(r.status === 400 || r.status === 403, JSON.stringify(body));
  }
  const arr = await post("/notes", [{ content: "x", tags: ["team"] }], mem);
  assert.ok(arr.status === 400 || arr.status === 403);
  assert.equal(vaultPosts().length, 0);
});

// ── path rules (the pages API's destination rules) ────────────────────────────

test("invalid, protected and exported paths are refused before the vault is asked", async () => {
  const { mem } = seed();
  createPublication({ id: "pubd", resource_type: "path", resource: "Published", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  createVaultMirror({ src_vault: "primary", src_prefix: "Mirrored", dest_vault: "primary", dest_prefix: "Copy" });
  insertGitHubConfig({ vaultId: "primary", vaultPath: "Synced", owner: "o", repo: "r", branch: "main", fileExtension: ".md", commitStrategy: "manual", conflictStrategy: "local-wins", autoSync: true, idMap: {}, blobMap: {}, lastSynced: "", importedFrom: null, createdBy: OWNER });
  const cases: Array<[string, number]> = [
    ["Team/../Secret/Plan", 400],
    ["../x", 400],
    ["Team//x", 400],
    ["/Team/x", 400],
    ["Team/x/", 400],
    ["Team/a\u0000b", 400],
    ["Team/a\nb", 400],
    ["Team\\x", 400],
    ["   ", 400],
    ["", 400],
    ["vault/people/Mallory", 403],
    ["vault/messages/email/fake-thread", 403],
    ["VAULT/Agent/dispatches/x", 403],
    ["vault/meetings/2026-01-01/fake", 403],
    ["vault/tasks/clickup/fake", 403],
    ["Published/Defaced", 403],
    ["Mirrored/Leak", 403],
    ["Synced/Leak", 403],
  ];
  for (const [path, status] of cases) {
    const r = await post("/notes", { content: "x", tags: ["team"], path }, mem);
    assert.equal(r.status, status, JSON.stringify(path));
  }
  assert.equal(vaultPosts().length, 0);
  // The owner is not bound by any of it (passthrough).
  assert.equal((await post("/notes", { content: "x", tags: ["team"], path: "Published/Owner" }, as(OWNER))).status, 200);
});

test("a path under a trashed page is refused like a taken path (no trash oracle)", async () => {
  const { mem } = seed();
  fv.put({ id: "bin", path: "Team/Old", content: "gone", tags: ["team", TRASH_TAG], metadata: { prism_trashed_at: "2026-01-01T00:00:00.000Z" } });
  fv.put({ id: "bin2", path: "Secret/Old", content: "gone", tags: ["secret", TRASH_TAG], metadata: { prism_trashed_at: "2026-01-01T00:00:00.000Z" } });
  for (const path of ["Team/Old/Child", "team/old/Deep/Er", "Secret/Old/Child"]) {
    const r = await post("/notes", { content: "x", tags: ["team"], path }, mem);
    assert.equal(r.status, 409, path);
    const j = await json(r);
    assert.equal(j.error, "path_conflict");
    assert.equal(j.path, path);
  }
  assert.equal(vaultPosts().length, 0);
  // A sibling that merely shares the prefix is fine.
  assert.equal((await post("/notes", { content: "x", tags: ["team"], path: "Team/Older" }, mem)).status, 200);
});

// ── what still works ──────────────────────────────────────────────────────────

test("a member with the create cap still creates — with and without a path", async () => {
  const { mem } = seed();
  const withPath = await post("/notes", { content: "hello", tags: ["team"], path: "Team/New Page", metadata: { title: "New Page", prism_creator: "forged@x", prism_locked: true, prism_trashed_at: "x", prism_visibility: "private" } }, mem);
  assert.equal(withPath.status, 200);
  const a = await json(withPath);
  assert.equal(a.path, "Team/New Page");
  assert.equal(a.metadata.prism_creator, MEM, "creator is the authenticated subject");
  assert.equal(a.metadata.prism_visibility, "private", "narrowing to private is allowed");
  assert.ok(!("prism_locked" in a.metadata) && !("prism_trashed_at" in a.metadata));
  assert.equal(a.metadata.title, "New Page");

  const noPath = await post("/notes", { content: "pathless", tags: ["team"] }, mem);
  assert.equal(noPath.status, 200);
  assert.equal((await json(noPath)).path, null);

  const bare = await post("/notes", { tags: ["team"] }, mem);
  assert.equal(bare.status, 200, "content defaults to empty");

  for (const call of vaultPosts()) {
    const sent = call.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent).filter((k) => !["content", "path", "tags", "metadata", "if_exists"].includes(k)), [], "only allowlisted keys reach the vault");
    assert.equal(sent.if_exists, "error");
    assert.ok(!("notes" in sent) && !("id" in sent) && !("links" in sent));
  }
});

test("the trash tag is dropped, never set, on a member create", async () => {
  const { mem } = seed();
  const r = await post("/notes", { content: "x", tags: ["team", TRASH_TAG] }, mem);
  assert.equal(r.status, 200);
  assert.deepEqual((await json(r)).tags, ["team"]);
});

test("no create cap → 403 before any validation detail; links and anon never create", async () => {
  seed();
  grantUser("viewer@test.local", "tag", "team", "view");
  const viewer = as("viewer@test.local");
  assert.equal((await post("/notes", { content: "x", tags: ["team"] }, viewer)).status, 403);
  assert.equal((await post("/notes", { content: "x", tags: ["team"], notes: [{ content: "y", tags: ["team"] }] }, viewer)).status, 403);
  const link = makeCapability("tag", "team", "edit");
  const viaLink = await api.request("/notes", { method: "POST", headers: { ...J, authorization: `Capability ${link}` }, body: JSON.stringify({ content: "x", tags: ["team"] }) });
  assert.equal(viaLink.status, 403);
  assert.equal((await api.request("/notes", { method: "POST", headers: J, body: JSON.stringify({ content: "x", tags: ["team"] }) })).status, 403);
  assert.equal(vaultPosts().length, 0);
});

test("owner passthrough is unchanged: batch create and if_exists still reach the vault verbatim", async () => {
  seed();
  const owner = as(OWNER);
  const batch = await post("/notes", { notes: [{ content: "a", path: "Batch/A", tags: ["x"], id: "owner-chosen" }, { content: "b", path: "Batch/B", tags: ["x"] }] }, owner);
  assert.equal(batch.status, 200);
  const made = await json(batch);
  assert.equal(made.length, 2);
  assert.ok(fv.notes.has("owner-chosen"));
  const sent = vaultPosts().at(-1)!.body as { notes: unknown[] };
  assert.equal(sent.notes.length, 2, "the batch body is forwarded as sent");

  const replace = await post("/notes", { content: "owner rewrote", path: "Team/Victim", if_exists: "replace" }, owner);
  assert.equal(replace.status, 200);
  assert.equal(fv.notes.get("v-seen")!.content, "owner rewrote");
});

// ── tags: a create may not smuggle a note into a system tag or onto a public site ──

test("a member create cannot carry system tags (agent-skill, governance-*, person, …)", async () => {
  const { mem } = seed();
  grantCaps("wide@test.local", "vault", "*", ["view", "create", "organize", "edit"]);
  const wide = as("wide@test.local");
  for (const tag of ["agent-skill", "agent-dispatch", "agent-session", "governance-membership", "governance-config", "person", "message-thread", "alert"]) {
    for (const cookie of [mem, wide]) {
      const r = await post("/notes", { content: "do things", tags: ["team", tag], metadata: { skillName: "evil", enabled: true, intervalSecs: 60 } }, cookie);
      assert.equal(r.status, 403, tag);
    }
  }
  assert.equal(vaultPosts().length, 0);
});

test("a member create cannot add a PUBLISHED tag they have no create standing in", async () => {
  const { mem } = seed();
  createPublication({ id: "site", resource_type: "tag", resource: "wiki", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER });
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "wiki", level: "view", created_by: OWNER } as never);
  const r = await post("/notes", { content: "defaced", tags: ["team", "wiki"] }, mem);
  assert.equal(r.status, 403);
  assert.equal(vaultPosts().length, 0);
  // Someone who may create in the published tag itself still can.
  grantUser("editor@test.local", "tag", "wiki", "edit");
  assert.equal((await post("/notes", { content: "fine", tags: ["wiki"] }, as("editor@test.local"))).status, 200);
});

// ── PATCH /notes/:id (step 4) ─────────────────────────────────────────────────

test("PATCH forwards only its own fields: links / if_exists / id / tags-op / created_at never reach the vault", async () => {
  const { mem } = seed();
  fv.put({ id: "mine", path: "Team/Mine", content: "c", tags: ["team"], metadata: { prism_creator: MEM } });
  const r = await patch("mine", {
    content: "edited",
    if_updated_at: stamp("mine"),
    links: { add: [{ target: "v-hidden", relationship: "references" }] },
    tags: { add: ["secret"], remove: ["team"] },
    force: true,
    id: "v-hidden",
    created_at: "1999-01-01T00:00:00.000Z",
    if_exists: "replace",
    notes: [{ path: "Secret/Plan", if_exists: "replace", content: "pwned" }],
  }, mem);
  assert.equal(r.status, 200);
  const sent = fv.calls.filter((c) => c.method === "PATCH").at(-1)!.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["content", "if_updated_at", "metadata"]);
  assert.deepEqual(fv.notes.get("mine")!.tags, ["team"]);
  assert.equal(fv.notes.get("mine")!.links, undefined);
  assert.equal(fv.notes.get("v-hidden")!.content, "hidden original");
});

test("PATCH checks field types", async () => {
  const { mem } = seed();
  fv.put({ id: "mine", path: "Team/Mine", content: "c", tags: ["team"], metadata: { prism_creator: MEM } });
  for (const body of [{ content: { a: 1 } }, { metadata: ["x"] }, { metadata: "x" }, { path: 7 }, { if_updated_at: { a: 1 }, content: "x" }, { content: 5 }]) {
    assert.equal((await patch("mine", body, mem)).status, 400, JSON.stringify(body));
  }
  assert.equal(vaultWrites().length, 0);
  assert.equal(fv.notes.get("mine")!.content, "c");
});

test("PATCH path obeys the pages destination rules for an organizer", async () => {
  seed();
  grantUser("org@test.local", "tag", "team", "own");
  const org = as("org@test.local");
  fv.put({ id: "mine", path: "Team/Mine", content: "c", tags: ["team"] });
  fv.put({ id: "bin", path: "Team/Old", content: "gone", tags: ["team", TRASH_TAG], metadata: { prism_trashed_at: "2026-01-01T00:00:00.000Z" } });
  createPublication({ id: "pubd", resource_type: "path", resource: "Published", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  const cases: Array<[unknown, number]> = [
    ["Team/../Secret/Plan2", 400],
    ["Team//x", 400],
    ["vault/people/Mallory", 403],
    ["vault/agent/skills/evil", 403],
    ["Published/Mine", 403],
    ["Team/Old/Mine", 409],
    ["Secret/Plan", 409],
    ["Team/Victim", 409],
  ];
  for (const [path, status] of cases) {
    const r = await patch("mine", { path, if_updated_at: stamp("mine") }, org);
    assert.equal(r.status, status, JSON.stringify(path));
    if (status === 409) {
      const j = await json(r);
      assert.equal(j.error, "path_conflict");
      assert.ok(!("current" in j));
    }
  }
  assert.equal(fv.notes.get("mine")!.path, "Team/Mine");
  // An ordinary rename still works.
  const ok = await patch("mine", { path: "Team/Renamed", if_updated_at: stamp("mine") }, org);
  assert.equal(ok.status, 200);
  assert.equal(fv.notes.get("mine")!.path, "Team/Renamed");
});

test("PATCH cannot move a system note, and cannot add a system tag even with vault-wide organize", async () => {
  seed();
  grantCaps("wide@test.local", "vault", "*", ["view", "create", "organize", "edit"]);
  const wide = as("wide@test.local");
  fv.put({ id: "person", path: "vault/people/Ada", content: "p", tags: ["person"] });
  fv.put({ id: "plain", path: "Team/Plain", content: "p", tags: ["team"] });
  assert.equal((await patch("person", { path: "Team/Ada", if_updated_at: stamp("person") }, wide)).status, 403);
  assert.equal(fv.notes.get("person")!.path, "vault/people/Ada");
  for (const tag of ["agent-skill", "governance-membership", "person"]) {
    assert.equal((await patch("plain", { add_tags: [tag] }, wide)).status, 403, tag);
  }
  assert.deepEqual(fv.notes.get("plain")!.tags, ["team"]);
  assert.equal((await patch("plain", { add_tags: ["extra"] }, wide)).status, 200, "an ordinary tag is fine");
});

test("PATCH and DELETE act on the note that was authorized, by id — not on a re-resolved alias", async () => {
  const { mem } = seed();
  fv.put({ id: "mine", path: "Team/Mine", content: "c", tags: ["team"], metadata: { prism_creator: MEM } });
  const r = await patch("Team%2FMine", { content: "by path", if_updated_at: stamp("mine") }, mem);
  assert.equal(r.status, 200);
  assert.ok(fv.calls.filter((c) => c.method === "PATCH").every((c) => c.path.endsWith("/notes/mine")));
  const d = await req("/notes/Team%2FMine", { method: "DELETE", cookie: mem });
  assert.equal(d.status, 200);
  assert.ok(fv.calls.filter((c) => c.method === "DELETE").every((c) => c.path.endsWith("/notes/mine")));
});

// ── restore (step 4): history may not bring back owner-only state ─────────────

test("a non-owner restore cannot change lock / trash metadata", async () => {
  const { mem } = seed();
  fv.put({ id: "mine", path: "Team/Mine", content: "v1", tags: ["team"], metadata: { prism_creator: MEM, prism_locked: true, prism_trashed_at: "2026-01-01T00:00:00.000Z", prism_trashed_path: "Team/Mine" } });
  // The owner clears those keys (a history version now holds the old state).
  const cleared = await patch("mine", { metadata: { prism_locked: null, prism_trashed_at: null, prism_trashed_path: null }, if_updated_at: stamp("mine") }, as(OWNER));
  assert.equal(cleared.status, 200);
  assert.ok(!("prism_locked" in fv.notes.get("mine")!.metadata!));
  const r = await post("/notes/mine/restore", { version_ix: 0, if_updated_at: stamp("mine") }, mem);
  assert.equal(r.status, 403);
  assert.ok(!("prism_locked" in fv.notes.get("mine")!.metadata!), "still unlocked");
  assert.ok(!("prism_trashed_at" in fv.notes.get("mine")!.metadata!));
  const bad = await post("/notes/mine/restore", { version_ix: 0, if_updated_at: { a: 1 } }, mem);
  assert.ok(bad.status === 400 || bad.status === 428);
});

// ── search (step 4) ───────────────────────────────────────────────────────────

test("search forwards only the query text and a bounded limit", async () => {
  const { mem } = seed();
  const r = await req("/search?q=original&limit=999999&tag=secret&near=v-hidden&path_prefix=Secret&include_links=true&meta.prism_creator=x", { cookie: mem });
  assert.equal(r.status, 200);
  const rows = await json(r);
  assert.deepEqual(rows.map((n: { id: string }) => n.id), ["v-seen"], "only what the member can view");
  const call = fv.calls.filter((c) => c.method === "GET" && c.search.includes("search=")).at(-1)!;
  const sp = new URLSearchParams(call.search);
  assert.deepEqual([...sp.keys()].sort(), ["include_content", "limit", "search"]);
  assert.ok(Number(sp.get("limit")) <= 200);
  const nan = await req("/search?q=original&limit=abc", { cookie: mem });
  assert.equal(nan.status, 200);
  assert.ok(/^\d+$/.test(new URLSearchParams(fv.calls.at(-1)!.search).get("limit") ?? ""));
});
