import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ShareLevel = "view" | "comment" | "suggest" | "edit";

/** Re-render signal for the active-vault soft switch. Bumps whenever the shell
 *  fires `prism:vault-changed`, so vault-aware UI (the nav switcher) re-reads the
 *  active vault without a full page reload. */
export function useVaultChangeSignal(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const h = () => setN((x) => x + 1);
    window.addEventListener("prism:vault-changed", h);
    return () => window.removeEventListener("prism:vault-changed", h);
  }, []);
  return n;
}

export interface ShareLink {
  id: string;
  level: ShareLevel;
  url: string;
  expiresAt: number;
  label?: string | null;
}

/** Workspace role (Phase 2 multi-tenant). Ordered weakest→strongest:
 *  guest < member < admin < owner. Distinct from the per-note ShareLevel. */
export type WorkspaceRole = "guest" | "member" | "admin" | "owner";
export interface WorkspaceMember {
  email: string;
  name: string | null;
  role: WorkspaceRole;
  joinedAt: number;
}
/** One access grant in the active vault, for the Members panel's audit view. */
export interface WorkspaceGrant {
  id: string;
  subjectType: string; // 'user' | 'link' | 'anyone' | ...
  subject: string;
  subjectName: string | null;
  resourceType: string; // 'note' | 'tag' | 'vault' | ...
  resource: string;
  level: ShareLevel;
  grantedBy: string | null;
  grantedAt: number;
}
/** The signed-in viewer, scoped to the active vault. `role` is what THIS
 *  workspace grants them; `isServerOwner` is the global operator flag (owner of
 *  every vault on the box). Backs role-gating of the Network management panels. */
export interface ViewerIdentity {
  email: string;
  role: WorkspaceRole;
  isServerOwner: boolean;
  vaultId: string;
}

// ── Workspace = the whole server: a permission boundary grouping many vaults ──
/** One vault within the workspace (token never included). */
export interface WorkspaceVaultRef {
  id: string;
  label: string;
  vault: string;
}
/** A person's access across the workspace: per-vault management `role` and/or
 *  whole-vault access `level`. A vault absent from `access` = no access there. */
export interface WorkspacePerson {
  email: string;
  name: string | null;
  isServerOwner: boolean;
  access: Record<string, { role?: WorkspaceRole; level?: ShareLevel }>;
}
/** The whole workspace: the vaults on this server + everyone's access matrix.
 *  Server-owner only (spans all vaults). */
export interface WorkspaceOverview {
  vaults: WorkspaceVaultRef[];
  people: WorkspacePerson[];
}

// ── Workspace entities (one server, many workspaces) ──
/** A workspace = a subdomain + one-or-more vaults + members. Distinct from the
 *  WorkspaceOverview people-matrix above: this is the workspace ENTITY the owner
 *  creates/configures. Each vault belongs to exactly one workspace. */
export interface WorkspaceEntity {
  id: string;
  name: string;
  hostname: string | null;
  isDefault: boolean;
  vaults: WorkspaceVaultRef[];
}

/** Cloudflare tunnel status (the pm2 `prism-tunnel` process fronting this box). */
export interface TunnelStatus {
  managed: boolean;
  name?: string;
  status?: string;
  restarts?: number;
  uptime?: number;
  hostname?: string | null;
  detail?: string;
}
/** Server settings + status snapshot (server-owner only). Secret VALUES are
 *  never included — only whether each is configured. */
