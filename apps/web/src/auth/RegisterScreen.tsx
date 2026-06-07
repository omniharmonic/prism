import { useEffect, useState } from "react";
import { fetchInvite, register } from "../config";

/**
 * Accept-invite / create-account screen, reached via the emailed invite link
 * (/accept-invite?token=…). The email is fixed by the invite (proves the owner
 * invited *this* address); the recipient sets their name + password. On success
 * they're signed in and dropped into the app, seeing only what was shared.
 */
export function RegisterScreen({ token }: { token: string }) {
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const info = await fetchInvite(token);
      if (info.valid && info.email) {
        setEmail(info.email);
        if (info.name) setName(info.name);
      }
      setLoading(false);
    })();
  }, [token]);

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
      await register(token, name.trim(), password);
      window.location.assign("/"); // enter the app, signed in
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not create your account.");
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
          <p style={{ fontSize: 14, color: "var(--text-muted)" }}>Checking your invite…</p>
        ) : !email ? (
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>This invite isn't valid</h1>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--text-muted, #888)" }}>
              It may have expired or already been used. Ask for a fresh invite.
            </p>
          </div>
        ) : (
          <>
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Create your Prism account</h1>
              <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #888)" }}>
                for <strong>{email}</strong>
              </p>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Your name
              <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoComplete="name" required />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Password (10+ characters)
              <input style={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Confirm password
              <input style={field} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </label>

            {status === "error" && <div style={{ fontSize: 13, color: "var(--color-danger, #EB5757)" }}>{error}</div>}

            <button
              type="submit"
              disabled={status === "working" || !name.trim() || password.length < 10}
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
                opacity: status === "working" || !name.trim() || password.length < 10 ? 0.6 : 1,
              }}
            >
              {status === "working" ? "Creating…" : "Create account"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
