/**
 * Templates, server defence in depth (review B1 rule 4 + should-fix 2).
 * A note tagged `template` is a blueprint, not content: it is never part of a
 * public site, never a row of a view that did not ask for templates, and its
 * mention chips notify and link nobody. Real routes over the fake vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { publish } from "../src/routes/publish";
import { config } from "../src/config";
import { addGrant, createPublication, setAccount } from "../src/db";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests } from "../src/routes/databases";
import { _resetNotifications, noteContentStored, setDeliveryHook } from "../src/notifications";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

const OWNER = config.ownerEmail;
const ADA = "ada@test.local";
const J = { "content-type": "application/json" };
let fv: FakeVault;
let delivered: Array<{ recipient: string }>;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  _resetNotifications();
  fv = installFakeVault();
  delivered = [];
  setDeliveryHook((n) => delivered.push(n));
});
afterEach(() => { setDeliveryHook(null); fv.restore(); resetTreeForTests(); });

const cookie = (email: string) => sessionCookie(makeSession(email));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a `template` note is never part of a TAG publication: listing, single note, graph", async () => {
  fv.put({ id: "page", path: "Wiki/Page", content: "<p>public page</p>", tags: ["wiki"] });
  // A template that (still) carries the published tag and is not private — e.g. hand-tagged, or made by an older client.
  fv.put({ id: "tpl", path: "Templates/Page", content: "<p>TEMPLATE-BODY links [[Wiki/Page]]</p>", tags: ["wiki", "template"] });
  createPublication({ id: "site", resource_type: "tag", resource: "wiki", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "wiki", level: "view", created_by: "test" });
  const manifest = await publish.request("/site");
  assert.equal(manifest.status, 200);
  const text = await manifest.text();
  assert.ok(text.includes("page"), "the real page is listed");
  assert.ok(!text.includes("tpl") && !text.includes("Templates/Page"), "the template is not listed");
  assert.equal((await publish.request("/site/notes/page")).status, 200);
  const single = await publish.request("/site/notes/tpl");
  assert.ok(single.status === 403 || single.status === 404, `template served: ${single.status}`);
  assert.ok(!(await single.text()).includes("TEMPLATE-BODY"));
  const graph = await (await publish.request("/site/graph")).text();
  assert.ok(!graph.includes("tpl"));
});

test("a `template` note is never part of a FOLDER publication", async () => {
  fv.put({ id: "page", path: "Site/Page", content: "<p>y</p>", tags: [] });
  fv.put({ id: "tpl", path: "Site/Templates/T", content: "<p>TEMPLATE-BODY</p>", tags: ["template"] });
  createPublication({ id: "folder", resource_type: "path", resource: "Site", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  const text = await (await publish.request("/folder")).text();
  assert.ok(text.includes("page") && !text.includes("tpl"));
  const single = await publish.request("/folder/notes/tpl");
  assert.ok(single.status === 403 || single.status === 404);
});

test("/api/query: a template of a task is not a task — unless the view asks for templates", async () => {
  fv.put({ id: "real", path: "vault/tasks/Real", content: "", tags: ["task"], metadata: { status: "todo" } });
  fv.put({ id: "tpl", path: "Templates/Task", content: "", tags: ["task", "template"], metadata: { status: "todo" } });
  grantUser(ADA, "tag", "task", "edit");
  grantUser(ADA, "tag", "template", "view");
  const query = async (email: string, tags: string[]) => {
    const r = await api.request("/query", { method: "POST", headers: { ...J, cookie: cookie(email) }, body: JSON.stringify({ tags }) });
    assert.equal(r.status, 200, await r.clone().text());
    return ((await r.json()) as { rows: Array<{ id: string }>; total: number });
  };
  for (const who of [OWNER, ADA]) {
    const tasks = await query(who, ["task"]);
    assert.deepEqual(tasks.rows.map((r) => r.id), ["real"], `${who}: only the real task`);
    assert.equal(tasks.total, 1);
    assert.deepEqual((await query(who, ["template"])).rows.map((r) => r.id), ["tpl"], `${who}: asked for templates`);
  }
});

const chip = (uid: string) => `<span data-type="mention" data-kind="person" data-id="p-ada" data-mention-uid="${uid}">@Ada</span>`;

test("mention chips in a `template` note notify nobody and add no backlink; a page made from it does", async () => {
  setAccount(ADA, "Ada Lovelace", "scrypt$fixture");
  fv.put({ id: "p-ada", path: "vault/people/Ada Lovelace", tags: ["person"], metadata: { name: "Ada Lovelace", email: ADA } });
  fv.put({ id: "tpl", path: "Templates/Standup", tags: ["template"], content: "<p>x</p>" });
  fv.put({ id: "page", path: "vault/Standup today", tags: ["team"], content: "<p>x</p>" });
  grantUser(ADA, "tag", "team", "view");
  grantUser(ADA, "tag", "template", "view");
  grantUser(ADA, "tag", "person", "view");
  // Direct (the collab store's path)…
  const direct = await noteContentStored({ vaultId: "primary", noteId: "tpl", prev: "<p>x</p>", next: `<p>${chip("t1")}</p>`, authors: [OWNER], updatedAt: fv.notes.get("tpl")!.updatedAt });
  assert.deepEqual(direct, { notified: 0, linked: 0, unlinked: 0 });
  // …and through a REST write (owner passthrough).
  const res = await api.request("/notes/tpl", { method: "PATCH", headers: { ...J, cookie: cookie(OWNER), "x-prism-editor-schema": "99" }, body: JSON.stringify({ content: `<p>${chip("t2")}</p>` }) });
  assert.equal(res.status, 200);
  await sleep(120);
  assert.equal(delivered.length, 0, "nobody is notified about a template");
  assert.deepEqual(fv.notes.get("tpl")!.links ?? [], [], "no `mentions` backlink from a template");
  // The same chip in an ordinary page notifies as always.
  const real = await noteContentStored({ vaultId: "primary", noteId: "page", prev: "<p>x</p>", next: `<p>${chip("p1")}</p>`, authors: [OWNER], updatedAt: fv.notes.get("page")!.updatedAt });
  assert.equal(real.notified, 1);
  assert.equal(delivered.length, 1);
});
