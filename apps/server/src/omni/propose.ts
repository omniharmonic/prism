/**
 * The one way a draft becomes a PENDING approval: the omni-bridge hook (`omni_propose`) and a
 * card option the owner picked. Stores, shows and announces — never decides, never sends.
 */
import { approvalView, createApproval, type Approval, type ApprovalKind } from "./approvals";
import { activeTurn, ensureThread, omniAudit } from "./store";
import { emit } from "./turns";
import { publishNotice, pushOmni } from "./bus";

export function proposeApproval(o: {
  owner: string; threadId: string | null; kind: ApprovalKind; payload: Record<string, unknown>; summary: string | null;
  ttlMs: number; actor: string; via: string; push: boolean;
}): Approval {
  const a = createApproval({ owner: o.owner, threadId: o.threadId, kind: o.kind, payload: o.payload, summary: o.summary, ttlMs: o.ttlMs });
  omniAudit({ actor: o.actor, via: o.via, action: "approval.propose", approvalId: a.id, threadId: o.threadId, digest: a.digest, status: "ok" });
  if (o.threadId) {
    ensureThread({ id: o.threadId, source: "hermes" });
    emit(o.threadId, null, { t: "approval", approval: approvalView(a) });
    // A paused tool call: the turn is waiting for the person, and the thread says so.
    if (a.kind === "command" && activeTurn(o.threadId)) emit(o.threadId, activeTurn(o.threadId)!.id, { t: "status", state: "needs-you", reason: "approval_requested" });
  }
  publishNotice({ type: "approval", id: a.id, op: "pending", threadId: o.threadId ?? undefined });
  if (o.push) pushOmni("OMNI_APPROVAL", a.id);
  return a;
}
