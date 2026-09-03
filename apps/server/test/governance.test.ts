/**
 * The governance algebra — the commons's second pure guard. Roles/powers,
 * scope-aware resolution, policy selection, proposal evaluation (distinct
 * approvers / quorum / window / eligibility), and the bootstrap lock are tested
 * here in isolation, exactly as permissions.test.ts covers effectiveLevel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POWERS,
  membershipActive,
  roleApplies,
  rolesForSubject,
  powersForSubject,
  hasPower,
  subjectHoldsRole,
  selectPolicy,
  defaultPolicy,
  requiredPolicy,
  evaluateProposal,
  evaluateAmendment,
  isLocked,
  canMutateGovernanceDirectly,
  type GovernanceState,
  type GovernanceConfig,
  type Role,
  type Policy,
  type Proposal,
  type Vote,
} from "../src/governance";

const T0 = Date.parse("2026-07-01T00:00:00Z"); // proposal open time
const NOW = Date.parse("2026-07-10T00:00:00Z"); // "now" for expiry checks
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const config = (over: Partial<GovernanceConfig> = {}): GovernanceConfig => ({
  enabled: false,
  bootstrapOwner: "owner@x.co",
  amendPolicy: "pol-amend",
  defaultThresholdN: 1,
  defaultEligibleRole: "gardener",
  ...over,
});

const role = (over: Partial<Role>): Role => ({
  id: "r",
  name: "gardener",
  powers: ["review"],
  scopeType: "global",
  scope: "",
  ...over,
});

const policy = (over: Partial<Policy>): Policy => ({
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

const vote = (voter: string, v: "approve" | "reject", minute: number, proposal = "prop"): Vote => ({
  proposal,
  voter,
  vote: v,
  at: at(minute),
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "prop",
  action: "edit_note",
  target: "n1",
  state: "open",
  openedBy: "alice@x.co",
  openedAt: at(0),
  ...over,
});

// ── powers & roles ────────────────────────────────────────────────────────────

test("POWERS includes the constitutional amend power", () => {
  assert.ok(POWERS.includes("amend_governance"));
  assert.ok(POWERS.includes("review"));
});

test("membershipActive: no expiry = forever; past expiry = inactive", () => {
  assert.equal(membershipActive({ subject: "a", role: "r" }, NOW), true);
  assert.equal(membershipActive({ subject: "a", role: "r", expiresAt: "" }, NOW), true);
  assert.equal(membershipActive({ subject: "a", role: "r", expiresAt: "2026-08-01T00:00:00Z" }, NOW), true);
  assert.equal(membershipActive({ subject: "a", role: "r", expiresAt: "2026-06-01T00:00:00Z" }, NOW), false);
});

test("roleApplies: global always; tag-scoped only within its tag", () => {
  assert.equal(roleApplies(role({ scopeType: "global" }), { tags: [] }), true);
  const g = role({ scopeType: "tag", scope: "watershed" });
  assert.equal(roleApplies(g, { tags: ["watershed", "x"] }), true);
  assert.equal(roleApplies(g, { tags: ["species"] }), false);
  assert.equal(roleApplies(g, {}), false);
});

test("rolesForSubject resolves memberships by id or name and skips expired", () => {
  const s = state({
    roles: [role({ id: "r1", name: "gardener" }), role({ id: "r2", name: "steward", powers: ["publish"] })],
    memberships: [
      { subject: "a@x.co", role: "r1" }, // by id
      { subject: "a@x.co", role: "steward" }, // by name
      { subject: "a@x.co", role: "r2", expiresAt: "2026-06-01T00:00:00Z" }, // expired dup, ignored
      { subject: "b@x.co", role: "r1" },
    ],
  });
  const names = rolesForSubject(s, "a@x.co", {}, NOW).map((r) => r.name).sort();
  assert.deepEqual(names, ["gardener", "steward"]);
});

test("tag-scoped power is only exercisable within that tag", () => {
  const s = state({
    roles: [role({ id: "r1", name: "watershed-gardener", powers: ["review"], scopeType: "tag", scope: "watershed" })],
    memberships: [{ subject: "a@x.co", role: "r1" }],
  });
  assert.equal(hasPower(s, "a@x.co", "review", { tags: ["watershed"] }, NOW), true);
  assert.equal(hasPower(s, "a@x.co", "review", { tags: ["species"] }, NOW), false);
  assert.deepEqual([...powersForSubject(s, "a@x.co", { tags: ["species"] }, NOW)], []);
});

test("subjectHoldsRole is scope-aware and false for the empty role", () => {
  const s = state({
    roles: [role({ id: "r1", name: "gardener" })],
    memberships: [{ subject: "a@x.co", role: "r1" }],
  });
  assert.equal(subjectHoldsRole(s, "a@x.co", "gardener", {}, NOW), true);
  assert.equal(subjectHoldsRole(s, "a@x.co", "admin", {}, NOW), false);
  assert.equal(subjectHoldsRole(s, "a@x.co", "", {}, NOW), false);
});

// ── policy selection ──────────────────────────────────────────────────────────

test("selectPolicy: most specific wins (note > tag > global)", () => {
  const s = state({
    policies: [
      policy({ id: "g", scopeType: "global", thresholdN: 1 }),
      policy({ id: "t", scopeType: "tag", scope: "medicine", thresholdN: 3 }),
      policy({ id: "n", scopeType: "note", scope: "n1", thresholdN: 5 }),
    ],
  });
  assert.equal(selectPolicy(s, "edit_note", { noteId: "n1", tags: ["medicine"] })?.id, "n");
  assert.equal(selectPolicy(s, "edit_note", { noteId: "other", tags: ["medicine"] })?.id, "t");
  assert.equal(selectPolicy(s, "edit_note", { noteId: "other", tags: ["x"] })?.id, "g");
  assert.equal(selectPolicy(s, "publish", { tags: ["x"] }), null); // no policy for action
});

test("selectPolicy tie-break: same specificity → stricter (higher thresholdN) wins", () => {
  const s = state({
    policies: [
      policy({ id: "lax", scopeType: "tag", scope: "medicine", thresholdN: 2 }),
      policy({ id: "strict", scopeType: "tag", scope: "medicine", thresholdN: 4 }),
    ],
  });
  assert.equal(selectPolicy(s, "edit_note", { tags: ["medicine"] })?.id, "strict");
});

test("requiredPolicy falls back to the config default and inherits eligibleRole", () => {
  const s = state({ config: config({ defaultThresholdN: 2, defaultEligibleRole: "steward" }) });
  const p = requiredPolicy(s, "edit_note", { tags: ["x"] });
  assert.equal(p.thresholdN, 2);
  assert.equal(p.eligibleRole, "steward");
  // a matching policy with an empty eligibleRole inherits the config default
  const s2 = state({
    config: config({ defaultEligibleRole: "steward" }),
    policies: [policy({ id: "p1", eligibleRole: "", thresholdN: 3 })],
  });
  assert.equal(requiredPolicy(s2, "edit_note", {}).eligibleRole, "steward");
});

test("requiredPolicy(amend_governance) always uses the constitution's amend_policy", () => {
  const s = state({
    config: config({ amendPolicy: "pol-amend" }),
    policies: [
      policy({ id: "pol-amend", action: "amend_governance", thresholdN: 4, eligibleRole: "admin" }),
      policy({ id: "decoy", action: "amend_governance", scopeType: "note", scope: "governance-config", thresholdN: 1 }),
    ],
  });
  const p = requiredPolicy(s, "amend_governance", { noteId: "governance-config" });
  assert.equal(p.id, "pol-amend");
  assert.equal(p.thresholdN, 4);
});

test("defaultPolicy is safe: at least 1 approval, distinct required", () => {
  const p = defaultPolicy(config({ defaultThresholdN: 0 }), "edit_note");
  assert.equal(p.thresholdN, 1);
  assert.equal(p.distinctRequired, true);
});

// ── proposal evaluation ───────────────────────────────────────────────────────

const govWithGardeners = (extra: Partial<GovernanceState> = {}) =>
  state({
    roles: [role({ id: "rg", name: "gardener", powers: ["review"] })],
    memberships: [
      { subject: "g1@x.co", role: "rg" },
      { subject: "g2@x.co", role: "rg" },
      { subject: "g3@x.co", role: "rg" },
    ],
    policies: [policy({ id: "p1", thresholdN: 2, eligibleRole: "gardener" })],
    ...extra,
  });

test("evaluateProposal: two distinct eligible approvals meet a threshold of 2", () => {
  const s = govWithGardeners();
  const ev = evaluateProposal(s, proposal(), [vote("g1@x.co", "approve", 1), vote("g2@x.co", "approve", 2)], { tags: [] }, NOW);
  assert.equal(ev.satisfied, true);
  assert.equal(ev.approvals, 2);
  assert.equal(ev.needed, 2);
});

test("evaluateProposal: distinct_required dedups repeat votes from one approver", () => {
  const s = govWithGardeners();
  const ev = evaluateProposal(s, proposal(), [vote("g1@x.co", "approve", 1), vote("g1@x.co", "approve", 2)], {}, NOW);
  assert.equal(ev.approvals, 1);
  assert.equal(ev.satisfied, false);
});

test("evaluateProposal: ineligible (non-role) voters are ignored", () => {
  const s = govWithGardeners();
  const ev = evaluateProposal(
    s,
    proposal(),
    [vote("g1@x.co", "approve", 1), vote("random@x.co", "approve", 2)],
    {},
    NOW,
  );
  assert.equal(ev.approvals, 1);
  assert.equal(ev.satisfied, false);
});

test("evaluateProposal: reject votes never count as approvals but do count for quorum", () => {
  const s = govWithGardeners({ policies: [policy({ id: "p1", thresholdN: 1, quorum: 3, eligibleRole: "gardener" })] });
  const ev = evaluateProposal(
    s,
    proposal(),
    [vote("g1@x.co", "approve", 1), vote("g2@x.co", "reject", 2), vote("g3@x.co", "reject", 3)],
    {},
    NOW,
  );
  assert.equal(ev.approvals, 1);
  assert.equal(ev.participation, 3);
  assert.equal(ev.quorumMet, true);
  assert.equal(ev.satisfied, true); // threshold 1 met AND quorum 3 met
});

test("evaluateProposal: quorum not met blocks an otherwise-passing proposal", () => {
  const s = govWithGardeners({ policies: [policy({ id: "p1", thresholdN: 1, quorum: 3, eligibleRole: "gardener" })] });
  const ev = evaluateProposal(s, proposal(), [vote("g1@x.co", "approve", 1)], {}, NOW);
  assert.equal(ev.quorumMet, false);
  assert.equal(ev.satisfied, false);
});

test("evaluateProposal: votes outside the window are dropped", () => {
  const s = govWithGardeners({
    policies: [policy({ id: "p1", thresholdN: 2, windowSeconds: 3600, eligibleRole: "gardener" })],
  });
  // window is 60 minutes from openedAt(at(0)); the second vote lands at minute 90
  const ev = evaluateProposal(s, proposal(), [vote("g1@x.co", "approve", 10), vote("g2@x.co", "approve", 90)], {}, NOW);
  assert.equal(ev.approvals, 1);
  assert.equal(ev.satisfied, false);
});

test("evaluateProposal: tag-scoped eligibility respects the proposal context", () => {
  const s = state({
    roles: [role({ id: "rw", name: "gardener", powers: ["review"], scopeType: "tag", scope: "watershed" })],
    memberships: [
      { subject: "g1@x.co", role: "rw" },
      { subject: "g2@x.co", role: "rw" },
    ],
    policies: [policy({ id: "p1", thresholdN: 2, eligibleRole: "gardener" })],
  });
  const votes = [vote("g1@x.co", "approve", 1), vote("g2@x.co", "approve", 2)];
  assert.equal(evaluateProposal(s, proposal(), votes, { tags: ["watershed"] }, NOW).satisfied, true);
  assert.equal(evaluateProposal(s, proposal(), votes, { tags: ["species"] }, NOW).satisfied, false);
});

// ── the bootstrap lock ────────────────────────────────────────────────────────

test("isLocked reflects config.enabled", () => {
  assert.equal(isLocked(config({ enabled: false })), false);
  assert.equal(isLocked(config({ enabled: true })), true);
});

test("canMutateGovernanceDirectly: only the bootstrap owner, only while unlocked", () => {
  const unlocked = state({ config: config({ enabled: false, bootstrapOwner: "owner@x.co" }) });
  const locked = state({ config: config({ enabled: true, bootstrapOwner: "owner@x.co" }) });
  assert.equal(canMutateGovernanceDirectly(unlocked, "owner@x.co"), true);
  assert.equal(canMutateGovernanceDirectly(unlocked, "someone@x.co"), false);
  // once ratified, NOBODY may edit governance out of band — not even the owner
  assert.equal(canMutateGovernanceDirectly(locked, "owner@x.co"), false);
});

test("evaluateAmendment: disabling governance requires clearing the amend policy", () => {
  const s = state({
    config: config({ enabled: true, amendPolicy: "pol-amend" }),
    roles: [role({ id: "ra", name: "admin", powers: ["amend_governance"] })],
    memberships: [
      { subject: "a1@x.co", role: "ra" },
      { subject: "a2@x.co", role: "ra" },
      { subject: "a3@x.co", role: "ra" },
    ],
    policies: [policy({ id: "pol-amend", action: "amend_governance", thresholdN: 3, distinctRequired: true, eligibleRole: "admin" })],
  });
  const disable = proposal({ id: "prop", action: "amend_governance", target: "governance-config" });
  const twoAdmins = [vote("a1@x.co", "approve", 1), vote("a2@x.co", "approve", 2)];
  assert.equal(evaluateAmendment(s, disable, twoAdmins, NOW).satisfied, false); // 2 of 3 — not enough
  const threeAdmins = [...twoAdmins, vote("a3@x.co", "approve", 3)];
  assert.equal(evaluateAmendment(s, disable, threeAdmins, NOW).satisfied, true); // constitutional threshold cleared
});
