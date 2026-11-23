// Comms sending (Phase 2a, owner-approved 2026-11-22): the owner types or records in Comms on
// his own signed-in device and presses Send — that press IS the approval of that exact message
// (DECISIONS D9). The server still enforces, in order (routes/comms.ts runs the HTTP gates):
//
//   1. requireCommsOwner: COMMS_ENABLED, the server owner, the primary vault, the comms bucket.
//   2. commsSendEnabled(): COMMS_SEND_ENABLED AND a family flag — ACTIONS_MATRIX_ENABLED for the
//      Matrix-bridged networks, BLUEBUBBLES_ENABLED (+ credential + BlueBubbles answering) for
//      imessage/sms (send-policy.ts); the thread's own family is checked at gate 6
//      → else 403 send_disabled.
//   3. HUMAN ORIGIN VIA A DEVICE TOKEN ONLY (`requestVia` = "device", no `X-Prism-Action-Origin:
//      agent` downgrade). A browser session is refused too (403 device_required): the one-door
//      rule (2026-10-15) already says a message to another person needs the owner's DEVICE
//      credential, because a session cookie is a bearer value an agent on the host could lift
//      from a browser profile. MCP (in-process), the loopback owner token, capability links and
//      anon are agent/none → refused. No model, timer or agent can reach a send.
//   4. Rate limit (COMMS_SEND_PER_10MIN, text + attachments together) → 429 rate_limited.
//   5. Input: clientId (UUID), text ≤ 32 000 bytes / attachment fields → 422 invalid,
//      size → 413 too_large, bytes → 415 unsupported_type.
//   6. The client never names a room: the THREAD must be in the projection (left / removed rooms
//      are not) → 404 not_found; its network must be Matrix-bridged (or imessage/sms with the
//      BlueBubbles connector — bluebubbles/comms-send.ts) → else 409 unsupported_network; its
//      family switched off → 403 send_disabled.
//   7. Idempotency by clientId (send-ledger.ts) → replay / 409 in_progress / 422 invalid.
//   8. Live checks with the stored matrix credential: the account is JOINED to the room, and the
//      room holds someone other than the owner's own ids and bridge bots (a bridge management
//      room — where text would be a bridge COMMAND — is never a target) → 404 not_found.
//   9. Upload (attachments) → PUT the event with txn id = f(clientId).
// Every attempt past gate 1 writes an `action_audit` row (`comms.send`): ids, sizes and hashes
// only — never the text, a file name or a credential.
import { createHash } from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { isJoined, sendMatrixEvent, validateEventId } from "../actions/matrix";
import { ActionInputError, ActionTransportError } from "../actions/email";
import { recordAction, scrubActionError, shortHash, type ActionOrigin } from "../actions/store";
import { agentSenderIds, isBridgeBot, MatrixClient, type MatrixCreds } from "../worker/matrix";
import { getThread } from "./store";
import { wellFormed } from "./wire";
import { threadSource, type ThreadSource } from "./timeline";
import { commsSelfIds, storedOwnerSenders } from "./owner";
import {
  RETRY_WINDOW_MS, RETRY_WINDOW_NO_DEVICE_MS, SEND_READ_TIMEOUT_MS, claimSend, contentHmac, markMaybeSent, markSent, releaseSend, txnIdFor, type SendKind,
} from "./send-ledger";
import { CAF_MIME, type AttachmentKind, type MediaFacts } from "./send-media";

export { SEND_NETWORKS, MENTION_NETWORKS, commsSendEnabled, channelCanSend, withSendFlag } from "./send-policy";
import { MENTION_NETWORKS, SEND_NETWORKS, commsSendEnabled, emailSendEnabled, imessageSendEnabled, isBlueBubblesNetwork, matrixSendEnabled } from "./send-policy";
import { emailThreadSource } from "./email";
import { forumTopic, isForumThread, topicOfMessage } from "./forums";
import { bbThreadSource } from "../bluebubbles/project";
import { blueBubblesActive, blueBubblesCreds } from "../bluebubbles/config";
import { sendViaBlueBubbles } from "../bluebubbles/comms-send";
import { COMMS_CAPABILITIES } from "./index";
import { omniConfig } from "../omni/config";

export class SendError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 413 | 415 | 422 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    /** For 502 send_failed: may the homeserver have accepted it? */
    readonly maybeSent?: boolean,
  ) {
    super(message);
    this.name = "SendError";
  }
  body(): Record<string, unknown> {
    return this.maybeSent === undefined ? { error: this.code, message: this.message } : { error: this.code, message: this.message, maybeSent: this.maybeSent };
  }
}

