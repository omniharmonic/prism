/**
 * The governance service — composes the pure engine (`governance.ts`) with the
 * store seam (`governance-store.ts`) and the live vault, and is the ONLY place
 * that effects a governance change. Every mutation to a `governance-*` note
 * funnels through `mutateGovernance`, which enforces the bootstrap lock
 * (Decision §2): while unlocked the bootstrap owner may write directly; once
 * `config.enabled` is true, a change is refused unless it rides an
 * `amend_governance` proposal that clears the constitution's own threshold.
 *
 * This layer does I/O (reads/writes notes, writes audit entries) but delegates
 * every DECISION to the pure engine, so the authoritative logic stays testable
 * in isolation and this file stays a thin, auditable choke point.
 */
import type { VaultHelper } from "./parachute";
import {
  canMutateGovernanceDirectly,
  evaluateAmendment,
  isLocked,
  type ActionContext,
  type GovernanceConfig,
  type GovernanceState,
  type Membership,
  type Policy,
  type Proposal,
  type Role,
  type Vote,
} from "./governance";
import {
  GOV_TAGS,
  configToMetadata,
  loadState,
  loadVotesFor,
  policyToMetadata,
  proposalToMetadata,
  roleToMetadata,
  membershipToMetadata,
  voteToMetadata,
  auditToMetadata,
  parseProposal,
} from "./governance-store";

/** The vault surface the service needs (satisfied by parachute.ts `vault`). */
export type ServiceVault = Pick<VaultHelper, "listNotes" | "createNote" | "updateNote" | "getNote">;

/** A governance change to effect. Kept to the small v1 set (light REA / small
 *  governance surface); content-note proposals are G2, not here. */
export type GovChange =
  | { kind: "set_config"; config: GovernanceConfig }
  | { kind: "add_role"; role: Omit<Role, "id"> }
  | { kind: "add_policy"; policy: Omit<Policy, "id"> }
  | { kind: "add_membership"; membership: Membership };

export const GOV_CHANGE_KINDS = ["set_config", "add_role", "add_policy", "add_membership"] as const;

export interface MutateOk {
  ok: true;
  applied: GovChange["kind"];
  note?: { id: string };
}
export interface MutateErr {
  ok: false;
  code: "requires_proposal" | "insufficient_approvals" | "forbidden";
  detail: string;
  evaluation?: ReturnType<typeof evaluateAmendment>;
}
export type MutateResult = MutateOk | MutateErr;

const nowIso = () => new Date().toISOString();

/** Load the full governance state, defaulting the bootstrap owner to OWNER_EMAIL. */
export function loadGovernance(vault: ServiceVault, ownerEmail: string): Promise<GovernanceState> {
  return loadState(vault, { fallbackOwner: ownerEmail });
}

/** Append an audit entry (best-effort; never throws into the caller's path). */
export async function recordAudit(
  vault: ServiceVault,
  entry: { action: string; actor: string; before?: string; after?: string },
): Promise<void> {
  try {
    await vault.createNote({
      content: `# Governance audit: ${entry.action}`,
      metadata: auditToMetadata({ ...entry, at: nowIso() }),
      tags: [GOV_TAGS.audit],
    });
  } catch {
    // Audit is memory, not a gate — a write failure must not block the action or
    // crash the request. (A durable audit-write retry queue is a later hardening.)
  }
}

