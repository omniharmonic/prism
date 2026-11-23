// Roles — the WHO axis of the constitution, edited as cards rather than as a
// form over a JSON blob.
//
// Two things make a role real, and the card shows both without the reader having
// to know which is which: the CONTENT capabilities it confers (compiled into
// ordinary grants — this is the half that actually changes what you can edit) and
// the GOVERNANCE powers it carries (what you may do to the commons itself). They
// are grouped and labelled in plain words; the raw vocabulary never surfaces.
//
// Before ratification, Save writes straight through. After it, the same Save
// opens a PRE-FILLED amendment — the member never sees or edits JSON, and the
// one-way lock is respected because the server, not this file, decides.
import { useMemo, useState } from "react";
import { Shield, Trash2, UserPlus, Save, Plus } from "lucide-react";
import { Button } from "../../../ui/Button";
import { Badge } from "../../../ui/Badge";
import { Input } from "../../../ui/Input";
import {
  CAP_GROUPS,
  POWER_ORDER,
  capLabel,
  powerLabel,
  renderRoleSentence,
} from "../../../../lib/governance/prose";
import type { TagCount } from "../../../../lib/types";
import { govApi, type Membership, type Role } from "./api";
import { needsProposal, type GovCtx } from "./ctx";
import { ScopeField } from "./ScopeField";
import type { RoleDraft } from "./templates";
import { Chip, Field, Section, row, sentence, subCard } from "./ui";

const emptyRole = (): RoleDraft => ({
  name: "",
  powers: [],
  scopeType: "global",
  scope: "",
  capabilities: ["view", "comment", "suggest"],
  assigns: [],
});

/** The pure, controlled editor for one role. Reused by the wizard and the cards. */
export function RoleForm({
  value,
  onChange,
  tags,
  roleNames,
  testId,
}: {
  value: RoleDraft;
  onChange: (next: RoleDraft) => void;
  tags: TagCount[];
  roleNames: string[];
  testId?: string;
}) {
  const toggle = (list: string[], item: string, on: boolean): string[] =>
    on ? [...new Set([...list, item])] : list.filter((x) => x !== item);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid={testId}>
      <div style={row}>
        <Field text="Role name" width={200}>
          <Input
            placeholder="e.g. gardener"
            value={value.name}
            data-testid={testId ? `${testId}-name` : undefined}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </Field>
        <Field text="Applies to">
          <ScopeField
            scopeType={value.scopeType}
            scope={value.scope}
            tags={tags}
            testId={testId ? `${testId}-scope` : undefined}
            onChange={(s) =>
              onChange({ ...value, scopeType: (s.scopeType === "note" ? "tag" : s.scopeType) as "global" | "tag", scope: s.scope })
            }
          />
        </Field>
      </div>

      {CAP_GROUPS.map((group) => (
        <div key={group.id}>
          <Field text={group.label}>
            <div style={{ ...row, gap: 12 }}>
              {group.caps.map((cap) => (
                <label
                  key={cap}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer", color: "var(--text-primary)" }}
                >
                  <input
                    type="checkbox"
                    aria-label={capLabel(cap)}
                    checked={(value.capabilities ?? []).includes(cap)}
                    onChange={(e) => onChange({ ...value, capabilities: toggle(value.capabilities ?? [], cap, e.target.checked) })}
                  />
                  {capLabel(cap)}
                </label>
              ))}
            </div>
          </Field>
        </div>
      ))}

      <Field text="Governance powers">
        <div style={{ ...row, gap: 12 }}>
          {POWER_ORDER.map((p) => (
            <label
              key={p}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer", color: "var(--text-primary)" }}
            >
              <input
                type="checkbox"
                aria-label={powerLabel(p)}
                checked={(value.powers ?? []).includes(p)}
                onChange={(e) => onChange({ ...value, powers: toggle(value.powers ?? [], p, e.target.checked) })}
              />
              {powerLabel(p)}
            </label>
          ))}
        </div>
      </Field>

      {(value.powers ?? []).includes("assign_roles") && (
        <Field text="May staff these roles (without an amendment)">
          <div style={{ ...row, gap: 12 }}>
            {roleNames.filter((n) => n && n !== value.name).length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>No other roles to staff yet.</span>
            ) : (
              roleNames
                .filter((n) => n && n !== value.name)
                .map((n) => (
                  <label key={n} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer", color: "var(--text-primary)" }}>
                    <input
                      type="checkbox"
                      aria-label={`staff ${n}`}
                      checked={(value.assigns ?? []).includes(n)}
                      onChange={(e) => onChange({ ...value, assigns: toggle(value.assigns ?? [], n, e.target.checked) })}
                    />
                    {n}
                  </label>
                ))
            )}
          </div>
        </Field>
      )}

      <p style={{ ...sentence, color: "var(--text-secondary)", margin: 0 }} data-testid={testId ? `${testId}-sentence` : undefined}>
        {renderRoleSentence({ ...value, name: value.name || "This role" })}
      </p>
    </div>
  );
}

