import { useState } from "react";
import { saveConnection, DEFAULT_VAULT_URL, DEFAULT_VAULT_NAME, type Connection } from "../config";

/**
 * First-run connection form. Collects the vault URL + name + bearer token,
 * verifies them against `GET /vault/{name}/api/vault`, then persists and hands
 * off to the app. Shown whenever there is no stored connection.
 */
export function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const [vaultUrl, setVaultUrl] = useState(DEFAULT_VAULT_URL);
  const [vaultName, setVaultName] = useState(DEFAULT_VAULT_NAME);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"idle" | "testing" | "error">("idle");
  const [error, setError] = useState("");

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setStatus("testing");
    setError("");
    const url = vaultUrl.trim().replace(/\/+$/, "").replace(/\/api$/, "");
    const name = vaultName.trim() || "default";
    try {
      const resp = await fetch(`${url}/vault/${name}/api/vault`, {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (!resp.ok) {
        throw new Error(
          resp.status === 401
            ? "Unauthorized — check your token."
            : `Vault responded ${resp.status}.`,
        );
      }
      const conn: Connection = { vaultUrl: url, vaultName: name, token: token.trim() };
      saveConnection(conn);
      onConnected();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not reach the vault.");
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
        onSubmit={connect}
        className="glass-elevated"
        style={{
          width: "100%",
          maxWidth: 420,
          padding: 28,
          borderRadius: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Connect to your vault</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #888)" }}>
            Point Prism at your Parachute vault. Your token stays in this browser.
          </p>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          Vault URL
          <input style={field} value={vaultUrl} onChange={(e) => setVaultUrl(e.target.value)} placeholder="https://vault.example.com" autoComplete="off" />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          Vault name
          <input style={field} value={vaultName} onChange={(e) => setVaultName(e.target.value)} placeholder="default" autoComplete="off" />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          Token
          <input style={field} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Bearer JWT" autoComplete="off" />
        </label>

        {status === "error" && (
          <div style={{ fontSize: 13, color: "var(--color-danger, #EB5757)" }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={status === "testing" || !token.trim()}
          style={{
            marginTop: 4,
            padding: "11px 16px",
            borderRadius: 8,
            border: "none",
            background: "var(--color-accent, #6366f1)",
            color: "white",
            fontSize: 14,
            fontWeight: 600,
            cursor: status === "testing" ? "default" : "pointer",
            opacity: status === "testing" || !token.trim() ? 0.6 : 1,
          }}
        >
          {status === "testing" ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}
