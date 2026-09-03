/**
 * "Review requested" notifications (P4) — the pure eligible-voter set, and the
 * route wiring around it.
 *
 * Two things are worth pinning here, and they pull in opposite directions:
 *
 *  - WHO gets told must be exactly who could decide it. `eligibleVoters` is the
 *    same computation `evaluateProposal` counts approvals from, minus the
 *    proposer — so it is tested against the same scope/expiry edge cases: a
 *    tag-scoped role does not get mail about another tag's notes, an expired
 *    membership gets nothing, and nobody is mailed twice.
 *  - DELIVERY must never matter to the request. The route tests stub the sender
 *    (including one that throws on every address) and assert the proposal is
 *    created, the response is clean, and the failure never surfaces.
 *
 * No real email is ever sent: the sender is stubbed, and the test env has no
 * RESEND_API_KEY, so even the unstubbed path is a console line.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { governance } from "../src/routes/governance";
import {
  eligibleVoters,
  type GovernanceState,
  type GovernanceConfig,
  type Policy,
  type Role,
} from "../src/governance";
import {
  MAX_RECIPIENTS,
  notificationSubject,
  setNotifySender,
  settleNotifications,
  type NotifySender,
} from "../src/governance-notify";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

// ── fixtures (mirrors governance.test.ts) ────────────────────────────────────

const NOW = Date.parse("2026-07-10T00:00:00Z");

const config = (over: Partial<GovernanceConfig> = {}): GovernanceConfig => ({
  enabled: false,
  bootstrapOwner: "owner@x.co",
  amendPolicy: "pol-amend",
  defaultThresholdN: 1,
  defaultEligibleRole: "gardener",
  ...over,
});

const role = (over: Partial<Role> = {}): Role => ({
  id: "r-gardener",
  name: "gardener",
  powers: [],
  scopeType: "global",
  scope: "",
  capabilities: [],
  assigns: [],
  ...over,
});

const policy = (over: Partial<Policy> = {}): Policy => ({
  id: "p",
  action: "edit_note",
  scopeType: "global",
  scope: "",
  thresholdN: 2,
  quorum: 0,
  distinctRequired: true,
  eligibleRole: "gardener",
  windowSeconds: 0,
  autoPublish: false,
  ...over,
});

const state = (over: Partial<GovernanceState> = {}): GovernanceState => ({
  config: config(),
  roles: [],
  memberships: [],
  policies: [],
  ...over,
});

// ── eligibleVoters (pure) ────────────────────────────────────────────────────

test("eligibleVoters: the holders of the policy's role, minus the proposer", () => {
  const s = state({
    roles: [role()],
    memberships: [
      { subject: "a@x.co", role: "gardener" },
      { subject: "b@x.co", role: "gardener" },
      { subject: "c@x.co", role: "gardener" },
    ],
  });
  assert.deepEqual(eligibleVoters(s, policy(), {}, "b@x.co", NOW), ["a@x.co", "c@x.co"]);
});

test("eligibleVoters: the proposer is excluded case-insensitively", () => {
  const s = state({
    roles: [role()],
    memberships: [{ subject: "Ada@X.co", role: "gardener" }, { subject: "b@x.co", role: "gardener" }],
  });
  assert.deepEqual(eligibleVoters(s, policy(), {}, "ada@x.co", NOW), ["b@x.co"]);
});

test("eligibleVoters: someone holding the role twice is notified once", () => {
  const s = state({
    roles: [role(), role({ id: "r-2", name: "gardener" })],
    memberships: [
      { subject: "a@x.co", role: "gardener" },
      { subject: "a@x.co", role: "r-2" },
    ],
  });
  assert.deepEqual(eligibleVoters(s, policy(), {}, "", NOW), ["a@x.co"]);
});

test("eligibleVoters: a tag-scoped role is only notified inside its tag", () => {
  const s = state({
    roles: [role({ id: "r-med", name: "gardener", scopeType: "tag", scope: "medicine" })],
    memberships: [{ subject: "a@x.co", role: "gardener" }],
  });
  assert.deepEqual(eligibleVoters(s, policy(), { tags: ["medicine"] }, "", NOW), ["a@x.co"]);
  assert.deepEqual(eligibleVoters(s, policy(), { tags: ["watershed"] }, "", NOW), []);
});

test("eligibleVoters: expired memberships and unknown roles yield nobody", () => {
  const expired = state({
    roles: [role()],
    memberships: [{ subject: "a@x.co", role: "gardener", expiresAt: "2026-01-01T00:00:00Z" }],
  });
  assert.deepEqual(eligibleVoters(expired, policy(), {}, "", NOW), []);

  const noRole = state({ roles: [], memberships: [{ subject: "a@x.co", role: "gardener" }] });
  assert.deepEqual(eligibleVoters(noRole, policy(), {}, "", NOW), []);
});

test("eligibleVoters: a policy with no eligible role notifies nobody", () => {
  const s = state({ roles: [role()], memberships: [{ subject: "a@x.co", role: "gardener" }] });
  assert.deepEqual(eligibleVoters(s, policy({ eligibleRole: "" }), {}, "", NOW), []);
});

test("MAX_RECIPIENTS caps the fan-out at 50", () => {
  assert.equal(MAX_RECIPIENTS, 50);
});

test("the subject line names the action and the target", () => {
  const subject = notificationSubject({
    id: "p1",
    action: "edit_note",
    target: "n1",
    state: "open",
    openedBy: "a@x.co",
    openedAt: new Date().toISOString(),
  });
  assert.equal(subject, "[Prism] Review requested: edit_note — n1");
});

// ── the routes (stubbed sender) ──────────────────────────────────────────────

let fv: FakeVault;
let sent: Array<{ to: string; subject: string; html: string }>;

const stub: NotifySender = async (to, subject, html) => {
  sent.push({ to, subject, html });
  return true;
};

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  sent = [];
  setNotifySender(stub);
});
afterEach(() => {
  setNotifySender(null);
  fv.restore();
});

const OWNER = "owner@test.local";
const cookieFor = (e: string) => sessionCookie(makeSession(e));

function jreq(path: string, cookie: string | undefined, method = "GET", payload?: unknown) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("content-type", "application/json");
  return governance.request(path, { method, headers, body: payload !== undefined ? JSON.stringify(payload) : undefined });
}

/** A commons where gardeners decide #medicine edits, with three of them. */
async function seedCommons(): Promise<void> {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardener", powers: ["publish"], capabilities: ["view", "edit"] });
  await jreq("/policies", owner, "POST", {
    action: "edit_note",
    scopeType: "tag",
    scope: "medicine",
    thresholdN: 2,
    eligibleRole: "gardener",
  });
  for (const g of ["g1@test.local", "g2@test.local", OWNER]) {
    await jreq("/memberships", owner, "POST", { subject: g, role: "gardener" });
  }
}

