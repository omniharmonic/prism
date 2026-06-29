// A compact, honest notice for features that only work in the desktop (Tauri)
// shell because they need host credentials/CLIs/processes the browser can't
// reach (Matrix, Google/`gog`, GitHub/`gh`, Notion sync, Claude CLI, native
// config/Keychain). Shown in the web/PWA shell IN PLACE OF controls that would
// otherwise render but silently discard input. Gate with `useIsWeb()`.
import { Monitor } from "lucide-react";

export function DesktopOnlyNotice({ feature, detail }: { feature: string; detail?: string }) {
  return (
    <div
      role="note"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "12px 14px",
        borderRadius: "var(--radius-md, 10px)",
        border: "1px dashed var(--glass-border)",
        background: "var(--glass)",
        color: "var(--text-secondary)",
      }}
    >
      <Monitor size={16} style={{ flexShrink: 0, marginTop: 1, color: "var(--text-muted)" }} />
      <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{feature}</span> is managed in
        the Prism desktop app.{" "}
        {detail ?? "It needs credentials and processes on the machine hosting your vault, so it isn't available in the browser."}
      </div>
    </div>
  );
}
