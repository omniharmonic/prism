/**
 * The Comms send pipeline's iMessage/SMS leg (comms/send.ts `sendToThread`, gates 7–9 for a
 * BlueBubbles thread). Gates 1–6 ran already: owner, COMMS_SEND_ENABLED + BLUEBUBBLES_ENABLED +
 * BlueBubbles answering (send-policy.ts), device-token human origin, the rate limit, input
 * validation, and the thread resolved from the projection (the client never names a chat).
 *
 * Same semantics as a Matrix send:
 *   7. the Comms ledger (comms_sends, send-ledger.ts) by clientId: replay of a sent message,
 *      409 in_progress, 422 for a reused clientId, `expired` after the retry window. The
 *      transport keeps its own per-clientId record (bluebubbles_send) because BlueBubbles'
 *      tempGuid dedupe lasts only while a send is in flight: an outcome-unknown try is LOOKED
 *      FOR in the chat before anything is sent again (bluebubbles/send.ts).
 *   8. live check: the chat exists on BlueBubbles (else 404 not_found, nothing sent).
 *   9. send: text → message/text, attachments → message/attachment (method apple-script — no
 *      Private API, D6). eventId = the iMessage GUID, which the projection's echo carries as
 *      `source.eventId` (and comms_sends maps back to the clientId).
 * Audit (action_audit `comms.send`): thread id, network, a redacted chat ref, sizes, hashes —
 * never the text, a file name, a phone number or a credential.
 *
 * Voice: BlueBubbles' `isAudioMessage` under apple-script converts an .mp3 (or a non-Opus
 * .caf) into an Opus CAF voice memo before AppleScript `send file` (api/apple/actions.ts,
 * fileSystem prepareVoiceMemo) and passes an Opus CAF through as it is; AppleScript has no
 * "voice message" flag. So Opus-in-CAF (what Comms records for iMessage — Messages' own audio
 * message format) and MP3 are sent with isAudioMessage; AAC/M4A is sent as an ordinary audio
 * file; Ogg/Opus is refused (iPhones do not play it in Messages).
 */
import { createHash } from "node:crypto";
import { config } from "../config";
import { scrubActionError } from "../actions/store";
import { SendError, auditSend, type SendOutcome, type SendRequest } from "../comms/send";
import { RETRY_WINDOW_MS, claimSend, contentHmac, markMaybeSent, markSent, releaseSend, type SendKind } from "../comms/send-ledger";
import { blueBubblesCreds } from "./config";
import { blueBubblesReader } from "./service";
import { ImessageSendError, imessageTransport, type ImessageTransport } from "./send";
import { redactRef } from "./map";
import { CAF_MIME } from "../comms/send-media";
import { noteBlueBubblesReachable } from "./ready";

type Reader = { getChat(guid: string): Promise<unknown | null> };
let override: { transport: ImessageTransport; reader: Reader } | null = null;
/** Tests: the transport and the chat reader (null restores the stored-credential ones). */
export function setBlueBubblesSendForTests(v: typeof override): void {
  override = v;
}

const credHash = (): string => createHash("sha256").update(`bluebubbles\n${blueBubblesCreds()?.password ?? ""}`).digest("hex").slice(0, 32);

/** A NEW conversation (POST /api/comms/conversations): no chat exists yet, so the live chat check
 *  is skipped, and an outcome-unknown retry looks for its delivered copy in every GUID Messages
 *  may file the chat under (`findIn`). */
export interface NewChatOpts { findIn: string[] }