// ── the Matrix client (injectable) ──────────────────────────────────────────

export type CommsSendClient = Pick<MatrixClient, "sendEvent" | "joinedRooms" | "whoamiInfo" | "memberProfiles" | "uploadMedia" | "mediaConfig" | "eventExists" | "roomEncrypted" | "reactionsTo" | "redactEvent">;
let factory: ((creds: MatrixCreds) => CommsSendClient) | null = null;
/** Tests: a fake client (null restores the real one) and fresh caches. */
export function setCommsSendClientForTests(f: ((creds: MatrixCreds) => CommsSendClient) | null): void {
  factory = f;
  whoamiCache.clear();
  limitCache.clear();
}
export const clientFor = (creds: MatrixCreds): CommsSendClient => (factory ?? ((c) => new MatrixClient(c, fetch, SEND_READ_TIMEOUT_MS)))(creds);

export const credHashOf = (creds: MatrixCreds): string =>
  createHash("sha256").update(`${creds.homeserver}\n${creds.accessToken}`).digest("hex").slice(0, 32);

export type Who = { userId: string; deviceId: string | null };
const whoamiCache = new Map<string, { at: number; who: Who }>();
export async function whoami(client: CommsSendClient, credHash: string): Promise<Who> {
  const hit = whoamiCache.get(credHash);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.who;
  const who = await client.whoamiInfo();
  whoamiCache.set(credHash, { at: Date.now(), who });
  return who;
}

const limitCache = new Map<string, { at: number; limit: number | null; ok: boolean }>();
/** The homeserver's upload limit (cached 1 h; a failed read is remembered 5 min as "unknown"). */
export async function homeserverUploadLimit(creds: MatrixCreds): Promise<number | null> {
  const k = credHashOf(creds);
  const hit = limitCache.get(k);
  if (hit && Date.now() - hit.at < (hit.ok ? 3_600_000 : 300_000)) return hit.limit;
  try {
    const limit = await clientFor(creds).mediaConfig();
    limitCache.set(k, { at: Date.now(), limit, ok: true });
    return limit;
  } catch {
    limitCache.set(k, { at: Date.now(), limit: null, ok: false });
    return null;
  }
}

/** The effective attachment cap: config, lowered by the homeserver's when known. */
export async function maxAttachmentBytes(creds: MatrixCreds | null): Promise<number> {
  const mine = config.commsSendMaxBytes;
  const hs = creds ? await homeserverUploadLimit(creds) : null;
  return hs ? Math.min(mine, hs) : mine;
}

// ── validation ──────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateClientId(v: unknown): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new SendError(422, "invalid", "clientId must be a UUID.");
  return v.toLowerCase();
}
export const TEXT_MAX_BYTES = 32_000;
/** `!` + letters as the first token (after leading whitespace) = a bridge command prefix. */
const BRIDGE_COMMAND_RE = /^\s*![a-z]/i;
/** `opts.bridged` = the thread is Matrix-bridged (the default): there `!command` text is refused.
 *  iMessage/SMS (BlueBubbles) have no bridge, so `!` is ordinary text (controller ruling). */
export function validateText(v: unknown, opts: { bridged?: boolean } = {}): string {
  if (typeof v !== "string" || !v.trim()) throw new SendError(422, "invalid", "The message is empty.");
  if (v.includes("\0")) throw new SendError(422, "invalid", "The message contains invalid characters.");
  if (Buffer.byteLength(v, "utf8") > TEXT_MAX_BYTES) throw new SendError(413, "too_large", "The message is too long.");
  if (wellFormed(v) !== v) throw new SendError(422, "invalid", "The message contains invalid characters.");
  // mautrix bridges read a message starting with their command prefix (`!wa`, `!tg`, `!signal` …)
  // as a bridge COMMAND in any portal room — it would never reach the contact. Refused, not escaped.
  if (opts.bridged !== false && BRIDGE_COMMAND_RE.test(v)) throw new SendError(422, "bridge_command", "Messages starting with ! are bridge commands and are not sent.");
  return v;
}
export function validateReplyTo(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    return validateEventId(v);
  } catch (e) {
    if (e instanceof ActionInputError) throw new SendError(422, "invalid", "replyTo is not a message id.");
    throw e;
  }
}

