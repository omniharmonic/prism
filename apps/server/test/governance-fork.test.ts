/**
 * G5 — fork / ancestry / merge-back, through the real Hono governance app + a
 * fake vault. Pins the locked decision: merge-back is PROPOSAL-ONLY — a fork's
 * content lands on its origin only after clearing the same per-tag sign-off as
 * any other edit.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { governance } from "../src/routes/governance";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";
const cookieFor = (e: string) => sessionCookie(makeSession(e));

function jreq(path: string, cookie: string | undefined, method = "GET", payload?: unknown) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("content-type", "application/json");
  return governance.request(path, { method, headers, body: payload !== undefined ? JSON.stringify(payload) : undefined });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json();

/** Gardeners of #medicine, auto-publish edit policy at threshold 2, enabled. */
async function bootstrap() {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardener", powers: ["review", "publish"], scopeType: "tag", scope: "medicine" });
  await jreq("/policies", owner, "POST", { action: "edit_note", scopeType: "tag", scope: "medicine", thresholdN: 2, distinctRequired: true, eligibleRole: "gardener", autoPublish: true });
  for (const g of ["g1@test.local", "g2@test.local"]) await jreq("/memberships", owner, "POST", { subject: g, role: "gardener" });
  assert.equal((await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, defaultEligibleRole: "gardener" })).status, 200);
  // Forking and proposing need VIEW on the note; the gardeners can read #medicine.
  for (const g of ["g1@test.local", "g2@test.local"]) grantUser(g, "tag", "medicine", "view");
}

test("fork copies content+tags and stamps ancestry", async () => {
  fv.put({ id: "n_orig", content: "# Yarrow\nv1", tags: ["medicine"], path: "medicine/yarrow" });
  await bootstrap();

  const r = await jreq("/fork", cookieFor("g1@test.local"), "POST", { noteId: "n_orig" });
  assert.equal(r.status, 201);
  const { id, forkedFrom } = await body(r);
  assert.equal(forkedFrom, "n_orig");

  const fork = fv.notes.get(id)!;
  assert.equal(fork.content, "# Yarrow\nv1");
  assert.ok((fork.tags ?? []).includes("medicine"));
  assert.equal(fork.metadata!.forked_from, "n_orig");
  assert.equal(fork.metadata!.forked_by, "g1@test.local");
  assert.ok(String(fork.path).startsWith("medicine/yarrow-fork-"));
});

test("merge-back is proposal-only and lands at the sign-off threshold", async () => {
  fv.put({ id: "n_orig", content: "# Yarrow\nv1", tags: ["medicine"] });
  await bootstrap();
  const owner = cookieFor(OWNER);
  const g1 = cookieFor("g1@test.local");

  // fork → diverge
  const { id: forkId } = await body(await jreq("/fork", g1, "POST", { noteId: "n_orig" }));
  fv.notes.get(forkId)!.content = "# Yarrow\nv2 improved from the fork";

  // propose the merge — the ORIGIN is untouched
  const pm = await jreq(`/forks/${forkId}/propose-merge`, g1, "POST");
  assert.equal(pm.status, 201);
  const { proposalId, target } = await body(pm);
  assert.equal(target, "n_orig");
  assert.equal(fv.notes.get("n_orig")!.content, "# Yarrow\nv1");

  // apply refused before sign-off
  assert.equal((await jreq(`/proposals/${proposalId}/apply`, owner, "POST")).status, 409);

  // two distinct gardeners sign off → merge lands on the origin
  assert.equal((await jreq(`/proposals/${proposalId}/vote`, g1, "POST", { vote: "approve" })).status, 200);
  assert.equal((await jreq(`/proposals/${proposalId}/vote`, cookieFor("g2@test.local"), "POST", { vote: "approve" })).status, 200);
  const applied = await jreq(`/proposals/${proposalId}/apply`, owner, "POST");
  assert.equal(applied.status, 200);
  assert.equal(fv.notes.get("n_orig")!.content, "# Yarrow\nv2 improved from the fork");

  // the fork itself is untouched (it remains a divergent copy)
  assert.equal(fv.notes.get(forkId)!.content, "# Yarrow\nv2 improved from the fork");
});

