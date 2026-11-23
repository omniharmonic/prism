/**
 * Email from Comms — the ONE DOOR (owner hard line; DECISIONS D9, D11; COMMS_EMAIL_SEND_ENABLED,
 * default off). Comms has no email sender of its own and never talks to SMTP.
 *
 * The owner types a reply (or a new email) on his signed-in device and presses Send. That press is
 * the approval of that exact message (D9: "the owner editing it and sending it as their own
 * message"). This module turns it into exactly what an Omni approval is, and hands it to the SAME
 * executor Omni's Approve & Send uses:
 *
 *   gates 1–5 (routes/comms-send.ts): owner, flags, DEVICE token + human origin, rate limit, input.
 *   6. The thread from the projection (never a client-named address). A reply answers the thread's
 *      newest inbound email NOTE; To/Cc/Subject/threading come from that note in the vault, read now.
 *      Two recipient sets exist, as in Mail: Reply (the sender / Reply-To only — the default) and
 *      Reply All (plus its To/Cc, minus the owner); the echo must equal one of them, and every
 *      recipient must be on the thread (sender / Reply-To / To / Cc of its emails). The account must be the one Comms sends as (the owner's — no
 *      fallback). The client echoes the To/Cc/Subject it SHOWED; a difference → 409 target_changed,
 *      nothing created (what the owner saw is what is sent).
 *   7. Plain text only (proton_send.py refuses Markdown; refused here first: 422 not_plain_text).
 *   8. The Comms ledger by clientId. Email has no transport dedupe, so a maybe-sent message is
 *      NEVER retried (retry window: none) — the client must check the thread.
 *   9. An `email-reply` (or `email`) approval is created with the exact payload and CLAIMED at once
 *      by this human device request with its digest (createApproval + claimApproval — the same
 *      atomic claim `decide` performs); the reply-recipients check runs as in `decide`; then
 *      runClaimedApproval → proton_send.py, which can send only with the one-time grant Prism mints
 *      for that approval and the digest of exactly these recipients/subject/body.
 * Audit: action_audit `comms.send` (ids/hashes only) and omni_audit `approval.approve|send` (via
 * "comms-device"). Never the body, an address or a credential in a log.
 */
import { db } from "../db";
import { config } from "../config";
import { vaultClient, VaultError, type Note } from "../parachute";
import { resolveVaultEntry } from "../db";
import { omniConfig } from "../omni/config";
import { omniAudit } from "../omni/store";
import {
  ApprovalInputError, applyReplyContext, claimApproval, closeApproval, createApproval, finishApproval, unclaimApproval, validatePayload,
  type ApprovalKind, type ExecOutcome,
} from "../omni/approvals";
import { replyRecipientsCheck } from "../omni/recipients";
import { scrubActionError } from "../actions/store";
import { SendError, auditSend, type SendOutcome, type SendRequest } from "./send";
import { claimSend, contentHmac, markMaybeSent, markSent, releaseSend } from "./send-ledger";
import { appendEvent, ensureSingleThread, upsertConversation, setThreadPerson, replaceConversationMembers } from "./store";
import {
  EMAIL_CAPABILITIES, emailConversationId, emailSourceRef, emailThreadSource, emailRichText, mailboxes, replyOptions, replySubject, sendingAccount, threadAddresses,
} from "./email";
import { resolveAvatar, resolveTitle } from "./naming";
import type { Message } from "./types";

/** What the owner's composer showed (echoed on Send). */
export interface EmailEcho { to: string[]; cc: string[]; subject: string }

// ── seams (tests) ──────────────────────────────────────────────────────────

type Exec = (o: { kind: ApprovalKind; payload: Record<string, unknown>; approvalId: string; headers: Record<string, string> }) => Promise<ExecOutcome>;
let readNote: (id: string) => Promise<Note | null> = async (id) => {
  try {
    return await vaultClient(resolveVaultEntry(undefined).id, { timeoutMs: 10_000 }).getNote(id);
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return null;
    throw e;
  }
};
let execOverride: Exec | null = null;
/** Tests: the vault note reader and the executor (null restores the real ones). */
export function setEmailSendForTests(o: { readNote?: ((id: string) => Promise<Note | null>) | null; exec?: Exec | null }): void {
  if (o.readNote !== undefined) readNote = o.readNote ?? readNote;
  if (o.exec !== undefined) execOverride = o.exec;
}
const runExecutor: Exec = async (o) => {
  if (execOverride) return execOverride(o);
  const { runClaimedApproval } = await import("../routes/omni");
  // Only the approval id: the runner loads it, checks it is claimed via this door, runs its stored payload.
  return runClaimedApproval(o.approvalId, VIA);
};
const VIA = "comms-device";

