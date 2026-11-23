/**
 * BlueBubbles → Prism mapping (pure; unit-tested without a server).
 *
 * Sources (BlueBubbles Server v1.9.12, packages/server/src/server):
 *  - MessageSerializer.ts: guid, text, handle {address, service}, isFromMe, dateCreated (epoch
 *    ms), dateEdited / dateRetracted (ms, Ventura+), associatedMessageGuid/-Type, attachments[],
 *    chats[] (webhook + `with=chat`), threadOriginatorGuid, error, itemType, groupTitle.
 *  - MessageTypeTransformer.ts: associatedMessageType is serialized as a NAME for the known
 *    codes — 2000 love, 2001 like, 2002 dislike, 2003 laugh, 2004 emphasize, 2005 question,
 *    3000–3005 the same with a leading "-" (removed), 1000 sticker — and as the numeric string
 *    for anything else (2006/3006 custom emoji tapbacks, 2007 sticker tapbacks on newer macOS).
 *  - associatedMessageGuid is "p:<part>/<target guid>" (or "bp:<target guid>" for a whole
 *    balloon): the target is the part after the "/" (or after "bp:").
 *  - ChatSerializer.ts: guid ("iMessage;-;+1555…" DM, "iMessage;+;chat…" group, "SMS;-;…"),
 *    style (43 = group, 45 = one-to-one), chatIdentifier, displayName, participants[].
 */
import { createHash } from "node:crypto";
import type { Capabilities } from "../comms/room-meta";
import { fromPlainText } from "../comms/richtext";
import { formatHandle, membersTitle, resolveTitle, type GroupMember, type TitleSource } from "../comms/naming";
import type { Attachment, AvatarRef, Message, Network, Reaction } from "../comms/types";
import type { BbChat, BbMessage } from "./client";
import { bbAttachmentRef } from "../comms/media";
import { addressKey, type ContactBook } from "./contacts";

/** The sender id of the owner's own messages (iMessage has no id for "me" in the payload). */
export const SELF_ID = "bluebubbles:self";

/** What the connector can do with SIP on (D6): send text + attachments; no tapbacks, typing, receipts. */
export const BB_CAPABILITIES: Capabilities = { react: false, edit: false, unsend: false, reply: false, typing: false, receipts: false, attachments: true };

/** "imessage" | "sms" for a BlueBubbles service name (RCS counts as SMS), else null. */
export function serviceNetwork(service: string | null | undefined): Network | null {
  const s = (service ?? "").trim().toLowerCase();
  if (s === "sms" || s === "rcs") return "sms";
  if (s.startsWith("imessage")) return "imessage";
  return null;
}

/** The network a chat GUID names explicitly (`iMessage;…` / `SMS;…` / `RCS;…`), or null — macOS 26
 *  files chats under a unified `any;-;<handle>` / `any;+;chat…` that names no service. */
export function guidNetwork(guid: string): Network | null {
  return serviceNetwork(guid.split(";", 1)[0] ?? "");
}

/**
 * The service ONE message travelled on, as Messages decides the bubble colour. BlueBubbles 1.9.12's
 * MessageSerializer does not serialize chat.db's `message.service` column; the message's `handle`
 * ({address, service}, HandleSerializer) is the handle row Messages used — one row per address per
 * service — so its service is the message's. A top-level `service` (a later server) wins when
 * present. Null when unknown: a group message of mine has no handle (handle_id 0), and a failed
 * send (error ≠ 0) proves nothing about the working service.
 */
export function messageService(m: Pick<BbMessage, "handle" | "error" | "service">): Network | null {
  if (m.error) return null;
  return serviceNetwork(m.service) ?? serviceNetwork(m.handle?.service);
}

/** iMessage vs SMS (RCS counts as SMS: same carrier path, same green bubble on Apple's side).
 *  The GUID prefix when it names one; else `fallbackService` (bluebubbles/state.ts chatNetworkOf
 *  passes the newest message's service, the participant handle's only when no message is known). */
