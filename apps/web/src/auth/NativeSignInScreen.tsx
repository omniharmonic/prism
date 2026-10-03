import { PrismMark } from "@prism/core/shell";
import { useEffect } from "react";
import { startNativeSignIn, getHost } from "../transport";
import { takeSignOutNotice } from "../config";

/** Keep native credential/network waits visible instead of a frozen boot label. */
export function NativeStartupScreen({ phase }: { phase: "credentials" | "connecting" }) {
  return <div role="main" style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
    <div className="workspace-auth-card" style={{ width: "100%", maxWidth: 400, padding: 28, borderRadius: 16 }}>
      <PrismMark width={72} height={48} decorative />
      <h1 style={{ margin: "16px 0 8px", fontSize: 22, fontWeight: 600 }}>Opening your workspace</h1>
      <p role="status" style={{ fontSize: 14, color: "var(--text-secondary)" }}>{phase === "credentials" ? "Checking your saved sign-in…" : "Connecting to your Prism server…"}</p>
      {phase === "credentials" && <p style={{ marginTop: 12, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>If your device shows a security prompt for Prism, respond there to continue.</p>}
    </div>
  </div>;
}

/**
 * Native-shell sign-in. There is no password form here: the shell runs the
 * OAuth/PKCE device flow in the system browser (docs/native-auth.md) and stores
 * the device token. The button just invokes the host hook. When the shell has
 * a token again it reloads the webview, or dispatches `prism:host-token` on
 * window — either way we re-boot so the auth gate re-checks /auth/me.
 */
const signedOutUnreached = takeSignOutNotice();

export function NativeSignInScreen({ notice }: { notice?: string }) {
  useEffect(() => {
    const reboot = () => window.location.reload();
    window.addEventListener("prism:host-token", reboot);
    return () => window.removeEventListener("prism:host-token", reboot);
  }, []);

  const hasHost = !!getHost();
  return (
    <div role="main" style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div
        className="workspace-auth-card"
        style={{ width: "100%", maxWidth: 400, padding: 28, borderRadius: 16, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <PrismMark width={72} height={48} decorative />
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Sign in to Prism</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, opacity: 0.65 }}>
            {signedOutUnreached ? "Signed out on this device. The server could not be reached, so this session may still be listed there until it expires — sign in and check Settings → Account when you are back online." : notice ?? "You'll sign in with your browser, then come straight back."}
          </p>
        </div>
        <button
          onClick={() => startNativeSignIn()}
          disabled={!hasHost}
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "none",
            cursor: hasHost ? "pointer" : "default",
            fontSize: 14,
            fontWeight: 600,
            background: "var(--action-bg)",
            color: "var(--action-fg)",
            opacity: hasHost ? 1 : 0.6,
          }}
        >
          Sign in
        </button>
        {!hasHost && (
          <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }}>
            This build expects to run inside the Prism app (no native host was found).
          </p>
        )}
      </div>
    </div>
  );
}
