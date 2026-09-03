/**
 * Commons governance routes (note-native, Decision §1). Mounted at
 * /api/governance BEFORE the gateway `api` group, so the owner short-circuit
 * never proxies these to the vault. Every write funnels through the service's
 * single `mutateGovernance` choke point, which enforces the bootstrap lock
 * (Decision §2): before governance is enabled the bootstrap owner configures
 * freely; once enabled, changes require an approved `amend_governance` proposal.
 *
 * Auth: a signed-in user (session) is required for every route — reading state,
 * opening a proposal, and voting are member actions. Anonymous → 401. The
 * gateway's own routes remain the authority for CONTENT; this surface governs
 * only the `governance-*` notes.
 *
 * Until an owner bootstraps a `governance-config` note and flips `enabled`, this
 * surface is inert: `/state` reports `enabled:false`, and nothing in the live
 * content path is affected. Governance is strictly opt-in.
 */
import { Hono, type Context } from "hono";
import { config } from "../config";
import { vault } from "../parachute";
import { resolveActor } from "../auth/actor";
import {
  isLocked,
  membershipActive,
  powersForSubject,
  hasPower,
  proposalWindowExpired,
  requiredPolicy,
  subjectHoldsRole,
  evaluateProposal,
  type GovernanceState,
  type GovernanceConfig,
  type Membership,
  type Policy,
  type Power,
  type Role,
} from "../governance";
import { roleAtLeast } from "../roles";
import {
  GOV_TAGS,
  parseProposal,
  loadVotesFor,
  listAudit,
  listRevisionsFor,
} from "../governance-store";
import {
  loadGovernance,
  mutateGovernance,
  openProposal,
  upsertVote,
  getProposalRaw,
  setProposalState,
  proposalContext,
  applyContentProposal,
  revisionForProposal,
  publishRevision,
  rollbackNote,
  forkNote,
  proposeMerge,
  isContentAction,
  recordAudit,
  type GovChange,
  type ContentPayload,
  type MutateResult,
} from "../governance-service";

export const governance = new Hono();

// Every governance route needs an authenticated member; anonymous → 401.
governance.use("*", async (c, next) => {
  if (resolveActor(c).kind !== "user") return c.json({ error: "unauthorized" }, 401);
  await next();
});

/** The signed-in subject for this request (the middleware guarantees a user). */
const email = (c: Context): string => {
  const a = resolveActor(c);
  return a.kind === "user" ? a.email : "";
};

const httpFor = (r: Extract<MutateResult, { ok: false }>): 400 | 403 | 404 | 409 => {
  if (r.code === "insufficient_approvals") return 409;
  if (r.code === "not_found") return 404;
  if (r.code === "invalid_config") return 400;
  return 403;
};

/**
 * Standing to PROPOSE. Proposing is cheap for the proposer and expensive for
 * everyone who must read it, so the commons requires some prior relationship:
 * a workspace member (or above), a governance role holder, or someone who holds
 * at least one grant in this vault. A signed-in stranger with zero grants may
 * read governance but not fill the queue. (Standing ≠ eligibility to VOTE — that
 * is the policy's `eligibleRole`, checked separately.)
 */
function hasStanding(c: Context, state: GovernanceState): boolean {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return false;
  if (roleAtLeast(actor.role, "member")) return true;
  // Only grants addressed to THIS person count. `grantsForUser` also returns the
  // vault's `anyone` grants (they apply to every request), but a public
  // publication must not hand every signed-in stranger a seat at the proposal
  // queue — that would erase the standing requirement on any workspace with a
  // published tag.
  if (actor.grants.some((g) => g.subject_type === "user")) return true;
  const me = actor.email.toLowerCase();
  const now = Date.now();
  return state.memberships.some((m) => m.subject.toLowerCase() === me && membershipActive(m, now));
}

const noStanding = (c: Context) =>
  c.json(
    {
      error: "no_standing",
      detail: "proposing requires workspace membership, a governance role, or a grant in this vault",
    },
    403,
  );

// ── read state ────────────────────────────────────────────────────────────────

