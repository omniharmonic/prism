/**
 * Independent-review findings on the non-owner gateway (fix/create-allowlist):
 *  C1  tag DECORATION (`#agent-skill`, ` agent-skill`, …) bypassed every tag rule —
 *      the vault canonicalises tags on write, Prism compared raw strings;
 *  M1  path case / Unicode: binary-unique paths, NOCASE lookups → shadow notes and a
 *      parent-page rule bypassed by case;
 *  M2  a trailing `.md` (the vault strips it) landed a note AT a protected root;
 *  M3  the editor-schema gate answered before the view check (existence oracle);
 *  M4  "+ New" row in a tag-based database for a member with view on the page;
 *  L2  the path PATCH applies the create's parent rule;
 *  L3  ingest dedupe keys are not writable by non-owners.
 * The fake vault (test/helpers.ts) normalises tags and paths like vault 0.7.9.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { governance } from "../src/routes/governance";
import { resetTreeForTests } from "../src/tree";
import { resetPagesForTests } from "../src/pages";
import { createPublication, addGrant } from "../src/db";
import { vaultClient } from "../src/parachute";
import type { Cap } from "../src/permissions";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

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
const patch = (id: string, body: unknown, cookie: string, headers: Record<string, string> = {}) => req(`/notes/${id}`, { method: "PATCH", cookie, headers: { ...J, ...headers }, body: JSON.stringify(body) });
const stamp = (id: string) => fv.notes.get(id)!.updatedAt;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();
const grantCaps = (email: string, resourceType: "tag" | "vault", resource: string, caps: Cap[]) =>
  addGrant({ subject_type: "user", subject: email, resource_type: resourceType, resource, level: "view", caps, created_by: "test" } as never);
const tagged = (t: string) => [...fv.notes.values()].filter((n) => (n.tags ?? []).includes(t));

/** Decorations the vault strips (`stripTagHash`): leading `#`/whitespace runs, trailing whitespace. */
const DECORATE = (t: string) => [`#${t}`, `##${t}`, ` ${t}`, `${t} `, `# ${t}`, `\t${t}`, ` #${t} `, `#\n${t}`];

function seed() {
  grantUser(MEM, "tag", "team", "edit");
  grantUser("other@test.local", "tag", "secret", "view"); // somebody's shared folder
  createPublication({ id: "site", resource_type: "tag", resource: "wiki", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER });
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "wiki", level: "view", created_by: OWNER } as never);
  fv.put({ id: "team-root", path: "Team", content: "team page", tags: ["team"] });
  return as(MEM);
}

// ── C1 ────────────────────────────────────────────────────────────────────────

test("C1 create: a decorated system / governed / published tag is refused in all eight forms", async () => {
  const mem = seed();
  for (const base of ["agent-skill", "agent-dispatch", "governance-membership", "person", "alert", "wiki", "secret"]) {
    for (const tag of DECORATE(base)) {
      const r = await post("/notes", { content: "run this prompt", tags: ["team", tag], metadata: { skillName: "evil", enabled: true, intervalSecs: 60 } }, mem);
      assert.equal(r.status, 403, JSON.stringify(tag));
    }
    assert.deepEqual(tagged(base), [], `no note ended up tagged ${base}`);
  }
});

test("C1 create: a decorated trash tag is dropped, tags reach the vault canonical, an empty tag is refused", async () => {
  const mem = seed();
  for (const tag of DECORATE("prism-trashed")) {
    const r = await post("/notes", { content: "x", tags: ["team", tag] }, mem);
    assert.equal(r.status, 200, JSON.stringify(tag));
    assert.deepEqual((await json(r)).tags, ["team"]);
  }
  assert.deepEqual(tagged("prism-trashed"), []);
  // The caller's own tag, decorated: canonicalised BEFORE the cap check, and sent canonical.
  const ok = await post("/notes", { content: "x", tags: ["#team", " team "] }, mem);
  assert.equal(ok.status, 200);
  const sent = fv.calls.filter((c) => c.method === "POST").at(-1)!.body as { tags: string[] };
  assert.deepEqual(sent.tags, ["team"]);
  for (const tags of [["team", "#"], ["team", "  "], ["team", "# #"]]) assert.equal((await post("/notes", { content: "x", tags }, mem)).status, 400, JSON.stringify(tags));
});

