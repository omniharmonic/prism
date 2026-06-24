import { X, PanelLeft, PanelRight, Bot } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { ShareButton } from "./ShareButton";

/** A square, quiet icon button for the top bar (rounded hover via .interactive). */
function IconButton({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="interactive focus-ring flex items-center justify-center flex-shrink-0"
      style={{ width: 30, height: 30, color: active ? "var(--text-secondary)" : "var(--text-muted)" }}
    >
      {children}
    </button>
  );
}

export function TabBar() {
  const {
    openTabs, activeTabId, setActiveTab, closeTab,
    sidebarOpen, toggleSidebar,
    contextPanelOpen, toggleContextPanel, setContextPanelTab,
  } = useUIStore();

  return (
    <div
      className="flex items-center gap-1"
      style={{
        height: "var(--tab-bar-height)",
        borderBottom: "1px solid var(--glass-border)",
        background: "var(--bg-surface)",
        padding: "0 8px",
      }}
    >
      {/* Sidebar toggle */}
      <IconButton onClick={toggleSidebar} title="Toggle sidebar (⌘B)" active={sidebarOpen}>
        <PanelLeft size={16} />
      </IconButton>

      {/* Tabs */}
      <div className="flex-1 flex items-center gap-1 overflow-x-auto min-w-0" style={{ paddingLeft: 2 }}>
        {openTabs.map((tab) => {
          const active = activeTabId === tab.id;
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveTab(tab.id);
                }
              }}
              className="interactive group flex items-center gap-1.5 flex-shrink-0"
              style={{
                height: 28,
                padding: "0 6px 0 10px",
                fontSize: "var(--text-sm)",
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                fontWeight: active ? 550 : 400,
                background: active ? "var(--surface-active)" : undefined,
              }}
            >
              {tab.isDirty && (
                <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--color-accent)", flexShrink: 0 }} />
              )}
              <span className="truncate" style={{ maxWidth: 160 }}>{tab.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                title="Close tab"
                className="interactive flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ width: 18, height: 18, color: "var(--text-muted)" }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <ShareButton />
        {/* Bot = opens Agent specifically */}
        <IconButton
          onClick={() => {
            if (!contextPanelOpen) {
              setContextPanelTab("agent");
              toggleContextPanel();
            } else {
              setContextPanelTab("agent");
            }
          }}
          title="AI Agent"
        >
          <Bot size={16} />
        </IconButton>
        {/* Panel toggle = opens Metadata by default */}
        <IconButton
          onClick={() => {
            if (!contextPanelOpen) setContextPanelTab("metadata");
            toggleContextPanel();
          }}
          title="Info panel (⌘\)"
          active={contextPanelOpen}
        >
          <PanelRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}
