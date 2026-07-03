/**
 * The governance algebra — the second pure guard of the commons, a sibling to
 * `permissions.ts`. Where `effectiveLevel` answers "how much may this subject
 * change this note's content", `governance` answers "who may take governance
 * actions, how many sign-offs a change needs before it is real, and whether the
 * commons is locked into governing its own rules".
 *
 * This module is DEPENDENCY-FREE and does no I/O. Governance state lives in the
 * vault as `governance-*` notes (Decision §1 — dogfooded as governed notes); a
 * thin store seam (`governance-store.ts`, not this file) parses those notes into
 * the structures below and this engine computes decisions over them. Keeping the
 * authoritative logic pure means it is unit-tested in isolation exactly like the
 * permission algebra.
 *
 * Two ideas carry the design:
 *  - Three axes kept separate: WHO (roles/memberships), HOW-MANY (policies),
 *    WHAT-STATE (proposals/votes). See docs/roadmap/bioregional-commons-1-governance.md.
 *  - The bootstrap lock (Decision §2): `config.enabled` is a one-way latch. While
 *    false the bootstrap owner configures freely; once true, every governance
 *    mutation — including turning it back off — must ride a proposal that clears
 *    the constitution's own `amend_policy`. The engine exposes `isLocked` and
 *    `canMutateGovernanceDirectly`; the mutation guard consults them so no code
 *    path edits a locked config out of band.
 */

/** Governance powers a role may carry (distinct from content `Level`). */
export const POWERS = [
  "review", // approve/vote on content proposals
  "publish", // move the live/published pointer
  "certify_gardener", // grant lower governance roles
  "manage_policy", // create/edit governance-policy notes
  "arbitrate", // resolve disputes / graduated sanctions
  "invite", // invite new members
  "revoke", // revoke memberships/grants
  "amend_governance", // change or disable governance itself (the constitutional power)
] as const;
export type Power = (typeof POWERS)[number];

export type ScopeType = "global" | "tag" | "note";
export type ProposalState = "open" | "approved" | "rejected" | "applied" | "withdrawn";

/** A named bundle of powers, optionally scoped to a single tag (nested governance). */
export interface Role {
  id: string;
  name: string;
  powers: Power[];
  scopeType: "global" | "tag";
  scope: string; // the tag when scopeType==="tag"; "" for global
}

/** Binds a subject (email) to a role, with optional expiry (term limits/recall). */
export interface Membership {
  subject: string;
  role: string; // matches a Role by id or name
  grantedBy?: string;
  expiresAt?: string | null; // ISO-8601, or null/"" for no expiry
}

/** A collective-choice rule: how many sign-offs, from whom, over what window. */
export interface Policy {
  id: string;
  action: string;
  scopeType: ScopeType;
  scope: string; // tag or note id; "" for global
  thresholdN: number;
  quorum: number; // min participation (distinct eligible voters); 0 = none
  distinctRequired: boolean;
  eligibleRole: string; // role NAME whose members' approvals count; "" → config default
  windowSeconds: number; // approvals must land within this of openedAt; 0 = none
  autoPublish: boolean;
}

/** A pending change awaiting sign-off. */
export interface Proposal {
  id: string;
  action: string;
  target: string; // note id, tag, role id, or "governance-config"
  state: ProposalState;
  openedBy: string;
  openedAt: string; // ISO-8601 (drives the policy window)
}

/** One sign-off on a proposal. */
export interface Vote {
  proposal: string;
  voter: string;
  vote: "approve" | "reject";
  at: string; // ISO-8601
}

/** The constitution (singleton `governance-config` note). */
export interface GovernanceConfig {
  enabled: boolean; // the bootstrap lock
  bootstrapOwner: string; // genesis admin subject
  amendPolicy: string; // policy id governing amend_governance (the constitutional threshold)
  defaultThresholdN: number;
  defaultEligibleRole: string;
}

/** Everything the engine reasons over — assembled by the store from notes. */
export interface GovernanceState {
  config: GovernanceConfig;
  roles: Role[];
  memberships: Membership[];
  policies: Policy[];
}

