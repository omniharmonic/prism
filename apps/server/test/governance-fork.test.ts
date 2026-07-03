/**
 * G5 — fork / ancestry / merge-back, through the real Hono governance app + a
 * fake vault. Pins the locked decision: merge-back is PROPOSAL-ONLY — a fork's
 * content lands on its origin only after clearing the same per-tag sign-off as
 * any other edit.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { governance } from "../src/routes/governance";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

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
  assert.equal((await jreq("/fork", cookieFor("g1@test.local"), "POST", { noteId: "nope" })).status, 400);
  assert.equal((await jreq("/fork", undefined, "POST", { noteId: "x" })).status, 401);
});
