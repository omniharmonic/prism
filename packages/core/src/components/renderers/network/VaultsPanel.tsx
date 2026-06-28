// VaultsPanel — the multi-vault connect/switch surface (Network → Vaults).
//
// Phase 1 (owner switcher): the Prism Server can front several Parachute vaults
// (configured via PRISM_VAULTS). This panel lists them and lets the owner switch
// which vault the app talks to — the choice is sent on every gateway call as
// `X-Prism-Vault` and persisted, so reloads stay put. Everything flows through
// the `useCollabSharing()` seam; no apps/web imports.
import { useCallback, useEffect, useState } from "react";
import { Database, Check, ArrowLeftRight, Plus } from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { useCollabSharing, type VaultSummary } from "../../../data/CollabSharing";

export function VaultsPanel() {
  const sharing = useCollabSharing();

  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sharing?.listVaults) return;
    setError(null);
    try {
      setVaults(await sharing.listVaults());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load vaults.");
    }
  }, [sharing]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await refresh();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  const activeId = sharing?.getActiveVault?.() ?? null;
  const isActive = useCallback(
    (v: VaultSummary) => (activeId ? v.id === activeId : v.active),
    [activeId],
  );

  const switchTo = useCallback(
    (v: VaultSummary) => {
      if (!sharing?.setActiveVault) return;
      setSwitching(v.id);
      // Repoints the client + reloads so every cached query refetches.
      sharing.setActiveVault(v.id);
    },
    [sharing],
  );

  // Guard: parent renders us only when listVaults exists, but be defensive.
  if (!sharing?.listVaults) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Multiple vaults aren't available on this shell.
      </div>
    );
  }

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "var(--text-muted)",
          fontSize: 13,
          padding: "32px 0",
        }}
      >
        <Spinner /> Loading vaults…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12.5,
            color: "var(--color-danger, #EB5757)",
            background: "color-mix(in srgb, var(--color-danger, #EB5757) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-danger, #EB5757) 30%, transparent)",
            borderRadius: "var(--radius-md, 10px)",
            padding: "10px 12px",
          }}
        >
          {error}
        </div>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SectionLabel>Connected vaults</SectionLabel>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {vaults.map((v) => {
            const active = isActive(v);
            return (
              <div
                key={v.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: 14,
                  background: "var(--glass)",
                  border: active
                    ? "1px solid var(--color-accent)"
                    : "1px solid var(--glass-border)",
                  borderRadius: "var(--radius-lg, 14px)",
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: active ? "var(--color-accent)" : "var(--glass-hover)",
                    color: active ? "white" : "var(--text-muted)",
                  }}
                >
                  <Database size={17} />
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text-primary)" }}>
                      {v.label}
                    </span>
                    {active && (
                      <Badge variant="success">
                        <Check size={11} /> Active
                      </Badge>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                    vault <span style={{ color: "var(--text-secondary)" }}>{v.vault}</span>
                  </div>
                </div>

                {!active && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ArrowLeftRight size={13} />}
                    loading={switching === v.id}
                    onClick={() => switchTo(v)}
                  >
                    Switch
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Connect another vault — Phase-1 is server-configured (PRISM_VAULTS). */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 16,
          background: "var(--glass)",
          border: "1px dashed var(--glass-border)",
          borderRadius: "var(--radius-lg, 14px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Plus size={15} style={{ color: "var(--text-muted)" }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Connect another vault
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.55 }}>
          Add a vault to <code style={{ fontFamily: "var(--font-mono, monospace)" }}>PRISM_VAULTS</code>{" "}
          on your Prism Server (id, label, url, vault name, token) and it appears here to switch into.
          Sharing and federation are scoped per-vault — an in-app “add vault” flow is on the way.
        </p>
      </section>

      <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
        Switching changes which vault every view reads and writes. Publications, share grants, and
        federation belong to the vault that owns them.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── helpers ──

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontWeight: 600,
        color: "var(--text-muted)",
      }}
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        style={{ opacity: 0.25 }}
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        style={{ opacity: 0.75 }}
      />
    </svg>
  );
}
