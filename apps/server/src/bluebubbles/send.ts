/**
 * iMessage/SMS send TRANSPORT (BlueBubbles, method apple-script — no Private API, D6).
 *
 * NOT a route. The Comms send route (branch feat/comms-send: device-token human origin,
 * COMMS_SEND_ENABLED, per-owner rate limit, the send ledger + audit) owns every gate; after
 * that branch merges, its dispatcher calls `imessageTransport()` for a thread whose network is
 * `imessage` | `sms` (bbThreadSource(threadId) gives the chat GUID — the client never names
 * one), exactly where it calls the Matrix transport today. See docs/runbook/bluebubbles.md
 * § "Send hook point".
 *
 * Idempotency is OURS. BlueBubbles requires a `tempGuid` for apple-script sends but only
 * de-duplicates it while that send is in flight (httpService.sendCache); once it finished, the
 * same tempGuid sends again. So every send is recorded in `bluebubbles_send` keyed by the
 * client's clientId (+ a digest of what was sent):
 *   sent     → the same clientId returns the stored result; nothing is sent again
 *   pending  → a send with this clientId is in flight → 409-style `in_flight`
 *   unknown  → the last try may have been delivered (timeout / 5xx / no answer). A retry first
 *              LOOKS in the chat for a message from the owner created after that try with the
 *              same text (or attachment name); found → `sent`, never a second copy. Not found →
 *              sent again.
 *   failed   → BlueBubbles definitely refused (4xx / an iMessage error code): a retry sends again.
 * The same clientId with a different text/attachment is refused (`client_id_reused`).
 */
import { createHash } from "node:crypto";
import { db } from "../db";
import { BlueBubblesError, type BbMessage, type BlueBubblesClient } from "./client";
import { redactRef, textOf } from "./map";
import { blueBubblesClient } from "./config";

export type SendResult = {
  clientId: string; eventId: string; status: "sent";
  /** The chat BlueBubbles put the message in, when it said (message/text answers with `chats`; a
   *  delivered copy found by `landed` names the chat it was found in). A new conversation's real
   *  GUID can differ from the one it was sent to (`iMessage;-;h` vs `any;-;h`). */
  chatGuid?: string;
};

export class ImessageSendError extends Error {
  constructor(
    readonly code: "in_flight" | "client_id_reused" | "send_failed" | "invalid",
    /** true = BlueBubbles may have delivered it: the client must not auto-retry (contract-send). */
    readonly maybeSent: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ImessageSendError";
  }
}

/** The interface the comms send route calls (wired after feat/comms-send merges). */
export interface ImessageTransport {
  /** `findIn`: more chat GUIDs a delivered copy of an outcome-unknown try may be in (a NEW
   *  conversation: Messages may file it under another service prefix). */
  sendImessageText(p: { chatGuid: string; clientId: string; text: string; findIn?: string[] }): Promise<SendResult>;
  sendImessageAttachment(p: { chatGuid: string; clientId: string; name: string; mime: string; bytes: Uint8Array; voice?: boolean }): Promise<SendResult>;
}

type SendClient = Pick<BlueBubblesClient, "sendText" | "sendAttachment" | "queryMessages">;

const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_BYTES = 32_000;
/** A retry of an `unknown` send looks this far before the last try STARTED (review I3). */
const LOOKBACK_SLACK_MS = 30_000;
/** A `pending` row older than the transport's own timeout + this margin was orphaned by a
 *  restart mid-send (review I4) and is treated as `unknown`. */
const PENDING_MARGIN_MS = 60_000;
/** The client's send timeouts (client.ts sendText / sendAttachment). */
const SEND_TIMEOUT_MS: Record<string, number> = { text: 120_000, attachment: 300_000, voice: 300_000 };

interface LedgerRow { client_id: string; chat_guid: string; kind: string; digest: string; state: "pending" | "sent" | "unknown" | "failed"; message_guid: string | null; updated_at: number; attempt_at: number }

const stem = (n: string): string => n.replace(/\.[A-Za-z0-9]{1,5}$/, "").toLowerCase();
const tempGuidFor = (clientId: string): string => `prism-${clientId.toLowerCase()}`;
const digestOf = (parts: Array<string | Uint8Array>): string => {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p).update("\u0000");
  return h.digest("hex");
};

