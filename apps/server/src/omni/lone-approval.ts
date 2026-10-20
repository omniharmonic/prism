/**
 * A draft proposed without a chat gets one of its own — `omni-approval-<approvalId>`, titled with
 * the approval's headline — so its push opens a chat that shows the draft and its buttons
 * (ApprovalCardView). Spec 2026-10-18 "Lone approvals". Shows and announces; never decides or sends.
 */
import { approvalView, attachApprovalThread, getApproval, type Approval } from "./approvals";
import { approvalHeadline } from "./push-text";
import { ensureSourceSession } from "./source-session";
import { bumpUnread, ensureThread } from "./store";
import { emit } from "./turns";
import { publishNotice } from "./bus";

export const loneApprovalThreadId = (approvalId: string): string => `omni-approval-${approvalId}`;

/** The chat id. Throws when Hermes cannot back the chat or the approval already has one: the caller
 *  then announces the approval the old way. */
export async function openLoneApprovalChat(owner: string, a: Approval): Promise<string> {
  const threadId = loneApprovalThreadId(a.id);
  const title = approvalHeadline(a);
  await ensureSourceSession(owner, `approval:${a.id}`, title, threadId);
  ensureThread({ id: threadId, title, source: "approval", state: "waiting" }); // needs-you is derived from the pending draft (threadView)
  if (!attachApprovalThread(a.id, threadId)) throw new Error("approval_already_in_a_chat");
  const linked = getApproval(owner, a.id)!;
  emit(threadId, null, { t: "approval", approval: approvalView(linked) });
  bumpUnread(threadId);
  publishNotice({ type: "thread", id: threadId, op: "created" });
  publishNotice({ type: "approval", id: a.id, op: "pending", threadId });
  return threadId;
}