/** Effect a change by writing the backing governance note(s). */
async function effect(vault: ServiceVault, change: GovChange): Promise<{ id: string }> {
  switch (change.kind) {
    case "set_config": {
      const existing = (await vault.listNotes({ tags: [GOV_TAGS.config] }))[0];
      const metadata = configToMetadata(change.config);
      if (existing) {
        const n = await vault.updateNote(existing.id, { metadata });
        return { id: n.id };
      }
      const n = await vault.createNote({
        content: "# Governance Constitution",
        path: "governance/config",
        metadata,
        tags: [GOV_TAGS.config],
      });
      return { id: n.id };
    }
    case "add_role": {
      const n = await vault.createNote({
        content: `# Governance role: ${change.role.name}`,
        metadata: roleToMetadata(change.role),
        tags: [GOV_TAGS.role],
      });
      return { id: n.id };
    }
    case "add_policy": {
      const n = await vault.createNote({
        content: `# Governance policy: ${change.policy.action}`,
        metadata: policyToMetadata(change.policy),
        tags: [GOV_TAGS.policy],
      });
      return { id: n.id };
    }
    case "add_membership": {
      const n = await vault.createNote({
        content: `# Governance membership: ${change.membership.subject} → ${change.membership.role}`,
        metadata: membershipToMetadata(change.membership),
        tags: [GOV_TAGS.membership],
      });
      return { id: n.id };
    }
  }
}

const auditFor = (change: GovChange): string => `${change.kind}`;

/**
 * The single governance mutation choke point (hook 1, note-native). Enforces the
 * bootstrap lock:
 *   - unlocked  → only the bootstrap owner may write, directly.
 *   - locked    → the change must ride an `amend_governance` proposal whose votes
 *                 clear the constitution's amend policy (evaluated by the pure
 *                 engine). No direct path exists once ratified — not even for the
 *                 owner. This is what makes governance self-amending & self-protecting.
 */
export async function mutateGovernance(
  vault: ServiceVault,
  state: GovernanceState,
  subject: string,
  change: GovChange,
  via?: { proposal: Proposal; votes: Vote[] },
): Promise<MutateResult> {
  if (canMutateGovernanceDirectly(state, subject)) {
    const note = await effect(vault, change);
    await recordAudit(vault, { action: `direct:${auditFor(change)}`, actor: subject, after: JSON.stringify(change) });
    return { ok: true, applied: change.kind, note };
  }

  if (!isLocked(state.config)) {
    // Unlocked but not the bootstrap owner — bootstrap is owner-only.
    return { ok: false, code: "forbidden", detail: "only the bootstrap owner may configure governance before it is enabled" };
  }

  // Locked: require a satisfied amend_governance proposal.
  if (!via) return { ok: false, code: "requires_proposal", detail: "governance is enabled; this change requires an approved amend_governance proposal" };
  const evaluation = evaluateAmendment(state, via.proposal, via.votes);
  if (!evaluation.satisfied) {
    return {
      ok: false,
      code: "insufficient_approvals",
      detail: `amendment needs ${evaluation.needed} approvals from role "${evaluation.policy.eligibleRole}" (has ${evaluation.approvals}${evaluation.quorumMet ? "" : ", quorum not met"})`,
      evaluation,
    };
  }
  const note = await effect(vault, change);
  await recordAudit(vault, {
    action: `amend:${auditFor(change)}`,
    actor: subject,
    before: `proposal ${via.proposal.id}`,
    after: JSON.stringify(change),
  });
  return { ok: true, applied: change.kind, note };
}

// ── proposal helpers (note-native) ─────────────────────────────────────────────

/** Open a proposal note. Proposing ≠ deciding, so any member may open one. */
export async function openProposal(
  vault: ServiceVault,
  p: { action: string; target: string; payload: string; openedBy: string },
): Promise<{ id: string }> {
  const proposal: Omit<Proposal, "id"> = {
    action: p.action,
    target: p.target,
    state: "open",
    openedBy: p.openedBy,
    openedAt: nowIso(),
  };
  const note = await vault.createNote({
    content: `# Proposal: ${p.action} → ${p.target}`,
    metadata: { ...proposalToMetadata(proposal), payload: p.payload },
    tags: [GOV_TAGS.proposal],
  });
  return { id: note.id };
}

/** Cast a vote. Caller must have verified eligibility via the engine first. */
export async function castVote(vault: ServiceVault, v: Vote): Promise<{ id: string }> {
  const note = await vault.createNote({
    content: `# Vote: ${v.vote} on ${v.proposal}`,
    metadata: voteToMetadata(v),
    tags: [GOV_TAGS.vote],
  });
  return { id: note.id };
}

