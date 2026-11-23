// A compact, honest notice for a feature this shell can't offer (the web PWA /
// Prism Client hold no vault token and run no host process). Shown IN PLACE OF
// controls that would otherwise render but silently discard input. Gate with
// `useIsWeb()`. Since WP4.3 the legacy desktop is retired, so the copy points at
// where the feature lives now (usually the Prism Server), never at the desktop.
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
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{feature}</span> isn't available
        in this app.{" "}
        {detail ?? "It needs credentials or processes on the machine hosting your vault."}
      </div>
    </div>
  );
}
