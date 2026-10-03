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
  // "Team" is a PAGE the member may add to (the destination-parent rule for a create).
  fv.put({ id: "team-root", path: "Team", content: "team page", tags: ["team"] });
  const hidden = fv.put({ id: "v-hidden", path: "Team/Private Plan", content: "hidden original", tags: ["secret"], metadata: { prism_creator: OWNER, prism_visibility: "private" } });
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
      { path: "Team/Private Plan", if_exists: "replace", content: "pwned", tags: ["team"], metadata: { prism_creator: MEM, prism_visibility: "workspace", prism_locked: true, prism_trashed_at: "2020-01-01T00:00:00.000Z", prism_last_writer: "u_forged" } },
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
    const b = await post("/notes", { content: "pwned", tags: ["team"], path: "Team/Private Plan", if_exists: mode }, mem);
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
  const b = await post("/notes", { content: "mine", tags: ["team"], path: "Team/private plan" }, mem);
  assert.equal(a.status, 409);
  assert.equal(b.status, 409);
  const [ja, jb] = [await json(a), await json(b)];
  assert.equal(ja.path, "Team/Victim", "echoes only the path the caller sent");
  assert.equal(jb.path, "Team/private plan", "…in the caller's own spelling, not the holder's");
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
    // (checked before the parent-page rule, so it answers like a taken path)
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
    notes: [{ path: "Team/Private Plan", if_exists: "replace", content: "pwned" }],
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
    ["Team/Private Plan", 409],
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
  assert.deepEqual(rows.map((n: { id: string }) => n.id).sort(), ["v-seen"], "only what the member can view");
  const call = fv.calls.filter((c) => c.method === "GET" && c.search.includes("search=")).at(-1)!;
  const sp = new URLSearchParams(call.search);
  assert.deepEqual([...sp.keys()].sort(), ["include_content", "limit", "search"]);
  assert.ok(Number(sp.get("limit")) <= 200);
  const nan = await req("/search?q=original&limit=abc", { cookie: mem });
  assert.equal(nan.status, 200);
  assert.ok(/^\d+$/.test(new URLSearchParams(fv.calls.at(-1)!.search).get("limit") ?? ""));
});

// ── round 2: the destination-parent rule, the per-tag rule, system notes, 404s ──

test("create placement: plain folders and the top level are free; inside somebody's PAGE needs create/organize there", async () => {
  const { mem } = seed();
  fv.put({ id: "hers", path: "Hers", content: "someone else's page", tags: ["hers"] });
  fv.put({ id: "ro", path: "ReadOnly", content: "viewable, not creatable", tags: ["ro"] });
  grantUser(MEM, "tag", "ro", "view");
  // No page note at the parent → as before this branch (the New menu, dropped-file imports, "Open as database").
  for (const path of ["TopLevel", "vault/TopLevel", "Folder/New", "vault/imports/2026-10-03/dropped-ab12", "Tasks database", "Deep/Plain/Folder/Note"]) {
    assert.equal((await post("/notes", { content: "x", tags: ["team"], path }, mem)).status, 200, path);
  }
  // A page the member cannot view: 404, like a missing note. One they can only view: 403.
  const hidden = await post("/notes", { content: "x", tags: ["team"], path: "Hers/New" }, mem);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await json(hidden), { error: "not_found" });
  assert.equal((await post("/notes", { content: "x", tags: ["team"], path: "ReadOnly/New" }, mem)).status, 403);
  assert.ok(![...fv.notes.values()].some((n) => n.path === "Hers/New" || n.path === "ReadOnly/New"));
  assert.equal((await post("/notes", { content: "x", tags: ["team"], path: "Team/Child" }, mem)).status, 200, "under a page they can create in");
  assert.equal((await post("/notes", { content: "x", tags: ["team"] }, mem)).status, 200, "a pathless create");
  // The MOVE route keeps its stricter rule: the top level and plain folders are the owner's.
  grantUser("org@test.local", "tag", "team", "own");
  fv.put({ id: "mv", path: "Team/Movable", content: "m", tags: ["team"] });
  assert.equal((await post("/notes/mv/move", { newParentPath: "", if_updated_at: stamp("mv") }, as("org@test.local"))).status, 403);
  assert.equal((await post("/notes/mv/move", { newParentPath: "PlainFolder", if_updated_at: stamp("mv") }, as("org@test.local"))).status, 403);
});

