import { invoke } from "@tauri-apps/api/core";
import type {
  MatrixRoom,
  MessageBatch,
  MatrixMember,
  GmailThreadList,
  GmailThread,
} from "./types";

export const matrixApi = {
  getRooms: () =>
    invoke<MatrixRoom[]>("matrix_get_rooms"),

  getMessages: (roomId: string, limit?: number, from?: string) =>
    invoke<MessageBatch>("matrix_get_messages", { roomId, limit, from }),

  sendMessage: (roomId: string, body: string, msgType?: string) =>
    invoke<string>("matrix_send_message", { roomId, body, msgType }),

  getRoomMembers: (roomId: string) =>
    invoke<MatrixMember[]>("matrix_get_room_members", { roomId }),

  markRead: (roomId: string, eventId: string) =>
    invoke<void>("matrix_mark_read", { roomId, eventId }),

  searchMessages: (query: string) =>
    invoke<unknown[]>("matrix_search_messages", { query }),
};

export const gmailApi = {
  listThreads: (account: string, query?: string, maxResults?: number, pageToken?: string) =>
    invoke<GmailThreadList>("gmail_list_threads", { account, query, maxResults, pageToken }),

  getThread: (account: string, threadId: string) =>
    invoke<GmailThread>("gmail_get_thread", { account, threadId }),

  send: (account: string, to: string[], subject: string, body: string, cc?: string[], inReplyTo?: string) =>
    invoke<string>("gmail_send", { account, to, cc, subject, body, inReplyTo }),

  archive: (account: string, threadId: string) =>
    invoke<void>("gmail_archive", { account, threadId }),

  label: (account: string, threadId: string, addLabels: string[], removeLabels: string[]) =>
    invoke<void>("gmail_label", { account, threadId, addLabels, removeLabels }),
};
