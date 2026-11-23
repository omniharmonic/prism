// Display naming for Comms: handles, thread titles, last-message previews, avatars.
// A title never shows a vault slug, room id, raw mxid or ghost id when a better name exists.
import type { AvatarRef, Message } from "./types.js";

const PREFIXES = ["whatsapp", "telegram", "discord", "signal", "instagram", "facebook", "twitter", "meta", "slack", "linkedin"] as const;
/** Networks whose numeric ghost ids are platform user ids, never phone numbers. */
const NON_PHONE = new Set(["telegram", "discord", "instagram", "facebook", "twitter", "meta", "slack", "linkedin"]);
/** Opaque remote ids that mean nothing to a person: a WhatsApp LID, a Signal ACI (a UUID), a
 *  mautrix-slack `<team>-<user>` id (`t0123abcd-u0456efgh`). Shown as "<Network> user". */
const OPAQUE_ID = /^(?:lid-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|t[a-z0-9]+-[uwb][a-z0-9]+)$/i;
/** Two-digit ITU country codes; 1 and 7 are one digit, everything else is three. */
const CC2 = new Set([
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66",
  "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98",
]);

/** Groups of 3 and 4 only (the 4s at the end): 10 → 3 3 4, 11 → 3 4 4. */
function group(d: string): string {
  const n = d.length;
  const fours = n % 3 === 0 ? 0 : n % 3 === 1 ? 1 : 2;
  if (n < 4 * fours) return d.length > 4 ? `${d.slice(0, 2)} ${d.slice(2)}` : d;
  const out: string[] = [];
  let i = 0;
  for (; i < n - 4 * fours; i += 3) out.push(d.slice(i, i + 3));
  for (; i < n; i += 4) out.push(d.slice(i, i + 4));
  return out.join(" ");
}

