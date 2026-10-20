// A small "new version available" banner. With the PWA in `prompt` mode, a new
// build installs but WAITS — it never swaps assets out from under a running
// session (which is what made styling vanish mid-session and left stale chunks
// rendering old code). When an update is ready we show this; clicking Reload
// calls updateServiceWorker(true), which activates the new SW and reloads once,
// cleanly, with a consistent asset set.
import { useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const [reloading, setReloading] = useState(false);

  // Robust reload. `updateServiceWorker(true)` posts SKIP_WAITING and reloads on
  // `controllerchange` — but that event only fires if the new SW takes control of
  // THIS tab. With clientsClaim off (we keep it off so a live session's assets are
  // never evicted mid-session), an UNCONTROLLED tab (e.g. right after a hard
  // refresh, or the first load after the SW was cleared) is never claimed, so
  // controllerchange never fires and the plain button did nothing. So: activate the
  // waiting SW, then GUARANTEE a reload ourselves. The fresh navigation is served
  // by the now-active new SW → fresh build. A short delay lets skipWaiting land.
  async function reload() {
    setReloading(true);
    try {
      await updateServiceWorker(true);
    } catch {
      /* fall through to the forced reload */
    }
    setTimeout(() => window.location.reload(), 700);
  }

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        borderRadius: 12,
        background: "var(--bg-surface, #1a1a1d)",
        border: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
        boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
        color: "var(--text-primary, #eee)",
        fontSize: 13,
      }}
    >
      <span>A new version of Prism is available.</span>
      <button
        onClick={() => void reload()}
        disabled={reloading}
        style={{
          padding: "5px 12px",
          borderRadius: 8,
          border: "none",
          cursor: reloading ? "default" : "pointer",
          fontSize: 12.5,
          fontWeight: 600,
          opacity: reloading ? 0.7 : 1,
          background: "var(--color-accent, #4f8ff7)",
          color: "white",
        }}
      >
        {reloading ? "Reloading…" : "Reload"}
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        aria-label="Dismiss"
        style={{
          padding: "5px 8px",
          borderRadius: 8,
          border: "none",
          cursor: "pointer",
          fontSize: 12.5,
          background: "transparent",
          color: "var(--text-muted, #999)",
        }}
      >
        Later
      </button>
    </div>
  );
}