export function chatNetwork(chat: Pick<BbChat, "guid"> | string, fallbackService?: string | null): Network {
  const guid = typeof chat === "string" ? chat : chat.guid;
  return guidNetwork(guid) ?? (serviceNetwork(fallbackService) === "sms" ? "sms" : "imessage");
}

/** The members an unnamed group is titled after: every participant but the owner, one entry per
 *  person (a phone + an email of the same person note count once), in BlueBubbles' order. */
export function groupMembers(chat: Pick<BbChat, "participants">, book: Pick<ContactBook, "nameOf"> & Partial<Pick<ContactBook, "firstNameOf" | "isSelf" | "personOf">>): GroupMember[] {
  const out: GroupMember[] = [];
  const seen = new Set<string>();
  for (const h of chat.participants ?? []) {
    const a = typeof h?.address === "string" ? h.address.trim() : "";
    if (!a || book.isSelf?.(a)) continue;
    const key = book.personOf?.(a) ?? addressKey(a) ?? a;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ handle: a, fullName: book.nameOf(a), firstName: book.firstNameOf?.(a) ?? null });
  }
  return out;
}

/**
 * A chat's title. DM: the counterpart's person note → Contacts → the formatted handle
 * (resolveTitle). Group: its own name when it has one ("room"); else Apple Messages' member title
 * — "Ann", "Ann & Bob", "Ann, Bob & 3 others" ("members"), never one member's name for the group.
 */
export function bbChatTitle(chat: Pick<BbChat, "guid" | "style" | "participants" | "chatIdentifier" | "displayName">, book: Parameters<typeof groupMembers>[1], network: Network, personName?: string | null): { title: string; titleSource: TitleSource } {
  const kind = chatKind(chat);
  const others = (chat.participants ?? []).map((h) => h.address).filter(Boolean);
  if (kind === "group") {
    const named = resolveTitle({ roomName: chat.displayName ?? null, memberDisplayNames: [], kind, network });
    if (named.titleSource === "room") return named;
    const title = membersTitle(groupMembers(chat, book));
    if (title) return { title, titleSource: "members" };
  }
  const dm = kind === "dm" ? dmAddress(chat) : null;
  return resolveTitle({
    person: personName ? { name: personName } : null,
    roomName: null,
    memberDisplayNames: others.map((a) => book.nameOf(a)).filter((n): n is string => !!n),
    handle: dm ?? others[0] ?? null,
    kind,
    network,
  });
}

export function chatKind(chat: Pick<BbChat, "guid" | "style" | "participants">): "dm" | "group" {
  if (chat.style === 43) return "group";
  if (chat.style === 45) return "dm";
  if (chat.guid.includes(";+;")) return "group";
  if (chat.guid.includes(";-;")) return "dm";
  return (chat.participants?.length ?? 0) > 1 ? "group" : "dm";
}

/** The other party's address of a one-to-one chat (participants, else the chat identifier). */
export function dmAddress(chat: Pick<BbChat, "guid" | "chatIdentifier" | "participants">): string | null {
  const p = chat.participants?.find((h) => typeof h?.address === "string" && h.address);
  if (p) return p.address;
  if (chat.chatIdentifier) return chat.chatIdentifier;
  const i = chat.guid.indexOf(";-;");
  return i >= 0 ? chat.guid.slice(i + 3) || null : null;
}

/** Stable, opaque conversation id for a chat GUID (same encoding as the Matrix one, own prefix). */
export function bbConversationKey(chatGuid: string): string {
  return `bluebubbles:${chatGuid}`;
}

// ── D13: one-time codes and short-code senders never reach the vault ───────────────────────

/**
 * A short-code / alphanumeric sender (bank alerts, 2FA, carriers): not a person's address.
 * Phone numbers are ≥ 7 digits (national) — anything shorter, or an alphanumeric sender id
 * ("AMAZON", "VERIFY"), is a short code. Emails are people.
 */