governance.get("/state", async (c) => {
  const state = await loadGovernance(vault, config.ownerEmail);
  const me = email(c);
  return c.json({
    enabled: state.config.enabled,
    locked: isLocked(state.config),
    config: state.config,
    roles: state.roles,
    policies: state.policies,
    myPowers: [...powersForSubject(state, me)],
    isBootstrapOwner: !isLocked(state.config) && me === state.config.bootstrapOwner,
  });
});

/** The membership roster — who holds which role (transparency for members). */
governance.get("/memberships", async (c) => {
  const state = await loadGovernance(vault, config.ownerEmail);
  return c.json({ memberships: state.memberships });
});

/** The audit trail — every governance mutation, newest first (Ostrom #4). */
governance.get("/audit", async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
  return c.json({ audit: await listAudit(vault, limit) });
});

// ── bootstrap / admin writes (funnel through the lock) ────────────────────────

async function applyDirect(c: Context, change: GovChange) {
  const state = await loadGovernance(vault, config.ownerEmail);
  const res = await mutateGovernance(vault, state, email(c), change);
  if (!res.ok) return c.json({ error: res.code, detail: res.detail }, httpFor(res));
  return c.json({ ok: true, applied: res.applied, note: res.note });
}

const asPowers = (v: unknown): Power[] => {
  const allow = new Set<string>(["review", "publish", "certify_gardener", "manage_policy", "arbitrate", "invite", "revoke", "amend_governance"]);
  return Array.isArray(v) ? (v.map(String).filter((p) => allow.has(p)) as Power[]) : [];
};

governance.post("/config", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const cfg: GovernanceConfig = {
    enabled: Boolean(b.enabled),
    bootstrapOwner: String(b.bootstrapOwner ?? config.ownerEmail),
    amendPolicy: String(b.amendPolicy ?? ""),
    defaultThresholdN: Number(b.defaultThresholdN ?? 1),
    defaultEligibleRole: String(b.defaultEligibleRole ?? ""),
  };
  return applyDirect(c, { kind: "set_config", config: cfg });
});

governance.post("/roles", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const role: Omit<Role, "id"> = {
    name: String(b.name ?? ""),
    powers: asPowers(b.powers),
    scopeType: b.scopeType === "tag" ? "tag" : "global",
    scope: String(b.scope ?? ""),
  };
  if (!role.name) return c.json({ error: "bad_request", detail: "role name required" }, 400);
  return applyDirect(c, { kind: "add_role", role });
});

governance.post("/policies", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const policy: Omit<Policy, "id"> = {
    action: String(b.action ?? ""),
    scopeType: b.scopeType === "note" ? "note" : b.scopeType === "tag" ? "tag" : "global",
    scope: String(b.scope ?? ""),
    thresholdN: Math.max(1, Number(b.thresholdN ?? 1)),
    quorum: Math.max(0, Number(b.quorum ?? 0)),
    distinctRequired: b.distinctRequired !== false,
    eligibleRole: String(b.eligibleRole ?? ""),
    windowSeconds: Math.max(0, Number(b.windowSeconds ?? 0)),
    autoPublish: Boolean(b.autoPublish),
  };
  if (!policy.action) return c.json({ error: "bad_request", detail: "policy action required" }, 400);
  return applyDirect(c, { kind: "add_policy", policy });
});

governance.post("/memberships", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const membership: Membership = {
    subject: String(b.subject ?? "").toLowerCase(),
    role: String(b.role ?? ""),
    grantedBy: email(c),
    expiresAt: b.expiresAt ? String(b.expiresAt) : null,
  };
  if (!membership.subject || !membership.role) return c.json({ error: "bad_request", detail: "subject and role required" }, 400);
  return applyDirect(c, { kind: "add_membership", membership });
});

// ── update / remove (bootstrap fixups; post-lock these 403 → amendment) ───────
// Same choke point as everything else: `applyDirect` → `mutateGovernance`, so
// while unlocked only the bootstrap owner may use them, and once locked they
// refuse with `requires_proposal` — no bypass, just an ergonomic surface for
// correcting a mistyped role/policy/membership before ratification.

