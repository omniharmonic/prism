// Comms wire model (ARCHITECTURE §3.3). Rendered by the Comms Swift app and Prism's web UI.
// Shapes ARCHITECTURE leaves untyped (ChannelRef, MessagePreview, LinkPreview, email,
// replyTo) are filled in here; keep the Swift mirrors (Task 16) in step.
import type { Capabilities, Network } from "./room-meta.js";
import type { RichText } from "./richtext.js";

export type { Network, Capabilities, RichText };

/** The normalizer emits {mxc}; routes rewrite it to {token} before responding (Task 9). */
export type AvatarRef = { mxc: string } | { token: string } | { monogram: string; members?: AvatarRef[] };

export interface Attachment {
  kind: "image" | "video" | "audio" | "voice" | "file" | "sticker" | "location";
  mxc?: string;
  mime?: string;
  size?: number;
  w?: number;
  h?: number;
  durationMs?: number;
  name?: string;
  geo?: string;
}

/** A send target: one network account a thread can be answered through. */
export interface ChannelRef {
  network: Network;
  /** Which of the owner's accounts on that network ("Work WhatsApp"); null = the only one. */
  accountLabel: string | null;
  capabilities?: Capabilities;
}

/** Plain-text preview of a thread's latest message; tapback/attachment phrasing pre-rendered. */
export interface MessagePreview {
  text: string;
  /** Email only: the message's subject (clients show it semibold above the snippet, PRD §5.8). */
  subject?: string;
  senderName: string | null;
  isSelf: boolean;
  sentAt: string;
}

/** The normalizer emits imageMxc; routes rewrite it to imageToken (Task 9). */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  imageMxc?: string;
  imageToken?: string;
}

export interface Reaction {
  key: string;
  count: number;
  mine: boolean;
  /** eventId = the reaction event (lets an un-react redaction find it; Phase 2 un-react sends it). */
  senders: { id: string; name: string; eventId?: string }[];
}

export type Thread = {
  id: string; // stable, opaque
  title: string;
  titleSource: "person" | "room" | "contact" | "members" | "email" | "handle";
  avatar: AvatarRef | null; // media token or {monogram, members[]}
  kind: "dm" | "group";
  networks: Network[]; // >1 only for merged person threads
  personId?: string;
  /** The vault `message-thread` note this conversation is projected from (absent for sources without one, e.g. BlueBubbles). */
  noteId?: string;
  lastMessage?: MessagePreview; // plain text, tapback/attachment phrasing pre-rendered
  lastActivityAt: string; // ISO UTC
  unread: { count: number; trusted: boolean };
  folder: "inbox" | "unknown" | "low" | "spam" | "archived";
  urgency: "urgent" | "needs-reply" | "fyi" | "low" | null; // from triage tags + owed-reply evidence
  /** Triage status from the thread note's tags (comms/triage.ts; same model as packages/core triage.ts). */
  status: import("./triage").CommsStatus;
  pinned: boolean;
  /** Position in the owner's pinned grid (0 = first); only on pinned threads Comms pinned (Task 8). */
  pinOrder?: number;
  muted: boolean;
  channels: ChannelRef[]; // send targets with network, account label, capabilities
  /** COMMS_TIDY_ENABLED: a DM whose counterpart is linked to no person note and not ignored. */
  needsTidy?: true;
  /** COMMS_FOLDERS_ENABLED: the owner folders holding this thread (comms/folders.ts), sorted. */
  folderIds?: string[];
  /** A Telegram forum (comms/forums.ts): one thread whose topics are sub-conversations.
   *  GET /threads/:id lists them (`topics`). */
  forum?: { topicCount: number };
};

/** A forum topic as a message names it (comms/forums.ts): `id` = the topic's opaque id. */
export interface TopicRef { id: string; title: string }

export type Message = {
  id: string;
  threadId: string;
  channel: ChannelRef;
  /** ref = the source-native message reference (Matrix: the event id). */
  source: { network: Network; eventId: string; ref: string };
  sender: { id: string; name: string; avatar: AvatarRef | null; isSelf: boolean; isOmni: boolean; personId?: string };
  sentAt: string;
  editedAt?: string;
  body: RichText | null; // portable spans: text, bold, italic, strike, code, pre, link, mention, quote, listItem
  email?: { subject: string; from: string; to: string[]; cc: string[]; quotedCollapsed: boolean; hasHtml: boolean };
  attachments: Attachment[];
  linkPreviews: LinkPreview[];
  /** senderSelf / senderOmni: server-only (the replied-to sender as normalized), stripped by
   *  messageOut, which names the sender "You" (the owner) or "Omni" (an agent id). */
  replyTo?: { messageId: string; snippet: string; senderName: string; senderSelf?: boolean; senderOmni?: boolean };
  threadRoot?: string;
  replyCount?: number;
  reactions: Reaction[];
  delivery: "pending" | "sent" | "delivered" | "read" | "failed" | null;
  deliveryError?: string;
  /** When the other side read it (delivery "read"): the newest reader's time for a DM, or the
   *  source's own read date (iMessage dateRead). Absent when the network gives no time. */
  readAt?: string;
  /** Group read state (Task 8): who has read this message, newest receipt per person. Only on
   *  the owner's messages, only when someone has. Never the owner, an agent or a bridge bot. */
  readBy?: { id: string; name: string; readAt: string }[];
  redacted: boolean;
  /** A Telegram forum message: the topic it was posted in (comms/forums.ts). */
  topic?: TopicRef;
  system?: { kind: string; text: string }; // joins, renames, bridge notices
  /** Wire only: the clientId Comms sent this message under (POST /threads/:id/messages|attachments). */
  clientId?: string;
  /** Server only (never on the wire — messageOut strips it): the Matrix `unsigned.transaction_id`
   *  of a Comms send's echo, mapped to its clientId even before the send answered. */
  sendTxn?: string;
};