/** One `@Name` mention: the member's Matrix id and the UTF-16 range of the text that names them
 *  (the display name as the owner sees it in the composer). */
export interface Mention { userId: string; start: number; length: number }
export const MAX_MENTIONS = 20;
/** A Matrix user id as the bridges mint them: `@localpart:server`, historical localpart charset,
 *  a host[:port] server — nothing an HTML attribute or a matrix.to URL would need escaped. */
const MATRIX_USER_RE = /^@[A-Za-z0-9._=\-/+]{1,200}:[A-Za-z0-9.\-]{1,200}(:\d{1,5})?$/;
export function validateMentions(text: string, v: unknown): Mention[] {
  if (v === undefined || v === null) return [];
  const bad = (m: string): never => { throw new SendError(422, "invalid", m); };
  if (!Array.isArray(v) || v.length > MAX_MENTIONS) bad(`mentions must be a list of at most ${MAX_MENTIONS}.`);
  const out: Mention[] = [];
  let end = 0;
  for (const raw of v as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("A mention must be {userId, start, length}.");
    const m = raw as Record<string, unknown>;
    if (Object.keys(m).some((k) => k !== "userId" && k !== "start" && k !== "length")) bad("Unknown field in a mention.");
    if (typeof m.userId !== "string" || !MATRIX_USER_RE.test(m.userId)) bad("A mention's userId is not a Matrix user id.");
    if (!Number.isInteger(m.start) || !Number.isInteger(m.length)) bad("A mention's start and length must be whole numbers.");
    const start = m.start as number, length = m.length as number;
    // Ordered, non-overlapping, inside the text, and naming someone (no line breaks, ≤ 100).
    if (start < end || length < 1 || length > 100 || start + length > text.length) bad("A mention's range is outside the text.");
    const named = text.slice(start, start + length);
    if (!named.trim() || /[\r\n]/.test(named) || wellFormed(named) !== named) bad("A mention's range is not a name.");
    out.push({ userId: m.userId as string, start, length });
    end = start + length;
  }
  return out;
}

/** The channel the owner picked in the composer (a merged conversation's "WhatsApp ⌄"). */
export interface ChannelPick { network: string; accountLabel: string | null }
export function validateChannel(v: unknown): ChannelPick | null {
  if (v === undefined || v === null) return null;
  const bad = (): never => { throw new SendError(422, "invalid", "channel must be {network, accountLabel?}."); };
  if (typeof v !== "object" || Array.isArray(v)) bad();
  const c = v as Record<string, unknown>;
  if (Object.keys(c).some((k) => k !== "network" && k !== "accountLabel")) bad();
  if (typeof c.network !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(c.network)) bad();
  if (c.accountLabel !== undefined && c.accountLabel !== null && (typeof c.accountLabel !== "string" || c.accountLabel.length > 100)) bad();
  return { network: c.network as string, accountLabel: (c.accountLabel as string | null | undefined) ?? null };
}

/** The Matrix content of a text: plain `body`, and when it mentions someone an HTML body with a
 *  matrix.to pill per mention + `m.mentions` (MSC3952) so the bridges send native mentions.
 *  Every character of the owner's text is HTML-escaped; only the pills are markup. */
export function textContent(body: string, mentions: Mention[]): Record<string, unknown> {
  if (!mentions.length) return { msgtype: "m.text", body };
  const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\n/g, "<br>");
  let html = "";
  let at = 0;
  for (const m of mentions) {
    html += esc(body.slice(at, m.start));
    html += `<a href="https://matrix.to/#/${m.userId}">${esc(body.slice(m.start, m.start + m.length))}</a>`;
    at = m.start + m.length;
  }
  html += esc(body.slice(at));
  return {
    msgtype: "m.text", body, format: "org.matrix.custom.html", formatted_body: html,
    "m.mentions": { user_ids: [...new Set(mentions.map((m) => m.userId))] },
  };
}

// ── the pipeline ────────────────────────────────────────────────────────────

export interface UploadPart {
  bytes: Buffer;
  facts: MediaFacts;
}
export interface SendRequest {
  actor: { email: string };
  via: string;
  vaultId: string;
  threadId: string;
  clientId: string;
  /** sha256 over everything that defines the message (thread, text / bytes, fields). */
  requestHash: string;
  creds: MatrixCreds | null;
  text?: { body: string; replyTo: string | null; mentions?: Mention[] };
  /** Email threads: the To/Cc/Subject the composer showed (comms/email-send.ts compares them). */
  email?: { to: string[]; cc: string[]; subject: string };
  /** The channel picked in the composer; the send is refused unless the thread sends through it. */
  channel?: ChannelPick | null;
  /** A Telegram forum thread: the topic to post in (required: never "All"; comms/forums.ts). */
  topic?: string | null;
  attachment?: {
    kind: AttachmentKind;
    file: UploadPart;
    thumbnail?: UploadPart | null;
    durationMs?: number | null;
    waveform?: number[] | null;
    w?: number | null;
    h?: number | null;
  };
}

