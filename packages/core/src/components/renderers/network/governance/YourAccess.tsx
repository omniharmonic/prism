// "Your access" — the answer to the question every member of a governed commons
// eventually asks: *why* can I edit this, and what else can I touch?
//
// Governance and content permissions are two different systems (a role grants no
// editing rights by itself; it grants them by COMPILING into ordinary grants), and
// that split is invisible until something surprises you. So this table names the
// source of every scope: "via the gardener role" or "shared with you directly".
import { KeyRound } from "lucide-react";
import { Badge } from "../../../ui/Badge";
import { capLabel, listWords, powerLabel } from "../../../../lib/governance/prose";
import type { GovState, MyAccess } from "./api";
import { Section, sentence, subCard } from "./ui";

const scopeName = (resourceType: string, resource: string): string => {
  if (resourceType === "vault") return "the whole workspace";
  if (resourceType === "tag") return `notes tagged #${resource}`;
  if (resourceType === "note") return `one note (${resource})`;
  if (resourceType === "space") return `the federated space ${resource}`;
  return `${resourceType} ${resource}`;
};

export function YourAccess({ me, state }: { me: MyAccess | null; state: GovState }) {
  if (!me) return null;
  const roleFor = (source: string): string | null => {
    if (!source.startsWith("governance:")) return null;
    const id = source.slice("governance:".length);
    return state.roles.find((r) => r.id === id)?.name ?? id;
  };

  return (
    <Section
      icon={<KeyRound size={16} />}
      title="Your access"
      subtitle="What you hold in this commons, and where each piece of it comes from."
      testId="gov-your-access"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ ...sentence }}>
          You are a <b>{me.workspaceRole}</b> of this workspace
          {me.powers.length ? (
            <>
              {" "}
              and may <b>{listWords(me.powers.map(powerLabel))}</b>.
            </>
          ) : (
            <> with no governance powers.</>
          )}
        </div>

        <div style={subCard}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>Roles you hold</div>
          {me.memberships.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: 0 }}>None yet.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {me.memberships.map((m) => (
                <Badge key={`${m.role}-${m.subject}`} variant="info">
                  {m.role}
                  {m.expiresAt ? ` · until ${String(m.expiresAt).slice(0, 10)}` : ""}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div style={subCard}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>What you can touch</div>
          {me.grants.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: 0 }}>
              Nothing is shared with you directly yet.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="gov-access-rows">
              {me.grants.map((g, i) => {
                const role = roleFor(g.source);
                return (
                  <div
                    key={`${g.resource_type}-${g.resource}-${i}`}
                    style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, color: "var(--text-primary)", paddingBottom: 6, borderBottom: "1px solid var(--glass-border)" }}
                  >
                    <span style={{ minWidth: 180 }}>{scopeName(g.resource_type, g.resource)}</span>
                    <span style={{ flex: 1, color: "var(--text-secondary)" }}>{listWords(g.caps.map(capLabel)) || "no capabilities"}</span>
                    <Badge variant={role ? "info" : "default"}>{role ? `via the ${role} role` : "shared with you directly"}</Badge>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
