// Starting a conversation (phase 2b, S3): POST /api/comms/conversations {clientId, handle, network, text}.
//
// v1 (DECISIONS D11): new conversations are iMessage / SMS only, through BlueBubbles. Email sending
// does not exist yet; other networks can only be continued, never started.
//
//   1. An iMessage/SMS one-to-one thread with that handle already projected → answered at once,
//      NOTHING is sent ({existing: true, threadId, thread}); the client opens it and the owner sends
//      normally. A clientId that was already used for a send skips this (a retry must replay).
//   2. Otherwise the first message goes out through the ordinary Comms send pipeline's iMessage leg
//      (bluebubbles/comms-send.ts: the comms_sends ledger by clientId, the transport's
//      delivered-copy check, audit) to `iMessage;-;<handle>` / `SMS;-;<handle>`. BlueBubbles 1.9.12
//      (message/text, method apple-script) sends to `chat id …` and, when Messages has no such chat,
//      falls back to `participant "<addr>" of service` — the same path its own `POST chat/new` takes
//      on macOS ≥ Big Sur. Messages may file the new chat under another prefix (`any;-;…` on recent
//      macOS), so the real chat GUID is read back (the send's answer, else the message's chats).
//   3. The chat is projected right away when BlueBubbles shows it; else the answer is `pending` with
//      the thread id it will have (the webhook / poll projects it and announces thread.updated).
// The route (routes/comms-send.ts postConversation) runs the HTTP gates first: owner, send enabled,
// device token + human origin, the send rate limit, input validation.
import { normalizePhone } from "../identity";
import { db } from "../db";
import { getThread } from "./store";
import { SendError, auditSend, type SendRequest } from "./send";
import { imessageSendEnabled } from "./send-policy";
import { bbThreadSource, conversationIdForChat, projectChat, threadIdForChat, type BbReader } from "../bluebubbles/project";
import { blueBubblesActive, blueBubblesCreds } from "../bluebubbles/config";
import { sendViaBlueBubbles } from "../bluebubbles/comms-send";
import { blueBubblesBook, blueBubblesReader } from "../bluebubbles/service";
import type { ContactBook } from "../bluebubbles/contacts";
import type { Thread } from "./types";

export type HandleKind = "phone" | "email";
export interface Handle { kind: HandleKind; value: string }
export type StartNetwork = "imessage" | "sms";

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const MAX_EMAIL = 254;

/** A sendable address: a phone WITH a country code (`+…` / `00…`, formatting allowed) → E.164, or an
 *  email (lowercased). Anything else → null. */
export function parseHandle(raw: unknown): Handle | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  // Controls and Unicode format characters (bidi overrides, zero-width): the address shown would
  // not be the address sent to (review M2).
  if (!t || t.length > 320 || /[\u0000-\u001f\u007f]|\p{Cf}/u.test(t)) return null;
  if (t.includes("@")) {
    const e = t.toLowerCase();
    // Printable ASCII only (no look-alike or invisible characters; internationalised addresses are
    // not offered for a new conversation).
    return e.length <= MAX_EMAIL && /^[\x21-\x7e]+$/.test(e) && EMAIL_RE.test(e) ? { kind: "email", value: e } : null;
  }
  // "+44 (0)20 …": the bracketed trunk 0 is not dialled internationally (review M1).
  const d = normalizePhone(t.replace(/\(\s*0\s*\)/g, " "));
  // A country code never starts with 0.
  return d && !d.startsWith("0") ? { kind: "phone", value: `+${d}` } : null;
}

/** The handle's comms_conversation_members id (bluebubbles/contacts.ts bbMemberId). */
export const handleMemberId = (h: Handle): string => (h.kind === "phone" ? `tel:${h.value}` : `mailto:${h.value}`);

/** Every chat GUID Messages may file a one-to-one chat with `h` under; the first is the send target. */
export function chatGuidsFor(h: Handle, network: StartNetwork): string[] {
  const target = `${network === "sms" ? "SMS" : "iMessage"};-;${h.value}`;
  return [...new Set([target, ...["iMessage", "SMS", "RCS", "any"].map((s) => `${s};-;${h.value}`)])];
}

