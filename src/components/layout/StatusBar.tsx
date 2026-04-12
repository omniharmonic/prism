import { useState } from "react";
import { Settings as SettingsIcon, RefreshCw } from "lucide-react";
import { useNotes, useServiceStatus } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { Settings } from "./Settings";
import { useQuery } from "@tanstack/react-query";
import { serviceApi, type BackgroundServiceStatus } from "../../lib/parachute/client";

export function StatusBar() {
  const { data: notes } = useNotes();
  const { data: services } = useServiceStatus();
  const { openTabs, activeTabId } = useUIStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const noteCount = notes?.length ?? 0;

  const { data: bgServices } = useQuery({
    queryKey: ["services", "background"],
    queryFn: serviceApi.getStatus,
    refetchInterval: 30_000,
  });

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
          {/* Background sync status */}
          {bgServices && bgServices.length > 0 && (
            <SyncIndicator services={bgServices} />
          )}
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

function SyncIndicator({ services }: { services: BackgroundServiceStatus[] }) {
  const [expanded, setExpanded] = useState(false);
  const running = services.filter((s) => s.running);
  const hasErrors = services.some((s) => s.last_error);

  return (
    <span className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 hover:opacity-80 transition-opacity"
        title={`Sync services: ${running.length}/${services.length} running`}
      >
        <RefreshCw
          size={10}
          className={running.length > 0 ? "animate-spin" : ""}
          style={{
            color: hasErrors ? "var(--color-warning)" : "var(--text-muted)",
            animationDuration: "3s",
          }}
        />
        <span>Sync {running.length}/{services.length}</span>
      </button>

      {expanded && (
        <div
          className="absolute bottom-full right-0 mb-1 w-64 rounded-lg py-1 z-50"
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--glass-border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <div className="px-3 py-1.5 text-[10px] font-medium" style={{ color: "var(--text-secondary)", borderBottom: "1px solid var(--glass-border)" }}>
            Background Sync Services
          </div>
          {services.map((svc) => (
            <div key={svc.name} className="px-3 py-1.5 flex items-start gap-2">
              <span
                className="w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0"
                style={{
                  background: svc.last_error
                    ? "var(--color-danger)"
                    : svc.running
                    ? "var(--color-success)"
                    : "var(--text-muted)",
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium" style={{ color: "var(--text-primary)" }}>{svc.name}</span>
                  <span style={{ color: "var(--text-muted)" }}>{svc.items_processed} items</span>
                </div>
                {svc.last_run && (
                  <div style={{ color: "var(--text-muted)", fontSize: "9px" }}>
                    Last: {new Date(svc.last_run).toLocaleTimeString()}
                  </div>
                )}
                {svc.last_error && (
                  <div className="truncate" style={{ color: "var(--color-danger)", fontSize: "9px" }}>
                    {svc.last_error}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