test("propose-merge on a non-fork or dangling origin fails cleanly", async () => {
  fv.put({ id: "n_plain", content: "x", tags: ["medicine"] });
  await bootstrap();
  const g1 = cookieFor("g1@test.local");

  // not a fork
  assert.equal((await jreq("/forks/n_plain/propose-merge", g1, "POST")).status, 400);

  // fork whose origin was deleted
  const { id: forkId } = await body(await jreq("/fork", g1, "POST", { noteId: "n_plain" }));
  fv.notes.delete("n_plain");
  assert.equal((await jreq(`/forks/${forkId}/propose-merge`, g1, "POST")).status, 400);
});

test("fork of a missing note 400s; anonymous cannot fork", async () => {
  await bootstrap();
  assert.equal((await jreq("/fork", cookieFor("g1@test.local"), "POST", { noteId: "nope" })).status, 404);
  assert.equal((await jreq("/fork", undefined, "POST", { noteId: "x" })).status, 401);
});

// ── security hotfix: fork needs view on the source, refuses system notes, and is private ──

test("fork: an unviewable or aliased source is a 404 identical to a missing one; system notes are refused", async () => {
  fv.put({ id: "n_secret", content: "secret", tags: ["secret"], path: "secret/plan", metadata: { title: "Secret Plan" } });
  fv.put({ id: "n_private", content: "private", tags: ["medicine"], path: "medicine/private", metadata: { prism_creator: OWNER, prism_visibility: "private" } });
  fv.put({ id: "n_orig", content: "ok", tags: ["medicine"], path: "medicine/yarrow" });
  fv.put({ id: "n_skill", content: "prompt", tags: ["medicine", "agent-skill"], path: "medicine/skill" });
  fv.put({ id: "n_person", content: "p", tags: ["medicine"], path: "vault/people/Ada" });
  await bootstrap();
  const g1 = cookieFor("g1@test.local");
  const count = fv.notes.size;
  const missing = await jreq("/fork", g1, "POST", { noteId: "nope" });
  assert.equal(missing.status, 404);
  const missingBody = await missing.text();
  for (const noteId of ["n_secret", "n_private", "secret/plan", "Secret Plan", "medicine/yarrow"]) {
    const r = await jreq("/fork", g1, "POST", { noteId });
    assert.equal(r.status, 404, noteId);
    assert.equal(await r.text(), missingBody, noteId);
  }
  for (const noteId of ["n_skill", "n_person"]) assert.equal((await jreq("/fork", g1, "POST", { noteId })).status, 403, noteId);
  assert.equal(fv.notes.size, count, "nothing was copied");
});

test("fork: the copy is private to the forker and inherits no reserved metadata", async () => {
  fv.put({ id: "n_orig", content: "body", tags: ["medicine"], path: "medicine/yarrow", metadata: { title: "Yarrow", prism_creator: "author@test.local", prism_locked: true, prism_order: 3, prism_last_writer: "u_x" } });
  await bootstrap();
  const g1 = cookieFor("g1@test.local");
  const { id } = await body(await jreq("/fork", g1, "POST", { noteId: "n_orig" }));
  const fork = fv.notes.get(id)!;
  assert.equal(fork.metadata!.prism_creator, "g1@test.local");
  assert.equal(fork.metadata!.prism_visibility, "private");
  assert.equal(fork.metadata!.title, "Yarrow");
  for (const k of ["prism_locked", "prism_order", "prism_last_writer"]) assert.ok(!(k in fork.metadata!), k);
  // Someone else who can read #medicine cannot merge (or even see) g1's fork; g1 can.
  assert.equal((await jreq(`/forks/${id}/propose-merge`, cookieFor("g2@test.local"), "POST")).status, 404);
  assert.equal((await jreq(`/forks/${id}/propose-merge`, g1, "POST")).status, 201);
});
