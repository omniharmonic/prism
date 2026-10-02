/**
 * Owner decision 5: merged people are hidden server-side. `GET /api/people`
 * lists neither tombstones nor non-human notes; opening a tombstone returns the
 * person it was merged into, with an additive `mergedFrom` hint.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { peopleApi } from "../src/routes/people";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, grantUser, installFakeVault, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  fv.put({ id: "live", path: "vault/people/Morgan Example", tags: ["person", "team"], metadata: { name: "Morgan Example", email: "morgan@example.org" }, links: [{ sourceId: "mail", targetId: "live", relationship: "email-from" }] });
  fv.put({ id: "stub", path: "vault/people/morgan-example-org", tags: ["person", "merged-stub", "team"], metadata: { name: "morgan-example-org", merged_into: "vault/people/Morgan Example", status: "merged_into_canonical" } });
  fv.put({ id: "status-only", path: "vault/people/old-two", tags: ["person"], metadata: { name: "old-two", status: "merged_into_canonical" } });
  fv.put({ id: "bot", path: "vault/people/Notetaker", tags: ["person", "bot"], metadata: { name: "Notetaker" } });
  fv.put({ id: "org", path: "vault/people/Acme", tags: ["person"], metadata: { name: "Acme", type: "organization" } });
  fv.put({ id: "pointer", path: "vault/people/Zed Pointer", tags: ["person"], metadata: { name: "Zed Pointer", superseded_by: "vault/people/Morgan Example" } });
  fv.put({ id: "mail", path: "vault/messages/email/m", tags: ["email", "team"], metadata: { title: "Hello" } });
});
afterEach(() => fv.restore());
const as = (email: string) => ({ cookie: sessionCookie(makeSession(email)) });

test("the directory lists live humans only", async () => {
  const r = (await (await peopleApi.request("/", { headers: as(config.ownerEmail) })).json()) as { people: Array<{ id: string }> };
  assert.deepEqual(r.people.map((p) => p.id), ["live", "pointer"], "a bare pointer without a tombstone tag/status is still a person — the same rule the index uses");
  const q = (await (await peopleApi.request("/?q=morgan", { headers: as(config.ownerEmail) })).json()) as { people: Array<{ id: string }> };
  assert.deepEqual(q.people.map((p) => p.id), ["live"], "a search never surfaces the stub either");
});

test("opening a merged person returns the canonical person + mergedFrom; the shape is otherwise unchanged", async () => {
  const direct = (await (await peopleApi.request("/live", { headers: as(config.ownerEmail) })).json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(direct).sort(), ["next", "person", "related"], "no new key for an ordinary person");
  const via = (await (await peopleApi.request("/stub", { headers: as(config.ownerEmail) })).json()) as { person: { id: string; name: string }; related: Array<{ id: string }>; mergedFrom?: { id: string; path: string } };
  assert.equal(via.person.id, "live");
  assert.deepEqual(via.related.map((x) => x.id), ["mail"], "the canonical person's records");
  assert.deepEqual(via.mergedFrom, { id: "stub", path: "vault/people/morgan-example-org" });
  // A stub that points nowhere opens as itself (so it can be repaired), with no hint.
  const lost = (await (await peopleApi.request("/status-only", { headers: as(config.ownerEmail) })).json()) as { person: { id: string }; mergedFrom?: unknown };
  assert.equal(lost.person.id, "status-only");
  assert.equal(lost.mergedFrom, undefined);
});

test("the redirect respects permissions: a reader who cannot see the canonical person is not redirected to it", async () => {
  grantUser("reader@test.local", "note", "stub", "view");
  const r = (await (await peopleApi.request("/stub", { headers: as("reader@test.local") })).json()) as { person: { id: string }; mergedFrom?: unknown };
  assert.equal(r.person.id, "stub");
  assert.equal(r.mergedFrom, undefined);
  assert.equal((await peopleApi.request("/live", { headers: as("reader@test.local") })).status, 404);
});
