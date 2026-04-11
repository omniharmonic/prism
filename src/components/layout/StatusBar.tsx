import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { useNotes, useServiceStatus } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { Settings } from "./Settings";

export function StatusBar() {
  const { data: notes } = useNotes();
  const { data: services } = useServiceStatus();
  const { openTabs, activeTabId } = useUIStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const noteCount = notes?.length ?? 0;

  return (
    <>
      <div
        className="flex items-center justify-between px-3 text-xs flex-shrink-0"
        style={{
          height: "var(--status-bar-height)",
          background: "var(--bg-surface)",
          borderTop: "1px solid var(--glass-border)",
          color: "var(--text-muted)",
        }}
      >
        {/* Left */}
        <div className="flex items-center gap-3">
          <span>Vault: {noteCount} notes</span>
          {activeTab && <span>{activeTab.type}</span>}
        </div>

        {/* Right */}
        <div className="flex items-center gap-3">
          <StatusDot ok={services?.parachute ?? false} label="Parachute" />
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-0.5 rounded hover:bg-[var(--glass-hover)] transition-colors"
            title="Settings"
          >
            <SettingsIcon size={12} />
          </button>
        </div>
      </div>

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: ok ? "var(--color-success)" : "var(--color-danger)" }}
      />
      {label}
    </span>
  );
}
