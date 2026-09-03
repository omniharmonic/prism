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
import { renderConstitution, renderPolicySentence, renderRoleSentence } from "@prism/core/governance-prose";
import type { Note, VaultHelper } from "./parachute";
import {
  canDelegateMembership,
  canMutateGovernanceDirectly,
  evaluateAmendment,
  isLocked,
  validateRatification,
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
  listRevisionsFor,
  policyToMetadata,
  proposalToMetadata,
  roleToMetadata,
  membershipToMetadata,
  voteToMetadata,
  auditToMetadata,
  parseConfig,
  parseMembership,
  parsePolicy,
  parseProposal,
  parseRevision,
  parseRole,
  parseVote,
  revisionToMetadata,
  type Revision,
} from "./governance-store";

/** The vault surface the service needs (satisfied by parachute.ts `vault`). */
export type ServiceVault = Pick<VaultHelper, "listNotes" | "createNote" | "updateNote" | "getNote" | "deleteNote">;

/**
 * A governance change to effect — the full lifecycle for each of the three axes
 * (WHO / HOW-MANY / WHAT-STATE), not just the additive half. Adds are UPSERTS
 * (re-running a provisioning script must not duplicate the constitution), and
 * every remove/update names its target by `ref`. Content-note proposals are G2,
 * not here.
 */
export type GovChange =
  | { kind: "set_config"; config: GovernanceConfig }
  | { kind: "add_role"; role: Omit<Role, "id"> }
  | { kind: "update_role"; ref: string; role: Partial<Omit<Role, "id">> }
  | { kind: "remove_role"; ref: string }
  | { kind: "add_policy"; policy: Omit<Policy, "id"> }
  | { kind: "update_policy"; ref: string; policy: Partial<Omit<Policy, "id">> }
  | { kind: "remove_policy"; ref: string }
  | { kind: "add_membership"; membership: Membership }
  | { kind: "remove_membership"; subject: string; role: string };

export const GOV_CHANGE_KINDS = [
  "set_config",
  "add_role",
  "update_role",
  "remove_role",
  "add_policy",
  "update_policy",
  "remove_policy",
  "add_membership",
  "remove_membership",
] as const;

export interface MutateOk {
  ok: true;
  applied: GovChange["kind"];
  note?: { id: string };
}
export interface MutateErr {
  ok: false;
  code: "requires_proposal" | "insufficient_approvals" | "forbidden" | "not_found" | "invalid_config";
  detail: string;
  evaluation?: ReturnType<typeof evaluateAmendment>;
}
export type MutateResult = MutateOk | MutateErr;

/**
 * A strictly-monotonic ISO clock for governance stamps. Revisions, votes and
 * audit entries are ordered by their `at` string alone (there is no sequence
 * column in a note), so two writes landing in the SAME millisecond — a rollback
 * right after an apply, say — leave their order ambiguous and the "newest first"
 * history can come back in the wrong order. Never returning the same instant
 * twice makes that ordering deterministic; the cost is that a burst of writes may
 * read a few ms ahead of the wall clock.
 */
let lastStampMs = 0;
const nowIso = (): string => {
  const t = Math.max(Date.now(), lastStampMs + 1);
  lastStampMs = t;
  return new Date(t).toISOString();
};

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

/** An effect either wrote a note, or refused with a structured reason. */
type EffectResult = { ok: true; id: string } | { ok: false; code: MutateErr["code"]; detail: string };

const govNotes = (vault: ServiceVault, tag: string): Promise<Note[]> => vault.listNotes({ tags: [tag] });

const notFound = (what: string, ref: string): EffectResult => ({
  ok: false,
  code: "not_found",
  detail: `no governance ${what} matches "${ref}"`,
});

// ── legible bodies (P3) ───────────────────────────────────────────────────────
// A governance note whose body is just a heading is a row in a database wearing a
// note's clothes. Every role/policy note carries the SENTENCE it means, rendered
// by the same pure module the UI renders it with (@prism/core/governance-prose),
// so the constitution is readable in the vault, in search, and in any client that
// never heard of governance. Metadata stays authoritative; prose is derived.