/** Whether `voter` has already voted on `proposalId` (one-vote-per-member). */
export async function hasVoted(vault: ServiceVault, proposalId: string, voter: string): Promise<boolean> {
  const votes = await loadVotesFor(vault, proposalId);
  return votes.some((v) => v.voter === voter);
}

/** Fetch + parse a single proposal note by id. */
export async function getProposal(vault: ServiceVault, id: string): Promise<Proposal | null> {
  try {
    const note = await vault.getNote(id);
    if (!(note.tags ?? []).includes(GOV_TAGS.proposal)) return null;
    return parseProposal(note);
  } catch {
    return null;
  }
}

/** Fetch a proposal together with its decoded payload (the proposed change). */
export async function getProposalRaw(
  vault: ServiceVault,
  id: string,
): Promise<{ proposal: Proposal; payload: unknown } | null> {
  const note = await vault.getNote(id).catch(() => null);
  if (!note || !(note.tags ?? []).includes(GOV_TAGS.proposal)) return null;
  const raw = note.metadata?.payload;
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  return { proposal: parseProposal(note), payload };
}

// ── content proposals (the G2 review pipeline — governed content changes) ──────

/** The shape of a content proposal's payload (the proposed change to a note). */
export interface ContentPayload {
  content?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  path?: string;
}

/** The governance actions that carry a ContentPayload (vs. governance amendments). */
export const CONTENT_ACTIONS = ["edit_note", "new_entry"] as const;
export const isContentAction = (a: string): boolean => (CONTENT_ACTIONS as readonly string[]).includes(a);

/**
 * The action context for a proposal — the tags/note the policy is scoped by.
 * For `edit_note` it is the TARGET note's live tags (so a gardener-of-#medicine
 * policy governs edits to medicine notes). For `new_entry` it is the proposed
 * tags carried in the payload. Governance amendments have no content context.
 */
export async function proposalContext(vault: ServiceVault, proposal: Proposal, payload?: ContentPayload): Promise<ActionContext> {
  if (proposal.action === "edit_note") {
    const target = await vault.getNote(proposal.target).catch(() => null);
    return target ? { noteId: target.id, tags: target.tags ?? [] } : { noteId: proposal.target, tags: [] };
  }
  if (proposal.action === "new_entry") {
    return { tags: payload?.tags ?? [] };
  }
  return {};
}

/** Effect a content proposal — write the proposed change to the vault. This is
 *  the "goes live" consumer the accept path lacked. (Approval≠publishing split is
 *  G4; for now an applied edit is live.) */
export async function applyContentProposal(
  vault: ServiceVault,
  proposal: Proposal,
  payload: ContentPayload,
): Promise<{ id: string }> {
  if (proposal.action === "edit_note") {
    const params: { content?: string; metadata?: Record<string, unknown> } = {};
    if (typeof payload.content === "string") params.content = payload.content;
    if (payload.metadata) params.metadata = payload.metadata;
    const n = await vault.updateNote(proposal.target, params);
    return { id: n.id };
  }
  // new_entry
  const n = await vault.createNote({
    content: payload.content ?? "",
    ...(payload.path ? { path: payload.path } : {}),
    ...(payload.metadata ? { metadata: payload.metadata } : {}),
    tags: payload.tags ?? [],
  });
  return { id: n.id };
}

/** Mark a proposal's terminal state (applied/rejected/withdrawn). Reads-then-
 *  merges so the other proposal fields survive regardless of whether the vault's
 *  PATCH merges or replaces metadata. */
export async function setProposalState(vault: ServiceVault, id: string, next: Proposal["state"]): Promise<void> {
  const note = await vault.getNote(id).catch(() => null);
  const metadata = { ...(note?.metadata ?? {}), state: next };
  await vault.updateNote(id, { metadata });
}
