import { useEffect } from "react";
import { startNativeSignIn, getHost } from "../transport";

/**
 * Native-shell sign-in. There is no password form here: the shell runs the
 * OAuth/PKCE device flow in the system browser (docs/native-auth.md) and stores
 * the device token. The button just invokes the host hook. When the shell has
 * a token again it reloads the webview, or dispatches `prism:host-token` on
 * window — either way we re-boot so the auth gate re-checks /auth/me.
 */
export function NativeSignInScreen({ notice }: { notice?: string }) {
  useEffect(() => {
    const reboot = () => window.location.reload();
    window.addEventListener("prism:host-token", reboot);
    return () => window.removeEventListener("prism:host-token", reboot);
  }, []);

  const hasHost = !!getHost();
  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div
        className="glass-elevated"
        style={{ width: "100%", maxWidth: 400, padding: 28, borderRadius: 16, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Sign in to Prism</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, opacity: 0.65 }}>
            {notice ?? "You'll sign in with your browser, then come straight back."}
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
            background: "var(--color-accent, #4f8ff7)",
            color: "white",
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