const roleBody = (role: Omit<Role, "id"> | Role): string =>
  `# Governance role: ${role.name}\n\n${renderRoleSentence(role)}`;

const policyBody = (policy: Omit<Policy, "id"> | Policy, state: GovernanceState): string =>
  `# Governance policy: ${policy.action}\n\n${renderPolicySentence(policy, {
    roleName: policy.eligibleRole || state.config.defaultEligibleRole,
  })}`;

/**
 * Rewrite the `governance-config` note's CONTENT as the human-readable
 * constitution. Called after every successful mutation (beside the grant
 * reconcile) so the prose never drifts from the metadata that governs.
 *
 * Best-effort and metadata-preserving by construction: it patches `content`
 * only. A no-op when the prose is already current, and a silent no-op when no
 * config note exists yet (an un-bootstrapped commons has no constitution to
 * write).
 */
export async function writeConstitutionProse(vault: ServiceVault, state: GovernanceState): Promise<boolean> {
  const note = (await govNotes(vault, GOV_TAGS.config))[0];
  if (!note) return false;
  const content = renderConstitution(state);
  if (note.content === content) return false;
  await vault.updateNote(note.id, { content });
  return true;
}

/**
 * Merge an incoming config with the current one, protecting the two fields whose
 * loss is unrecoverable. The UI's "disable governance" amendment template sends
 * `{enabled:false}` alone; taken literally that would blank `bootstrap_owner` and
 * leave the commons with NO recovery root once disabled. So an empty
 * `bootstrapOwner` always inherits, and an empty `amendPolicy` inherits whenever
 * the config stays enabled (a disable may legitimately clear it).
 */
export function mergeConfig(current: GovernanceConfig, incoming: GovernanceConfig): GovernanceConfig {
  const merged: GovernanceConfig = { ...incoming };
  if (!merged.bootstrapOwner) merged.bootstrapOwner = current.bootstrapOwner;
  if (!merged.amendPolicy && merged.enabled) merged.amendPolicy = current.amendPolicy;
  return merged;
}

/**
 * Effect a change by writing the backing governance note(s).
 *
 * Adds are UPSERTS keyed by the structure's natural identity (role name; policy
 * action+scope; membership subject+role) so re-running a provisioning script or
 * re-applying an amendment converges instead of duplicating the constitution.
 * Removes cascade where a dangling reference would otherwise survive (deleting a
 * role deletes the memberships that named it) and refuse where the deletion would
 * strand governance (the amend policy is load-bearing — without it nothing can
 * ever be amended again).
 */
