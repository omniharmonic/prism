/**
 * NP-CO-16 — "assigned you to <page>" notifications, and the per-page
 * notification level (NP-CO-04). Real routes over the fake vault; push delivery
 * observed through `setDeliveryHook`.
 *
 * Every write path is covered, including the ones that must NOT notify: creates
 * (templates, duplicates), the CSV import, and anything that writes the vault
 * directly (ingest).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import { api } from "../src/routes/api";
import { config } from "../src/config";
import { db, setAccount } from "../src/db";
import { resetTreeForTests } from "../src/tree";
import { issuePat } from "../src/auth/pat";
import { documentActorId } from "../src/human-collab";
import { saveOwnerSettings } from "../src/people-owner";
import { resetDatabaseCachesForTests } from "../src/routes/databases";
import { vaultClient } from "../src/parachute";
import {
  _resetNotifications,
  commentsStored,
  primeComments,
  runEmailDigestOnce,
  setDeliveryHook,
  setDigestSender,
  clearNoteInfoCache,
} from "../src/notifications";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

process.env.NOTIFY_READS_PER_MINUTE = "100000";
const OWNER = config.ownerEmail; // owner@test.local
const ADA = "ada@test.local";
const BOB = "bob@test.local";
const EVE = "eve@test.local";
let fv: FakeVault;
let delivered: Array<{ id: string; recipient: string; type: string }>;

beforeEach(() => {
  resetDb();
  _resetNotifications();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  saveOwnerSettings("primary", null);
  fv = installFakeVault();
  delivered = [];
  setDeliveryHook((n) => delivered.push(n));
  for (const [e, n] of [[ADA, "Ada Lovelace"], [BOB, "Bob"], [EVE, "Eve"]] as const) setAccount(e, n, "scrypt$fixture");
  fv.put({ id: "p-ada", path: "vault/people/Ada Lovelace", tags: ["person"], metadata: { name: "Ada Lovelace", email: ADA } });
  fv.put({ id: "p-eve", path: "vault/people/Eve", tags: ["person"], metadata: { name: "Eve", emails: [EVE] } });
  fv.put({ id: "task", path: "vault/Projects/Ship it", tags: ["team", "task"], metadata: { status: "todo" }, content: "<p>do</p>" });
  fv.put({ id: "task2", path: "vault/Projects/Second", tags: ["team", "task"], metadata: { status: "todo" }, content: "" });
  fv.put({ id: "secret", path: "vault/Private/Secret", tags: ["hidden"], content: "<p>s</p>" });
  grantUser(ADA, "tag", "team", "edit");
  grantUser(BOB, "tag", "team", "edit");
});
afterEach(() => {
  setDeliveryHook(null);
  setDigestSender(null);
  fv.restore();
});

const revoke = (email: string) => db.prepare("DELETE FROM grants WHERE subject = ?").run(email);
const as = (email: string) => ({ cookie: sessionCookie(makeSession(email)) });
const J = { "content-type": "application/json" };
const req = (path: string, email: string | null, init: RequestInit = {}) =>
  api.request(path, { ...init, headers: { ...(email ? as(email) : {}), ...J, ...(init.headers as Record<string, string> | undefined) } });
const post = (path: string, email: string | null, body: unknown, headers: Record<string, string> = {}) => req(path, email, { method: "POST", body: JSON.stringify(body), headers });
async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}
type Item = { id: string; type: string; title: string | null; actor: { name: string } | null; anchor: Record<string, unknown> | null; noteId: string };
const inbox = async (email: string, q = "") => (await (await req(`/notifications${q}`, email)).json()) as { items: Item[]; unread: number };
const assigned = async (email: string) => (await inbox(email)).items.filter((i) => i.type === "assigned");
/** Let fire-and-forget producers finish, then read: for "nothing was sent" assertions. */
const settled = async (email: string) => {
  await new Promise((r) => setTimeout(r, 150));
  return assigned(email);
};
const setProp = (email: string | null, id: string, set: Record<string, unknown>, headers: Record<string, string> = {}) => post(`/properties/${id}`, email, { set }, headers);

// ── the property route ───────────────────────────────────────────────────────