/** The existing iMessage/SMS one-to-one thread with `h` (the requested network first, then the
 *  newest), or null. Only threads this connector projected (bbThreadSource) count. */
export function existingThreadFor(h: Handle, preferred: StartNetwork): string | null {
  const ids = chatGuidsFor(h, preferred).map(conversationIdForChat);
  const rows = db.prepare(`SELECT m.thread_id AS thread_id, c.network AS network FROM comms_conversations c
      JOIN comms_thread_members m ON m.conversation_id = c.id
    WHERE c.kind = 'dm' AND c.network IN ('imessage', 'sms') AND c.source_ref NOT LIKE '!%'
      AND (c.id IN (SELECT conversation_id FROM comms_conversation_members WHERE member_id = ?) OR c.id IN (${ids.map(() => "?").join(",")}))
    ORDER BY CASE WHEN c.network = ? THEN 0 ELSE 1 END, c.last_event_at DESC, m.thread_id DESC LIMIT 10`)
    .all(handleMemberId(h), ...ids, preferred) as { thread_id: string; network: string }[];
  return rows.find((r) => !!bbThreadSource(r.thread_id))?.thread_id ?? null;
}

/** Existing one-to-one iMessage/SMS threads for many member ids at once (recipients search). */
export function existingThreadsByMember(memberIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!memberIds.length) return out;
  const rows = db.prepare(`SELECT cm.member_id AS member_id, m.thread_id AS thread_id FROM comms_conversation_members cm
      JOIN comms_conversations c ON c.id = cm.conversation_id
      JOIN comms_thread_members m ON m.conversation_id = c.id
    WHERE cm.member_id IN (${memberIds.map(() => "?").join(",")}) AND c.kind = 'dm' AND c.network IN ('imessage', 'sms')
      AND c.source_ref NOT LIKE '!%'
    ORDER BY CASE WHEN c.network = 'imessage' THEN 0 ELSE 1 END, c.last_event_at DESC`)
    .all(...memberIds) as { member_id: string; thread_id: string }[];
  for (const r of rows) if (!out.has(r.member_id)) out.set(r.member_id, r.thread_id);
  return out;
}

type Reader = BbReader;
let override: { reader: Reader | null; book: ContactBook } | null = null;
/** Tests: the chat reader + contact book used after the send (null restores the live ones). */
export function setConversationDepsForTests(v: typeof override): void {
  override = v;
}

export interface StartRequest extends Omit<SendRequest, "threadId" | "requestHash" | "creds" | "text" | "attachment"> {
  handle: Handle;
  network: StartNetwork;
  text: string;
  requestHash: string;
}
export type StartOutcome =
  | { existing: true; threadId: string; thread: Thread | null }
  | { existing: false; threadId: string; thread: Thread | null; pending: boolean; replayed: boolean; body: { clientId: string; eventId: string; status: "sent" } };

const clientIdUsed = (clientId: string): boolean => !!db.prepare(`SELECT 1 FROM comms_sends WHERE client_id = ?`).get(clientId);

/** A new conversation to a handle started in the last RECENT_START_MS under ANOTHER clientId (review
 *  M8: a client that mints a clientId per tap). In memory; the ledger still guards each clientId. */
const RECENT_START_MS = 30_000;
const recentStarts = new Map<string, { clientId: string; at: number }>();
function recentlyStarted(key: string, clientId: string, now = Date.now()): boolean {
  for (const [k, v] of recentStarts) if (now - v.at > RECENT_START_MS) recentStarts.delete(k);
  const hit = recentStarts.get(key);
  return !!hit && hit.clientId !== clientId;
}
/** Tests: forget recent starts. */
export function resetRecentStartsForTests(): void {
  recentStarts.clear();
}

