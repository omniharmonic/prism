// AgentAccessTokens — Settings → Account → "Agent access tokens" / "Connect your agent" (WP6.1, WP6.5).
// Lets the signed-in user mint a Prism MCP personal access token for an AI agent
// (Claude Code, Claude Desktop, any MCP client), bound to the ACTIVE vault and
// limited to what their own Prism account can see/do. The secret is shown ONCE,
// with paste-ready client config (Claude Code, Claude Desktop, generic) and a
// "Test connection" button; afterwards only its prefix is listed. The secret lives
// in component state only (never localStorage) and is dropped on Done / unmount.
import { useCallback, useEffect, useState } from "react";
import { Bot, Copy, Check, X, Plus, Plug } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useAccount, type AgentToken, type CreatedAgentToken } from "../../data/Account";

import { formatDate as fmtDate } from "../../lib/datetime/format";
const cardStyle = { border: "1px solid var(--glass-border)", borderRadius: 10, padding: 16, marginBottom: 16, background: "var(--glass-bg)" } as const;
const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 } as const;
const mutedStyle = { fontSize: 11.5, color: "var(--text-muted)" } as const;
const codeStyle = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 11.5,
  background: "var(--glass-active)",
  border: "1px solid var(--glass-border)",
  borderRadius: 6,
  padding: "8px 10px",
  margin: 0,
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-all" as const,
  color: "var(--text-primary)",
};
const selectStyle = {
  background: "var(--glass-bg)",
  color: "var(--text-primary)",
  border: "1px solid var(--glass-border)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
} as const;

function CopyBlock({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the text is selectable */
    }
  }, [text]);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ ...labelStyle, marginBottom: 0 }}>{title}</div>
        <Button variant="ghost" onClick={() => void copy()} title={`Copy ${title}`}>
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre style={codeStyle}>{text}</pre>
    </div>
  );
}

export function AgentAccessTokens() {
  const account = useAccount();
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedAgentToken | null>(null);
  const [vaults, setVaults] = useState<Array<{ id: string; label: string; active: boolean }>>([]);
  const [vaultId, setVaultId] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Drop the secret when the dialog/panel goes away.
  useEffect(() => () => setCreated(null), []);
  useEffect(() => {
    if (!account?.listAgentVaults) return;
    account.listAgentVaults().then((v) => {
      setVaults(v);
      setVaultId((cur) => cur || v.find((x) => x.active)?.id || v[0]?.id || "");
    }).catch(() => {});
  }, [account]);

  const load = useCallback(async () => {
    if (!account?.listAgentTokens) return;
    try {
      setTokens((await account.listAgentTokens()).tokens);
    } catch {
      setTokens(null); // older server without /auth/pats — hide the section
    }
  }, [account]);

  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    if (!account?.createAgentToken) return;
    setBusy(true);
    setError(null);
    try {
      setTestResult(null);
      setCreated(await account.createAgentToken({ label: label.trim() || undefined, scope, expiresInDays: days, ...(vaultId ? { vaultId } : {}) }));
      setLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create a token.");
    } finally {
      setBusy(false);
    }
  }, [account, label, scope, days, vaultId, load]);

  const testConnection = useCallback(async (token: string) => {
    if (!account?.testAgentConnection) return;
    setTesting(true);
    setTestResult(null);
    try {
      const { toolCount } = await account.testAgentConnection(token);
      setTestResult({ ok: true, text: `Connected: the endpoint exposes ${toolCount} tool${toolCount === 1 ? "" : "s"} to this token.` });
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : "Connection test failed." });
    } finally {
      setTesting(false);
    }
  }, [account]);

  const revoke = useCallback(async (t: AgentToken) => {
    if (!account?.revokeAgentToken) return;
    if (!window.confirm(`Revoke "${t.label ?? t.prefix}"? Any agent using it loses access immediately.`)) return;
    setError(null);
    try {
      await account.revokeAgentToken(t.id);
      if (created?.id === t.id) setCreated(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't revoke that token.");
    }
  }, [account, created, load]);

  if (!account?.listAgentTokens || tokens === null) return null;
  const fmt = (ms: number | null) => (ms ? fmtDate(new Date(ms), { dateStyle: "medium" }) : "never");

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Bot size={14} />
        <div style={{ ...labelStyle, marginBottom: 0 }}>Connect your agent</div>
      </div>
      <p style={{ ...mutedStyle, margin: "0 0 12px" }}>
        Connect an AI agent (Claude Code, Claude Desktop, any MCP client) to Prism. It acts as you, in the current
        vault, and can only see and change what your account can. Read-only tokens can't change anything.
      </p>

      {error && <div style={{ ...mutedStyle, color: "var(--color-error, #d33)", marginBottom: 8 }}>{error}</div>}

      {created && (
        <div style={{ border: "1px solid var(--color-accent)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              Copy your token now — it won't be shown again.
            </div>
            <Button variant="ghost" onClick={() => { setCreated(null); setTestResult(null); }} title="Done (discard the secret from this screen)">
              <X size={13} /> Done
            </Button>
          </div>
          <CopyBlock title="Token" text={created.token} />
          <CopyBlock title="Claude Code (terminal)" text={created.claudeCodeCommand} />
          <CopyBlock title="Claude Code .mcp.json" text={JSON.stringify(created.mcpJson, null, 2)} />
          <CopyBlock title="Claude Desktop (claude_desktop_config.json, via the mcp-remote bridge)" text={JSON.stringify(created.claudeDesktopJson, null, 2)} />
          <CopyBlock title="Any other MCP client (Streamable HTTP)" text={`URL:    ${created.url}\nHeader: Authorization: Bearer ${created.token}`} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
            {account?.testAgentConnection && (
              <Button onClick={() => void testConnection(created.token)} disabled={testing}>
                <Plug size={13} /> {testing ? "Testing…" : "Test connection"}
              </Button>
            )}
            {testResult && (
              <span style={{ ...mutedStyle, color: testResult.ok ? "var(--color-success, #2a9d5c)" : "var(--color-error, #d33)" }}>{testResult.text}</span>
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <Input placeholder="Label (e.g. laptop agent)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: "1 1 160px" }} />
        {vaults.length > 1 && (
          <select value={vaultId} onChange={(e) => setVaultId(e.target.value)} style={selectStyle} aria-label="Vault">
            {vaults.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        )}
        <select
          value={scope}
          onChange={(e) => {
            const s = e.target.value === "write" ? "write" : "read";
            setScope(s);
            if (s === "write" && days > 90) setDays(90); // write tokens: ≤ 90 days (server caps admin write tokens)
          }}
          style={selectStyle}
          aria-label="Access"
        >
          <option value="read">Read only</option>
          <option value="write">Read &amp; write</option>
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={selectStyle} aria-label="Expires">
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365} disabled={scope === "write"}>1 year</option>
        </select>
        <Button onClick={() => void create()} disabled={busy}><Plus size={13} /> Create token</Button>
      </div>

      {tokens.length === 0 ? (
        <p style={{ ...mutedStyle, margin: 0 }}>No agent tokens yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tokens.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--glass-border)", borderRadius: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.label ?? "Agent token"} <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{t.prefix}…</code>
                </div>
                <div style={mutedStyle}>
                  {t.scope === "write" ? "Read & write" : "Read only"} · vault {t.vaultId} · last used {fmt(t.lastUsedAt)} · expires {fmt(t.expiresAt)}
                </div>
              </div>
              <Button variant="ghost" onClick={() => void revoke(t)} title="Revoke this token">
                <X size={13} /> Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
