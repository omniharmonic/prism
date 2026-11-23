// SQLite state of the BlueBubbles connector (tables in db.ts). No secrets, no message bodies
// (the chat cache holds names/addresses/style only — the same facts the comms projection shows).
import { db } from "../db";
import type { BbChat, BbMessage } from "./client";
import type { Network } from "../comms/types";
import { chatNetwork, guidNetwork, messageService, OTP_RULE_VERSION } from "./map";

const SEEN_RETENTION_MS = 400 * 86_400_000;

/** "written" | "excluded" (final) | "excluded:otp:v<N>" (a heuristic verdict, re-evaluated when
 *  the OTP rule version changes — review I2). */
export type SeenOutcome = string;
const currentOtp = (): string => `excluded:otp:v${OTP_RULE_VERSION}`;
const stillSeen = (outcome: string): boolean => !outcome.startsWith("excluded:otp:") || outcome === currentOtp();

/** Message GUIDs whose vault outcome is already final (out of `guids`). */
export function seenGuids(guids: string[]): Set<string> {
  const out = new Set<string>();
  const stmt = db.prepare(`SELECT outcome FROM bluebubbles_seen WHERE guid = ?`);
  for (const g of guids) {
    const r = stmt.get(g) as { outcome: string } | undefined;
    if (r && stillSeen(r.outcome)) out.add(g);
  }
  return out;
}

export function markSeen(guids: string[], outcome: SeenOutcome, now = Date.now()): void {
  if (!guids.length) return;
  // A stale OTP verdict is replaced; any other recorded outcome stands.
  const stmt = db.prepare(`INSERT INTO bluebubbles_seen (guid, at, outcome) VALUES (?, ?, ?)
    ON CONFLICT(guid) DO UPDATE SET at = excluded.at, outcome = excluded.outcome
    WHERE bluebubbles_seen.outcome LIKE 'excluded:otp:%' AND bluebubbles_seen.outcome != ?`);
  db.transaction(() => {
    for (const g of guids) stmt.run(g, now, outcome, currentOtp());
  })();
}

/** GUIDs excluded as one-time codes under an OLDER rule version: to be re-evaluated. */
export function staleOtpGuids(limit: number): string[] {
  return (db.prepare(`SELECT guid FROM bluebubbles_seen WHERE outcome LIKE 'excluded:otp:%' AND outcome != ? ORDER BY at DESC LIMIT ?`)
    .all(currentOtp(), Math.max(1, Math.floor(limit))) as { guid: string }[]).map((r) => r.guid);
}

export function pruneSeen(now = Date.now()): number {
  return db.prepare(`DELETE FROM bluebubbles_seen WHERE at < ?`).run(now - SEEN_RETENTION_MS).changes;
}

// ── tapbacks ────────────────────────────────────────────────────────────────

/** Apply one tapback (Apple keeps ONE per sender per message: a new one replaces the old).
 *  Returns whether the stored state changed. Older events never overwrite newer ones. */
export function applyTapback(t: { target: string; sender: string; key: string; remove: boolean; messageGuid: string; at: number }): boolean {
  const cur = db.prepare(`SELECT key, at, message_guid FROM bluebubbles_tapbacks WHERE target_guid = ? AND sender = ?`).get(t.target, t.sender) as
    { key: string; at: number; message_guid: string } | undefined;
  // Events arrive in any order (webhook, newest-first pages, backfill): the newest one wins.
  if (cur && (cur.at > t.at || (cur.at === t.at && cur.message_guid === t.messageGuid))) return false;
  // A removal is kept as a tombstone (key "") so an OLDER add seen later cannot resurrect it.
  // "*" (an emoji removal we could not name) removes whatever the sender had.
  const key = t.remove ? (t.key === "*" || !cur || cur.key === t.key || cur.key === "" ? "" : cur.key) : t.key;
  if (t.remove && cur && key === cur.key && cur.key !== "") return false; // removing a different tapback than the current one
  db.prepare(`INSERT INTO bluebubbles_tapbacks (target_guid, sender, key, message_guid, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(target_guid, sender) DO UPDATE SET key = excluded.key, message_guid = excluded.message_guid, at = excluded.at`)
    .run(t.target, t.sender, key, t.messageGuid, t.at);
  return (cur?.key ?? "") !== key;
}

export function tapbackRows(target: string): Array<{ sender: string; key: string; message_guid: string }> {
  return db.prepare(`SELECT sender, key, message_guid FROM bluebubbles_tapbacks WHERE target_guid = ? AND key != '' ORDER BY at ASC, sender ASC`).all(target) as
    Array<{ sender: string; key: string; message_guid: string }>;
}