test("POST /properties/:id: someone else adding you to `assigned` puts 'assigned you' in your inbox and pushes; never the author; never an email", async () => {
  const res = await setProp(BOB, "task", { assigned: "Ada Lovelace" });
  assert.equal(res.status, 200);
  const items = await until(() => assigned(ADA), (v) => v.length === 1);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "Ship it");
  assert.equal(items[0]!.noteId, "task");
  assert.deepEqual(items[0]!.actor, { name: "Bob" });
  assert.deepEqual(items[0]!.anchor, { property: "assigned" }, "the deep link names the property");
  assert.ok(!JSON.stringify(items).includes("@test.local"), "no address reaches the reader");
  assert.equal((await inbox(ADA)).unread, 1, "the unread badge counts it");
  await until(() => delivered.length, (n) => n === 1);
  assert.deepEqual(delivered.map((d) => [d.recipient, d.type]), [[ADA, "assigned"]]);
  assert.equal((await assigned(BOB)).length, 0);
  // Assigning yourself notifies nobody.
  assert.equal((await setProp(ADA, "task2", { assigned: "Ada Lovelace" })).status, 200);
  assert.equal((await settled(ADA)).length, 1);
});

test("identity: an address, a wikilink (path, id, name) and a person note's name all resolve; an account display name and an ambiguous name do not", async () => {
  let n = 0;
  const fresh = () => {
    const id = `t${++n}`;
    fv.put({ id, path: `vault/Projects/T${n}`, tags: ["team", "task"], metadata: {}, content: "" });
    resetTreeForTests();
    clearNoteInfoCache();
    return id;
  };
  for (const value of [ADA, "ADA@test.local", "[[vault/people/Ada Lovelace]]", "[[p-ada]]", "[[Ada Lovelace]]", "ada lovelace", "Someone Else, Ada Lovelace"]) {
    const id = fresh();
    assert.equal((await setProp(BOB, id, { assigned: value })).status, 200);
    const got = await until(() => assigned(ADA), (v) => v.some((i) => i.noteId === id));
    assert.ok(got.some((i) => i.noteId === id), `${value} names Ada`);
  }
  const before = (await assigned(ADA)).length;
  // Bob's ACCOUNT is named "Bob" but he has no person note: a display name is not an identity.
  assert.equal((await setProp(ADA, fresh(), { assigned: "Bob" })).status, 200);
  assert.equal((await settled(BOB)).length, 0);
  // Two people called Sam: a name that could be either notifies neither.
  setAccount("sam1@test.local", "Sam", "scrypt$fixture");
  setAccount("sam2@test.local", "Sam", "scrypt$fixture");
  grantUser("sam1@test.local", "tag", "team", "view");
  grantUser("sam2@test.local", "tag", "team", "view");
  fv.put({ id: "p-sam1", path: "vault/people/Sam", tags: ["person"], metadata: { name: "Sam", email: "sam1@test.local" } });
  fv.put({ id: "p-sam2", path: "vault/people/team/Sam", tags: ["person"], metadata: { name: "Sam", email: "sam2@test.local" } });
  resetDatabaseCachesForTests();
  assert.equal((await setProp(BOB, fresh(), { assigned: "Sam" })).status, 200);
  assert.equal((await settled("sam1@test.local")).length, 0);
  assert.equal((await assigned("sam2@test.local")).length, 0);
  // …but a wikilink to one of them is exact.
  const exact = fresh();
  assert.equal((await setProp(BOB, exact, { assigned: "[[vault/people/team/Sam]]" })).status, 200);
  assert.equal((await until(() => assigned("sam2@test.local"), (v) => v.length === 1)).length, 1);
  assert.equal((await assigned("sam1@test.local")).length, 0);
  assert.equal((await assigned(ADA)).length, before);
});

