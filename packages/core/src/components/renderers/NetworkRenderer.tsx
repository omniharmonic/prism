import { useState } from "react";
import { Globe, Radio, Database } from "lucide-react";
import { Tabs } from "../ui/Tabs";
import { useCollabSharing } from "../../data/CollabSharing";
import type { RendererProps } from "./RendererProps";
import { PublishPanel } from "./network/PublishPanel";
import { FederatePanel } from "./network/FederatePanel";
import { VaultsPanel } from "./network/VaultsPanel";

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
  const canPublish = !!sharing?.publishTag;
  const canFederate = !!sharing?.getNodeIdentity;

  const tabs = [
    ...(canPublish ? [{ id: "publish", label: "Publish", icon: <Globe size={14} /> }] : []),
    ...(canFederate ? [{ id: "federate", label: "Federate", icon: <Radio size={14} /> }] : []),
    { id: "vaults", label: "Vaults", icon: <Database size={14} /> },
  ];
  const [tab, setTab] = useState<string>(tabs[0]?.id ?? "vaults");

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <header style={{ padding: "20px 28px 12px", borderBottom: "1px solid var(--glass-border)", flexShrink: 0 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>Network</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "4px 0 0" }}>
          Publish slices of your vault to the web, and federate them peer-to-peer with other vaults.
        </p>
        <div style={{ marginTop: 14 }}>
          <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />
        </div>
      </header>
      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 48px" }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          {tab === "publish" && <PublishPanel />}
          {tab === "federate" && <FederatePanel />}
          {tab === "vaults" && <VaultsPanel />}
        </div>
      </div>
    </div>
  );
}