export function isShortCodeSender(address: string | null | undefined): boolean {
  const a = (address ?? "").trim();
  if (!a || a.includes("@")) return false;
  const digits = a.replace(/[\s().+-]/g, "");
  if (/^\d+$/.test(digits)) return digits.length <= 6;
  return /[A-Za-z]/.test(a); // alphanumeric sender id
}

/**
 * OTP rule version. Bump it whenever the heuristic below changes: messages excluded under an
 * older version are re-evaluated (bluebubbles/state.ts staleOtpGuids → service pass).
 */
export const OTP_RULE_VERSION = 2;

// Unicode-aware boundaries: a token / word never touches a letter or digit of any script.
const NB = String.raw`(?<![\p{L}\p{N}])`;
const NA = String.raw`(?![\p{L}\p{N}])`;
/** Words that name a one-time code, in the languages iOS 2FA senders use. Never generic words
 *  ("confirm", "security", "login", "password", "token" alone — review I2). */
const CODE_WORDS = new RegExp(
  `${NB}(?:code|codes|passcode|pin|otp|one[\\s-]?time|verification|verify|2fa|mfa|two[\\s-]?(?:factor|step)|`
  + `authentication|login code|sign[\\s-]?in code|security code|access code|`
  + `код|кодом|кода|código|codigo|bestätigungscode|sicherheitscode|kod|kode|codice)${NA}`
  + `|コード|認証番号|验证码|驗證碼|校验码|인증번호|인증 번호|รหัส`,
  "iu",
);
/** Phrases that make a message a code by themselves (with a token anywhere). */
const STRONG = /(?:is your|est votre|ist dein|es tu|é o seu)\b[^.\n]{0,40}\b(?:code|código|codigo)|\byour\b[^.\n]{0,30}\bcode\b|\b(?:do not|don['’]?t|never) share\b|\bone[\s-]?time (?:pass(?:word|code)?|code)\b|ваш код|認証コード|验证码|驗證碼|인증번호/iu;
/** Candidate code tokens: one 4–8 digit run, or 2–4 groups of 2–4 digits (4–8 digits in all)
 *  separated by a space or "-", or a sender-prefixed "G-482913". Maximal runs only. */
const TOKEN = new RegExp(String.raw`${NB}(?:[A-Z]{1,3}-)?\d+(?:[ \-]\d+)*${NA}`, "gu");
/** Apple's origin-bound format: "@example.com #123456". */
const ORIGIN_BOUND = /@[\w.-]+\.\w+\s+#\d{4,8}\b/u;
const CURRENCY_BEFORE = /[$€£¥₹₽₩₪฿]\s*$|\b(?:usd|eur|gbp|chf|rs|inr|rub)\s*$/iu;
const UNIT_AFTER = /^\s*(?:%|€|\$|£|¥|₹|₽|(?:usd|eur|gbp|chf|kg|km|mi|ft|m|cm|mm|lb|lbs|sq|sqft|mph|kmh|am|pm|h|hrs|min|mins|years?|yrs?|dollars?|euros?|pounds?)\b)/iu;

/** A code-shaped token at [i, i+len) in `t`, or null. */
function codeToken(t: string, raw: string, i: number): { digits: string; prefixed: boolean } | null {
  const prefixed = /^[A-Z]{1,3}-/.test(raw);
  const num = prefixed ? raw.slice(raw.indexOf("-") + 1) : raw;
  const groups = num.split(/[ \-]/);
  const digits = groups.join("");
  if (digits.length < 4 || digits.length > 8) return null;
  if (groups.length > 1 && (groups.length > 4 || groups.some((g) => g.length < 2 || g.length > 4))) return null;
  if (!prefixed) {
    if (groups.length === 1 && digits.length === 4 && /^(?:19|20)\d\d$/.test(digits)) return null; // a year
    if (CURRENCY_BEFORE.test(t.slice(Math.max(0, i - 6), i))) return null; // a price
    if (UNIT_AFTER.test(t.slice(i + raw.length, i + raw.length + 12))) return null; // an amount
    if (/[.,]\d$/.test(t.slice(i + raw.length, i + raw.length + 2)) || /\d[.,]$/.test(t.slice(Math.max(0, i - 2), i))) return null; // a decimal
  }
  return { digits, prefixed };
}

/**
 * A one-time code message (D13), rule v2 (review I2): a code-shaped token (not a year, a price,
 * an amount or a decimal) AND a code word within 30 characters of it — or a strong phrase
 * ("your … code", "do not share", "認証コード", …) anywhere — or a sender-prefixed "G-482913",
 * or Apple's origin-bound "@domain #123456". Unicode-aware.
 */
export function isOneTimeCode(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 1000) return false;
  if (ORIGIN_BOUND.test(t)) return true;
  const strong = STRONG.test(t);
  for (const m of t.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    const tok = codeToken(t, m[0], i);
    if (!tok) continue;
    if (tok.prefixed && tok.digits.length >= 5) return true;
    if (strong) return true;
    const near = t.slice(Math.max(0, i - 30), i) + " " + t.slice(i + m[0].length, i + m[0].length + 30);
    if (CODE_WORDS.test(near)) return true;
  }
  return false;
}

// ── tapbacks ────────────────────────────────────────────────────────────────────────────────

const TAPBACK_KEY: Record<string, string> = {
  love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓",
};
const TAPBACK_CODE: Record<number, string> = { 2000: "love", 2001: "like", 2002: "dislike", 2003: "laugh", 2004: "emphasize", 2005: "question" };

export type Tapback =
  | { kind: "tapback"; target: string; part: number; key: string; remove: boolean }
  /** Any other associated message (stickers, custom-emoji tapbacks we cannot render): not a bubble. */
  | { kind: "ignored"; target: string | null };

/** "p:0/GUID" → {GUID, 0}; "bp:GUID" → {GUID, 0}; a bare GUID stays. */
export function parseAssociatedGuid(raw: string | null | undefined): { guid: string; part: number } | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const p = /^p:(\d+)\/(.+)$/.exec(s);
  if (p) return { guid: p[2]!, part: Number(p[1]) };
  if (s.startsWith("bp:")) return s.length > 3 ? { guid: s.slice(3), part: 0 } : null;
  return { guid: s, part: 0 };
}

