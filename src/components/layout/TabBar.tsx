import { X, PanelLeft, PanelRight, Sparkles, Settings } from "lucide-react";
import { useState } from "react";
import { useUIStore } from "../../app/stores/ui";
import { cn } from "../../lib/cn";
import { Settings as SettingsDialog } from "./Settings";

export function TabBar() {
  const {
    openTabs, activeTabId, setActiveTab, closeTab,
    sidebarOpen, toggleSidebar,
    contextPanelOpen, toggleContextPanel, setContextPanelTab,
  } = useUIStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <div
        className="flex items-center"
        style={{
          height: "var(--tab-bar-height)",
          borderBottom: "1px solid var(--glass-border)",
          background: "var(--bg-surface)",
        }}
      >
        {/* Sidebar toggle */}
        <button
          onClick={toggleSidebar}
          className="px-2 h-full hover:bg-[var(--glass-hover)] transition-colors flex-shrink-0"
          title={`${sidebarOpen ? "Hide" : "Show"} sidebar (⌘B)`}
        >
          <PanelLeft size={15} style={{ color: sidebarOpen ? "var(--text-secondary)" : "var(--text-muted)" }} />
        </button>

        {/* Tabs */}
        <div className="flex-1 flex items-center overflow-x-auto min-w-0">
          {openTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 h-full text-sm whitespace-nowrap transition-colors group relative",
                activeTabId === tab.id
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
              style={
                activeTabId === tab.id
                  ? { background: "var(--glass)" }
                  : undefined
              }
            >
              {tab.isDirty && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
              )}
              <span className="truncate max-w-[160px]">{tab.title}</span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="opacity-0 group-hover:opacity-100 hover:bg-[var(--glass-hover)] rounded p-0.5 transition-opacity"
              >
                <X size={12} />
              </span>
              {activeTabId === tab.id && (
                <div
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ background: "var(--color-accent)" }}
                />
              )}
            </button>
          ))}
        </div>

        {/* Right actions */}
        <div className="flex items-center flex-shrink-0">
          {/* Agent panel toggle */}
          <button
            onClick={() => {
              if (!contextPanelOpen) {
                setContextPanelTab("agent");
                toggleContextPanel();
              } else {
                setContextPanelTab("agent");
              }
            }}
            className="px-2 h-full hover:bg-[var(--glass-hover)] transition-colors"
            title="AI Agent (⌘\)"
          >
            <Sparkles size={15} style={{ color: contextPanelOpen ? "var(--color-accent)" : "var(--text-muted)" }} />
          </button>

          {/* Context panel toggle */}
          <button
            onClick={toggleContextPanel}
            className="px-2 h-full hover:bg-[var(--glass-hover)] transition-colors"
            title={`${contextPanelOpen ? "Hide" : "Show"} panel (⌘\\)`}
          >
            <PanelRight size={15} style={{ color: contextPanelOpen ? "var(--text-secondary)" : "var(--text-muted)" }} />
          </button>

          {/* Settings */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="px-2 h-full hover:bg-[var(--glass-hover)] transition-colors"
            title="Settings"
          >
            <Settings size={14} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
