/**
 * Commons Governance — a self-contained control surface for the /api/governance
 * backend, mounted at the client route /governance. It lets a signed-in member
 * see the constitution, bootstrap it (while unlocked), and drive the full
 * lifecycle: roles/policies/memberships, proposals (open → vote → apply →
 * withdraw), content review, and the audit trail.
 *
 * Deliberately plain: it inherits the global design system's typography/colors
 * (loaded as a side effect of importing @prism/core in main.tsx) and adds only
 * light structural styling — the goal is to exercise the governance flows on a
 * local dev server, not to be the final polished UI.
 */
import { useCallback, useEffect, useState } from "react";
import {
  govApi,
  type GovState,
  type Proposal,
  type Membership,
  type AuditEntry,
  type ApiResult,
} from "./api";

const POWERS = ["review", "publish", "certify_gardener", "manage_policy", "arbitrate", "invite", "revoke", "amend_governance"] as const;

const s = {
  page: { maxWidth: 920, margin: "0 auto", padding: "32px 20px 80px", fontFamily: "system-ui, sans-serif", lineHeight: 1.45 } as React.CSSProperties,
  card: { border: "1px solid rgba(128,128,128,0.3)", borderRadius: 12, padding: 18, margin: "16px 0", background: "rgba(128,128,128,0.04)" } as React.CSSProperties,
  h1: { fontSize: 26, fontWeight: 700, margin: "0 0 4px" } as React.CSSProperties,
  h2: { fontSize: 16, fontWeight: 650, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.75 } as React.CSSProperties,
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } as React.CSSProperties,
  input: { padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.4)", background: "transparent", color: "inherit", font: "inherit" } as React.CSSProperties,
  btn: { padding: "6px 12px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.5)", background: "rgba(128,128,128,0.1)", color: "inherit", cursor: "pointer", font: "inherit" } as React.CSSProperties,
  badge: (bg: string) => ({ display: "inline-block", padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: bg, color: "#fff" } as React.CSSProperties),
  mono: { fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.85 } as React.CSSProperties,
  err: { color: "#c0392b", margin: "8px 0", fontWeight: 600 } as React.CSSProperties,
  li: { padding: "8px 0", borderTop: "1px solid rgba(128,128,128,0.18)" } as React.CSSProperties,
};

export function GovernancePanel() {
  const [state, setState] = useState<GovState | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const st = await govApi.state();
    if (!st.ok) {
      setErr(st.status === 401 ? "Please sign in to view governance." : st.error ?? "Failed to load");
      setLoading(false);
      return;
    }
    setState(st.data);
    setProposals((await govApi.proposals()).data.proposals ?? []);
    setMembers((await govApi.memberships()).data.memberships ?? []);
    setAudit((await govApi.audit()).data.audit ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<ApiResult>) => {
      setErr(null);
      const r = await fn();
      if (!r.ok) setErr(r.error ?? `HTTP ${r.status}`);
      await load();
      return r;
    },
    [load],
  );

  if (loading) return <div style={s.page}>Loading governance…</div>;
  if (!state)
    return (
      <div style={s.page}>
        <h1 style={s.h1}>Commons Governance</h1>
        <p style={s.err}>{err}</p>
        <a href="/" style={s.btn}>Go to sign in</a>
      </div>
    );

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Commons Governance</h1>
      <div style={{ ...s.row, margin: "6px 0 4px" }}>
        {state.enabled ? <span style={s.badge("#2e7d32")}>Enabled</span> : <span style={s.badge("#757575")}>Not enabled</span>}
        {state.locked ? <span style={s.badge("#b71c1c")}>Locked (self-amending)</span> : <span style={s.badge("#f57c00")}>Unlocked (bootstrap)</span>}
        {state.isBootstrapOwner && <span style={s.badge("#1565c0")}>You are the bootstrap owner</span>}
      </div>
      <p style={{ opacity: 0.75, marginTop: 4 }}>
        Your powers: <span style={s.mono}>{state.myPowers.length ? state.myPowers.join(", ") : "none"}</span>
      </p>
      {err && <p style={s.err}>{err}</p>}

      {!state.enabled && state.isBootstrapOwner && <BootstrapCard state={state} run={run} />}

      <RolesCard state={state} />
      <PoliciesCard state={state} />
      <MembersCard members={members} />
      <ProposalsCard state={state} proposals={proposals} run={run} />
      <ContentProposeCard run={run} />
      <AuditCard audit={audit} />
    </div>
  );
}

// ── bootstrap (unlocked owner only) ────────────────────────────────────────────

