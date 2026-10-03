/**
 * Wave 3 gaps #9 — Home "My tasks": `/api/query {assignedToMe: true}`.
 * The server resolves who the caller is (owner setting for the server owner; the
 * person note carrying the account's email for everyone else) and only ever
 * narrows rows the caller may already view.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests } from "../src/routes/databases";
import { saveOwnerSettings } from "../src/people-owner";
import { assignedToMe } from "../src/my-tasks";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const MIRA = "mira@test.local";
const SAM = "sam@test.local";
const J = { "content-type": "application/json" };
let fv: FakeVault;
let innerFetch: typeof fetch;
beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  innerFetch = globalThis.fetch;
  const tags = [{ name: "task", count: 6, description: null, fields: { status: { type: "string" }, assigned: { type: "string" }, due: { type: "string" } } }];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") return Response.json(tags);
    return innerFetch(input, init);
  }) as typeof fetch;
  fv.put({ id: "p-owner", path: "vault/people/Benjamin Life", tags: ["person"], metadata: { name: "Benjamin Life", email: "ben@elsewhere.test" } });
  fv.put({ id: "p-mira", path: "vault/people/Mira Park", tags: ["person"], metadata: { name: "Mira Park", emails: [MIRA, "mira@old.test"] } });
  fv.put({ id: "p-stub", path: "vault/people/Mira P", tags: ["person", "merged-stub"], metadata: { name: "Mira P", email: MIRA, merged_into: "p-mira" } });
  fv.put({ id: "t1", path: "vault/tasks/Write notes", tags: ["task", "team"], metadata: { status: "todo", assigned: "Benjamin" } });
  fv.put({ id: "t2", path: "vault/tasks/Review plan", tags: ["task", "team"], metadata: { status: "todo", assigned: "Mira Park, Benjamin" } });
  fv.put({ id: "t3", path: "vault/tasks/Book room", tags: ["task", "team"], metadata: { status: "todo", assigned: "[[vault/people/Mira Park]]" } });
  fv.put({ id: "t4", path: "vault/tasks/Call venue", tags: ["task", "team"], metadata: { status: "todo", assignee_email: MIRA } });
  fv.put({ id: "t5", path: "vault/tasks/Private errand", tags: ["task", "hidden"], metadata: { status: "todo", assigned: "Mira Park" } });
  fv.put({ id: "t6", path: "vault/tasks/Someone else", tags: ["task", "team"], metadata: { status: "todo", assigned: "Sam" } });
  fv.put({ id: "t7", path: "vault/tasks/Unassigned", tags: ["task", "team"], metadata: { status: "todo" } });
  fv.put({ id: "t8", path: "vault/tasks/Old", tags: ["task", "team", "prism-trashed"], metadata: { status: "todo", assigned: "Mira Park" } });
});
afterEach(() => { globalThis.fetch = innerFetch; fv.restore(); });

const login = (email: string) => sessionCookie(makeSession(email));
const query = (cookie: string | null, body: Record<string, unknown>, path = "/query") =>
  api.request(path, { method: "POST", headers: { ...J, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids = async (r: Response) => { assert.equal(r.status, 200, await r.clone().text()); const b = (await r.json()) as any; return { ids: b.rows.map((x: { id: string }) => x.id).sort(), identity: b.identity, total: b.total }; };

test("a member sees the tasks assigned to their person note — by name, wikilink or address — and only ones they can view", async () => {
  grantUser(MIRA, "tag", "team", "view");
  const mine = await ids(await query(login(MIRA), { tags: ["task"], assignedToMe: true }));
  assert.deepEqual(mine.ids, ["t2", "t3", "t4"]);
  assert.equal(mine.identity, "person");
  assert.equal(mine.total, 3, "the hidden task (t5) is neither listed nor counted");
  // Without the flag: every viewable task, as before.
  assert.deepEqual((await ids(await query(login(MIRA), { tags: ["task"] }))).ids, ["t1", "t2", "t3", "t4", "t6", "t7"]);
  // Filters still apply on top.
  const filtered = await ids(await query(login(MIRA), { tags: ["task"], assignedToMe: true, search: "venue" }));
  assert.deepEqual(filtered.ids, ["t4"]);
});

test("a member with no person note matches by address only; a display name is never used", async () => {
  grantUser(SAM, "tag", "team", "view");
  const mine = await ids(await query(login(SAM), { tags: ["task"], assignedToMe: true }));
  assert.deepEqual(mine.ids, [], "“Sam” on a task is a name, and no person note says this account is that Sam");
  assert.equal(mine.identity, "account");
  fv.put({ id: "t9", path: "vault/tasks/By address", tags: ["task", "team"], metadata: { status: "todo", assigned: SAM } });
  resetDatabaseCachesForTests();
  assert.deepEqual((await ids(await query(login(SAM), { tags: ["task"], assignedToMe: true }))).ids, ["t9"]);
});

test("the server owner is the identity layer's owner setting: person note, aliases and extra addresses", async () => {
  // Nothing configured: only the sign-in address could match.
  assert.deepEqual((await ids(await query(login(OWNER), { tags: ["task"], assignedToMe: true }))).ids, []);
  saveOwnerSettings("primary", { person: "p-owner", emails: [], aliases: ["Benjamin"] });
  resetDatabaseCachesForTests();
  const mine = await ids(await query(login(OWNER), { tags: ["task"], assignedToMe: true }));
  assert.deepEqual(mine.ids, ["t1", "t2"]);
  assert.equal(mine.identity, "person");
  // The owner setting may name the person by path too.
  saveOwnerSettings("primary", { person: "vault/people/Benjamin Life", emails: [], aliases: [] });
  resetDatabaseCachesForTests();
  fv.put({ id: "t10", path: "vault/tasks/Full name", tags: ["task"], metadata: { status: "todo", assigned: "Benjamin Life" } });
  assert.deepEqual((await ids(await query(login(OWNER), { tags: ["task"], assignedToMe: true }))).ids, ["t10"]);
});

test("a capability link has no account: no tasks; a bad value is a 400", async () => {
  const link = makeCapability("tag", "team", "view");
  const viaLink = await ids(await query(null, { tags: ["task"], assignedToMe: true }, `/query?t=${encodeURIComponent(link)}`));
  assert.deepEqual(viaLink.ids, []);
  assert.equal((await query(login(OWNER), { tags: ["task"], assignedToMe: "yes" })).status, 400);
});

test("assignedToMe: tombstones never stand for a person; long or odd values are handled linearly", () => {
  const me = { emails: new Set(["a@x.test"]), names: new Set(["ada lovelace"]), refs: new Set(["p1", "vault/people/ada lovelace", "ada lovelace"]), person: true };
  assert.equal(assignedToMe({ assigned: "Bob and Ada Lovelace" }, me), true);
  assert.equal(assignedToMe({ assigned: "[[Ada Lovelace|Ada]]" }, me), true);
  assert.equal(assignedToMe({ assignee: ["x@y.test", "A@X.test"] }, me), true);
  assert.equal(assignedToMe({ assigned: "Ada" }, me), false, "a first name alone is not the person");
  assert.equal(assignedToMe({ assigned: "[[Ada Lovelace" }, me), false);
  const started = Date.now();
  assert.equal(assignedToMe({ assigned: "[[".repeat(900) + " and ".repeat(50) }, me), false);
  assert.ok(Date.now() - started < 200);
});