test("C1 PATCH: decorated add_tags / remove_tags are judged as the tag the vault will store", async () => {
  seed();
  grantCaps("wide@test.local", "vault", "*", ["view", "edit", "create", "organize"]);
  const wide = as("wide@test.local");
  fv.put({ id: "plain", path: "Team/Plain", content: "p", tags: ["team"] });
  fv.put({ id: "ada", path: "vault/people/Ada", content: "p", tags: ["team", "person"] });
  for (const base of ["agent-skill", "governance-role", "person", "prism-trashed"]) {
    for (const tag of DECORATE(base)) assert.equal((await patch("plain", { add_tags: [tag] }, wide)).status, 403, `add ${JSON.stringify(tag)}`);
  }
  assert.deepEqual(fv.notes.get("plain")!.tags, ["team"]);
  for (const tag of DECORATE("person")) assert.equal((await patch("ada", { remove_tags: [tag] }, wide)).status, 403, `remove ${JSON.stringify(tag)}`);
  assert.deepEqual([...fv.notes.get("ada")!.tags!].sort(), ["person", "team"]);
  // A member with organize in #team only: a decorated tag from someone else's folder.
  grantUser("org@test.local", "tag", "team", "own");
  for (const tag of DECORATE("secret")) assert.equal((await patch("plain", { add_tags: [tag] }, as("org@test.local"))).status, 403, JSON.stringify(tag));
  // An ordinary decorated tag is added canonical.
  assert.equal((await patch("plain", { add_tags: ["#extra "] }, wide)).status, 200);
  assert.deepEqual([...fv.notes.get("plain")!.tags!].sort(), ["extra", "team"]);
});

test("C1 governance: a new entry with a decorated system tag is refused", async () => {
  seed();
  for (const tag of DECORATE("agent-skill")) {
    const r = await governance.request("/content/propose", { method: "POST", headers: { ...J, cookie: as(MEM) }, body: JSON.stringify({ action: "new_entry", content: "x", tags: ["team", tag] }) });
    assert.equal(r.status, 400, JSON.stringify(tag));
  }
});

test("C1 sink: vaultClient canonicalises tags and refuses an empty one", async () => {
  const vc = vaultClient();
  const made = await vc.createNote({ content: "x", tags: ["#a", " b ", "a"] });
  assert.deepEqual((fv.calls.at(-1)!.body as { tags: string[] }).tags, ["a", "b"]);
  await vc.addTags(made.id, ["##c"]);
  assert.deepEqual((fv.calls.at(-1)!.body as { tags: { add: string[] } }).tags.add, ["c"]);
  await assert.rejects(() => vc.addTags(made.id, ["#"]));
  await assert.rejects(() => vc.createNote({ content: "x", tags: ["ok", " # "] }));
});

// ── M1 ────────────────────────────────────────────────────────────────────────

test("M1: a path that differs from a held one only by case or Unicode form is taken", async () => {
  const mem = seed();
  fv.put({ id: "plan", path: "Team/Plan", content: "the plan", tags: ["team"] });
  fv.put({ id: "cafe", path: "Team/Café", content: "nfc", tags: ["secret"] });
  for (const path of ["Team/plan", "team/Plan", "TEAM/PLAN", "Team/Café", "team/CAFÉ"]) {
    const r = await post("/notes", { content: "shadow", tags: ["team"], path }, mem);
    assert.equal(r.status, 409, JSON.stringify(path));
    assert.equal((await json(r)).error, "path_conflict");
  }
  assert.equal(fv.notes.size, 3, "no shadow note was created");
  // The path PATCH too.
  grantUser("org@test.local", "tag", "team", "own");
  fv.put({ id: "mine", path: "Team/Mine", content: "m", tags: ["team"] });
  // (Wave 2D, review C1: a non-owner path change is a MOVE — the bare PATCH answers
  // `move_required`; the pages move route applies the same held-path rule.)
  const refused = await patch("mine", { path: "team/plan", if_updated_at: stamp("mine") }, as("org@test.local"));
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).error, "move_required");
  assert.equal((await post("/notes/mine/move", { newPath: "team/plan", if_updated_at: stamp("mine") }, as("org@test.local"))).status, 409);
  // …but renaming a note to a different CASE of its own path is not a conflict with itself.
  assert.equal((await post("/notes/mine/move", { newPath: "Team/MINE", if_updated_at: stamp("mine") }, as("org@test.local"))).status, 200);
});

test("M1: the parent-page rule is not bypassed by case", async () => {
  const mem = seed();
  fv.put({ id: "locked", path: "Locked", content: "viewable, not creatable", tags: ["ro"] });
  fv.put({ id: "hers", path: "Hers", content: "invisible", tags: ["hers"] });
  grantUser(MEM, "tag", "ro", "view");
  for (const path of ["Locked/Child", "locked/Child2", "LOCKED/Child3"]) assert.equal((await post("/notes", { content: "x", tags: ["team"], path }, mem)).status, 403, path);
  for (const path of ["Hers/Child", "hers/Child2"]) assert.equal((await post("/notes", { content: "x", tags: ["team"], path }, mem)).status, 404, path);
  assert.equal((await post("/notes", { content: "x", tags: ["team"], path: "team/Child" }, mem)).status, 200, "a page they can add to, in any case");
  // Two pages whose paths differ only by case (possible in the vault): ambiguity is refused.
  fv.put({ id: "amb1", path: "Amb", content: "a", tags: ["team"] });
  fv.put({ id: "amb2", path: "amb", content: "b", tags: ["team"] });
  const r = await post("/notes", { content: "x", tags: ["team"], path: "Amb/Child" }, mem);
  assert.ok(r.status === 403 || r.status === 409, `ambiguous parent refused (${r.status})`);
});

