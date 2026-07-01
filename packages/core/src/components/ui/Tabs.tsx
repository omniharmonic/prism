import type { ReactNode } from "react";
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
  return (
    // Horizontally scrollable so a strip too wide for the viewport (e.g. the
    // Network sub-tabs on mobile) scrolls instead of clipping. No visual change
    // when the tabs already fit. `scrollbar-none` hides the bar; buttons never
    // shrink so labels stay intact.
    <div
      className={cn("flex gap-0.5 overflow-x-auto scrollbar-none", className)}
      style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
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