async function effect(vault: ServiceVault, state: GovernanceState, change: GovChange): Promise<EffectResult> {
  switch (change.kind) {
    case "set_config": {
      const existing = (await govNotes(vault, GOV_TAGS.config))[0];
      const metadata = configToMetadata(change.config);
      if (existing) {
        const n = await vault.updateNote(existing.id, { metadata });
        return { ok: true, id: n.id };
      }
      const n = await vault.createNote({
        content: "# Governance Constitution",
        path: "governance/config",
        metadata,
        tags: [GOV_TAGS.config],
      });
      return { ok: true, id: n.id };
    }

    case "add_role": {
      const existing = (await govNotes(vault, GOV_TAGS.role)).find((n) => parseRole(n).name === change.role.name);
      const metadata = roleToMetadata(change.role);
      const content = roleBody(change.role);
      if (existing) {
        const n = await vault.updateNote(existing.id, { metadata, content });
        return { ok: true, id: n.id };
      }
      const n = await vault.createNote({ content, metadata, tags: [GOV_TAGS.role] });
      return { ok: true, id: n.id };
    }

    case "update_role": {
      const match = (await govNotes(vault, GOV_TAGS.role)).find((n) => {
        const r = parseRole(n);
        return r.id === change.ref || r.name === change.ref;
      });
      if (!match) return notFound("role", change.ref);
      const merged: Role = { ...parseRole(match), ...change.role };
      const n = await vault.updateNote(match.id, { metadata: roleToMetadata(merged), content: roleBody(merged) });
      return { ok: true, id: n.id };
    }

    case "remove_role": {
      const match = (await govNotes(vault, GOV_TAGS.role)).find((n) => {
        const r = parseRole(n);
        return r.id === change.ref || r.name === change.ref;
      });
      if (!match) return notFound("role", change.ref);
      const role = parseRole(match);
      await vault.deleteNote(match.id);
      // Cascade: a membership pointing at a deleted role is a dangling grant of
      // powers that no longer resolve. Drop them with the role.
      for (const mn of await govNotes(vault, GOV_TAGS.membership)) {
        const m = parseMembership(mn);
        if (m.role === role.id || (role.name !== "" && m.role === role.name)) await vault.deleteNote(mn.id);
      }
      return { ok: true, id: match.id };
    }

    case "add_policy": {
      const existing = (await govNotes(vault, GOV_TAGS.policy)).find((n) => {
        const p = parsePolicy(n);
        return p.action === change.policy.action && p.scopeType === change.policy.scopeType && p.scope === change.policy.scope;
      });
      const metadata = policyToMetadata(change.policy);
      const content = policyBody(change.policy, state);
      if (existing) {
        const n = await vault.updateNote(existing.id, { metadata, content });
        return { ok: true, id: n.id };
      }
      const n = await vault.createNote({ content, metadata, tags: [GOV_TAGS.policy] });
      return { ok: true, id: n.id };
    }

    case "update_policy": {
      const match = (await govNotes(vault, GOV_TAGS.policy)).find((n) => n.id === change.ref);
      if (!match) return notFound("policy", change.ref);
      const merged: Policy = { ...parsePolicy(match), ...change.policy };
      if (state.config.amendPolicy && match.id === state.config.amendPolicy && merged.action !== "amend_governance") {
        return {
          ok: false,
          code: "invalid_config",
          detail: "refusing to retarget the constitution's amend policy away from amend_governance — governance would become un-amendable",
        };
      }
      const n = await vault.updateNote(match.id, { metadata: policyToMetadata(merged), content: policyBody(merged, state) });
      return { ok: true, id: n.id };
    }

    case "remove_policy": {
      const match = (await govNotes(vault, GOV_TAGS.policy)).find((n) => n.id === change.ref);
      if (!match) return notFound("policy", change.ref);
      if (state.config.amendPolicy && match.id === state.config.amendPolicy) {
        return {
          ok: false,
          code: "invalid_config",
          detail: "refusing to delete the constitution's amend policy — no amendment could ever be evaluated again",
        };
      }
      await vault.deleteNote(match.id);
      return { ok: true, id: match.id };
    }

    case "add_membership": {
      const existing = (await govNotes(vault, GOV_TAGS.membership)).find((n) => {
        const m = parseMembership(n);
        return m.subject === change.membership.subject && m.role === change.membership.role;
      });
      const metadata = membershipToMetadata(change.membership);
      if (existing) {
        const n = await vault.updateNote(existing.id, { metadata });
        return { ok: true, id: n.id };
      }
      const n = await vault.createNote({
        content: `# Governance membership: ${change.membership.subject} → ${change.membership.role}`,
        metadata,
        tags: [GOV_TAGS.membership],
      });
      return { ok: true, id: n.id };
    }

    case "remove_membership": {
      const matches = (await govNotes(vault, GOV_TAGS.membership)).filter((n) => {
        const m = parseMembership(n);
        return m.subject === change.subject && m.role === change.role;
      });
      const first = matches[0];
      if (!first) return notFound("membership", `${change.subject} → ${change.role}`);
      for (const n of matches) await vault.deleteNote(n.id);
      return { ok: true, id: first.id };
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
  // A config write is normalized (and pre-flighted) BEFORE any authorization
  // branch, so both the bootstrap path and the amendment path get the same
  // protected merge and the same ratification check.
  let effective = change;
  if (change.kind === "set_config") {
    const merged = mergeConfig(state.config, change.config);
    effective = { kind: "set_config", config: merged };
    // The enable transition is the one-way latch. Refuse to ratify a constitution
    // that could never amend itself — after the latch there is no way back.
    if (merged.enabled && !isLocked(state.config)) {
      const check = validateRatification(state, merged);
      if (!check.ok) {
        return { ok: false, code: "invalid_config", detail: check.problems.join("; ") };
      }
    }
  }

  if (canMutateGovernanceDirectly(state, subject)) {
    const res = await effect(vault, state, effective);
    if (!res.ok) return res;
    await recordAudit(vault, { action: `direct:${auditFor(effective)}`, actor: subject, after: JSON.stringify(effective) });
    return { ok: true, applied: effective.kind, note: { id: res.id } };
  }

  if (!isLocked(state.config)) {
    // Unlocked but not the bootstrap owner — bootstrap is owner-only.
    return { ok: false, code: "forbidden", detail: "only the bootstrap owner may configure governance before it is enabled" };
  }

  // ── delegated stewardship (P2) ────────────────────────────────────────────
  // Post-lock, EVERY change riding an amendment is correct for the constitution
  // and wrong for the roster: onboarding a gardener should not require a
  // constitutional vote, and a commons where it does simply stops onboarding.
  // So membership changes — and only membership changes — may be made directly
  // by someone the constitution has explicitly deputized: a role carrying
  // `assign_roles` that names the target role in its `assigns`, with compatible
  // scope. The engine decides (`canDelegateMembership`, which also refuses to let
  // any delegation hand out `amend_governance`); this stays inside the same
  // choke point, so there is still exactly one place governance is written.
  if (
    !via &&
    (effective.kind === "add_membership" || effective.kind === "remove_membership") &&
    canDelegateMembership(
      state,
      subject,
      effective.kind === "add_membership" ? effective.membership.role : effective.role,
    )
  ) {
    const res = await effect(vault, state, effective);
    if (!res.ok) return res;
    await recordAudit(vault, {
      action: `delegated:${auditFor(effective)}`,
      actor: subject,
      after: JSON.stringify(effective),
    });
    return { ok: true, applied: effective.kind, note: { id: res.id } };
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
  const res = await effect(vault, state, effective);
  if (!res.ok) return res;
  await recordAudit(vault, {
    action: `amend:${auditFor(effective)}`,
    actor: subject,
    before: `proposal ${via.proposal.id}`,
    after: JSON.stringify(effective),
  });
  return { ok: true, applied: effective.kind, note: { id: res.id } };
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

/** Whether `voter` has already voted on `proposalId`. Kept for callers that only
 *  need the predicate; the vote route uses `upsertVote` (votes are mutable). */
export async function hasVoted(vault: ServiceVault, proposalId: string, voter: string): Promise<boolean> {
  const votes = await loadVotesFor(vault, proposalId);
  return votes.some((v) => v.voter === voter);
}

/** The voter's existing vote NOTE on a proposal (`loadVotesFor` drops note ids,
 *  and we need the id to rewrite the vote in place). */
export async function findVoteNote(
  vault: ServiceVault,
  proposalId: string,
  voter: string,
): Promise<Note | null> {
  const notes = await govNotes(vault, GOV_TAGS.vote);
  return (
    notes.find((n) => {
      const v = parseVote(n);
      return v.proposal === proposalId && v.voter === voter;
    }) ?? null
  );
}

/**
 * Cast or CHANGE a vote. A member may revise their sign-off while a proposal is
 * still open — deliberation that cannot change its mind is not deliberation — so
 * a second vote rewrites the first rather than being refused. One note per
 * (proposal, voter) keeps the distinct-approver tally honest either way.
 */
export async function upsertVote(vault: ServiceVault, v: Vote): Promise<{ id: string; updated: boolean }> {
  const existing = await findVoteNote(vault, v.proposal, v.voter);
  if (existing) {
    const n = await vault.updateNote(existing.id, {
      metadata: { ...(existing.metadata ?? {}), ...voteToMetadata(v) },
    });
    return { id: n.id, updated: true };
  }
  const n = await castVote(vault, v);
  return { id: n.id, updated: false };
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

/** Result of applying a content proposal: either live (published) or staged. */
export interface ContentApplyResult {
  published: boolean;
  revisionId: string;
  noteId: string | null; // null while a staged new_entry has no note yet
}

/** Snapshot a revision note (the note CONTENT is the snapshot). */
async function createRevisionNote(
  vault: ServiceVault,
  r: Omit<Revision, "id"> & { content: string },
): Promise<{ id: string }> {
  const { content, ...meta } = r;
  const note = await vault.createNote({
    content,
    metadata: revisionToMetadata(meta),
    tags: [GOV_TAGS.revision],
  });
  return { id: note.id };
}

const latestRevisionId = async (vault: ServiceVault, noteId: string): Promise<string> =>
  (await listRevisionsFor(vault, noteId))[0]?.id ?? "";

/**
 * Effect an APPROVED content proposal (G4: approval ≠ publishing). Always
 * snapshots a revision; the policy's `autoPublish` decides whether the change
 * also goes live now or stays STAGED (published=false) awaiting an explicit
 * publish by a `publish`-power holder.
 */
export async function applyContentProposal(
  vault: ServiceVault,
  proposal: Proposal,
  payload: ContentPayload,
  opts: { author: string; autoPublish: boolean },
): Promise<ContentApplyResult> {
  const at = nowIso();
  const content = payload.content ?? "";

  if (proposal.action === "edit_note") {
    const parent = await latestRevisionId(vault, proposal.target);
    if (opts.autoPublish) {
      const params: { content?: string; metadata?: Record<string, unknown> } = {};
      if (typeof payload.content === "string") params.content = payload.content;
      if (payload.metadata) params.metadata = payload.metadata;
      await vault.updateNote(proposal.target, params);
    }
    const rev = await createRevisionNote(vault, {
      note: proposal.target,
      parent,
      proposal: proposal.id,
      author: opts.author,
      origin: "proposal",
      published: opts.autoPublish,
      at,
      payload: "",
      content,
    });
    return { published: opts.autoPublish, revisionId: rev.id, noteId: proposal.target };
  }

  // new_entry
  if (opts.autoPublish) {
    const n = await vault.createNote({
      content,
      ...(payload.path ? { path: payload.path } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
      tags: payload.tags ?? [],
    });
    const rev = await createRevisionNote(vault, {
      note: n.id,
      parent: "",
      proposal: proposal.id,
      author: opts.author,
      origin: "proposal",
      published: true,
      at,
      payload: "",
      content,
    });
    return { published: true, revisionId: rev.id, noteId: n.id };
  }
  // Staged: the revision carries everything needed to create the note on publish.
  const rev = await createRevisionNote(vault, {
    note: "",
    parent: "",
    proposal: proposal.id,
    author: opts.author,
    origin: "proposal",
    published: false,
    at,
    payload: JSON.stringify({ path: payload.path ?? "", tags: payload.tags ?? [], metadata: payload.metadata ?? null }),
    content,
  });
  return { published: false, revisionId: rev.id, noteId: null };
}

/** The (unpublished) revision a proposal staged, if any. */
export async function revisionForProposal(vault: ServiceVault, proposalId: string): Promise<Revision | null> {
  const notes = await vault.listNotes({ tags: [GOV_TAGS.revision] });
  const match = notes.map(parseRevision).find((r) => r.proposal === proposalId);
  return match ?? null;
}

/** Publish a staged revision: write it live and mark it published. */
export async function publishRevision(
  vault: ServiceVault,
  revisionId: string,
  author: string,
): Promise<{ noteId: string }> {
  const revNote = await vault.getNote(revisionId);
  const rev = parseRevision(revNote);
  if (rev.published) throw new Error("revision is already published");

  let noteId = rev.note;
  if (noteId) {
    await vault.updateNote(noteId, { content: revNote.content });
  } else {
    // Staged new_entry — create the note from the stored payload.
    let p: { path?: string; tags?: string[]; metadata?: Record<string, unknown> | null } = {};
    try {
      p = JSON.parse(rev.payload || "{}");
    } catch {
      p = {};
    }
    const n = await vault.createNote({
      content: revNote.content,
      ...(p.path ? { path: p.path } : {}),
      ...(p.metadata ? { metadata: p.metadata } : {}),
      tags: p.tags ?? [],
    });
    noteId = n.id;
  }
  await vault.updateNote(revisionId, {
    metadata: { ...(revNote.metadata ?? {}), note: noteId, published: true, origin: "publish" },
  });
  await recordAudit(vault, { action: "revision_published", actor: author, after: `${revisionId} → ${noteId}` });
  return { noteId };
}

/** Roll a note's live content back to a prior revision (non-destructive: the
 *  rollback itself is snapshotted as a new revision). */
export async function rollbackNote(
  vault: ServiceVault,
  noteId: string,
  revisionId: string,
  author: string,
): Promise<{ revisionId: string }> {
  const revNote = await vault.getNote(revisionId);
  const rev = parseRevision(revNote);
  if (rev.note !== noteId) throw new Error("revision does not belong to this note");
  await vault.updateNote(noteId, { content: revNote.content });
  const parent = await latestRevisionId(vault, noteId);
  const created = await createRevisionNote(vault, {
    note: noteId,
    parent,
    proposal: "",
    author,
    origin: "rollback",
    published: true,
    at: nowIso(),
    payload: "",
    content: revNote.content,
  });
  await recordAudit(vault, { action: "note_rolled_back", actor: author, before: revisionId, after: created.id });
  return { revisionId: created.id };
}

// ── fork / ancestry / merge-back (G5) ─────────────────────────────────────────
// A fork is a full local copy with ancestry pointers; it does NOT sync with its
// origin. Merge-back is PROPOSAL-ONLY (locked decision): the fork's content is
// submitted as an ordinary edit_note proposal against the origin, gated by the
// same per-tag policy as any other change. On a federated origin, an applied
// merge converges to mirrors via the existing CRDT bridge — the hub whose
// governance gates the merge IS the canonical hub.

/** Fork a note: copy content+tags+metadata, stamp ancestry, audit. */
export async function forkNote(
  vault: ServiceVault,
  noteId: string,
  by: string,
): Promise<{ id: string; forkedFrom: string }> {
  const origin = await vault.getNote(noteId);
  const metadata: Record<string, unknown> = {
    ...(origin.metadata ?? {}),
    forked_from: origin.id,
    forked_at: nowIso(),
    forked_by: by,
  };
  const fork = await vault.createNote({
    content: origin.content,
    ...(origin.path ? { path: `${origin.path}-fork-${Date.now().toString(36)}` } : {}),
    metadata,
    tags: origin.tags ?? [],
  });
  await recordAudit(vault, { action: "note_forked", actor: by, before: origin.id, after: fork.id });
  return { id: fork.id, forkedFrom: origin.id };
}

/** Open a merge-back proposal: the fork's current content as an edit_note
 *  proposal against its origin. Returns the proposal id. */
export async function proposeMerge(
  vault: ServiceVault,
  forkId: string,
  by: string,
): Promise<{ proposalId: string; target: string }> {
  const fork = await vault.getNote(forkId);
  const target = String(fork.metadata?.forked_from ?? "");
  if (!target) throw new Error("note has no forked_from ancestry — not a fork");
  // Origin must still exist (merge-back has somewhere to land).
  await vault.getNote(target);
  const payload: ContentPayload = { content: fork.content };
  const { id } = await openProposal(vault, {
    action: "edit_note",
    target,
    payload: JSON.stringify({ ...payload, merge_of: forkId }),
    openedBy: by,
  });
  await recordAudit(vault, { action: "merge_proposed", actor: by, before: forkId, after: id });
  return { proposalId: id, target };
}

/** Mark a proposal's terminal state (applied/rejected/withdrawn). Reads-then-
 *  merges so the other proposal fields survive regardless of whether the vault's
 *  PATCH merges or replaces metadata. */
export async function setProposalState(vault: ServiceVault, id: string, next: Proposal["state"]): Promise<void> {
  const note = await vault.getNote(id).catch(() => null);
  const metadata = { ...(note?.metadata ?? {}), state: next };
  await vault.updateNote(id, { metadata });
}
