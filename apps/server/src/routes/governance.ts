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
  powersForSubject,
  requiredPolicy,
  subjectHoldsRole,
  evaluateProposal,
  type GovernanceConfig,
  type Membership,
  type Policy,
  type Power,
  type Role,
} from "../governance";
import {
  GOV_TAGS,
  parseProposal,
  loadVotesFor,
  listAudit,
} from "../governance-store";
import {
  loadGovernance,
  mutateGovernance,
  openProposal,
  castVote,
  hasVoted,
  getProposalRaw,
  setProposalState,
  proposalContext,
  applyContentProposal,
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

const httpFor = (r: Extract<MutateResult, { ok: false }>): 403 | 409 =>
  r.code === "insufficient_approvals" ? 409 : 403;

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
  const me = email(c);
  if (!subjectHoldsRole(state, me, policy.eligibleRole, ctx)) {
    return c.json({ error: "ineligible", detail: `only members of role "${policy.eligibleRole}" may vote on this` }, 403);
  }
  if (await hasVoted(vault, proposal.id, me)) {
    return c.json({ error: "already_voted" }, 409);
  }
  await castVote(vault, { proposal: proposal.id, voter: me, vote: decision, at: new Date().toISOString(), reason: String(b.reason ?? "") });
  return c.json({ ok: true });
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

  // Governance amendment — constitutional threshold, via the lock choke point.
  if (proposal.action === "amend_governance") {
    const change = coerceChange(payload);
    if (!change) return c.json({ error: "bad_payload", detail: "proposal payload is not a valid governance change" }, 400);
    const res = await mutateGovernance(vault, state, me, change, { proposal, votes });
    if (!res.ok) return c.json({ error: res.code, detail: res.detail, evaluation: res.evaluation }, httpFor(res));
    await setProposalState(vault, proposal.id, "applied");
    return c.json({ ok: true, applied: res.applied, note: res.note });
  }

  // Content proposal — per-tag policy; write the change live when satisfied.
  if (isContentAction(proposal.action)) {
    const cp = coerceContentPayload(payload);
    const ctx = await proposalContext(vault, proposal, cp);
    const ev = evaluateProposal(state, proposal, votes, ctx);
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
    const written = await applyContentProposal(vault, proposal, cp);
    await setProposalState(vault, proposal.id, "applied");
    await recordAudit(vault, { action: `apply:${proposal.action}`, actor: me, after: written.id });
    return c.json({ ok: true, applied: proposal.action, note: written });
  }

  return c.json({ error: "unsupported", detail: `unknown proposal action "${proposal.action}"` }, 400);
});

/** Withdraw an open proposal. Only the proposer (or the owner) may close it. */
governance.post("/proposals/:id/withdraw", async (c) => {
  const proposal = await getProposalRaw(vault, c.req.param("id"));
  if (!proposal) return c.json({ error: "not_found" }, 404);
  if (proposal.proposal.state !== "open") return c.json({ error: "closed", detail: `proposal is ${proposal.proposal.state}` }, 409);
  const actor = resolveActor(c);
  const me = actor.kind === "user" ? actor.email : "";
  if (proposal.proposal.openedBy !== me && !actor.isOwner) {
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
    default:
      return null;
  }
}
