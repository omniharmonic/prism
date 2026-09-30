// "Notify me when an agent finishes" — Settings → Account (WP3.3). Renders only
// when the shell provides a PushClient (web owner). The notification itself is
// generic and content-free; nothing about your prompts or answers leaves the server.
import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "../ui/Button";
import { usePush, type PushState } from "../../data/PushNotifications";

const HELP: Partial<Record<PushState, string>> = {
  unsupported: "This browser doesn't support push notifications.",
  "needs-install":
    "On iPhone/iPad, notifications only work for an installed app: tap Share → Add to Home Screen, open Prism from the Home Screen, then turn this on (iOS 16.4+).",
  "server-off": "Push isn't configured on this server yet (the owner needs to set VAPID keys — see docs/push.md).",
  denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then come back.",
};

export function PushSettings() {
  const push = usePush();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (push) setState(await push.state().catch(() => "unsupported" as PushState));
  }, [push]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (!push || !state) return null;

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const actionable = state === "off" || state === "on";

  return (
    <div style={{ border: "1px solid var(--glass-border)", borderRadius: 10, padding: 16, marginBottom: 16, background: "var(--glass-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Bell size={14} />
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>Notify me when an agent finishes</div>
      </div>
      {actionable ? (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-primary)" }}>
          <input
            type="checkbox"
            checked={state === "on"}
            disabled={busy}
            onChange={(e) => void (e.target.checked ? run(() => push.enable()) : run(() => push.disable()))}
          />
          {state === "on" ? "On for this browser" : "Off"}
        </label>
      ) : (
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>{HELP[state]}</p>
      )}
      {state === "on" && (
        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => push.test(), "Test sent — it should arrive in a moment.")}>
            Send a test notification
          </Button>
        </div>
      )}
      {msg && <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 0 0" }}>{msg}</p>}
      <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "10px 0 0" }}>
        Tapping the notification opens that agent session. The notification says only "Your agent finished" — no prompts or answers are sent through Apple or Google.
      </p>
    </div>
  );
}
