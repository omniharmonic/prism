// VaultSwitcher — an Obsidian-style active-vault selector for the bottom of the
// side nav. Shows the current vault; click to open an upward popover listing the
// other configured vaults (switch repoints the whole app) plus a "Manage vaults"
// entry that opens the Network → Vaults surface (create/link a vault there).
//
// Only renders when the shell exposes the multi-vault seam (web owner). On the
// desktop shell (no listVaults) it returns null, so the footer keeps its plain
// New button.
import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, Check, Database, Settings2, Plus } from "lucide-react";
import { useCollabSharing, useVaultChangeSignal, type VaultSummary } from "../../data/CollabSharing";

export function VaultSwitcher({ onManage }: { onManage: () => void }) {
  const sharing = useCollabSharing();
  const vaultSignal = useVaultChangeSignal();
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sharing?.listVaults) return;
    let alive = true;
    sharing
      .listVaults()
      .then((v) => alive && setVaults(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // Re-load (and re-read the active vault) after a soft vault switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharing, vaultSignal]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!sharing?.listVaults) return null;

  const activeId = sharing.getActiveVault?.() ?? null;
  const active = vaults.find((v) => (activeId ? v.id === activeId : v.active)) ?? vaults[0];

  const switchTo = (v: VaultSummary) => {
    setOpen(false);
    if (v.id === active?.id) return;
    sharing.setActiveVault?.(v.id); // persists + reloads
  };

  return (
    <div ref={rootRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch vault"
        title="Switch vault"
        className="focus-ring"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 34,
          padding: "0 8px",
          borderRadius: "var(--radius-md)",
          background: open ? "var(--glass-hover)" : "transparent",
          border: "1px solid var(--glass-border)",
          cursor: "pointer",
          color: "var(--text-primary)",
          minWidth: 0,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--glass-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = open ? "var(--glass-hover)" : "transparent")}
      >
        <Database size={15} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "left",
            fontSize: "var(--text-base)",
            fontWeight: 550,
          }}
        >
          {active?.label ?? "Vault"}
        </span>
        <ChevronsUpDown size={14} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            right: 0,
            background: "var(--bg-surface)",
            border: "1px solid var(--glass-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
            padding: 4,
            zIndex: 50,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontWeight: 600,
              color: "var(--text-muted)",
              padding: "6px 8px 4px",
            }}
          >
            Vaults
          </div>
          {vaults.map((v) => {
            const isActive = v.id === active?.id;
            return (
              <button
                key={v.id}
                role="menuitem"
                onClick={() => switchTo(v)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  borderRadius: 7,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  color: "var(--text-primary)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--glass-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <Database size={14} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "var(--text-base)",
                  }}
                >
                  {v.label}
                </span>
                {isActive && <Check size={14} style={{ flexShrink: 0, color: "var(--color-accent)" }} />}
              </button>
            );
          })}

          <div style={{ height: 1, background: "var(--glass-border)", margin: "4px 0" }} />

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 8px",
              borderRadius: 7,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              color: "var(--text-secondary)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--glass-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <Plus size={14} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: "var(--text-base)" }}>Create or link a vault…</span>
            <Settings2 size={13} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
          </button>
        </div>
      )}
    </div>
  );
}