function BootstrapCard({ state, run }: { state: GovState; run: (fn: () => Promise<ApiResult>) => Promise<ApiResult> }) {
  const [roleName, setRoleName] = useState("");
  const [rolePowers, setRolePowers] = useState<string[]>(["review"]);
  const [roleScope, setRoleScope] = useState("");
  const [polAction, setPolAction] = useState("edit_note");
  const [polScope, setPolScope] = useState("");
  const [polThreshold, setPolThreshold] = useState(2);
  const [polRole, setPolRole] = useState("");
  const [memSubject, setMemSubject] = useState("");
  const [memRole, setMemRole] = useState("");
  const [amendPolicy, setAmendPolicy] = useState("");

  const amendPolicies = state.policies.filter((p) => p.action === "amend_governance");

  return (
    <div style={{ ...s.card, borderColor: "#f57c00" }}>
      <h2 style={s.h2}>Bootstrap the constitution</h2>
      <p style={{ opacity: 0.8, marginTop: 0 }}>
        While unlocked, you (the bootstrap owner) configure roles, policies and members directly. <b>Enabling governance
        is a one-way latch</b> — after that, every change (including disabling it) requires an approved amendment.
      </p>

      <div style={{ ...s.card, margin: "10px 0" }}>
        <b>Add role</b>
        <div style={{ ...s.row, marginTop: 6 }}>
          <input style={s.input} placeholder="name (e.g. gardener)" value={roleName} onChange={(e) => setRoleName(e.target.value)} />
          <input style={s.input} placeholder="scope tag (blank = global)" value={roleScope} onChange={(e) => setRoleScope(e.target.value)} />
        </div>
        <div style={{ ...s.row, marginTop: 6 }}>
          {POWERS.map((p) => (
            <label key={p} style={{ ...s.mono, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={rolePowers.includes(p)}
                onChange={(e) => setRolePowers((cur) => (e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)))}
              />{" "}
              {p}
            </label>
          ))}
        </div>
        <button
          style={{ ...s.btn, marginTop: 8 }}
          onClick={() =>
            run(() =>
              govApi.addRole({ name: roleName, powers: rolePowers, scopeType: roleScope ? "tag" : "global", scope: roleScope }),
            )
          }
        >
          Add role
        </button>
      </div>

      <div style={{ ...s.card, margin: "10px 0" }}>
        <b>Add policy</b>
        <div style={{ ...s.row, marginTop: 6 }}>
          <input style={s.input} placeholder="action (edit_note / new_entry / amend_governance)" value={polAction} onChange={(e) => setPolAction(e.target.value)} />
          <input style={s.input} placeholder="scope tag (blank = global)" value={polScope} onChange={(e) => setPolScope(e.target.value)} />
          <input style={{ ...s.input, width: 90 }} type="number" min={1} placeholder="threshold" value={polThreshold} onChange={(e) => setPolThreshold(Number(e.target.value))} />
          <input style={s.input} placeholder="eligible role" value={polRole} onChange={(e) => setPolRole(e.target.value)} />
        </div>
        <button
          style={{ ...s.btn, marginTop: 8 }}
          onClick={() =>
            run(() =>
              govApi.addPolicy({
                action: polAction,
                scopeType: polScope ? "tag" : "global",
                scope: polScope,
                thresholdN: polThreshold,
                distinctRequired: true,
                eligibleRole: polRole,
              }),
            )
          }
        >
          Add policy
        </button>
      </div>

      <div style={{ ...s.card, margin: "10px 0" }}>
        <b>Add member</b>
        <div style={{ ...s.row, marginTop: 6 }}>
          <input style={s.input} placeholder="subject email" value={memSubject} onChange={(e) => setMemSubject(e.target.value)} />
          <input style={s.input} placeholder="role name" value={memRole} onChange={(e) => setMemRole(e.target.value)} />
        </div>
        <button style={{ ...s.btn, marginTop: 8 }} onClick={() => run(() => govApi.addMembership({ subject: memSubject, role: memRole }))}>
          Add member
        </button>
      </div>

      <div style={{ ...s.card, margin: "10px 0", borderColor: "#b71c1c" }}>
        <b>Enable governance (locks the constitution)</b>
        <div style={{ ...s.row, marginTop: 6 }}>
          <label style={s.mono}>amend policy:&nbsp;</label>
          <select style={s.input} value={amendPolicy} onChange={(e) => setAmendPolicy(e.target.value)}>
            <option value="">(config default)</option>
            {amendPolicies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} — {p.thresholdN}× {p.eligibleRole}
              </option>
            ))}
          </select>
        </div>
        <button
          style={{ ...s.btn, marginTop: 8, borderColor: "#b71c1c" }}
          onClick={() => {
            if (!confirm("Enable governance? After this, changing or disabling it requires an approved amendment.")) return;
            void run(() =>
              govApi.setConfig({
                enabled: true,
                bootstrapOwner: state.config.bootstrapOwner,
                amendPolicy,
                defaultEligibleRole: state.config.defaultEligibleRole || "admin",
              }),
            );
          }}
        >
          Enable & lock
        </button>
      </div>
    </div>
  );
}