test("the server owner is reached through the configured owner identity (person note, extra address, alias)", async () => {
  fv.put({ id: "p-owner", path: "vault/people/Robin Vale", tags: ["person"], metadata: { name: "Robin Vale", email: "robin@elsewhere.test" } });
  saveOwnerSettings("primary", { person: "vault/people/Robin Vale", emails: ["robin@elsewhere.test"], aliases: ["Robin"] });
  let n = 0;
  for (const value of ["[[vault/people/Robin Vale]]", "robin@elsewhere.test", "Robin", "Robin Vale"]) {
    const id = `o${++n}`;
    fv.put({ id, path: `vault/Projects/O${n}`, tags: ["team", "task"], metadata: {}, content: "" });
    resetTreeForTests();
    assert.equal((await setProp(BOB, id, { assigned: value })).status, 200);
    const got = await until(() => assigned(OWNER), (v) => v.some((i) => i.noteId === id));
    assert.ok(got.some((i) => i.noteId === id), `${value} names the owner`);
  }
});

test("only ADDED people: restating the value, rewriting a name as a wikilink and removing notify nobody", async () => {
  await setProp(BOB, "task", { assigned: "Ada Lovelace" });
  assert.equal((await until(() => assigned(ADA), (v) => v.length === 1)).length, 1);
  db.prepare("UPDATE notifications SET created_at = created_at - 7200000").run(); // rule out the hour look-back
  for (const value of ["Ada Lovelace", "[[vault/people/Ada Lovelace]]", `${ADA}, Someone`, ""]) {
    assert.equal((await setProp(BOB, "task", { assigned: value })).status, 200);
  }
  assert.equal((await settled(ADA)).length, 1);
});

test("view is required at creation and re-checked at read time", async () => {
  // Eve cannot view the page: nothing is created for her.
  assert.equal((await setProp(BOB, "task", { assigned: "Eve, Ada Lovelace" })).status, 200);
  assert.equal((await until(() => assigned(ADA), (v) => v.length === 1)).length, 1);
  assert.equal((await assigned(EVE)).length, 0);
  assert.deepEqual(delivered.map((d) => d.recipient), [ADA]);
  // Ada loses access: her item disappears (and so does its title).
  revoke(ADA);
  clearNoteInfoCache();
  const after = await inbox(ADA);
  assert.equal(after.items.length, 0);
  assert.equal(after.unread, 0);
});

test("removed and re-added within the hour: one item; after the hour: a new one", async () => {
  await setProp(BOB, "task", { assigned: "Ada Lovelace" });
  assert.equal((await until(() => assigned(ADA), (v) => v.length === 1)).length, 1);
  await setProp(BOB, "task", { assigned: "" });
  await setProp(BOB, "task", { assigned: "Ada Lovelace" });
  assert.equal((await settled(ADA)).length, 1, "the hourly look-back holds");
  // …also across an hour boundary of the clock (not a fixed bucket): 50 minutes ago is still "within the hour".
  db.prepare("UPDATE notifications SET created_at = created_at - 3000000").run();
  await setProp(BOB, "task", { assigned: "" });
  await setProp(BOB, "task", { assigned: "Ada Lovelace" });
  assert.equal((await settled(ADA)).length, 1);
  // More than an hour later it is news again.
  db.prepare("UPDATE notifications SET created_at = created_at - 3600000, dedupe_key = dedupe_key || ':old'").run();
  await setProp(BOB, "task", { assigned: "" });
  await setProp(BOB, "task", { assigned: "Ada Lovelace" });
  assert.equal((await until(() => assigned(ADA), (v) => v.length === 2)).length, 2);
});

test("POST /properties/batch notifies per page, within the per-sender budget shared with mentions (20/h)", async () => {
  const items = [];
  for (let i = 0; i < 25; i++) {
    fv.put({ id: `b${i}`, path: `vault/Projects/B${i}`, tags: ["team", "task"], metadata: {}, content: "" });
    items.push({ id: `b${i}`, set: { assigned: ADA } });
  }
  resetTreeForTests();
  const res = await post("/properties/batch", BOB, { items });
  assert.equal(res.status, 200);
  const got = await until(() => assigned(ADA), (v) => v.length >= 20, 4000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await assigned(ADA)).length, 20, "25 assignments from one sender in an hour: 20 items");
  assert.ok(got.every((i) => i.actor?.name === "Bob"));
});