export interface ServerInfo {
  appOrigin: string;
  port: number;
  ownerEmail: string;
  parachuteUrl: string;
  parachuteVault: string;
  vaultCount: number;
  federationEnabled: boolean;
  trustLocal: boolean;
  secretsAvailable: boolean;
  emailConfigured: boolean;
  magicFrom: string;
  integrations: Record<string, boolean>;
  tunnel: TunnelStatus;
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
  note: { id: string; tags: string[]; title: string; visibility?: "private" | "workspace"; creator?: string | null };
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
/** Per-publication presentation overrides for the public site. All optional;
 *  absent fields fall back to the default theme. `logoUrl` must be an http(s)
 *  URL and colors are applied as CSS values (validated again at render — these
 *  are owner-set but shown on a PUBLIC page, so never injected as raw HTML). */
export interface PublicationTheme {
  /** http(s) URL of a logo shown in the public site header. */
  logoUrl?: string;
  /** Accent color (links, active states) — any valid CSS color. */
  accent?: string;
  /** Page background color. */
  bg?: string;
  /** Body text color. */
  text?: string;
  /** Body font family. */
  font?: "sans" | "serif" | "mono";
}

/** A published tag: a public, read-only site ("Wiki") covering every note that
 *  carries the tag — dynamic, so future notes with the tag are included too. */
export interface PublicationInfo {
  slug: string;
  /** What slice is published: a tag, or a path/directory prefix. */
  kind: "tag" | "path";
  /** The published tag (when kind === "tag"). Empty for path publications. */
  tag: string;
  /** The published path prefix (when kind === "path"). */
  pathPrefix?: string | null;
  template: string;
  title: string | null;
  passwordRequired: boolean;
  url: string;
  createdAt: number;
  /** The landing note id (null → derive at read time). */
  homeNoteId?: string | null;
  /** Note ids hand-excluded from the public set even though they match the slice. */
  excludeNoteIds?: string[];
  /** Presentation overrides for the public site (logo/colors/font); null/absent
   *  → the default theme. */
  theme?: PublicationTheme | null;
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
/** One inbound edit a federated peer made to a shared note (audit, 4.3). */
export interface PeerEditInfo {
  spaceNoteKey: string;
  localId: string;
  peer: string;
  peerFingerprint: string;
  editedAt: number;
}
/** A shared space = a slice of the vault synced with peers. */
/** A peer granted access to a space, with its level + the vault's last-synced clock. */
export interface SpacePeerGrant {
  pubkey: string;
  fingerprint: string;
  label: string | null;
  level: ShareLevel;
}
export interface SpaceInfo {
  id: string;
  title: string | null;
  includeTags: string[];
  excludeTags: string[];
  pathPrefix: string | null;
  createdAt: number;
  /** Peers this space is shared with (real grants, server-authoritative). */
  peers: SpacePeerGrant[];
  /** How many notes are mapped into the space (federated_notes count). */
  noteCount: number;
  /** Newest peer_synced_at across the space's notes, or null if never synced. */
  lastSyncedAt: number | null;
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

/** One configured vault the owner can switch between (multi-vault Phase 1).
 *  Tokens never reach the client — only the id/label/vault name + which is active. */
export interface VaultSummary {
  id: string;
  label: string;
  vault: string;
  active: boolean;
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
  /** Private-to-creator (Phase 2.5): mark a note private (only the creator + people
   *  with an explicit per-note grant can see it) or back to workspace-visible. */
  setNoteVisibility?(noteId: string, isPrivate: boolean): Promise<void>;
  createLink?(noteId: string, level: ShareLevel, expiresInDays?: number): Promise<ShareLink>;
  revokeLink?(noteId: string, linkId: string): Promise<void>;
  listUsers?(): Promise<string[]>;

  /** Folder/tag sharing (Phase 2): grant a person access to EVERYTHING carrying a
   *  tag (≈ "share this folder with this email"). Backs the Share dialog's
   *  folder-share affordance + the Members panel. */
  setTagPerson?(tag: string, email: string, level: ShareLevel): Promise<SetPersonResult>;
  removeTagPerson?(tag: string, email: string): Promise<void>;
  /** Who currently has access to a tag/folder (people + anyone-grants). Backs the
   *  Share dialog's folder-share panel. */
  getTagAccess?(tag: string): Promise<TagAccess[]>;

  /** Grants audit (Phase 2.2): every access grant in the active vault, each
   *  revocable by id. Admin-only server-side; absent → the audit view hides. */
  listGrants?(): Promise<WorkspaceGrant[]>;
  revokeGrant?(id: string): Promise<void>;

  /** The signed-in viewer's identity + role FOR THE ACTIVE VAULT. Role is
   *  per-vault (a member of workspace A may be a guest in B), so this is re-read
   *  on every vault switch. The management surfaces (Members/Publish/Federate)
   *  gate on `role` being admin+ so a member never fires admin-only /acl/* calls
   *  and sees 403 noise. Absent (desktop shell) → treat the local operator as owner. */
  getViewer?(): Promise<ViewerIdentity>;

  /** Workspace management (server-owner only): the WHOLE server as a permission
   *  boundary grouping every vault. `getWorkspace` returns the people × vaults
   *  access matrix; the setters add/revoke a person's whole-vault ACCESS (level)
   *  or management ROLE in a CHOSEN vault — the "add someone to the workspace →
   *  access to a chosen vault" flow. Absent → the Workspace surface hides. */
  getWorkspace?(): Promise<WorkspaceOverview>;
  setWorkspaceAccess?(email: string, vaultId: string, level: ShareLevel): Promise<SetPersonResult>;
  removeWorkspaceAccess?(vaultId: string, email: string): Promise<void>;
  setWorkspaceMemberRole?(email: string, vaultId: string, role: WorkspaceRole): Promise<SetPersonResult>;
  removeWorkspaceMemberRole?(vaultId: string, email: string): Promise<void>;

  /** Server settings + Cloudflare tunnel management (server-owner only). A config
   *  snapshot (no secret values), tunnel status + start/stop/restart, and a narrow
   *  editable-.env allowlist (APP_ORIGIN/MAGIC_FROM/RESEND_API_KEY — restart-required).
   *  Absent → the Server surface hides (desktop / non-server-owner). */
  getServerInfo?(): Promise<ServerInfo>;
  controlTunnel?(action: "start" | "stop" | "restart"): Promise<{ tunnel: TunnelStatus }>;
  setServerConfig?(key: string, value: string): Promise<{ restartRequired: boolean }>;

