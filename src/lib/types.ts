// Core content types that determine which renderer to use
export type ContentType =
  | "document"
  | "note"
  | "presentation"
  | "code"
  | "email"
  | "message-thread"
  | "task-board"
  | "task"
  | "event"
  | "project"
  | "spreadsheet"
  | "website"
  | "canvas"
  | "briefing"
  | "dashboard";

// Parachute Note — the canonical data model
export interface Note {
  id: string;
  content: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
  tags: string[] | null;
}

export interface NoteIndex {
  id: string;
  path: string | null;
  createdAt: string;
  updatedAt: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  byteSize: number | null;
  preview: string | null;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface VaultStats {
  noteCount: number;
  tagCount: number;
  linkCount: number;
}

export interface Link {
  sourceId: string;
  targetId: string;
  relationship: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// Sync configuration per document
export interface SyncConfig {
  adapter: "google-docs" | "google-slides" | "google-sheets" | "notion" | "gmail" | "github" | "vercel";
  remoteId: string;
  lastSynced: string;
  direction: "push" | "pull" | "bidirectional";
  conflictStrategy: "local-wins" | "remote-wins" | "ask";
  autoSync: boolean;
}

// Prism metadata extension on Parachute notes
export interface PrismMetadata {
  type: ContentType;
  project?: string;
  sync?: SyncConfig[];
}

// Type-specific metadata
export interface DocumentMeta extends PrismMetadata {
  type: "document" | "note" | "briefing";
  template?: string;
  status?: "draft" | "review" | "final";
}

export interface PresentationMeta extends PrismMetadata {
  type: "presentation";
  aspectRatio: "16:9" | "4:3";
  theme: string;
  slideCount?: number;
}

export interface CodeMeta extends PrismMetadata {
  type: "code";
  language?: string;
  repoUrl?: string;
}

export interface EmailMeta extends PrismMetadata {
  type: "email";
  from: string;
  to: string[];
  subject: string;
  account: string;
  gmailId?: string;
  threadId?: string;
  status: "draft" | "sent" | "received";
}

export interface MessageThreadMeta extends PrismMetadata {
  type: "message-thread";
  platform: string;
  matrixRoomId: string;
  participants: string[];
  isDm: boolean;
  unreadCount: number;
}

export interface TaskMeta extends PrismMetadata {
  type: "task";
  status: string;
  priority: string;
  deadline?: string;
  notionPageId?: string;
}

export interface EventMeta extends PrismMetadata {
  type: "event";
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  googleEventId?: string;
  meetUrl?: string;
}

export interface SpreadsheetMeta extends PrismMetadata {
  type: "spreadsheet";
  columns?: string[];
  rowCount?: number;
}

export interface WebsiteMeta extends PrismMetadata {
  type: "website";
  framework?: string;
  deployTarget?: string;
  liveUrl?: string;
}

export interface DashboardWidget {
  id: string;
  type: "task-list" | "note-list" | "stat-card" | "calendar";
  title?: string;
  filter?: Record<string, unknown>;
  span?: number; // grid column span (1 or 2)
}

export interface DashboardMeta extends PrismMetadata {
  type: "dashboard";
  layout?: {
    columns?: number;
    widgets: DashboardWidget[];
  };
}

// API parameter types
export interface NoteFilters {
  tag?: string;
  path?: string;
  limit?: number;
  offset?: number;
}

export interface CreateNoteParams {
  content: string;
  path?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface UpdateNoteParams {
  content?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

// Tab state for the UI
export interface TabState {
  id: string;
  noteId: string;
  title: string;
  type: ContentType;
  isDirty: boolean;
}

// Service status
export interface ServiceStatus {
  parachute: boolean;
  matrix: boolean;
}

// Default content for new notes by type
export const CONTENT_DEFAULTS: Record<ContentType, { content: string; metadata: Record<string, unknown> }> = {
  document: { content: "", metadata: { type: "document", status: "draft" } },
  note: { content: "", metadata: { type: "note" } },
  presentation: { content: "---\n\n# Title Slide\n\n---\n\n# Slide 2\n\n---", metadata: { type: "presentation", aspectRatio: "16:9", theme: "dark" } },
  code: { content: "", metadata: { type: "code" } },
  email: { content: "", metadata: { type: "email", status: "draft", from: "", to: [], subject: "" } },
  "message-thread": { content: "", metadata: { type: "message-thread" } },
  "task-board": { content: "", metadata: { type: "task-board" } },
  task: { content: "", metadata: { type: "task", status: "inbox", priority: "normal" } },
  event: { content: "", metadata: { type: "event", title: "", start: "", end: "" } },
  project: { content: "", metadata: { type: "project" } },
  spreadsheet: { content: "", metadata: { type: "spreadsheet" } },
  website: { content: "<!DOCTYPE html>\n<html>\n<head>\n  <title>Untitled</title>\n</head>\n<body>\n  \n</body>\n</html>", metadata: { type: "website" } },
  canvas: { content: "", metadata: { type: "canvas" } },
  briefing: { content: "", metadata: { type: "briefing" } },
  dashboard: { content: "", metadata: { type: "dashboard", layout: { columns: 2, widgets: [] } } },
};