test("which properties count: person-kind fields by schema, hint or name; never a plain text field", async () => {
  (fv.tags as unknown as Array<Record<string, unknown>>).push({ name: "team", count: 2, fields: { reviewer: { type: "string" }, summary: { type: "string" }, champion: { type: "string" } } });
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("schema-ui:primary:team", JSON.stringify({ champion: { kind: "person" } }));
  resetDatabaseCachesForTests();
  // A text field that happens to hold a name is not an assignment.
  assert.equal((await setProp(BOB, "task", { summary: "Ada Lovelace" })).status, 200);
  assert.equal((await settled(ADA)).length, 0);
  // `reviewer` reads as a person by its name; `champion` by the owner's presentation hint.
  assert.equal((await setProp(BOB, "task", { reviewer: "Ada Lovelace" })).status, 200);
  const one = await until(() => assigned(ADA), (v) => v.length === 1);
  assert.deepEqual(one[0]!.anchor, { property: "reviewer" });
  db.prepare("UPDATE notifications SET created_at = created_at - 7200000").run();
  assert.equal((await setProp(BOB, "task2", { champion: "[[p-ada]]" })).status, 200);
  const two = await until(() => assigned(ADA), (v) => v.length === 2);
  assert.ok(two.some((i) => i.noteId === "task2" && i.anchor?.property === "champion"));
  // Added to two properties in one write: one item.
  fv.put({ id: "task3", path: "vault/Projects/Third", tags: ["team", "task"], metadata: {}, content: "" });
  resetTreeForTests();
  assert.equal((await setProp(BOB, "task3", { reviewer: ADA, assigned: ADA })).status, 200);
  await until(() => assigned(ADA), (v) => v.length === 3);
  assert.equal((await settled(ADA)).filter((i) => i.noteId === "task3").length, 1);
});

// ── the gateway PATCH ────────────────────────────────────────────────────────

test("a metadata PATCH notifies too: the owner passthrough and the member route; a content-only PATCH and a refused one do not", async () => {
  // Owner passthrough (the owner assigning a member).
  const res = await req("/notes/task", OWNER, { method: "PATCH", body: JSON.stringify({ metadata: { assigned: "Ada Lovelace" } }) });
  assert.equal(res.status, 200);
  assert.equal((fv.notes.get("task")!.metadata as Record<string, unknown>).assigned, "Ada Lovelace");
  const one = await until(() => assigned(ADA), (v) => v.length === 1);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0]!.anchor, { property: "assigned" });
  // Member route (Bob, edit via tag).
  const res2 = await req("/notes/task2", BOB, { method: "PATCH", body: JSON.stringify({ metadata: { assigned: ADA }, if_updated_at: fv.notes.get("task2")!.updatedAt }) });
  assert.equal(res2.status, 200);
  const two = await until(() => assigned(ADA), (v) => v.length === 2);
  assert.ok(two.some((i) => i.noteId === "task2" && i.actor?.name === "Bob"));
  // The stored note is read for the previous value ONLY when a person property is written.
  fv.put({ id: "task4", path: "vault/Projects/Fourth", tags: ["team", "task"], metadata: { assigned: "Ada Lovelace" }, content: "" });
  resetTreeForTests();
  const readsFor = async (body: unknown) => {
    const at = fv.calls.length;
    assert.equal((await req("/notes/task4", OWNER, { method: "PATCH", body: JSON.stringify(body), headers: { "x-prism-editor-schema": "99" } })).status, 200);
    return fv.calls.slice(at).filter((c) => c.method === "GET" && c.path.endsWith("/notes/task4")).length;
  };
  await readsFor({ metadata: { status: "warm-up" } }); // builds the tree projection
  const plain = await readsFor({ metadata: { status: "doing" } });
  const body = await readsFor({ content: "<p>x</p>" });
  const person = await readsFor({ metadata: { assigned: "Ada Lovelace, Someone" } });
  assert.equal(person - plain, 1, "one pre-read for a person property");
  assert.ok(body <= plain + 1, "a body save is not pre-read by this hook");
  // Eve cannot edit: her PATCH is refused and assigns nobody.
  grantUser(EVE, "tag", "team", "view");
  fv.put({ id: "task5", path: "vault/Projects/Fifth", tags: ["team", "task"], metadata: {}, content: "" });
  resetTreeForTests();
  const refused = await req("/notes/task5", EVE, { method: "PATCH", body: JSON.stringify({ metadata: { assigned: ADA } }) });
  assert.ok(refused.status >= 400);
  assert.equal((await settled(ADA)).length, 2);
});