export const requestHashOf = (parts: Record<string, unknown>): string =>
  contentHmac(JSON.stringify(Object.keys(parts).sort().map((k) => [k, parts[k] ?? null])));

export { txnIdFor } from "./send-ledger";

/** Audit one attempt (ids/sizes/hashes only). */
export function auditSend(
  r: Pick<SendRequest, "actor" | "via" | "vaultId" | "clientId"> & { origin?: ActionOrigin; action?: string },
  target: Record<string, unknown>, status: "ok" | "failed" | "refused" | "replayed", error?: string,
): void {
  recordAction({
    // The REAL origin: refused agent attempts (MCP, loopback token, a downgrade) are recorded as
    // such. Past gate 3 every request is human by construction.
    actorEmail: r.actor.email, via: r.via, origin: r.origin ?? "human", action: r.action ?? "comms.send", vaultId: r.vaultId,
    target, idempotencyKey: r.clientId || null, status, error: error ?? null,
  });
}

export interface SendOutcome {
  status: 200;
  body: { clientId: string; eventId: string; status: "sent" };
  replayed: boolean;
}

/** Gates 6–9 for one message. Throws SendError (already audited). */
export async function sendToThread(r: SendRequest): Promise<SendOutcome> {
  const kind: SendKind = r.text ? "text" : r.attachment!.kind;
  const target: Record<string, unknown> = { threadId: r.threadId, kind };
  const refuse = (e: SendError, status: "refused" | "failed" = "refused"): never => {
    auditSend(r, target, status, e.code);
    throw e;
  };

  // 6. The thread, as the projection knows it — never a client-named room.
  let source: ThreadSource & { cacheId?: string };
  try {
    source = resolveSendTarget(r.threadId, { attachment: !!r.attachment, reply: !!r.text?.replyTo }, r.topic ?? null);
  } catch (e) {
    if (e instanceof SendError) {
      if (e.code !== "not_found") Object.assign(target, sendTargetFacts(r.threadId));
      return refuse(e);
    }
    throw e;
  }
  // A forum reply answers a message of ONE topic: a different declared topic is refused, never
  // re-resolved (review C-1 / I-2).
  if (source.cacheId && r.text?.replyTo) {
    const of = topicOfMessage(r.threadId, r.text.replyTo);
    if (of && of.cacheId !== source.cacheId) return refuse(new SendError(409, "topic_mismatch", "The message you're replying to is in another topic. Nothing was sent."));
  }
  const network = source.network;
  target.network = network;
  // The owner picked a channel (a merged conversation): send only if it is the one this thread
  // sends through — never quietly through another network or account.
  if (r.channel) {
    const ch = getThread(r.threadId)?.channels[0];
    if (!ch || ch.network !== r.channel.network || (ch.accountLabel ?? null) !== r.channel.accountLabel) {
      return refuse(new SendError(409, "unsupported_network", "Sending through that channel isn't available in this conversation."));
    }
  }
  const mentions = r.text?.mentions ?? [];
  if (mentions.length) {
    target.mentions = mentions.length;
    const caps = getThread(r.threadId)?.channels[0]?.capabilities;
    if (isBlueBubblesNetwork(network) || !MENTION_NETWORKS.has(network) || caps?.encrypted) {
      return refuse(new SendError(422, "invalid", "Mentions aren't supported in this conversation."));
    }
  }
  if (r.attachment) target.sizeBytes = r.attachment.file.bytes.length;
  // iMessage / SMS: the BlueBubbles transport, same ledger / audit / idempotency (bluebubbles/comms-send.ts).
  if (isBlueBubblesNetwork(network)) return sendViaBlueBubbles(r, source.roomId, target, refuse);
  // Email: the Omni approval executor (proton_send.py + a one-time grant) — comms/email-send.ts.
  if (network === "email") {
    const { sendEmailReply } = await import("./email-send");
    return sendEmailReply(r, target, refuse);
  }
  target.roomId = source.roomId;
  // Opus-in-CAF is Messages' voice format: the bridges' recipients (WhatsApp, Telegram …) can't play it.
  if (r.attachment?.file.facts.mimetype === CAF_MIME) {
    return refuse(new SendError(415, "unsupported_type", "Voice messages in CAF can only be sent to iMessage/SMS."));
  }

  if (!r.creds) return refuse(new SendError(503, "source_unavailable", "The message source isn't configured on the server."));
  const creds = r.creds;
  if (r.attachment) {
    const max = await maxAttachmentBytes(creds);
    if (r.attachment.file.bytes.length > max) return refuse(new SendError(413, "too_large", `Attachments can be at most ${Math.floor(max / (1024 * 1024))} MB.`));
  }

  const client = clientFor(creds);
  const credHash = credHashOf(creds);
  // Who the token is (cached). A token without a device gets the short retry window: Synapse
  // then dedupes txn ids in memory only. Unknown (homeserver silent) → the short one too.
  const who = await whoami(client, credHash).catch(() => null);
  const retryWindowMs = who?.deviceId ? RETRY_WINDOW_MS : RETRY_WINDOW_NO_DEVICE_MS;

  // 7. Idempotency.
  const claim = claimSend({ clientId: r.clientId, actorEmail: r.actor.email, threadId: r.threadId, kind, requestHash: r.requestHash, credHash, retryWindowMs });
  if (claim.kind === "replay") {
    auditSend(r, { ...target, eventId: claim.response.eventId }, "replayed");
    return { status: 200, body: claim.response as SendOutcome["body"], replayed: true };
  }
  if (claim.kind === "mismatch") return refuse(new SendError(422, "invalid", "This clientId was already used for a different message."));
  if (claim.kind === "in_progress") return refuse(new SendError(409, "in_progress", "This message is still being sent."));
  if (claim.kind === "expired") {
    return refuse(new SendError(502, "send_failed", "This message may have been sent and can no longer be retried safely. Check the conversation before sending it again.", true), "failed");
  }
  const { retry, attempt } = claim;
  target.attempt = attempt;

  // Anything thrown before the event PUT provably sent nothing: release the clientId (this
  // attempt's claim only — never a row a later Try Again reclaimed).
  const unsent = (e: SendError): never => {
    try {
      releaseSend(r.clientId, attempt, retry);
    } catch (le) {
      console.error(`[comms] send ledger release failed: ${scrubActionError(le)}`);
    }
    return refuse(e, e.status === 502 ? "failed" : "refused");
  };
  const roomId = source.roomId;

  // 8. Live checks.
  try {
    const refusal = await liveRoomRefusal(client, creds, roomId, who);
    if (refusal) return unsent(refusal);
    if (r.text?.replyTo && !(await eventInThread(client, source.cacheId ?? r.threadId, roomId, r.text.replyTo))) {
      return unsent(new SendError(422, "invalid", "The message you're replying to isn't in this conversation."));
    }
    // Everyone mentioned is in the room now, and is a person (not the owner, not a bridge bot).
    if (mentions.length) {
      // The room's own spelling of each id (canonical), matched case-insensitively.
      const members = new Map(Object.keys(await client.memberProfiles(roomId)).map((id) => [id.toLowerCase(), id]));
      const me = who ?? (await whoami(client, credHash));
      const self = new Set(commsSelfIds(me.userId).map((id) => id.toLowerCase()));
      if (mentions.some((m) => !members.has(m.userId.toLowerCase()) || self.has(m.userId.toLowerCase()) || isBridgeLike(m.userId))) {
        return unsent(new SendError(422, "invalid", "Someone you mentioned isn't in this conversation."));
      }
      for (const m of mentions) m.userId = members.get(m.userId.toLowerCase())!;
    }
  } catch (e) {
    if (e instanceof SendError) throw e;
    return unsent(new SendError(502, "send_failed", `The message source didn't answer (${scrubActionError(e)}).`, false));
  }

  // 9a. Upload (an upload reaches nobody: every failure here is "nothing was sent").
  let content: Record<string, unknown>;
  if (r.text) {
    content = textContent(r.text.body, mentions);
    if (r.text.replyTo) {
      content["m.relates_to"] = { "m.in_reply_to": { event_id: r.text.replyTo } };
      target.replyTo = r.text.replyTo;
    }
    target.textHash = contentHmac(r.text.body).slice(0, 16);
  } else {
    const a = r.attachment!;
    let url: string;
    let thumb: { url: string; info: Record<string, unknown> } | null = null;
    try {
      url = await client.uploadMedia(a.file.bytes, a.file.facts.mimetype, a.file.facts.filename);
      if (a.thumbnail) {
        const tu = await client.uploadMedia(a.thumbnail.bytes, a.thumbnail.facts.mimetype, "thumbnail");
        thumb = { url: tu, info: info({ mimetype: a.thumbnail.facts.mimetype, size: a.thumbnail.bytes.length, w: a.thumbnail.facts.w, h: a.thumbnail.facts.h }) };
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 413) return unsent(new SendError(413, "too_large", "The server's media store refused a file this large."));
      return unsent(new SendError(502, "send_failed", `The attachment couldn't be uploaded (${status ?? "network"}).`, false));
    }
    target.mediaHash = shortHash(url);
    content = attachmentContent(a, url, thumb);
  }

  // 9b. The event. txn id = f(clientId): a retry of a maybe-sent message is deduped upstream.
  let eventId: string;
  try {
    eventId = await sendMatrixEvent(client, roomId, "m.room.message", txnIdFor(r.clientId), content);
  } catch (e) {
    if (e instanceof ActionTransportError && e.sent === false) {
      return unsent(new SendError(502, "send_failed", "The message was refused and not sent.", false));
    }
    return maybeSent("The message may not have been delivered. Try again to make sure (it won't be sent twice).");
  }
  if (!eventId) {
    // Accepted (2xx) but no event id came back: it is probably posted. Never report "sent"
    // without the id the client reconciles by.
    return maybeSent("The server didn't confirm the message. Try again to make sure (it won't be sent twice).");
  }
  // From here the message IS posted: bookkeeping that fails is logged, never turned into an
  // error the client could read as "not sent" (a resend under a new clientId = a duplicate).
  try {
    markSent(r.clientId, attempt, eventId);
  } catch (le) {
    console.error(`[comms] send ledger update failed after a successful send: ${scrubActionError(le)}`);
  }
  auditSend(r, { ...target, eventId }, "ok");
  return { status: 200, body: { clientId: r.clientId, eventId, status: "sent" }, replayed: false };

  function maybeSent(message: string): never {
    try {
      markMaybeSent(r.clientId, attempt);
    } catch (le) {
      console.error(`[comms] send ledger update failed: ${scrubActionError(le)}`);
    }
    return refuse(new SendError(502, "send_failed", message, true), "failed");
  }
}

