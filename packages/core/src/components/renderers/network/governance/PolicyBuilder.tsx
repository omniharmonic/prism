// Policies — the HOW-MANY axis. A policy is a sentence ("Edits to notes tagged
// #medicine need 2 approvals from Gardeners within 7 days, then go live
// immediately"), so the editor IS that sentence with each slot swapped for a
// control. Nobody has to learn that `thresholdN` and `eligibleRole` are separate
// fields; they read the rule and change the words they disagree with.
//
// The list also names its own overlaps. Two rules can govern the same action —
// a commons-wide one and a per-tag one — and the engine resolves them by
// specificity (note > tag > global, stricter threshold on ties). Silently
// applying that rule is how a commons ends up with a policy nobody realises is
// dead, so the section says out loud which one wins.
import { useMemo, useState } from "react";
import { Scale, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "../../../ui/Button";
import { Badge } from "../../../ui/Badge";
import { Input } from "../../../ui/Input";
import {
  ACTION_LABELS,
  WINDOW_CHOICES,
  listWords,
  renderPolicySentence,
} from "../../../../lib/governance/prose";
import type { TagCount } from "../../../../lib/types";
import { govApi, type Policy } from "./api";
import type { GovCtx } from "./ctx";
import { ScopeField } from "./ScopeField";
import type { PolicyDraft } from "./templates";
import { Check, Field, Section, row, selectStyle, sentence, subCard } from "./ui";

const ACTIONS = ["edit_note", "new_entry", "amend_governance"] as const;

export const emptyPolicy = (): PolicyDraft => ({
  action: "edit_note",
  scopeType: "global",
  scope: "",
  thresholdN: 1,
  quorum: 0,
  distinctRequired: true,
  eligibleRole: "",
  windowSeconds: 0,
  autoPublish: false,
});

/** The controlled sentence-editor for one policy. */
export function PolicyForm({
  value,
  onChange,
  roleNames,
  tags,
  testId,
}: {
  value: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  roleNames: string[];
  tags: TagCount[];
  testId?: string;
}) {
  const amend = value.action === "amend_governance";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid={testId}>
      <div style={row}>
        <Field text="What kind of change">
          <select
            value={value.action}
            data-testid={testId ? `${testId}-action` : undefined}
            onChange={(e) => onChange({ ...value, action: e.target.value })}
            style={selectStyle}
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a] ?? a}
              </option>
            ))}
          </select>
        </Field>

        {!amend && (
          <Field text="Where">
            <ScopeField
              scopeType={value.scopeType}
              scope={value.scope}
              tags={tags}
              allowNote
              testId={testId ? `${testId}-scope` : undefined}
              onChange={(s) => onChange({ ...value, scopeType: s.scopeType, scope: s.scope })}
            />
          </Field>
        )}
      </div>

      <div style={row}>
        <Field text="Approvals needed" width={130}>
          <Input
            type="number"
            min={1}
            value={String(value.thresholdN)}
            data-testid={testId ? `${testId}-threshold` : undefined}
            onChange={(e) => onChange({ ...value, thresholdN: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>

        <Field text="From members of">
          <select
            value={value.eligibleRole}
            data-testid={testId ? `${testId}-role` : undefined}
            onChange={(e) => onChange({ ...value, eligibleRole: e.target.value })}
            style={selectStyle}
          >
            <option value="">(the constitution's default role)</option>
            {roleNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>

        <Field text="Voting window">
          <select
            value={String(value.windowSeconds)}
            data-testid={testId ? `${testId}-window` : undefined}
            onChange={(e) => onChange({ ...value, windowSeconds: Number(e.target.value) || 0 })}
            style={selectStyle}
          >
            {WINDOW_CHOICES.map((w) => (
              <option key={w.seconds} value={w.seconds}>
                {w.label}
              </option>
            ))}
          </select>
        </Field>

        <Field text="Quorum (0 = none)" width={130}>
          <Input
            type="number"
            min={0}
            value={String(value.quorum)}
            data-testid={testId ? `${testId}-quorum` : undefined}
            onChange={(e) => onChange({ ...value, quorum: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
      </div>

      <div style={{ ...row, gap: 16 }}>
        <Check
          checked={value.autoPublish}
          onChange={(next) => onChange({ ...value, autoPublish: next })}
          text="Approved changes go live immediately"
          title="Off means an approved change is staged until someone with the publish power releases it."
        />
        <Check
          checked={value.distinctRequired}
          onChange={(next) => onChange({ ...value, distinctRequired: next })}
          text="Approvals must come from different people"
        />
      </div>

      <p style={{ ...sentence, color: "var(--text-secondary)", margin: 0 }} data-testid={testId ? `${testId}-sentence` : undefined}>
        {renderPolicySentence(value as Policy, { roleName: value.eligibleRole || undefined })}
      </p>
    </div>
  );
}

function PolicyCard({ policy, ctx }: { policy: Policy; ctx: GovCtx }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PolicyDraft>({ ...policy });
  const roleNames = ctx.state.roles.map((r) => r.name);
  const isAmendPolicy = ctx.state.config.amendPolicy === policy.id;

  const patch = (): PolicyDraft => ({ ...draft, id: undefined });

  const save = async () => {
    const body = { ...patch() };
    delete (body as { id?: string }).id;
    if (ctx.direct) await ctx.run(() => govApi.updatePolicy(policy.id, body));
    else await ctx.amend({ kind: "update_policy", ref: policy.id, policy: body }, `change the ${policy.action} rule`);
    setOpen(false);
  };

  const remove = async () => {
    if (ctx.direct) await ctx.run(() => govApi.removePolicy(policy.id));
    else await ctx.amend({ kind: "remove_policy", ref: policy.id }, `remove the ${policy.action} rule`);
  };

  return (
    <div style={{ ...subCard, marginBottom: 10 }} data-testid="gov-policy-card">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <p style={{ ...sentence, margin: 0, flex: 1 }} data-testid="gov-policy-sentence">
          {renderPolicySentence(policy, { roleName: policy.eligibleRole || ctx.state.config.defaultEligibleRole })}
        </p>
        {isAmendPolicy && <Badge variant="warning">the amendment rule</Badge>}
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} data-testid="gov-policy-edit">
          {open ? "Close" : "Edit"}
        </Button>
      </div>
      {open && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--glass-border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <PolicyForm value={draft} onChange={setDraft} roleNames={roleNames} tags={ctx.tags} testId="gov-policy-form" />
          <div style={row}>
            <Button variant="primary" onClick={() => void save()} icon={<Save size={13} />} data-testid="gov-policy-save">
              {ctx.direct ? "Save rule" : "Propose this change"}
            </Button>
            <Button variant="ghost" onClick={() => void remove()} icon={<Trash2 size={13} />} data-testid="gov-policy-delete">
              {ctx.direct ? "Delete rule" : "Propose removal"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const specificity = (p: { scopeType: string }): number => (p.scopeType === "note" ? 3 : p.scopeType === "tag" ? 2 : 1);

/** Human warnings for actions governed by more than one rule. */
export function conflictHints(policies: Policy[]): string[] {
  const byAction = new Map<string, Policy[]>();
  for (const p of policies) byAction.set(p.action, [...(byAction.get(p.action) ?? []), p]);
  const out: string[] = [];
  for (const [action, group] of byAction) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => specificity(b) - specificity(a) || b.thresholdN - a.thresholdN);
    const name = (p: Policy) =>
      p.scopeType === "global" ? "the commons-wide rule" : p.scopeType === "tag" ? `the #${p.scope} rule` : `the rule for one note`;
    out.push(
      `${ACTION_LABELS[action] ?? action}: ${listWords(ordered.map(name))} all apply. Wherever it matches, ${name(
        ordered[0] as Policy,
      )} wins — the most specific scope governs, and a tie goes to the higher threshold.`,
    );
  }
  return out;
}

export function PoliciesSection({ ctx }: { ctx: GovCtx }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<PolicyDraft>(emptyPolicy());
  const roleNames = ctx.state.roles.map((r) => r.name);
  const hints = useMemo(() => conflictHints(ctx.state.policies), [ctx.state.policies]);

  const create = async () => {
    const body = { ...draft };
    delete (body as { id?: string }).id;
    if (ctx.direct) await ctx.run(() => govApi.addPolicy(body));
    else await ctx.amend({ kind: "add_policy", policy: body }, `add a ${draft.action} rule`);
    setDraft(emptyPolicy());
    setAdding(false);
  };

  return (
    <Section
      icon={<Scale size={16} />}
      title="Rules"
      subtitle="How many sign-offs a change needs, from whom, and whether it goes live on approval."
      testId="gov-policies"
      actions={
        <Button size="sm" onClick={() => setAdding((a) => !a)} icon={<Plus size={13} />} data-testid="gov-policy-new">
          New rule
        </Button>
      }
    >
      {adding && (
        <div style={{ ...subCard, marginBottom: 12 }}>
          <PolicyForm value={draft} onChange={setDraft} roleNames={roleNames} tags={ctx.tags} testId="gov-new-policy" />
          <div style={{ ...row, marginTop: 12 }}>
            <Button variant="primary" onClick={() => void create()} data-testid="gov-policy-create">
              {ctx.direct ? "Create rule" : "Propose new rule"}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {ctx.state.policies.length === 0 && !adding && (
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          No rules yet. Without one, every change falls back to the constitution's default threshold.
        </p>
      )}
      {ctx.state.policies.map((p) => (
        <PolicyCard key={p.id} policy={p} ctx={ctx} />
      ))}

      {hints.map((h) => (
        <p key={h} style={{ fontSize: 12, color: "var(--text-secondary)", margin: "8px 0 0" }} data-testid="gov-policy-conflict">
          {h}
        </p>
      ))}
    </Section>
  );
}
