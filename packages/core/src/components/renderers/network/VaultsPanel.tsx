// VaultsPanel — the multi-vault connect/switch surface (Network → Vaults).
//
// Lists the vaults this Prism Server fronts, lets the owner switch the active one
// (Obsidian-style; the nav switcher shares the seam), and — the mini onboarding —
// CREATE a brand-new vault (the server shells out to the hub CLI + mints a token
// + optionally seeds starter tags) or LINK an existing/remote vault by url+token.
// Everything flows through the `useCollabSharing()` seam; no apps/web imports.
import { useCallback, useEffect, useState } from "react";
import { Database, Check, ArrowLeftRight, Plus, Sparkles, Link2, Trash2, X } from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
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
      sharing.setActiveVault(v.id); // repoints + reloads
    },
    [sharing],
  );

  const remove = useCallback(
    async (v: VaultSummary) => {
      if (!sharing?.removeVault) return;
      await sharing.removeVault(v.id);
      await refresh();
    },
    [sharing, refresh],
  );

  if (!sharing?.listVaults) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Multiple vaults aren't available on this shell.
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-muted)", fontSize: 13, padding: "32px 0" }}>
        <Spinner /> Loading vaults…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {error && <ErrBanner>{error}</ErrBanner>}

      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SectionLabel>Connected vaults</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {vaults.map((v, i) => {
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
                  border: active ? "1px solid var(--color-accent)" : "1px solid var(--glass-border)",
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
                    <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text-primary)" }}>{v.label}</span>
                    {active && (
                      <Badge variant="success">
                        <Check size={11} /> Active
                      </Badge>
                    )}
                    {i === 0 && <Badge variant="default">Primary</Badge>}
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
                {/* Primary (env) vault can't be removed; only added ones. */}
                {i !== 0 && sharing.removeVault && <RemoveVault vault={v} onRemove={() => remove(v)} />}
              </div>
            );
          })}
        </div>
      </section>

      {/* Add a vault — create new or link existing (mini onboarding). */}
      <AddVault sharing={sharing} onAdded={refresh} onSwitch={switchTo} />

      <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
        Switching changes which vault every view reads and writes. Publications, share grants, and
        federation belong to the vault that owns them.
      </p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── add a vault ──

