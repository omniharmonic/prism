// The bootstrap wizard — the only moment in a commons's life when its rules can
// be written freely, so it is the one screen that must not look like a database
// form.
//
// Three steps: pick a shape, argue with it, ratify it. Templates are starting
// points, not presets: everything they fill in stays editable, and step 2 is the
// same role/rule editors the panel uses afterwards. Step 3 states the one-way
// latch in plain words and refuses to hide it behind a button — after ratifying,
// nobody (the owner included) can change the constitution except through the
// constitution's own amendment process.
import { useMemo, useState } from "react";
import { Sparkles, ArrowRight, Lock, Check as CheckIcon, X, Plus, Trash2 } from "lucide-react";
import { Button } from "../../../ui/Button";
import { Badge } from "../../../ui/Badge";
import { Input } from "../../../ui/Input";
import { pluralRole, renderPolicySentence, renderRoleSentence } from "../../../../lib/governance/prose";
import { govApi } from "./api";
import type { GovCtx } from "./ctx";
import { RoleForm } from "./RoleEditor";
import { PolicyForm, emptyPolicy } from "./PolicyBuilder";
import { TEMPLATES, type MemberDraft, type PolicyDraft, type RoleDraft, type Template } from "./templates";
import { Field, Section, row, selectStyle, sentence, subCard } from "./ui";

interface CheckItem {
  ok: boolean;
  text: string;
}

/**
 * The client-side mirror of the server's `validateRatification`, shown as a live
 * readout so a steward sees what is missing BEFORE they press the irreversible
 * button. The server remains the authority: pressing Enable & lock can still come
 * back with problems, and those are rendered verbatim.
 */
function readiness(roles: RoleDraft[], policies: PolicyDraft[], members: MemberDraft[]): CheckItem[] {
  const amend = policies.find((p) => p.action === "amend_governance");
  const eligible = amend?.eligibleRole ?? "";
  const roleExists = !!eligible && roles.some((r) => r.name === eligible);
  const holders = new Set(members.filter((m) => m.role === eligible).map((m) => m.subject.toLowerCase()));
  const threshold = Math.max(1, amend?.thresholdN ?? 1);
  return [
    { ok: roles.length > 0, text: "At least one role exists" },
    { ok: !!amend, text: "A rule governs amendments to the constitution" },
    { ok: roleExists, text: eligible ? `The amendment rule names a real role (${eligible})` : "The amendment rule names a role" },
    {
      ok: roleExists && holders.size >= threshold,
      text: `${pluralRole(eligible || "that role")} has ${holders.size} member(s) — amendments need ${threshold}`,
    },
  ];
}

