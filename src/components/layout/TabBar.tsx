import { X, PanelLeft, PanelRight, Sparkles } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { cn } from "../../lib/cn";

export function TabBar() {
  const {
    openTabs, activeTabId, setActiveTab, closeTab,
    sidebarOpen, toggleSidebar,
    contextPanelOpen, toggleContextPanel, setContextPanelTab,
  } = useUIStore();

  return (
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
        title="Toggle sidebar (⌘B)"
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
            style={activeTabId === tab.id ? { background: "var(--glass)" } : undefined}
          >
            {tab.isDirty && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />}
            <span className="truncate max-w-[160px]">{tab.title}</span>
            <span
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              className="opacity-0 group-hover:opacity-100 hover:bg-[var(--glass-hover)] rounded p-0.5 transition-opacity"
            >
              <X size={12} />
            </span>
            {activeTabId === tab.id && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ background: "var(--color-accent)" }} />
            )}
          </button>
        ))}
      </div>

      {/* Right actions */}
      <div className="flex items-center flex-shrink-0">
        {/* Sparkles = opens Agent specifically */}
        <button
          onClick={() => {
            if (!contextPanelOpen) {
              setContextPanelTab("agent");
              toggleContextPanel();
            } else if (contextPanelOpen) {
              setContextPanelTab("agent");
            }
          }}
          className="px-2 h-full hover:bg-[var(--glass-hover)] transition-colors"
          title="AI Agent"
        >
          <Sparkles size={15} style={{ color: "var(--text-muted)" }} />
        </button>
        {/* Panel toggle = opens Metadata by default */}
        <button
          onClick={() => {
            if (!contextPanelOpen) setContextPanelTab("metadata");
            toggleContextPanel();
          }}
          className="px-2 h-full hover:bg-[var(--glass-hover)] transition-colors"
          title="Info panel (⌘\\)"
        >
          <PanelRight size={15} style={{ color: contextPanelOpen ? "var(--text-secondary)" : "var(--text-muted)" }} />
        </button>
      </div>
    </div>
  );
}