export async function sendViaBlueBubbles(
  r: SendRequest, chatGuid: string, target: Record<string, unknown>,
  refuse: (e: SendError, status?: "refused" | "failed") => never,
  newChat?: NewChatOpts,
): Promise<SendOutcome & { chatGuid?: string }> {
  const kind: SendKind = r.text ? "text" : r.attachment!.kind;
  target.chat = redactRef(chatGuid);
  const transport = override?.transport ?? imessageTransport();
  const reader = override?.reader ?? blueBubblesReader();
  if (!transport || !reader) return refuse(new SendError(503, "source_unavailable", "iMessage isn't configured on the server."));
  if (r.text?.replyTo) return refuse(new SendError(422, "invalid", "Replies aren't supported for iMessage."));
  const a = r.attachment;
  if (a) {
    if (a.file.bytes.length > config.commsSendMaxBytes) return refuse(new SendError(413, "too_large", `Attachments can be at most ${Math.floor(config.commsSendMaxBytes / (1024 * 1024))} MB.`));
    if (a.kind === "voice" && a.file.facts.mimetype === "audio/ogg") return refuse(new SendError(415, "unsupported_type", "iMessage voice messages must be Opus in CAF, M4A/AAC or MP3."));
  }

  // 7. Idempotency (the Comms ledger; the transport adds its delivered-copy check).
  const claim = claimSend({ clientId: r.clientId, actorEmail: r.actor.email, threadId: r.threadId, kind, requestHash: r.requestHash, credHash: credHash(), retryWindowMs: RETRY_WINDOW_MS });
  if (claim.kind === "replay") {
    auditSend(r, { ...target, eventId: claim.response.eventId }, "replayed");
    return { status: 200, body: claim.response as SendOutcome["body"], replayed: true };
  }
  if (claim.kind === "mismatch") return refuse(new SendError(422, "invalid", "This clientId was already used for a different message."));
  if (claim.kind === "in_progress") return refuse(new SendError(409, "in_progress", "This message is still being sent."));
  if (claim.kind === "expired") return refuse(new SendError(502, "send_failed", "This message may have been sent and can no longer be retried safely. Check the conversation before sending it again.", true), "failed");
  const { retry, attempt } = claim;
  target.attempt = attempt;
  const unsent = (e: SendError): never => {
    try {
      releaseSend(r.clientId, attempt, retry);
    } catch (le) {
      console.error(`[comms] send ledger release failed: ${scrubActionError(le)}`);
    }
    return refuse(e, e.status === 502 ? "failed" : "refused");
  };
  const maybeSent = (message: string): never => {
    try {
      markMaybeSent(r.clientId, attempt);
    } catch (le) {
      console.error(`[comms] send ledger update failed: ${scrubActionError(le)}`);
    }
    return refuse(new SendError(502, "send_failed", message, true), "failed");
  };

  // 8. The chat exists on BlueBubbles (nothing is sent to a GUID it does not know) — except for a
  //    new conversation, whose chat Messages creates with this first message.
  if (!newChat) {
    let chat: unknown;
    try {
      chat = await reader.getChat(chatGuid);
    } catch {
      return unsent(new SendError(502, "send_failed", "BlueBubbles didn't answer; nothing was sent.", false));
    }
    if (!chat) return unsent(new SendError(404, "not_found", "This conversation isn't available any more."));
  }

  // 9. Send.
  let eventId: string;
  let sentChat: string | undefined;
  try {
    if (r.text) {
      target.textHash = contentHmac(r.text.body).slice(0, 16);
      const res = await transport.sendImessageText({ chatGuid, clientId: r.clientId, text: r.text.body, ...(newChat ? { findIn: newChat.findIn } : {}) });
      eventId = res.eventId;
      sentChat = res.chatGuid;
    } else {
      const f = a!.file;
      const isVoiceMemo = a!.kind === "voice" && (f.facts.mimetype === "audio/mpeg" || f.facts.mimetype === CAF_MIME);
      target.voiceAs = a!.kind === "voice" ? (isVoiceMemo ? "voice-memo" : "audio-file") : undefined;
      eventId = (await transport.sendImessageAttachment({
        chatGuid, clientId: r.clientId, name: f.facts.filename, mime: f.facts.mimetype, bytes: new Uint8Array(f.bytes), voice: isVoiceMemo,
      })).eventId;
    }
  } catch (e) {
    if (e instanceof ImessageSendError) {
      if (e.code === "in_flight") return maybeSent("This message is still being sent. Try again in a moment (it won't be sent twice).");
      if (e.code === "invalid" || e.code === "client_id_reused") return unsent(new SendError(422, "invalid", e.message));
      return e.maybeSent
        ? maybeSent("The message may not have been delivered. Try again to make sure (it won't be sent twice).")
        : unsent(new SendError(502, "send_failed", "The message was refused and not sent.", false));
    }
    return maybeSent("Something went wrong while sending; the message may have been sent. Try again to make sure (it won't be sent twice).");
  }
  noteBlueBubblesReachable();
  try {
    markSent(r.clientId, attempt, eventId);
  } catch (le) {
    console.error(`[comms] send ledger update failed after a successful send: ${scrubActionError(le)}`);
  }
  auditSend(r, { ...target, eventId }, "ok");
  return { status: 200, body: { clientId: r.clientId, eventId, status: "sent" }, replayed: false, ...(sentChat ? { chatGuid: sentChat } : {}) };
}
