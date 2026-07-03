/**
 * The governance routes — full-stack through the real Hono `governance` app with
 * a faked vault. The invariants under test are the ones the owner's decisions
 * demand: governance is inert until enabled; while unlocked only the bootstrap
 * owner configures; the instant it is enabled the lock engages so NObody —
 * including the owner — can edit or disable it out of band; and an amendment
 * takes effect only when its votes clear the constitutional threshold.
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

/** Bootstrap an enabled commons: an admin role, an amend policy (2 distinct
 *  admins), three admins, then flip `enabled`. Returns the amend policy id. */
async function bootstrapEnabled(): Promise<string> {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "admin", powers: ["amend_governance", "review"] });
  const polRes = await jreq("/policies", owner, "POST", {
    action: "amend_governance",
    thresholdN: 2,
    distinctRequired: true,
    eligibleRole: "admin",
  });
  const { note } = await body(polRes);
  const amendPolicy = note.id as string;
  for (const a of ["a1@test.local", "a2@test.local", "a3@test.local"]) {
    await jreq("/memberships", owner, "POST", { subject: a, role: "admin" });
  }
  const cfg = await jreq("/config", owner, "POST", {
    enabled: true,
    bootstrapOwner: OWNER,
    amendPolicy,
    defaultEligibleRole: "admin",
  });
  assert.equal(cfg.status, 200);
  return amendPolicy;
}

// ── inert + auth ────────────────────────────────────────────────────────────

test("anonymous requests are unauthorized", async () => {
  assert.equal((await jreq("/state", undefined)).status, 401);
});

test("before enablement, state is disabled and the owner is the bootstrap root", async () => {
  const r = await jreq("/state", cookieFor(OWNER));
  assert.equal(r.status, 200);
  const s = await body(r);
  assert.equal(s.enabled, false);
  assert.equal(s.locked, false);
  assert.equal(s.isBootstrapOwner, true);
});

// ── bootstrap while unlocked ──────────────────────────────────────────────────

test("while unlocked, only the bootstrap owner may configure", async () => {
  // owner can create a role
  assert.equal((await jreq("/roles", cookieFor(OWNER), "POST", { name: "gardener", powers: ["review"] })).status, 200);
  // a non-owner cannot bootstrap
  const r = await jreq("/roles", cookieFor("stranger@test.local"), "POST", { name: "x", powers: [] });
  assert.equal(r.status, 403);
  assert.equal((await body(r)).error, "forbidden");
});

test("owner bootstrap seeds roles + policies visible in state", async () => {
  await bootstrapEnabled();
  const s = await body(await jreq("/state", cookieFor(OWNER)));
  assert.ok(s.roles.some((r: { name: string }) => r.name === "admin"));
  assert.ok(s.policies.some((p: { action: string }) => p.action === "amend_governance"));
});

// ── the bootstrap lock (the headline guarantee) ───────────────────────────────

test("enabling engages the lock: state reports locked, owner is no longer bootstrap root", async () => {
  await bootstrapEnabled();
  const s = await body(await jreq("/state", cookieFor(OWNER)));
  assert.equal(s.enabled, true);
  assert.equal(s.locked, true);
  assert.equal(s.isBootstrapOwner, false);
});

test("once locked, even the OWNER cannot add a role directly", async () => {
  await bootstrapEnabled();
  const r = await jreq("/roles", cookieFor(OWNER), "POST", { name: "gardener", powers: ["review"] });
  assert.equal(r.status, 403);
  assert.equal((await body(r)).error, "requires_proposal");
});

test("once locked, even the OWNER cannot disable governance directly", async () => {
  await bootstrapEnabled();
  const r = await jreq("/config", cookieFor(OWNER), "POST", { enabled: false, bootstrapOwner: OWNER });
  assert.equal(r.status, 403);
  assert.equal((await body(r)).error, "requires_proposal");
});

// ── amendment via the constitutional threshold ────────────────────────────────

test("an amendment takes effect only when votes clear the amend threshold", async () => {
  await bootstrapEnabled();
  const owner = cookieFor(OWNER);

  // open a proposal to add a `gardener` role
  const open = await jreq("/proposals", cookieFor("a1@test.local"), "POST", {
    action: "amend_governance",
    target: "governance",
    payload: JSON.stringify({ kind: "add_role", role: { name: "gardener", powers: ["review"], scopeType: "global", scope: "" } }),
  });
  assert.equal(open.status, 201);
  const { id: propId } = await body(open);

  // no approvals yet → apply refused
  assert.equal((await jreq(`/proposals/${propId}/apply`, owner, "POST")).status, 409);

  // one admin approval → still short of threshold 2
  assert.equal((await jreq(`/proposals/${propId}/vote`, cookieFor("a1@test.local"), "POST", { vote: "approve" })).status, 200);
  assert.equal((await jreq(`/proposals/${propId}/apply`, owner, "POST")).status, 409);

  // second distinct admin approval → threshold cleared → applies
  assert.equal((await jreq(`/proposals/${propId}/vote`, cookieFor("a2@test.local"), "POST", { vote: "approve" })).status, 200);
  const applied = await jreq(`/proposals/${propId}/apply`, owner, "POST");
  assert.equal(applied.status, 200);
  assert.equal((await body(applied)).applied, "add_role");

  // the amendment is now live in state
  const s = await body(await jreq("/state", owner));
  assert.ok(s.roles.some((r: { name: string }) => r.name === "gardener"));
});

test("a non-eligible member cannot vote, and no one may vote twice", async () => {
  await bootstrapEnabled();
  const open = await jreq("/proposals", cookieFor("a1@test.local"), "POST", {
    action: "amend_governance",
    target: "governance",
    payload: JSON.stringify({ kind: "add_role", role: { name: "gardener", powers: ["review"] } }),
  });
  const { id: propId } = await body(open);

  // a non-admin cannot vote on an amend_governance proposal
  const bad = await jreq(`/proposals/${propId}/vote`, cookieFor("stranger@test.local"), "POST", { vote: "approve" });
  assert.equal(bad.status, 403);
  assert.equal((await body(bad)).error, "ineligible");

  // an admin votes once → ok; twice → 409
  assert.equal((await jreq(`/proposals/${propId}/vote`, cookieFor("a1@test.local"), "POST", { vote: "approve" })).status, 200);
  assert.equal((await jreq(`/proposals/${propId}/vote`, cookieFor("a1@test.local"), "POST", { vote: "approve" })).status, 409);
});
