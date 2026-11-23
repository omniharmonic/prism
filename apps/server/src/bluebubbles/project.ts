/**
 * BlueBubbles → Comms projection (comms_conversations / comms_threads / comms_events), the read
 * path of an iMessage/SMS thread, and the live events a webhook produces. Mirrors
 * comms/project.ts + comms/live.ts for Matrix, with the source being the local BlueBubbles
 * Server instead of a homeserver:
 *
 *  - one conversation per chat GUID, id = conversationIdForKey("bluebubbles:<guid>");
 *    network imessage | sms like Messages: the GUID prefix when explicit (`iMessage;`/`SMS;`), else
 *    (macOS 26's unified `any;…` GUIDs) the service of the newest message seen
 *    (bluebubbles_chat_service; one probe of recent messages for a chat never seen), else the first
 *    participant's handle; dm/group by chat style; capabilities per D6 (send text +
 *    attachments; no react/edit/unsend/reply/typing/receipts).
 *  - title (map.ts bbChatTitle): a DM's person note (strong key) → Contacts → the formatted handle;
 *    a group's own name, else Messages' member title "Ann, Bob & 3 others" (titleSource
 *    "members"; the owner excluded). Every refresh re-titles the row. Avatars: Contacts photos as
 *    `bb://contact/…` media refs (minted into tokens by the routes), else a monogram/cluster.
 *  - folder: a short-code sender → "low"; a DM nobody knows (no person note, not in Contacts)
 *    whose recent history holds no message from the owner → "unknown"; else "inbox".
 *  - tapbacks: kept in bluebubbles_tapbacks (one per sender per message, as Apple does) and
 *    folded into the target's `reactions`; a tapback emits reaction.changed for its target.
 *  - edits/unsends (updated-message) → message.updated / message.deleted.
 */
import { db } from "../db";
import { conversationIdForKey } from "../comms/project";
import { previewText, resolveAvatar } from "../comms/naming";
import { appendEvent, ensureSingleThread, replaceConversationMembers, setThreadPerson, upsertConversation, type Folder } from "../comms/store";
import { isCommsStatus, type CommsStatus } from "../comms/triage";
import { mintSourceCursor, sourceCursorPosition } from "../comms/timeline";
import type { Message, MessagePreview, Network } from "../comms/types";
import { clipText } from "../comms/wire";
import type { BbChat, BbMessage, BlueBubblesClient } from "./client";
import { bbMemberId, type ContactBook } from "./contacts";
import { BB_CAPABILITIES, bbChatTitle, bbConversationKey, chatKind, dmAddress, guidNetwork, isShortCodeSender, reactionsFrom, SELF_ID, senderName, senderOf, tapbackOf, toCommsMessage, type WireCtx } from "./map";
import { applyTapback, chatNetworkOf, chatServiceOf, getChatCached, markChatServiceProbed, noteMessageServices, putChat, tapbackRows } from "./state";

export type BbReader = Pick<BlueBubblesClient, "getChat" | "getMessage" | "queryMessages">;

export const conversationIdForChat = (chatGuid: string): string => conversationIdForKey(bbConversationKey(chatGuid));
export const threadIdForChat = (chatGuid: string): string => `th_${conversationIdForChat(chatGuid)}`;

/** The BlueBubbles chat behind a display thread, or null (not a BlueBubbles thread). Only a
 *  conversation THIS connector projected counts (review I2): its id is the hash of its chat GUID
 *  and its ref is no Matrix room id — a Matrix-bridged imessage/gmessages room (network imessage /
 *  sms from m.bridge) stays a Matrix thread. */
export function bbThreadSource(threadId: string): { chatGuid: string; network: Network } | null {
  const rows = db.prepare(`SELECT c.id AS id, c.source_ref AS ref, c.network AS network FROM comms_thread_members m
    JOIN comms_conversations c ON c.id = m.conversation_id WHERE m.thread_id = ? AND c.network IN ('imessage', 'sms')
      AND c.source_ref NOT LIKE '!%' ORDER BY c.last_event_at DESC`).all(threadId) as { id: string; ref: string; network: Network }[];
  const r = rows.find((x) => typeof x.ref === "string" && x.ref && x.id === conversationIdForChat(x.ref));
  return r ? { chatGuid: r.ref, network: r.network } : null;
}

const MAX_PREVIEW_CHARS = 1000;
const firstName = (n: string): string => n.trim().split(/\s+/)[0] ?? "";