/**
 * Gate 8: the live room checks every outward event (message, reaction, redaction) passes. Null =
 * fine; a SendError = refuse (nothing was sent). Network failures throw (the caller maps them).
 *   - the stored account is JOINED to the room;
 *   - the room is not end-to-end encrypted (no plaintext into E2EE rooms);
 *   - someone other than the owner's ids and bridge bots is in it (never a bridge management room).
 */
export async function liveRoomRefusal(client: CommsSendClient, creds: MatrixCreds, roomId: string, who: Who | null): Promise<SendError | null> {
  if (!(await isJoined(client, creds, roomId))) return new SendError(404, "not_found", "This conversation isn't available any more.");
  const [me, members, encrypted] = await Promise.all([
    who ? Promise.resolve(who) : whoami(client, credHashOf(creds)),
    client.memberProfiles(roomId),
    client.roomEncrypted(roomId),
  ]);
  if (encrypted) return new SendError(409, "encrypted_room", "This conversation is end-to-end encrypted; Comms can't send to it yet.");
  // Who counts as a recipient: anyone but the owner's own ids and bridge bots. The agent's senders
  // (OMNI_AGENT_MATRIX_IDS, e.g. the owner's own Omni Telegram bot) are NOT the owner: a chat with
  // one of them is a real conversation (S2 ruling, 2026-11-22). Only the posting account itself
  // (whoami) and the owner's stored ids stay excluded.
  const self = new Set(commsSelfIds(me.userId).filter((id) => !agentOnly(id, me.userId)));
  const others = Object.keys(members).filter((id) => !self.has(id.toLowerCase()) && !isBridgeLike(id));
  if (!others.length) {
    const bot = Object.keys(members).some((id) => !self.has(id.toLowerCase()) && isBridgeLike(id));
    return new SendError(404, "not_found", bot
      ? "Only you and the bridge bot are in this conversation, so there's no one to send to (the bridge would read it as a command)."
      : "You're the only one in this conversation, so there's no one to send to.");
  }
  return null;
}