/** The tapback a message carries, or null for an ordinary message. */
export function tapbackOf(m: Pick<BbMessage, "associatedMessageGuid" | "associatedMessageType" | "text">): Tapback | null {
  const raw = m.associatedMessageType;
  if (raw === null || raw === undefined || raw === "" || raw === 0 || raw === "0") return null;
  const target = parseAssociatedGuid(m.associatedMessageGuid);
  let name: string | null = null;
  let remove = false;
  if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    if (n >= 2000 && n <= 2005) name = TAPBACK_CODE[n]!;
    else if (n >= 3000 && n <= 3005) { name = TAPBACK_CODE[n - 1000]!; remove = true; }
    else if (n === 2006 || n === 3006) {
      // A custom-emoji tapback (iOS 18 / macOS 15): the emoji is only in the summary text
      // ("Reacted 🎉 to “…”"); take it from there when it is there.
      const e = /^Reacted (\p{Extended_Pictographic}[\p{Extended_Pictographic}\u{FE0F}\u{200D}\p{Emoji_Modifier}]*) to /u.exec(m.text ?? "");
      if (e && target) return { kind: "tapback", target: target.guid, part: target.part, key: e[1]!, remove: n === 3006 };
      if (n === 3006 && target) return { kind: "tapback", target: target.guid, part: target.part, key: "*", remove: true };
      return { kind: "ignored", target: target?.guid ?? null };
    } else return { kind: "ignored", target: target?.guid ?? null };
  } else {
    const s = String(raw);
    remove = s.startsWith("-");
    name = remove ? s.slice(1) : s;
    if (!TAPBACK_KEY[name]) return { kind: "ignored", target: target?.guid ?? null };
  }
  if (!target || !name) return { kind: "ignored", target: target?.guid ?? null };
  return { kind: "tapback", target: target.guid, part: target.part, key: TAPBACK_KEY[name]!, remove };
}

