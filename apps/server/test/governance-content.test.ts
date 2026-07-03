/**
 * The content review pipeline (G2) — governed content changes through the real
 * Hono `governance` app + a fake vault. Proves the headline commons flow: a
 * member proposes an edit or a new entry, tag-scoped gardeners sign off, and the
 * change goes live only once the per-tag policy threshold clears — with
 * eligibility correctly scoped to the note's tags.
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

/** Bootstrap an enabled commons: gardeners scoped to #medicine (review +
 *  publish powers), an auto-publish edit policy and a STAGED new-entry policy
 *  on #medicine (2 distinct gardeners each), members g1/g2. */
async function bootstrapContentCommons() {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardener", powers: ["review", "publish"], scopeType: "tag", scope: "medicine" });
  // edit_note auto-publishes at threshold; new_entry stages for an explicit publish.
  await jreq("/policies", owner, "POST", { action: "edit_note", scopeType: "tag", scope: "medicine", thresholdN: 2, distinctRequired: true, eligibleRole: "gardener", autoPublish: true });
  await jreq("/policies", owner, "POST", { action: "new_entry", scopeType: "tag", scope: "medicine", thresholdN: 2, distinctRequired: true, eligibleRole: "gardener", autoPublish: false });
  for (const g of ["g1@test.local", "g2@test.local"]) {
    await jreq("/memberships", owner, "POST", { subject: g, role: "gardener" });
  }
  const cfg = await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, defaultEligibleRole: "gardener" });
  assert.equal(cfg.status, 200);
}

// ── edit_note ──────────────────────────────────────────────────────────────────

test("an edit goes live only after the tag policy threshold is met", async () => {
  fv.put({ id: "n_med", content: "old", tags: ["medicine"] });
  await bootstrapContentCommons();
  const owner = cookieFor(OWNER);

  // any member (even a non-gardener) may PROPOSE
  const open = await jreq("/content/propose", cookieFor("stranger@test.local"), "POST", { action: "edit_note", target: "n_med", content: "new" });
  assert.equal(open.status, 201);
  const { id } = await body(open);

  // no sign-off yet → not applied, note unchanged
  assert.equal((await jreq(`/proposals/${id}/apply`, owner, "POST")).status, 409);
  assert.equal(fv.notes.get("n_med")!.content, "old");

  // one gardener → still short of 2
  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor("g1@test.local"), "POST", { vote: "approve" })).status, 200);
  assert.equal((await jreq(`/proposals/${id}/apply`, owner, "POST")).status, 409);

  // second distinct gardener → threshold cleared → the edit is written live
  // (this policy auto-publishes) AND a published revision is snapshotted
  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor("g2@test.local"), "POST", { vote: "approve" })).status, 200);
  const applied = await jreq(`/proposals/${id}/apply`, owner, "POST");
  assert.equal(applied.status, 200);
  const res = await body(applied);
  assert.equal(res.applied, "edit_note");
  assert.equal(res.published, true);
  assert.equal(fv.notes.get("n_med")!.content, "new");

  const revs = await body(await jreq("/notes/n_med/revisions", owner));
  assert.equal(revs.revisions.length, 1);
  assert.equal(revs.revisions[0].published, true);
});

