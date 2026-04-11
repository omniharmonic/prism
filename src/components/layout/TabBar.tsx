import { X } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { cn } from "../../lib/cn";

export function TabBar() {
  const { openTabs, activeTabId, setActiveTab, closeTab } = useUIStore();

  if (openTabs.length === 0) return null;

  return (
    <div
      className="flex items-center overflow-x-auto"
      style={{
        height: "var(--tab-bar-height)",
        borderBottom: "1px solid var(--glass-border)",
        background: "var(--bg-surface)",
      }}
    >
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
  );
}
