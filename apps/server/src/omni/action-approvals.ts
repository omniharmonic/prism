/**
 * Approved `action`s (approvals.ts, KIND `action`): an outward step with no draft kind of its own
 * — a booking page's Confirm, a web form, a sign-up — that the owner approved, possibly hours
 * after it was proposed. Approving starts a new turn in the approval's thread that carries the
 * approved text; while THAT turn runs the approval is `approved`, and the omni-bridge guard asks
 * `actionGrants(threadId)` which of its approval-tier rules it may let through without a card.
 * When the turn ends the approval closes: `sent` (the turn finished) or `failed` (it errored, was
 * cancelled or interrupted). A turn already running in the thread queues the action; it starts
 * when that turn ends. Nothing here acts on anything itself: Hermes does, under the guard.
 */
import { approvalView, approvedThreadActions, finishApproval, getApproval, noteApprovalResult, type Approval } from "./approvals";
import { getThread, getTurn, omniAudit } from "./store";
import { emit, onTurnEnded, startTurn } from "./turns";
import { publishNotice } from "./bus";
import { omniConfig } from "./config";
import { cardAfterDecision } from "./card-flow";

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The resumed turn's message: the approved action, verbatim, and the limits it runs under. */
export function actionPrompt(a: Approval): string {
  const p = a.payload;
  const permissions = list(p.permissions).length ? list(p.permissions) : list(p.grants);
  const fence = (s: string) => s.replace(/`{3,}/g, "'''");
  return [
    `Benjamin approved this action on his device (approval ${a.id}). Do it now, exactly as approved: nothing more, nothing different.`,
    "```approved-action",
    `What: ${fence(text(p.title))}`,
    `Reaches: ${fence(text(p.reaches))}`,
    ...(text(p.url) ? [`Where: ${fence(text(p.url))}`] : []),
    "Steps:",
    fence(text(p.steps)),
    "```",
    permissions.length
      ? `For this turn only, these run without asking him again: ${permissions.join("; ")}. Anything else still pauses for him or is refused as usual.`
      : "No extra permissions were granted: anything that normally pauses for him still does.",
    "Anything that would also send an email, a chat message, an invite or a post is still a separate omni_propose draft.",
    "If what you find no longer matches what he approved (the time is gone, the price or the terms changed, the form asks for something the steps do not cover), stop before submitting, tell him what changed, and propose a corrected action instead.",
    "When you are done, tell him plainly what happened and how you know (the confirmation the site showed, a reference number, a screenshot path).",
  ].join("\n");
}

/** Start the action's turn now, or leave it queued behind the turn that is running. */
export function runApprovedAction(owner: string, approvalId: string): { turnId: string | null; queued: boolean } {
  const a = getApproval(owner, approvalId);
  if (!a || a.kind !== "action" || a.status !== "approved") return { turnId: null, queued: false };
  if (!a.threadId || !getThread(a.threadId)) {
    finishApproval(a.id, "failed", { error: "no_thread", executor: "hermes-action-turn" });
    announce(owner, a.id, "failed");
    return { turnId: null, queued: false };
  }
  // The one running action of a thread goes first; this one waits its turn.
  const ahead = approvedThreadActions(a.threadId).find((x) => x.id !== a.id && typeof x.result?.turnId === "string");
  if (ahead) {
    noteApprovalResult(a.id, { executor: "hermes-action-turn", queued: true });
    return { turnId: null, queued: true };
  }
  const r = startTurn(a.threadId, actionPrompt(a), `action-${a.id}`);
  if ("active" in r) {
    noteApprovalResult(a.id, { executor: "hermes-action-turn", queued: true });
    return { turnId: null, queued: true };
  }
  const turn = "turn" in r ? r.turn : r.replay;
  noteApprovalResult(a.id, { executor: "hermes-action-turn", turnId: turn.id });
  omniAudit({ actor: owner, via: "server", action: "approval.action-turn", approvalId: a.id, threadId: a.threadId, digest: a.digest, status: "ok" });
  // A replayed key means its turn already ran: close it by that turn's outcome.
  if ("replay" in r) settle(owner, a.threadId);
  return { turnId: turn.id, queued: false };
}

function announce(owner: string, id: string, op: string): void {
  const a = getApproval(owner, id);
  if (!a) return;
  publishNotice({ type: "approval", id, op, threadId: a.threadId ?? undefined });
  if (a.threadId && getThread(a.threadId)) emit(a.threadId, null, { t: "approval", approval: approvalView(a) });
}

/** Close actions whose turn has ended; then start the next queued one. */
function settle(owner: string, threadId: string): void {
  for (const a of approvedThreadActions(threadId)) {
    const turnId = text(a.result?.turnId);
    if (!turnId) continue;
    const turn = getTurn(turnId);
    if (turn && turn.status === "running") return; // still going: nothing else may start
    const ok = turn?.status === "done";
    finishApproval(a.id, ok ? "sent" : "failed", { executor: "hermes-action-turn", turnId, turnStatus: turn?.status ?? "missing" });
    omniAudit({ actor: owner, via: "server", action: "approval.action-done", approvalId: a.id, threadId, digest: a.digest, status: ok ? "sent" : "failed" });
    announce(owner, a.id, ok ? "sent" : "failed");
    try {
      cardAfterDecision(owner, a.id, ok ? "sent" : "failed");
    } catch (e) {
      console.error("omni: card bookkeeping failed", a.id, e);
    }
  }
  const next = approvedThreadActions(threadId).find((a) => !text(a.result?.turnId));
  if (next) runApprovedAction(owner, next.id);
}

/**
 * What the guard may let through without asking, for a thread right now: the grants of the
 * approved action whose turn is running there. Empty for any other thread or moment.
 */
export function actionGrants(threadId: string): Array<{ approvalId: string; turnId: string; grants: string[] }> {
  const out: Array<{ approvalId: string; turnId: string; grants: string[] }> = [];
  for (const a of approvedThreadActions(threadId)) {
    const turnId = text(a.result?.turnId);
    if (!turnId || getTurn(turnId)?.status !== "running") continue;
    out.push({ approvalId: a.id, turnId, grants: list(a.payload.grants) });
  }
  return out;
}

onTurnEnded((threadId) => {
  try {
    settle(omniConfig.ownerEmail(), threadId);
  } catch (e) {
    console.error("omni: settling approved actions failed", threadId, e);
  }
});