// ── chat cache ──────────────────────────────────────────────────────────────

/** The fields of a chat the projection needs (never a message). */
function slimChat(c: BbChat): BbChat {
  return {
    guid: c.guid,
    ...(typeof c.style === "number" ? { style: c.style } : {}),
    ...(c.chatIdentifier ? { chatIdentifier: c.chatIdentifier } : {}),
    ...(c.displayName ? { displayName: c.displayName } : {}),
    ...(c.isArchived ? { isArchived: true } : {}),
    participants: (c.participants ?? []).filter((h) => h && typeof h.address === "string").map((h) => ({ address: h.address, ...(h.service ? { service: h.service } : {}) })),
  };
}

export function putChat(c: BbChat, now = Date.now()): void {
  if (!c?.guid) return;
  db.prepare(`INSERT INTO bluebubbles_chats (guid, json, at) VALUES (?, ?, ?) ON CONFLICT(guid) DO UPDATE SET json = excluded.json, at = excluded.at`)
    .run(c.guid, JSON.stringify(slimChat(c)), now);
}

export function getChatCached(guid: string): { chat: BbChat; at: number } | null {
  const r = db.prepare(`SELECT json, at FROM bluebubbles_chats WHERE guid = ?`).get(guid) as { json: string; at: number } | undefined;
  if (!r) return null;
  try {
    return { chat: JSON.parse(r.json) as BbChat, at: r.at };
  } catch {
    return null;
  }
}

// ── chat service (iMessage vs SMS) ──────────────────────────────────────────

/**
 * Record the service of messages (newest wins, per chat): Messages colours a conversation by the
 * service of its latest message, and a chat filed under macOS 26's unified `any;…` GUID names
 * none. `chatGuid` = the chat when the caller knows it, else each message's own `chats`.
 * Returns the chats whose recorded service changed.
 */
export function noteMessageServices(messages: BbMessage[], chatGuid?: string): Set<string> {
  const changed = new Set<string>();
  const cur = db.prepare(`SELECT service, at FROM bluebubbles_chat_service WHERE chat_guid = ?`);
  const put = db.prepare(`INSERT INTO bluebubbles_chat_service (chat_guid, service, at) VALUES (?, ?, ?)
    ON CONFLICT(chat_guid) DO UPDATE SET service = excluded.service, at = excluded.at WHERE excluded.at >= bluebubbles_chat_service.at`);
  db.transaction(() => {
    for (const m of messages) {
      const service = m ? messageService(m) : null;
      const at = typeof m?.dateCreated === "number" && m.dateCreated > 0 ? m.dateCreated : 0;
      if (!service || !at) continue;
      const guids = chatGuid ? [chatGuid] : (m.chats ?? []).map((c) => c?.guid).filter((g): g is string => typeof g === "string" && !!g);
      for (const g of guids) {
        if (guidNetwork(g)) continue; // the GUID says it already
        const before = cur.get(g) as { service: string; at: number } | undefined;
        if (before && before.at > at) continue;
        put.run(g, service, at);
        if (before?.service !== service) changed.add(g);
      }
    }
  })();
  return changed;
}

/** The recorded service of a chat: a network, "none" (probed, no message carried one), or null (never seen). */
export function chatServiceOf(chatGuid: string): Network | "none" | null {
  const r = db.prepare(`SELECT service FROM bluebubbles_chat_service WHERE chat_guid = ?`).get(chatGuid) as { service: string } | undefined;
  if (!r) return null;
  return r.service === "imessage" || r.service === "sms" ? r.service : "none";
}

/** Remember that a chat's recent history named no service (so the probe is not repeated). */
export function markChatServiceProbed(chatGuid: string): void {
  db.prepare(`INSERT INTO bluebubbles_chat_service (chat_guid, service, at) VALUES (?, '', 0) ON CONFLICT(chat_guid) DO NOTHING`).run(chatGuid);
}

/**
 * iMessage vs SMS for a chat, as Messages decides it: the GUID's prefix when it names one
 * (`iMessage;` / `SMS;`); else the service of the newest message seen; else — no message known —
 * the first participant handle's service.
 */
export function chatNetworkOf(chat: Pick<BbChat, "guid" | "participants">): Network {
  const explicit = guidNetwork(chat.guid);
  if (explicit) return explicit;
  const seen = chatServiceOf(chat.guid);
  if (seen === "imessage" || seen === "sms") return seen;
  return chatNetwork(chat, chat.participants?.[0]?.service ?? null);
}
