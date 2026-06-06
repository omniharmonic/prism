import { useState } from "react";
import { requestMagicLink } from "../config";

/**
 * Sign-in screen. The browser never sees a vault token — you enter your email,
 * the Prism Server emails a one-time link, and clicking it starts a session.
 * Replaces the old ConnectScreen (which pasted a raw vault token into the page).
 */
export function LoginScreen({ notice }: { notice?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError("");
    try {
      await requestMagicLink(email.trim().toLowerCase());
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not send the sign-in link.");
    }
  }

  const field: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
    background: "var(--glass, rgba(255,255,255,0.04))",
    color: "var(--text-primary, rgba(255,255,255,0.92))",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        className="glass-elevated"
        style={{
          width: "100%",
          maxWidth: 400,
          padding: 28,
          borderRadius: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Sign in to Prism</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #888)" }}>
            Enter your email and we'll send you a one-time sign-in link.
          </p>
        </div>

        {notice && (
          <div style={{ fontSize: 13, color: "var(--text-muted, #888)" }}>{notice}</div>
        )}

        {status === "sent" ? (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            Check <strong>{email}</strong> for a sign-in link. You can close this tab; the link
            opens Prism signed in.
          </div>
        ) : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Email
              <input
                style={field}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </label>

            {status === "error" && (
              <div style={{ fontSize: 13, color: "var(--color-danger, #EB5757)" }}>{error}</div>
            )}

            <button
              type="submit"
              disabled={status === "sending" || !email.trim()}
              style={{
                marginTop: 4,
                padding: "11px 16px",
                borderRadius: 8,
                border: "none",
                background: "var(--color-accent, #6366f1)",
                color: "white",
                fontSize: 14,
                fontWeight: 600,
                cursor: status === "sending" ? "default" : "pointer",
                opacity: status === "sending" || !email.trim() ? 0.6 : 1,
              }}
            >
              {status === "sending" ? "Sending…" : "Email me a link"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
