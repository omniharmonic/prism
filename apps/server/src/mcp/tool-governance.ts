/**
 * Governance tools, resources and prompts (Architecture v2 WP6.4).
 *
 * Every call is an in-process dispatch to the EXISTING `/api/governance/*`
 * routes, as the caller's actor — so standing, voting eligibility (the policy's
 * eligible role, scoped by the target's tags), the content-proposal rules, the
 * signed-note integrity layer and `mutateGovernance` are the web app's. Nothing
 * here writes a governance note or touches the vault directly.
 *
 * Deliberately NOT exposed (per the MCP design): constitution/config/role/policy/
 * membership edits, amendment proposals, voting on or applying an
 * `amend_governance` proposal, and publishing a staged revision. An agent may
 * propose CONTENT changes, sign off on CONTENT proposals within its own role, and
 * withdraw its own proposals — constitutional power changes hands only through
 * the web app.
 */
import * as z from "zod/v4";
import { renderConstitution } from "@prism/core/governance-prose";
import { config } from "../config";
import { membershipActive } from "../governance";
import { loadGovernance } from "../governance-service";
import { vault } from "../parachute";
import { roleAtLeast } from "../roles";
import type { McpPrincipal } from "./auth";
import { jsonOrToolError } from "./dispatch";
import { ToolError } from "./errors";
import { defineTool, type PrismPrompt, type PrismResource, type PrismTool, type ToolContext } from "./tools";

const enc = encodeURIComponent;
const CONTENT_ACTIONS = new Set(["edit_note", "new_entry"]);
const MAX_ROWS = 200;
const PAYLOAD_PREVIEW = 1_500;

/**
 * Early, cosmetic gate: a signed-in user with STANDING: workspace member, a grant
 * in this vault, or an active governance membership (a role holder may have no
 * content grant at all). Standing and voting eligibility are still decided by the
 * governance routes; this only keeps the tools out of a stranger's tools/list. The
 * governance lookup is cached briefly per user (access runs on every /mcp request).
 */
const STANDING_TTL_MS = 15_000;
const standingCache = new Map<string, { at: number; ok: boolean }>();
async function hasStanding(p: McpPrincipal): Promise<boolean> {
  if (p.actor.kind !== "user") return false;
  if (roleAtLeast(p.actor.role, "member") || p.actor.grants.some((g) => g.subject_type === "user")) return true;
  const key = p.actor.email.toLowerCase();
  const hit = standingCache.get(key);
  if (hit && Date.now() - hit.at < STANDING_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const state = await loadGovernance(vault, config.ownerEmail);
    const now = Date.now();
    ok = state.memberships.some((m) => m.subject.toLowerCase() === key && membershipActive(m, now));
  } catch {
    ok = false; // fail closed
  }
  standingCache.set(key, { at: Date.now(), ok });
  return ok;
}

async function gov<T = Record<string, any>>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  return jsonOrToolError<T>(await ctx.dispatch(`/api/governance${path}`, init));
}