// ── senders, bodies, attachments ────────────────────────────────────────────────────────────

/** The stable sender id of a message: SELF_ID for the owner, else the handle's address. */
export function senderOf(m: Pick<BbMessage, "isFromMe" | "handle">, chat?: Pick<BbChat, "guid" | "chatIdentifier" | "participants" | "style"> | null): string | null {
  if (m.isFromMe) return SELF_ID;
  const a = m.handle?.address;
  if (typeof a === "string" && a) return a;
  // A DM's only other party is the sender even when the handle was not joined.
  return chat && chatKind(chat) === "dm" ? dmAddress(chat) : null;
}

/** The text of a message as a person reads it ("￼" attachment placeholders dropped). */
export function textOf(m: Pick<BbMessage, "text" | "subject">): string {
  const t = (m.text ?? "").replace(/￼/g, "").replace(/\r\n?/g, "\n").trim();
  const subject = (m.subject ?? "").trim();
  return subject && t ? `${subject}\n${t}` : subject || t;
}

/** UTIs (and file extensions) of picture/video attachments whose `mimeType` BlueBubbles left empty. */
const IMAGE_UTIS: Record<string, string> = {
  "public.heic": "image/heic", "public.heif": "image/heif", "public.jpeg": "image/jpeg", "public.png": "image/png",
  "com.compuserve.gif": "image/gif", "public.tiff": "image/tiff", "org.webmproject.webp": "image/webp", "public.avif": "image/avif",
};
const VIDEO_UTIS: Record<string, string> = { "com.apple.quicktime-movie": "video/quicktime", "public.mpeg-4": "video/mp4" };
const EXT_MIME: Record<string, string> = {
  heic: "image/heic", heif: "image/heif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", avif: "image/avif", mov: "video/quicktime", mp4: "video/mp4", m4v: "video/mp4",
};

/**
 * The attachment's type as BlueBubbles describes it: `mimeType`, else its UTI, else the file
 * name's extension (older chat.db rows and some Live Photo stills carry no mimeType). Only a
 * hint for the kind and the client; the media route serves the SNIFFED type.
 */
export function attachmentMime(a: { mimeType?: string | null; uti?: string | null; transferName?: string | null }): string | null {
  const mime = (a.mimeType ?? "").trim().toLowerCase();
  if (mime && mime !== "application/octet-stream") return mime;
  const uti = (a.uti ?? "").trim().toLowerCase();
  if (IMAGE_UTIS[uti]) return IMAGE_UTIS[uti]!;
  if (VIDEO_UTIS[uti]) return VIDEO_UTIS[uti]!;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(a.transferName ?? "")?.[1]?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext]!;
  return mime || null;
}

/**
 * Rich-link payloads (`*.pluginPayloadAttachment`, the data behind a link preview / app
 * balloon) are not attachments a person sent: Messages never shows them as files.
 */
export function isPluginPayload(a: { transferName?: string | null; uti?: string | null }): boolean {
  return /\.pluginpayloadattachment$/i.test(a.transferName ?? "") || /pluginpayloadattachment/i.test(a.uti ?? "");
}

