/**
 * Sidebar account menu (wave 3): who is signed in, a way into Settings → Account,
 * and Sign out. Rendered only when the shell provides an AccountClient that can
 * sign out (web / Prism Client); without one (the legacy desktop) a plain Settings row.
 */
import { useEffect, useRef, useState } from "react";
import { CircleUser, LogOut, Settings2 } from "lucide-react";
import { useAccount } from "../../data/Account";
import { useUIStore } from "../../app/stores/ui";

export function AccountMenu() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    account?.getProfile().then((p) => { if (live) setName(p.name?.trim() || p.email || null); }).catch(() => undefined);
    return () => { live = false; };
  }, [account]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);

  // No account to sign out of (the legacy desktop): Settings still needs a way in — it used to be
  // the status bar's gear, removed in w16.
  if (!account?.signOut) return (
    <div className="workspace-account">
      <div className="workspace-nav-row group flex items-center" style={{ color: "var(--text-secondary)", fontSize: "var(--text-base)" }}>
        <button type="button" onClick={() => useUIStore.getState().setSettingsOpen(true)}
          className="interactive focus-ring flex flex-1 min-w-0 items-center gap-2.5 text-left" style={{ minHeight: "var(--workspace-control-height)", padding: "0 10px" }}>
          <span className="flex items-center justify-center flex-shrink-0" style={{ width: 16, color: "var(--text-muted)" }}><Settings2 size={16} /></span>
          <span className="flex-1 truncate">Settings</span>
        </button>
      </div>
    </div>
  );
  const signOut = async () => {
    setBusy(true);
    try { await account.signOut!(); } finally { setBusy(false); setOpen(false); }
  };
  const item = "interactive focus-ring flex w-full items-center gap-2.5 text-left";
  const itemStyle = { minHeight: "var(--workspace-control-height)", padding: "0 10px", borderRadius: "var(--radius-sm)", fontSize: "var(--text-base)", color: "var(--text-primary)" } as const;
  return (
    <div ref={root} className="workspace-account" style={{ position: "relative" }}>
      <div className="workspace-nav-row group flex items-center" style={{ color: "var(--text-secondary)", fontSize: "var(--text-base)" }}>
        <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen((v) => !v)}
          className="interactive focus-ring flex flex-1 min-w-0 items-center gap-2.5 text-left" style={{ minHeight: "var(--workspace-control-height)", padding: "0 10px" }}>
          <span className="flex items-center justify-center flex-shrink-0" style={{ width: 16, color: "var(--text-muted)" }}><CircleUser size={16} /></span>
          <span className="flex-1 truncate">{name ?? "Account"}</span>
        </button>
      </div>
      {open && (
        <div role="menu" aria-label="Account" className="glass-elevated"
          style={{ position: "absolute", left: 6, right: 6, bottom: "calc(100% + 4px)", padding: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)", zIndex: 30 }}>
          <button type="button" role="menuitem" className={item} style={itemStyle}
            onClick={() => { setOpen(false); useUIStore.getState().setSettingsOpen(true); }}>
            <Settings2 size={15} style={{ color: "var(--text-muted)" }} /> Settings
          </button>
          <button type="button" role="menuitem" className={item} style={itemStyle} disabled={busy} onClick={() => void signOut()}>
            <LogOut size={15} style={{ color: "var(--text-muted)" }} /> {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
