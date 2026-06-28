import { createContext, useContext, type ReactNode } from "react";

export type ShareLevel = "view" | "comment" | "suggest" | "edit";

export interface ShareLink {
  id: string;
  level: ShareLevel;
  url: string;
  expiresAt: number;
  label?: string | null;
}
export interface SharePerson {
  email: string;
  level: ShareLevel;
}
export interface TagAccess {
  tag: string;
  email?: string;
  subjectType: string;
  level: ShareLevel;
}
export interface NoteAccess {
  note: { id: string; tags: string[]; title: string };
  people: SharePerson[];
  links: ShareLink[];
  tagAccess: TagAccess[];
}
/** Result of granting a person: when they had no account yet, an invite is
 *  issued and its accept URL is returned so the owner can hand it over directly
 *  (email may be unconfigured/unpaid). Already-registered people → invited:false. */
export interface SetPersonResult {
  invited: boolean;
  inviteUrl?: string;
}
/** A published tag: a public, read-only site ("Wiki") covering every note that
 *  carries the tag — dynamic, so future notes with the tag are included too. */
export interface PublicationInfo {
  slug: string;
  tag: string;
  template: string;
  title: string | null;
  passwordRequired: boolean;
  url: string;
  createdAt: number;
}

/**
 * Seam for sharing. The web shell implements the full ACL surface against the
 * Prism Server gateway (/acl); the desktop shell may provide only the legacy
 * quick-link (or nothing). The rich methods are optional so the share dialog
 * degrades gracefully when a shell doesn't support them. When no provider is
 * supplied at all, share UI is hidden.
 */
export interface CollabSharing {
  /** Legacy one-click "anyone can edit" link. Kept for shells without the full ACL. */
  createShareLink(noteId: string): Promise<string>;

  /** Full per-note access (people + links + tag-grants). Presence enables the rich dialog. */
  getAccess?(noteId: string): Promise<NoteAccess>;
  setPerson?(noteId: string, email: string, level: ShareLevel): Promise<SetPersonResult>;
  removePerson?(noteId: string, email: string): Promise<void>;
  createLink?(noteId: string, level: ShareLevel, expiresInDays?: number): Promise<ShareLink>;
  revokeLink?(noteId: string, linkId: string): Promise<void>;
  listUsers?(): Promise<string[]>;

  /** Publishing — turn a tag into a public, read-only site. Optional so shells
   *  without it (desktop no-op, capability viewers) simply never show the tab. */
  listPublications?(): Promise<PublicationInfo[]>;
  publishTag?(
    tag: string,
    opts?: { template?: string; title?: string; password?: string },
  ): Promise<{ slug: string; url: string; count: number; passwordRequired: boolean }>;
  setPublishPassword?(tag: string, password: string | null): Promise<void>;
  unpublishTag?(tag: string): Promise<void>;
}

const CollabSharingContext = createContext<CollabSharing | null>(null);

export function CollabSharingProvider({
  value,
  children,
}: {
  value: CollabSharing | null;
  children: ReactNode;
}) {
  return <CollabSharingContext.Provider value={value}>{children}</CollabSharingContext.Provider>;
}

/** Returns the host-provided sharing impl, or null when sharing isn't available. */
export function useCollabSharing(): CollabSharing | null {
  return useContext(CollabSharingContext);
}
