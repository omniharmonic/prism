/**
 * "Me" as a person filter value in a saved view: the view stores the token `@me`
 * (never an address) and `/api/query` resolves it for whoever is asking — with
 * the identity rules of "assigned to me" (`src/my-tasks.ts`).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests } from "../src/routes/databases";
import { saveOwnerSettings } from "../src/people-owner";
import { setUserProfile } from "../src/db";
import { valueNamesMe, type MyIdentity } from "../src/my-tasks";
import { writerIdFor } from "../src/writer-stamp";
import { evaluateCondition, ME_TOKEN, runQuery, validateQuerySpec, type QueryInput } from "@prism/core/database";
import { readDatabaseConfig } from "../../../packages/core/src/components/database/config";
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
  const tags = [{ name: "story", count: 5, description: null, fields: { status: { type: "string" }, lead: { type: "string" }, reviewers: { type: "array" } } }];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") return Response.json(tags);
    return innerFetch(input, init);
  }) as typeof fetch;
  fv.put({ id: "p-owner", path: "vault/people/Benjamin Life", tags: ["person"], metadata: { name: "Benjamin Life", email: "ben@elsewhere.test" } });
  fv.put({ id: "p-mira", path: "vault/people/Mira Park", tags: ["person"], metadata: { name: "Mira Park", emails: [MIRA] } });
  fv.put({ id: "s1", path: "Stories/One", tags: ["story"], metadata: { title: "One", lead: "[[vault/people/Mira Park]]", reviewers: ["Benjamin Life"], prism_creator: OWNER, prism_last_writer: writerIdFor(MIRA) } });
  fv.put({ id: "s2", path: "Stories/Two", tags: ["story"], metadata: { title: "Two", lead: "Benjamin Life", reviewers: ["[[vault/people/Mira Park]]", "Sam"], prism_creator: MIRA, prism_last_writer: writerIdFor(OWNER) } });
  fv.put({ id: "s3", path: "Stories/Three", tags: ["story"], metadata: { title: "Three", lead: MIRA, prism_creator: SAM } });
  fv.put({ id: "s4", path: "Stories/Four", tags: ["story"], metadata: { title: "Four", lead: "Sam", prism_creator: MIRA } });
  // Mira's, but private to someone else: never hers to see, so never in her "Me" view.
  fv.put({ id: "s5", path: "Stories/Five", tags: ["story"], metadata: { title: "Five", lead: "Mira Park", prism_creator: "x@test.local", prism_visibility: "private" } });
  saveOwnerSettings("primary", { person: "p-owner", emails: [], aliases: [] });
});
afterEach(() => fv.restore());

const login = (email: string) => sessionCookie(makeSession(email));
const query = (body: unknown, cookie?: string, headers: Record<string, string> = {}) => {
  const h = new Headers({ ...J, ...headers });
  if (cookie) h.set("cookie", cookie);
  return api.request("/query", { method: "POST", headers: h, body: JSON.stringify(body) });
};
const ids = async (filter: unknown, cookie?: string, headers?: Record<string, string>) =>
  ((await (await query({ tags: ["story"], filter, fields: ["lead"] }, cookie, headers)).json()) as any).rows.map((r: any) => r.id).sort();
const is = (key: string, op = "eq") => ({ match: "all", conditions: [{ key, op, value: ME_TOKEN }] });

test("engine: `@me` needs someone to resolve it; without one no row is mine", () => {
  const n: QueryInput = { id: "a", path: "x", tags: ["story"], createdAt: "2026-01-01T00:00:00Z", updatedAt: null, metadata: { lead: "@me" } };
  assert.equal(evaluateCondition(n, { key: "lead", op: "eq", value: ME_TOKEN }), false, "the token is never compared as text");
  assert.equal(evaluateCondition(n, { key: "lead", op: "ne", value: ME_TOKEN }), true);
  assert.equal(evaluateCondition(n, { key: "lead", op: "contains", value: ME_TOKEN }, new Date(), 0, () => true), true);
  assert.equal(evaluateCondition(n, { key: "lead", op: "not_contains", value: ME_TOKEN }, new Date(), 0, () => true), false);
  const page = runQuery([n], { tags: ["story"], filter: { match: "all", conditions: [{ key: "lead", op: "eq", value: ME_TOKEN }] }, aggregates: [{ key: "lead", fn: "count_all" }] }, { limited: false, me: (row, key) => row.id === "a" && key === "lead" });
  assert.equal(page.total, 1);
  assert.equal(page.aggregates!.lead!.count_all, 1, "calculations follow the resolved filter");
  assert.ok(validateQuerySpec({ tags: ["story"], filter: { match: "all", conditions: [{ key: "lead", op: "eq", value: ME_TOKEN }] } }).ok);
  // A saved view holds the token, nothing about a person.
  const cfg = readDatabaseConfig({ prism_database: { version: 1, source: { tags: ["story"] }, views: [{ id: "t", name: "Mine", type: "table", filter: { match: "all", conditions: [{ key: "lead", op: "eq", value: ME_TOKEN }] } }] } });
  assert.equal(JSON.stringify(cfg).includes("@test.local"), false);
});

test("valueNamesMe: an address, a link to my person page, or its name — never a look-alike", () => {
  const me: MyIdentity = { emails: new Set([MIRA]), names: new Set(["mira park"]), refs: new Set(["p-mira", "vault/people/mira park", "mira park"]), person: true, ownerUnset: false };
  for (const v of [MIRA, "Mira Park", "[[vault/people/Mira Park]]", "[[vault/people/Mira Park|Mira]]", ["Sam", "mira park"], "Sam, Mira Park", "Sam & [[vault/people/Mira Park]]"]) assert.equal(valueNamesMe(v, me), true, JSON.stringify(v));
  // A long people list is read whole (the assignee reader, not a 20-name cut).
  assert.equal(valueNamesMe([...Array.from({ length: 30 }, (_, i) => `Person ${i}`), "Mira Park"], me), true);
  for (const v of ["Mira", "Mira Parker", "mira@other.test", "[[vault/people/Mira P]]", ["Sam"], "", null, undefined, 7, { name: "Mira Park" }, "x".repeat(5000)]) assert.equal(valueNamesMe(v, me), false, JSON.stringify(v)?.slice(0, 40));
});

test("query: `is Me` on a person property is resolved per caller", async () => {
  grantUser(MIRA, "tag", "story", "view");
  grantUser(SAM, "tag", "story", "view");
  assert.deepEqual(await ids(is("lead"), login(MIRA)), ["s1", "s3"], "her person page, or her address — and not the private page she cannot see");
  assert.deepEqual(await ids(is("lead"), login(OWNER)), ["s2"], "the owner is the configured owner person");
  assert.deepEqual(await ids(is("lead"), login(SAM)), [], "Sam has no person page: a bare name is never an account");
  assert.deepEqual(await ids(is("reviewers", "contains"), login(MIRA)), ["s2"], "a multi-person property");
  assert.deepEqual(await ids(is("reviewers", "contains"), login(OWNER)), ["s1"]);
  assert.deepEqual(await ids(is("lead", "ne"), login(MIRA)), ["s2", "s4"], "`is not Me` is the rest of what she can see");
  // Combined with an ordinary condition, and inside a group.
  assert.deepEqual(await ids({ match: "any", conditions: [{ key: "$title", op: "eq", value: "Four" }], groups: [{ match: "all", conditions: [{ key: "lead", op: "eq", value: ME_TOKEN }] }] }, login(MIRA)), ["s1", "s3", "s4"]);
});

test("query: `is Me` on created by / last edited by compares the account, whatever the row shows", async () => {
  grantUser(MIRA, "tag", "story", "view");
  setUserProfile(MIRA, { name: "Mira Park" });
  assert.deepEqual(await ids(is("prism_creator"), login(MIRA)), ["s2", "s4"]);
  assert.deepEqual(await ids(is("prism_creator"), login(OWNER)), ["s1"]);
  assert.deepEqual(await ids(is("prism_last_writer"), login(MIRA)), ["s1"]);
  assert.deepEqual(await ids(is("prism_last_writer"), login(OWNER)), ["s2"]);
  // The answer names nobody: a member's rows carry no address for it.
  const res = (await (await query({ tags: ["story"], filter: is("prism_creator"), fields: ["lead", "prism_creator"] }, login(MIRA))).json()) as any;
  assert.deepEqual(res.rows.map((r: any) => r.id).sort(), ["s2", "s4"]);
  assert.ok(res.rows.every((r: any) => !String(r.metadata.prism_creator ?? "").includes("@")), "no address in a member's rows");
});

test("query: a share link is nobody — `is Me` matches nothing and leaks nothing", async () => {
  const cap = makeCapability("tag", "story", "view");
  const via = { authorization: `Capability ${cap}` };
  assert.deepEqual(await ids(is("lead"), undefined, via), []);
  assert.deepEqual(await ids(is("prism_creator"), undefined, via), []);
  assert.deepEqual(await ids(is("lead", "ne"), undefined, via), ["s1", "s2", "s3", "s4"]);
  assert.equal((await query({ tags: ["story"], filter: is("lead") })).status, 401);
});

test("query: `last edited by Me` never returns a row whose \"Last edited by\" shows nobody", async () => {
  grantUser(MIRA, "tag", "story", "view");
  setUserProfile(MIRA, { name: "Mira Park" });
  // Stamped by Mira, then written again much later by something that leaves no stamp
  // (ingest, a collab store): the row's "Last edited by" is empty for everyone.
  fv.put({ id: "s6", path: "Stories/Six", tags: ["story"], metadata: { title: "Six", prism_last_writer: writerIdFor(MIRA), prism_last_write_at: "2026-09-01T00:00:00.000Z" }, updatedAt: "2026-09-02T00:00:00.000Z" });
  // Stamped by Mira and still current.
  fv.put({ id: "s7", path: "Stories/Seven", tags: ["story"], metadata: { title: "Seven", prism_last_writer: writerIdFor(MIRA), prism_last_write_at: "2026-09-02T00:00:00.000Z" }, updatedAt: "2026-09-02T00:00:01.000Z" });
  resetDatabaseCachesForTests();
  const res = (await (await query({ tags: ["story"], filter: is("prism_last_writer"), fields: ["prism_last_writer"] }, login(MIRA))).json()) as any;
  assert.deepEqual(res.rows.map((r: any) => r.id).sort(), ["s1", "s7"]);
  assert.ok(res.rows.every((r: any) => r.metadata.prism_last_writer === "Mira Park"), "every returned row shows her as the last editor");
});