/** Context for scope-aware resolution: the resource an action touches. */
export interface ActionContext {
  noteId?: string;
  tags?: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

const parseTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Is a membership active at `nowMs` (not expired)? Empty/absent expiry = forever. */
export function membershipActive(m: Membership, nowMs: number): boolean {
  const exp = parseTime(m.expiresAt ?? null);
  return exp === null || exp > nowMs;
}

/** Does a role apply to the given context? Global always; tag-scoped only if the
 *  context carries that tag. */
export function roleApplies(role: Role, ctx: ActionContext = {}): boolean {
  if (role.scopeType === "global") return true;
  return (ctx.tags ?? []).includes(role.scope);
}

const roleMatches = (role: Role, ref: string): boolean => role.id === ref || role.name === ref;

/** The active roles a subject holds that apply to `ctx`. */
export function rolesForSubject(
  state: GovernanceState,
  subject: string,
  ctx: ActionContext = {},
  nowMs = Date.now(),
): Role[] {
  const out: Role[] = [];
  for (const m of state.memberships) {
    if (m.subject !== subject) continue;
    if (!membershipActive(m, nowMs)) continue;
    for (const role of state.roles) {
      if (roleMatches(role, m.role) && roleApplies(role, ctx)) out.push(role);
    }
  }
  return out;
}

/** The union of powers a subject can exercise in `ctx`. */
export function powersForSubject(
  state: GovernanceState,
  subject: string,
  ctx: ActionContext = {},
  nowMs = Date.now(),
): Set<Power> {
  const powers = new Set<Power>();
  for (const role of rolesForSubject(state, subject, ctx, nowMs)) {
    for (const p of role.powers) powers.add(p);
  }
  return powers;
}

export function hasPower(
  state: GovernanceState,
  subject: string,
  power: Power,
  ctx: ActionContext = {},
  nowMs = Date.now(),
): boolean {
  return powersForSubject(state, subject, ctx, nowMs).has(power);
}

/** Does a subject hold a role by NAME (scope-aware)? Used for approval eligibility. */
export function subjectHoldsRole(
  state: GovernanceState,
  subject: string,
  roleName: string,
  ctx: ActionContext = {},
  nowMs = Date.now(),
): boolean {
  if (!roleName) return false;
  return rolesForSubject(state, subject, ctx, nowMs).some((r) => r.name === roleName);
}

/** How specific is a policy for this context? note (3) > tag (2) > global (1);
 *  0 = does not match at all. */
function policySpecificity(p: Policy, action: string, ctx: ActionContext): number {
  if (p.action !== action) return 0;
  if (p.scopeType === "note") return p.scope && p.scope === ctx.noteId ? 3 : 0;
  if (p.scopeType === "tag") return p.scope && (ctx.tags ?? []).includes(p.scope) ? 2 : 0;
  return 1; // global
}

/**
 * Select the governing policy for an action+context. Most-specific wins
 * (note > tag > global); on a tie the STRICTER policy (higher thresholdN) wins,
 * so overlapping rules never weaken the guard. Returns null when nothing matches
 * (callers fall back to the config default via `requiredPolicy`).
 */
export function selectPolicy(
  state: GovernanceState,
  action: string,
  ctx: ActionContext = {},
): Policy | null {
  let best: Policy | null = null;
  let bestRank = 0;
  for (const p of state.policies) {
    const spec = policySpecificity(p, action, ctx);
    if (spec === 0) continue;
    if (spec > bestRank || (spec === bestRank && best !== null && p.thresholdN > best.thresholdN)) {
      best = p;
      bestRank = spec;
    }
  }
  return best;
}

/** Synthesize the config-default policy for an action (used when none matches). */
export function defaultPolicy(config: GovernanceConfig, action: string): Policy {
  return {
    id: `__default__:${action}`,
    action,
    scopeType: "global",
    scope: "",
    thresholdN: Math.max(1, config.defaultThresholdN),
    quorum: 0,
    distinctRequired: true,
    eligibleRole: config.defaultEligibleRole,
    windowSeconds: 0,
    autoPublish: false,
  };
}

/**
 * The policy that governs an action — always returns one. `amend_governance` is
 * special: it is governed by the constitution's own `amend_policy` (the
 * constitutional threshold), not by scope matching. Everything else uses
 * `selectPolicy`, falling back to the config default. An empty `eligibleRole`
 * inherits the config default so the policy is always evaluable.
 */
export function requiredPolicy(
  state: GovernanceState,
  action: string,
  ctx: ActionContext = {},
): Policy {
  let chosen: Policy | null = null;
  if (action === "amend_governance") {
    chosen = state.policies.find((p) => p.id === state.config.amendPolicy) ?? null;
  } else {
    chosen = selectPolicy(state, action, ctx);
  }
  const base = chosen ?? defaultPolicy(state.config, action);
  return base.eligibleRole
    ? base
    : { ...base, eligibleRole: state.config.defaultEligibleRole };
}

export interface Evaluation {
  policy: Policy;
  satisfied: boolean;
  approvals: number; // eligible approve tally (distinct if required)
  needed: number; // policy.thresholdN
  quorumMet: boolean;
  participation: number; // distinct eligible voters (approve or reject)
  eligibleApprovers: string[]; // distinct subjects whose approval counted
}

/**
 * Evaluate whether a proposal's votes satisfy its governing policy. Counts only
 * votes from subjects who hold the policy's `eligibleRole` (scope-aware against
 * the proposal's context), that land within the window, deduped by voter when
 * `distinct_required`. Reject votes never count as approvals but do count toward
 * quorum participation. Pure: `nowMs` and the window bound time explicitly.
 */
export function evaluateProposal(
  state: GovernanceState,
  proposal: Proposal,
  votes: Vote[],
  ctx: ActionContext = {},
  nowMs = Date.now(),
): Evaluation {
  const policy = requiredPolicy(state, proposal.action, ctx);
  const openedAt = parseTime(proposal.openedAt) ?? 0;
  const windowMs = policy.windowSeconds > 0 ? policy.windowSeconds * 1000 : Infinity;

  const eligible = (voter: string, atMs: number | null) => {
    if (atMs === null) return false;
    if (atMs - openedAt > windowMs) return false; // outside the window
    return subjectHoldsRole(state, voter, policy.eligibleRole, ctx, nowMs);
  };

  const approveVoters = new Set<string>();
  const rejectVoters = new Set<string>();
  let approveTally = 0;
  for (const v of votes) {
    if (v.proposal !== proposal.id) continue;
    const atMs = parseTime(v.at);
    if (!eligible(v.voter, atMs)) continue;
    if (v.vote === "approve") {
      approveVoters.add(v.voter);
      approveTally += 1;
    } else {
      rejectVoters.add(v.voter);
    }
  }

  const approvals = policy.distinctRequired ? approveVoters.size : approveTally;
  const participation = new Set<string>([...approveVoters, ...rejectVoters]).size;
  const quorumMet = policy.quorum <= 0 || participation >= policy.quorum;
  const satisfied = approvals >= policy.thresholdN && quorumMet;

  return {
    policy,
    satisfied,
    approvals,
    needed: policy.thresholdN,
    quorumMet,
    participation,
    eligibleApprovers: [...approveVoters],
  };
}

// ── the bootstrap lock (Decision §2) ─────────────────────────────────────────

/** Is governance ratified and therefore self-amending? */
export function isLocked(config: GovernanceConfig): boolean {
  return config.enabled === true;
}

/**
 * May a subject change `governance-*` notes DIRECTLY (out of band), bypassing the
 * proposal process? Only before ratification, and only the bootstrap owner. Once
 * locked, nobody may — every change must ride an `amend_governance` proposal that
 * clears `config.amendPolicy`. This is the guard the grant/governance mutation
 * hook consults.
 */
export function canMutateGovernanceDirectly(state: GovernanceState, subject: string): boolean {
  if (isLocked(state.config)) return false;
  return subject !== "" && subject === state.config.bootstrapOwner;
}

/**
 * Evaluate an `amend_governance` proposal (change/disable governance, edit a
 * policy or role while locked). Convenience wrapper that pins the action so the
 * constitutional `amend_policy` is always the one applied.
 */
export function evaluateAmendment(
  state: GovernanceState,
  proposal: Proposal,
  votes: Vote[],
  nowMs = Date.now(),
): Evaluation {
  const amend: Proposal = { ...proposal, action: "amend_governance" };
  return evaluateProposal(state, amend, votes, {}, nowMs);
}
