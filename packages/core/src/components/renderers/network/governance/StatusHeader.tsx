// The status line — the three facts that change what every other control on this
// page means: is governance in force, is it locked, and what may YOU do.
import { Lock, Unlock, ShieldCheck, Inbox } from "lucide-react";
import { Badge } from "../../../ui/Badge";
import { listWords, powerLabel } from "../../../../lib/governance/prose";
import type { GovState } from "./api";
import { row, sentence } from "./ui";

export function StatusHeader({ state, reviewCount = 0 }: { state: GovState; reviewCount?: number }) {
  return (
    <div style={{ marginBottom: 18 }} data-testid="gov-status">
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px", color: "var(--text-primary)" }}>Governance</h1>
      <div style={{ ...row, gap: 6 }}>
        {/* The shared Badge does not forward arbitrary DOM props, so the test
            hooks live on wrapper spans rather than on the badges themselves. */}
        <span data-testid="gov-status-enabled">
          {state.enabled ? (
            <Badge variant="success">
              <ShieldCheck size={12} /> In force
            </Badge>
          ) : (
            <Badge>Draft — not in force</Badge>
          )}
        </span>
        <span data-testid="gov-status-lock">
          {state.locked ? (
            <Badge variant="warning">
              <Lock size={12} /> Locked — changes need an amendment
            </Badge>
          ) : (
            <Badge variant="info">
              <Unlock size={12} /> Unlocked — still editable directly
            </Badge>
          )}
        </span>
        {/* The queue's claim on YOUR attention. Only shown when there is something
            this caller could actually decide (the count is computed from each
            proposal's own evaluation — see ProposalsSection), so it is never a
            badge for work belonging to someone else. */}
        {reviewCount > 0 && (
          <span data-testid="review-chip">
            <Badge variant="warning">
              <Inbox size={12} /> {reviewCount} awaiting review
            </Badge>
          </span>
        )}
        {state.isBootstrapOwner && (
          <span data-testid="gov-status-bootstrap">
            <Badge variant="info">You are the bootstrap owner</Badge>
          </span>
        )}
      </div>
      <p style={{ ...sentence, color: "var(--text-secondary)", margin: "8px 0 0" }} data-testid="gov-my-powers">
        {state.myPowers.length
          ? `You may ${listWords(state.myPowers.map(powerLabel))}.`
          : "You hold no governance powers here — you can read the constitution and, with standing, propose changes."}
      </p>
    </div>
  );
}