function formatPhone(d: string): string {
  if (d.startsWith("1")) {
    const n = d.slice(1);
    if (n.length === 10) return `+1 ${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
    if (n.length === 7) return `+1 ${n.slice(0, 3)}-${n.slice(3)}`;
    return `+1 ${group(n)}`;
  }
  const ccLen = d.startsWith("7") ? 1 : CC2.has(d.slice(0, 2)) ? 2 : 3;
  return `+${d.slice(0, ccLen)} ${group(d.slice(ccLen))}`;
}

/**
 * A raw identifier (Matrix mxid, bridge ghost, bare phone number) as a person-readable
 * handle: `@whatsapp_15550001:server` → "+1 555-0001", `@telegram_alice:server` → "@alice".
 * Never returns the homeserver part (nothing after a ':').
 */
export function formatHandle(raw: string): string {
  let s = raw.trim();
  const isMxid = s.startsWith("@");
  if (isMxid) s = s.slice(1);
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(0, colon);
  let network: string | null = null;
  for (const p of PREFIXES) {
    if (s.toLowerCase().startsWith(`${p}_`)) {
      network = p;
      s = s.slice(p.length + 1);
      break;
    }
  }
  const label = network ? (network === "whatsapp" ? "WhatsApp" : network === "linkedin" ? "LinkedIn" : network[0]!.toUpperCase() + network.slice(1)) : null;
  // mautrix-linkedin ghosts carry an opaque member URN id (never a name or a phone).
  if (network === "linkedin" && /^[a-z0-9_-]{6,}$/i.test(s)) return "LinkedIn user";
  // A WhatsApp LID, a Signal UUID, a Slack team-user id: opaque, never a phone, never worth showing.
  if (label && OPAQUE_ID.test(s)) return `${label} user`;
  const digits = s.replace(/^\+/, "");
  if (/^\d{7,15}$/.test(digits) && !(network && NON_PHONE.has(network))) return formatPhone(digits);
  if (!s) return label ? `${label} user` : "Unknown";
  return isMxid || network ? `@${s}` : s;
}

// ---- titles -------------------------------------------------------------------------

export interface TitleInputs {
  person?: { name: string } | null;
  roomName?: string | null;
  channelName?: string | null;
  memberDisplayNames: string[];
  emailDisplayName?: string | null;
  handle?: string | null;
  kind: "dm" | "group";
  /** The room's network, when known: Slack channel names are kebab-case by design ("eng-on-call"). */
  network?: string | null;
}
/** "members": an unnamed group titled from its members, Messages-style ("Ann, Bob & 3 others"). */
export type TitleSource = "person" | "room" | "contact" | "members" | "email" | "handle";

// Conservative on purpose: real group names ("co-op", "AC/DC", "Signal_Boost", "Climbers") must survive.
// `[\w-]`: WhatsApp LID ghosts are `whatsapp_lid-<digits>` (a hyphen; production had one as a title).
// Slack ghosts are `slack_<team>-<user>` (mautrix-slack MakeUserID, lowercased).
const GHOST_LOCALPART = /^(whatsapp|telegram|discord|signal|instagram|facebook|meta|twitter|imessage|slack|linkedin)_[\w-]*\d[\w-]*$/i;
const MATRIX_ID = /^[!@#+$]\S+:\S+$/;
const KEBAB_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){2,}$|^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/;
const PATH_LIKE = /^[\w.-]+(?:\/[\w.-]+)+$/;
// Path-like = no spaces, and either 2+ slashes or all lowercase ("vault/people"); "AC/DC" and "Work/Life" survive.
const EMPTY_ROOM = /^empty room\b/i;
const PHONE_LIKE = /^\+?[\d\s().-]{7,}$/;
const NETWORK_SUFFIX = /\s*\((?:WA|WhatsApp|Telegram|TG|Signal|Messenger|Discord|X|Twitter|Slack|Instagram|IG|LinkedIn)\)\s*$/i;

/** Networks whose real chat names are kebab-case slugs (Slack channels: "eng-on-call", "q3-planning-2"). */
const SLUG_NAMED = new Set(["slack"]);

/** True when a candidate name is an identifier rather than something a person would call the chat.
 *  `network` = the room's network, when known: on Slack a kebab slug is the channel's real name. */
export function looksLikeId(raw: string, network?: string | null): boolean {
  const s = raw.trim();
  const slugOk = !!network && SLUG_NAMED.has(network);
  return GHOST_LOCALPART.test(s) || MATRIX_ID.test(s) || (PATH_LIKE.test(s) && (s.split("/").length > 2 || s === s.toLowerCase())) || (!slugOk && KEBAB_SLUG.test(s)) || EMPTY_ROOM.test(s);
}

type Candidate = { name: string } | { phone: string } | null;

/** A real name, a phone number (formatted), or nothing; network suffixes like " (WA)" are dropped. */
function classify(raw: string | null | undefined, network?: string | null): Candidate {
  const s = raw?.replace(NETWORK_SUFFIX, "").trim();
  if (!s) return null;
  if (PHONE_LIKE.test(s)) return { phone: formatHandle(s.replace(/\D/g, "")) };
  return looksLikeId(s, network) ? null : { name: s };
}

/**
 * A person's display name for `id` as shown on the wire (senders, members, system lines): the
 * given name when it is a real name, a formatted phone when it is one, else `formatHandle(id)` —
 * never a raw ghost localpart ("whatsapp_15550001") or mxid (ledger F2).
 */
export function displayNameFor(name: string | null | undefined, id: string): string {
  const c = classify(name);
  if (c && "name" in c) return c.name;
  if (c && "phone" in c) return c.phone;
  return formatHandle(id);
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} & ${rest} other${rest === 1 ? "" : "s"}`;
}

/**
 * Callers must exclude the owner (self) from `memberDisplayNames`. A phone-number display name
 * never shows raw: it is formatted and reported as titleSource "handle", and any real name wins over it.
 */
export function resolveTitle(i: TitleInputs): { title: string; titleSource: TitleSource } {
  const phones: string[] = [];
  const pick = (raw: string | null | undefined): string | null => {
    const c = classify(raw, i.network);
    if (c && "phone" in c) phones.push(c.phone);
    return c && "name" in c ? c.name : null;
  };
  const person = pick(i.person?.name);
  if (person) return { title: person, titleSource: "person" };
  const room = pick(i.roomName) ?? pick(i.channelName);
  if (room) return { title: room, titleSource: "room" };
  if (i.kind === "dm") {
    const email = pick(i.emailDisplayName);
    if (email) return { title: email, titleSource: "email" };
  }
  const names = i.memberDisplayNames.map(pick).filter((n): n is string => !!n);
  if (names.length) return { title: i.kind === "dm" ? names[0]! : joinNames(names), titleSource: "contact" };
  if (phones.length) return { title: phones[0]!, titleSource: "handle" };
  // A bare email address is a fine last resort; anything else is formatted as a handle.
  const email = i.emailDisplayName?.trim();
  if (email && /^[^@\s]+@[^@\s:]+$/.test(email)) return { title: email, titleSource: "email" };
  const raw = i.handle?.trim() || i.memberDisplayNames.find((n) => n.trim())?.trim() || i.emailDisplayName?.trim();
  return { title: raw ? formatHandle(raw) : "Unknown", titleSource: "handle" };
}

/** One member of an unnamed group as Messages names it: a first name, else a full name, else the
 *  handle (formatted). */
export interface GroupMember { firstName?: string | null; fullName?: string | null; handle: string }

/** A member's full display name (person note / Contacts name, else the formatted handle). */
function memberFull(m: GroupMember): string {
  const c = classify(m.fullName);
  if (c && "name" in c) return c.name;
  if (c && "phone" in c) return c.phone;
  return formatHandle(m.handle);
}

/** A member's short name in a group title: the first name when known, else the full display. */
function memberShort(m: GroupMember): string {
  const c = classify(m.firstName);
  if (c && "name" in c) return c.name;
  const full = classify(m.fullName);
  if (full && "name" in full) return full.name.split(/\s+/)[0] || full.name;
  return memberFull(m);
}

/**
 * The title of an unnamed group, as Apple Messages builds it: one other member → their full name;
 * two → "Ann & Bob"; more → "Ann, Bob & N others" (first names; an unknown number formatted).
 * Callers exclude the owner. Null when there is nobody to name.
 */
export function membersTitle(members: GroupMember[]): string | null {
  if (!members.length) return null;
  if (members.length === 1) return memberFull(members[0]!);
  const [a, b] = [memberShort(members[0]!), memberShort(members[1]!)];
  if (members.length === 2) return `${a} & ${b}`;
  const rest = members.length - 2;
  return `${a}, ${b} & ${rest} other${rest === 1 ? "" : "s"}`;
}

// ---- previews -----------------------------------------------------------------------

function clipQuote(text: string): string {
  const cps = [...text.replace(/\s+/g, " ").trim()];
  return cps.length > 24 ? `${cps.slice(0, 24).join("")}…` : cps.join("");
}

const TAPBACK_VERB: Record<string, string> = {
  "❤️": "loved", "❤": "loved", "👍": "liked", "👎": "disliked", "😂": "laughed at", "‼️": "emphasized", "❓": "questioned",
};

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One-line preview of a thread's latest event. For a reaction-only latest event pass the
 * reacted-to message as `m`, the reactor's first name as `senderFirstName` and the key as
 * `reactionKey`. Group previews from other people are prefixed "Name: "; own messages never are.
 */
export function previewText(m: Message, senderFirstName: string, isGroup: boolean, reactionKey?: string): string {
  const quoted = clipQuote(m.body?.plain ?? m.email?.subject ?? "");
  if (reactionKey) {
    const verb = TAPBACK_VERB[reactionKey];
    const target = quoted ? ` “${quoted}”` : " a message";
    return verb ? `${senderFirstName} ${verb}${target}` : `${senderFirstName} reacted ${reactionKey} to${target}`;
  }
  let text: string;
  const a = m.attachments[0];
  const caption = (m.body?.plain ?? "").replace(/\s+/g, " ").trim();
  if (m.redacted) text = "Message deleted";
  else if (m.system) text = m.system.text;
  else if (a) {
    const label =
      a.kind === "image" ? "📷 Photo"
      : a.kind === "video" ? "🎥 Video"
      : a.kind === "voice" ? `Voice message ${clock(a.durationMs ?? 0)}`
      : a.kind === "audio" ? "🎵 Audio"
      : a.kind === "sticker" ? "Sticker"
      : a.kind === "location" ? "📍 Location"
      : `📎 ${a.name ?? "File"}`;
    text = caption && a.kind !== "voice" && a.kind !== "file" ? `${label} ${caption}` : label;
  } else text = caption || m.email?.subject || "";
  return isGroup && !m.sender.isSelf && senderFirstName ? `${senderFirstName}: ${text}` : text;
}

// ---- avatars ------------------------------------------------------------------------

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** First letters of the first two words (grapheme-safe); "#" for a phone number. */
function monogram(title: string): string {
  const t = title.trim();
  if (/^\+?[\d\s().-]{5,}$/.test(t)) return "#";
  const out: string[] = [];
  for (const word of t.split(/\s+/)) {
    for (const { segment } of SEGMENTER.segment(word)) {
      if (/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(segment)) {
        out.push(segment.toLocaleUpperCase());
        break;
      }
    }
    if (out.length === 2) break;
  }
  return out.join("") || "?";
}

export function resolveAvatar(i: {
  personPhoto?: string | null;
  roomAvatar?: string | null;
  channelAvatar?: string | null;
  dmMemberAvatar?: string | null;
  title: string;
  memberAvatars?: (string | null)[];
}): AvatarRef {
  const mxc = i.personPhoto || i.roomAvatar || i.channelAvatar || i.dmMemberAvatar;
  if (mxc) return { mxc };
  const members = (i.memberAvatars ?? []).filter((a): a is string => !!a).slice(0, 3);
  if (members.length) return { monogram: "", members: members.map((m) => ({ mxc: m })) };
  return { monogram: monogram(i.title) };
}
