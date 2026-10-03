// Settings → Account, iOS app only (WP5): the Face ID / passcode lock and the
// server this app is bound to. Provided through core's ShellSettings seam.
// The shell owns every native prompt: changing the lock while one is on asks
// for Face ID first; "Sign out & change server" shows a native confirmation.
import { useCallback, useEffect, useState } from "react";
import { clearReadCache } from "../offline/readCache";
import { iosShell, shellError, type AppSettings, type LockMode } from "./ios";

type Choice = "off" | "launch" | "background-5" | "background-15" | "background-60" | "always";

const CHOICES: Array<{ value: Choice; label: string }> = [
  { value: "off", label: "Off" },
  { value: "launch", label: "When Prism opens" },
  { value: "background-5", label: "After 5 minutes in the background" },
  { value: "background-15", label: "After 15 minutes in the background" },
  { value: "background-60", label: "After 1 hour in the background" },
  { value: "always", label: "Every time Prism comes back" },
];

export function choiceOf(mode: LockMode, minutes: number): Choice {
  if (mode === "background") return (`background-${[5, 15, 60].includes(minutes) ? minutes : 5}` as Choice);
  return mode;
}

export function lockOf(choice: Choice): { mode: LockMode; minutes: number } {
  const m = choice.match(/^background-(\d+)$/);
  return m ? { mode: "background", minutes: Number(m[1]) } : { mode: choice as LockMode, minutes: 5 };
}

const BIOMETRY: Record<string, string> = { faceID: "Face ID", touchID: "Touch ID", opticID: "Optic ID" };

const card = {
  border: "1px solid var(--glass-border)",
  borderRadius: 10,
  padding: 16,
  marginBottom: 16,
  background: "var(--glass-bg)",
} as const;
const heading = { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 10 } as const;
const help = { fontSize: 12.5, color: "var(--text-muted)", margin: "8px 0 0", lineHeight: 1.5 } as const;

export function IosAppSettings() {
  const shell = iosShell();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shell) return;
    try {
      setSettings(await shell.appSettings());
    } catch (e) {
      setMsg(shellError(e));
    }
  }, [shell]);
  useEffect(() => void load(), [load]);

  if (!shell || !settings) return null;
  const method = BIOMETRY[settings.biometry] ?? "your passcode";

  const changeLock = async (choice: Choice) => {
    setBusy(true);
    setMsg(null);
    try {
      const { mode, minutes } = lockOf(choice);
      const lock = await shell.setAppLock(mode, minutes);
      setSettings({ ...settings, lock });
    } catch (e) {
      setMsg(shellError(e));
    } finally {
      setBusy(false);
    }
  };

  const changeServer = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // Drop this server's cached reads first: on success the shell signs out,
      // clears the server and reloads the page itself (also after a partial failure).
      await clearReadCache().catch(() => {});
      await shell.resetServer(); // false = cancelled in the native dialog
    } catch (e) {
      setMsg(shellError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={card}>
        <div style={heading}>Security</div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--text-primary)" }}>
          Lock Prism with {method}
          <select
            value={choiceOf(settings.lock.mode, settings.lock.minutes)}
            disabled={busy}
            onChange={(e) => void changeLock(e.target.value as Choice)}
            // 16px: no zoom-on-focus on iOS.
            style={{ fontSize: 16, padding: "8px 10px", borderRadius: 8, background: "var(--surface-sunken, transparent)", color: "inherit", border: "1px solid var(--glass-border)" }}
          >
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <p style={help}>
          {settings.passcodeSet
            ? `While locked, Prism shows a cover instead of your notes (also in the app switcher). ${method === "your passcode" ? "Your passcode" : `${method}, or your passcode,`} unlocks it.`
            : "Set a device passcode in the iOS Settings app to use the lock."}
          {settings.lock.mode !== "off" && " Changing this setting asks you to unlock first."}
        </p>
      </div>

      <div style={card}>
        <div style={heading}>Server</div>
        <div style={{ fontSize: 13, color: "var(--text-primary)", wordBreak: "break-all" }}>{settings.serverOrigin}</div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void changeServer()}
          style={{ marginTop: 10, fontSize: 15, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--glass-border)", background: "transparent", color: "var(--danger, #ff8080)" }}
        >
          Sign out & change server…
        </button>
        <p style={help}>Signs this device out of the server above, then asks for a server address again.</p>
      </div>
      {msg && <p style={{ ...help, marginTop: -8, marginBottom: 16 }}>{msg}</p>}
    </>
  );
}
