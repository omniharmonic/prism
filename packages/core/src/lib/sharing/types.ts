/**
 * Wire types for the sharing / review reads (server: apps/server/src/routes/sharing.ts).
 * Kept dependency-free so the web transport, the fixtures and the UI agree.
 */

/** GET /api/shared-with-me → one top-level page or note shared with the caller. */
export interface SharedItem {
  id: string;
  title: string;
  path: string | null;
  /** "page" = the page and its sub-pages; "note" = this note only. */
  scope: "page" | "note";
  level: string;
  sharedAt: number;
  /** Display name only — never an email. */
  sharedBy: { name: string };
  type?: string;
  prismType?: string;
}
export interface SharedWithMeListing {
  items: SharedItem[];
  tags: Array<{ tag: string; level: string; sharedAt: number }>;
}

/** One comment in a thread, as the index returns it (no actor ids). */
export interface IndexedComment {
  author: string;
  text: string;
  createdAt: number;
  agent: boolean;
  mine: boolean;
}
export interface IndexedThread {
  noteId: string;
  noteTitle: string;
  threadId: string;
  quote: string;
  resolved: boolean;
  lastActivity: number;
  comments: IndexedComment[];
}

/** Who produced a stored state of a page (server `versionWriter`). */
export interface WriterInfo {
  kind: "person" | "guest" | "agent" | "suggestion" | "accepted-suggestion" | "unknown";
  name: string | null;
  self: boolean;
}

/** GET /api/notes/:id/activity */
export interface PageActivity {
  comments: IndexedThread[];
  /** Present only when the caller may manage this page's access (`sharesVisible`). */
  shares: Array<{
    name: string | null;
    avatar: string | null;
    email?: string;
    level: string;
    at: number;
    by: string;
    scope: "page" | "note";
    inheritedFrom?: { id: string; title: string };
  }>;
  sharesVisible: boolean;
  lastEditor: WriterInfo;
  createdAt: string | null;
  updatedAt: string | null;
  /** Signed-in viewers: display names of this page's writer stamps, and the viewer's own stamp id. */
  writers?: Record<string, string>;
  me?: string;
}

/** GET /api/notes/:id/access-preview?parent= */
export interface AccessPreview {
  willChange: boolean;
  losing?: number;
  gaining?: number;
  /** `email` only for administrators. */
  changes?: Array<{ email: string | null; name: string | null; avatar: string | null; from: string | null; to: string | null }>;
}