/**
 * What of an executor's outcome is kept (omni_approvals.result, omni_audit.error): never an address
 * or a subject — proton_send.py's stderr echoes the reply context and refused recipients. Only the
 * first `ERROR:` line with every address masked, or a short code.
 */
export function safeOutcomeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["executor", "exitCode", "messageId"]) if (detail[k] !== undefined) out[k] = detail[k];
  const raw = typeof detail.error === "string" ? detail.error : "";
  if (raw) {
    const line = /^ERROR: .*$/m.exec(raw)?.[0] ?? (/^[a-z_ ]{1,40}$/i.test(raw.trim()) ? raw.trim() : "send_error");
    out.error = line.replace(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/g, "[address]").slice(0, 200);
  }
  return out;
}

// ── validation ─────────────────────────────────────────────────────────────

// proton_send.py `_MARKDOWN_PATTERNS` (same shapes): a body matching any is refused there.
const MARKDOWN: Array<[string, RegExp]> = [
  ["bold", /\*\*[^*\n]+\*\*/], ["underscores", /__[^_\n]+__/], ["heading", /^[ \t]{0,3}#{1,6}[ \t]+\S/m],
  ["link", /\[[^\]\n]{1,120}\]\([^)\n]{1,300}\)/], ["code fence", /```/], ["inline code", /`[^`\n]+`/],
  ["bullet", /^[ \t]{0,3}[-*+][ \t]+\S/m], ["quote", /^[ \t]{0,3}>[ \t]+\S/m],
];
export function markdownIn(body: string): string | null {
  return MARKDOWN.find(([, re]) => re.test(body))?.[0] ?? null;
}
const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;
const normList = (v: string[]): string[] => [...new Set(v.map((a) => a.trim().toLowerCase()))].sort();
const sameList = (a: string[], b: string[]): boolean => JSON.stringify(normList(a)) === JSON.stringify(normList(b));

export function validateEcho(v: unknown): EmailEcho | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new SendError(422, "invalid", "email must be an object.");
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "to" && k !== "cc" && k !== "subject")) throw new SendError(422, "invalid", "Unknown field in email.");
  const list = (x: unknown, f: string): string[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || x.length > 50 || x.some((a) => typeof a !== "string" || a.length > 320)) throw new SendError(422, "invalid", `email.${f} must be a list of addresses.`);
    return x as string[];
  };
  if (typeof o.subject !== "string" || o.subject.length > 998) throw new SendError(422, "invalid", "email.subject is required.");
  return { to: list(o.to, "to"), cc: list(o.cc, "cc"), subject: o.subject };
}

// ── the pipeline ───────────────────────────────────────────────────────────

type Refuse = (e: SendError, status?: "refused" | "failed") => never;

interface Plan { kind: ApprovalKind; payload: Record<string, unknown>; conversationId: string | null; threadId: string; echoTo: string[]; echoCc: string[]; subject: string }