test("a content proposal notifies the eligible gardeners, not the proposer", async () => {
  await seedCommons();
  fv.put({ id: "n1", content: "old", tags: ["medicine"] });

  const r = await jreq("/content/propose", cookieFor("g1@test.local"), "POST", {
    action: "edit_note",
    target: "n1",
    content: "new text",
  });
  assert.equal(r.status, 201);
  await settleNotifications();

  assert.deepEqual(
    sent.map((s) => s.to).sort(),
    ["g2@test.local", OWNER].sort(),
    "every other gardener is told; the proposer is not",
  );
  assert.match(sent[0]!.subject, /Review requested: edit_note/);
  // The body carries the rule in the constitution's own words + the arithmetic.
  assert.match(sent[0]!.html, /Edits to notes tagged #medicine need 2 approvals from Gardeners/);
  assert.match(sent[0]!.html, /needs <strong>2<\/strong> approvals/);
  assert.match(sent[0]!.html, /\/governance/);
});

test("a proposal outside the role's tag scope notifies nobody", async () => {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", {
    name: "gardener",
    scopeType: "tag",
    scope: "medicine",
    capabilities: ["view"],
  });
  await jreq("/policies", owner, "POST", { action: "edit_note", thresholdN: 1, eligibleRole: "gardener" });
  await jreq("/memberships", owner, "POST", { subject: "g1@test.local", role: "gardener" });
  fv.put({ id: "n2", content: "old", tags: ["watershed"] });

  const r = await jreq("/content/propose", cookieFor(OWNER), "POST", {
    action: "edit_note",
    target: "n2",
    content: "new",
  });
  assert.equal(r.status, 201);
  await settleNotifications();
  assert.deepEqual(sent, [], "a gardener-of-#medicine is not asked to review a #watershed edit");
});

test("an amendment notifies the constitutional voters", async () => {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "steward", powers: ["amend_governance"] });
  const pol = await jreq("/policies", owner, "POST", {
    action: "amend_governance",
    thresholdN: 1,
    eligibleRole: "steward",
  });
  const amendPolicy = ((await pol.json()) as { note: { id: string } }).note.id;
  await jreq("/memberships", owner, "POST", { subject: "s1@test.local", role: "steward" });
  await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, amendPolicy, defaultEligibleRole: "steward" });

  const r = await jreq("/proposals", cookieFor(OWNER), "POST", {
    action: "amend_governance",
    target: "governance-config",
    payload: JSON.stringify({ kind: "add_role", role: { name: "gardener" } }),
  });
  assert.equal(r.status, 201);
  await settleNotifications();
  assert.deepEqual(sent.map((s) => s.to), ["s1@test.local"]);
});

test("a sender that throws never reaches the response, and the proposal still stands", async () => {
  await seedCommons();
  fv.put({ id: "n1", content: "old", tags: ["medicine"] });
  const attempts: string[] = [];
  setNotifySender(async (to) => {
    attempts.push(to);
    throw new Error("smtp is on fire");
  });

  const r = await jreq("/content/propose", cookieFor("g1@test.local"), "POST", {
    action: "edit_note",
    target: "n1",
    content: "new text",
  });
  assert.equal(r.status, 201, "delivery failure must not fail the request");
  const body = (await r.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.ok(typeof body.id === "string" && body.id.length > 0);
  assert.ok(!("error" in body) && !("email" in body), "nothing about delivery leaks into the response");

  await settleNotifications();
  assert.equal(attempts.length, 2, "one bad address does not silence the rest — each is attempted");

  // The proposal is durable regardless.
  const list = (await (await jreq("/proposals", cookieFor(OWNER))).json()) as { proposals: Array<{ id: string }> };
  assert.equal(list.proposals.length, 1);
});
