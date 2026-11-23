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
import { useCallback, useEffect, useMemo, useState, useId } from "react";
import "./governance-workspace.css";
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
  const [section, setSection] = useState("overview");
  const sectionId = useId();
  const sections = [
    ["overview", "Overview"],
    ["rules", "Roles & rules"],
    ["proposals", "Proposals"],
    ["history", "History"],
  ] as const;
  const openSection = (id: string) => {
    setSection(id);
    document.getElementById(`${sectionId}-${id}`)?.focus();
  };
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
  // How many open proposals THIS caller may vote on. Reported up from
  // ProposalsSection (which loads each proposal's evaluation) and shown as the
  // status header's "N awaiting review" chip.
  const [reviewCount, setReviewCount] = useState(0);

  const load = useCallback(async () => {
    const st = await govApi.state();
    if (!st.ok) {
      setError(
        st.status === 401
          ? "Please sign in to view governance."
          : (st.error ?? "Couldn't load governance."),
      );
      setLoading(false);
      return;
    }
    setState(st.data);
    const [ms, ps, au, my] = await Promise.all([
      govApi.memberships(),
      govApi.proposals(),
      govApi.audit(),
      govApi.me(),
    ]);
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
      if (alive && r.ok && Array.isArray(r.data))
        setUsers(r.data.map((u) => u.email).filter(Boolean));
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
    async (
      change: Record<string, unknown>,
      label: string,
    ): Promise<ApiResult> => {
      const r = await run(() =>
        govApi.openProposal({
          action: "amend_governance",
          target: "governance-config",
          payload: JSON.stringify(change),
        }),
      );
      if (r.ok)
        setNotice(
          `Proposed: ${label}. It takes effect once enough members approve and apply it.`,
        );
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

  // Stable identity: ProposalsSection takes these as effect dependencies, so an
  // inline arrow would re-run its detail load on every render.
  const onChanged = useCallback(() => void load(), [load]);

  const page: React.CSSProperties = {
    maxWidth: 900,
    margin: "0 auto",
    padding: "8px 4px 48px",
    minWidth: 0,
  };

  if (loading) {
    return (
      <div className="prism-governance" style={page}>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          Loading governance…
        </p>
      </div>
    );
  }

  if (!state || !ctx) {
    return (
      <div className="prism-governance" style={page}>
        <h1
          style={{
            fontSize: 20,
            fontWeight: 600,
            margin: "0 0 8px",
            color: "var(--text-primary)",
          }}
        >
          Governance
        </h1>
        <Badge variant="error">{error ?? "Governance is unavailable."}</Badge>
      </div>
    );
  }

  return (
    <div className="prism-governance" style={page}>
      <StatusHeader state={state} reviewCount={reviewCount} />

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

      <nav
        className="prism-governance-tabs"
        role="tablist"
        aria-label="Governance sections"
      >
        {sections.map(([id, title], index) => (
          <button
            key={id}
            id={`${sectionId}-${id}`}
            role="tab"
            className="focus-ring"
            aria-selected={section === id}
            aria-controls={`${sectionId}-${id}-panel`}
            tabIndex={section === id ? 0 : -1}
            onClick={() => setSection(id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % sections.length
                  : event.key === "ArrowLeft"
                    ? (index + sections.length - 1) % sections.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? sections.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setSection(sections[next]![0]);
              document
                .getElementById(`${sectionId}-${sections[next]![0]}`)
                ?.focus();
            }}
          >
            {title}
            {id === "proposals" && reviewCount > 0 && (
              <span aria-label={`${reviewCount} awaiting your review`}>
                {reviewCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <section
        role="tabpanel"
        id={`${sectionId}-overview-panel`}
        aria-labelledby={`${sectionId}-overview`}
        hidden={section !== "overview"}
      >
        <div className="prism-governance-intro">
          <h2>How this workspace is governed</h2>
          <p>
            Roles define responsibilities. Rules determine which changes need
            approval. Proposals keep those decisions visible.
          </p>
        </div>
        {!state.enabled && state.isBootstrapOwner && (
          <BootstrapWizard ctx={ctx} />
        )}
        <YourAccess me={me} state={state} />
        <div className="prism-governance-overview-actions">
          <button className="focus-ring" onClick={() => openSection("rules")}>
            Explore roles and rules
          </button>
          <button
            className="focus-ring"
            onClick={() => openSection("proposals")}
          >
            Review proposals
          </button>
        </div>
      </section>
      <section
        role="tabpanel"
        id={`${sectionId}-rules-panel`}
        aria-labelledby={`${sectionId}-rules`}
        hidden={section !== "rules"}
      >
        <RolesSection ctx={ctx} />
        <PoliciesSection ctx={ctx} />
      </section>
      <section
        role="tabpanel"
        id={`${sectionId}-proposals-panel`}
        aria-labelledby={`${sectionId}-proposals`}
        hidden={section !== "proposals"}
      >
        <ProposalsSection
          ctx={ctx}
          proposals={proposals}
          onChanged={onChanged}
          onReviewCount={setReviewCount}
        />
        <details className="prism-governance-compose">
          <summary>Propose a content change</summary>
          <ContentProposeCard ctx={ctx} />
        </details>
      </section>
      <section
        role="tabpanel"
        id={`${sectionId}-history-panel`}
        aria-labelledby={`${sectionId}-history`}
        hidden={section !== "history"}
      >
        <HistoryCard ctx={ctx} />
        <AuditCard audit={audit} />
      </section>
    </div>
  );
}