const clip = (s: unknown, n: number): string => {
  const str = typeof s === "string" ? s : "";
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

const proposalRow = (p: Record<string, any>) => ({
  id: p.id,
  action: p.action,
  target: p.target ?? "",
  state: p.state,
  openedBy: p.openedBy,
  openedAt: p.openedAt,
});

/** The proposal payload as a voter should see it: bounded, content proposals only. */
function payloadView(payload: unknown): Record<string, unknown> {
  const o = (payload ?? {}) as Record<string, any>;
  return {
    ...(typeof o.content === "string" ? { content: clip(o.content, PAYLOAD_PREVIEW), contentLength: o.content.length } : {}),
    ...(Array.isArray(o.tags) ? { tags: o.tags } : {}),
    ...(typeof o.path === "string" ? { path: o.path } : {}),
    ...(typeof o.rationale === "string" ? { rationale: o.rationale } : {}),
  };
}

// ── prism_governance_state ──────────────────────────────────────────────────

export const governanceStateTool = defineTool({
  name: "prism_governance_state",
  scope: "read",
  title: "Governance state",
  description:
    "The commons' governance at a glance: whether governance is enabled/locked, the roles and per-action policies (who may " +
    "vote, how many approvals), YOUR standing (powers, roles you hold, grants) and the roster of role holders, plus the open " +
    "proposals. Use it to learn whether proposing or voting is open to you before calling prism_propose_change / prism_vote. " +
    "Read-only; takes no arguments.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: hasStanding,
  async handler(_a, ctx) {
    const [state, me, roster, open] = await Promise.all([
      gov(ctx, "/state"),
      gov(ctx, "/me"),
      gov(ctx, "/memberships"),
      gov<{ proposals: Array<Record<string, any>> }>(ctx, "/proposals?state=open"),
    ]);
    const memberships = (roster.memberships ?? []) as Array<Record<string, any>>;
    return {
      enabled: Boolean(state.enabled),
      locked: Boolean(state.locked),
      roles: state.roles ?? [],
      policies: state.policies ?? [],
      me: { subject: me.subject, workspaceRole: me.workspaceRole, powers: me.powers, memberships: me.memberships, grants: me.grants },
      memberships: memberships.slice(0, MAX_ROWS),
      membershipsTruncated: memberships.length > MAX_ROWS,
      openProposals: (open.proposals ?? []).slice(0, MAX_ROWS).map(proposalRow),
    };
  },
});

// ── prism_propose_change ────────────────────────────────────────────────────

export const proposeChangeTool = defineTool({
  name: "prism_propose_change",
  scope: "write",
  title: "Propose a content change",
  description:
    "Open a governance proposal for a CONTENT change: `edit_note` (replace the content of the note `target`, which you must be " +
    "able to view) or `new_entry` (a new note — give `tags`, and optionally `path`). It does NOT change anything by itself: the " +
    "commons' per-tag policy decides, after eligible members vote (prism_vote). Requires standing (workspace membership, a " +
    "governance role or a grant). `rationale` is REQUIRED and is shown to the voters. Constitution/role/policy changes are not " +
    "available through MCP.",
  inputSchema: z.object({
    action: z.enum(["edit_note", "new_entry"]),
    target: z.string().min(1).max(200).optional().describe("Note id (required for edit_note)"),
    content: z.string().max(500_000).describe("The proposed full content of the note"),
    tags: z.array(z.string().min(1).max(200)).max(50).optional().describe("Tags for a new_entry (they select the policy)"),
    path: z.string().min(1).max(500).optional().describe("Path for a new_entry"),
    rationale: z.string().min(1).max(2000).describe("Why — shown to the voters"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  access: hasStanding,
  async handler(a, ctx) {
    if (a.action === "edit_note") {
      if (!a.target) throw new ToolError("invalid_request", "edit_note requires a target note id");
      // You may only propose changes to notes you can see (and this keeps the target from being probed).
      const res = await ctx.dispatch(`/api/notes/${enc(a.target)}`);
      if (!res.ok) throw new ToolError("not_found", "target note not found");
    }
    const r = await gov<{ id: string }>(ctx, "/content/propose", {
      method: "POST",
      body: JSON.stringify({ action: a.action, target: a.target ?? "", content: a.content, tags: a.tags, path: a.path, rationale: a.rationale }),
    });
    return { proposal_id: r.id, action: a.action, target: a.target ?? a.path ?? "", state: "open" };
  },
});

// ── prism_vote ──────────────────────────────────────────────────────────────

export const voteTool = defineTool({
  name: "prism_vote",
  scope: "write",
  title: "Vote on a content proposal",
  description:
    "Sign off (`approve`) or decline (`reject`) an OPEN content proposal (edit_note / new_entry), as YOU. Allowed only if you hold " +
    "the policy's eligible role for that proposal's tags; otherwise refused. You may revise your vote while it is open. After an " +
    "approval, if the policy's threshold is now met the change is applied (set apply=false to only record the vote); a policy " +
    "that stages content needs an explicit publish in the web app, which MCP never does. Constitutional (amend_governance) " +
    "proposals cannot be voted on through MCP. Read the proposal first (prism_governance_state, or the review-open-proposals prompt).",
  inputSchema: z.object({
    proposal_id: z.string().min(1).max(200),
    vote: z.enum(["approve", "reject"]),
    reason: z.string().max(2000).optional().describe("Shown in the audit of the vote"),
    apply: z.boolean().optional().describe("Apply the proposal if this vote clears the threshold (default true)"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  access: hasStanding,
  async handler(a, ctx) {
    const detail = await gov<{ proposal: Record<string, any> }>(ctx, `/proposals/${enc(a.proposal_id)}`);
    const action = String(detail.proposal?.action ?? "");
    if (!CONTENT_ACTIONS.has(action)) {
      throw new ToolError("forbidden", "only content proposals (edit_note / new_entry) can be voted on through MCP — constitutional changes are decided in the web app");
    }
    const res = await ctx.dispatch(`/api/governance/proposals/${enc(a.proposal_id)}/vote`, {
      method: "POST",
      body: JSON.stringify({ vote: a.vote, reason: a.reason ?? "" }),
    });
    if (res.status === 403) {
      const b = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new ToolError("forbidden", b.detail ?? "you are not eligible to vote on this proposal");
    }
    if (res.status === 409) {
      const b = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new ToolError("conflict", b.detail ?? "this proposal is no longer open");
    }
    const voted = await jsonOrToolError<{ updated?: boolean }>(res);
    const out: Record<string, unknown> = { proposal_id: a.proposal_id, vote: a.vote, revised: Boolean(voted.updated), outcome: "recorded" };
    if (a.vote !== "approve" || a.apply === false) return out;

    // The threshold may now be met — try to apply. "Not enough approvals yet" is the normal case, not an error.
    const applied = await ctx.dispatch(`/api/governance/proposals/${enc(a.proposal_id)}/apply`, { method: "POST", body: JSON.stringify({}) });
    const body = (await applied.json().catch(() => ({}))) as Record<string, any>;
    if (applied.ok) {
      return { ...out, outcome: body.published ? "applied" : "approved_staged", published: Boolean(body.published), noteId: body.noteId ?? null };
    }
    if (body.error === "insufficient_approvals") {
      const ev = body.evaluation ?? {};
      return { ...out, outcome: "pending", approvals: ev.approvals ?? null, needed: ev.needed ?? null };
    }
    return { ...out, outcome: "recorded", applyError: body.error ?? `status ${applied.status}` };
  },
});

// ── prism_withdraw_proposal ─────────────────────────────────────────────────

export const withdrawProposalTool = defineTool({
  name: "prism_withdraw_proposal",
  scope: "write",
  title: "Withdraw my proposal",
  description: "Withdraw an open proposal YOU opened. Only the proposer may do this through MCP.",
  inputSchema: z.object({ proposal_id: z.string().min(1).max(200) }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: hasStanding,
  async handler({ proposal_id }, ctx) {
    const detail = await gov<{ proposal: Record<string, any> }>(ctx, `/proposals/${enc(proposal_id)}`);
    const me = ctx.principal.actor.email.toLowerCase();
    if (String(detail.proposal?.openedBy ?? "").toLowerCase() !== me) {
      throw new ToolError("forbidden", "only the proposer may withdraw a proposal");
    }
    await gov(ctx, `/proposals/${enc(proposal_id)}/withdraw`, { method: "POST", body: JSON.stringify({}) });
    return { ok: true, proposal_id, state: "withdrawn" };
  },
});

export const GOVERNANCE_TOOLS = [governanceStateTool, proposeChangeTool, voteTool, withdrawProposalTool] as unknown as PrismTool[];

// ── resources ───────────────────────────────────────────────────────────────

export const constitutionResource: PrismResource = {
  name: "prism-governance-constitution",
  uriTemplate: "prism://governance/constitution",
  title: "Governance constitution",
  description: "The commons' constitution as readable Markdown (roles, powers, policies). Rendered from the live governance state; contains no email addresses.",
  mimeType: "text/markdown",
  cacheHint: { ttlMs: 0, cacheScope: "private" },
  access: hasStanding,
  async read(uri, _vars, ctx) {
    const [state, roster] = await Promise.all([gov(ctx, "/state"), gov(ctx, "/memberships")]);
    const md = renderConstitution({ config: state.config, roles: state.roles, policies: state.policies, memberships: roster.memberships ?? [] } as never);
    return [{ uri: uri.href, mimeType: "text/markdown", text: md }];
  },
};

export const meResource: PrismResource = {
  name: "prism-me",
  uriTemplate: "prism://me",
  title: "Me (Prism)",
  description: "Who this connection acts as: account, workspace role, vault, read-only flag, and your governance standing (powers, roles, grants).",
  mimeType: "application/json",
  cacheHint: { ttlMs: 0, cacheScope: "private" },
  access: () => true,
  async read(uri, _vars, ctx) {
    const { actor, readOnly, via } = ctx.principal;
    const standing = actor.kind === "user" ? await gov(ctx, "/me").catch(() => null) : null;
    const body = { email: actor.email, role: actor.role, vaultId: actor.vaultId, readOnly, via, governance: standing };
    return [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }];
  },
};

export const GOVERNANCE_RESOURCES: PrismResource[] = [constitutionResource, meResource];

// ── prompts ─────────────────────────────────────────────────────────────────

const MAX_REVIEW = 10;

export const reviewOpenProposalsPrompt: PrismPrompt = {
  name: "review-open-proposals",
  title: "Review open proposals",
  description: "Walk the open content proposals you may vote on, with their proposed changes, then vote with prism_vote.",
  argsSchema: z.object({}),
  access: hasStanding,
  async build(_a, ctx) {
    const open = await gov<{ proposals: Array<Record<string, any>> }>(ctx, "/proposals?state=open");
    const rows = (open.proposals ?? []).filter((p) => CONTENT_ACTIONS.has(String(p.action))).slice(0, MAX_REVIEW);
    if (rows.length === 0) return "There are no open content proposals right now. Nothing to review.";
    const blocks: string[] = [];
    for (const p of rows) {
      const d = await gov<Record<string, any>>(ctx, `/proposals/${enc(String(p.id))}`).catch(() => null);
      if (!d) continue;
      const ev = d.evaluation ?? {};
      blocks.push(
        [
          `### Proposal ${p.id} — ${p.action} ${p.target || ""}`.trim(),
          `Opened by ${p.openedBy} at ${p.openedAt}. Approvals ${ev.approvals ?? "?"}/${ev.needed ?? "?"} from role "${ev.policy?.eligibleRole ?? "?"}".`,
          "Proposed change:",
          "```json",
          JSON.stringify(payloadView(d.payload), null, 2),
          "```",
        ].join("\n"),
      );
    }
    return [
      "Review the open content proposals below. For each one:",
      "1. For an edit_note, read the current note with prism_get_note (id = the target) and compare it to the proposed content.",
      "2. Decide whether the change is accurate, in scope and well-sourced. Read the proposer's rationale.",
      "3. If you are eligible, call prism_vote with vote=approve or vote=reject and a short reason. If you are not eligible the call is refused — say so and move on.",
      "Never approve a change you have not compared against the current note. Summarize your decisions at the end.",
      "",
      ...blocks,
    ].join("\n");
  },
};

export const summarizeCommentsPrompt: PrismPrompt = {
  name: "summarize-comments",
  title: "Summarize comments on a note",
  description: "Collect and summarize the discussion on one note you can view.",
  argsSchema: z.object({ id: z.string().min(1).max(200).describe("Note id") }),
  access: hasStanding,
  async build(args, _ctx) {
    const id = String(args.id);
    return [
      `Summarize the open discussion on note ${id}.`,
      "1. Read the note with prism_get_note (id above).",
      "2. If a comments tool is available (prism_list_comments), list the unresolved threads for the note; otherwise work from what prism_get_note returns and say that comment threads were not available.",
      "3. Produce: a one-paragraph summary of what the note is, then each unresolved thread as a bullet — who raised it, the quoted passage, the ask, and whether it looks resolved by the current text.",
      "Do not edit the note. Only report.",
    ].join("\n");
  },
};

export const editSharedDocPrompt: PrismPrompt = {
  name: "edit-shared-doc",
  title: "Edit a shared document safely",
  description: "A guided flow for changing a note according to what YOU may do to it (edit directly, suggest, or propose for review).",
  argsSchema: z.object({ id: z.string().min(1).max(200).describe("Note id") }),
  access: hasStanding,
  async build(args, ctx) {
    const id = String(args.id);
    const note = await jsonOrToolError<Record<string, any>>(await ctx.dispatch(`/api/notes/${enc(id)}`));
    // The owner/admin passthrough carries no `_caps`: those roles hold every cap.
    const caps: string[] = Array.isArray(note._caps) ? note._caps : roleAtLeast(ctx.principal.actor.role, "admin") ? ["view", "comment", "suggest", "edit", "create", "organize", "delete", "share"] : ["view"];
    const has = (c: string) => caps.includes(c);
    const steps: string[] = [`Your capabilities on note ${id}: ${caps.join(", ") || "none"}.`];
    if (has("edit")) {
      steps.push(
        "You may EDIT directly. Call prism_get_note, then prism_update_note with `if_updated_at` set to the updatedAt you just read.",
        "If the note is open in live collaborative editing (collab.live = true) content writes are refused: wait and retry, or leave a suggestion/comment instead.",
        "Make the smallest change that does the job; keep the note's existing structure and voice.",
      );
    } else if (has("suggest")) {
      steps.push(
        "You may only SUGGEST. Do not try prism_update_note (it will be refused).",
        "Use the suggestion tool (prism_suggest_edit) when it is available so the owner can accept or reject each change.",
        "If the commons runs governance (prism_governance_state → enabled) and you have standing, you can instead open a reviewed change with prism_propose_change (action=edit_note, target=this id, rationale required).",
      );
    } else if (has("comment")) {
      steps.push("You may only COMMENT. Describe the change you would make to the people who can edit; do not edit.");
    } else {
      steps.push("You may only READ this note. Do not attempt edits; report what you found.");
    }
    steps.push("Always state what you changed (or proposed) and why.");
    return steps.join("\n");
  },
};

export const GOVERNANCE_PROMPTS: PrismPrompt[] = [reviewOpenProposalsPrompt, summarizeCommentsPrompt, editSharedDocPrompt];