/** An id that is self ONLY because it is one of the agent's senders (not the posting account, not a
 *  stored owner id). */
function agentOnly(id: string, me: string): boolean {
  const l = id.toLowerCase();
  if (l === me.toLowerCase()) return false;
  if (storedOwnerSenders().some((o) => o.toLowerCase() === l)) return false;
  // Only a bridge PUPPET (`@<network>_<id>:` — a real chat on the other side, e.g. the owner's Omni
  // Telegram bot) counts as a recipient (review M3): a native Matrix agent account in a bridge
  // management room must never make that room sendable.
  return agentSenderIds().includes(l) && PUPPET.test(l);
}
const PUPPET = /^@[a-z]+_[^:]+:/;

/** Is `eventId` a message of THIS thread's room (window cache first, else the room itself)? */
export async function eventInThread(client: CommsSendClient, threadId: string, roomId: string, eventId: string): Promise<boolean> {
  return inWindow(threadId, eventId) || (await client.eventExists(roomId, eventId));
}

/**
 * Gate 6 on its own (no network, no body): the thread's projected source, refused when the
 * thread is unknown/left (404), its network is not sendable (409 unsupported_network), the room
 * is known to be encrypted (409 encrypted_room), or the channel refuses attachments / replies.
 * The attachment route runs it BEFORE reading the upload.
 */
