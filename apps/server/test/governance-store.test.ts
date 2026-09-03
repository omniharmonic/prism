/**
 * The governance store seam — notes ⇄ engine structures. Verifies defensive
 * coercion of untrusted note metadata, parse(serialize(x)) round-trips, and
 * loadState assembly over a fake in-memory vault (no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "../src/parachute";
import {
  GOV_TAGS,
  parseConfig,
  parseRole,
  parseMembership,
  parsePolicy,
  parseProposal,
  parseVote,
  roleToMetadata,
  membershipToMetadata,
  policyToMetadata,
  proposalToMetadata,
  voteToMetadata,
  loadState,
  loadVotesFor,
  disabledConfig,
  type GovernanceVault,
} from "../src/governance-store";
import type { Membership, Policy, Proposal, Role, Vote } from "../src/governance";

const note = (id: string, tags: string[], metadata: Record<string, unknown>): Note => ({
  id,
  content: "",
  path: null,
  metadata,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
  tags,
});

/** A fake vault: in-memory notes, tag-any filtering, newest-first (like the real listNotes). */
function fakeVault(notes: Note[]): GovernanceVault {
  return {
    async listNotes({ tags }) {
      const want = new Set(tags ?? []);
      const match = notes.filter((n) => (n.tags ?? []).some((t) => want.has(t)));
      return [...match].reverse(); // simulate sort: desc (newest-first) — later pushes win
    },
  };
}

// ── defensive coercion ────────────────────────────────────────────────────────

test("parsePolicy coerces string metadata and clamps to safe defaults", () => {
  const p = parsePolicy(
    note("pol1", [GOV_TAGS.policy], {
      action: "edit_note",
      scope_type: "tag",
      scope: "medicine",
      threshold_n: "3", // string → number
      quorum: "2",
      distinct_required: "true", // string → boolean
      eligible_role: "gardener",
      window_seconds: "0",
      auto_publish: false,
    }),
  );
  assert.equal(p.id, "pol1");
  assert.equal(p.thresholdN, 3);
  assert.equal(p.quorum, 2);
  assert.equal(p.distinctRequired, true);
  assert.equal(p.scopeType, "tag");
});

test("parsePolicy with a missing threshold degrades to 1 (never 0)", () => {
  const p = parsePolicy(note("pol2", [GOV_TAGS.policy], { action: "edit_note" }));
  assert.equal(p.thresholdN, 1);
  assert.equal(p.distinctRequired, true);
});

test("parseRole keeps only recognized powers and defaults scope", () => {
  const r = parseRole(
    note("role1", [GOV_TAGS.role], { name: "gardener", powers: ["review", "not_a_power", "publish"] }),
  );
  assert.deepEqual(r.powers, ["review", "publish"]);
  assert.equal(r.scopeType, "global");
  assert.equal(r.name, "gardener");
});

test("parseConfig reads the bootstrap lock and defaults to disabled", () => {
  assert.equal(parseConfig(note("c", [GOV_TAGS.config], {})).enabled, false);
  const c = parseConfig(note("c", [GOV_TAGS.config], { enabled: true, bootstrap_owner: "o@x.co", amend_policy: "pa" }));
  assert.equal(c.enabled, true);
  assert.equal(c.bootstrapOwner, "o@x.co");
  assert.equal(c.amendPolicy, "pa");
});

// ── round-trips (parse ∘ serialize = id) ──────────────────────────────────────

test("role round-trips through metadata", () => {
  const r: Role = { id: "role-x", name: "steward", powers: ["review", "publish"], scopeType: "tag", scope: "watershed" };
  const back = parseRole(note("role-x", [GOV_TAGS.role], roleToMetadata(r)));
  assert.deepEqual(back, r);
});

test("membership round-trips through metadata", () => {
  const m: Membership = { subject: "a@x.co", role: "role-x", grantedBy: "o@x.co", expiresAt: "2026-12-01T00:00:00Z" };
  assert.deepEqual(parseMembership(note("m", [GOV_TAGS.membership], membershipToMetadata(m))), m);
});

test("policy round-trips through metadata", () => {
  const p: Policy = {
    id: "pol-x",
    action: "amend_governance",
    scopeType: "global",
    scope: "",
    thresholdN: 3,
    quorum: 5,
    distinctRequired: true,
    eligibleRole: "admin",
    windowSeconds: 604800,
    autoPublish: false,
  };
  assert.deepEqual(parsePolicy(note("pol-x", [GOV_TAGS.policy], policyToMetadata(p))), p);
});

test("proposal and vote round-trip through metadata", () => {
  const p: Proposal = { id: "prop-x", action: "edit_note", target: "n1", state: "open", openedBy: "a@x.co", openedAt: "2026-07-01T00:00:00Z" };
  assert.deepEqual(parseProposal(note("prop-x", [GOV_TAGS.proposal], proposalToMetadata(p))), p);
  const v: Vote = { proposal: "prop-x", voter: "g1@x.co", vote: "approve", at: "2026-07-01T01:00:00Z" };
  assert.deepEqual(parseVote(note("v", [GOV_TAGS.vote], voteToMetadata(v))), v);
});

// ── loadState assembly ────────────────────────────────────────────────────────

test("loadState assembles config + roles + memberships + policies", async () => {
  const vault = fakeVault([
    note("cfg", [GOV_TAGS.config], { enabled: true, bootstrap_owner: "o@x.co", amend_policy: "pol-amend" }),
    note("role-g", [GOV_TAGS.role], { name: "gardener", powers: ["review"] }),
    note("mem-1", [GOV_TAGS.membership], { subject: "g1@x.co", role: "role-g" }),
    note("pol-amend", [GOV_TAGS.policy], { action: "amend_governance", threshold_n: 3, eligible_role: "admin" }),
  ]);
  const s = await loadState(vault);
  assert.equal(s.config.enabled, true);
  assert.equal(s.config.bootstrapOwner, "o@x.co");
  assert.equal(s.roles.length, 1);
  assert.equal(s.roles[0]!.name, "gardener");
  assert.equal(s.memberships[0]!.subject, "g1@x.co");
  assert.equal(s.policies[0]!.action, "amend_governance");
});

test("loadState with no config note → disabled with the fallback owner", async () => {
  const s = await loadState(fakeVault([]), { fallbackOwner: "root@x.co" });
  assert.equal(s.config.enabled, false);
  assert.equal(s.config.bootstrapOwner, "root@x.co");
  assert.deepEqual(disabledConfig("root@x.co"), s.config);
});

test("loadVotesFor returns only votes for the given proposal", async () => {
  const vault = fakeVault([
    note("v1", [GOV_TAGS.vote], { proposal: "prop-a", voter: "g1@x.co", vote: "approve", at: "2026-07-01T01:00:00Z" }),
    note("v2", [GOV_TAGS.vote], { proposal: "prop-b", voter: "g2@x.co", vote: "approve", at: "2026-07-01T02:00:00Z" }),
    note("v3", [GOV_TAGS.vote], { proposal: "prop-a", voter: "g3@x.co", vote: "reject", at: "2026-07-01T03:00:00Z" }),
  ]);
  const votes = await loadVotesFor(vault, "prop-a");
  assert.equal(votes.length, 2);
  assert.deepEqual(votes.map((v) => v.voter).sort(), ["g1@x.co", "g3@x.co"]);
});