/** Gates 6–9 of a reply on an email thread. */
export async function sendEmailReply(r: SendRequest, target: Record<string, unknown>, refuse: Refuse): Promise<SendOutcome> {
  const src = emailThreadSource(r.threadId);
  if (!src || !r.text) return refuse(new SendError(404, "not_found", "This conversation isn't available."));
  if (r.text.replyTo) return refuse(new SendError(422, "invalid", "Replying to a single email isn't supported; the reply answers the thread."));
  if (!r.email) return refuse(new SendError(422, "invalid", "An email reply needs the To, Cc and Subject the composer showed."));
  // The newest inbound note of the thread — read from the vault NOW (to/cc/subject/threading).
  const idx = db.prepare(`SELECT note_id FROM comms_email_messages WHERE conversation_id = ? AND is_self = 0 ORDER BY sent_at DESC, note_id DESC LIMIT 1`)
    .get(src.conversationId) as { note_id: string } | undefined;
  if (!idx) return refuse(new SendError(409, "unsupported_network", "There's no received email in this conversation to reply to."));
  let note: Note | null;
  try {
    note = await readNote(idx.note_id);
  } catch {
    return refuse(new SendError(503, "source_unavailable", "The email couldn't be read right now; nothing was sent."));
  }
  const meta = (note?.metadata ?? {}) as Record<string, unknown>;
  const account = sendingAccount();
  if (!note || typeof meta.account !== "string" || meta.account.trim().toLowerCase() !== account) {
    return refuse(new SendError(409, "wrong_account", "This email arrived at an account Comms can't send from. Reply from your mail app."));
  }
  // Reply (sender only) or Reply All — whichever the composer showed; nothing else is accepted.
  const options = replyOptions(meta as { from: unknown; to: unknown; cc: unknown; replyTo?: unknown; subject?: unknown }, [account, config.ownerEmail]);
  const chosen = [options.reply, options.replyAll].find((o) => o && sameList(o.to, r.email!.to) && sameList(o.cc, r.email!.cc));
  if (!chosen) return refuse(new SendError(409, "target_changed", "The recipients changed since the composer showed them. Check them and send again."));
  const { to, cc } = chosen;
  // Only people on the thread (sender / Reply-To / To / Cc of its emails, or of this one).
  const onThread = threadAddresses(src.conversationId);
  for (const b of [...mailboxes(meta.from), ...mailboxes(meta.replyTo ?? ""), ...mailboxes(meta.to), ...mailboxes(meta.cc)]) onThread.add(b.addr);
  if ([...to, ...cc].some((a) => !onThread.has(a.toLowerCase()))) {
    return refuse(new SendError(409, "target_changed", "The reply would go to someone who isn't on this thread. Nothing was sent."));
  }
  let payload: Record<string, unknown>;
  try {
    payload = validatePayload("email-reply", { noteId: note.id, expectTo: to, ...(cc.length ? { cc } : {}), body: r.text.body }).payload;
    payload = applyReplyContext(payload, note, omniConfig.ownerEmail());
  } catch (e) {
    if (e instanceof ApprovalInputError) return refuse(new SendError(409, "unsupported_network", "This email can't be replied to from Comms (no usable address or message id)."));
    throw e;
  }
  return execute(r, target, refuse, { kind: "email-reply", payload, conversationId: src.conversationId, threadId: r.threadId, echoTo: to, echoCc: cc, subject: String(payload.subject) });
}

/** A NEW email (POST /api/comms/conversations network "email", D11). */
export async function sendNewEmail(r: SendRequest & { newEmail: { to: string; subject: string } }, target: Record<string, unknown>, refuse: Refuse): Promise<SendOutcome & { threadId: string }> {
  const to = r.newEmail.to.trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return refuse(new SendError(422, "invalid_handle", "That isn't an email address."));
  const subject = r.newEmail.subject.replace(/[\r\n\0]+/g, " ").trim();
  if (!subject) return refuse(new SendError(422, "invalid", "A new email needs a subject."));
  let payload: Record<string, unknown>;
  try {
    payload = validatePayload("email", { to: [to], subject, body: r.text!.body }).payload;
  } catch (e) {
    if (e instanceof ApprovalInputError) return refuse(new SendError(422, "invalid", "The email couldn't be prepared."));
    throw e;
  }
  const out = await execute({ ...r, email: { to: [to], cc: [], subject } }, target, refuse, { kind: "email", payload, conversationId: null, threadId: r.threadId, echoTo: [to], echoCc: [], subject });
  return out as SendOutcome & { threadId: string };
}