// ── read cards ──────────────────────────────────────────────────────────────────

function RolesCard({ state }: { state: GovState }) {
  return (
    <div style={s.card}>
      <h2 style={s.h2}>Roles</h2>
      {state.roles.length === 0 && <p style={{ opacity: 0.6 }}>No roles yet.</p>}
      {state.roles.map((r) => (
        <div key={r.id} style={s.li}>
          <b>{r.name}</b> <span style={s.mono}>[{r.scopeType === "tag" ? `#${r.scope}` : "global"}]</span>
          <div style={s.mono}>{r.powers.join(", ") || "no powers"}</div>
        </div>
      ))}
    </div>
  );
}

function PoliciesCard({ state }: { state: GovState }) {
  return (
    <div style={s.card}>
      <h2 style={s.h2}>Policies</h2>
      {state.policies.length === 0 && <p style={{ opacity: 0.6 }}>No policies yet.</p>}
      {state.policies.map((p) => (
        <div key={p.id} style={s.li}>
          <b>{p.action}</b> <span style={s.mono}>[{p.scopeType === "global" ? "global" : `${p.scopeType}:${p.scope}`}]</span>
          <div style={s.mono}>
            {p.thresholdN}× {p.distinctRequired ? "distinct " : ""}
            {p.eligibleRole || "(default role)"}
            {p.quorum ? `, quorum ${p.quorum}` : ""}
            {p.windowSeconds ? `, window ${p.windowSeconds}s` : ""}
            {p.autoPublish ? ", auto-publish" : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function MembersCard({ members }: { members: Membership[] }) {
  return (
    <div style={s.card}>
      <h2 style={s.h2}>Members</h2>
      {members.length === 0 && <p style={{ opacity: 0.6 }}>No members yet.</p>}
      {members.map((m, i) => (
        <div key={`${m.subject}-${i}`} style={s.li}>
          <b>{m.subject}</b> → <span style={s.mono}>{m.role}</span>
          {m.expiresAt ? <span style={s.mono}> (expires {m.expiresAt})</span> : null}
        </div>
      ))}
    </div>
  );
}

// ── proposals ─────────────────────────────────────────────────────────────────

const AMEND_TEMPLATES: Record<string, string> = {
  add_role: JSON.stringify({ kind: "add_role", role: { name: "gardener", powers: ["review"], scopeType: "tag", scope: "medicine" } }, null, 2),
  add_membership: JSON.stringify({ kind: "add_membership", membership: { subject: "someone@example.com", role: "gardener" } }, null, 2),
  add_policy: JSON.stringify({ kind: "add_policy", policy: { action: "edit_note", scopeType: "tag", scope: "medicine", thresholdN: 2, distinctRequired: true, eligibleRole: "gardener" } }, null, 2),
  disable: JSON.stringify({ kind: "set_config", config: { enabled: false } }, null, 2),
};

function ProposalsCard({
  state,
  proposals,
  run,
}: {
  state: GovState;
  proposals: Proposal[];
  run: (fn: () => Promise<ApiResult>) => Promise<ApiResult>;
}) {
  const [payload, setPayload] = useState(AMEND_TEMPLATES.add_role);
  const open = proposals.filter((p) => p.state === "open");
  const closed = proposals.filter((p) => p.state !== "open");

  return (
    <div style={s.card}>
      <h2 style={s.h2}>Proposals</h2>

      {state.locked && (
        <div style={{ ...s.card, margin: "0 0 12px" }}>
          <b>New amendment proposal</b>
          <div style={{ opacity: 0.75, fontSize: 13, margin: "4px 0" }}>
            Governance is locked, so changes go through an <span style={s.mono}>amend_governance</span> proposal. Pick a
            template, edit the JSON, and open it — then eligible members vote and anyone can apply once the threshold clears.
          </div>
          <div style={s.row}>
            {Object.keys(AMEND_TEMPLATES).map((k) => (
              <button key={k} style={s.btn} onClick={() => setPayload(AMEND_TEMPLATES[k] ?? "")}>
                {k}
              </button>
            ))}
          </div>
          <textarea style={{ ...s.input, width: "100%", minHeight: 120, marginTop: 8, fontFamily: "ui-monospace, monospace" }} value={payload} onChange={(e) => setPayload(e.target.value)} />
          <button
            style={{ ...s.btn, marginTop: 8 }}
            onClick={() => {
              try {
                JSON.parse(payload);
              } catch {
                alert("Payload is not valid JSON");
                return;
              }
              void run(() => govApi.openProposal({ action: "amend_governance", target: "governance-config", payload }));
            }}
          >
            Open amendment proposal
          </button>
        </div>
      )}

      {open.length === 0 && <p style={{ opacity: 0.6 }}>No open proposals.</p>}
      {open.map((p) => (
        <div key={p.id} style={s.li}>
          <div>
            <b>{p.action}</b> → <span style={s.mono}>{p.target}</span> <span style={s.badge("#f57c00")}>{p.state}</span>
          </div>
          <div style={s.mono}>by {p.openedBy} · {p.openedAt}</div>
          <div style={{ ...s.row, marginTop: 6 }}>
            <button style={s.btn} onClick={() => run(() => govApi.vote(p.id, "approve"))}>Approve</button>
            <button style={s.btn} onClick={() => run(() => govApi.vote(p.id, "reject"))}>Reject</button>
            <button style={s.btn} onClick={() => run(() => govApi.apply(p.id))}>Apply</button>
            <button style={s.btn} onClick={() => run(() => govApi.withdraw(p.id))}>Withdraw</button>
          </div>
        </div>
      ))}

      {closed.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", opacity: 0.75 }}>Closed proposals ({closed.length})</summary>
          {closed.map((p) => (
            <div key={p.id} style={s.li}>
              <b>{p.action}</b> → <span style={s.mono}>{p.target}</span> <span style={s.badge("#616161")}>{p.state}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// ── content proposals ───────────────────────────────────────────────────────────

function ContentProposeCard({ run }: { run: (fn: () => Promise<ApiResult>) => Promise<ApiResult> }) {
  const [mode, setMode] = useState<"edit_note" | "new_entry">("edit_note");
  const [target, setTarget] = useState("");
  const [path, setPath] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");

  return (
    <div style={s.card}>
      <h2 style={s.h2}>Propose a content change</h2>
      <div style={s.row}>
        <label style={s.mono}>
          <input type="radio" checked={mode === "edit_note"} onChange={() => setMode("edit_note")} /> edit_note
        </label>
        <label style={s.mono}>
          <input type="radio" checked={mode === "new_entry"} onChange={() => setMode("new_entry")} /> new_entry
        </label>
      </div>
      <div style={{ ...s.row, marginTop: 6 }}>
        {mode === "edit_note" ? (
          <input style={{ ...s.input, minWidth: 260 }} placeholder="target note id" value={target} onChange={(e) => setTarget(e.target.value)} />
        ) : (
          <>
            <input style={s.input} placeholder="path (e.g. medicine/yarrow)" value={path} onChange={(e) => setPath(e.target.value)} />
            <input style={s.input} placeholder="tags (comma-separated)" value={tags} onChange={(e) => setTags(e.target.value)} />
          </>
        )}
      </div>
      <textarea style={{ ...s.input, width: "100%", minHeight: 90, marginTop: 8 }} placeholder="proposed content (may be a stub)" value={content} onChange={(e) => setContent(e.target.value)} />
      <button
        style={{ ...s.btn, marginTop: 8 }}
        onClick={() =>
          run(() =>
            mode === "edit_note"
              ? govApi.proposeContent({ action: "edit_note", target, content })
              : govApi.proposeContent({ action: "new_entry", path, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), content }),
          )
        }
      >
        Propose
      </button>
    </div>
  );
}

// ── audit ────────────────────────────────────────────────────────────────────

function AuditCard({ audit }: { audit: AuditEntry[] }) {
  return (
    <div style={s.card}>
      <h2 style={s.h2}>Audit trail</h2>
      {audit.length === 0 && <p style={{ opacity: 0.6 }}>No governance activity yet.</p>}
      {audit.map((e) => (
        <div key={e.id} style={s.li}>
          <span style={s.mono}>{e.at}</span> · <b>{e.action}</b> · {e.actor}
        </div>
      ))}
    </div>
  );
}
