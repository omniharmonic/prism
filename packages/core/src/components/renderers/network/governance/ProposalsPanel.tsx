// Proposals — the WHAT-STATE axis: a change that is not yet real, and the record
// of who has said yes.
//
// Three things this surface refuses to do. It does not show JSON as the primary
// affordance (an amendment is composed with the same role/rule editors used
// everywhere else; raw JSON survives only as an escape hatch). It does not hide
// the arithmetic — the card says "1 of 2 approvals", names the eligible role, and
// counts down the window, because "why can't I apply this yet" should never need
// a support conversation. And it does not ask anyone to approve a content change
// sight-unseen: an edit proposal renders the current text beside the proposed one.
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitPullRequest, Check, X, Send, Upload, Undo2, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../../../ui/Button";
import { Badge } from "../../../ui/Badge";
import { Input } from "../../../ui/Input";
import { ACTION_LABELS, pluralRole, renderPolicySentence, renderRoleSentence } from "../../../../lib/governance/prose";
import { govApi, type Policy, type Proposal, type ProposalDetail } from "./api";
import type { GovCtx } from "./ctx";
import { RoleForm } from "./RoleEditor";
import { PolicyForm, emptyPolicy } from "./PolicyBuilder";
import type { PolicyDraft, RoleDraft } from "./templates";
import { Field, Progress, Section, ago, countdown, row, selectStyle, sentence, subCard } from "./ui";

// ── composing an amendment ────────────────────────────────────────────────────

type AmendKind =
  | "add_role"
  | "update_role"
  | "remove_role"
  | "add_policy"
  | "update_policy"
  | "remove_policy"
  | "add_membership"
  | "remove_membership"
  | "disable";

const AMEND_LABELS: Record<AmendKind, string> = {
  add_role: "Create a role",
  update_role: "Change a role",
  remove_role: "Remove a role",
  add_policy: "Create a rule",
  update_policy: "Change a rule",
  remove_policy: "Remove a rule",
  add_membership: "Give someone a role",
  remove_membership: "Take a role away",
  disable: "Turn governance off",
};

const blankRole = (): RoleDraft => ({
  name: "",
  powers: [],
  scopeType: "global",
  scope: "",
  capabilities: ["view", "comment", "suggest"],
  assigns: [],
});