export function resolveSendTarget(
  threadId: string, want: { attachment?: boolean; reply?: boolean; react?: boolean } = {}, topic: string | null = null,
): ThreadSource & { cacheId?: string } {
  const thread = threadId.length <= 200 ? getThread(threadId) : null;
  // A Telegram forum (comms/forums.ts): a send goes to ONE topic the owner chose — never "All",
  // never a guess here (the client defaults to the newest topic and names it).
  if (thread && isForumThread(threadId)) {
    if (!topic) throw new SendError(422, "topic_required", "Choose the topic to send to.");
    const t = forumTopic(threadId, topic);
    if (!t) throw new SendError(422, "topic_required", "That topic isn't in this forum any more. Choose another one.");
    if (!SEND_NETWORKS.has(t.network)) throw new SendError(409, "unsupported_network", "Sending isn't available for this conversation yet.");
    if (!matrixSendEnabled()) throw new SendError(403, "send_disabled", "Sending is turned off on this server.");
    const caps = t.capabilities;
    if (caps?.encrypted) throw new SendError(409, "encrypted_room", "This conversation is end-to-end encrypted; Comms can't send to it yet.");
    if (want.attachment && caps && caps.attachments === false) throw new SendError(409, "unsupported_network", "This conversation doesn't accept attachments.");
    if (want.react && caps && caps.react === false) throw new SendError(409, "unsupported_network", "Reactions aren't supported in this conversation.");
    if (want.reply && caps && caps.reply === false) throw new SendError(422, "invalid", "Replies aren't supported in this conversation.");
    return { roomId: t.roomId, network: t.network, cacheId: t.cacheId };
  }
  // iMessage / SMS (BlueBubbles): the chat GUID stands in for the room id; its own family switch.
  const em = thread ? emailThreadSource(threadId) : null;
  if (thread && em) {
    if (want.attachment) throw new SendError(409, "unsupported_network", "Attachments can't be sent by email from Comms yet.");
    if (want.react) throw new SendError(409, "unsupported_network", "Reactions aren't supported for email.");
    if (want.reply) throw new SendError(422, "invalid", "Replying to a single email isn't supported; the reply answers the thread.");
    if (!emailSendEnabled()) throw new SendError(403, "send_disabled", "Sending email is turned off on this server.");
    return { roomId: em.sourceRef, network: "email" };
  }
  const bb = thread ? bbThreadSource(threadId) : null;
  const source: ThreadSource | null = bb ? { roomId: bb.chatGuid, network: bb.network } : thread ? threadSource(threadId) : null;
  if (!thread || !source) throw new SendError(404, "not_found", "This conversation isn't available.");
  if (bb) {
    // No BlueBubbles connector on this server → the network is simply not sendable (as before);
    // a configured one that is switched off / not answering → send_disabled.
    if (!blueBubblesActive() || !blueBubblesCreds()) throw new SendError(409, "unsupported_network", "Sending isn't available for this conversation yet.");
    if (!imessageSendEnabled()) throw new SendError(403, "send_disabled", "Sending iMessage/SMS is turned off on this server, or BlueBubbles isn't answering.");
  } else {
    if (!SEND_NETWORKS.has(source.network)) throw new SendError(409, "unsupported_network", "Sending isn't available for this conversation yet.");
    if (!matrixSendEnabled()) throw new SendError(403, "send_disabled", "Sending is turned off on this server.");
  }
  const caps = thread.channels[0]?.capabilities;
  if (caps?.encrypted) throw new SendError(409, "encrypted_room", "This conversation is end-to-end encrypted; Comms can't send to it yet.");
  if (want.attachment && caps && caps.attachments === false) throw new SendError(409, "unsupported_network", "This conversation doesn't accept attachments.");
  if (want.react && caps && caps.react === false) throw new SendError(409, "unsupported_network", "Reactions aren't supported in this conversation.");
  if (want.reply && caps && caps.reply === false) throw new SendError(422, "invalid", "Replies aren't supported in this conversation.");
  return source;
}
const sendTargetFacts = (threadId: string): Record<string, unknown> => {
  const s = threadSource(threadId);
  return s ? { network: s.network, roomId: s.roomId } : {};
};