governance.patch("/roles/:ref", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const patch: Partial<Omit<Role, "id">> = {};
  if (typeof b.name === "string" && b.name) patch.name = b.name;
  if (Array.isArray(b.powers)) patch.powers = asPowers(b.powers);
  if (b.scopeType === "tag" || b.scopeType === "global") patch.scopeType = b.scopeType;
  if (typeof b.scope === "string") patch.scope = b.scope;
  return applyDirect(c, { kind: "update_role", ref: c.req.param("ref"), role: patch });
});

governance.delete("/roles/:ref", (c) => applyDirect(c, { kind: "remove_role", ref: c.req.param("ref") }));

governance.patch("/policies/:ref", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const patch: Partial<Omit<Policy, "id">> = {};
  if (typeof b.action === "string" && b.action) patch.action = b.action;
  if (b.scopeType === "note" || b.scopeType === "tag" || b.scopeType === "global") patch.scopeType = b.scopeType;
  if (typeof b.scope === "string") patch.scope = b.scope;
  if (b.thresholdN !== undefined) patch.thresholdN = Math.max(1, Number(b.thresholdN) || 1);
  if (b.quorum !== undefined) patch.quorum = Math.max(0, Number(b.quorum) || 0);
  if (b.distinctRequired !== undefined) patch.distinctRequired = b.distinctRequired !== false;
  if (typeof b.eligibleRole === "string") patch.eligibleRole = b.eligibleRole;
  if (b.windowSeconds !== undefined) patch.windowSeconds = Math.max(0, Number(b.windowSeconds) || 0);
  if (b.autoPublish !== undefined) patch.autoPublish = Boolean(b.autoPublish);
  return applyDirect(c, { kind: "update_policy", ref: c.req.param("ref"), policy: patch });
});

governance.delete("/policies/:ref", (c) => applyDirect(c, { kind: "remove_policy", ref: c.req.param("ref") }));

governance.delete("/memberships", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const subject = String(b.subject ?? "").toLowerCase();
  const role = String(b.role ?? "");
  if (!subject || !role) return c.json({ error: "bad_request", detail: "subject and role required" }, 400);
  return applyDirect(c, { kind: "remove_membership", subject, role });
});

// ── proposals ─────────────────────────────────────────────────────────────────

governance.get("/proposals", async (c) => {
  const wantState = c.req.query("state");
  const notes = await vault.listNotes({ tags: [GOV_TAGS.proposal] });
  const proposals = notes.map(parseProposal).filter((p) => !wantState || p.state === wantState);
  return c.json({ proposals });
});

governance.get("/proposals/:id", async (c) => {
  const state = await loadGovernance(vault, config.ownerEmail);
  const raw = await getProposalRaw(vault, c.req.param("id"));
  if (!raw) return c.json({ error: "not_found" }, 404);
  const { proposal, payload } = raw;
  const ctx = await proposalContext(vault, proposal, payload as ContentPayload);
  const votes = await loadVotesFor(vault, proposal.id);
  const evaluation = evaluateProposal(state, proposal, votes, ctx);
  return c.json({ proposal, votes, evaluation });
});

/** Open a proposal. Proposing ≠ deciding — any member may open one. The payload
 *  is a JSON-encoded GovChange for governance amendments. */
governance.post("/proposals", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const action = String(b.action ?? "");
  const target = String(b.target ?? "");
  if (!action) return c.json({ error: "bad_request", detail: "action required" }, 400);
  if (!hasStanding(c, await loadGovernance(vault, config.ownerEmail))) return noStanding(c);
  const payload = typeof b.payload === "string" ? b.payload : JSON.stringify(b.payload ?? {});
  const { id } = await openProposal(vault, { action, target, payload, openedBy: email(c) });
  return c.json({ ok: true, id }, 201);
});

/** Propose a CONTENT change — an edit to a note or a brand-new entry (which may
 *  be a stub for a researcher/AI to fill in). Any member may propose; whether it
 *  goes live is decided by the per-tag policy at apply time. */