test("EVERY tag on a create must be addable: governed tags need standing, plain tags stay free", async () => {
  seed();
  grantUser("maker@test.local", "tag", "task", "edit");
  const maker = as("maker@test.local");
  // Ungoverned organisational tag: nobody's access hangs on it.
  assert.equal((await post("/notes", { content: "x", tags: ["task", "project-x"] }, maker)).status, 200);
  // The same tag once it is somebody's shared folder.
  grantUser("other@test.local", "tag", "project-x", "view");
  const refused = await post("/notes", { content: "x", tags: ["task", "project-x"] }, maker);
  assert.equal(refused.status, 403);
  // …a folder the maker has no standing in at all (the pre-fix smuggle: create in A, land in B).
  assert.equal((await post("/notes", { content: "x", tags: ["task", "team"] }, maker)).status, 403);
  assert.equal((await post("/notes", { content: "x", tags: ["task", "secret-club"] }, maker)).status, 200, "still ungoverned");
  // View standing is not enough; organize (or create) on that tag is.
  grantUser("maker@test.local", "tag", "project-x", "view");
  assert.equal((await post("/notes", { content: "x", tags: ["task", "project-x"] }, maker)).status, 403);
  grantCaps("maker@test.local", "tag", "team", ["view", "organize"]);
  assert.equal((await post("/notes", { content: "x", tags: ["task", "team"] }, maker)).status, 200, "organize standing in the other tag");
  // And the base rule is unchanged: no create cap anywhere → 403.
  assert.equal((await post("/notes", { content: "x", tags: ["project-x"] }, maker)).status, 403);
});

// TRUE system notes: read-only for non-owners whatever their grants.
const SYSTEM_NOTES: Array<Partial<FakeNote> & { id: string }> = [
  { id: "skill", path: "Shared/skill", tags: ["shared", "agent-skill"], metadata: { skillName: "s", enabled: true } },
  { id: "dispatch", path: "Shared/dispatch", tags: ["shared", "agent-dispatch"] },
  { id: "session", path: "Shared/session", tags: ["shared", "agent-session"] },
  { id: "alert", path: "Shared/alert", tags: ["shared", "alert"] },
  { id: "govrole", path: "Shared/govrole", tags: ["shared", "governance-role"], metadata: { name: "steward" } },
  { id: "agentfile", path: "vault/agent/reports/r1", tags: ["shared"] },
];
// INGEST-owned notes: editable per grants; only their placement and system tags are pinned.
const INGEST_NOTES: Array<Partial<FakeNote> & { id: string }> = [
  { id: "thread", path: "vault/messages/matrix/room", tags: ["shared", "message-thread"] },
  { id: "person", path: "vault/people/Ada", tags: ["shared", "person"] },
  { id: "meeting", path: "vault/meetings/2026-01-01/Sync", tags: ["shared", "meeting"] },
  { id: "cutask", path: "vault/tasks/clickup/T1", tags: ["shared", "task", "clickup"], metadata: { priority: "low" } },
  { id: "inbox", path: "vault/_inbox/transcripts/t1", tags: ["shared", "transcript"] },
];