function AmendmentComposer({ ctx }: { ctx: GovCtx }) {
  const [kind, setKind] = useState<AmendKind>("add_role");
  const [roleDraft, setRoleDraft] = useState<RoleDraft>(blankRole());
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>(emptyPolicy());
  const [ref, setRef] = useState("");
  const [subject, setSubject] = useState("");
  const [memberRole, setMemberRole] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [raw, setRaw] = useState("");

  const roles = ctx.state.roles;
  const policies = ctx.state.policies;
  const roleNames = roles.map((r) => r.name);

  /** Load the selected role/rule into the editor so "change" starts from reality. */
  const selectRef = (next: string) => {
    setRef(next);
    if (kind === "update_role") {
      const r = roles.find((x) => x.id === next);
      if (r) setRoleDraft({ ...r });
    }
    if (kind === "update_policy") {
      const p = policies.find((x) => x.id === next);
      if (p) setPolicyDraft({ ...p });
    }
  };

  const change = (): Record<string, unknown> | null => {
    switch (kind) {
      case "add_role":
        return roleDraft.name.trim() ? { kind: "add_role", role: roleDraft } : null;
      case "update_role":
        return ref ? { kind: "update_role", ref, role: { ...roleDraft, id: undefined } } : null;
      case "remove_role":
        return ref ? { kind: "remove_role", ref } : null;
      case "add_policy":
        return { kind: "add_policy", policy: { ...policyDraft, id: undefined } };
      case "update_policy":
        return ref ? { kind: "update_policy", ref, policy: { ...policyDraft, id: undefined } } : null;
      case "remove_policy":
        return ref ? { kind: "remove_policy", ref } : null;
      case "add_membership":
        return subject.trim() && memberRole
          ? { kind: "add_membership", membership: { subject: subject.trim().toLowerCase(), role: memberRole } }
          : null;
      case "remove_membership":
        return subject.trim() && memberRole
          ? { kind: "remove_membership", subject: subject.trim().toLowerCase(), role: memberRole }
          : null;
      case "disable":
        return { kind: "set_config", config: { enabled: false } };
    }
  };

  const submit = async () => {
    if (advanced) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.notify("That is not valid JSON.");
        return;
      }
      await ctx.amend(parsed as Record<string, unknown>, "a hand-written amendment");
      return;
    }
    const c = change();
    if (!c) {
      ctx.notify("Fill in the amendment before opening it.");
      return;
    }
    await ctx.amend(c, AMEND_LABELS[kind].toLowerCase());
  };

  return (
    <div style={{ ...subCard, marginBottom: 14 }} data-testid="gov-amend-composer">
      <Field text="Propose a change to the constitution">
        <select
          value={kind}
          data-testid="gov-amend-kind"
          onChange={(e) => {
            setKind(e.target.value as AmendKind);
            setRef("");
          }}
          style={selectStyle}
        >
          {(Object.keys(AMEND_LABELS) as AmendKind[]).map((k) => (
            <option key={k} value={k}>
              {AMEND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        {(kind === "update_role" || kind === "remove_role") && (
          <Field text="Which role">
            <select value={ref} onChange={(e) => selectRef(e.target.value)} style={selectStyle} data-testid="gov-amend-role-ref">
              <option value="">choose…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {(kind === "add_role" || (kind === "update_role" && ref)) && (
          <RoleForm value={roleDraft} onChange={setRoleDraft} tags={ctx.tags} roleNames={roleNames} testId="gov-amend-role" />
        )}

        {(kind === "update_policy" || kind === "remove_policy") && (
          <Field text="Which rule">
            <select value={ref} onChange={(e) => selectRef(e.target.value)} style={selectStyle} data-testid="gov-amend-policy-ref">
              <option value="">choose…</option>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {renderPolicySentence(p, { roleName: p.eligibleRole || ctx.state.config.defaultEligibleRole })}
                </option>
              ))}
            </select>
          </Field>
        )}

        {(kind === "add_policy" || (kind === "update_policy" && ref)) && (
          <PolicyForm value={policyDraft} onChange={setPolicyDraft} roleNames={roleNames} tags={ctx.tags} testId="gov-amend-policy" />
        )}

        {(kind === "add_membership" || kind === "remove_membership") && (
          <div style={row}>
            <Field text="Person" width={240}>
              <Input placeholder="email@example.com" value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="gov-amend-subject" />
            </Field>
            <Field text="Role">
              <select value={memberRole} onChange={(e) => setMemberRole(e.target.value)} style={selectStyle} data-testid="gov-amend-member-role">
                <option value="">choose…</option>
                {roleNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        {kind === "disable" && (
          <p style={{ ...sentence, margin: 0, color: "var(--text-secondary)" }}>
            Turning governance off revokes every grant the constitution created. The rules stay written down; they simply
            stop applying.
          </p>
        )}

        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--text-secondary)", alignSelf: "flex-start" }}
          data-testid="gov-amend-advanced-toggle"
        >
          {advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Advanced: write the change as JSON
        </button>
        {advanced && (
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder='{"kind":"add_role","role":{"name":"gardener","powers":["publish"],"capabilities":["view","edit"]}}'
            data-testid="gov-amend-raw"
            style={{
              width: "100%",
              minHeight: 110,
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              padding: 8,
              borderRadius: 8,
              background: "var(--glass)",
              color: "var(--text-primary)",
              border: "1px solid var(--glass-border)",
            }}
          />
        )}

        <div>
          <Button variant="primary" onClick={() => void submit()} icon={<Send size={13} />} data-testid="gov-amend-open">
            Open this amendment
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── reading a proposal ────────────────────────────────────────────────────────

/** The proposal's headline in words, not in field names. */
function describe(p: Proposal, payload: unknown, state: GovCtx["state"]): string {
  if (p.action === "edit_note") return `Edit to note ${p.target}`;
  if (p.action === "new_entry") {
    const path = (payload as { path?: string } | null)?.path;
    return path ? `New entry at ${path}` : "New entry";
  }
  const c = payload as { kind?: string; role?: { name?: string }; ref?: string; membership?: { subject?: string; role?: string }; subject?: string; policy?: Policy } | null;
  const roleName = (ref: string) => state.roles.find((r) => r.id === ref)?.name ?? ref;
  switch (c?.kind) {
    case "add_role":
      return `Create the ${c.role?.name ?? "new"} role`;
    case "update_role":
      return `Change the ${roleName(c.ref ?? "")} role`;
    case "remove_role":
      return `Remove the ${roleName(c.ref ?? "")} role`;
    case "add_policy":
      return "Add a rule";
    case "update_policy":
      return "Change a rule";
    case "remove_policy":
      return "Remove a rule";
    case "add_membership":
      return `Give ${c.membership?.subject ?? "someone"} the ${c.membership?.role ?? ""} role`;
    case "remove_membership":
      return `Take the ${c.role ? "" : ""}${(c as { role?: string }).role ?? ""} role from ${c.subject ?? "someone"}`;
    case "set_config":
      return "Change the constitution itself";
    default:
      return ACTION_LABELS[p.action] ?? p.action;
  }
}

/** The change spelled out, when the payload carries a role or a rule. */
function detailSentence(payload: unknown): string | null {
  const c = payload as { kind?: string; role?: RoleDraft; policy?: PolicyDraft } | null;
  if (!c) return null;
  if ((c.kind === "add_role" || c.kind === "update_role") && c.role?.name) {
    return renderRoleSentence({ ...c.role, scopeType: c.role.scopeType ?? "global", scope: c.role.scope ?? "", powers: c.role.powers ?? [] });
  }
  if ((c.kind === "add_policy" || c.kind === "update_policy") && c.policy) {
    return renderPolicySentence(c.policy as Policy, { roleName: c.policy.eligibleRole || undefined });
  }
  return null;
}

/** Current vs proposed, side by side. `current === null` = we may not read it. */
function Diff({ current, proposed }: { current: string | null; proposed: string }) {
  const pane: React.CSSProperties = {
    flex: 1,
    minWidth: 220,
    maxHeight: 220,
    overflow: "auto",
    padding: 10,
    borderRadius: 8,
    border: "1px solid var(--glass-border)",
    background: "var(--glass)",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    color: "var(--text-primary)",
  };
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }} data-testid="gov-proposal-diff">
      {current !== null && (
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Currently</div>
          <div style={pane}>{current || "(empty)"}</div>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
          {current === null ? "Proposed (the current text isn't readable by you)" : "Proposed"}
        </div>
        <div style={pane}>{proposed || "(empty)"}</div>
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  detail,
  ctx,
  onChanged,
}: {
  proposal: Proposal;
  detail: ProposalDetail | undefined;
  ctx: GovCtx;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const payload = detail?.payload ?? null;
  const evaluation = detail?.evaluation;
  const proposed = (payload as { content?: string } | null)?.content ?? "";

  // The target's live text, for the diff. A 403 is expected for a member who may
  // review a change without being able to read the whole note — say so, don't fail.
  useEffect(() => {
    if (proposal.action !== "edit_note" || !proposal.target) return;
    let alive = true;
    void govApi.note(proposal.target).then((r) => {
      if (!alive) return;
      setCurrent(r.ok ? (r.data?.content ?? "") : null);
    });
    return () => {
      alive = false;
    };
  }, [proposal.action, proposal.target]);

  const act = async (fn: () => Promise<{ ok: boolean }>) => {
    await fn();
    onChanged();
  };

  const window = evaluation ? countdown(proposal.openedAt, evaluation.policy.windowSeconds) : "";
  const open = proposal.state === "open";
  const staged = proposal.state === "approved";

  return (
    <div style={{ ...subCard, marginBottom: 10 }} data-testid="gov-proposal-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13.5, color: "var(--text-primary)" }} data-testid="gov-proposal-title">
          {describe(proposal, payload, ctx.state)}
        </strong>
        <Badge variant={open ? "warning" : staged ? "info" : "default"}>{proposal.state}</Badge>
        <span style={{ flex: 1 }} />
        {evaluation && <Progress value={evaluation.approvals} needed={evaluation.needed} testId="gov-proposal-progress" />}
      </div>

      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
        proposed by {proposal.openedBy} · {ago(proposal.openedAt)}
        {evaluation ? ` · ${pluralRole(evaluation.policy.eligibleRole)} decide this` : ""}
        {evaluation && evaluation.policy.quorum > 0
          ? ` · quorum ${evaluation.participation}/${evaluation.policy.quorum} ${evaluation.quorumMet ? "met" : "not met"}`
          : ""}
        {window ? ` · ${window}` : ""}
      </div>

      {detailSentence(payload) && (
        <p style={{ ...sentence, margin: "8px 0 0" }} data-testid="gov-proposal-detail">
          {detailSentence(payload)}
        </p>
      )}

      {(proposal.action === "edit_note" || proposal.action === "new_entry") && (
        <div style={{ marginTop: 10 }}>
          <Diff current={proposal.action === "edit_note" ? (current ?? null) : null} proposed={proposed} />
        </div>
      )}

      {detail && detail.votes.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }} data-testid="gov-proposal-votes">
          {detail.votes.map((v) => (
            <div key={`${v.voter}-${v.at}`} style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {v.vote === "approve" ? "✓" : "✗"} {v.voter}
              {v.reason ? ` — “${v.reason}”` : ""}
            </div>
          ))}
        </div>
      )}

      {(open || staged) && (
        <div style={{ ...row, marginTop: 10 }}>
          {open && (
            <>
              <Input placeholder="reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 200 }} data-testid="gov-vote-reason" />
              <Button size="sm" icon={<Check size={13} />} onClick={() => void act(() => ctx.run(() => govApi.vote(proposal.id, "approve", reason)))} data-testid="gov-approve">
                Approve
              </Button>
              <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => void act(() => ctx.run(() => govApi.vote(proposal.id, "reject", reason)))} data-testid="gov-reject">
                Reject
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={evaluation ? !evaluation.satisfied : false}
                onClick={() => void act(() => ctx.run(() => govApi.apply(proposal.id)))}
                data-testid="gov-apply"
              >
                Apply
              </Button>
            </>
          )}
          {staged && (
            <Button size="sm" variant="primary" icon={<Upload size={13} />} onClick={() => void act(() => ctx.run(() => govApi.publish(proposal.id)))} data-testid="gov-publish">
              Publish
            </Button>
          )}
          {/* Withdrawing is the proposer's own retraction (the owner may also close
              a stale one) — the server enforces this; showing it to nobody else
              keeps the card from offering a button that can only 403. */}
          {(ctx.me?.subject === proposal.openedBy || ctx.me?.workspaceRole === "owner") && (
            <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => void act(() => ctx.run(() => govApi.withdraw(proposal.id)))} data-testid="gov-withdraw">
              Withdraw
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The wiki-moderation actions, as opposed to constitutional amendments. */
const CONTENT_ACTIONS = new Set(["edit_note", "new_entry"]);

/** The governance role NAMES the caller actively holds (memberships name a role
 *  by id or by name; the policy's `eligibleRole` is always a name). */
function heldRoleNames(ctx: GovCtx): Set<string> {
  const out = new Set<string>();
  for (const m of ctx.me?.memberships ?? []) {
    const r = ctx.state.roles.find((x) => x.id === m.role || x.name === m.role);
    if (r) out.add(r.name);
  }
  return out;
}

/** A small "Content changes · 2" divider above each queue. */
function GroupHeading({ text, count, testId }: { text: string; count: number; testId: string }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0 8px", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}
      data-testid={testId}
    >
      <span>{text}</span>
      <span
        style={{
          fontSize: 11,
          padding: "1px 7px",
          borderRadius: 999,
          border: "1px solid var(--glass-border)",
          background: "var(--glass)",
        }}
      >
        {count}
      </span>
    </div>
  );
}

export function ProposalsSection({
  ctx,
  proposals,
  onChanged,
  onReviewCount,
}: {
  ctx: GovCtx;
  proposals: Proposal[];
  onChanged: () => void;
  /** How many OPEN proposals this caller is eligible to vote on — surfaced as
   *  the status header's "N awaiting review" chip. Reported from here because
   *  this is where the authoritative per-proposal evaluation is loaded. */
  onReviewCount?: (n: number) => void;
}) {
  const [details, setDetails] = useState<Record<string, ProposalDetail>>({});
  const live = useMemo(() => proposals.filter((p) => p.state === "open" || p.state === "approved"), [proposals]);
  const closed = useMemo(() => proposals.filter((p) => p.state !== "open" && p.state !== "approved"), [proposals]);
  // Two queues, not one list: a content change asks "is this page better?" and an
  // amendment asks "should the rules change?". Reviewers self-select by which
  // question they can answer, so the counts carry the triage.
  const liveContent = useMemo(() => live.filter((p) => CONTENT_ACTIONS.has(p.action)), [live]);
  const liveAmendments = useMemo(() => live.filter((p) => !CONTENT_ACTIONS.has(p.action)), [live]);

  const loadDetails = useCallback(async () => {
    const entries = await Promise.all(
      live.map(async (p) => {
        const r = await govApi.proposal(p.id);
        return [p.id, r.ok ? r.data : undefined] as const;
      }),
    );
    const next: Record<string, ProposalDetail> = {};
    for (const [id, d] of entries) if (d) next[id] = d;
    setDetails(next);
  }, [live.map((p) => `${p.id}:${p.state}`).join(",")]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  // "Awaiting review" = OPEN proposals whose governing policy names a role this
  // caller holds — exactly the set /proposals/:id/vote would accept from them.
  const myRoles = heldRoleNames(ctx);
  const reviewable = live.filter((p) => {
    if (p.state !== "open") return false;
    const eligibleRole = details[p.id]?.evaluation?.policy.eligibleRole;
    return !!eligibleRole && myRoles.has(eligibleRole);
  }).length;
  useEffect(() => {
    onReviewCount?.(reviewable);
  }, [reviewable, onReviewCount]);

  const changed = () => {
    onChanged();
    void loadDetails();
  };

  return (
    <Section
      icon={<GitPullRequest size={16} />}
      title="Proposals"
      subtitle={
        ctx.state.locked
          ? "The constitution is locked, so changes to it come here first. Content changes do too, wherever a rule governs them."
          : "Content changes that a rule governs land here for review."
      }
      testId="gov-proposals"
    >
      {ctx.state.locked && <AmendmentComposer ctx={ctx} />}

      {live.length === 0 && <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>Nothing is waiting on a decision.</p>}

      {liveContent.length > 0 && (
        <div data-testid="gov-group-content">
          <GroupHeading text="Content changes" count={liveContent.length} testId="gov-group-content-count" />
          {liveContent.map((p) => (
            <ProposalCard key={p.id} proposal={p} detail={details[p.id]} ctx={ctx} onChanged={changed} />
          ))}
        </div>
      )}

      {liveAmendments.length > 0 && (
        <div data-testid="gov-group-amendments">
          <GroupHeading text="Amendments" count={liveAmendments.length} testId="gov-group-amendments-count" />
          {liveAmendments.map((p) => (
            <ProposalCard key={p.id} proposal={p} detail={details[p.id]} ctx={ctx} onChanged={changed} />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--text-secondary)" }}>Settled ({closed.length})</summary>
          {closed.map((p) => (
            <div key={p.id} style={{ fontSize: 12.5, color: "var(--text-secondary)", padding: "6px 0", borderBottom: "1px solid var(--glass-border)" }}>
              {describe(p, null, ctx.state)} — {p.state} · {ago(p.openedAt)}
            </div>
          ))}
        </details>
      )}
    </Section>
  );
}