  /** Workspace entities (server-owner): the "one server, many workspaces" model.
   *  Create/configure a workspace (name + subdomain), and assign vaults to it.
   *  Absent → the Workspaces surface hides. */
  listWorkspaceEntities?(): Promise<WorkspaceEntity[]>;
  createWorkspaceEntity?(name: string, hostname?: string): Promise<WorkspaceEntity>;
  updateWorkspaceEntity?(id: string, patch: { name?: string; hostname?: string | null }): Promise<WorkspaceEntity>;
  deleteWorkspaceEntity?(id: string): Promise<void>;
  assignVaultToWorkspaceEntity?(workspaceId: string, vaultId: string): Promise<void>;

  /** Workspace members & roles (Phase 2 — the team workspace). A member belongs
   *  to the active vault at a role; `setVaultPerson` grants broad note access
   *  (a whole-workspace grant) without management rights. Absent → the Members
   *  panel hides (desktop / non-owner safe). */
  listMembers?(): Promise<WorkspaceMember[]>;
  setMember?(email: string, role: WorkspaceRole): Promise<SetPersonResult>;
  removeMember?(email: string): Promise<void>;
  setVaultPerson?(email: string, level: ShareLevel): Promise<SetPersonResult>;
  removeVaultPerson?(email: string): Promise<void>;

  /** Publishing — turn a tag into a public, read-only site. Optional so shells
   *  without it (desktop no-op, capability viewers) simply never show the tab. */
  listPublications?(): Promise<PublicationInfo[]>;
  publishTag?(
    tag: string,
    opts?: { template?: string; title?: string; password?: string },
  ): Promise<{ slug: string; url: string; count: number; passwordRequired: boolean }>;
  /** Publish a path/directory prefix as a public read-only site (the slice is the
   *  notes under that prefix; membership is path-evaluated server-side). */
  publishPath?(
    pathPrefix: string,
    opts?: { template?: string; title?: string; password?: string },
  ): Promise<{ slug: string; pathPrefix: string; url: string; count: number; passwordRequired: boolean }>;
  setPublishPassword?(tag: string, password: string | null): Promise<void>;
  /** Set/clear a publication's password by slug — works for tag + path publications. */
  setPublicationPassword?(slug: string, password: string | null): Promise<void>;
  /** Per-publication tending: rename, choose the home note, and/or hand-exclude notes. */
  updatePublicationSettings?(
    slug: string,
    settings: {
      title?: string | null;
      homeNoteId?: string | null;
      excludeNoteIds?: string[];
      theme?: PublicationTheme | null;
    },
  ): Promise<void>;
  unpublishTag?(tag: string): Promise<void>;
  /** Unpublish by slug — works for both tag and path publications. */
  unpublish?(slug: string): Promise<void>;

  /** Federation — peer-to-peer vault sync. All optional; absent → the Federate
   *  surface is hidden (desktop / capability-viewer safe). `federationEnabled`
   *  reports whether the node has the FEDERATION_ENABLED flag on. */
  federationEnabled?(): Promise<boolean>;
  /** Toggle the live federation transport at runtime (owner-only; persisted, no
   *  restart). Enabling starts the bridge + binds known spaces; disabling stops it. */
  setFederationEnabled?(enabled: boolean): Promise<void>;
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
  /** "Parachute Sync" (Phase 4.2): mirror ONE note to a paired peer in a single
   *  action — the server composes create-space + add-note + grant-peer + sync. */
  mirrorNoteToPeer?(noteId: string, pubkey: string, level: ShareLevel): Promise<{ spaceId: string; spaceNoteKey: string }>;
  /** Peer-edit audit (4.3): inbound edits federated peers made to shared notes. */
  listPeerEdits?(limit?: number): Promise<PeerEditInfo[]>;

  /** Inbound mirror requests this node has received (owner-reviewed). */
  listMirrorRequests?(status?: "pending" | "accepted" | "rejected"): Promise<MirrorRequestInfo[]>;
  acceptMirror?(id: string, level?: ShareLevel): Promise<void>;
  rejectMirror?(id: string): Promise<void>;

  /** Multi-vault (Phase 1). The owner can front several Parachute vaults from one
   *  Prism Server and switch which one the app talks to. `listVaults` enumerates
   *  the configured vaults; `setActiveVault` repoints the client (persisted) and
   *  `getActiveVault` reads the current choice. Absent → single-vault, no switcher. */
  listVaults?(): Promise<VaultSummary[]>;
  getActiveVault?(): string | null;
  setActiveVault?(id: string): void;
  /** Create a brand-new Parachute vault and register it (owner; server shells out
   *  to the hub CLI + mints a token, then optionally seeds tag schemas). */
  createVault?(args: { label: string; name: string; seedSchemas?: boolean }): Promise<VaultSummary>;
  /** Link an existing (possibly remote) vault by url + name + token. */
  linkVault?(args: { label: string; url: string; vault: string; token: string }): Promise<VaultSummary>;
  /** Remove an added vault from the registry (never the env primary). */
  removeVault?(id: string): Promise<void>;
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
