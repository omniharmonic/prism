import type {
  CollabSharing,
  MirrorRequestInfo,
  NodeIdentity,
  NoteAccess,
  PairingCode,
  PeerInfo,
  PeerEditInfo,
  PublicationInfo,
  PublicationPreview,
  PublicationPresentation,
  PublicationPresentationState,
  PublicationTheme,
  SetPersonResult,
  ShareLevel,
  ShareLink,
  SpaceInfo,
  TagAccess,
  ServerInfo,
  IntegrationStatus,
  TunnelStatus,
  TunnelIngress,
  VaultSummary,
  WorkspaceEntity,
  WorkspaceGrant,
  WorkspaceMember,
  WorkspaceOverview,
  WorkspaceRole,
} from "@prism/core/shell";
import { serverFetch, collabWsUrl } from "../transport";
import { getActiveVault, setActiveVault, getActiveWorkspace, setActiveWorkspace, contextHeaders, agentScope, getMe, apiBase } from "../config";
import type { ViewerIdentity } from "@prism/core/shell";

/**
 * Web sharing impl, backed by the Prism Server ACL API (/acl, owner-only). The
 * browser never holds a vault token; these calls ride the owner's session
 * cookie. Powers the full share dialog (people + capability links + tag-grants).
 */
export async function managementRequest(prefix: "/acl" | "/api", path: string, init?: RequestInit): Promise<Response> {
  const scope = agentScope();
  const me = getMe();
  if (!scope || !me?.email || !me.vaultId || !me.workspace?.id) {
    throw new Error("Reconnect to this workspace before managing access.");
  }
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("X-Prism-Vault", me.vaultId);
  headers.set("X-Prism-Workspace", me.workspace.id);
  headers.set("X-Prism-Write-Actor", `user:${me.email}`);
  const origin = apiBase().replace(/\/api$/, "");
  const response = await serverFetch(`${origin}${prefix}${path}`, { ...init, credentials: "include", headers });
  // Finish reading before checking scope: a delayed JSON body is also an old
  // audience's result. Never display it after switching account/workspace/vault.
  const payload = await response.arrayBuffer();
  if (agentScope() !== scope) throw new Error("Workspace or account changed. Reopen these settings.");
  const result = new Response([204, 205, 304].includes(response.status) ? null : payload, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
  if (!result.ok) throw await serverError(result, `${prefix.slice(1).toUpperCase()} ${init?.method ?? "GET"} ${path}`);
  return result;
}
const acl = (path: string, init?: RequestInit) => managementRequest("/acl", path, init);
const api = (path: string, init?: RequestInit) => managementRequest("/api", path, init);

/** An Error carrying the server's `{error, detail}` (e.g. 409 `disabled`) so the
 *  UI can say something useful. Server error bodies never carry secret values. */
async function serverError(r: Response, what: string): Promise<Error & { status: number; code?: string; retryAfter?: number }> {
  let code: string | undefined;
  let detail: string | undefined;
  let retryAfter: number | undefined;
  try {
    const b = (await r.json()) as { error?: unknown; detail?: unknown; retryAfter?: unknown };
    if (typeof b.retryAfter === "number" && Number.isFinite(b.retryAfter) && b.retryAfter >= 0) retryAfter = b.retryAfter;
    if (typeof b.error === "string") code = b.error;
    if (typeof b.detail === "string") detail = b.detail.slice(0, 300);
  } catch {
    /* non-JSON body */
  }
  const retryHeader = r.headers.get("Retry-After");
  if (retryHeader) {
    const seconds = Number(retryHeader);
    const value = Number.isFinite(seconds) ? seconds : (Date.parse(retryHeader) - Date.now()) / 1000;
    if (Number.isFinite(value)) retryAfter = Math.max(0, value);
  }
  const e = new Error(`${what} → ${r.status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`) as Error & { status: number; code?: string; retryAfter?: number };
  e.status = r.status;
  e.code = code;
  if (retryAfter !== undefined) e.retryAfter = Math.min(3600, Math.ceil(retryAfter));
  return e;
}

const enc = encodeURIComponent;

/** This web app's collab WebSocket url — the peer dials this to mirror our spaces. */
function collabUrl(): string {
  return collabWsUrl();
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
  async setPerson(noteId: string, email: string, level: ShareLevel, options?: { scope?: "page" | "note"; caps?: string[] }): Promise<SetPersonResult> {
    const body: Record<string, unknown> = { email, level };
    if (options?.scope) body.scope = options.scope;
    if (options?.caps?.length) body.caps = options.caps;
    return (await acl(`/notes/${enc(noteId)}/people`, { method: "PUT", body: JSON.stringify(body) })).json();
  },
  async removePerson(noteId: string, email: string): Promise<void> {
    await acl(`/notes/${enc(noteId)}/people/${enc(email)}`, { method: "DELETE" });
  },
  async setNoteVisibility(noteId: string, isPrivate: boolean): Promise<void> {
    // Both shells use the same guarded metadata delta. Conflicts are surfaced
    // for review; visibility is never retried as a forced write.
    await acl(`/notes/${enc(noteId)}/visibility`, { method: "PUT", body: JSON.stringify({ isPrivate }) });
  },

  // The viewer's role in the active vault — a FRESH, vault-scoped read (not the
  // global cachedMe) so it's correct right after a vault switch. Powers role-
  // gating of the Network management panels.
  async getViewer(): Promise<ViewerIdentity> {
    const r = await serverFetch(`/auth/me`, {
      credentials: "include",
      headers: contextHeaders(),
    });
    if (!r.ok) return { email: "", role: "guest", isServerOwner: false, vaultId: getActiveVault() ?? "primary" };
    const me = (await r.json()) as { email?: string; role?: ViewerIdentity["role"]; isOwner?: boolean; vaultId?: string };
    return {
      email: me.email ?? "",
      role: me.role ?? "guest",
      isServerOwner: !!me.isOwner,
      vaultId: me.vaultId ?? getActiveVault() ?? "primary",
    };
  },

  // ── Folder/tag sharing + workspace members (Phase 2) ──
  async setTagPerson(tag: string, email: string, level: ShareLevel): Promise<SetPersonResult> {
    return (await acl(`/tags/${enc(tag)}/people`, { method: "PUT", body: JSON.stringify({ email, level }) })).json();
  },
  async removeTagPerson(tag: string, email: string): Promise<void> {
    await acl(`/tags/${enc(tag)}/people/${enc(email)}`, { method: "DELETE" });
  },
  async getTagAccess(tag: string): Promise<TagAccess[]> {
    return (await acl(`/tags/${enc(tag)}/access`)).json();
  },
  async listGrants(): Promise<WorkspaceGrant[]> {
    return (await acl(`/grants`)).json();
  },
  async revokeGrant(id: string): Promise<void> {
    await acl(`/grants/${enc(id)}`, { method: "DELETE" });
  },
  // ── Workspace (= the server): cross-vault people management (server-owner) ──
  async getWorkspace(): Promise<WorkspaceOverview> {
    return (await acl(`/workspace`)).json();
  },
  async setWorkspaceAccess(email: string, vaultId: string, level: ShareLevel): Promise<SetPersonResult> {
    return (await acl(`/workspace/access`, { method: "PUT", body: JSON.stringify({ email, vaultId, level }) })).json();
  },
  async removeWorkspaceAccess(vaultId: string, email: string): Promise<void> {
    await acl(`/workspace/access/${enc(vaultId)}/${enc(email)}`, { method: "DELETE" });
  },
  async setWorkspaceMemberRole(email: string, vaultId: string, role: WorkspaceRole): Promise<SetPersonResult> {
    return (await acl(`/workspace/members`, { method: "PUT", body: JSON.stringify({ email, vaultId, role }) })).json();
  },
  async removeWorkspaceMemberRole(vaultId: string, email: string): Promise<void> {
    await acl(`/workspace/members/${enc(vaultId)}/${enc(email)}`, { method: "DELETE" });
  },

  // ── Server settings + Cloudflare tunnel (server-owner) ──
  async getServerInfo(): Promise<ServerInfo> {
    return (await acl(`/server`)).json();
  },
  async getWorkerHealth() {
    return (await acl(`/workers`)).json();
  },
  async getLegacyMcpTokens() {
    return (await api(`/mcp/legacy-tokens`)).json();
  },
  async revokeLegacyMcpTokens(opts) {
    return (await api(`/mcp/legacy-tokens/revoke`, { method: "POST", body: JSON.stringify(opts) })).json();
  },
  async controlTunnel(action: "start" | "stop" | "restart"): Promise<{ tunnel: TunnelStatus }> {
    return (await acl(`/server/tunnel`, { method: "POST", body: JSON.stringify({ action }) })).json();
  },
  async setServerConfig(key: string, value: string): Promise<{ restartRequired: boolean }> {
    return (await acl(`/server/config`, { method: "PUT", body: JSON.stringify({ key, value }) })).json();
  },
  async getTunnelIngress(): Promise<TunnelIngress> {
    return (await acl(`/server/tunnel/ingress`)).json();
  },
  async applyTunnelIngress(): Promise<{ added: string[] }> {
    return (await acl(`/server/tunnel/ingress`, { method: "POST" })).json();
  },

  // ── Server-side sync-integration credentials (admin+, /api/integrations) ──
  // Status rides the same api() (active-vault) scope as the PUT, so the
  // configured badge always reflects the vault a Save actually wrote to.
  async getIntegrationStatus(kind: string): Promise<IntegrationStatus> {
    return (await api(`/integrations/${enc(kind)}`)).json();
  },
  async setIntegrationCredential(kind: string, fields: Record<string, unknown>): Promise<void> {
    await api(`/integrations/${enc(kind)}`, { method: "PUT", body: JSON.stringify(fields) });
  },
  async deleteIntegrationCredential(kind: string): Promise<void> {
    await api(`/integrations/${enc(kind)}`, { method: "DELETE" });
  },
  async syncIntegration(kind: string): Promise<Record<string, unknown>> {
    return (await api(`/integrations/${enc(kind)}/sync`, { method: "POST" })).json();
  },
  async integrationAction(kind: string, action: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await api(`/integrations/${enc(kind)}/${enc(action)}`, { method: "POST", body: JSON.stringify(body ?? {}) })).json();
  },
  async setVaultToken(vaultId: string, token: string): Promise<void> {
    const r = await serverFetch(`/acl/vaults/${enc(vaultId)}/token`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...contextHeaders() },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) throw await serverError(r, "Replace vault token");
  },

  // ── Workspace entities (one server, many workspaces) ──
  async listWorkspaceEntities(): Promise<WorkspaceEntity[]> {
    return (await acl(`/workspaces`)).json();
  },
  async createWorkspaceEntity(name: string, hostname?: string): Promise<WorkspaceEntity> {
    return (await acl(`/workspaces`, { method: "POST", body: JSON.stringify({ name, hostname }) })).json();
  },
  async updateWorkspaceEntity(id: string, patch: { name?: string; hostname?: string | null }): Promise<WorkspaceEntity> {
    return (await acl(`/workspaces/${enc(id)}`, { method: "PUT", body: JSON.stringify(patch) })).json();
  },
  async deleteWorkspaceEntity(id: string): Promise<void> {
    await acl(`/workspaces/${enc(id)}`, { method: "DELETE" });
  },
  async assignVaultToWorkspaceEntity(workspaceId: string, vaultId: string): Promise<void> {
    await acl(`/workspaces/${enc(workspaceId)}/vaults`, { method: "PUT", body: JSON.stringify({ vaultId }) });
  },
  getActiveWorkspace(): string | null {
    return getActiveWorkspace();
  },
  setActiveWorkspace(id: string): void {
    setActiveWorkspace(id);
  },

  async listMembers(): Promise<WorkspaceMember[]> {
    return (await acl(`/members`)).json();
  },
  async setMember(email: string, role: WorkspaceRole): Promise<SetPersonResult> {
    return (await acl(`/members`, { method: "PUT", body: JSON.stringify({ email, role }) })).json();
  },
  async removeMember(email: string): Promise<void> {
    await acl(`/members/${enc(email)}`, { method: "DELETE" });
  },
  async setVaultPerson(email: string, level: ShareLevel): Promise<SetPersonResult> {
    return (await acl(`/vault/people`, { method: "PUT", body: JSON.stringify({ email, level }) })).json();
  },
  async removeVaultPerson(email: string): Promise<void> {
    await acl(`/vault/people/${enc(email)}`, { method: "DELETE" });
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
  async previewPublication(slug: string): Promise<PublicationPreview> {
    return (await acl(`/publications/${enc(slug)}/preview`)).json();
  },
  async getPublicationPresentation(slug: string): Promise<PublicationPresentationState> {
    return (await acl(`/publications/${enc(slug)}/presentation`)).json();
  },
  async savePublicationPresentation(slug: string, presentation: PublicationPresentation, draftRevision: number, liveRevision: number): Promise<PublicationPresentationState> {
    return (await acl(`/publications/${enc(slug)}/presentation/draft`, {method:"POST",body:JSON.stringify({presentation,draftRevision,liveRevision})})).json();
  },
  async publishPublicationPresentation(slug: string, draftRevision: number, liveRevision: number): Promise<PublicationPresentationState> {
    return (await acl(`/publications/${enc(slug)}/presentation/publish`, {method:"POST",body:JSON.stringify({draftRevision,liveRevision})})).json();
  },
  async restorePublicationPresentation(slug: string, revision: number, draftRevision: number, liveRevision: number): Promise<PublicationPresentationState> {
    return (await acl(`/publications/${enc(slug)}/presentation/restore`, {method:"POST",body:JSON.stringify({revision,draftRevision,liveRevision})})).json();
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
    settings: {
      title?: string | null;
      homeNoteId?: string | null;
      excludeNoteIds?: string[];
      theme?: PublicationTheme | null;
    },
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
  async mirrorNoteToPeer(noteId: string, pubkey: string, level: ShareLevel): Promise<{ spaceId: string; spaceNoteKey: string }> {
    return (await acl(`/notes/${enc(noteId)}/mirror`, { method: "POST", body: JSON.stringify({ pubkey, level }) })).json();
  },
  async listPeerEdits(limit = 200): Promise<PeerEditInfo[]> {
    return (await acl(`/federation/peer-edits?limit=${limit}`)).json();
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
    const r = await serverFetch(`/api/vaults`, { credentials: "include" });
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