test("rollback restores a prior revision, non-destructively", async () => {
  fv.put({ id: "n_med", content: "v1", tags: ["medicine"] });
  await bootstrapContentCommons();
  const owner = cookieFor(OWNER);
  const g1 = cookieFor("g1@test.local");
  const g2 = cookieFor("g2@test.local");

  // two governed edits: v2 then v3
  for (const v of ["v2", "v3"]) {
    const open = await jreq("/content/propose", g1, "POST", { action: "edit_note", target: "n_med", content: v });
    const { id } = await body(open);
    await jreq(`/proposals/${id}/vote`, g1, "POST", { vote: "approve" });
    await jreq(`/proposals/${id}/vote`, g2, "POST", { vote: "approve" });
    assert.equal((await jreq(`/proposals/${id}/apply`, owner, "POST")).status, 200);
  }
  assert.equal(fv.notes.get("n_med")!.content, "v3");

  // roll back to the v2 revision (a gardener has the publish power)
  const revs = (await body(await jreq("/notes/n_med/revisions", owner))).revisions;
  assert.equal(revs.length, 2);
  const v2rev = revs[1]; // newest-first → [v3, v2]
  const rb = await jreq("/notes/n_med/rollback", g1, "POST", { revision: v2rev.id });
  assert.equal(rb.status, 200);
  assert.equal(fv.notes.get("n_med")!.content, "v2");

  // non-destructive: history GREW (v3, v2, + the rollback revision)
  const after = (await body(await jreq("/notes/n_med/revisions", owner))).revisions;
  assert.equal(after.length, 3);
  assert.equal(after[0].origin, "rollback");

  // a plain member without the publish power cannot roll back
  const stranger = await jreq("/notes/n_med/rollback", cookieFor("stranger@test.local"), "POST", { revision: v2rev.id });
  assert.equal(stranger.status, 403);
});

test("sign-off eligibility is scoped to the note's tags", async () => {
  fv.put({ id: "n_food", content: "x", tags: ["food"] });
  await bootstrapContentCommons();

  const open = await jreq("/content/propose", cookieFor("g1@test.local"), "POST", { action: "edit_note", target: "n_food", content: "y" });
  const { id } = await body(open);

  // g1 is a gardener of #medicine, not #food → cannot sign off here
  const vote = await jreq(`/proposals/${id}/vote`, cookieFor("g1@test.local"), "POST", { vote: "approve" });
  assert.equal(vote.status, 403);
  assert.equal((await body(vote)).error, "ineligible");
});

// ── new_entry ───────────────────────────────────────────────────────────────────

test("a staged new entry goes live only at the explicit publish step (approval ≠ publishing)", async () => {
  await bootstrapContentCommons();
  const owner = cookieFor(OWNER);
  const g1 = cookieFor("g1@test.local");

  const open = await jreq("/content/propose", g1, "POST", {
    action: "new_entry",
    tags: ["medicine"],
    path: "medicine/yarrow",
    content: "# Yarrow\nStub for a gardener to fill in.",
  });
  assert.equal(open.status, 201);
  const { id } = await body(open);

  // publish before approval → refused
  assert.equal((await jreq(`/proposals/${id}/publish`, g1, "POST")).status, 409);

  assert.equal((await jreq(`/proposals/${id}/vote`, g1, "POST", { vote: "approve" })).status, 200);
  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor("g2@test.local"), "POST", { vote: "approve" })).status, 200);
  const applied = await jreq(`/proposals/${id}/apply`, owner, "POST");
  assert.equal(applied.status, 200);
  const res = await body(applied);
  assert.equal(res.applied, "new_entry");
  assert.equal(res.published, false); // APPROVED + STAGED — not live

  // the LIVE note does not exist yet (the snapshot lives only in a
  // governance-revision note, which is not tagged medicine)
  const liveYarrow = () =>
    [...fv.notes.values()].find((n) => (n.tags ?? []).includes("medicine") && n.content.startsWith("# Yarrow"));
  assert.ok(!liveYarrow(), "staged entry must not be live");

  // a member WITHOUT the publish power cannot publish
  assert.equal((await jreq(`/proposals/${id}/publish`, cookieFor("stranger@test.local"), "POST")).status, 403);

  // a gardener (publish power, in-scope via the proposed tags) publishes → live
  const pub = await jreq(`/proposals/${id}/publish`, g1, "POST");
  assert.equal(pub.status, 200);
  const created = liveYarrow();
  assert.ok(created, "the entry is live after publish");

  // publishing twice → refused (proposal is applied now)
  assert.equal((await jreq(`/proposals/${id}/publish`, g1, "POST")).status, 409);
});

test("edit_note requires a target note id", async () => {
  await bootstrapContentCommons();
  const r = await jreq("/content/propose", cookieFor("g1@test.local"), "POST", { action: "edit_note", content: "x" });
  assert.equal(r.status, 400);
});