governance.post("/content/propose", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const action = b.action === "new_entry" ? "new_entry" : b.action === "edit_note" ? "edit_note" : "";
  if (!action) return c.json({ error: "bad_request", detail: "action must be edit_note or new_entry" }, 400);
  const target = String(b.target ?? "");
  if (action === "edit_note" && !target) return c.json({ error: "bad_request", detail: "edit_note requires a target note id" }, 400);
  if (!hasStanding(c, await loadGovernance(vault, config.ownerEmail))) return noStanding(c);

  const payload: ContentPayload = coerceContentPayload(b);
  const { id } = await openProposal(vault, {
    action,
    target: target || (payload.path ?? ""),
    payload: JSON.stringify(payload),
    openedBy: email(c),
  });
  return c.json({ ok: true, id }, 201);
});

governance.post("/proposals/:id/vote", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const decision = b.vote === "reject" ? "reject" : "approve";
  const state = await loadGovernance(vault, config.ownerEmail);
  const raw = await getProposalRaw(vault, c.req.param("id"));
  if (!raw) return c.json({ error: "not_found" }, 404);
  const { proposal, payload } = raw;
  if (proposal.state !== "open") return c.json({ error: "closed", detail: `proposal is ${proposal.state}` }, 409);

  // Eligibility is scoped by the proposal's context (the target note's tags for
  // an edit, the proposed tags for a new entry) so a gardener-of-#medicine may
  // only sign off within #medicine.
  const ctx = await proposalContext(vault, proposal, payload as ContentPayload);
  const policy = requiredPolicy(state, proposal.action, ctx);

  // The window is an objective fact about the proposal, not a privilege: the
  // first request to touch an expired proposal closes it, whoever they are.
  if (proposalWindowExpired(policy, proposal)) {
    await setProposalState(vault, proposal.id, "rejected");
    await recordAudit(vault, { action: "proposal_window_expired", actor: email(c), before: proposal.id });
    return c.json({ error: "window_expired", detail: `the ${policy.windowSeconds}s voting window has closed` }, 409);
  }

  const me = email(c);
  if (!subjectHoldsRole(state, me, policy.eligibleRole, ctx)) {
    return c.json({ error: "ineligible", detail: `only members of role "${policy.eligibleRole}" may vote on this` }, 403);
  }
  // Votes are MUTABLE while a proposal is open — a second vote revises the first
  // (one note per voter, so the distinct-approver tally stays honest).
  const { updated } = await upsertVote(vault, {
    proposal: proposal.id,
    voter: me,
    vote: decision,
    at: new Date().toISOString(),
    reason: String(b.reason ?? ""),
  });
  return c.json({ ok: true, updated });
});

/** Apply an approved proposal — effect the change if its votes clear the policy.
 *  Governance amendments go through the constitutional threshold (mutateGovernance);
 *  content proposals (edit_note/new_entry) go through their per-tag policy and, if
 *  satisfied, write the change live. */
