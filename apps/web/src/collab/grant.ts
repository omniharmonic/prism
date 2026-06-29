import type {
  CollabSharing,
  MirrorRequestInfo,
  NodeIdentity,
  NoteAccess,
  PairingCode,
  PeerInfo,
  PublicationInfo,
  SetPersonResult,
  ShareLevel,
  ShareLink,
  SpaceInfo,
  VaultSummary,
} from "@prism/core";
import { GATEWAY_ORIGIN, getActiveVault, setActiveVault } from "../config";

/**
 * Web sharing impl, backed by the Prism Server ACL API (/acl, owner-only). The
 * browser never holds a vault token; these calls ride the owner's session
 * cookie. Powers the full share dialog (people + capability links + tag-grants).
 */
async function acl(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(`${GATEWAY_ORIGIN}/acl${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string>) },
  });
  if (!r.ok) throw new Error(`ACL ${init?.method ?? "GET"} ${path} → ${r.status}`);
  return r;
}

const enc = encodeURIComponent;

/** This web app's collab WebSocket url — the peer dials this to mirror our spaces. */
function collabUrl(): string {
  const base = GATEWAY_ORIGIN || location.origin;
  return base.replace(/^http/, "ws") + "/collab";
}

async function createLink(noteId: string, level: ShareLevel, expiresInDays?: number): Promise<ShareLink> {
  return (await acl(`/notes/${enc(noteId)}/links`, {
    method: "POST",
    body: JSON.stringify({ level, expiresInDays }),
  })).json();
}

export const webCollabSharing: CollabSharing = {
  // Legacy one-click link → an "edit" capability link.
  async createShareLink(noteId: string): Promise<string> {
    return (await createLink(noteId, "edit")).url;
  },

  async getAccess(noteId: string): Promise<NoteAccess> {
    return (await acl(`/notes/${enc(noteId)}`)).json();
  },
  async setPerson(noteId: string, email: string, level: ShareLevel): Promise<SetPersonResult> {
    return (await acl(`/notes/${enc(noteId)}/people`, { method: "PUT", body: JSON.stringify({ email, level }) })).json();
  },
  async removePerson(noteId: string, email: string): Promise<void> {
    await acl(`/notes/${enc(noteId)}/people/${enc(email)}`, { method: "DELETE" });
  },
  createLink,
  async revokeLink(noteId: string, linkId: string): Promise<void> {
    await acl(`/notes/${enc(noteId)}/links/${enc(linkId)}`, { method: "DELETE" });
  },
  async listUsers(): Promise<string[]> {
    const users = (await (await acl(`/users`)).json()) as Array<{ email: string }>;
    return users.map((u) => u.email);
  },

  // ── Publishing (turn a tag into a public, read-only Wiki) ──
  async listPublications(): Promise<PublicationInfo[]> {
    return (await acl(`/publications`)).json();
  },
  async publishTag(
    tag: string,
    opts?: { template?: string; title?: string; password?: string },
  ): Promise<{ slug: string; url: string; count: number; passwordRequired: boolean }> {
    return (await acl(`/tags/${enc(tag)}/publish`, { method: "POST", body: JSON.stringify(opts ?? {}) })).json();
  },
  async publishPath(
    pathPrefix: string,
    opts?: { template?: string; title?: string; password?: string },
  ): Promise<{ slug: string; pathPrefix: string; url: string; count: number; passwordRequired: boolean }> {
    return (await acl(`/publish/path`, { method: "POST", body: JSON.stringify({ pathPrefix, ...(opts ?? {}) }) })).json();
  },
  async setPublishPassword(tag: string, password: string | null): Promise<void> {
    await acl(`/tags/${enc(tag)}/publish/password`, {
      method: "PUT",
      body: JSON.stringify({ password: password ?? "" }),
    });
  },
  async unpublishTag(tag: string): Promise<void> {
    await acl(`/tags/${enc(tag)}/publish`, { method: "DELETE" });
  },
  async unpublish(slug: string): Promise<void> {
    await acl(`/publications/${enc(slug)}`, { method: "DELETE" });
  },
  async setPublicationPassword(slug: string, password: string | null): Promise<void> {
    await acl(`/publications/${enc(slug)}/password`, {
      method: "PUT",
      body: JSON.stringify({ password: password ?? "" }),
    });
  },
  async updatePublicationSettings(
    slug: string,
    settings: { homeNoteId?: string | null; excludeNoteIds?: string[] },
  ): Promise<void> {
    await acl(`/publications/${enc(slug)}/settings`, { method: "PUT", body: JSON.stringify(settings) });
  },

  // ── Federation (peer-to-peer vault sync) ──
  async federationEnabled(): Promise<boolean> {
    const { enabled } = (await (await acl(`/federation/status`)).json()) as { enabled: boolean };
    return enabled;
  },
  async setFederationEnabled(enabled: boolean): Promise<void> {
    await acl(`/federation/enabled`, { method: "POST", body: JSON.stringify({ enabled }) });
  },
  async getNodeIdentity(): Promise<NodeIdentity> {
    return (await acl(`/peers/identity`)).json();
  },
  async createPairingCode(label?: string): Promise<PairingCode> {
    return (await acl(`/peers/pair`, { method: "POST", body: JSON.stringify({ label }) })).json();
  },
  // The one cross-origin call: register THIS node as the peer's peer. No
  // credentials (the peer authorizes by the one-time code, not our session).
  async redeemPairingCode(args: {
    code: string;
    peerServerUrl: string;
    label?: string;
  }): Promise<{ ok: boolean; fingerprint: string }> {
    const identity = await webCollabSharing.getNodeIdentity!();
    const peerOrigin = args.peerServerUrl.replace(/\/+$/, "");
    const r = await fetch(`${peerOrigin}/api/federation/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: args.code,
        pubkey: identity.publicKey,
        label: args.label,
        collabUrl: collabUrl(),
      }),
    });
    if (!r.ok) throw new Error("Pairing failed — check the code + server URL");
    const { fingerprint } = (await r.json()) as { ok: boolean; serverPublicKey: string; fingerprint: string };
    return { ok: true, fingerprint };
  },
  async listPeers(): Promise<PeerInfo[]> {
    return (await acl(`/peers`)).json();
  },
  async setPeerUrl(pubkey: string, collabUrl: string): Promise<void> {
    await acl(`/peers/${enc(pubkey)}/url`, { method: "POST", body: JSON.stringify({ collabUrl }) });
  },
  async removePeer(pubkey: string): Promise<void> {
    await acl(`/peers/${enc(pubkey)}`, { method: "DELETE" });
  },

  // ── Shared spaces (a slice of the vault synced with peers) ──
  async listSpaces(): Promise<SpaceInfo[]> {
    return (await acl(`/spaces`)).json();
  },
  async createSpace(args: {
    title?: string;
    includeTags?: string[];
    excludeTags?: string[];
    pathPrefix?: string;
  }): Promise<SpaceInfo> {
    return (await acl(`/spaces`, { method: "POST", body: JSON.stringify(args) })).json();
  },
  async deleteSpace(spaceId: string): Promise<void> {
    await acl(`/spaces/${enc(spaceId)}`, { method: "DELETE" });
  },
  async addNoteToSpace(spaceId: string, noteId: string): Promise<{ space_note_key: string; kind: string }> {
    const row = (await (
      await acl(`/spaces/${enc(spaceId)}/notes`, { method: "POST", body: JSON.stringify({ noteId }) })
    ).json()) as { space_note_key: string; kind: string };
    return { space_note_key: row.space_note_key, kind: row.kind };
  },
  async grantSpacePeer(spaceId: string, pubkey: string, level: ShareLevel): Promise<void> {
    await acl(`/spaces/${enc(spaceId)}/peers`, { method: "POST", body: JSON.stringify({ pubkey, level }) });
  },
  async revokeSpacePeer(spaceId: string, pubkey: string): Promise<void> {
    await acl(`/spaces/${enc(spaceId)}/peers/${enc(pubkey)}`, { method: "DELETE" });
  },

  // ── Inbound mirror requests (owner-reviewed) ──
  async listMirrorRequests(status?: "pending" | "accepted" | "rejected"): Promise<MirrorRequestInfo[]> {
    return (await acl(`/federation/mirrors${status ? `?status=${status}` : ""}`)).json();
  },
  async acceptMirror(id: string, level?: ShareLevel): Promise<void> {
    await acl(`/federation/mirrors/${enc(id)}/accept`, { method: "POST", body: JSON.stringify({ level }) });
  },
  async rejectMirror(id: string): Promise<void> {
    await acl(`/federation/mirrors/${enc(id)}/reject`, { method: "POST" });
  },

  // ── Multi-vault (Phase 1 owner switcher) ──
  async listVaults(): Promise<VaultSummary[]> {
    // Owner-only gateway route (not under /acl); rides the session cookie.
    const r = await fetch(`${GATEWAY_ORIGIN}/api/vaults`, { credentials: "include" });
    if (!r.ok) throw new Error(`GET /api/vaults → ${r.status}`);
    const rows: VaultSummary[] = await r.json();
    // The active flag from the server marks the DEFAULT vault; overlay the
    // client's current choice so the UI reflects what we're actually sending.
    const chosen = getActiveVault();
    return chosen ? rows.map((v) => ({ ...v, active: v.id === chosen })) : rows;
  },
  getActiveVault(): string | null {
    return getActiveVault();
  },
  setActiveVault(id: string): void {
    // Persist the choice (rest.ts reads it per request via X-Prism-Vault), then
    // fire a soft-switch event. The app clears its query cache + closes tabs and
    // refetches against the new vault — NO full page reload, so a waiting
    // service-worker version never activates mid-switch.
    setActiveVault(id);
    window.dispatchEvent(new CustomEvent("prism:vault-changed", { detail: id }));
  },
  async createVault(args: { label: string; name: string; seedSchemas?: boolean }): Promise<VaultSummary> {
    return (await acl(`/vaults`, { method: "POST", body: JSON.stringify({ mode: "create", ...args }) })).json();
  },
  async linkVault(args: { label: string; url: string; vault: string; token: string }): Promise<VaultSummary> {
    return (await acl(`/vaults`, { method: "POST", body: JSON.stringify({ mode: "link", ...args }) })).json();
  },
  async removeVault(id: string): Promise<void> {
    await acl(`/vaults/${enc(id)}`, { method: "DELETE" });
  },
};