// ── an agent, and a share-link guest ─────────────────────────────────────────

test("a Prism MCP agent's write notifies as '<name> (agent)'; a share-link guest's as nobody ('Someone'), both within a budget", async () => {
  const app = createApp();
  const ip = "203.0.113.9";
  const headers: Record<string, string> = { "cf-connecting-ip": ip, "x-forwarded-for": ip, authorization: `Bearer ${issuePat({ email: BOB, vaultId: "primary", scope: "write" }).token}` };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const r = new Request(input, init);
    const h = new Headers(r.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const u = new URL(r.url);
    return app.request(u.pathname + u.search, { method: r.method, headers: h, body: r.method === "POST" ? await r.text() : undefined });
  };
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  const r = (await client.callTool({ name: "prism_update_note", arguments: { id: "task", if_updated_at: fv.notes.get("task")!.updatedAt, metadata: { assigned: "Ada Lovelace" } } })) as { isError?: boolean; content?: unknown };
  assert.ok(!r.isError, JSON.stringify(r.content));
  const got = await until(() => assigned(ADA), (v) => v.length === 1);
  assert.deepEqual(got[0]!.actor, { name: "Bob (agent)" });
  assert.deepEqual(got[0]!.anchor, { property: "assigned" }, "the server's own flag is not part of the anchor");
  await client.close();

  // A guest with an edit link: there is no account to name.
  const token = makeCapability("note", "task2", "edit");
  const res = await api.request("/properties/task2", { method: "POST", headers: { ...J, authorization: `Capability ${token}` }, body: JSON.stringify({ set: { assigned: ADA } }) });
  assert.equal(res.status, 200);
  const two = await until(() => assigned(ADA), (v) => v.length === 2);
  assert.equal(two.find((i) => i.noteId === "task2")!.actor, null);
});

// ── the paths that must NOT notify ───────────────────────────────────────────

test("creates never notify: a new page with an assignee (member route, owner passthrough) — the shape of a template copy or a duplicate", async () => {
  grantUser(BOB, "tag", "task", "edit");
  const member = await post("/notes", BOB, { content: "", path: "vault/Projects/Copy of Ship it", tags: ["team", "task"], metadata: { assigned: "Ada Lovelace" } });
  assert.ok(member.status === 200 || member.status === 201, `member create: ${member.status}`);
  const owner = await post("/notes", OWNER, { content: "", path: "vault/Projects/From template", tags: ["team", "task"], metadata: { assigned: ADA } });
  assert.ok(owner.status === 200 || owner.status === 201, `owner create: ${owner.status}`);
  assert.equal((await settled(ADA)).length, 0);
  assert.equal(delivered.length, 0);
});

test("the CSV import never notifies (bulk), whether it creates or updates", async () => {
  const csv = "Name,Assigned\nShip it,Ada Lovelace\nBrand new,ada@test.local\n";
  const body = { tag: "task", csv, mapping: { Name: "$title", Assigned: "assigned" }, pathPrefix: "vault/Projects", dryRun: false };
  fv.notes.get("task")!.metadata = { status: "todo", title: "Ship it" };
  const res = await post("/databases/import/csv", OWNER, body);
  assert.ok(res.status === 200 || res.status === 207, `import: ${res.status} ${await res.clone().text()}`);
  const out = (await res.json()) as { result: { created: number; updated: number } };
  assert.equal(out.result.created + out.result.updated, 2, "the import really wrote both rows");
  assert.equal((fv.notes.get("task")!.metadata as Record<string, unknown>).assigned, "Ada Lovelace");
  assert.equal((await settled(ADA)).length, 0);
  assert.equal(delivered.length, 0);
});