governance.post("/proposals/:id/apply", async (c) => {
  const state = await loadGovernance(vault, config.ownerEmail);
  const raw = await getProposalRaw(vault, c.req.param("id"));
  if (!raw) return c.json({ error: "not_found" }, 404);
  const { proposal, payload } = raw;
  if (proposal.state !== "open") return c.json({ error: "closed", detail: `proposal is ${proposal.state}` }, 409);
  const me = email(c);
  const votes = await loadVotesFor(vault, proposal.id);

  // An expired proposal that did NOT gather its approvals in-window is dead:
  // close it here rather than letting it linger as permanently-appliable. (If the
  // votes DID land in-window the evaluation is satisfied and it applies normally,
  // whenever someone gets around to pressing apply.)
  const applyCtx = await proposalContext(vault, proposal, payload as ContentPayload);
  const applyPolicy = requiredPolicy(state, proposal.action, applyCtx);
  if (proposalWindowExpired(applyPolicy, proposal)) {
    const ev = evaluateProposal(state, proposal, votes, applyCtx);
    if (!ev.satisfied) {
      await setProposalState(vault, proposal.id, "rejected");
      await recordAudit(vault, { action: "proposal_window_expired", actor: me, before: proposal.id });
      return c.json({ error: "window_expired", detail: `the ${applyPolicy.windowSeconds}s voting window closed unsatisfied`, evaluation: ev }, 409);
    }
  }

  // Governance amendment — constitutional threshold, via the lock choke point.
  if (proposal.action === "amend_governance") {
    const change = coerceChange(payload);
    if (!change) return c.json({ error: "bad_payload", detail: "proposal payload is not a valid governance change" }, 400);
    const res = await mutateGovernance(vault, state, me, change, { proposal, votes });
    if (!res.ok) return c.json({ error: res.code, detail: res.detail, evaluation: res.evaluation }, httpFor(res));
    await setProposalState(vault, proposal.id, "applied");
    return c.json({ ok: true, applied: res.applied, note: res.note });
  }

  // Content proposal — per-tag policy. When satisfied: snapshot a revision and
  // either go live now (policy.auto_publish) or stay STAGED for an explicit
  // publish (approval ≠ publishing, G4).
  if (isContentAction(proposal.action)) {
    const cp = coerceContentPayload(payload);
    const ev = evaluateProposal(state, proposal, votes, applyCtx);
    if (!ev.satisfied) {
      return c.json(
        {
          error: "insufficient_approvals",
          detail: `needs ${ev.needed} approvals from role "${ev.policy.eligibleRole}" (has ${ev.approvals}${ev.quorumMet ? "" : ", quorum not met"})`,
          evaluation: ev,
        },
        409,
      );
    }
    const result = await applyContentProposal(vault, proposal, cp, { author: me, autoPublish: ev.policy.autoPublish });
    await setProposalState(vault, proposal.id, result.published ? "applied" : "approved");
    await recordAudit(vault, {
      action: `apply:${proposal.action}${result.published ? "" : ":staged"}`,
      actor: me,
      after: result.noteId ?? result.revisionId,
    });
    return c.json({ ok: true, applied: proposal.action, ...result });
  }

  return c.json({ error: "unsupported", detail: `unknown proposal action "${proposal.action}"` }, 400);
});

/** Publish an APPROVED (staged) content proposal's revision — the explicit
 *  go-live step. Requires the `publish` power (scope-aware to the note's tags). */
governance.post("/proposals/:id/publish", async (c) => {
  const state = await loadGovernance(vault, config.ownerEmail);
  const raw = await getProposalRaw(vault, c.req.param("id"));
  if (!raw) return c.json({ error: "not_found" }, 404);
  const { proposal, payload } = raw;
  if (proposal.state !== "approved") {
    return c.json({ error: "not_approved", detail: `proposal is ${proposal.state}; only approved (staged) proposals publish` }, 409);
  }
  const me = email(c);
  const ctx = await proposalContext(vault, proposal, payload as ContentPayload);
  if (!hasPower(state, me, "publish", ctx)) {
    return c.json({ error: "forbidden", detail: "publishing requires the publish power" }, 403);
  }
  const rev = await revisionForProposal(vault, proposal.id);
  if (!rev) return c.json({ error: "no_revision", detail: "no staged revision found for this proposal" }, 409);
  if (rev.published) return c.json({ error: "already_published" }, 409);
  const { noteId } = await publishRevision(vault, rev.id, me);
  await setProposalState(vault, proposal.id, "applied");
  return c.json({ ok: true, noteId, revisionId: rev.id });
});

/** Revision history for a note, newest first. */
governance.get("/notes/:id/revisions", async (c) => {
  const revisions = await listRevisionsFor(vault, c.req.param("id"));
  return c.json({ revisions });
});

/** Roll a note back to a prior revision (non-destructive — the rollback is
 *  itself a new revision). Requires the `publish` power. */
