import { useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface Tab {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onChange, className }: TabsProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    // Horizontally scrollable so a strip too wide for the viewport (e.g. the
    // Network sub-tabs on mobile) scrolls instead of clipping. No visual change
    // when the tabs already fit. `scrollbar-none` hides the bar; buttons never
    // shrink so labels stay intact.
    <div
      role="tablist"
      aria-label="Views"
      className={cn("flex gap-0.5 overflow-x-auto scrollbar-none", className)}
      style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          tabIndex={activeTab === tab.id ? 0 : -1}
          ref={(node) => { buttons.current[index] = node; }}
          onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
              : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            onChange(tabs[next].id);
            buttons.current[next]?.focus();
          }}
          onClick={() => onChange(tab.id)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
            activeTab === tab.id
              ? "text-[var(--text-primary)] bg-[var(--glass-active)]"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--glass-hover)]",
          )}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
