/**
 * "Review requested" — the one notification the moderation loop needs (P4).
 *
 * A proposal that nobody knows about is a proposal that never gets decided. When
 * someone opens one, the members the governing policy makes ELIGIBLE TO VOTE are
 * told, in the same words the constitution uses: the rule sentence, how many
 * approvals it needs, and a link to the queue.
 *
 * Three properties this module is built around:
 *
 *  1. STRICTLY FIRE-AND-FORGET. `notifyVoters` returns void and swallows every
 *     failure. A dead SMTP key must never turn a successful proposal into a 500,
 *     and nothing about delivery ever appears in the request's response — the
 *     proposal is already durable in the vault before we get here.
 *  2. SAME PLUMBING AS MAGIC LINKS. It sends through `sendEmail`, so a configured
 *     Resend key mails, and an unconfigured one logs the line to the console —
 *     which is exactly the dev/test path (and what the tests assert against).
 *  3. NO NEW POLICY. Who is eligible is `eligibleVoters` in the pure engine, the
 *     same set `evaluateProposal` counts approvals from. This module decides
 *     nothing; it only addresses an envelope.
 */
import { config } from "./config";
import { sendEmail } from "./auth/email";
import { renderPolicySentence } from "@prism/core/governance-prose";
import {
  eligibleVoters,
  requiredPolicy,
  type ActionContext,
  type GovernanceState,
  type Proposal,
} from "./governance";

/** The transport shape — `sendEmail`'s signature, so the real one just drops in. */
export type NotifySender = (to: string, subject: string, html: string, devLine?: string) => Promise<boolean>;

/**
 * Never mail a crowd. A commons with hundreds of eligible voters wants a digest,
 * not a fan-out; until that exists we notify the first 50 and stop, rather than
 * turning one proposal into an unbounded outbound burst.
 */
export const MAX_RECIPIENTS = 50;

let sender: NotifySender = sendEmail;

/** Test seam: swap the transport (pass null to restore the real sender). */
export function setNotifySender(fn: NotifySender | null): void {
  sender = fn ?? sendEmail;
}

/** In-flight notification runs, so tests can await delivery deterministically. */
const inflight = new Set<Promise<void>>();

/** Test seam: wait for every in-flight notification to settle. */
export async function settleNotifications(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The subject line: what changed, and where. */
export function notificationSubject(proposal: Proposal): string {
  const target = proposal.target ? ` — ${proposal.target}` : "";
  return `[Prism] Review requested: ${proposal.action}${target}`;
}

/**
 * Compose the notice. Exported for the tests (and because the body IS the
 * product here — a member should be able to decide from the email whether this
 * needs them).
 */
export function notificationBody(
  proposal: Proposal,
  sentence: string,
  needed: number,
): { html: string; text: string } {
  const url = `${config.appOrigin}/governance`;
  const text =
    `${proposal.openedBy} proposed a change that you can vote on. ` +
    `${sentence} It needs ${needed} ${needed === 1 ? "approval" : "approvals"}. Review it at ${url}`;
  const html = [
    `<p><strong>${escape(proposal.openedBy)}</strong> proposed a change you are eligible to decide.</p>`,
    `<p><em>${escape(sentence)}</em></p>`,
    `<p>It needs <strong>${needed}</strong> ${needed === 1 ? "approval" : "approvals"} before it can be applied.</p>`,
    `<p><a href="${escape(url)}">Review it in the governance queue</a></p>`,
  ].join("\n");
  return { html, text };
}

/**
 * Tell the eligible voters that a proposal is waiting. Fire-and-forget: returns
 * immediately, and every failure (a bad address, a dead provider, a thrown
 * sender) is logged and dropped. Each recipient is attempted independently, so
 * one bad address cannot silence the rest.
 */
export function notifyVoters(state: GovernanceState, proposal: Proposal, ctx: ActionContext = {}): void {
  let run: Promise<void>;
  try {
    run = deliver(state, proposal, ctx);
  } catch (e) {
    // A synchronous throw (bad state shape) must not escape into the request.
    console.warn(`[governance] notify skipped: ${(e as Error).message}`);
    return;
  }
  const tracked = run.catch((e: unknown) => {
    console.warn(`[governance] notify failed: ${(e as Error).message}`);
  });
  inflight.add(tracked);
  void tracked.finally(() => inflight.delete(tracked));
}

async function deliver(state: GovernanceState, proposal: Proposal, ctx: ActionContext): Promise<void> {
  const policy = requiredPolicy(state, proposal.action, ctx);
  const recipients = eligibleVoters(state, policy, ctx, proposal.openedBy).slice(0, MAX_RECIPIENTS);
  if (recipients.length === 0) return;

  const sentence = renderPolicySentence(policy, {
    roleName: policy.eligibleRole || state.config.defaultEligibleRole,
  });
  const subject = notificationSubject(proposal);
  const { html, text } = notificationBody(proposal, sentence, policy.thresholdN);

  for (const to of recipients) {
    try {
      await sender(to, subject, html, text);
    } catch (e) {
      console.warn(`[governance] notify ${to} failed: ${(e as Error).message}`);
    }
  }
}