// ── M2 ────────────────────────────────────────────────────────────────────────

test("M2: a trailing .md cannot land a note AT a protected or exported root", async () => {
  const mem = seed();
  createPublication({ id: "pubd", resource_type: "path", resource: "Published", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  for (const path of ["vault/agent.md", "vault/people.MD", "vault/messages.md", "Published.md", "Published.Md", "vault/agent/skills/evil.md"]) {
    const r = await post("/notes", { content: "x", tags: ["team"], path }, mem);
    assert.ok(r.status === 403 || r.status === 400, `${path} → ${r.status}`);
  }
  for (const p of ["vault/agent", "vault/people", "vault/messages", "Published"]) assert.ok(![...fv.notes.values()].some((n) => n.path?.toLowerCase() === p.toLowerCase()), p);
  grantUser("org@test.local", "tag", "team", "own");
  fv.put({ id: "mine", path: "Team/Mine", content: "m", tags: ["team"] });
  for (const path of ["vault/agent.md", "Published.md"]) {
    const r = await patch("mine", { path, if_updated_at: stamp("mine") }, as("org@test.local"));
    assert.ok(r.status === 403 || r.status === 400, `PATCH ${path} → ${r.status}`);
    const m = await post("/notes/mine/move", { newPath: path, if_updated_at: stamp("mine") }, as("org@test.local"));
    assert.ok(m.status === 403 || m.status === 400, `move ${path} → ${m.status}`);
  }
  assert.equal(fv.notes.get("mine")!.path, "Team/Mine");
  // An ordinary .md path is stored the way the vault stores it.
  const ok = await post("/notes", { content: "x", tags: ["team"], path: "Team/Readme.md" }, mem);
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).path, "Team/Readme");
});

// ── M3 ────────────────────────────────────────────────────────────────────────

test("M3: the editor-schema gate never answers for a note the caller cannot view", async () => {
  const mem = seed();
  fv.put({ id: "hid", path: "Secret/Doc", content: '<div data-type="callout">x</div>', tags: ["secret"] });
  fv.put({ id: "plainhid", path: "Secret/Plain", content: "<p>x</p>", tags: ["secret"] });
  const a = await patch("hid", { content: "<p>y</p>" }, mem);
  const b = await patch("plainhid", { content: "<p>y</p>" }, mem);
  const c = await patch("nope", { content: "<p>y</p>" }, mem);
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.equal(await a.text(), await c.text(), "markers of an unviewable note are not revealed");
  // The gate still protects a note the caller CAN edit.
  fv.put({ id: "vis", path: "Team/Doc", content: '<div data-type="callout">x</div>', tags: ["team"] });
  assert.equal((await patch("vis", { content: "<p>y</p>" }, mem)).status, 409);
});

// ── M4 ────────────────────────────────────────────────────────────────────────

test("M4: '+ New' row in a tag-based database — create in the row tag(s) is enough, view on the page suffices", async () => {
  seed();
  fv.put({ id: "db", path: "Boards/Tasks DB", content: "", tags: ["dbs"], metadata: { prism_type: "database", prism_database: { version: 1, source: { tags: ["row"] }, views: [] } } });
  fv.put({ id: "db2", path: "Boards/Two", content: "", tags: ["dbs"], metadata: { prism_type: "database", prism_database: { version: 1, source: { tags: ["row", "extra-src"] }, views: [] } } });
  grantUser("rower@test.local", "tag", "row", "edit");
  grantUser("rower@test.local", "tag", "dbs", "view");
  const rower = as("rower@test.local");
  assert.equal((await post("/notes", { content: "", tags: ["row"], path: "Boards/Tasks DB/Row 1", metadata: { title: "Row 1" } }, rower)).status, 200);
  assert.equal((await post("/notes", { content: "", tags: ["row", "plain-extra"], path: "Boards/Tasks DB/Row 2" }, rower)).status, 200, "an ungoverned extra tag");
  // Not the database's tags → the ordinary parent rule (view on the page is not enough).
  grantUser("rower@test.local", "tag", "misc", "edit");
  assert.equal((await post("/notes", { content: "", tags: ["misc"], path: "Boards/Tasks DB/Stray" }, rower)).status, 403);
  // Every source tag is needed, and create in every one of them.
  assert.equal((await post("/notes", { content: "", tags: ["row"], path: "Boards/Two/Row" }, rower)).status, 403, "missing a source tag");
  grantUser("someone@test.local", "tag", "extra-src", "view");
  assert.equal((await post("/notes", { content: "", tags: ["row", "extra-src"], path: "Boards/Two/Row" }, rower)).status, 403, "no create in the second source tag");
  // No create in the row tag at all.
  grantUser("viewer@test.local", "tag", "dbs", "view");
  grantUser("viewer@test.local", "tag", "row", "view");
  assert.equal((await post("/notes", { content: "", tags: ["row"], path: "Boards/Tasks DB/Nope" }, as("viewer@test.local"))).status, 403);
});