function AddVault({
  sharing,
  onAdded,
  onSwitch,
}: {
  sharing: NonNullable<ReturnType<typeof useCollabSharing>>;
  onAdded: () => void | Promise<void>;
  onSwitch: (v: VaultSummary) => void;
}) {
  const canCreate = !!sharing.createVault;
  const canLink = !!sharing.linkVault;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "link">(canCreate ? "create" : "link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<VaultSummary | null>(null);

  // create fields
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [seedSchemas, setSeedSchemas] = useState(true);
  // link fields
  const [url, setUrl] = useState("");
  const [vaultName, setVaultName] = useState("");
  const [token, setToken] = useState("");

  if (!canCreate && !canLink) return null;

  const reset = () => {
    setOpen(false);
    setError(null);
    setCreated(null);
    setLabel("");
    setName("");
    setSeedSchemas(true);
    setUrl("");
    setVaultName("");
    setToken("");
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let v: VaultSummary;
      if (mode === "create") {
        v = await sharing.createVault!({ label: label.trim() || name.trim(), name: name.trim(), seedSchemas });
      } else {
        v = await sharing.linkVault!({ label: label.trim() || vaultName.trim(), url: url.trim(), vault: vaultName.trim(), token: token.trim() });
      }
      setCreated(v);
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the vault.");
    } finally {
      setBusy(false);
    }
  };

  const createValid = /^[a-z0-9_-]+$/.test(name.trim());
  const linkValid = /^https?:\/\//.test(url.trim()) && vaultName.trim() && token.trim();
  const valid = mode === "create" ? createValid : linkValid;

  if (!open) {
    return (
      <div>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setOpen(true)}>
          Create or link a vault
        </Button>
      </div>
    );
  }

  return (
    <section
      style={{
        background: "var(--glass)",
        border: "1px solid var(--glass-border)",
        borderRadius: "var(--radius-lg, 14px)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionLabel>{created ? "Vault ready" : "Add a vault"}</SectionLabel>
        <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={reset}>
          {created ? "Done" : "Cancel"}
        </Button>
      </div>

      {created ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Badge variant="success">
              <Check size={11} /> Added
            </Badge>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              <span style={{ color: "var(--text-primary)" }}>{created.label}</span> is connected and ready.
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" size="sm" icon={<ArrowLeftRight size={13} />} onClick={() => onSwitch(created)}>
              Switch to it
            </Button>
            <Button variant="ghost" size="sm" onClick={reset}>
              Stay here
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* mode toggle */}
          <div style={{ display: "flex", gap: 6 }}>
            {canCreate && (
              <ModeTab active={mode === "create"} onClick={() => setMode("create")} icon={<Sparkles size={13} />} label="Create new" />
            )}
            {canLink && (
              <ModeTab active={mode === "link"} onClick={() => setMode("link")} icon={<Link2 size={13} />} label="Link existing" />
            )}
          </div>

          {mode === "create" ? (
            <>
              <Field label="Name" hint="The vault id on your hub. Lowercase letters, numbers, - and _.">
                <Input placeholder="e.g. bioregional-commons" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
                {name.trim() && !createValid && <ErrText>Use only lowercase letters, numbers, - and _.</ErrText>}
              </Field>
              <Field label="Label" hint="Display name in the switcher (defaults to the name).">
                <Input placeholder="Bioregional Commons" value={label} onChange={(e) => setLabel(e.target.value)} />
              </Field>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-secondary)", cursor: "pointer" }}>
                <input type="checkbox" checked={seedSchemas} onChange={(e) => setSeedSchemas(e.target.checked)} />
                Seed the starter tag schemas (recommended)
              </label>
            </>
          ) : (
            <>
              <Field label="Label" hint="Display name in the switcher.">
                <Input placeholder="Shared research vault" value={label} onChange={(e) => setLabel(e.target.value)} />
              </Field>
              <Field label="Server URL" hint="The Parachute hub root, e.g. http://localhost:1940.">
                <Input placeholder="http://localhost:1940" value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <Field label="Vault name">
                <Input placeholder="default" value={vaultName} onChange={(e) => setVaultName(e.target.value)} />
              </Field>
              <Field label="Write token" hint="A hub-issued JWT (vault:<name>:write). Stored server-side, never in the browser.">
                <Input type="password" placeholder="eyJ…" value={token} onChange={(e) => setToken(e.target.value)} />
              </Field>
            </>
          )}

          {error && <ErrText>{error}</ErrText>}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              variant="primary"
              icon={mode === "create" ? <Sparkles size={15} /> : <Link2 size={15} />}
              loading={busy}
              disabled={!valid}
              onClick={submit}
            >
              {mode === "create" ? "Create vault" : "Link vault"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function RemoveVault({ vault, onRemove }: { vault: VaultSummary; onRemove: () => void | Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => setConfirming(true)} style={{ color: "var(--color-danger, #EB5757)" }}>
        Remove
      </Button>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
        Cancel
      </Button>
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onRemove();
          } finally {
            setBusy(false);
          }
        }}
        style={{ background: "var(--color-danger, #EB5757)", color: "white" }}
      >
        Remove {vault.label}
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── helpers ──

function ModeTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12.5,
        fontWeight: 550,
        padding: "6px 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--color-accent)" : "var(--glass-border)"}`,
        background: active ? "var(--color-accent-dim, var(--glass-hover))" : "transparent",
        color: active ? "var(--color-accent)" : "var(--text-secondary)",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-secondary)" }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, color: "var(--text-muted)" }}>
      {children}
    </div>
  );
}

function ErrText({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, color: "var(--color-danger, #EB5757)" }}>{children}</div>;
}

function ErrBanner({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" style={{ opacity: 0.25 }} />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" style={{ opacity: 0.75 }} />
    </svg>
  );
}