/** Bridge bots never count as "someone to send to" (comms/bridge-like.ts). */
export { isBridgeLike } from "./bridge-like";
import { isBridgeLike } from "./bridge-like";

const inWindow = (threadId: string, eventId: string): boolean =>
  !!db.prepare(`SELECT 1 FROM comms_messages WHERE thread_id = ? AND source_event_id = ?`).get(threadId, eventId);

const info = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** The m.room.message content for an uploaded attachment (Matrix spec v1.x + MSC3245/MSC1767). */
export function attachmentContent(a: NonNullable<SendRequest["attachment"]>, url: string, thumb: { url: string; info: Record<string, unknown> } | null): Record<string, unknown> {
  const f = a.file.facts;
  const size = a.file.bytes.length;
  const thumbInfo = thumb ? { thumbnail_url: thumb.url, thumbnail_info: thumb.info } : {};
  switch (a.kind) {
    case "image":
      return { msgtype: "m.image", body: f.filename, filename: f.filename, url, info: info({ mimetype: f.mimetype, size, w: f.w ?? a.w, h: f.h ?? a.h, ...thumbInfo }) };
    case "video":
      return { msgtype: "m.video", body: f.filename, filename: f.filename, url, info: info({ mimetype: f.mimetype, size, w: a.w, h: a.h, duration: a.durationMs, ...thumbInfo }) };
    case "file":
      return { msgtype: "m.file", body: f.filename, filename: f.filename, url, info: info({ mimetype: f.mimetype, size }) };
    case "voice":
      // mautrix bridges read the voice flag from org.matrix.msc3245.voice and the waveform from
      // org.matrix.msc1767.audio; Telegram's bridge reads the duration from info.duration and
      // WhatsApp's falls back to the MSC1767 one — so the duration goes in both.
      return {
        msgtype: "m.audio", body: "Voice message", filename: f.filename, url,
        info: info({ mimetype: f.mimetype, size, duration: a.durationMs }),
        "org.matrix.msc1767.audio": info({ duration: a.durationMs, waveform: a.waveform?.length ? a.waveform : undefined }),
        "org.matrix.msc3245.voice": {},
      };
  }
}

/** GET capabilities body (/api/integrations/comms/capabilities and /api/comms/capabilities). */
export async function capabilitiesBody(creds: MatrixCreds | null): Promise<Record<string, unknown>> {
  const enabled = commsSendEnabled();
  return {
    ...COMMS_CAPABILITIES,
    operations: [
      ...COMMS_CAPABILITIES.operations,
      ...(enabled ? ["messages:send"] : []),
      ...(config.commsPinsEnabled ? ["threads:pin"] : []),
      ...(config.commsReceiptsEnabled ? ["receipts:read"] : []),
      // Row actions + folders (sprint Task 9): the client shows a swipe button only when listed.
      ...(config.commsThreadActionsEnabled ? ["threads:mute", "threads:archive", "threads:status"] : []),
      ...(config.commsFoldersEnabled ? ["threads:folders"] : []),
    ],
    send: { enabled, maxAttachmentBytes: await maxAttachmentBytes(enabled ? creds : null) },
    // Omni in Comms (Phase 4): the client shows @Omni, drafts and Needs you only when this is true.
    omni: { enabled: config.commsEnabled && config.commsOmniEnabled && omniConfig.enabled() },
  };
}
