/**
 * The Comms read API as Prism's Messages screens use it (`/api/comms/*`, apps/server/src/comms/types.ts
 * is the source of truth; ARCHITECTURE §3.3 in the Comms repo). Read-only here: sending is the
 * comms send gate (device token only) and lands in a later stage.
 */

export type CommsNetwork =
  | "whatsapp" | "telegram" | "discord" | "messenger" | "x" | "imessage" | "sms" | "email" | "matrix"
  | "signal" | "slack" | "instagram" | "linkedin";

export type CommsFolder = "inbox" | "unknown" | "low" | "spam" | "archived";

/** Same nine statuses as lib/messages/triage.ts `ThreadStatus` (the server mirrors that model). */
export type CommsStatus =
  | "urgent" | "action-required" | "unclassified" | "triage-failed" | "informational" | "low" | "social" | "triaged" | "handled";

/** Routes rewrite every mxc to an opaque media token; a group shows a monogram over member avatars. */
export type CommsAvatar = { token: string } | { monogram: string; members?: CommsAvatar[] };

export interface CommsCapabilities {
  react?: boolean; edit?: boolean; unsend?: boolean; reply?: boolean; typing?: boolean; receipts?: boolean;
  attachments?: boolean; send?: boolean; encrypted?: boolean;
}

export interface CommsChannel { network: CommsNetwork; accountLabel: string | null; capabilities?: CommsCapabilities }

export interface CommsThread {
  id: string;
  title: string;
  titleSource: "person" | "room" | "contact" | "email" | "handle";
  avatar: CommsAvatar | null;
  kind: "dm" | "group";
  networks: CommsNetwork[];
  personId?: string;
  /** The vault `message-thread` note this conversation is projected from (absent without one). */
  noteId?: string;
  lastMessage?: { text: string; senderName: string | null; isSelf: boolean; sentAt: string };
  lastActivityAt: string;
  unread: { count: number; trusted: boolean };
  folder: CommsFolder;
  status: CommsStatus;
  pinned: boolean;
  muted: boolean;
  channels: CommsChannel[];
}

export type CommsSpan =
  | { t: "text"; v: string }
  | { t: "bold" | "italic" | "strike" | "code"; c: CommsSpan[] }
  | { t: "pre"; v: string }
  | { t: "link"; href: string; c: CommsSpan[] }
  | { t: "mention"; id: string; name: string }
  | { t: "quote"; c: CommsSpan[] }
  | { t: "li"; c: CommsSpan[] }
  | { t: "br" };

export interface CommsRichText { spans: CommsSpan[]; plain: string; jumboEmoji: boolean; truncated: boolean }

export interface CommsAttachment {
  kind: "image" | "video" | "audio" | "voice" | "file" | "sticker" | "location";
  mediaToken?: string;
  thumbToken?: string;
  mime?: string;
  size?: number;
  w?: number;
  h?: number;
  durationMs?: number;
  name?: string;
  geo?: string;
}

export interface CommsLinkPreview { url: string; title?: string; description?: string; siteName?: string; imageToken?: string }

export interface CommsReaction { key: string; count: number; mine: boolean; senders: { id: string; name: string }[] }

export interface CommsMessage {
  id: string;
  threadId: string;
  channel: CommsChannel;
  source: { network: CommsNetwork; eventId: string; ref: string };
  sender: { id: string; name: string; avatar: CommsAvatar | null; isSelf: boolean; isOmni: boolean; personId?: string };
  sentAt: string;
  editedAt?: string;
  body: CommsRichText | null;
  attachments: CommsAttachment[];
  linkPreviews: CommsLinkPreview[];
  replyTo?: { messageId: string; snippet: string; senderName: string };
  reactions: CommsReaction[];
  delivery: "pending" | "sent" | "delivered" | "read" | "failed" | null;
  redacted: boolean;
  system?: { kind: string; text: string };
}

export interface CommsContact {
  phones: { label?: string; value: string }[];
  emails: { label?: string; value: string }[];
  handles: { network: CommsNetwork; value: string; kind: "phone" | "username" | "userId" }[];
}

export interface CommsThreadDetail {
  thread: CommsThread;
  capabilities: CommsCapabilities | null;
  members: { id: string; name: string; avatar: CommsAvatar | null; personId?: string }[];
  contact?: CommsContact;
}

export interface CommsPerson extends CommsContact {
  id: string;
  name: string;
  avatar?: CommsAvatar;
  noteId: string;
  threads: CommsThread[];
}

export interface CommsThreadQuery {
  folder?: CommsFolder;
  statuses?: CommsStatus[];
  /** Urgent + action required (the server merges it into `statuses`). */
  attention?: boolean;
  networks?: CommsNetwork[];
  unread?: boolean;
  person?: string;
  note?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface CommsThreadPage { threads: CommsThread[]; next: string | null }
export interface CommsMessagePage { messages: CommsMessage[]; before: string | null; hasMore: boolean }
export interface CommsStatusCounts { folder: CommsFolder; counts: Partial<Record<CommsStatus, number>>; attention: number }

/**
 * The shell's Comms reader (optional on `VaultClient`). Every call may reject with an error whose
 * `status` is the HTTP status; 403/404/409 on a list read mean "Comms is not for this viewer here"
 * (flag off, not the owner, another vault) and the screens fall back to the vault notes.
 */
export interface CommsReadClient {
  listThreads(query: CommsThreadQuery): Promise<CommsThreadPage>;
  statusCounts(folder: CommsFolder): Promise<CommsStatusCounts>;
  getThread(id: string): Promise<CommsThreadDetail>;
  getMessages(id: string, before?: string): Promise<CommsMessagePage>;
  getPerson(id: string): Promise<CommsPerson>;
  /** A URL an <img> can load for a media token (the native shell re-points it to a bearer-fetched blob). */
  mediaUrl(token: string): string;
  /**
   * Native shell only: fetch one media token with the device credential and return a blob: URL (the
   * caller revokes it). When present, audio/video are NOT given a URL up front — they load on the
   * person's press, so a transcript never downloads every clip (`preload="none"` cannot work on a
   * blob the shell would have to fetch whole).
   */
  loadMedia?(token: string): Promise<string>;
}
