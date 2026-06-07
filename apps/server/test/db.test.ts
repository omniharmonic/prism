/**
 * The SQLite store holds all identity + access state. Security-relevant
 * invariants tested here: magic-link tokens are single-use and expire; sessions
 * expire (and are reaped on read); grant upsert updates in place rather than
 * duplicating; revocation actually deletes; and the CRDT doc-state round-trips
 * its binary payload faithfully.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  storeMagicLink,
  consumeMagicLink,
  createSession,
  getSession,
  destroySession,
  addGrant,
  grantsForUser,
  grantsForCapability,
  upsertGrant,
  removeGrantBySubjectResource,
  createCapability,
  capabilitiesForResource,
  deleteCapability,
  getDocState,
  saveDocState,
} from "../src/db";
import { resetDb } from "./helpers";

beforeEach(() => resetDb());

const h = (s: string) => `hash-${s}`;

test("magic link: a valid, unused, unexpired token redeems to its email", () => {
  storeMagicLink(h("t1"), "alice@example.com", 60_000);
  assert.equal(consumeMagicLink(h("t1")), "alice@example.com");
});

test("magic link is single-use: the second redemption returns null", () => {
  storeMagicLink(h("t2"), "bob@example.com", 60_000);
  assert.equal(consumeMagicLink(h("t2")), "bob@example.com");
  assert.equal(consumeMagicLink(h("t2")), null);
});

test("magic link expires: a token past its TTL does not redeem", () => {
  storeMagicLink(h("t3"), "carol@example.com", -1); // already expired
  assert.equal(consumeMagicLink(h("t3")), null);
});

test("an unknown magic-link hash returns null", () => {
  assert.equal(consumeMagicLink(h("never-stored")), null);
});

test("session: create then read returns the row; destroy removes it", () => {
  createSession("s1", "dave@example.com", 60_000);
  assert.equal(getSession("s1")?.email, "dave@example.com");
  destroySession("s1");
  assert.equal(getSession("s1"), null);
});

test("session expires and is reaped on read", () => {
  createSession("s2", "erin@example.com", -1);
  assert.equal(getSession("s2"), null);
  // reaped: a second read is still null (and the row is gone)
  assert.equal(getSession("s2"), null);
});

test("grantsForUser includes the user's own grants AND any 'anyone' grants", () => {
  addGrant({ subject_type: "user", subject: "u@x.co", resource_type: "note", resource: "n1", level: "edit", created_by: null });
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "public", level: "view", created_by: null });
  addGrant({ subject_type: "user", subject: "other@x.co", resource_type: "note", resource: "n9", level: "own", created_by: null });
  const grants = grantsForUser("u@x.co");
  const keys = grants.map((g) => `${g.subject_type}:${g.resource}`).sort();
  assert.deepEqual(keys, ["anyone:public", "user:n1"]);
});

test("grantsForCapability is scoped to that capability id only", () => {
  addGrant({ subject_type: "link", subject: "capA", resource_type: "note", resource: "n1", level: "view", created_by: null });
  addGrant({ subject_type: "link", subject: "capB", resource_type: "note", resource: "n2", level: "view", created_by: null });
  assert.equal(grantsForCapability("capA").length, 1);
  assert.equal(grantsForCapability("capA")[0]!.resource, "n1");
});

test("upsertGrant updates the level in place instead of duplicating", () => {
  upsertGrant({ subject_type: "user", subject: "u@x.co", resource_type: "note", resource: "n1", level: "view", created_by: null });
  upsertGrant({ subject_type: "user", subject: "u@x.co", resource_type: "note", resource: "n1", level: "edit", created_by: null });
  const grants = grantsForUser("u@x.co");
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.level, "edit");
});

test("removeGrantBySubjectResource revokes access", () => {
  upsertGrant({ subject_type: "user", subject: "u@x.co", resource_type: "note", resource: "n1", level: "edit", created_by: null });
  removeGrantBySubjectResource("user", "u@x.co", "note", "n1");
  assert.equal(grantsForUser("u@x.co").length, 0);
});

test("capability metadata: create, list by resource, delete (link revocation)", () => {
  createCapability({ id: "cap1", resource_type: "note", resource: "n1", level: "view", label: "share", expires_at: Date.now() + 1000 });
  assert.equal(capabilitiesForResource("note", "n1").length, 1);
  deleteCapability("cap1");
  assert.equal(capabilitiesForResource("note", "n1").length, 0);
});

test("collab doc state round-trips its binary payload and sourceUpdatedAt", () => {
  const state = new Uint8Array([1, 2, 3, 250, 255, 0]);
  saveDocState("note-1", state, 1234);
  const got = getDocState("note-1");
  assert.ok(got);
  assert.deepEqual([...got!.state], [...state]);
  assert.equal(got!.sourceUpdatedAt, 1234);
});

test("saving doc state again overwrites the previous payload (upsert by name)", () => {
  saveDocState("note-2", new Uint8Array([1]), 1);
  saveDocState("note-2", new Uint8Array([9, 9]), 2);
  const got = getDocState("note-2");
  assert.deepEqual([...got!.state], [9, 9]);
  assert.equal(got!.sourceUpdatedAt, 2);
});

test("getDocState for an unknown note is null", () => {
  assert.equal(getDocState("nope"), null);
});