governance.post("/notes/:id/rollback", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const revisionId = String(b.revision ?? "");
  if (!revisionId) return c.json({ error: "bad_request", detail: "revision required" }, 400);
  const noteId = c.req.param("id");
  const state = await loadGovernance(vault, config.ownerEmail);
  const me = email(c);
  const target = await vault.getNote(noteId).catch(() => null);
  if (!target) return c.json({ error: "not_found" }, 404);
  if (!hasPower(state, me, "publish", { noteId, tags: target.tags ?? [] })) {
    return c.json({ error: "forbidden", detail: "rollback requires the publish power" }, 403);
  }
  try {
    const r = await rollbackNote(vault, noteId, revisionId, me);
    return c.json({ ok: true, revisionId: r.revisionId });
  } catch (e) {
    return c.json({ error: "rollback_failed", detail: (e as Error).message }, 400);
  }
});

// ── fork / merge-back (G5 — proposal-only merge) ──────────────────────────────

/** Fork a note: any member may take a divergent copy (with ancestry pointers).
 *  The fork does not sync with its origin. */
governance.post("/fork", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const noteId = String(b.noteId ?? "");
  if (!noteId) return c.json({ error: "bad_request", detail: "noteId required" }, 400);
  try {
    const fork = await forkNote(vault, noteId, email(c));
    return c.json({ ok: true, ...fork }, 201);
  } catch (e) {
    return c.json({ error: "fork_failed", detail: (e as Error).message }, 400);
  }
});

/** Propose merging a fork's content back into its origin — an ordinary
 *  edit_note proposal, gated by the origin's per-tag policy like any change. */
governance.post("/forks/:id/propose-merge", async (c) => {
  try {
    const r = await proposeMerge(vault, c.req.param("id"), email(c));
    return c.json({ ok: true, ...r }, 201);
  } catch (e) {
    return c.json({ error: "merge_propose_failed", detail: (e as Error).message }, 400);
  }
});

/** Withdraw an open proposal. Only the proposer (or the owner) may close it. */
governance.post("/proposals/:id/withdraw", async (c) => {
  const proposal = await getProposalRaw(vault, c.req.param("id"));
  if (!proposal) return c.json({ error: "not_found" }, 404);
  if (proposal.proposal.state !== "open") return c.json({ error: "closed", detail: `proposal is ${proposal.proposal.state}` }, 409);
  const actor = resolveActor(c);
  const me = actor.kind === "user" ? actor.email : "";
  // "Owner" here is the vault owner specifically (the pre-role-model `isOwner`),
  // not any admin — every Actor kind carries `role`, so no narrowing needed.
  if (proposal.proposal.openedBy !== me && actor.role !== "owner") {
    return c.json({ error: "forbidden", detail: "only the proposer or owner may withdraw" }, 403);
  }
  await setProposalState(vault, proposal.proposal.id, "withdrawn");
  await recordAudit(vault, { action: "proposal_withdrawn", actor: me, before: proposal.proposal.id });
  return c.json({ ok: true });
});

// ── payload coercion (shared by propose + apply) ───────────────────────────────

/** Sanitize an untrusted object into a ContentPayload (only the allowed keys). */
function coerceContentPayload(obj: unknown): ContentPayload {
  const o = (obj ?? {}) as Record<string, unknown>;
  const out: ContentPayload = {};
  if (typeof o.content === "string") out.content = o.content;
  if (o.metadata && typeof o.metadata === "object" && !Array.isArray(o.metadata)) out.metadata = o.metadata as Record<string, unknown>;
  if (Array.isArray(o.tags)) out.tags = o.tags.map(String).filter(Boolean);
  if (typeof o.path === "string" && o.path) out.path = o.path;
  return out;
}

