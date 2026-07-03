/**
 * The governance store seam — the thin, I/O-bearing bridge between the vault's
 * `governance-*` notes (Decision §1 — governance state dogfooded as governed
 * notes) and the pure `governance.ts` engine. This file does the parsing and
 * serialization; the engine does the deciding. Nothing here makes a governance
 * decision — it only turns notes into structures and back.
 *
 * Note metadata is untrusted `unknown`, so every field is coerced defensively:
 * a malformed governance note degrades to safe defaults (e.g. a policy with a
 * missing threshold reads as threshold 1, distinct-required) rather than throwing
 * and taking the gateway down.
 */
import type { Note } from "./parachute";
import type {
  GovernanceConfig,
  GovernanceState,
  Membership,
  Policy,
  Power,
  Proposal,
  ProposalState,
  Role,
  Vote,
} from "./governance";
import { POWERS } from "./governance";

/** The minimum vault surface the store needs — satisfied by parachute.ts `vault`. */
export interface GovernanceVault {
  listNotes(opts: { tags?: string[]; includeContent?: boolean; limit?: number }): Promise<Note[]>;
}

// ── the governance tag names (single source, mirrors tag-schemas.json) ─────────
export const GOV_TAGS = {
  config: "governance-config",
  role: "governance-role",
  membership: "governance-membership",
  policy: "governance-policy",
  proposal: "governance-proposal",
  vote: "governance-vote",
  audit: "governance-audit",
} as const;

// ── defensive coercion ────────────────────────────────────────────────────────
type Meta = Record<string, unknown> | null | undefined;

const str = (m: Meta, k: string, def = ""): string => {
  const v = m?.[k];
  return typeof v === "string" ? v : v == null ? def : String(v);
};
const num = (m: Meta, k: string, def = 0): number => {
  const v = m?.[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return def;
};
const bool = (m: Meta, k: string, def = false): boolean => {
  const v = m?.[k];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  return def;
};
const strArr = (m: Meta, k: string): string[] => {
  const v = m?.[k];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x !== "");
  if (typeof v === "string" && v.trim() !== "") return v.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
};
const oneOf = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

// ── parsers (note → structure) ────────────────────────────────────────────────

export function parseConfig(note: Note): GovernanceConfig {
  const m = note.metadata;
  return {
    enabled: bool(m, "enabled", false),
    bootstrapOwner: str(m, "bootstrap_owner"),
    amendPolicy: str(m, "amend_policy"),
    defaultThresholdN: num(m, "default_threshold_n", 1),
    defaultEligibleRole: str(m, "default_eligible_role"),
  };
}

export function parseRole(note: Note): Role {
  const m = note.metadata;
  const powers = strArr(m, "powers").filter((p): p is Power => (POWERS as readonly string[]).includes(p));
  return {
    id: note.id,
    name: str(m, "name") || note.id,
    powers,
    scopeType: oneOf(str(m, "scope_type", "global"), ["global", "tag"] as const, "global"),
    scope: str(m, "scope"),
  };
}

export function parseMembership(note: Note): Membership {
  const m = note.metadata;
  return {
    subject: str(m, "subject"),
    role: str(m, "role"),
    grantedBy: str(m, "granted_by") || undefined,
    expiresAt: str(m, "expires_at") || null,
  };
}

export function parsePolicy(note: Note): Policy {
  const m = note.metadata;
  return {
    id: note.id,
    action: str(m, "action"),
    scopeType: oneOf(str(m, "scope_type", "global"), ["global", "tag", "note"] as const, "global"),
    scope: str(m, "scope"),
    thresholdN: Math.max(1, num(m, "threshold_n", 1)),
    quorum: Math.max(0, num(m, "quorum", 0)),
    distinctRequired: bool(m, "distinct_required", true),
    eligibleRole: str(m, "eligible_role"),
    windowSeconds: Math.max(0, num(m, "window_seconds", 0)),
    autoPublish: bool(m, "auto_publish", false),
  };
}

const PROPOSAL_STATES = ["open", "approved", "rejected", "applied", "withdrawn"] as const;

export function parseProposal(note: Note): Proposal {
  const m = note.metadata;
  return {
    id: note.id,
    action: str(m, "action"),
    target: str(m, "target"),
    state: oneOf(str(m, "state", "open"), PROPOSAL_STATES, "open") as ProposalState,
    openedBy: str(m, "opened_by"),
    openedAt: str(m, "opened_at"),
  };
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  before: string;
  after: string;
  at: string;
}

export function parseAudit(note: Note): AuditEntry {
  const m = note.metadata;
  return {
    id: note.id,
    action: str(m, "action"),
    actor: str(m, "actor"),
    before: str(m, "before"),
    after: str(m, "after"),
    at: str(m, "at"),
  };
}