// ── L2 ────────────────────────────────────────────────────────────────────────

test("L2: a path PATCH applies the create's parent rule", async () => {
  seed();
  grantUser("org@test.local", "tag", "team", "own");
  grantUser("org@test.local", "tag", "ro", "view");
  const org = as("org@test.local");
  fv.put({ id: "mine", path: "Team/Mine", content: "m", tags: ["team"] });
  fv.put({ id: "locked", path: "Locked", content: "viewable, not creatable", tags: ["ro"] });
  fv.put({ id: "hers", path: "Hers", content: "invisible", tags: ["hers"] });
  // Wave 2D (review C1): the PATCH itself answers `move_required`; the destination's
  // parent rule is applied by the pages move route (where an unviewable parent reads
  // like "no page there", and the top level / plain folders are the owner's).
  for (const path of ["Locked/Mine", "Hers/Mine", "Team/Renamed", "PlainFolder/Renamed"]) {
    const r = await patch("mine", { path, if_updated_at: stamp("mine") }, org);
    assert.equal(r.status, 403, path);
    assert.equal((await json(r)).error, "move_required");
  }
  const mv = (newPath: string) => post("/notes/mine/move", { newPath, if_updated_at: stamp("mine") }, org);
  assert.equal((await mv("Locked/Mine")).status, 403);
  assert.equal((await mv("Hers/Mine")).status, 403);
  assert.equal(fv.notes.get("mine")!.path, "Team/Mine");
  assert.equal((await mv("Team/Renamed")).status, 200);
  assert.equal((await mv("PlainFolder/Renamed")).status, 403, "a plain folder is the owner's for a move");
});

// ── L3 ────────────────────────────────────────────────────────────────────────

const INGEST_KEYS = { source_id: "cu-1", calendarEventId: "ev-1", messageId: "<m@x>", threadId: "t-1", matrixRoomId: "!r:x", skillName: "evil", runner: "server", lastRun: "2020-01-01T00:00:00Z", executionMode: "agentic", merged_into: "someone", prism_merge_history: [{ id: "x" }] };

test("L3: ingest dedupe / skill / merge keys are dropped from a non-owner create and PATCH; ordinary properties are not", async () => {
  const mem = seed();
  const r = await post("/notes", { content: "x", tags: ["team"], metadata: { ...INGEST_KEYS, status: "todo", due: "2026-01-01", priority: "high", source: "web", title: "T" } }, mem);
  assert.equal(r.status, 200);
  const made = await json(r);
  for (const k of Object.keys(INGEST_KEYS)) assert.ok(!(k in made.metadata), `create: ${k}`);
  for (const [k, v] of Object.entries({ status: "todo", due: "2026-01-01", priority: "high", source: "web", title: "T" })) assert.equal(made.metadata[k], v, k);

  fv.put({ id: "task", path: "Team/Task", content: "t", tags: ["team"], metadata: { source_id: "real", calendarEventId: "real-ev", status: "todo" } });
  const p = await patch("task", { metadata: { ...INGEST_KEYS, status: "done", source_id: "forged" }, if_updated_at: stamp("task") }, mem);
  assert.equal(p.status, 200);
  const after = fv.notes.get("task")!.metadata!;
  assert.equal(after.status, "done", "the legitimate property edit lands");
  assert.equal(after.source_id, "real");
  assert.equal(after.calendarEventId, "real-ev");
  for (const k of Object.keys(INGEST_KEYS).filter((k) => !["source_id", "calendarEventId"].includes(k))) assert.ok(!(k in after), `PATCH: ${k}`);
  // Restating the current value (an autosave carrying the whole metadata) is fine.
  assert.equal((await patch("task", { metadata: { source_id: "real", status: "doing" }, if_updated_at: stamp("task") }, mem)).status, 200);
  assert.equal(fv.notes.get("task")!.metadata!.status, "doing");
  // A non-owner cannot DELETE a dedupe key either (null in a merge patch).
  assert.equal((await patch("task", { metadata: { source_id: null }, if_updated_at: stamp("task") }, mem)).status, 200);
  assert.equal(fv.notes.get("task")!.metadata!.source_id, "real");
});