test("true system notes are read-only for non-owners through every general write route, whatever their grants", async () => {
  grantUser("boss@test.local", "tag", "shared", "own");
  grantCaps("boss@test.local", "vault", "*", ["view", "edit", "create", "organize", "delete", "share"]);
  const boss = as("boss@test.local");
  fv.put({ id: "dest", path: "Shared", content: "page", tags: ["shared"] });
  for (const n of SYSTEM_NOTES) fv.put({ content: "original", ...n, metadata: { ...(n.metadata ?? {}), prism_creator: "boss@test.local" } });
  for (const { id } of SYSTEM_NOTES) {
    assert.equal((await req(`/notes/${id}`, { cookie: boss })).status, 200, `${id}: still readable`);
    // One history version to try to restore.
    assert.equal((await patch(id, { content: "owner edit", if_updated_at: stamp(id) }, as(OWNER))).status, 200, `${id}: the owner still writes`);
    const before = JSON.stringify(fv.notes.get(id));
    const writes = vaultWrites().length;
    const attempts: Array<[string, Response]> = [
      ["PATCH content", await patch(id, { content: "pwned", if_updated_at: stamp(id) }, boss)],
      ["PATCH metadata", await patch(id, { metadata: { enabled: true, prompt: "x" }, if_updated_at: stamp(id) }, boss)],
      ["PATCH add_tags", await patch(id, { add_tags: ["extra"] }, boss)],
      ["PATCH remove_tags", await patch(id, { remove_tags: ["shared"] }, boss)],
      ["PATCH path", await patch(id, { path: "Shared/moved", if_updated_at: stamp(id) }, boss)],
      ["restore", await post(`/notes/${id}/restore`, { version_ix: 0, if_updated_at: stamp(id) }, boss)],
      ["DELETE", await req(`/notes/${id}`, { method: "DELETE", cookie: boss })],
      ["trash", await post(`/notes/${id}/trash`, {}, boss)],
      ["move", await post(`/notes/${id}/move`, { newPath: `Shared/elsewhere-${id}`, if_updated_at: stamp(id) }, boss)],
      ["meta", await post(`/notes/${id}/meta`, { set: { prism_locked: true }, if_updated_at: stamp(id) }, boss)],
      ["properties", await post(`/properties/${id}`, { set: { priority: "high" } }, boss)],
    ];
    for (const [what, r] of attempts) assert.equal(r.status, 403, `${id}: ${what} → ${await r.clone().text()}`);
    const batch = await post("/properties/batch", { items: [{ id, set: { priority: "high" } }] }, boss);
    const item = (await json(batch)).results[0];
    assert.equal(item.ok, false, `${id}: batch`);
    assert.equal(item.error, "forbidden", `${id}: batch`);
    assert.equal(JSON.stringify(fv.notes.get(id)), before, `${id}: untouched`);
    assert.equal(vaultWrites().length, writes, `${id}: no vault write was attempted`);
  }
});

