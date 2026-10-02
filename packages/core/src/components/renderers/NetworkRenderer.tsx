import { useEffect, useState } from "react";
import { Globe, Radio, Database, Scale, Users, Building2, Server, Boxes } from "lucide-react";
import { Tabs } from "../ui/Tabs";
import { useCollabSharing, useVaultChangeSignal, type WorkspaceRole } from "../../data/CollabSharing";
import type { RendererProps } from "./RendererProps";
import { PublishPanel } from "./network/PublishPanel";
import { FederatePanel } from "./network/FederatePanel";
import { VaultsPanel } from "./network/VaultsPanel";
import { MembersPanel } from "./network/MembersPanel";
import { WorkspacePanel } from "./network/WorkspacePanel";
import { WorkspacesPanel } from "./network/WorkspacesPanel";
import { ServerPanel } from "./network/ServerPanel";
import { GovernancePanel } from "./network/governance/GovernancePanel";

/**
 * Workspace settings — a top-level virtual tab (not a per-note dialog) where the
 * owner operates their vault as a node in a knowledge network:
 *   • Publish — turn a slice (tag/directory) into a public read-only Wiki.
 *   • Federate — pair with peer hubs and keep slices in two-way CRDT sync.
 *   • Vaults — connect/switch the vault(s) this Prism fronts.
 *
 * Each section is gated on the sharing seam exposing its methods, so the surface
 * degrades gracefully on the desktop shell / for capability viewers (web-owner
 * only), exactly like the Publish tab in the share dialog.
 */
export default function NetworkRenderer(_props: RendererProps) {
  const sharing = useCollabSharing();
  const vaultSignal = useVaultChangeSignal();

  // The viewer's role in the ACTIVE vault. Management panels (Publish/Federate/
  // Members) are admin+ server-side — so we gate their tabs on the role too, or a
  // plain member would mount them, fire admin-only /acl/* calls, and see 403s.
  // Re-read whenever the active vault changes (role is per-workspace). When the
  // shell has no getViewer (desktop = local operator), treat as owner.
  const [role, setRole] = useState<WorkspaceRole | null>(sharing?.getViewer ? null : "owner");
  const [isServerOwner, setIsServerOwner] = useState<boolean>(!sharing?.getViewer);
  useEffect(() => {
    const getViewer = sharing?.getViewer;
    if (!getViewer) { setRole("owner"); setIsServerOwner(true); return; }
    let live = true;
    setRole(null);
    getViewer()
      .then((v) => { if (live) { setRole(v.role); setIsServerOwner(v.isServerOwner); } })
      .catch(() => { if (live) { setRole("guest"); setIsServerOwner(false); } });
    return () => { live = false; };
  }, [sharing, vaultSignal]);

  const isAdmin = role === "owner" || role === "admin";

  const canPublish = !!sharing?.publishTag && isAdmin;
  const canFederate = !!sharing?.getNodeIdentity && isAdmin;
  // Multi-vault is the Prism Server's owner-passthrough registry — web only. The
  // desktop talks to its own single configured vault, so it doesn't expose
  // listVaults; hide the tab there rather than show a dead "not available" panel.
  // Vaults is visible to every member (the list is membership-filtered server-side)
  // so a member can still see + switch between the workspaces they belong to.
  const canVaults = !!sharing?.listVaults;
  const canMembers = !!sharing?.listMembers && isAdmin;
  // The Workspaces/Access + Server surfaces span the whole box → server-owner only.
  const canWorkspaces = !!sharing?.listWorkspaceEntities && isServerOwner;
  const canAccess = !!sharing?.getWorkspace && isServerOwner;
  // Integration credentials are vault-scoped admin work; operator controls
  // remain server-owner-only inside ServerPanel after getServerInfo succeeds.
  const canConnections = !!sharing?.getViewer && isAdmin && !!sharing.getIntegrationStatus;
  const canServer = canConnections || (!!sharing?.getServerInfo && isServerOwner
    && (!sharing.getIntegrationStatus || !!sharing.getViewer));
  // Governance is member-authed in its own handler (members vote on proposals),
  // so it is NOT admin-gated: show it wherever the Network surface has any web
  // capability; hidden on desktop / for capability viewers.
  const canGovern = canPublish || canFederate || canVaults;

  const tabs = [
    ...(canWorkspaces ? [{ id: "workspaces", label: "Workspaces", icon: <Boxes size={14} /> }] : []),
    ...(canAccess ? [{ id: "access", label: "Access", icon: <Building2 size={14} /> }] : []),
    ...(canPublish ? [{ id: "publish", label: "Publish", icon: <Globe size={14} /> }] : []),
    ...(canFederate ? [{ id: "federate", label: "Federate", icon: <Radio size={14} /> }] : []),
    ...(canMembers ? [{ id: "members", label: "Members", icon: <Users size={14} /> }] : []),
    ...(canVaults ? [{ id: "vaults", label: "Vaults", icon: <Database size={14} /> }] : []),
    ...(canGovern ? [{ id: "governance", label: "Governance", icon: <Scale size={14} /> }] : []),
    ...(canServer ? [{ id: "server", label: canConnections ? "Connections" : "Server", icon: <Server size={14} /> }] : []),
  ];
  const [tab, setTab] = useState<string>("publish");
  // Resolve against permitted tabs during render, so a removed capability never
  // leaves its management panel mounted while an effect catches up.
  const activeTab = tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id;

  // Role still loading (web, first paint before getViewer resolves).
  if (role === null) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  return (
    <section
      aria-label="Workspace settings"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      <header className="shrink-0 border-b border-[var(--glass-border)] px-4 pb-3 pt-5 sm:px-7 sm:pt-7">
        <div className={`mx-auto ${activeTab === "publish" ? "max-w-[1180px]" : "max-w-[880px]"}`}>
          <h1 className="m-0 text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">Workspace settings</h1>
          <p className="mb-0 mt-1 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {isAdmin
              ? "Manage your people, published sites, connected vaults, and shared workspace."
              : "Explore your connected vaults and workspace governance. Your admin manages access and publishing."}
          </p>
          {tabs.length > 0 && (
            <div className="mt-4 min-w-0">
              <Tabs
                tabs={tabs}
                activeTab={activeTab!}
                onChange={setTab}
                className="[&>button]:min-h-11"
              />
            </div>
          )}
        </div>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pb-12 pt-5 sm:px-7">
        <div className={`mx-auto ${activeTab === "publish" ? "max-w-[1180px]" : "max-w-[880px]"}`}>
          {activeTab === "workspaces" && <WorkspacesPanel />}
          {activeTab === "access" && <WorkspacePanel />}
          {activeTab === "publish" && <PublishPanel />}
          {activeTab === "federate" && <FederatePanel />}
          {activeTab === "members" && <MembersPanel />}
          {activeTab === "vaults" && <VaultsPanel />}
          {activeTab === "governance" && <GovernancePanel />}
          {activeTab === "server" && <ServerPanel />}
          {!activeTab && (
            <p role="status" className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Workspace settings aren't available for this connection. Ask a workspace admin if you need management access.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
