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

// ── Federation (peer-to-peer vault sync) ──────────────────────────────────────
/** This node's federation identity. The fingerprint is the human-verifiable
 *  hash two operators read aloud to confirm they paired the right node. */
export interface NodeIdentity {
  publicKey: string;
  fingerprint: string;
}
/** A paired peer hub. */
export interface PeerInfo {
  pubkey: string;
  email: string | null;
  label: string | null;
  fingerprint: string;
  pairedAt: number | null;
  createdAt: number;
}
/** A shared space = a slice of the vault synced with peers. */
export interface SpaceInfo {
  id: string;
  title: string | null;
  includeTags: string[];
  excludeTags: string[];
  pathPrefix: string | null;
  createdAt: number;
}
/** A one-time pairing code to hand to a peer, plus our identity for them to verify. */
export interface PairingCode {
  code: string;
  expiresInDays: number;
  serverPublicKey: string;
  fingerprint: string;
}
/** An inbound mirror request: a peer wants this node to mirror a shared slice.
 *  Owner-reviewed — a peer never writes to the vault without an accept. */
export interface MirrorRequestInfo {
  id: string;
  peer: string;
  fingerprint: string;
  spaceId: string;
  spaceTitle: string | null;
  notes: Array<{ spaceNoteKey: string; kind: string; title?: string }>;
  status: "pending" | "accepted" | "rejected";
  createdAt: number;
  resolvedAt: number | null;
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

  /** Federation — peer-to-peer vault sync. All optional; absent → the Federate
   *  surface is hidden (desktop / capability-viewer safe). `federationEnabled`
   *  reports whether the node has the FEDERATION_ENABLED flag on. */
  federationEnabled?(): Promise<boolean>;
  getNodeIdentity?(): Promise<NodeIdentity>;
  /** Mint a one-time code to hand a peer (they redeem it against THIS node). */
  createPairingCode?(label?: string): Promise<PairingCode>;
  /** Redeem a peer's code: registers THIS node as their peer (and exchanges
   *  identity). `peerServerUrl` is the peer's Prism origin (e.g. https://…). */
  redeemPairingCode?(args: { code: string; peerServerUrl: string; label?: string }): Promise<{ ok: boolean; fingerprint: string }>;
  listPeers?(): Promise<PeerInfo[]>;
  setPeerUrl?(pubkey: string, collabUrl: string): Promise<void>;
  removePeer?(pubkey: string): Promise<void>;

  listSpaces?(): Promise<SpaceInfo[]>;
  createSpace?(args: { title?: string; includeTags?: string[]; excludeTags?: string[]; pathPrefix?: string }): Promise<SpaceInfo>;
  deleteSpace?(spaceId: string): Promise<void>;
  /** Add a note to a space → mints its space_note_key + pins the collab kind. */
  addNoteToSpace?(spaceId: string, noteId: string): Promise<{ space_note_key: string; kind: string }>;
  grantSpacePeer?(spaceId: string, pubkey: string, level: ShareLevel): Promise<void>;
  revokeSpacePeer?(spaceId: string, pubkey: string): Promise<void>;

  /** Inbound mirror requests this node has received (owner-reviewed). */
  listMirrorRequests?(status?: "pending" | "accepted" | "rejected"): Promise<MirrorRequestInfo[]>;
  acceptMirror?(id: string, level?: ShareLevel): Promise<void>;
  rejectMirror?(id: string): Promise<void>;
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