/** Validate an untrusted object into a GovChange (or null). */
function coerceChange(obj: unknown): GovChange | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  switch (o.kind) {
    case "set_config": {
      const c = (o.config ?? {}) as Record<string, unknown>;
      return {
        kind: "set_config",
        config: {
          enabled: Boolean(c.enabled),
          bootstrapOwner: String(c.bootstrapOwner ?? ""),
          amendPolicy: String(c.amendPolicy ?? ""),
          defaultThresholdN: Number(c.defaultThresholdN ?? 1),
          defaultEligibleRole: String(c.defaultEligibleRole ?? ""),
        },
      };
    }
    case "add_role": {
      const r = (o.role ?? {}) as Record<string, unknown>;
      if (!r.name) return null;
      return {
        kind: "add_role",
        role: {
          name: String(r.name),
          powers: asPowers(r.powers),
          scopeType: r.scopeType === "tag" ? "tag" : "global",
          scope: String(r.scope ?? ""),
        },
      };
    }
    case "add_policy": {
      const p = (o.policy ?? {}) as Record<string, unknown>;
      if (!p.action) return null;
      return {
        kind: "add_policy",
        policy: {
          action: String(p.action),
          scopeType: p.scopeType === "note" ? "note" : p.scopeType === "tag" ? "tag" : "global",
          scope: String(p.scope ?? ""),
          thresholdN: Math.max(1, Number(p.thresholdN ?? 1)),
          quorum: Math.max(0, Number(p.quorum ?? 0)),
          distinctRequired: p.distinctRequired !== false,
          eligibleRole: String(p.eligibleRole ?? ""),
          windowSeconds: Math.max(0, Number(p.windowSeconds ?? 0)),
          autoPublish: Boolean(p.autoPublish),
        },
      };
    }
    case "update_role": {
      const ref = String(o.ref ?? "");
      if (!ref) return null;
      const r = (o.role ?? {}) as Record<string, unknown>;
      const patch: Partial<Omit<Role, "id">> = {};
      if (r.name !== undefined) patch.name = String(r.name);
      if (r.powers !== undefined) patch.powers = asPowers(r.powers);
      if (r.scopeType !== undefined) patch.scopeType = r.scopeType === "tag" ? "tag" : "global";
      if (r.scope !== undefined) patch.scope = String(r.scope);
      return { kind: "update_role", ref, role: patch };
    }
    case "remove_role": {
      const ref = String(o.ref ?? "");
      return ref ? { kind: "remove_role", ref } : null;
    }
    case "update_policy": {
      const ref = String(o.ref ?? "");
      if (!ref) return null;
      const p = (o.policy ?? {}) as Record<string, unknown>;
      const patch: Partial<Omit<Policy, "id">> = {};
      if (p.action !== undefined) patch.action = String(p.action);
      if (p.scopeType !== undefined) patch.scopeType = p.scopeType === "note" ? "note" : p.scopeType === "tag" ? "tag" : "global";
      if (p.scope !== undefined) patch.scope = String(p.scope);
      if (p.thresholdN !== undefined) patch.thresholdN = Math.max(1, Number(p.thresholdN));
      if (p.quorum !== undefined) patch.quorum = Math.max(0, Number(p.quorum));
      if (p.distinctRequired !== undefined) patch.distinctRequired = p.distinctRequired !== false;
      if (p.eligibleRole !== undefined) patch.eligibleRole = String(p.eligibleRole);
      if (p.windowSeconds !== undefined) patch.windowSeconds = Math.max(0, Number(p.windowSeconds));
      if (p.autoPublish !== undefined) patch.autoPublish = Boolean(p.autoPublish);
      return { kind: "update_policy", ref, policy: patch };
    }
    case "remove_policy": {
      const ref = String(o.ref ?? "");
      return ref ? { kind: "remove_policy", ref } : null;
    }
    case "add_membership": {
      const m = (o.membership ?? {}) as Record<string, unknown>;
      if (!m.subject || !m.role) return null;
      return {
        kind: "add_membership",
        membership: {
          subject: String(m.subject).toLowerCase(),
          role: String(m.role),
          grantedBy: m.grantedBy ? String(m.grantedBy) : undefined,
          expiresAt: m.expiresAt ? String(m.expiresAt) : null,
        },
      };
    }
    case "remove_membership": {
      const subject = String(o.subject ?? "").toLowerCase();
      const role = String(o.role ?? "");
      return subject && role ? { kind: "remove_membership", subject, role } : null;
    }
    default:
      return null;
  }
}
