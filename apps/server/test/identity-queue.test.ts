/**
 * The identity review queue: SQLite store + the owner-only routes
 * (`/api/admin/people/candidates*`). Fake vault, synthetic people.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { db, setMembership } from "../src/db";
import { adminApi } from "../src/routes/admin";
import { candidateStatus, enqueueCandidate, getCandidate, keyHash, listCandidates, openCandidateCounts, vaultIdentity } from "../src/identity-store";
import { addKeyPatch } from "../src/people-metadata";
import { resetDb, makeSession, sessionCookie, makeCapability, installFakeVault, type FakeVault } from "./helpers";

const J = { "content-type": "application/json" };
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
const post = (p: string, h: Record<string, string>, body: unknown = {}) => adminApi.request(p, { method: "POST", headers: h, body: JSON.stringify(body) });
const get = (p: string, h: Record<string, string> = owner()) => adminApi.request(p, { headers: h });
let clock = 1_000;
const queue = (source: string, key: { kind: string; value: string }, extra: Partial<Parameters<typeof enqueueCandidate>[0]> = {}) =>
  enqueueCandidate({ vaultId: "primary", sourceNoteId: source, relationship: "email-from", key, candidateIds: ["p1", "p2"], reason: "ambiguous-key", origin: "backfill:emails", ...extra }, clock++);
const onlyId = () => listCandidates("primary").candidates[0]!.id;

function seedPeople() {
  fv.put({ id: "p1", path: "vault/people/Alex Example", tags: ["person"], metadata: { name: "Alex Example", email: "alex@example.test" } });
  fv.put({ id: "p2", path: "vault/people/Blake Example", tags: ["person"], metadata: { name: "Blake Example", aliases: "B. Example" } });
  fv.put({ id: "e1", path: "vault/messages/email/one", tags: ["email"], metadata: { from: "New <new@example.test>" }, links: [] });
  fv.put({ id: "e2", path: "vault/messages/email/two", tags: ["email"], metadata: { from: "New <new@example.test>" }, links: [] });
}

test("store: one row per (source, relationship, key); a closed row is never reopened; counts + paging", () => {
  assert.equal(queue("e1", { kind: "email", value: "new@example.test" }), "created");
  assert.equal(queue("e1", { kind: "email", value: "new@example.test" }, { candidateIds: ["p2"] }), "refreshed");
  assert.equal(queue("e2", { kind: "email", value: "new@example.test" }), "created");
  assert.equal(queue("e1", { kind: "email", value: "new@example.test" }, { relationship: "email-to" }), "created", "a different relationship is a different question");
  const page = listCandidates("primary", { limit: 2 });
  assert.equal(page.candidates.length, 2);
  assert.ok(page.next);
  const rest = listCandidates("primary", { limit: 2, after: page.next });
  assert.equal(rest.candidates.length, 1);
  assert.equal(rest.next, null);
  assert.equal(new Set([...page.candidates, ...rest.candidates].map((c) => c.id)).size, 3);
  assert.deepEqual(page.candidates[0]!.candidateIds, ["p2"], "the refresh replaced the candidate list");
  assert.deepEqual(openCandidateCounts("primary"), { total: 3, byReason: { "ambiguous-key": 3 } });
  assert.equal(page.candidates[0]!.key.hash, keyHash("email", "new@example.test"));

  db.prepare("UPDATE identity_candidates SET status = 'dismissed' WHERE source_note_id = 'e2'").run();
  assert.equal(queue("e2", { kind: "email", value: "new@example.test" }), "closed");
  assert.equal(candidateStatus("primary", "e2", "email-from", { kind: "email", value: "new@example.test" }), "dismissed");
  assert.equal(candidateStatus("primary", "nope", "email-from", { kind: "email", value: "new@example.test" }), null);
  assert.equal(openCandidateCounts("primary").total, 2);
  assert.equal(listCandidates("primary", { status: "dismissed" }).candidates.length, 1);
});

test("store: rows are pinned to the vault they were seen in", () => {
  queue("e1", { kind: "email", value: "new@example.test" });
  const id = onlyId();
  assert.ok(getCandidate("primary", id));
  // Same registry id, different vault behind it → the row is invisible.
  db.prepare("UPDATE identity_candidates SET vault_identity = 'another-vault'").run();
  assert.equal(getCandidate("primary", id), null);
  assert.equal(listCandidates("primary").candidates.length, 0);
  assert.equal(vaultIdentity("primary").length, 24);
});

test("routes: server owner only; CSRF on mutations; bounded list", async () => {
  seedPeople();
  queue("e1", { kind: "email", value: "new@example.test" });
  const id = onlyId();
  setMembership("primary", "admin@example.test", "admin", null);
  setMembership("primary", "member@example.test", "member", null);
  setMembership("primary", "coowner@example.test", "owner", null);
  for (const h of [
    J,
    { ...J, authorization: `Capability ${makeCapability("note", "e1", "edit")}` },
    { ...J, cookie: sessionCookie(makeSession("guest@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("member@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("admin@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("coowner@example.test")) },
  ]) {
    assert.equal((await get("/people/candidates", h)).status, 403);
    assert.equal((await post(`/people/candidates/${id}/resolve`, h, { personId: "p1" })).status, 403);
    assert.equal((await post(`/people/candidates/${id}/dismiss`, h)).status, 403);
  }
  assert.equal((await post(`/people/candidates/${id}/resolve`, { ...owner(), "content-type": "text/plain" }, { personId: "p1" })).status, 415);
  assert.equal((await post(`/people/candidates/${id}/dismiss`, { ...owner(), "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(fv.calls.length, 0, "nothing reached the vault");
  for (const bad of ["?limit=0", "?limit=201", "?status=maybe", `?after=${"x".repeat(100)}`]) assert.equal((await get(`/people/candidates${bad}`)).status, 400);
  const body = (await (await get("/people/candidates")).json()) as { candidates: Array<{ id: string; key: { value: string } }>; open: { total: number }; next: string | null };
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0]!.key.value, "new@example.test", "the owner sees what they are deciding");
  assert.equal(body.open.total, 1);
});

test("resolve: links the source to the chosen person (CAS, links only) and teaches the person the key", async () => {
  seedPeople();
  queue("e1", { kind: "email", value: "new@example.test" }, { reason: "name-key-mismatch", display: "Blake Example" });
  const id = onlyId();
  assert.equal((await post(`/people/candidates/${id}/resolve`, owner(), {})).status, 400);
  assert.equal((await post(`/people/candidates/nope/resolve`, owner(), { personId: "p2" })).status, 404);
  assert.equal((await post(`/people/candidates/${id}/resolve`, owner(), { personId: "missing" })).status, 404);
  assert.equal((await post(`/people/candidates/${id}/resolve`, owner(), { personId: "e1" })).status, 404, "the target must be a person");

  const before = fv.notes.get("e1")!.updatedAt;
  const r = await post(`/people/candidates/${id}/resolve`, owner(), { personId: "p2" });
  assert.equal(r.status, 200);
  const out = (await r.json()) as Record<string, unknown>;
  assert.deepEqual({ linked: out.linked, resolved: out.resolved, identityAdded: out.identityAdded }, { linked: 1, resolved: 1, identityAdded: true });
  const patches = fv.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0]!.body, { links: { add: [{ target: "p2", relationship: "email-from" }] }, if_updated_at: before });
  assert.deepEqual((patches[1]!.body as { metadata: unknown }).metadata, { channels: { email: ["new@example.test"] } });
  assert.deepEqual(fv.notes.get("e1")!.links, [{ sourceId: "e1", targetId: "p2", relationship: "email-from" }]);
  assert.equal(getCandidate("primary", id)!.status, "resolved");
  assert.equal(getCandidate("primary", id)!.resolvedPersonId, "p2");
  assert.equal((await post(`/people/candidates/${id}/resolve`, owner(), { personId: "p2" })).status, 409, "already decided");

  const audit = db.prepare("SELECT action, target FROM action_audit").get() as { action: string; target: string };
  assert.equal(audit.action, "admin.people-candidate-resolve");
  assert.ok(!audit.target.includes("new@example.test") && !audit.target.includes("Blake"), "the audit row holds ids, hashes and counts only");
});

test("resolve: applyToKey covers every open source of that key; a key another person claims is not added; a 409 stays open", async () => {
  seedPeople();
  queue("e1", { kind: "email", value: "alex@example.test" });
  queue("e2", { kind: "email", value: "alex@example.test" });
  const id = listCandidates("primary").candidates[0]!.id;
  // p1 already claims this address → linking to p2 must not also give p2 the key.
  const r = await post(`/people/candidates/${id}/resolve`, owner(), { personId: "p2", applyToKey: true });
  const out = (await r.json()) as Record<string, unknown>;
  assert.deepEqual({ linked: out.linked, resolved: out.resolved, identityAdded: out.identityAdded, identitySkipped: out.identitySkipped }, { linked: 2, resolved: 2, identityAdded: false, identitySkipped: "claimed_by_another_person" });
  assert.equal(fv.notes.get("p2")!.metadata!.channels, undefined);
  assert.equal(openCandidateCounts("primary").total, 0);

  // A source that changes under the resolve is counted, never forced, and stays open.
  queue("e1", { kind: "name", value: "b-example" }, { relationship: "email-to", display: "B. Example", reason: "single-token-name" });
  const again = listCandidates("primary").candidates[0]!.id;
  fv.conflictOnNextWrite = true;
  const c = (await (await post(`/people/candidates/${again}/resolve`, owner(), { personId: "p2", addIdentity: false })).json()) as Record<string, unknown>;
  assert.deepEqual({ linked: c.linked, conflicts: c.conflicts, resolved: c.resolved, identitySkipped: c.identitySkipped }, { linked: 0, conflicts: 1, resolved: 0, identitySkipped: "not_requested" });
  assert.equal(getCandidate("primary", again)!.status, "open");
  // Retry: now it links; an existing edge is not re-written.
  await post(`/people/candidates/${again}/resolve`, owner(), { personId: "p2", addIdentity: false });
  queue("e1", { kind: "name", value: "blake" }, { relationship: "email-to", display: "Blake", reason: "single-token-name" });
  const third = listCandidates("primary").candidates[0]!.id;
  const n = fv.calls.filter((x) => x.method === "PATCH").length;
  const t = (await (await post(`/people/candidates/${third}/resolve`, owner(), { personId: "p2", addIdentity: false })).json()) as Record<string, unknown>;
  assert.equal(t.alreadyLinked, 1);
  assert.equal(fv.calls.filter((x) => x.method === "PATCH").length, n, "no write for an edge that exists");
});

test("dismiss closes without touching the vault; applyToKey closes the whole key", async () => {
  seedPeople();
  queue("e1", { kind: "email", value: "new@example.test" });
  queue("e2", { kind: "email", value: "new@example.test" });
  queue("e2", { kind: "email", value: "other@example.test" });
  const id = listCandidates("primary").candidates[0]!.id;
  const r = (await (await post(`/people/candidates/${id}/dismiss`, owner(), { applyToKey: true })).json()) as { dismissed: number };
  assert.equal(r.dismissed, 2);
  assert.equal(openCandidateCounts("primary").total, 1);
  assert.equal(fv.calls.length, 0);
  assert.equal((await post(`/people/candidates/${id}/dismiss`, owner())).status, 409);
});

test("addKeyPatch: a delta that never overwrites, in the shapes the vault already uses", () => {
  const note = (metadata: Record<string, unknown>) => ({ id: "p", content: "", path: "vault/people/Pat Lane", tags: ["person"], metadata, createdAt: "", updatedAt: "" });
  assert.deepEqual(addKeyPatch(note({ email: "a@example.test" }), { kind: "email", value: "b@example.test" }), { channels: { email: ["b@example.test"] } });
  assert.equal(addKeyPatch(note({ email: "A@example.test" }), { kind: "email", value: "a@example.test" }), null, "already claimed");
  assert.deepEqual(addKeyPatch(note({ channels: { matrix: "@a:h.test" } }), { kind: "matrix", value: "@b:h.test" }), { channels: { matrix: ["@a:h.test", "@b:h.test"] } });
  assert.deepEqual(addKeyPatch(note({}), { kind: "matrix", value: "@b:h.test" }), { channels: { matrix: "@b:h.test" } });
  assert.deepEqual(addKeyPatch(note({}), { kind: "telegram", value: "424242" }), { channels: { telegram: "telegram_424242" } });
  assert.deepEqual(addKeyPatch(note({ phone: "" }), { kind: "phone", value: "15550100" }), { phone: "+15550100" });
  assert.deepEqual(addKeyPatch(note({ phone: "+1 555 0199" }), { kind: "phone", value: "15550100" }), { channels: { phone: "+15550100" } });
  assert.deepEqual(addKeyPatch(note({ aliases: "Patty Lane" }), { kind: "name", value: "p-lane" }, "P. Lane"), { aliases: "Patty Lane, P. Lane" }, "a CSV alias field stays a string");
  assert.deepEqual(addKeyPatch(note({ aliases: ["Patty Lane"] }), { kind: "name", value: "p-lane" }, "P. Lane"), { aliases: ["Patty Lane", "P. Lane"] });
  assert.equal(addKeyPatch(note({}), { kind: "name", value: "pat-lane" }, "Pat Lane"), null, "the path already names them");
  assert.equal(addKeyPatch(note({}), { kind: "handle", value: "twitter:5" }), null);
});