function attachmentKind(a: { mimeType?: string | null; uti?: string | null; transferName?: string | null; isSticker?: boolean | null }, isAudioMessage: boolean): Attachment["kind"] {
  const mime = attachmentMime(a) ?? "";
  if (a.isSticker) return "sticker";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/") || /audio|caf/.test(a.uti ?? "")) return isAudioMessage ? "voice" : "audio";
  if (mime === "text/vcard" || mime === "text/x-vlocation") return mime === "text/x-vlocation" ? "location" : "file";
  return "file";
}

export function attachmentsOf(m: Pick<BbMessage, "attachments" | "isAudioMessage">): Attachment[] {
  const out: Attachment[] = [];
  for (const a of m.attachments ?? []) {
    if (!a || typeof a.guid !== "string" || !a.guid || a.hideAttachment || isPluginPayload(a)) continue;
    const ref = bbAttachmentRef(a.guid);
    if (!ref) continue;
    const att: Attachment = { kind: attachmentKind(a, !!m.isAudioMessage), mxc: ref };
    const mime = attachmentMime(a);
    if (mime) att.mime = mime;
    if (typeof a.totalBytes === "number" && a.totalBytes >= 0) att.size = a.totalBytes;
    if (typeof a.width === "number" && a.width > 0) att.w = a.width;
    if (typeof a.height === "number" && a.height > 0) att.h = a.height;
    if (a.transferName) att.name = a.transferName;
    out.push(att);
  }
  return out;
}

/** The vault line body: the text, else the attachment names (Matrix m.image bodies are file names too). */
export function vaultBodyOf(m: BbMessage): string {
  const t = textOf(m);
  if (t) return t;
  const names = (m.attachments ?? []).filter((a) => a && !a.hideAttachment && !isPluginPayload(a)).map((a) => a.transferName || "attachment");
  return names.length ? names.map((n) => `📎 ${n}`).join(" ") : "";
}

// ── comms wire ──────────────────────────────────────────────────────────────────────────────

export interface WireCtx {
  threadId: string;
  network: Network;
  /** Display name for an address (Contacts / person note), or null. */
  nameOf: (address: string) => string | null;
  /** Avatar for an address (a contact photo ref), or null. */
  avatarOf?: (address: string) => AvatarRef | null;
  /** The person note id an address resolves to with a strong key (D3), or null. */
  personOf?: (address: string) => string | null;
  /** Tapbacks currently on a message (bluebubbles_tapbacks + the page's own). */
  reactionsOf?: (guid: string) => Reaction[];
  /** Text of another message in reach (for replyTo snippets). */
  lookup?: (guid: string) => BbMessage | undefined;
}

const iso = (ms: number | null | undefined): string => new Date(typeof ms === "number" && ms > 0 ? ms : 0).toISOString();

function systemOf(m: BbMessage, actor: string): { kind: string; text: string } | null {
  const it = m.itemType ?? 0;
  if (!it) return null;
  if (it === 2) return { kind: "rename", text: m.groupTitle ? `${actor} named the conversation “${m.groupTitle}”` : `${actor} removed the name from the conversation` };
  if (it === 1) return { kind: "members", text: m.groupActionType === 1 ? `${actor} removed someone from the conversation` : `${actor} added someone to the conversation` };
  if (it === 3) return { kind: m.groupActionType === 1 ? "photo" : "leave", text: m.groupActionType === 1 ? `${actor} changed the group photo` : `${actor} left the conversation` };
  return { kind: "system", text: "Conversation updated" };
}

/** The display name of a sender for the wire (never a raw id beyond a formatted handle). */
export function senderName(id: string | null, ctx: Pick<WireCtx, "nameOf">): string {
  if (!id) return "Unknown";
  if (id === SELF_ID) return "You";
  return ctx.nameOf(id) ?? formatHandle(id);
}

/**
 * One BlueBubbles message → a Comms wire Message, or null for tapbacks / ignored associated
 * messages (they fold into their target's reactions). Attachment refs are `bb://…` media refs
 * (comms/media.ts) that messageOut turns into media tokens.
 */
