import { useEffect, useState } from "react";
import { pendingCount, subscribe } from "./outbox";

/**
 * Small fixed pill that surfaces offline state and the number of writes queued
 * for replay. Hidden when online with an empty queue.
 */
export function OfflineIndicator() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const refresh = () => pendingCount().then(setPending).catch(() => {});
    const on = () => {
      setOnline(true);
      refresh();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const unsub = subscribe(refresh);
    refresh();
    const iv = window.setInterval(refresh, 5000);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      unsub();
      clearInterval(iv);
    };
  }, []);

  if (online && pending === 0) return null;

  const label = !online
    ? pending > 0
      ? `Offline · ${pending} change${pending > 1 ? "s" : ""} queued`
      : "Offline"
    : `Syncing ${pending} change${pending > 1 ? "s" : ""}…`;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        padding: "6px 14px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        background: online ? "var(--color-accent, #6366f1)" : "rgba(20,20,22,0.92)",
        color: "white",
        border: "1px solid var(--glass-border, rgba(255,255,255,0.18))",
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
      }}
    >
      {label}
    </div>
  );
}
