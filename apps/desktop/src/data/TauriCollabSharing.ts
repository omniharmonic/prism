import { invoke } from "@tauri-apps/api/core";
import type {
  CollabSharing,
  MirrorRequestInfo,
  NodeIdentity,
  NoteAccess,
  PairingCode,
  PeerInfo,
  PublicationInfo,
  PublicationTheme,
  SetPersonResult,
  ShareLevel,
  ShareLink,
  SpaceInfo,
  VaultSummary,
} from "@prism/core";

/**
 * Desktop implementation of the CollabSharing seam — full parity with the web
 * shell for the share dialog AND the Network surface (publishing + federation).
 * Every owner-only call is proxied through the `acl_request` Rust command, which
 * talks to the Prism Server's `/acl` API using the COLLAB_TOKEN held in the
 * desktop config — exactly like the web client's `fetch('/acl' + path)`. The
 * token never enters the web context.
 *
 * Multi-vault (listVaults / vault switching) is intentionally NOT implemented
 * here: it's the Prism Server's owner-passthrough registry (web), whereas the
 * desktop talks to its own single configured Parachute vault directly. So the
 * Network → Vaults tab is web-only (NetworkRenderer gates it on listVaults).
 */
async function acl<T>(method: string, path: string, body?: unknown): Promise<T> {
  return invoke<T>("acl_request", { method, path, body: body ?? null });
}

const enc = encodeURIComponent;

async function createLink(noteId: string, level: ShareLevel, expiresInDays?: number): Promise<ShareLink> {
  return acl<ShareLink>("POST", `/notes/${enc(noteId)}/links`, { level, expiresInDays });
}

/** Our Prism Server's collab WS url (what a peer dials to mirror our spaces). */
async function ownCollabUrl(): Promise<string> {
  try {
    const cfg = await invoke<Record<string, unknown>>("get_full_config");
    const u = String(cfg.collab_url ?? "");
    if (u) return u;
  } catch {
    /* fall through */
  }
  return "";
}

