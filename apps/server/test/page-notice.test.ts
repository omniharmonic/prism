/**
 * Slice I review (S5): an open live document is told to look again when its page's NAME
 * changes — a move, or a write of the stored title (`metadata.title`) through the properties
 * route, a member's PATCH or the owner passthrough. The message carries no data.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { addGrant, ensureUser } from "../src/db";
import { docNameFor, hocuspocus, resetReconcileState } from "../src/collab";
import { resetTreeForTests } from "../src/tree";
import { writesTitle } from "../src/page-notice";
import { stopConversionWorkers } from "../src/convert/service";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

after(async () => { await stopConversionWorkers(); });

const OWNER = "owner@test.local";
const EDITOR = "editor@test.local";
const JSON_H = { "content-type": "application/json", origin: process.env.APP_ORIGIN ?? "http://localhost:8787", "sec-fetch-site": "same-origin", "x-prism-editor-schema": "6" };
let fv: FakeVault;
let heard: string[] = [];
let release: (() => Promise<void>) | null = null;

beforeEach(async () => {
  resetDb();
  resetTreeForTests();
  resetReconcileState();
  fv = installFakeVault();
  ensureUser(EDITOR);
  addGrant({ subject_type: "user", subject: EDITOR, resource_type: "tag", resource: "garden", level: "edit", created_by: "test", vault_id: "primary" });
  fv.put({ id: "d1", path: "vault/Garden/Page", tags: ["garden"], content: "<p>alpha</p>", updatedAt: "2026-02-01T00:00:00.000Z" });
  // The page is open as a live document; listen to what its sockets would be told.
  const name = docNameFor("primary", "d1");
  const connection = await hocuspocus.openDirectConnection(name, {});
  const doc = hocuspocus.documents.get(name)!;
  heard = [];
  (doc as unknown as { broadcastStateless(payload: string): void }).broadcastStateless = (payload: string) => { heard.push(payload); };
  release = () => connection.disconnect();
});
afterEach(async () => {
  await release?.();
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  fv.restore();
});
const told = () => heard.filter((m) => m.includes("prism:page-changed")).length;
const settle = () => new Promise((r) => setTimeout(r, 50));

test("writesTitle reads a write body", () => {
  assert.equal(writesTitle({ metadata: { title: "X" } }), true);
  assert.equal(writesTitle({ metadata: { title: null } }), true);
  assert.equal(writesTitle('{"metadata":{"title":"X"}}'), true);
  assert.equal(writesTitle({ metadata: { status: "done" } }), false);
  assert.equal(writesTitle({ content: 'the word "title" in a body' }), false);
  assert.equal(writesTitle("{not json"), false);
});

test("a stored-title write through /api/properties tells the open document; another property does not", async () => {
  const cookie = sessionCookie(makeSession(OWNER));
  const other = await api.request("/properties/d1", { method: "POST", headers: { ...JSON_H, cookie }, body: JSON.stringify({ set: { status: "done" } }) });
  assert.equal(other.status, 200, await other.clone().text());
  await settle();
  assert.equal(told(), 0);
  const res = await api.request("/properties/d1", { method: "POST", headers: { ...JSON_H, cookie }, body: JSON.stringify({ set: { title: "A stored title" }, expect: { title: null } }) });
  assert.equal(res.status, 200, await res.clone().text());
  await settle();
  assert.equal(told(), 1);
  assert.deepEqual(JSON.parse(heard.find((m) => m.includes("prism:page-changed"))!), { type: "prism:page-changed" }, "the message carries nothing but its type");
});

test("a member's PATCH and the owner passthrough's PATCH of metadata.title tell it too", async () => {
  const member = sessionCookie(makeSession(EDITOR));
  const stamp = () => fv.notes.get("d1")!.updatedAt;
  const a = await api.request("/notes/d1", { method: "PATCH", headers: { ...JSON_H, cookie: member }, body: JSON.stringify({ metadata: { title: "From a member" }, if_updated_at: stamp() }) });
  assert.equal(a.status, 200, await a.clone().text());
  await settle();
  assert.equal(told(), 1);
  const owner = sessionCookie(makeSession(OWNER));
  const b = await api.request("/notes/d1", { method: "PATCH", headers: { ...JSON_H, cookie: owner }, body: JSON.stringify({ metadata: { title: "From the owner" }, if_updated_at: stamp() }) });
  assert.equal(b.status, 200, await b.clone().text());
  await settle();
  assert.equal(told(), 2);
  // A metadata write that does not touch the title says nothing.
  const c = await api.request("/notes/d1", { method: "PATCH", headers: { ...JSON_H, cookie: owner }, body: JSON.stringify({ metadata: { icon: "🌱" }, if_updated_at: stamp() }) });
  assert.equal(c.status, 200, await c.clone().text());
  await settle();
  assert.equal(told(), 2);
});
