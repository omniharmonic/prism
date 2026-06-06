// Matrix/messaging types matching the Rust models

export interface MatrixRoom {
  room_id: string;
  name: string;
  platform: string;
  is_dm: boolean;
  unread_count: number;
  last_message: LastMessage | null;
  avatar_url: string | null;
  member_count: number;
}

export interface LastMessage {
  sender: string;
  body: string;
  timestamp: number;
  event_id: string;
}

export interface MatrixMessage {
  event_id: string;
  sender: string;
  sender_name: string | null;
  body: string;
  msg_type: string;
  timestamp: number;
  is_outgoing: boolean;
  media_url: string | null;
  media_info: Record<string, unknown> | null;
}

export interface MessageBatch {
  messages: MatrixMessage[];
  start: string | null;
  end: string | null;
  has_more: boolean;
}

export interface MatrixMember {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
}

// Gmail types
export interface GmailThread {
  id: string;
  subject: string;
  snippet: string;
  messages: GmailMessage[];
  unread: boolean;
  labels: string[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[] | null;
  subject: string;
  body: string;
  date: string;
  isUnread: boolean;
  inReplyTo: string | null;
}

export interface GmailThreadList {
  threads: GmailThreadSummary[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

export interface GmailThreadSummary {
  id: string;
  subject: string;
  snippet: string;
  from: string;
  fromName: string | null;
  date: string;
  unread: boolean;
  messageCount: number;
  labels: string[];
}