async function execute(r: SendRequest, target: Record<string, unknown>, refuse: Refuse, p: Plan): Promise<SendOutcome & { threadId?: string }> {
  // What the owner saw is what is sent.
  if (!r.email || !sameList(r.email.to, p.echoTo) || !sameList(r.email.cc, p.echoCc) || r.email.subject.trim() !== p.subject.trim()) {
    return refuse(new SendError(409, "target_changed", "The recipients or subject changed since the composer showed them. Check them and send again."));
  }
  const md = markdownIn(r.text!.body);
  if (md) return refuse(new SendError(422, "not_plain_text", `Email is sent as plain text; remove the formatting (${md}) and send again.`));
  target.textHash = contentHmac(r.text!.body).slice(0, 16);
  target.recipients = p.echoTo.length + p.echoCc.length;

  // 8. Ledger. No retry of a maybe-sent email (no transport dedupe): retry window none.
  const claim = claimSend({ clientId: r.clientId, actorEmail: r.actor.email, threadId: r.threadId, kind: "text", requestHash: r.requestHash, credHash: "email", retryWindowMs: -1 });
  if (claim.kind === "replay") {
    auditSend(r, { ...target, eventId: claim.response.eventId }, "replayed");
    return { status: 200, body: claim.response as SendOutcome["body"], replayed: true };
  }
  if (claim.kind === "mismatch") return refuse(new SendError(422, "invalid", "This clientId was already used for a different message."));
  if (claim.kind === "in_progress") return refuse(new SendError(409, "in_progress", "This email is still being sent."));
  if (claim.kind === "expired") return refuse(new SendError(502, "send_failed", "This email may have been sent and can't be retried safely. Check the conversation (or your Sent folder) before sending it again.", true), "failed");
  const { retry, attempt } = claim;
  const unsent = (e: SendError): never => {
    try { releaseSend(r.clientId, attempt, retry); } catch (le) { console.error(`[comms] send ledger release failed: ${scrubActionError(le)}`); }
    return refuse(e, e.status === 502 ? "failed" : "refused");
  };

  // 9. The approval, created and claimed by THIS device press with the exact payload's digest.
  const owner = omniConfig.ownerEmail();
  const via = VIA;
  const device = (r.actor as { deviceId?: string }).deviceId ?? null;
  const a = createApproval({ owner, threadId: null, kind: p.kind, payload: p.payload, summary: p.kind === "email" ? "New email sent from Comms" : "Email reply sent from Comms", ttlMs: 5 * 60_000 });
  target.approvalId = a.id;
  if (!claimApproval(a.id, a.digest, via, device, `comms:${r.clientId}`)) return unsent(new SendError(409, "in_progress", "This email is already being sent."));
  omniAudit({ actor: owner, via, action: "approval.approve", approvalId: a.id, digest: a.digest, status: "ok" });
  const withdraw = (error: string): void => {
    unclaimApproval(a.id);
    closeApproval(a.id, "cancelled", via, device, null);
    omniAudit({ actor: owner, via, action: "approval.send", approvalId: a.id, digest: a.digest, status: "refused", error });
  };
  const check = await replyRecipientsCheck(a, owner).catch(() => ({ ok: false as const, detail: "unreadable" }));
  if (!check.ok) {
    withdraw("target_changed");
    return unsent(new SendError(409, "target_changed", "The reply would go to someone who isn't on the email. Nothing was sent."));
  }
  let out: ExecOutcome;
  try {
    out = await runExecutor({ kind: p.kind, payload: a.payload, approvalId: a.id, headers: {} });
  } catch {
    out = { status: "unknown", detail: { error: "executor_error" } };
  }
  if (out.status === "disabled") {
    withdraw(String(safeOutcomeDetail(out.detail).error ?? "executor_disabled"));
    return unsent(new SendError(403, "send_disabled", "Sending email is turned off on this server."));
  }
  const kept = safeOutcomeDetail(out.detail);
  finishApproval(a.id, out.status, kept);
  omniAudit({ actor: owner, via, action: "approval.send", approvalId: a.id, digest: a.digest, status: out.status, error: out.status === "sent" ? null : String(kept.error ?? "") || null });
  if (out.status === "failed") return unsent(new SendError(502, "send_failed", "The email was refused and not sent.", false));
  if (out.status === "unknown") {
    try { markMaybeSent(r.clientId, attempt); } catch (le) { console.error(`[comms] send ledger update failed: ${scrubActionError(le)}`); }
    return refuse(new SendError(502, "send_failed", "The email may have been sent. Check your Sent folder before sending it again.", true), "failed");
  }

  // Sent. From here bookkeeping failures are logged, never reported as "not sent".
  const eventId = `email-sent:${a.id}`;
  let threadId = p.threadId;
  try {
    const messageId = typeof out.detail.messageId === "string" ? out.detail.messageId.replace(/^<|>$/g, "") : a.id;
    const conversationId = p.conversationId ?? ensureNewEmailConversation(messageId, p.echoTo[0]!);
    threadId = `th_${conversationId}`;
    recordSent(conversationId, threadId, eventId, r.clientId, r.text!.body, p);
  } catch (le) {
    console.error(`[comms] email echo bookkeeping failed: ${scrubActionError(le)}`);
  }
  try { markSent(r.clientId, attempt, eventId); } catch (le) { console.error(`[comms] send ledger update failed after a successful send: ${scrubActionError(le)}`); }
  auditSend(r, { ...target, eventId }, "ok");
  return { status: 200, body: { clientId: r.clientId, eventId, status: "sent" }, replayed: false, threadId };
}