test("ingest never notifies: a direct vault write does nothing, and no ingester, importer or transfer module reaches the producer", async () => {
  // What ClickUp sync / calendar attendees do: write the vault with the server's own client.
  await vaultClient("primary").updateNote("task", { metadata: { assigned: "Ada Lovelace", attendees: [ADA] } });
  await vaultClient("primary").createNote({ content: "", path: "vault/tasks/clickup/x", tags: ["task", "clickup", "team"], metadata: { assigned: ADA, source: "clickup", source_id: "1" } });
  assert.equal((await settled(ADA)).length, 0);
  // And structurally: the only callers of the producer are the two gateway hooks.
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []));
  const callers = walk(src).filter((f) => /\b(assignmentsStored|notifyAssignments)\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(src.length + 1)).sort();
  assert.deepEqual(callers, ["notifications.ts", "routes/databases.ts", "routes/notifications.ts"]);
  for (const dir of ["worker", "transfer", "importers"]) {
    for (const f of walk(join(src, dir))) assert.ok(!/from "\.\.\/(routes\/databases|routes\/notifications)"/.test(readFileSync(f, "utf8")), `${f} must not import the gateway hooks`);
  }
});

test("a template's properties assign nobody", async () => {
  fv.put({ id: "tpl", path: "Templates/Task", tags: ["template"], metadata: {}, content: "" });
  grantUser(ADA, "tag", "template", "view");
  assert.equal((await req("/notes/tpl", OWNER, { method: "PATCH", body: JSON.stringify({ metadata: { assigned: ADA } }) })).status, 200);
  assert.equal((await settled(ADA)).length, 0);
});

// ── settings, filter ─────────────────────────────────────────────────────────