export const tauriCollabSharing: CollabSharing = {
  // ── Share dialog (people grants, capability links, tag-grants) ──
  async createShareLink(noteId: string): Promise<string> {
    return (await createLink(noteId, "edit")).url;
  },
  async getAccess(noteId: string): Promise<NoteAccess> {
    return acl<NoteAccess>("GET", `/notes/${enc(noteId)}`);
  },
  async setPerson(noteId: string, email: string, level: ShareLevel): Promise<SetPersonResult> {
    return acl<SetPersonResult>("PUT", `/notes/${enc(noteId)}/people`, { email, level });
  },
  async removePerson(noteId: string, email: string): Promise<void> {
    await acl("DELETE", `/notes/${enc(noteId)}/people/${enc(email)}`);
  },
  createLink,
  async revokeLink(noteId: string, linkId: string): Promise<void> {
    await acl("DELETE", `/notes/${enc(noteId)}/links/${enc(linkId)}`);
  },
  async listUsers(): Promise<string[]> {
    const users = await acl<Array<{ email: string }>>("GET", `/users`);
    return users.map((u) => u.email);
  },

  // ── Publishing (Network → Publish) ──
  async listPublications(): Promise<PublicationInfo[]> {
    return acl<PublicationInfo[]>("GET", `/publications`);
  },
  async publishTag(tag, opts) {
    return acl("POST", `/tags/${enc(tag)}/publish`, opts ?? {});
  },
  async publishPath(pathPrefix, opts) {
    return acl("POST", `/publish/path`, { pathPrefix, ...(opts ?? {}) });
  },
  async setPublishPassword(tag, password) {
    await acl("PUT", `/tags/${enc(tag)}/publish/password`, { password: password ?? "" });
  },
  async unpublishTag(tag) {
    await acl("DELETE", `/tags/${enc(tag)}/publish`);
  },
  async unpublish(slug) {
    await acl("DELETE", `/publications/${enc(slug)}`);
  },
  async setPublicationPassword(slug, password) {
    await acl("PUT", `/publications/${enc(slug)}/password`, { password: password ?? "" });
  },
  async updatePublicationSettings(slug, settings: { title?: string | null; homeNoteId?: string | null; excludeNoteIds?: string[]; theme?: PublicationTheme | null }) {
    await acl("PUT", `/publications/${enc(slug)}/settings`, settings);
  },

  // ── Federation (Network → Federate) ──
  async federationEnabled(): Promise<boolean> {
    const { enabled } = await acl<{ enabled: boolean }>("GET", `/federation/status`);
    return enabled;
  },
  async setFederationEnabled(enabled: boolean): Promise<void> {
    await acl("POST", `/federation/enabled`, { enabled });
  },
  async getNodeIdentity(): Promise<NodeIdentity> {
    return acl<NodeIdentity>("GET", `/peers/identity`);
  },
  async createPairingCode(label?: string): Promise<PairingCode> {
    return acl<PairingCode>("POST", `/peers/pair`, { label });
  },
  // Cross-origin: register THIS node as the peer's peer. No credentials (the peer
  // authorizes by the one-time code). Sends our identity + our collab WS url.
  async redeemPairingCode(args: { code: string; peerServerUrl: string; label?: string }): Promise<{ ok: boolean; fingerprint: string }> {
    const identity = await acl<NodeIdentity>("GET", `/peers/identity`);
    const peerOrigin = args.peerServerUrl.replace(/\/+$/, "");
    const r = await fetch(`${peerOrigin}/api/federation/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: args.code, pubkey: identity.publicKey, label: args.label, collabUrl: await ownCollabUrl() }),
    });
    if (!r.ok) throw new Error("Pairing failed — check the code + server URL");
    const { fingerprint } = (await r.json()) as { fingerprint: string };
    return { ok: true, fingerprint };
  },
  async listPeers(): Promise<PeerInfo[]> {
    return acl<PeerInfo[]>("GET", `/peers`);
  },
  async setPeerUrl(pubkey: string, collabUrl: string): Promise<void> {
    await acl("POST", `/peers/${enc(pubkey)}/url`, { collabUrl });
  },
  async removePeer(pubkey: string): Promise<void> {
    await acl("DELETE", `/peers/${enc(pubkey)}`);
  },

  async listSpaces(): Promise<SpaceInfo[]> {
    return acl<SpaceInfo[]>("GET", `/spaces`);
  },
  async createSpace(args): Promise<SpaceInfo> {
    return acl<SpaceInfo>("POST", `/spaces`, args);
  },
  async deleteSpace(spaceId: string): Promise<void> {
    await acl("DELETE", `/spaces/${enc(spaceId)}`);
  },
  async addNoteToSpace(spaceId: string, noteId: string): Promise<{ space_note_key: string; kind: string }> {
    return acl("POST", `/spaces/${enc(spaceId)}/notes`, { noteId });
  },
  async grantSpacePeer(spaceId: string, pubkey: string, level: ShareLevel): Promise<void> {
    await acl("POST", `/spaces/${enc(spaceId)}/peers`, { pubkey, level });
  },
  async revokeSpacePeer(spaceId: string, pubkey: string): Promise<void> {
    await acl("DELETE", `/spaces/${enc(spaceId)}/peers/${enc(pubkey)}`);
  },

  async listMirrorRequests(status): Promise<MirrorRequestInfo[]> {
    return acl<MirrorRequestInfo[]>("GET", `/federation/mirrors${status ? `?status=${status}` : ""}`);
  },
  async acceptMirror(id: string, level?: ShareLevel): Promise<void> {
    await acl("POST", `/federation/mirrors/${enc(id)}/accept`, { level });
  },
  async rejectMirror(id: string): Promise<void> {
    await acl("POST", `/federation/mirrors/${enc(id)}/reject`);
  },

  // ── Multi-vault (DESKTOP-NATIVE — talks to the local Parachute hub, not the
  // cloud Prism Server). Registry + switching live in the Rust backend; create
  // shells out to `parachute-vault create` on the host. ──
  async listVaults(): Promise<VaultSummary[]> {
    return invoke<VaultSummary[]>("vault_list");
  },
  setActiveVault(id: string): void {
    // Repoint the live Rust ParachuteClient, THEN soft-switch the UI (clear the
    // query cache + close tabs, no reload) — same event the web shell fires.
    void invoke("vault_set_active", { id })
      .then(() => window.dispatchEvent(new CustomEvent("prism:vault-changed", { detail: id })))
      .catch((e) => console.error("vault_set_active failed:", e));
  },
  async createVault(args: { label: string; name: string; seedSchemas?: boolean }): Promise<VaultSummary> {
    return invoke<VaultSummary>("vault_create", { label: args.label, name: args.name, seedSchemas: args.seedSchemas ?? true });
  },
  async linkVault(args: { label: string; url: string; vault: string; token: string }): Promise<VaultSummary> {
    return invoke<VaultSummary>("vault_link", args);
  },
  async removeVault(id: string): Promise<void> {
    await invoke("vault_remove", { id });
  },
};