/** The conversation a NEW email starts (its own Message-ID is the thread root the reply will carry). */
function ensureNewEmailConversation(messageId: string, to: string): string {
  const account = sendingAccount();
  const id = emailConversationId(account, messageId);
  const box = mailboxes(to)[0];
  // A known person (§5.9: never a raw address when a better name exists): the person a projected
  // conversation already links to this address by its verified key.
  const known = db.prepare(`SELECT cm.person_id AS person, c.title AS title FROM comms_conversation_members cm
    JOIN comms_conversations c ON c.id = cm.conversation_id WHERE cm.member_id = ? AND cm.person_id IS NOT NULL AND c.title_source = 'person'
    ORDER BY c.last_event_at DESC LIMIT 1`).get(`mailto:${to.toLowerCase()}`) as { person: string; title: string } | undefined;
  const { title, titleSource } = resolveTitle({ person: known ? { name: known.title } : null, emailDisplayName: box?.addr ?? to, memberDisplayNames: [], handle: to, kind: "dm", network: "email" });
  const now = new Date().toISOString();
  upsertConversation({
    id, network: "email", sourceRef: emailSourceRef(account, messageId), kind: "dm", title, titleSource, avatar: resolveAvatar({ title }),
    lastEventAt: now, lastPreview: null, unreadCount: 0, unreadTrusted: true, folder: "inbox", pinned: false, muted: false, archived: false,
    triage: null, accountLabel: account, capabilities: EMAIL_CAPABILITIES, vaultNoteId: null,
  });
  const threadId = ensureSingleThread(id);
  replaceConversationMembers(id, [{ memberId: `mailto:${to}`, personId: known?.person ?? null }]);
  setThreadPerson(threadId, known?.person ?? null);
  return id;
}

function recordSent(conversationId: string, threadId: string, eventId: string, clientId: string, body: string, p: Plan): void {
  const at = new Date().toISOString();
  const account = sendingAccount();
  const rich = emailRichText(body);
  const msg: Message = {
    id: eventId, threadId, channel: { network: "email", accountLabel: account },
    source: { network: "email", eventId, ref: eventId },
    sender: { id: `mailto:${account}`, name: "You", avatar: null, isSelf: true, isOmni: false },
    sentAt: at, body: rich.body,
    email: { subject: p.subject, from: account, to: p.echoTo, cc: p.echoCc, quotedCollapsed: rich.quotedCollapsed, hasHtml: false },
    attachments: [], linkPreviews: [], reactions: [], delivery: "sent", redacted: false, clientId,
  };
  db.prepare(`INSERT OR REPLACE INTO comms_email_sent (conversation_id, event_id, sent_at, json) VALUES (?, ?, ?, ?)`).run(conversationId, eventId, at, JSON.stringify(msg));
  db.prepare(`UPDATE comms_conversations SET last_event_at = ?, last_preview_json = ?, unread_count = 0 WHERE id = ?`)
    .run(at, JSON.stringify({ text: body.replace(/\s+/g, " ").trim().slice(0, 280), subject: p.subject, senderName: null, isSelf: true, sentAt: at }), conversationId);
  appendEvent("message.created", threadId, { threadId, message: msg });
  appendEvent("thread.updated", threadId, { threadId });
}

export { replySubject };