export function toCommsMessage(m: BbMessage, ctx: WireCtx, chat?: BbChat | null): Message | null {
  if (tapbackOf(m)) return null;
  const sender = senderOf(m, chat);
  const isSelf = sender === SELF_ID;
  const name = senderName(sender, ctx);
  const text = textOf(m);
  const personId = sender && !isSelf ? ctx.personOf?.(sender) ?? null : null;
  const retracted = typeof m.dateRetracted === "number" && m.dateRetracted > 0;
  const msg: Message = {
    id: m.guid,
    threadId: ctx.threadId,
    channel: { network: ctx.network, accountLabel: null, capabilities: BB_CAPABILITIES },
    source: { network: ctx.network, eventId: m.guid, ref: m.guid },
    sender: {
      id: sender ?? "unknown",
      name,
      avatar: sender && !isSelf ? ctx.avatarOf?.(sender) ?? null : null,
      isSelf,
      isOmni: false,
      ...(personId ? { personId } : {}),
    },
    sentAt: iso(m.dateCreated),
    body: retracted || !text ? null : fromPlainText(text),
    attachments: retracted ? [] : attachmentsOf(m),
    linkPreviews: [],
    reactions: ctx.reactionsOf?.(m.guid) ?? [],
    delivery: isSelf ? ((m.error ?? 0) !== 0 ? "failed" : m.dateRead ? "read" : m.isDelivered || m.dateDelivered ? "delivered" : "sent") : null,
    redacted: retracted,
  };
  if (isSelf && (m.error ?? 0) !== 0) msg.deliveryError = `iMessage error ${m.error}`;
  // iMessage read time (Task 8): BlueBubbles' dateRead on the owner's message (DMs with the
  // other side's read receipts on; iMessage gives groups none).
  if (msg.delivery === "read" && typeof m.dateRead === "number" && m.dateRead > 0) msg.readAt = iso(m.dateRead);
  if (typeof m.dateEdited === "number" && m.dateEdited > 0 && !retracted) msg.editedAt = iso(m.dateEdited);
  const sys = systemOf(m, isSelf ? "You" : name);
  if (sys) msg.system = sys;
  const reply = m.threadOriginatorGuid ? ctx.lookup?.(m.threadOriginatorGuid) : undefined;
  if (m.threadOriginatorGuid) {
    msg.threadRoot = m.threadOriginatorGuid;
    if (reply) msg.replyTo = { messageId: reply.guid, snippet: textOf(reply).slice(0, 140), senderName: senderName(senderOf(reply, chat), ctx) };
  }
  return msg;
}

/** Group tapback rows into wire reactions (one per key, in first-seen order). */
export function reactionsFrom(rows: Array<{ sender: string; key: string; message_guid: string }>, nameOf: (address: string) => string | null): Reaction[] {
  const by = new Map<string, Reaction>();
  for (const r of rows) {
    const cur = by.get(r.key) ?? { key: r.key, count: 0, mine: false, senders: [] };
    cur.count++;
    if (r.sender === SELF_ID) cur.mine = true;
    cur.senders.push({ id: r.sender, name: senderName(r.sender, { nameOf }), eventId: r.message_guid });
    by.set(r.key, cur);
  }
  return [...by.values()];
}

/** A short, non-reversible tag for logs (never a phone number or chat GUID in a log line). */
export const redactRef = (ref: string): string => `bb_${createHash("sha256").update(ref).digest("hex").slice(0, 8)}`;

/** An error for a log line (final review M6): its class and HTTP status only — never a message
 *  (a vault error carries a path / body, a BlueBubbles one can echo a chat GUID = a number). */
export function errorForLog(e: unknown): string {
  if (!(e instanceof Error)) return "error";
  const op = (e as { op?: unknown }).op;
  const status = (e as { status?: unknown }).status;
  return [e.name, typeof op === "string" ? op : null, typeof status === "number" ? String(status) : status === null ? "no response" : null].filter(Boolean).join(" ");
}
