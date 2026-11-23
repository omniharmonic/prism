// Comms reactions (owner-approved 2026-11-22): add / remove the owner's tapback on a message.
//
//   POST   /api/comms/threads/:id/messages/:messageId/reactions        {clientId, key}
//   DELETE /api/comms/threads/:id/messages/:messageId/reactions/:key
//
// Same gates as sending (comms/send.ts header): owner, COMMS_SEND_ENABLED + the Matrix family
// flag, a DEVICE token with human origin, a rate limit (the live-actions `matrix-react` budget,
// shared with /api/actions/matrix/react), the projected thread on a sendable network with
// capabilities.react, joined / not encrypted / not a management room. On top:
//   - the message id is the target's Matrix event id, and it must be an event of THIS thread's
//     room (window cache, else GET /rooms/{room}/event/{id}: an event of another room is a 404);
//   - add: idempotent by clientId (send ledger, kind "reaction", txn id = f(clientId)); refused
//     409 already_reacted when one of the owner's ids already has that key on the message;
//   - remove: redacts ONLY reaction events the stored account sent (never someone else's, never
//     a reaction the owner made from his phone through a bridge ghost) → 404 when there is none.
// Audit: `comms.react` / `comms.unreact` rows, real origin, ids only.
import { forumTopic, isForumThread, topicOfMessage } from "./forums";
import { createHash } from "node:crypto";
import { ActionTransportError } from "../actions/email";
import { sendMatrixEvent, validateEventId, validateReactionKey } from "../actions/matrix";
import { ActionInputError } from "../actions/email";
import { scrubActionError } from "../actions/store";
import type { MatrixCreds } from "../worker/matrix";
import { commsSelfIds } from "./owner";
import {
  SendError, auditSend, clientFor, credHashOf, eventInThread, liveRoomRefusal, resolveSendTarget, txnIdFor, whoami,
  type SendOutcome,
} from "./send";
import { RETRY_WINDOW_MS, RETRY_WINDOW_NO_DEVICE_MS, claimSend, markMaybeSent, markSent, releaseSend } from "./send-ledger";
import { wellFormed } from "./wire";

export interface ReactRequest {
  actor: { email: string };
  via: string;
  vaultId: string;
  threadId: string;
  messageId: string;
  creds: MatrixCreds | null;
  /** A Telegram forum: the message's topic (the client's; else the cached window that holds it). */
  topic?: string | null;
}

export function validateMessageId(v: unknown): string {
  try {
    return validateEventId(v);
  } catch (e) {
    if (e instanceof ActionInputError) throw new SendError(422, "invalid", "messageId is not a message id.");
    throw e;
  }
}
export function validateKey(v: unknown): string {
  try {
    const k = validateReactionKey(v);
    if (wellFormed(k) !== k) throw new ActionInputError("key");
    return k;
  } catch (e) {
    if (e instanceof ActionInputError) throw new SendError(422, "invalid", "key must be a short reaction (an emoji).");
    throw e;
  }
}

/** Gates 6 + 8 and the target check, shared by add and remove. Throws SendError (audited). */
async function target(r: ReactRequest, action: string, audit: Record<string, unknown>) {
  const refuse = (e: SendError): never => {
    auditSend({ ...r, clientId: (audit.clientId as string) ?? "", action }, audit, e.status === 502 ? "failed" : "refused", e.code);
    throw e;
  };
  let source;
  try {
    let topic: string | null = null;
    if (isForumThread(r.threadId)) {
      // The message's own topic (its cached window) and the client's must agree: never re-resolved.
      const cached = topicOfMessage(r.threadId, r.messageId)?.id ?? null;
      const declared = r.topic ? (forumTopic(r.threadId, r.topic)?.id ?? r.topic) : null;
      if (cached && declared && cached !== declared) throw new SendError(409, "topic_mismatch", "That message is in another topic. Nothing was sent.");
      topic = cached ?? declared;
    }
    source = resolveSendTarget(r.threadId, { react: true }, topic);
  } catch (e) {
    if (e instanceof SendError) return refuse(e);
    throw e;
  }
  audit.network = source.network;
  audit.roomId = source.roomId;
  if (!r.creds) return refuse(new SendError(503, "source_unavailable", "The message source isn't configured on the server."));
  const client = clientFor(r.creds);
  const who = await whoami(client, credHashOf(r.creds)).catch(() => null);
  try {
    const refusal = await liveRoomRefusal(client, r.creds, source.roomId, who);
    if (refusal) return refuse(refusal);
    if (!(await eventInThread(client, source.cacheId ?? r.threadId, source.roomId, r.messageId))) {
      return refuse(new SendError(404, "not_found", "That message isn't in this conversation."));
    }
    const me = who ?? (await whoami(client, credHashOf(r.creds)));
    return { client, roomId: source.roomId, me, refuse, creds: r.creds };
  } catch (e) {
    if (e instanceof SendError) throw e;
    return refuse(new SendError(502, "send_failed", `The message source didn't answer (${scrubActionError(e)}).`, false));
  }
}