test("settings: `assignment` defaults to push + email for everyone, including people whose stored settings predate it", async () => {
  // A row written before the category existed.
  db.prepare("INSERT INTO notification_settings (email, json, updated_at) VALUES (?, ?, ?)").run(ADA, JSON.stringify({ mention: { push: false, email: false }, comment: { push: true, email: true }, reminder: { push: true, email: false }, access: { push: true, email: true } }), Date.now());
  const got = (await (await req("/notifications/settings", ADA)).json()) as { settings: Record<string, { push: boolean; email: boolean }> };
  assert.deepEqual(got.settings.assignment, { push: true, email: true });
  assert.deepEqual(got.settings.mention, { push: false, email: false }, "their other choices are untouched");
  // An older client's PUT (no `assignment` key) keeps the default.
  const { assignment: _a, ...old } = got.settings;
  const put = await req("/notifications/settings", ADA, { method: "PUT", body: JSON.stringify({ settings: old }) });
  assert.equal(put.status, 200);
  assert.deepEqual(((await put.json()) as typeof got).settings.assignment, { push: true, email: true });
  // Push off: the inbox item still arrives, no push; email off: the digest skips it.
  await req("/notifications/settings", ADA, { method: "PUT", body: JSON.stringify({ settings: { ...old, assignment: { push: false, email: false } } }) });
  await setProp(BOB, "task", { assigned: ADA });
  assert.equal((await until(() => assigned(ADA), (v) => v.length === 1)).length, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(delivered.length, 0);
  const mails: string[] = [];
  setDigestSender(async (to) => void mails.push(to));
  assert.equal(await runEmailDigestOnce(Date.now() + 3_600_000), 0);
  assert.deepEqual(mails, []);
  // Email on (the default, Bob assigned by Ada): one content-free digest.
  await setProp(ADA, "task2", { assigned: "bob@test.local" });
  await until(() => assigned(BOB), (v) => v.length === 1);
  assert.equal(await runEmailDigestOnce(Date.now() + 3_600_000), 1);
  assert.deepEqual(mails, [BOB]);
});

test("the inbox filters by type: `assigned` and the `assignment` group; archive moves an item out of the inbox", async () => {
  await setProp(BOB, "task", { assigned: ADA });
  const [item] = await until(() => assigned(ADA), (v) => v.length === 1);
  assert.equal((await inbox(ADA, "?type=assigned")).items.length, 1);
  assert.equal((await inbox(ADA, "?type=assignment")).items.length, 1);
  assert.equal((await inbox(ADA, "?type=mention")).items.length, 0);
  assert.equal((await post("/notifications/archive", ADA, { ids: [item!.id], archived: true })).status, 200);
  assert.equal((await inbox(ADA)).items.length, 0);
  assert.equal((await inbox(ADA, "?box=archived&type=assigned")).items.length, 1);
  assert.equal((await inbox(ADA)).unread, 0, "archiving reads it");
});

// ── per-page level ───────────────────────────────────────────────────────────

const level = async (email: string | null, id: string, init: RequestInit = {}) => req(`/notifications/pages/${id}`, email, init);
const putLevel = (email: string, id: string, l: unknown) => level(email, id, { method: "PUT", body: JSON.stringify({ level: l }) });

test("GET/PUT /notifications/pages/:id: default 'mentions'; own choice only; view required (404); strict input; signed-in people only", async () => {
  assert.deepEqual(await (await level(ADA, "task")).json(), { level: "mentions" });
  assert.deepEqual(await (await putLevel(ADA, "task", "none")).json(), { level: "none" });
  assert.deepEqual(await (await level(ADA, "task")).json(), { level: "none" });
  assert.deepEqual(await (await level(BOB, "task")).json(), { level: "mentions" }, "a level is per person");
  assert.deepEqual(await (await putLevel(ADA, "task", "all")).json(), { level: "all" });
  assert.deepEqual(await (await putLevel(ADA, "task", "mentions")).json(), { level: "mentions" });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notification_page_levels").get() as { n: number }).n, 0, "the default stores nothing");
  // A page the caller cannot view is indistinguishable from a missing one.
  for (const id of ["secret", "nope", "vault%2FProjects%2FShip%20it"]) {
    assert.equal((await level(ADA, id)).status, 404);
    assert.equal((await putLevel(ADA, id, "all")).status, 404);
  }
  for (const bad of ["loud", "", null, 3]) assert.equal((await putLevel(ADA, "task", bad)).status, 400);
  assert.equal((await level(ADA, "task", { method: "PUT", body: JSON.stringify({ level: "all", extra: 1 }) })).status, 400);
  // CSRF: a cross-site PUT is refused.
  assert.equal((await level(ADA, "task", { method: "PUT", body: JSON.stringify({ level: "all" }), headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  // No inbox for anonymous callers or share links.
  assert.equal((await level(null, "task")).status, 401);
  const token = makeCapability("note", "task", "edit");
  assert.equal((await api.request("/notifications/pages/task", { headers: { authorization: `Capability ${token}` } })).status, 401);
});

function thread(doc: Y.Doc, id: string, first: Record<string, unknown>, page = false) {
  const t = new Y.Map<unknown>();
  t.set("id", id);
  if (page) t.set("page", true);
  const arr = new Y.Array<Record<string, unknown>>();
  arr.push([first]);
  t.set("comments", arr);
  doc.getMap<Y.Map<unknown>>("comments").set(id, t);
  return arr;
}
const by = (email: string) => documentActorId(`user:${email}`);
const types = async (email: string) => (await inbox(email)).items.map((i) => i.type).sort();

test("level 'none' drops comment replies and page-comment replies for that page — a mention of you and an assignment still arrive", async () => {
  const doc = new Y.Doc();
  primeComments("lv-none", doc);
  const t1 = thread(doc, "t1", { id: "c1", actorId: by(ADA), author: "Ada", text: "First", createdAt: 1 });
  const pg = thread(doc, "pg", { id: "p1", actorId: by(ADA), author: "Ada", text: "Page note", createdAt: 2 }, true);
  await commentsStored("lv-none", "primary", "task", doc, [ADA]);
  assert.equal((await putLevel(ADA, "task", "none")).status, 200);
  t1.push([{ id: "c2", actorId: by(BOB), author: "Bob", text: "A reply", createdAt: 3 }]);
  pg.push([{ id: "p2", actorId: by(BOB), author: "Bob", text: "A page reply", createdAt: 4 }]);
  assert.equal(await commentsStored("lv-none", "primary", "task", doc, [BOB]), 0);
  assert.deepEqual(await types(ADA), []);
  // A mention of Ada in a comment still reaches her…
  grantUser(BOB, "tag", "person", "view");
  t1.push([{ id: "c3", actorId: by(BOB), author: "Bob", text: "@[Ada Lovelace](person:p-ada) please look", createdAt: 5 }]);
  assert.equal(await commentsStored("lv-none", "primary", "task", doc, [BOB]), 1);
  // …and so does an assignment.
  await setProp(BOB, "task", { assigned: ADA });
  await until(() => assigned(ADA), (v) => v.length === 1);
  assert.deepEqual(await types(ADA), ["assigned", "comment_mention"]);
  // The level is per page: the same reply on another page still notifies.
  const other = new Y.Doc();
  primeComments("lv-other", other);
  const o1 = thread(other, "o1", { id: "x1", actorId: by(ADA), author: "Ada", text: "First", createdAt: 1 });
  await commentsStored("lv-other", "primary", "task2", other, [ADA]);
  o1.push([{ id: "x2", actorId: by(BOB), author: "Bob", text: "Reply", createdAt: 2 }]);
  assert.equal(await commentsStored("lv-other", "primary", "task2", other, [BOB]), 1);
});

test("level 'all' adds new threads and page comments you took no part in — never your own, never without view, one item per comment, within budgets", async () => {
  grantUser(EVE, "tag", "team", "view");
  for (const e of [ADA, EVE]) assert.equal((await putLevel(e, "task", "all")).status, 200);
  const doc = new Y.Doc();
  primeComments("lv-all", doc);
  // Bob starts a thread: Ada and Eve follow the page.
  const t1 = thread(doc, "t1", { id: "c1", actorId: by(BOB), author: "Bob", text: "A new thread", createdAt: 1 });
  assert.equal(await commentsStored("lv-all", "primary", "task", doc, [BOB]), 2);
  const ada = (await inbox(ADA)).items;
  assert.deepEqual(ada.map((i) => [i.type, i.actor?.name, i.anchor]), [["comment_thread", "Bob", { thread: "t1" }]]);
  assert.deepEqual(await types(EVE), ["comment_thread"]);
  assert.deepEqual(await types(BOB), [], "never your own");
  // A reply in a thread Ada never joined is not a new thread: nothing more.
  t1.push([{ id: "c2", actorId: by(BOB), author: "Bob", text: "More", createdAt: 2 }]);
  assert.equal(await commentsStored("lv-all", "primary", "task", doc, [BOB]), 0);
  // A page comment, and a reply to it, both count as page comments.
  const pg = thread(doc, "pg", { id: "p1", actorId: by(BOB), author: "Bob", text: "Page comment", createdAt: 3 }, true);
  assert.equal(await commentsStored("lv-all", "primary", "task", doc, [BOB]), 2);
  pg.push([{ id: "p2", actorId: by(ADA), author: "Ada", text: "Reply on the page", createdAt: 4 }]);
  // Ada wrote it: Bob (participant) gets the reply, Eve (follower) the page comment, Ada nothing.
  assert.equal(await commentsStored("lv-all", "primary", "task", doc, [ADA]), 2);
  assert.deepEqual(await types(BOB), ["comment_reply"]);
  assert.deepEqual(await types(ADA), ["comment_thread", "comment_thread"]);
  assert.deepEqual(await types(EVE), ["comment_thread", "comment_thread", "comment_thread"]);
  // Losing view ends it: Eve hears nothing more and her items disappear.
  revoke(EVE);
  clearNoteInfoCache();
  thread(doc, "t9", { id: "z1", actorId: by(BOB), author: "Bob", text: "After Eve left", createdAt: 9 });
  assert.equal(await commentsStored("lv-all", "primary", "task", doc, [BOB]), 1);
  assert.deepEqual(await types(EVE), []);
  // The comment filter group lists the new type; settings category `comment` governs its push.
  assert.equal((await inbox(ADA, "?type=comment")).items.length, 3);
  // Budget: a burst of threads from one sender on one page stops at the per-page budget (8/h).
  for (let i = 0; i < 12; i++) thread(doc, `burst${i}`, { id: `b${i}`, actorId: by(BOB), author: "Bob", text: `n${i}`, createdAt: 20 + i });
  await commentsStored("lv-all", "primary", "task", doc, [BOB]);
  assert.equal((await inbox(ADA, "?type=comment_thread")).items.length, 8);
});