export function wireCtx(threadId: string, network: Network, book: ContactBook, lookup?: (guid: string) => BbMessage | undefined): WireCtx {
  return {
    threadId,
    network,
    nameOf: (a) => book.nameOf(a),
    avatarOf: (a) => book.avatarOf(a),
    personOf: (a) => book.personOf(a),
    reactionsOf: (g) => reactionsFrom(tapbackRows(g), (a) => book.nameOf(a)),
    ...(lookup ? { lookup } : {}),
  };
}

/** The one-line preview of a chat's latest message (a tapback reads "Ann loved a message"). */
function previewOf(m: BbMessage, chat: BbChat, book: ContactBook, network: Network): MessagePreview | null {
  const group = chatKind(chat) === "group";
  const sender = senderOf(m, chat);
  const isSelf = sender === SELF_ID;
  const name = isSelf ? null : senderName(sender, book);
  const tb = tapbackOf(m);
  let text = "";
  if (tb?.kind === "tapback" && !tb.remove) {
    const stub = toCommsMessage({ guid: `${m.guid}#t`, dateCreated: m.dateCreated, isFromMe: m.isFromMe, handle: m.handle }, wireCtx("", network, book), chat)!;
    stub.body = null;
    text = previewText(stub, isSelf ? "You" : firstName(name ?? ""), false, tb.key);
  } else if (!tb) {
    const msg = toCommsMessage(m, wireCtx("", network, book), chat);
    if (msg) text = previewText(msg, firstName(name ?? ""), group);
  }
  text = clipText(text, MAX_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { text, senderName: name, isSelf, sentAt: new Date(m.dateCreated && m.dateCreated > 0 ? m.dateCreated : 0).toISOString() };
}

export interface ProjectOpts {
  /** The chat's latest message, when the caller holds it (a webhook). Else chat.lastMessage. */
  last?: BbMessage | null;
  /** The chat's vault thread note, when known. */
  vaultNoteId?: string | null;
  /** The triage status from the thread note's tags (comms/triage.ts commsStatus), when read. */
  status?: CommsStatus;
  /** Reader for the bounded "did the owner ever write here" probe (unknown-sender folder). */
  reader?: Pick<BbReader, "queryMessages">;
}

/** Project one chat into comms_conversations; returns its thread id (thread.updated when it changed). */
export async function projectChat(chat: BbChat, book: ContactBook, opts: ProjectOpts = {}): Promise<string> {
  const id = conversationIdForChat(chat.guid);
  const kind = chatKind(chat);
  const others = (chat.participants ?? []).map((h) => h.address).filter(Boolean);
  const dm = kind === "dm" ? dmAddress(chat) : null;
  // iMessage vs SMS from the newest message's service (unified `any;` GUIDs name none): record
  // what this call holds, and — never seen any — read the chat's recent messages once.
  let recent: BbMessage[] | null = null;
  const recentMessages = async (): Promise<BbMessage[] | null> => {
    if (recent || !opts.reader) return recent;
    recent = (await opts.reader.queryMessages({ chatGuid: chat.guid, limit: 25, sort: "DESC", with: ["handle"] }).catch(() => null))?.messages ?? null;
    return recent;
  };
  const held = [opts.last, chat.lastMessage].filter((m): m is BbMessage => !!m);
  if (held.length) noteMessageServices(held, chat.guid);
  if (!guidNetwork(chat.guid) && chatServiceOf(chat.guid) === null && opts.reader) {
    const r = await recentMessages();
    if (r) {
      noteMessageServices(r, chat.guid);
      if (chatServiceOf(chat.guid) === null) markChatServiceProbed(chat.guid);
    }
  }
  const network = chatNetworkOf(chat);
  const personName = dm && book.personOf(dm) ? book.nameOf(dm) : null;
  const { title, titleSource } = bbChatTitle(chat, book, network, personName);
  const dmAvatar = dm ? book.avatarOf(dm) : null;
  const avatar = resolveAvatar({
    dmMemberAvatar: dmAvatar && "mxc" in dmAvatar ? dmAvatar.mxc : null,
    title,
    memberAvatars: kind === "group" ? others.map((a) => { const r = book.avatarOf(a); return r && "mxc" in r ? r.mxc : null; }) : [],
  });
  const before = db.prepare("SELECT * FROM comms_conversations WHERE id = ?").get(id) as
    { folder?: string; last_preview_json?: string | null; last_event_at?: string; vault_note_id?: string | null; status?: string | null } | undefined;

  const last = opts.last ?? chat.lastMessage ?? null;
  const fresh = last && (!before?.last_event_at || (last.dateCreated ?? 0) >= Date.parse(before.last_event_at));
  const preview = fresh && last ? previewOf(last, chat, book, network) : null;
  const lastPreview = preview ?? (before?.last_preview_json ? (JSON.parse(before.last_preview_json) as MessagePreview) : null);
  const lastEventAt = fresh && last ? new Date(last.dateCreated && last.dateCreated > 0 ? last.dateCreated : 0).toISOString() : before?.last_event_at ?? new Date(0).toISOString();
  const lastIsSelf = lastPreview?.isSelf ?? false;

  let folder: Folder = "inbox";
  if (kind === "dm" && isShortCodeSender(dm)) folder = "low";
  else if (kind === "dm" && dm && !book.personOf(dm) && !book.known(dm) && !lastIsSelf) {
    // Decided once (review M12: no 25-message probe per unknown DM every refresh): "inbox" sticks
    // (the owner wrote here), "unknown" sticks until the owner writes (lastIsSelf → inbox above).
    if (before?.folder === "inbox" || before?.folder === "unknown") folder = before.folder;
    else if (opts.reader) {
      const r = await recentMessages();
      folder = r && !r.some((m) => m.isFromMe) ? "unknown" : "inbox";
    } else folder = (before?.folder as Folder | undefined) ?? "unknown";
  }

  upsertConversation({
    id, network, sourceRef: chat.guid, kind, title, titleSource, avatar, lastEventAt, lastPreview,
    unreadCount: lastPreview && !lastIsSelf ? (last && fresh && last.dateRead ? 0 : 1) : 0, unreadTrusted: false,
    folder, pinned: false, muted: false, archived: !!chat.isArchived, triage: null, accountLabel: null,
    capabilities: BB_CAPABILITIES, vaultNoteId: opts.vaultNoteId ?? before?.vault_note_id ?? null,
    // Triage status (review I1): the thread note's tags when the caller read them (the refresh),
    // else what the row holds — the projection never resets a classified thread.
    status: opts.status ?? (before?.status && isCommsStatus(before.status) ? before.status : "unclassified"),
  });
  const threadId = ensureSingleThread(id);
  // People (review I4): every handle is a member (tel:+E.164 / mailto:), tied to a person note by
  // a strong key; a DM's thread is that person's.
  const members = others.map((a) => ({ memberId: bbMemberId(a), personId: book.personOf(a) }));
  replaceConversationMembers(id, kind === "dm" ? members : members.filter((m) => m.personId));
  setThreadPerson(threadId, dm ? book.personOf(dm) : null);
  const after = db.prepare("SELECT * FROM comms_conversations WHERE id = ?").get(id);
  if (JSON.stringify(before) !== JSON.stringify(after)) appendEvent("thread.updated", threadId, { threadId });
  return threadId;
}

// ── live events (webhook) ───────────────────────────────────────────────────────────────────

/** The full chat (participants) for a GUID: the cache when fresh, else BlueBubbles (and cache it). */
export async function chatFor(guid: string, reader: Pick<BbReader, "getChat">, maxAgeMs = 10 * 60_000): Promise<BbChat | null> {
  const hit = getChatCached(guid);
  if (hit && Date.now() - hit.at < maxAgeMs && hit.chat.participants?.length) return hit.chat;
  const c = await reader.getChat(guid).catch(() => null);
  if (c) {
    putChat(c);
    return c;
  }
  return hit?.chat ?? null;
}

/** Record a tapback; returns the target's thread + refreshed message when its reactions changed. */
export async function applyLiveTapback(m: BbMessage, chat: BbChat, book: ContactBook, reader: Pick<BbReader, "getMessage">): Promise<Message | null> {
  const tb = tapbackOf(m);
  if (!tb || tb.kind !== "tapback") return null;
  const sender = senderOf(m, chat);
  if (!sender) return null;
  if (!applyTapback({ target: tb.target, sender, key: tb.key, remove: tb.remove, messageGuid: m.guid, at: m.dateCreated ?? 0 })) return null;
  const target = await reader.getMessage(tb.target).catch(() => null);
  if (!target) return null;
  return toCommsMessage(target, wireCtx(threadIdForChat(chat.guid), chatNetworkOf(chat), book), chat);
}

/**
 * One webhook / polled message into the live stream: message.created (new), message.updated
 * (edited), message.deleted (unsent), reaction.changed (a tapback on its target). Also folds
 * the chat's projection. Returns the thread id.
 */
export async function publishLive(kind: "new" | "updated", m: BbMessage, chat: BbChat, book: ContactBook, reader: BbReader, vaultNoteId?: string | null): Promise<string> {
  const threadId = await projectChat(chat, book, { ...(kind === "new" ? { last: m } : { last: (await reader.getChat(chat.guid).catch(() => null))?.lastMessage ?? null }), ...(vaultNoteId ? { vaultNoteId } : {}) });
  const network = chatNetworkOf(chat);
  if (tapbackOf(m)) {
    const target = await applyLiveTapback(m, chat, book, reader);
    if (target) appendEvent("reaction.changed", threadId, { threadId, message: target });
    return threadId;
  }
  const msg = toCommsMessage(m, wireCtx(threadId, network, book), chat);
  if (!msg) return threadId;
  const ev = kind === "new" ? "message.created" : msg.redacted ? "message.deleted" : "message.updated";
  appendEvent(ev, threadId, { threadId, message: msg });
  return threadId;
}

// ── the read path ───────────────────────────────────────────────────────────────────────────

export interface BbTimelinePage { messages: Message[]; before: string | null; hasMore: boolean }

/** Tapbacks take slots in a page: fetch more than asked, at most this many. */
const MAX_FETCH = 200;

/**
 * Newest-last page of an iMessage/SMS thread, read live from BlueBubbles (it is local; no
 * window cache). Cursor = a server-side `tc_` id holding the "before" timestamp. Tapbacks in
 * the page are recorded and folded into their targets; others in reach come from the table.
 */
export async function readBbTimeline(q: { threadId: string; chatGuid: string; network: Network; limit: number; before?: string; reader: BbReader; book: ContactBook }): Promise<BbTimelinePage | null> {
  let beforeTs: number | undefined;
  if (q.before) {
    const pos = sourceCursorPosition(q.before, q.threadId, q.chatGuid);
    if (pos === null) return null;
    beforeTs = Number(pos);
    if (!Number.isFinite(beforeTs) || beforeTs <= 0) return { messages: [], before: null, hasMore: false };
  }
  const fetch = Math.min(MAX_FETCH, Math.max(q.limit * 2, q.limit + 20));
  const { messages: raw } = await q.reader.queryMessages({ chatGuid: q.chatGuid, limit: fetch, sort: "DESC", ...(beforeTs ? { before: beforeTs } : {}), with: ["attachment", "handle"] });
  noteMessageServices(raw, q.chatGuid);
  const chat = (await chatFor(q.chatGuid, q.reader).catch(() => null)) ?? { guid: q.chatGuid };
  const byGuid = new Map(raw.map((m) => [m.guid, m]));
  for (const m of raw) {
    const tb = tapbackOf(m);
    const sender = tb?.kind === "tapback" ? senderOf(m, chat) : null;
    if (tb?.kind === "tapback" && sender) applyTapback({ target: tb.target, sender, key: tb.key, remove: tb.remove, messageGuid: m.guid, at: m.dateCreated ?? 0 });
  }
  const ctx = wireCtx(q.threadId, q.network, q.book, (g) => byGuid.get(g));
  const normal = raw.filter((m) => !tapbackOf(m));
  const page = normal.slice(0, q.limit);
  const messages = page.map((m) => toCommsMessage(m, ctx, chat)).filter((m): m is Message => !!m).reverse();
  // Continue below the oldest message SERVED (or, when the page held only tapbacks, below everything read).
  const oldest = page.length ? page[page.length - 1]! : raw[raw.length - 1];
  const more = raw.length >= fetch || normal.length > q.limit;
  const at = oldest?.dateCreated ?? 0;
  const before = more && at > 0 ? mintSourceCursor(q.threadId, q.chatGuid, String(at)) : null;
  return { messages, before, hasMore: !!before };
}

/** Thread members for the detail view (Contacts names / person notes, contact photos). */
export async function readBbMembers(chatGuid: string, reader: Pick<BbReader, "getChat">, book: ContactBook): Promise<Array<{ id: string; name: string; avatar: import("../comms/types").AvatarRef | null }>> {
  const chat = await chatFor(chatGuid, reader).catch(() => null);
  return (chat?.participants ?? []).slice(0, 500).map((h) => ({ id: h.address, name: senderName(h.address, book), avatar: book.avatarOf(h.address) }));
}
