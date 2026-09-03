/**
 * Commons Governance — the product surface for /api/governance.
 *
 * Mounted in two places, unchanged from P2: the Network renderer's Governance tab
 * (in-app) and the standalone /governance route (a signed-in member with no app
 * shell). Both get the same component, and it fetches everything itself through
 * `govApi` — no VaultClient, no query client, no provider tree — because the
 * standalone route has none of those.
 *
 * The composition is the argument: a status line that says what is in force, a
 * wizard that exists only before ratification, the constitution as editable
 * cards, the proposal queue, your own access, and the history. Each piece lives in
 * its own file next to this one.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../ui/Badge";
import type { TagCount } from "../../../../lib/types";
import {
  govApi,
  type ApiResult,
  type AuditEntry,
  type GovState,
  type Membership,
  type MyAccess,
  type Proposal,
} from "./api";
import type { GovCtx } from "./ctx";
import { StatusHeader } from "./StatusHeader";
import { BootstrapWizard } from "./BootstrapWizard";
import { RolesSection } from "./RoleEditor";
import { PoliciesSection } from "./PolicyBuilder";
import { ProposalsSection } from "./ProposalsPanel";
import { YourAccess } from "./YourAccess";
import { ContentProposeCard } from "./ContentProposeCard";
import { HistoryCard } from "./HistoryCard";
import { AuditCard } from "./AuditCard";

export function GovernancePanel() {
  const [state, setState] = useState<GovState | null>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [me, setMe] = useState<MyAccess | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const st = await govApi.state();
    if (!st.ok) {
      setError(st.status === 401 ? "Please sign in to view governance." : (st.error ?? "Couldn't load governance."));
      setLoading(false);
      return;
    }
    setState(st.data);
    const [ms, ps, au, my] = await Promise.all([govApi.memberships(), govApi.proposals(), govApi.audit(), govApi.me()]);
    setMembers(ms.data?.memberships ?? []);
    setProposals(ps.data?.proposals ?? []);
    setAudit(au.data?.audit ?? []);
    setMe(my.ok ? my.data : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Context reads, fetched once. Both are allowed to fail: /api/tags is filtered
  // per-actor and /acl/users is admin-only, so a plain member simply gets the
  // free-text versions of the pickers rather than an error.
  useEffect(() => {
    let alive = true;
    void govApi.tags().then((r) => {
      if (alive && r.ok && Array.isArray(r.data)) setTags(r.data);
    });
    void govApi.users().then((r) => {
      if (alive && r.ok && Array.isArray(r.data)) setUsers(r.data.map((u) => u.email).filter(Boolean));
    });
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(
    async <T,>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? `HTTP ${r.status}`);
      await load();
      return r;
    },
    [load],
  );

  const amend = useCallback(
    async (change: Record<string, unknown>, label: string): Promise<ApiResult> => {
      const r = await run(() =>
        govApi.openProposal({ action: "amend_governance", target: "governance-config", payload: JSON.stringify(change) }),
      );
      if (r.ok) setNotice(`Proposed: ${label}. It takes effect once enough members approve and apply it.`);
      return r;
    },
    [run],
  );

  const ctx: GovCtx | null = useMemo(
    () =>
      state
        ? {
            state,
            me,
            members,
            tags,
            users,
            direct: !state.locked && state.isBootstrapOwner,
            run,
            amend,
            notify: setNotice,
          }
        : null,
    [state, me, members, tags, users, run, amend],
  );

  const page: React.CSSProperties = { maxWidth: 900, margin: "0 auto", padding: "8px 4px 48px" };

  if (loading) {
    return (
      <div style={page}>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading governance…</p>
      </div>
    );
  }

  if (!state || !ctx) {
    return (
      <div style={page}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px", color: "var(--text-primary)" }}>Governance</h1>
        <Badge variant="error">{error ?? "Governance is unavailable."}</Badge>
      </div>
    );
  }

  return (
    <div style={page}>
      <StatusHeader state={state} />

      {error && (
        <div style={{ marginBottom: 12 }} data-testid="gov-error">
          <Badge variant="error">{error}</Badge>
        </div>
      )}
      {notice && (
        <div style={{ marginBottom: 12 }} data-testid="gov-notice">
          <Badge variant="info">{notice}</Badge>
        </div>
      )}

      {!state.enabled && state.isBootstrapOwner && <BootstrapWizard ctx={ctx} />}

      <RolesSection ctx={ctx} />
      <PoliciesSection ctx={ctx} />
      <ProposalsSection ctx={ctx} proposals={proposals} onChanged={() => void load()} />
      <YourAccess me={me} state={state} />
      <ContentProposeCard ctx={ctx} />
      <HistoryCard ctx={ctx} />
      <AuditCard audit={audit} />
    </div>
  );
}
