/**
 * Cost + budget labelling for the agent UI (Arch v2 WP3.4). Pure, so the verify
 * script can pin the wording.
 *
 * The server's runner uses the `claude` CLI's login. On a claude.ai SUBSCRIPTION
 * the CLI's cost figure is an API-equivalent ESTIMATE — nothing is billed, it
 * counts against subscription usage — so it must never read like a charge. On an
 * API key it is a real charge. `unknown` (probe not answered yet / failed) is
 * labelled like the subscription case: an unexplained "$" is the worse mistake.
 */
import type { AgentBilling, AgentProfile } from "./sessions";

export const SUBSCRIPTION_COST_TOOLTIP =
  "Runs on your Claude subscription; this is what the turn would cost at API prices — counts against subscription usage, not billed";

/** `$0.0177` under a cent, else `$0.02`. */
export function fmtUsd(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export interface CostLabel {
  text: string;
  /** Tooltip (title attribute); only set when the figure is an estimate. */
  title?: string;
}

/** The label for a cost figure: `≈$0.02 API-equiv.` on a subscription, `$0.02` on an API key. */
export function formatAgentCost(usd: number | null | undefined, billing: AgentBilling | undefined): CostLabel | null {
  if (usd == null || !Number.isFinite(usd)) return null;
  if (billing === "api") return { text: fmtUsd(usd) };
  return { text: `≈${fmtUsd(usd)} API-equiv.`, title: SUBSCRIPTION_COST_TOOLTIP };
}

/** Budget amounts (a limit / remaining) get the same estimate marker on a subscription. */
export function formatAgentBudget(usd: number, billing: AgentBilling | undefined): CostLabel {
  return billing === "api" ? { text: fmtUsd(usd) } : { text: `≈${fmtUsd(usd)} API-equiv.`, title: SUBSCRIPTION_COST_TOOLTIP };
}

/** Profile display names for the picker / session header. */
export const PROFILE_LABELS: Record<AgentProfile, { label: string; hint: string }> = {
  "vault-ro": { label: "Read-only", hint: "Can read, not change, your vault" },
  "vault-rw": { label: "Read-write", hint: "Can create and edit notes" },
  skill: { label: "Skill", hint: "Background skill run" },
  "prism-ro": { label: "Prism read-only", hint: "Reads through your Prism permissions (comments, history, governance)" },
  "prism-rw": { label: "Prism read-write", hint: "Reads and writes through your Prism permissions; never deletes or shares" },
};

export const isReadOnlyProfile = (p: AgentProfile | undefined): boolean => p === "vault-ro" || p === "prism-ro";
