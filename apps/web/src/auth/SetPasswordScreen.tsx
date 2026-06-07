import { useEffect, useState } from "react";
import { fetchMe, setPassword } from "../config";

/**
 * Set/replace your password while signed in (owner bootstrap, or anyone who
 * wants password login). Reached at /set-password — the owner's first email-link
 * sign-in lands here. Requires an active session; otherwise points back to login.
 */
export function SetPasswordScreen() {
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (me.authenticated && me.email) {
        setEmail(me.email);
        if (me.name) setName(me.name);
      }
      setLoading(false);
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setStatus("error");
      setError("Passwords don't match.");
      return;
    }
    setStatus("working");
    setError("");
    try {
      await setPassword(password, name.trim() || undefined);
      window.location.assign("/");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not set your password.");
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
        {loading ? (
          <p style={{ fontSize: 14, color: "var(--text-muted)" }}>…</p>
        ) : !email ? (
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Please sign in first</h1>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--text-muted, #888)" }}>
              <a href="/" style={{ color: "var(--color-accent)" }}>Go to sign in</a>
            </p>
          </div>
        ) : (
          <>
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Set a password</h1>
              <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #888)" }}>
                for <strong>{email}</strong> — so you can log in without an email link.
              </p>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Your name
              <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Password (10+ characters)
              <input style={field} type="password" value={password} onChange={(e) => setPasswordValue(e.target.value)} autoComplete="new-password" required />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Confirm password
              <input style={field} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </label>
            {status === "error" && <div style={{ fontSize: 13, color: "var(--color-danger, #EB5757)" }}>{error}</div>}
            <button
              type="submit"
              disabled={status === "working" || password.length < 10}
              style={{ marginTop: 4, padding: "11px 16px", borderRadius: 8, border: "none", background: "var(--color-accent, #6366f1)", color: "white", fontSize: 14, fontWeight: 600, cursor: "pointer", opacity: status === "working" || password.length < 10 ? 0.6 : 1 }}
            >
              {status === "working" ? "Saving…" : "Set password"}
            </button>
            <button type="button" onClick={() => window.location.assign("/")} style={{ background: "none", border: "none", color: "var(--text-muted, #888)", fontSize: 12, cursor: "pointer" }}>
              Skip for now
            </button>
          </>
        )}
      </form>
    </div>
  );
}