test("ingest notes stay editable per grants; only their placement and system tags are pinned", async () => {
  grantUser("ed@test.local", "tag", "shared", "own");
  const ed = as("ed@test.local");
  fv.put({ id: "dest", path: "Shared", content: "page", tags: ["shared"] });
  for (const n of INGEST_NOTES) fv.put({ content: "original", ...n });
  for (const { id } of INGEST_NOTES) {
    const tagsBefore = [...(fv.notes.get(id)!.tags ?? [])];
    const pathBefore = fv.notes.get(id)!.path;
    // Editable exactly as before this branch.
    assert.equal((await patch(id, { content: "edited body", if_updated_at: stamp(id) }, ed)).status, 200, `${id}: body`);
    assert.equal(fv.notes.get(id)!.content, "edited body");
    assert.equal((await patch(id, { metadata: { note: "m" }, if_updated_at: stamp(id) }, ed)).status, 200, `${id}: metadata`);
    assert.equal((await post(`/properties/${id}`, { set: { status: "done" } }, ed)).status, 200, `${id}: properties`);
    assert.equal(fv.notes.get(id)!.metadata!.status, "done");
    assert.equal((await patch(id, { add_tags: ["shared"] }, ed)).status, 200, `${id}: an ordinary tag`);
    assert.equal((await post(`/notes/${id}/restore`, { version_ix: 0, if_updated_at: stamp(id) }, ed)).status, 200, `${id}: restore`);
    // Pinned: move, trash, path change, system-tag changes.
    assert.equal((await post(`/notes/${id}/move`, { newPath: `Shared/elsewhere-${id}`, if_updated_at: stamp(id) }, ed)).status, 403, `${id}: move`);
    assert.equal((await post(`/notes/${id}/trash`, {}, ed)).status, 403, `${id}: trash`);
    assert.equal((await patch(id, { path: `Shared/moved-${id}`, if_updated_at: stamp(id) }, ed)).status, 403, `${id}: path`);
    assert.equal((await patch(id, { add_tags: ["agent-skill"] }, ed)).status, 403, `${id}: add agent-skill`);
    for (const t of tagsBefore.filter((x) => ["person", "message-thread"].includes(x))) {
      assert.equal((await patch(id, { remove_tags: [t] }, ed)).status, 403, `${id}: remove ${t}`);
    }
    // Identity keys are never forged.
    assert.equal((await patch(id, { metadata: { prism_creator: "ed@test.local" }, if_updated_at: stamp(id) }, ed)).status, 403, `${id}: creator`);
    assert.equal(fv.notes.get(id)!.path, pathBefore);
    assert.deepEqual([...(fv.notes.get(id)!.tags ?? [])].sort(), [...tagsBefore].sort());
  }
});

test("a member with edit on #task changes a ClickUp task's status via /api/properties", async () => {
  grantUser("worker@test.local", "tag", "task", "edit");
  fv.put({ id: "cu1", path: "vault/tasks/clickup/Fix-bug", content: "do it", tags: ["task", "clickup"], metadata: { status: "todo", source_id: "abc" } });
  const worker = as("worker@test.local");
  const r = await post("/properties/cu1", { set: { status: "in-progress" }, expect: { status: "todo" } }, worker);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(fv.notes.get("cu1")!.metadata!.status, "in-progress");
  const batch = await json(await post("/properties/batch", { items: [{ id: "cu1", set: { status: "done" } }] }, worker));
  assert.equal(batch.results[0].ok, true);
  assert.equal((await post("/notes/cu1/trash", {}, worker)).status, 403);
  assert.equal((await patch("cu1", { add_tags: ["agent-skill"] }, worker)).status, 403);
});

test("a member with edit on a meeting note edits its body and opens it live at edit level — but cannot move or trash it", async () => {
  const { resolveLevel } = await import("../src/collab");
  grantUser("att@test.local", "tag", "meeting", "edit");
  fv.put({ id: "meet1", path: "vault/meetings/2026-01-01/Sync", content: "<p>agenda</p>", tags: ["meeting"], metadata: { calendarEventId: "e1" } });
  const cookie = as("att@test.local");
  assert.equal((await patch("meet1", { content: "<p>agenda + notes</p>", if_updated_at: stamp("meet1") }, cookie)).status, 200);
  assert.equal(fv.notes.get("meet1")!.content, "<p>agenda + notes</p>");
  assert.equal(await resolveLevel("meet1", "session", cookie), "edit");
  assert.equal((await post("/notes/meet1/move", { newPath: "Elsewhere/Sync", if_updated_at: stamp("meet1") }, cookie)).status, 403);
  assert.equal((await post("/notes/meet1/trash", {}, cookie)).status, 403);
  assert.equal((await patch("meet1", { add_tags: ["agent-skill"] }, cookie)).status, 403);
  assert.equal(fv.notes.get("meet1")!.path, "vault/meetings/2026-01-01/Sync");
});