/** Steps 1–3 above. Throws SendError (audited). */
export async function startConversation(r: StartRequest): Promise<StartOutcome> {
  const guids = chatGuidsFor(r.handle, r.network);
  const target = guids[0]!;
  const predicted = threadIdForChat(target);
  const audit: Record<string, unknown> = { route: "conversations", network: r.network, handleKind: r.handle.kind, newChat: true };

  // 1. Existing → nothing is sent. (A clientId already in the ledger is a retry: it must replay.)
  if (!clientIdUsed(r.clientId)) {
    const existing = existingThreadFor(r.handle, r.network);
    if (existing) {
      auditSend(r, { ...audit, threadId: existing, existing: true }, "refused", "existing_conversation");
      return { existing: true, threadId: existing, thread: getThread(existing) };
    }
  }

  // The iMessage family: no connector → not available; configured but off / silent → send_disabled.
  if (!blueBubblesActive() || !blueBubblesCreds()) {
    auditSend(r, audit, "refused", "unsupported_network");
    throw new SendError(409, "unsupported_network", "Starting new conversations needs the iMessage connector, which isn't set up on this server.");
  }
  if (!imessageSendEnabled()) {
    auditSend(r, audit, "refused", "send_disabled");
    throw new SendError(403, "send_disabled", "Sending iMessage/SMS is turned off on this server, or BlueBubbles isn't answering.");
  }

  const startKey = `${r.network}:${r.handle.value}`;
  if (recentlyStarted(startKey, r.clientId)) {
    auditSend(r, audit, "refused", "in_progress");
    throw new SendError(409, "in_progress", "A conversation with this address was just started. Open it from the list, or wait a moment.");
  }
  recentStarts.set(startKey, { clientId: r.clientId, at: Date.now() });

  // 2. Send through the Comms pipeline's iMessage leg (ledger, idempotency, audit).
  const send: SendRequest = { ...r, threadId: predicted, creds: null, text: { body: r.text, replyTo: null } };
  const refuse = (e: SendError, status: "refused" | "failed" = "refused"): never => {
    auditSend(send, { ...audit, threadId: predicted }, status, e.code);
    throw e;
  };
  let out: Awaited<ReturnType<typeof sendViaBlueBubbles>>;
  try {
    out = await sendViaBlueBubbles(send, target, { ...audit, threadId: predicted, network: r.network }, refuse, { findIn: guids.slice(1) });
  } catch (e) {
    if (e instanceof SendError && e.maybeSent !== true && recentStarts.get(startKey)?.clientId === r.clientId) recentStarts.delete(startKey);
    throw e;
  }

  // 3. Where did the message land? Project that chat when BlueBubbles shows it.
  const { threadId, thread } = await projectNewChat(out.chatGuid ?? null, out.body.eventId, guids);
  return { existing: false, threadId: threadId ?? predicted, thread, pending: !thread, replayed: out.replayed, body: out.body };
}

async function projectNewChat(chatHint: string | null, eventId: string, guids: string[]): Promise<{ threadId: string | null; thread: Thread | null }> {
  const reader = override ? override.reader : (blueBubblesReader() as Reader | null);
  if (!reader) return { threadId: chatHint ? threadIdForChat(chatHint) : null, thread: null };
  let real = chatHint;
  if (!real) {
    const m = await reader.getMessage(eventId).catch(() => null);
    real = m?.chats?.find((c) => typeof c?.guid === "string" && c.guid.includes(";-;"))?.guid ?? null;
  }
  // The real GUID first, then the send target (bounded: two chat reads).
  for (const g of [...new Set([real, guids[0]].filter((x): x is string => !!x))]) {
    const chat = await reader.getChat(g).catch(() => null);
    if (!chat) continue;
    try {
      const book = override?.book ?? (await blueBubblesBook());
      const threadId = await projectChat(chat, book, { reader });
      return { threadId, thread: getThread(threadId) };
    } catch (e) {
      console.warn(`[comms] new conversation projection failed (${(e as Error)?.name ?? "error"}); the webhook / poll will project it`);
      return { threadId: threadIdForChat(chat.guid), thread: null };
    }
  }
  return { threadId: real ? threadIdForChat(real) : null, thread: null };
}
