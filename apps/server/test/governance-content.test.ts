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

/** Bootstrap an enabled commons: gardeners scoped to #medicine, edit/new
 *  policies on #medicine requiring 2 distinct gardeners, members g1/g2. */
async function bootstrapContentCommons() {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardener", powers: ["review"], scopeType: "tag", scope: "medicine" });
  await jreq("/policies", owner, "POST", { action: "edit_note", scopeType: "tag", scope: "medicine", thresholdN: 2, distinctRequired: true, eligibleRole: "gardener" });
  await jreq("/policies", owner, "POST", { action: "new_entry", scopeType: "tag", scope: "medicine", thresholdN: 2, distinctRequired: true, eligibleRole: "gardener" });
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
  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor("g2@test.local"), "POST", { vote: "approve" })).status, 200);
  const applied = await jreq(`/proposals/${id}/apply`, owner, "POST");
  assert.equal(applied.status, 200);
  assert.equal((await body(applied)).applied, "edit_note");
  assert.equal(fv.notes.get("n_med")!.content, "new");
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

test("a new entry is created only after governed sign-off", async () => {
  await bootstrapContentCommons();
  const owner = cookieFor(OWNER);

  const open = await jreq("/content/propose", cookieFor("g1@test.local"), "POST", {
    action: "new_entry",
    tags: ["medicine"],
    path: "medicine/yarrow",
    content: "# Yarrow\nStub for a gardener to fill in.",
  });
  assert.equal(open.status, 201);
  const { id } = await body(open);

  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor("g1@test.local"), "POST", { vote: "approve" })).status, 200);
  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor("g2@test.local"), "POST", { vote: "approve" })).status, 200);
  const applied = await jreq(`/proposals/${id}/apply`, owner, "POST");
  assert.equal(applied.status, 200);
  assert.equal((await body(applied)).applied, "new_entry");

  // a governed note now exists with the proposed content + tag
  const created = [...fv.notes.values()].find((n) => n.content.startsWith("# Yarrow"));
  assert.ok(created, "the new entry was created");
  assert.ok((created!.tags ?? []).includes("medicine"));
});

test("edit_note requires a target note id", async () => {
  await bootstrapContentCommons();
  const r = await jreq("/content/propose", cookieFor("g1@test.local"), "POST", { action: "edit_note", content: "x" });
  assert.equal(r.status, 400);
});