export function BootstrapWizard({ ctx }: { ctx: GovCtx }) {
  const owner = ctx.state.config.bootstrapOwner;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [chosen, setChosen] = useState<Template | null>(null);
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [policies, setPolicies] = useState<PolicyDraft[]>([]);
  const [members, setMembers] = useState<MemberDraft[]>([]);
  const [newMember, setNewMember] = useState("");
  const [newMemberRole, setNewMemberRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [understood, setUnderstood] = useState(false);

  const roleNames = useMemo(() => roles.map((r) => r.name).filter(Boolean), [roles]);
  const checks = useMemo(() => readiness(roles, policies, members), [roles, policies, members]);
  const allGreen = checks.every((c) => c.ok);

  const pick = (t: Template) => {
    setChosen(t);
    setRoles(t.roles.map((r) => ({ ...r, capabilities: [...(r.capabilities ?? [])], powers: [...r.powers], assigns: [...(r.assigns ?? [])] })));
    setPolicies(t.policies.map((p) => ({ ...p })));
    setMembers(owner ? [{ subject: owner, role: t.ownerRole }] : []);
    setNewMemberRole(t.ownerRole);
    setStep(2);
  };

  /** Write the draft constitution: roles, then rules, then the roster. Every one
   *  of these is an upsert server-side, so pressing Back and re-applying converges
   *  rather than duplicating. */
  const applyDraft = async () => {
    setBusy(true);
    try {
      for (const r of roles) {
        if (!r.name.trim()) continue;
        await govApi.addRole({
          name: r.name.trim(),
          powers: r.powers,
          scopeType: r.scopeType,
          scope: r.scope,
          capabilities: r.capabilities,
          assigns: r.assigns,
        });
      }
      for (const p of policies) {
        const body = { ...p };
        delete (body as { id?: string }).id;
        await govApi.addPolicy(body);
      }
      for (const m of members) {
        if (!m.subject.trim() || !m.role) continue;
        await govApi.addMembership({ subject: m.subject.trim().toLowerCase(), role: m.role });
      }
      setStep(3);
      ctx.notify("Draft constitution saved. Nothing is in force until you ratify it.");
    } finally {
      setBusy(false);
      await ctx.run(async () => ({ status: 200, ok: true, data: null }));
    }
  };

  /** The irreversible step. The server pre-flights it; a refusal comes back as a
   *  list of problems and NOTHING is changed. */
  const ratify = async () => {
    setProblems([]);
    setBusy(true);
    try {
      const amendId = ctx.state.policies.find((p) => p.action === "amend_governance")?.id ?? "";
      const eligible = policies.find((p) => p.action === "amend_governance")?.eligibleRole ?? "";
      const r = await govApi.setConfig({
        enabled: true,
        bootstrapOwner: owner,
        amendPolicy: amendId,
        defaultEligibleRole: ctx.state.config.defaultEligibleRole || eligible,
      });
      if (!r.ok) {
        const detail = (r.data as { detail?: string } | null)?.detail ?? r.error ?? "Ratification refused.";
        setProblems(detail.split("; ").filter(Boolean));
        return;
      }
      ctx.notify("Governance is ratified and locked. Every change from here rides an amendment.");
    } finally {
      setBusy(false);
      await ctx.run(async () => ({ status: 200, ok: true, data: null }));
    }
  };

  return (
    <Section
      icon={<Sparkles size={16} />}
      title="Set up your constitution"
      subtitle="You are the bootstrap owner, so you can write the rules directly — until you ratify them."
      testId="gov-wizard"
    >
      <div style={{ ...row, marginBottom: 14, gap: 6 }}>
        {[1, 2, 3].map((n) => (
          <Badge key={n} variant={step === n ? "info" : "default"}>
            {n}. {n === 1 ? "Shape" : n === 2 ? "Adjust" : "Ratify"}
          </Badge>
        ))}
      </div>

      {/* ── step 1: pick a shape ─────────────────────────────────────────────── */}
      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="gov-wizard-step1">
          {TEMPLATES.map((t) => (
            <div key={t.id} style={subCard}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>{t.name}</strong>
                <span style={{ flex: 1 }} />
                <Button size="sm" variant="primary" onClick={() => pick(t)} data-testid={`gov-template-${t.id}`}>
                  Start from this
                </Button>
              </div>
              <p style={{ ...sentence, margin: "6px 0 0" }}>{t.summary}</p>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "6px 0 0" }}>{t.feel}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── step 2: argue with it ────────────────────────────────────────────── */}
      {step === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }} data-testid="gov-wizard-step2">
          <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: 0 }}>
            Starting from <b>{chosen?.name}</b>. Nothing here is fixed — change any of it before you save.
          </p>

          <div>
            <Field text="Roles">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {roles.map((r, i) => (
                  <div key={i} style={subCard}>
                    <RoleForm
                      value={r}
                      onChange={(next) => setRoles((cur) => cur.map((x, j) => (j === i ? next : x)))}
                      tags={ctx.tags}
                      roleNames={roleNames}
                      testId={`gov-wizard-role-${i}`}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={12} />}
                      onClick={() => setRoles((cur) => cur.filter((_, j) => j !== i))}
                      style={{ marginTop: 8 }}
                    >
                      Remove role
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    size="sm"
                    icon={<Plus size={12} />}
                    data-testid="gov-wizard-add-role"
                    onClick={() =>
                      setRoles((cur) => [
                        ...cur,
                        { name: "", powers: [], scopeType: "global", scope: "", capabilities: ["view", "comment"], assigns: [] },
                      ])
                    }
                  >
                    Add another role
                  </Button>
                </div>
              </div>
            </Field>
          </div>

          <div>
            <Field text="Rules">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {policies.map((p, i) => (
                  <div key={i} style={subCard}>
                    <PolicyForm
                      value={p}
                      onChange={(next) => setPolicies((cur) => cur.map((x, j) => (j === i ? next : x)))}
                      roleNames={roleNames}
                      tags={ctx.tags}
                      testId={`gov-wizard-policy-${i}`}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={12} />}
                      onClick={() => setPolicies((cur) => cur.filter((_, j) => j !== i))}
                      style={{ marginTop: 8 }}
                    >
                      Remove rule
                    </Button>
                  </div>
                ))}
                <div>
                  <Button size="sm" icon={<Plus size={12} />} onClick={() => setPolicies((cur) => [...cur, emptyPolicy()])} data-testid="gov-wizard-add-policy">
                    Add another rule
                  </Button>
                </div>
              </div>
            </Field>
          </div>

          <div>
            <Field text="Who holds which role">
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {members.map((m, i) => (
                  <div key={`${m.subject}-${i}`} style={row}>
                    <span style={{ fontSize: 13, color: "var(--text-primary)", minWidth: 220 }}>{m.subject}</span>
                    <select
                      value={m.role}
                      onChange={(e) => setMembers((cur) => cur.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                      style={selectStyle}
                    >
                      {roleNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setMembers((cur) => cur.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
                <div style={row}>
                  <Input
                    placeholder="email@example.com"
                    value={newMember}
                    list={ctx.users.length ? "gov-wizard-users" : undefined}
                    onChange={(e) => setNewMember(e.target.value)}
                    style={{ width: 240 }}
                    data-testid="gov-wizard-member-email"
                  />
                  {ctx.users.length > 0 && (
                    <datalist id="gov-wizard-users">
                      {ctx.users.map((u) => (
                        <option key={u} value={u} />
                      ))}
                    </datalist>
                  )}
                  <select value={newMemberRole} onChange={(e) => setNewMemberRole(e.target.value)} style={selectStyle} data-testid="gov-wizard-member-role">
                    {roleNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    data-testid="gov-wizard-member-add"
                    onClick={() => {
                      const s = newMember.trim().toLowerCase();
                      if (!s || !newMemberRole) return;
                      setMembers((cur) => [...cur, { subject: s, role: newMemberRole }]);
                      setNewMember("");
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </Field>
          </div>

          <div style={row}>
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void applyDraft()} icon={<ArrowRight size={13} />} data-testid="gov-wizard-save">
              Save draft &amp; review
            </Button>
          </div>
        </div>
      )}

      {/* ── step 3: ratify ───────────────────────────────────────────────────── */}
      {step === 3 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="gov-wizard-step3">
          <div style={subCard}>
            <Field text="What you are about to ratify">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {ctx.state.roles.map((r) => (
                  <p key={r.id} style={{ ...sentence, margin: 0 }}>
                    {renderRoleSentence(r)}
                  </p>
                ))}
                {ctx.state.policies.map((p) => (
                  <p key={p.id} style={{ ...sentence, margin: 0 }}>
                    {renderPolicySentence(p, { roleName: p.eligibleRole || ctx.state.config.defaultEligibleRole })}
                  </p>
                ))}
              </div>
            </Field>
          </div>

          <div style={subCard}>
            <Field text="Readiness">
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {checks.map((c) => (
                  <div key={c.text} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-primary)" }} data-testid="gov-ratify-check">
                    {c.ok ? <CheckIcon size={13} color="var(--color-success, #2e7d32)" /> : <X size={13} color="var(--color-danger, #c0392b)" />}
                    {c.text}
                  </div>
                ))}
              </div>
            </Field>
          </div>

          {problems.length > 0 && (
            <div style={{ ...subCard, borderColor: "var(--color-danger, #c0392b)" }} data-testid="gov-ratify-problems">
              <Field text="The server refused to ratify this constitution">
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {problems.map((p) => (
                    <div key={p} style={{ display: "flex", gap: 6, fontSize: 12.5, color: "var(--text-primary)" }}>
                      <X size={13} color="var(--color-danger, #c0392b)" /> {p}
                    </div>
                  ))}
                </div>
              </Field>
            </div>
          )}

          <div style={{ ...subCard, borderColor: "var(--color-warning, #f57c00)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <Lock size={14} />
              <strong style={{ fontSize: 13.5, color: "var(--text-primary)" }}>Ratifying cannot be undone</strong>
            </div>
            <p style={{ ...sentence, margin: "0 0 10px" }}>
              From the moment you ratify, nobody can change these rules directly — not another admin, not you. Every
              change, including switching governance back off, needs an amendment that clears the rule above. If the
              people who can approve amendments become unreachable, the constitution stays exactly as it is.
            </p>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer", color: "var(--text-primary)" }}>
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} data-testid="gov-ratify-understood" />
              I understand this is one-way.
            </label>
          </div>

          <div style={row}>
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back to edit
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!understood || !allGreen}
              onClick={() => void ratify()}
              icon={<Lock size={13} />}
              data-testid="gov-ratify"
            >
              Enable &amp; lock
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}
