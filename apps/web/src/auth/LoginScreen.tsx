import { useState } from "react";
import { login, requestMagicLink } from "../config";

/**
 * Sign-in screen. Prism is invite-only: people log in with the email + password
 * they set when accepting an invite. The owner can also request a one-time email
 * link (bootstrap / recovery). No self-signup — entering an unknown email does
 * nothing.
 */
export function LoginScreen({ notice }: { notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "linksent" | "error">("idle");
  const [error, setError] = useState("");
  const [linkMode, setLinkMode] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("working");
    setError("");
    try {
      if (linkMode) {
        await requestMagicLink(email.trim().toLowerCase());
        setStatus("linksent");
      } else {
        await login(email.trim().toLowerCase(), password);
        window.location.assign("/"); // re-enter the app with a session
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Sign-in failed.");
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
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <form
        onSubmit={submit}
        className="glass-elevated"
        style={{ width: "100%", maxWidth: 400, padding: 28, borderRadius: 16, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Sign in to Prism</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #888)" }}>
            {linkMode ? "We'll email you a one-time sign-in link." : "Prism is invite-only — log in with your account."}
          </p>
        </div>

        {notice && <div style={{ fontSize: 13, color: "var(--text-muted, #888)" }}>{notice}</div>}

        {status === "linksent" ? (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            If <strong>{email}</strong> is allowed, a sign-in link is on its way. You can close this tab.
          </div>
        ) : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Email
              <input style={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
            </label>

            {!linkMode && (
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                Password
                <input style={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required />
              </label>
            )}

            {status === "error" && <div style={{ fontSize: 13, color: "var(--color-danger, #EB5757)" }}>{error}</div>}

            <button
              type="submit"
              disabled={status === "working" || !email.trim() || (!linkMode && !password)}
              style={{
                marginTop: 4,
                padding: "11px 16px",
                borderRadius: 8,
                border: "none",
                background: "var(--color-accent, #6366f1)",
                color: "white",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                opacity: status === "working" || !email.trim() || (!linkMode && !password) ? 0.6 : 1,
              }}
            >
              {status === "working" ? "…" : linkMode ? "Email me a link" : "Log in"}
            </button>

            <button
              type="button"
              onClick={() => {
                setLinkMode((m) => !m);
                setStatus("idle");
                setError("");
              }}
              style={{ background: "none", border: "none", color: "var(--text-muted, #888)", fontSize: 12, cursor: "pointer", textAlign: "center" }}
            >
              {linkMode ? "← Back to password login" : "Owner? Email me a sign-in link instead"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