function row(clientId: string): LedgerRow | undefined {
  return db.prepare(`SELECT client_id, chat_guid, kind, digest, state, message_guid, updated_at, attempt_at FROM bluebubbles_send WHERE client_id = ?`).get(clientId) as LedgerRow | undefined;
}
function setState(clientId: string, state: LedgerRow["state"], fields: { messageGuid?: string | null; error?: string | null } = {}, now = Date.now()): void {
  db.prepare(`UPDATE bluebubbles_send SET state = ?, message_guid = COALESCE(?, message_guid), error = ?, updated_at = ? WHERE client_id = ?`)
    .run(state, fields.messageGuid ?? null, fields.error ?? null, now, clientId);
}

/** Claim the clientId for this send; returns what to do. Atomic (one transaction).
 *  `since` = when the previous, outcome-unknown try STARTED (look for it from there). */
function claim(p: { clientId: string; chatGuid: string; kind: string; digest: string }, now: number): { do: "send"; since: number | null } | { do: "done"; eventId: string } {
  return db.transaction(() => {
    const cur = row(p.clientId);
    if (!cur) {
      db.prepare(`INSERT INTO bluebubbles_send (client_id, chat_guid, kind, digest, state, created_at, updated_at, attempt_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(p.clientId, p.chatGuid, p.kind, p.digest, now, now, now);
      return { do: "send" as const, since: null };
    }
    if (cur.chat_guid !== p.chatGuid || cur.kind !== p.kind || cur.digest !== p.digest) throw new ImessageSendError("client_id_reused", false, "This clientId was used for a different message.");
    if (cur.state === "sent" && cur.message_guid) return { do: "done" as const, eventId: cur.message_guid };
    const orphaned = cur.state === "pending" && now - cur.attempt_at > (SEND_TIMEOUT_MS[cur.kind] ?? 300_000) + PENDING_MARGIN_MS;
    if (cur.state === "pending" && !orphaned) throw new ImessageSendError("in_flight", true, "This message is already being sent.");
    const since = cur.state === "unknown" || orphaned ? cur.attempt_at || cur.updated_at : null;
    db.prepare(`UPDATE bluebubbles_send SET state = 'pending', updated_at = ?, attempt_at = ? WHERE client_id = ?`).run(now, now, p.clientId);
    return { do: "send" as const, since };
  })();
}

/** Message GUIDs another ledger row already owns (never adopted twice — review M10). */
const adopted = (guid: string, clientId: string): boolean =>
  !!db.prepare(`SELECT 1 FROM bluebubbles_send WHERE message_guid = ? AND client_id != ?`).get(guid, clientId);

/** A definite refusal (never delivered) vs an outcome we cannot know. */
function classify(e: unknown): { maybeSent: boolean; why: string } {
  if (e instanceof BlueBubblesError) {
    if (e.status === null) return { maybeSent: true, why: e.detail === "timeout" ? "timeout" : "unreachable" };
    if (e.status >= 500) {
      // BlueBubbles answers 500 with the serialized message when iMessage reported an error code:
      // that is a definite failure. A bare 500 is unknown.
      const data = (e as BlueBubblesError & { data?: { error?: number } }).data;
      return typeof data?.error === "number" && data.error !== 0 ? { maybeSent: false, why: `imessage_error_${data.error}` } : { maybeSent: true, why: `http_${e.status}` };
    }
    return { maybeSent: false, why: `http_${e.status}` };
  }
  return { maybeSent: true, why: "error" };
}

export function makeImessageTransport(client: SendClient, opts: { now?: () => number } = {}): ImessageTransport {
  const now = () => (opts.now ? opts.now() : Date.now());

  /** After an `unknown` try that started at `since`: did a message from the owner with this
   *  content land in the chat? Messages older than the try, or already owned by another send, are
   *  never adopted. */
  async function landed(clientId: string, chatGuids: string[], since: number, matches: (m: BbMessage) => boolean): Promise<{ guid: string; chatGuid: string } | null> {
    for (const chatGuid of chatGuids) {
      try {
        const { messages } = await client.queryMessages({ chatGuid, after: Math.max(0, since - LOOKBACK_SLACK_MS), sort: "ASC", limit: 100, with: ["attachment"] });
        const hit = messages.find((m) => m.isFromMe && matches(m) && !adopted(m.guid, clientId));
        if (hit) return { guid: hit.guid, chatGuid };
      } catch {
        throw new ImessageSendError("send_failed", true, "Could not check whether the earlier try was delivered.");
      }
    }
    return null;
  }

  async function run(p: { clientId: string; chatGuid: string; kind: "text" | "attachment" | "voice"; digest: string; findIn?: string[] }, send: () => Promise<BbMessage>, matches: (m: BbMessage) => boolean): Promise<SendResult> {
    if (!CLIENT_ID_RE.test(p.clientId)) throw new ImessageSendError("invalid", false, "clientId must be a UUID.");
    if (!p.chatGuid) throw new ImessageSendError("invalid", false, "No chat.");
    const c = claim(p, now());
    if (c.do === "done") return { clientId: p.clientId, eventId: c.eventId, status: "sent" };
    if (c.since !== null) {
      const found = await landed(p.clientId, [...new Set([p.chatGuid, ...(p.findIn ?? [])])], c.since, matches).catch((e) => {
        setState(p.clientId, "unknown");
        throw e;
      });
      if (found) {
        setState(p.clientId, "sent", { messageGuid: found.guid });
        return { clientId: p.clientId, eventId: found.guid, status: "sent", chatGuid: found.chatGuid };
      }
    }
    try {
      const sent = await send();
      const guid = typeof sent?.guid === "string" && sent.guid ? sent.guid : null;
      if (!guid) {
        setState(p.clientId, "unknown", { error: "no_guid" });
        throw new ImessageSendError("send_failed", true, "BlueBubbles did not confirm the message.");
      }
      setState(p.clientId, "sent", { messageGuid: guid });
      const chat = Array.isArray(sent.chats) ? sent.chats.find((x) => typeof x?.guid === "string" && x.guid)?.guid : undefined;
      return { clientId: p.clientId, eventId: guid, status: "sent", ...(chat ? { chatGuid: chat } : {}) };
    } catch (e) {
      if (e instanceof ImessageSendError) throw e;
      const k = classify(e);
      setState(p.clientId, k.maybeSent ? "unknown" : "failed", { error: k.why });
      console.warn(`[bluebubbles] send to ${redactRef(p.chatGuid)} ${k.maybeSent ? "may have failed" : "failed"} (${k.why})`);
      throw new ImessageSendError("send_failed", k.maybeSent, k.maybeSent ? "The message may not have been delivered." : "The message was not sent.");
    }
  }

  return {
    async sendImessageText({ chatGuid, clientId, text, findIn }) {
      const body = text.replace(/\r\n?/g, "\n");
      if (!body.trim() || Buffer.byteLength(body, "utf8") > MAX_TEXT_BYTES) throw new ImessageSendError("invalid", false, "Text must be 1–32000 bytes.");
      return run(
        { clientId, chatGuid, kind: "text", digest: digestOf(["text", body]), ...(findIn ? { findIn } : {}) },
        () => client.sendText({ chatGuid, tempGuid: tempGuidFor(clientId), message: body }),
        (m) => textOf(m) === body.trim(),
      );
    },
    async sendImessageAttachment({ chatGuid, clientId, name, mime, bytes, voice }) {
      const safeName = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "attachment";
      if (!bytes.byteLength) throw new ImessageSendError("invalid", false, "Empty attachment.");
      return run(
        { clientId, chatGuid, kind: voice ? "voice" : "attachment", digest: digestOf(["attachment", safeName, mime, bytes]) },
        () => client.sendAttachment({ chatGuid, tempGuid: tempGuidFor(clientId), name: safeName, mime, bytes, isAudioMessage: !!voice }),
        // Messages may rename on conversion (HEIC, voice → .caf): same name, else the same stem.
        (m) => (m.attachments ?? []).some((a) => !!a.transferName && (a.transferName === safeName || stem(a.transferName) === stem(safeName))),
      );
    },
  };
}

/** The production transport over the stored credential, or null when the connector is off. */
export function imessageTransport(): ImessageTransport | null {
  const c = blueBubblesClient();
  return c ? makeImessageTransport(c) : null;
}
