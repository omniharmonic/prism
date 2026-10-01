import { isVaultNoteId } from "../../lib/noteIdentity";
import { lazy, Suspense } from "react";
import { useUIStore } from "../../app/stores/ui";
import { useNote } from "../../app/hooks/useParachute";
import { Tabs } from "../ui/Tabs";
import { MetadataPanel } from "./MetadataPanel";
import { PanelChat } from "../agent/PanelChat";
import { LinksPanel } from "./LinksPanel";
import { HistoryPanel } from "./HistoryPanel";
import { Spinner } from "../ui/Spinner";

const GraphPanel = lazy(() => import("./GraphPanel"));

const PANEL_TABS = [
  { id: "agent", label: "Agent" },
  { id: "details", label: "Details" },
  { id: "history", label: "Activity" },
];
const DETAIL_TABS = [
  { id: "metadata", label: "Properties" },
  { id: "links", label: "Links" },
  { id: "graph", label: "Graph" },
];

export function ContextPanel() {
  const { contextPanelTab, setContextPanelTab, openTabs, activeTabId } = useUIStore();
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const noteId = activeTab?.noteId;
  const { data: note } = useNote(isVaultNoteId(noteId) ? noteId : null);
  const section = contextPanelTab === "agent" || contextPanelTab === "history" ? contextPanelTab : "details";

  return (
    <div
      className="h-full min-h-0 flex flex-col"
      style={{
        background: "var(--bg-surface)",
        borderLeft: "1px solid var(--glass-border)",
      }}
    >
      <div className="p-2" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <Tabs
          tabs={PANEL_TABS}
          activeTab={section}
          onChange={(id) => setContextPanelTab(id === "details" ? "metadata" : id as typeof contextPanelTab)}
        />
      </div>

      {section === "details" && <div className="p-2 workspace-context-tabs">
        <Tabs tabs={DETAIL_TABS} activeTab={contextPanelTab} onChange={(id) => setContextPanelTab(id as typeof contextPanelTab)} />
      </div>}
      <div hidden={section !== "agent"} className={section === "agent" ? "flex-1 min-h-0 overflow-hidden" : "hidden"}>
        <PanelChat />
      </div>
      <div hidden={section === "agent"} className={section === "agent" ? "hidden" : contextPanelTab === "graph" ? "flex-1 min-h-0 overflow-hidden" : "workspace-panel-scroll flex-1 overflow-auto p-4"}>
        {contextPanelTab === "metadata" && note ? (
          <MetadataPanel note={note} />
        ) : contextPanelTab === "metadata" && !note ? (
          <Placeholder text="Select a note to view details" />
        ) : contextPanelTab === "links" && note ? (
          <LinksPanel noteId={note.id} />
        ) : contextPanelTab === "links" ? (
          <Placeholder text="Select a note to view links" />
        ) : contextPanelTab === "history" && note ? (
          <HistoryPanel note={note} />
        ) : contextPanelTab === "history" ? (
          <Placeholder text="Select a note to view history" />
        ) : contextPanelTab === "graph" && note ? (
          <Suspense
            fallback={
              <div className="flex justify-center items-center h-full">
                <Spinner size={20} />
              </div>
            }
          >
            <GraphPanel noteId={note.id} />
          </Suspense>
        ) : contextPanelTab === "graph" ? (
          <Placeholder text="Select a note to view its graph" />
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