export async function addReaction(r: ReactRequest & { clientId: string; key: string; requestHash: string }): Promise<SendOutcome> {
  const audit: Record<string, unknown> = { threadId: r.threadId, messageId: r.messageId, clientId: r.clientId };
  const { client, roomId, me, refuse, creds } = await target(r, "comms.react", audit);
  const a = { ...r, action: "comms.react" };

  const claim = claimSend({
    clientId: r.clientId, actorEmail: r.actor.email, threadId: r.threadId, kind: "reaction", requestHash: r.requestHash,
    credHash: credHashOf(creds), retryWindowMs: me.deviceId ? RETRY_WINDOW_MS : RETRY_WINDOW_NO_DEVICE_MS,
  });
  if (claim.kind === "replay") {
    auditSend(a, { ...audit, eventId: claim.response.eventId }, "replayed");
    return { status: 200, body: claim.response as SendOutcome["body"], replayed: true };
  }
  if (claim.kind === "mismatch") return refuse(new SendError(422, "invalid", "This clientId was already used for something else."));
  if (claim.kind === "in_progress") return refuse(new SendError(409, "in_progress", "This reaction is still being sent."));
  if (claim.kind === "expired") return refuse(new SendError(502, "send_failed", "This reaction may have been sent and can no longer be retried safely.", true));
  const { attempt, retry } = claim;
  const unsent = (e: SendError): never => {
    try { releaseSend(r.clientId, attempt, retry); } catch (le) { console.error(`[comms] react ledger release failed: ${scrubActionError(le)}`); }
    return refuse(e);
  };

  // A first attempt: refuse a duplicate tapback (the owner — any of his ids — already has it).
  // A Try Again of a maybe-sent one skips this: its own earlier PUT may be what is there, and the
  // same txn id makes the homeserver answer with that event instead of posting a second.
  if (!retry) {
    try {
      const self = new Set(commsSelfIds(me.userId));
      const existing = await client.reactionsTo(roomId, r.messageId);
      if (existing.some((x) => x.key === r.key && self.has(x.sender.toLowerCase()))) {
        return unsent(new SendError(409, "already_reacted", "You already reacted with this."));
      }
    } catch (e) {
      if (e instanceof SendError) throw e;
      return unsent(new SendError(502, "send_failed", `The message source didn't answer (${scrubActionError(e)}).`, false));
    }
  }

  let eventId: string;
  try {
    eventId = await sendMatrixEvent(client, roomId, "m.reaction", txnIdFor(r.clientId), {
      "m.relates_to": { rel_type: "m.annotation", event_id: r.messageId, key: r.key },
    });
  } catch (e) {
    if (e instanceof ActionTransportError && e.sent === false) return unsent(new SendError(502, "send_failed", "The reaction was refused and not sent.", false));
    return maybe();
  }
  if (!eventId) return maybe();
  try {
    markSent(r.clientId, attempt, eventId);
  } catch (le) {
    console.error(`[comms] react ledger update failed after a successful send: ${scrubActionError(le)}`);
  }
  auditSend(a, { ...audit, eventId }, "ok");
  return { status: 200, body: { clientId: r.clientId, eventId, status: "sent" }, replayed: false };

  function maybe(): never {
    try { markMaybeSent(r.clientId, attempt); } catch (le) { console.error(`[comms] react ledger update failed: ${scrubActionError(le)}`); }
    return refuse(new SendError(502, "send_failed", "The reaction may not have been delivered. Try again to make sure (it won't be sent twice).", true));
  }
}

const redactTxn = (reactionEventId: string): string =>
  `comms-redact-${createHash("sha256").update(`comms-redact\n${reactionEventId}`).digest("hex").slice(0, 32)}`;

export async function removeReaction(r: ReactRequest & { key: string }): Promise<{ status: "removed"; removed: number }> {
  const audit: Record<string, unknown> = { threadId: r.threadId, messageId: r.messageId };
  const { client, roomId, me, refuse } = await target(r, "comms.unreact", audit);
  const a = { ...r, clientId: "", action: "comms.unreact" };
  let mine: string[];
  try {
    // ONLY the stored account's own reaction events: someone else's, or the owner's phone
    // reaction relayed by a bridge ghost, is never redacted by Comms.
    mine = (await client.reactionsTo(roomId, r.messageId))
      .filter((x) => x.key === r.key && x.sender.toLowerCase() === me.userId.toLowerCase())
      .map((x) => x.eventId);
  } catch (e) {
    return refuse(new SendError(502, "send_failed", `The message source didn't answer (${scrubActionError(e)}).`, false));
  }
  if (!mine.length) return refuse(new SendError(404, "not_found", "You haven't reacted with this."));
  let done = 0;
  for (const id of mine) {
    try {
      // txn id per reaction event: a repeated DELETE re-PUTs the same redaction (deduped).
      await client.redactEvent(roomId, id, redactTxn(id));
      done++;
    } catch (e) {
      const status = (e as { status?: number }).status;
      const maybeSent = done > 0 || !(typeof status === "number" && status >= 400 && status < 500);
      return refuse(new SendError(502, "send_failed", "The reaction couldn't be removed. Try again.", maybeSent));
    }
  }
  auditSend(a, { ...audit, redacted: done }, "ok");
  return { status: "removed", removed: done };
}