export function parseVote(note: Note): Vote {
  const m = note.metadata;
  const reason = str(m, "reason");
  return {
    proposal: str(m, "proposal"),
    voter: str(m, "voter"),
    vote: oneOf(str(m, "vote", "approve"), ["approve", "reject"] as const, "approve"),
    at: str(m, "at"),
    ...(reason ? { reason } : {}),
  };
}

// ── serializers (structure → note metadata) ───────────────────────────────────
// Used by the write path (G1+) so a proposal/vote/membership can be created as a
// governance-* note. Field names mirror tag-schemas.json exactly, so
// parse(serialize(x)) round-trips.

export function configToMetadata(c: GovernanceConfig): Record<string, unknown> {
  return {
    enabled: c.enabled,
    bootstrap_owner: c.bootstrapOwner,
    amend_policy: c.amendPolicy,
    default_threshold_n: c.defaultThresholdN,
    default_eligible_role: c.defaultEligibleRole,
  };
}
export function roleToMetadata(r: Omit<Role, "id">): Record<string, unknown> {
  return { name: r.name, powers: r.powers, scope_type: r.scopeType, scope: r.scope };
}
export function membershipToMetadata(m: Membership): Record<string, unknown> {
  return { subject: m.subject, role: m.role, granted_by: m.grantedBy ?? "", expires_at: m.expiresAt ?? "" };
}
export function policyToMetadata(p: Omit<Policy, "id">): Record<string, unknown> {
  return {
    action: p.action,
    scope_type: p.scopeType,
    scope: p.scope,
    threshold_n: p.thresholdN,
    quorum: p.quorum,
    distinct_required: p.distinctRequired,
    eligible_role: p.eligibleRole,
    window_seconds: p.windowSeconds,
    auto_publish: p.autoPublish,
  };
}
export function proposalToMetadata(p: Omit<Proposal, "id">): Record<string, unknown> {
  return { action: p.action, target: p.target, state: p.state, opened_by: p.openedBy, opened_at: p.openedAt };
}
export function voteToMetadata(v: Vote): Record<string, unknown> {
  return { proposal: v.proposal, voter: v.voter, vote: v.vote, at: v.at, reason: v.reason ?? "" };
}
export function auditToMetadata(e: {
  action: string;
  actor: string;
  before?: string;
  after?: string;
  at: string;
}): Record<string, unknown> {
  return { action: e.action, actor: e.actor, before: e.before ?? "", after: e.after ?? "", at: e.at };
}

// ── loaders (vault → engine state) ─────────────────────────────────────────────

/** A safe disabled constitution when no `governance-config` note exists yet. */
export function disabledConfig(fallbackOwner = ""): GovernanceConfig {
  return {
    enabled: false,
    bootstrapOwner: fallbackOwner,
    amendPolicy: "",
    defaultThresholdN: 1,
    defaultEligibleRole: "",
  };
}

/**
 * Assemble the full governance state from the vault. The config is a singleton:
 * `listNotes` returns newest-first, so the most recently updated
 * `governance-config` note wins; absent any, governance is treated as disabled
 * (unlocked) with the fallback owner as bootstrap root.
 */
export async function loadState(
  vault: GovernanceVault,
  opts: { fallbackOwner?: string } = {},
): Promise<GovernanceState> {
  const [configs, roles, memberships, policies] = await Promise.all([
    vault.listNotes({ tags: [GOV_TAGS.config] }),
    vault.listNotes({ tags: [GOV_TAGS.role] }),
    vault.listNotes({ tags: [GOV_TAGS.membership] }),
    vault.listNotes({ tags: [GOV_TAGS.policy] }),
  ]);
  const first = configs[0];
  const config = first ? parseConfig(first) : disabledConfig(opts.fallbackOwner);
  return {
    config,
    roles: roles.map(parseRole),
    memberships: memberships.map(parseMembership),
    policies: policies.map(parsePolicy),
  };
}

/** Load the votes cast on a given proposal. */
export async function loadVotesFor(vault: GovernanceVault, proposalId: string): Promise<Vote[]> {
  const notes = await vault.listNotes({ tags: [GOV_TAGS.vote] });
  return notes.map(parseVote).filter((v) => v.proposal === proposalId);
}

/** Load the audit trail, newest first — the commons's legible memory (Ostrom #4). */
export async function listAudit(vault: GovernanceVault, limit = 100): Promise<AuditEntry[]> {
  const notes = await vault.listNotes({ tags: [GOV_TAGS.audit], limit });
  return notes.map(parseAudit).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
