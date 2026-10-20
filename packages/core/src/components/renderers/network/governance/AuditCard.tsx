// The audit trail — the commons's memory. Ostrom's fourth principle is monitoring:
// a rule nobody can see being applied is a rule nobody can trust. Every governance
// mutation lands here, newest first, with the actor who made it.
import { ScrollText } from "lucide-react";
import type { AuditEntry } from "./api";
import { Section, ago } from "./ui";

/** "direct:add_role" / "amend:set_config" → words. */
function readable(action: string): string {
  const [how, what] = action.includes(":") ? action.split(":") : ["", action];
  const verb =
    how === "direct" ? "set directly" : how === "amend" ? "changed by amendment" : how === "delegated" ? "staffed by a deputy" : "";
  const noun = (what ?? action).replace(/_/g, " ");
  return verb ? `${noun} — ${verb}` : noun;
}

export function AuditCard({ audit }: { audit: AuditEntry[] }) {
  return (
    <Section icon={<ScrollText size={16} />} title="History" subtitle="Every governance change, newest first." testId="gov-audit">
      {audit.length === 0 && <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>Nothing has happened yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {audit.map((e) => (
          <div key={e.id} style={{ display: "flex", gap: 10, fontSize: 12.5, color: "var(--text-primary)", padding: "5px 0", borderBottom: "1px solid var(--glass-border)" }}>
            <span style={{ flex: 1 }} data-testid="gov-audit-action">
              {readable(e.action)}
            </span>
            <span style={{ color: "var(--text-secondary)" }}>{e.actor}</span>
            <span style={{ color: "var(--text-secondary)", minWidth: 64, textAlign: "right" }}>{ago(e.at)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