/** The roster chips for one role, with add/remove. */
function RoleMembers({ role, ctx }: { role: Role; ctx: GovCtx }) {
  const [email, setEmail] = useState("");
  const holders = ctx.members.filter((m: Membership) => m.role === role.id || m.role === role.name);
  const listId = `gov-users-${role.id}`;

  const add = async () => {
    const subject = email.trim().toLowerCase();
    if (!subject) return;
    const r = await ctx.run(() => govApi.addMembership({ subject, role: role.name }));
    if (needsProposal(r)) {
      // Locked, and this member isn't a deputized assigner — route it through the
      // constitution instead of failing at them.
      await ctx.amend({ kind: "add_membership", membership: { subject, role: role.name } }, `add ${subject} to ${role.name}`);
    }
    setEmail("");
  };

  const remove = async (m: Membership) => {
    const r = await ctx.run(() => govApi.removeMembership({ subject: m.subject, role: m.role }));
    if (needsProposal(r)) {
      await ctx.amend({ kind: "remove_membership", subject: m.subject, role: m.role }, `remove ${m.subject} from ${role.name}`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Field text={`Members (${holders.length})`}>
        <div style={{ ...row, gap: 6 }}>
          {holders.length === 0 && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Nobody holds this role yet.</span>}
          {holders.map((m) => (
            <Chip key={`${m.subject}-${m.role}`} onRemove={() => void remove(m)} testId="gov-role-member">
              {m.subject}
              {m.expiresAt ? ` · until ${String(m.expiresAt).slice(0, 10)}` : ""}
            </Chip>
          ))}
        </div>
      </Field>
      <div style={row}>
        <Input
          placeholder="email@example.com"
          value={email}
          list={ctx.users.length ? listId : undefined}
          data-testid="gov-member-email"
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: 240 }}
        />
        {ctx.users.length > 0 && (
          <datalist id={listId}>
            {ctx.users.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        )}
        <Button onClick={() => void add()} disabled={!email.trim()} icon={<UserPlus size={13} />} data-testid="gov-member-add">
          Add to {role.name}
        </Button>
      </div>
    </div>
  );
}

/** One persisted role: read as a sentence, opened to edit, saved or removed. */
function RoleCard({ role, ctx }: { role: Role; ctx: GovCtx }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RoleDraft>({ ...role });
  const roleNames = useMemo(() => ctx.state.roles.map((r) => r.name), [ctx.state.roles]);
  const constitutional = role.powers.includes("amend_governance");

  const save = async () => {
    const patch = {
      name: draft.name,
      powers: draft.powers,
      scopeType: draft.scopeType,
      scope: draft.scope,
      capabilities: draft.capabilities,
      assigns: draft.assigns,
    };
    if (ctx.direct) {
      await ctx.run(() => govApi.updateRole(role.id, patch));
      setOpen(false);
      return;
    }
    await ctx.amend({ kind: "update_role", ref: role.id, role: patch }, `change the ${role.name} role`);
    setOpen(false);
  };

  const remove = async () => {
    if (ctx.direct) {
      await ctx.run(() => govApi.removeRole(role.id));
      return;
    }
    await ctx.amend({ kind: "remove_role", ref: role.id }, `remove the ${role.name} role`);
  };

  return (
    <div style={{ ...subCard, marginBottom: 10 }} data-testid="gov-role-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Shield size={14} />
        <strong style={{ fontSize: 14, color: "var(--text-primary)" }} data-testid="gov-role-name">
          {role.name}
        </strong>
        {role.scopeType === "tag" && role.scope && <Badge>#{role.scope}</Badge>}
        {constitutional && <Badge variant="warning">constitutional</Badge>}
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} data-testid="gov-role-edit">
          {open ? "Close" : "Edit"}
        </Button>
      </div>

      <p style={{ ...sentence, margin: "0 0 10px" }} data-testid="gov-role-sentence">
        {renderRoleSentence(role)}
      </p>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, borderTop: "1px solid var(--glass-border)", paddingTop: 12 }}>
          <RoleForm value={draft} onChange={setDraft} tags={ctx.tags} roleNames={roleNames} testId="gov-role-form" />
          <div style={row}>
            <Button variant="primary" onClick={() => void save()} icon={<Save size={13} />} data-testid="gov-role-save">
              {ctx.direct ? "Save role" : "Propose this change"}
            </Button>
            <Button variant="ghost" onClick={() => void remove()} icon={<Trash2 size={13} />} data-testid="gov-role-delete">
              {ctx.direct ? "Delete role" : "Propose removal"}
            </Button>
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--glass-border)", paddingTop: 10, marginTop: 10 }}>
        <RoleMembers role={role} ctx={ctx} />
      </div>
    </div>
  );
}

/** The Roles section of the panel: every role, plus a way to add one. */
export function RolesSection({ ctx }: { ctx: GovCtx }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<RoleDraft>(emptyRole());
  const roleNames = useMemo(() => ctx.state.roles.map((r) => r.name), [ctx.state.roles]);

  const create = async () => {
    if (!draft.name.trim()) return;
    if (ctx.direct) {
      await ctx.run(() => govApi.addRole(draft));
    } else {
      await ctx.amend({ kind: "add_role", role: draft }, `add the ${draft.name} role`);
    }
    setDraft(emptyRole());
    setAdding(false);
  };

  return (
    <Section
      icon={<Shield size={16} />}
      title="Roles"
      subtitle="Who may do what. A role's capabilities become real access the moment the constitution is ratified; its powers say what its holders may do to the commons itself."
      testId="gov-roles"
      actions={
        <Button size="sm" onClick={() => setAdding((a) => !a)} icon={<Plus size={13} />} data-testid="gov-role-new">
          New role
        </Button>
      }
    >
      {adding && (
        <div style={{ ...subCard, marginBottom: 12 }}>
          <RoleForm value={draft} onChange={setDraft} tags={ctx.tags} roleNames={roleNames} testId="gov-new-role" />
          <div style={{ ...row, marginTop: 12 }}>
            <Button variant="primary" onClick={() => void create()} disabled={!draft.name.trim()} data-testid="gov-role-create">
              {ctx.direct ? "Create role" : "Propose new role"}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {ctx.state.roles.length === 0 && !adding && (
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          No roles yet — a commons needs at least one before it can be ratified.
        </p>
      )}
      {ctx.state.roles.map((r) => (
        <RoleCard key={r.id} role={r} ctx={ctx} />
      ))}
    </Section>
  );
}
