import { useEffect, useState } from "react";
import { Globe, Radio, Database, Users, Building2, Server, Boxes } from "lucide-react";
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

/**
 * The Network surface — a top-level virtual tab (not a per-note dialog) where the
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
  const canServer = !!sharing?.getServerInfo && isServerOwner;

  const tabs = [
    ...(canWorkspaces ? [{ id: "workspaces", label: "Workspaces", icon: <Boxes size={14} /> }] : []),
    ...(canAccess ? [{ id: "access", label: "Access", icon: <Building2 size={14} /> }] : []),
    ...(canPublish ? [{ id: "publish", label: "Publish", icon: <Globe size={14} /> }] : []),
    ...(canFederate ? [{ id: "federate", label: "Federate", icon: <Radio size={14} /> }] : []),
    ...(canMembers ? [{ id: "members", label: "Members", icon: <Users size={14} /> }] : []),
    ...(canVaults ? [{ id: "vaults", label: "Vaults", icon: <Database size={14} /> }] : []),
    ...(canServer ? [{ id: "server", label: "Server", icon: <Server size={14} /> }] : []),
  ];
  const [tab, setTab] = useState<string>("publish");
  // Keep the active tab valid as role/vault gating changes which tabs exist.
  useEffect(() => {
    if (tabs.length && !tabs.some((t) => t.id === tab)) setTab(tabs[0]!.id);
  }, [tabs.map((t) => t.id).join(","), tab]);

  // Role still loading (web, first paint before getViewer resolves).
  if (role === null) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <header style={{ padding: "20px 28px 12px", borderBottom: "1px solid var(--glass-border)", flexShrink: 0 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>Network</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "4px 0 0" }}>
          {isAdmin
            ? "Publish slices of your vault to the web, and federate them peer-to-peer with other vaults."
            : "The workspaces you belong to. Ask a workspace admin for management access to publish or federate."}
        </p>
        <div style={{ marginTop: 14 }}>
          <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />
        </div>
      </header>
      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 48px" }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          {tab === "workspaces" && <WorkspacesPanel />}
          {tab === "access" && <WorkspacePanel />}
          {tab === "publish" && <PublishPanel />}
          {tab === "federate" && <FederatePanel />}
          {tab === "members" && <MembersPanel />}
          {tab === "vaults" && <VaultsPanel />}
          {tab === "server" && <ServerPanel />}
        </div>
      </div>
    </div>
  );
}
