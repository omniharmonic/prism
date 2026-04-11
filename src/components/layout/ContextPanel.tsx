import { useUIStore } from "../../app/stores/ui";
import { useNote } from "../../app/hooks/useParachute";
import { Tabs } from "../ui/Tabs";
import { MetadataPanel } from "./MetadataPanel";
import { PanelChat } from "../agent/PanelChat";

const PANEL_TABS = [
  { id: "metadata", label: "Meta" },
  { id: "agent", label: "Agent" },
  { id: "links", label: "Links" },
  { id: "history", label: "History" },
];

export function ContextPanel() {
  const { contextPanelTab, setContextPanelTab, openTabs, activeTabId } = useUIStore();
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const { data: note } = useNote(activeTab?.noteId ?? null);

  return (
    <div
      className="h-full flex flex-col"
      style={{
        background: "var(--bg-surface)",
        borderLeft: "1px solid var(--glass-border)",
      }}
    >
      <div className="p-2" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <Tabs
          tabs={PANEL_TABS}
          activeTab={contextPanelTab}
          onChange={(id) => setContextPanelTab(id as typeof contextPanelTab)}
        />
      </div>

      <div className="flex-1 overflow-auto p-3">
        {contextPanelTab === "metadata" && note ? (
          <MetadataPanel note={note} />
        ) : contextPanelTab === "metadata" && !note ? (
          <Placeholder text="Select a note to view details" />
        ) : contextPanelTab === "agent" ? (
          <PanelChat />
        ) : contextPanelTab === "links" ? (
          <Placeholder text="Links view coming soon" />
        ) : contextPanelTab === "history" ? (
          <Placeholder text="Version history coming soon" />
        ) : null}
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="text-center pt-8" style={{ color: "var(--text-muted)" }}>
      {text}
    </div>
  );
}