test("collab: a true system note is a read-only socket (and so takes no commands) for a non-owner; ingest notes keep their level", async () => {
  const { resolveLevel, collabLevelFor } = await import("../src/collab");
  const { collabAccess } = await import("../src/mcp/tool-collab");
  const { grantsForUser } = await import("../src/db");
  grantUser("boss@test.local", "tag", "shared", "own");
  for (const n of [...SYSTEM_NOTES, ...INGEST_NOTES]) fv.put({ content: "original", ...n });
  fv.put({ id: "plain", path: "Shared/plain", content: "c", tags: ["shared"] });
  const cookie = as("boss@test.local");
  const grants = grantsForUser("boss@test.local");
  for (const id of ["plain", ...INGEST_NOTES.map((n) => n.id)]) {
    assert.equal(await resolveLevel(id, "session", cookie), "own", `${id}: keeps its level`);
    assert.equal(collabAccess({ grants, role: "guest", email: "boss@test.local" } as never, fv.notes.get(id) as never).level, "own", `${id}: MCP`);
  }
  for (const n of SYSTEM_NOTES) {
    assert.equal(await resolveLevel(n.id, "session", cookie), "view", `${n.id}: socket`);
    const note = fv.notes.get(n.id)!;
    // The projection the command endpoint (routes/human-collab.ts) and the MCP collab tools use.
    assert.equal(collabLevelFor(grants, { id: n.id, tags: note.tags ?? [], path: note.path, creator: null, visibility: "workspace" }, "guest", "boss@test.local"), "view", `${n.id}: commands`);
    assert.equal(collabAccess({ grants, role: "guest", email: "boss@test.local" } as never, note as never).level, "view", `${n.id}: MCP`);
    assert.equal(await resolveLevel(n.id, "session", as(OWNER)), "own", `${n.id}: the owner is unaffected`);
  }
});

test("a note you cannot view answers exactly like a note that does not exist (404), on every note route", async () => {
  const { mem } = seed();
  const calls: Array<[string, (id: string) => Response | Promise<Response>]> = [
    ["GET", (id) => req(`/notes/${id}`, { cookie: mem })],
    ["PATCH", (id) => patch(id, { content: "x" }, mem)],
    ["DELETE", (id) => req(`/notes/${id}`, { method: "DELETE", cookie: mem })],
    ["versions", (id) => req(`/notes/${id}/versions`, { cookie: mem })],
    ["version", (id) => req(`/notes/${id}/versions/0`, { cookie: mem })],
    ["restore", (id) => post(`/notes/${id}/restore`, { version_ix: 0, if_updated_at: "x" }, mem)],
    ["trash", (id) => post(`/notes/${id}/trash`, {}, mem)],
    ["move", (id) => post(`/notes/${id}/move`, { newParentPath: "Team", if_updated_at: "x" }, mem)],
    ["meta", (id) => post(`/notes/${id}/meta`, { set: { prism_locked: true }, if_updated_at: "x" }, mem)],
  ];
  for (const [what, call] of calls) {
    const hidden = await call("v-hidden");
    const missing = await call("no-such-note");
    assert.equal(hidden.status, 404, what);
    assert.equal(missing.status, 404, what);
    assert.equal(await hidden.text(), await missing.text(), `${what}: identical bodies`);
    // By path and by title alias too.
    assert.equal((await call(encodeURIComponent("Team/Private Plan"))).status, 404, `${what}: by path`);
  }
  assert.equal(fv.notes.get("v-hidden")!.content, "hidden original");
  // 403 survives where the caller CAN view but lacks the cap.
  grantUser("viewer@test.local", "tag", "team", "view");
  const viewer = as("viewer@test.local");
  assert.equal((await req("/notes/v-seen", { cookie: viewer })).status, 200);
  assert.equal((await patch("v-seen", { content: "x" }, viewer)).status, 403);
  assert.equal((await req("/notes/v-seen", { method: "DELETE", cookie: viewer })).status, 403);
  assert.equal((await post("/notes/v-seen/restore", { version_ix: 0, if_updated_at: "x" }, viewer)).status, 403);
});
