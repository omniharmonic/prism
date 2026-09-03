// ServerPanel — the server-owner operator surface (Network → Server). A config
// snapshot (no secret values), integration status, a narrow editable-.env
// allowlist (restart-required), and Cloudflare tunnel status + controls. The
// tunnel is a pm2 process; STOP takes the public site offline — heavily warned.
// Server/tunnel/config cards are server-owner-gated server-side; the sync-
// integrations card is admin+ and vault-scoped, so it must work even when
// /acl/server 403s (non-owner admin) — its state comes from the per-kind
// GET /api/integrations/<kind>, never the owner-only ServerInfo snapshot.
import { useCallback, useEffect, useState } from "react";
import { Server, Globe, Radio, RefreshCw, Square, Play, AlertTriangle, Save, CheckCircle2, XCircle, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
import { useCollabSharing, useVaultChangeSignal, type CollabSharing, type IntegrationStatus, type ServerInfo, type TunnelIngress } from "../../../data/CollabSharing";

const EDITABLE: { key: string; label: string; help: string; secret?: boolean }[] = [
  { key: "APP_ORIGIN", label: "App origin (public URL)", help: "The public https origin — must match the tunnel hostname. Changing it affects cookies; restart required." },
  { key: "MAGIC_FROM", label: "Email 'from' address", help: "Sender for magic-link / invite emails." },
  { key: "RESEND_API_KEY", label: "Resend API key", help: "Enables outbound email. Leave blank to log links to the console instead.", secret: true },
];

// ── Server-side sync integrations: which credential fields each kind takes.
// The row list is this registry merged with ServerInfo.integrations, so a kind
// the running server doesn't report yet (e.g. pre-restart) is still configurable.
interface IntegrationField {
  key: string;
  label: string;
  help?: string;
  secret?: boolean;
  required?: boolean;
  type?: "checkbox";
  default?: boolean;
}
const INTEGRATION_FIELDS: Record<string, IntegrationField[]> = {
  clickup: [
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "teamId", label: "Workspace ID", help: "blank = all workspaces" },
    { key: "spaceIds", label: "Space IDs (comma-sep)" },
    { key: "assignedOnly", label: "Only tasks assigned to me", type: "checkbox", default: true },
  ],
  fireflies: [{ key: "apiKey", label: "API key", secret: true, required: true }],
  fathom: [{ key: "apiKey", label: "API key", secret: true, required: true }],
  notion: [{ key: "apiKey", label: "API key", secret: true, required: true }],
  github: [{ key: "token", label: "Token", secret: true, required: true }],
  google: [{ key: "account", label: "Account", required: true }],
  matrix: [
    { key: "homeserver", label: "Homeserver", required: true },
    { key: "accessToken", label: "Access token", secret: true, required: true },
  ],
};
/** Kinds with a POST /api/integrations/<kind>/sync route. */
const SYNCABLE = new Set(["matrix", "fathom", "fireflies", "clickup"]);

/** One configurable integration row: badge header → expandable credential form. */
function IntegrationRow({ kind, configured, status, sharing, onNotice, onError, onChanged }: {
  kind: string;
  configured: boolean;
  status?: IntegrationStatus;
  sharing: CollabSharing;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const fields = INTEGRATION_FIELDS[kind] ?? [];
  const configurable = fields.length > 0 && !!sharing.setIntegrationCredential;

  // Prefill non-secret fields from the server's status echo so a key re-save
  // doesn't silently drop teamId/spaceIds or reset a checkbox to its default.
  const openForm = () => {
    setOpen((o) => {
      if (!o) {
        const seed: Record<string, string | boolean> = {};
        for (const f of fields) {
          const v = status?.[f.key];
          if (f.secret || v === undefined) continue;
          if (f.type === "checkbox" ? typeof v === "boolean" : typeof v === "string") seed[f.key] = v;
        }
        setValues(seed);
      }
      return !o;
    });
  };

  const str = (key: string) => String(values[key] ?? "").trim();
  const canSave = fields.filter((f) => f.required).every((f) => str(f.key));

  const save = async () => {
    if (!sharing.setIntegrationCredential) return;
    // PUT replaces the whole credential; optional blank strings are omitted.
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === "checkbox") payload[f.key] = (values[f.key] as boolean | undefined) ?? f.default ?? false;
      else if (str(f.key)) payload[f.key] = str(f.key);
    }
    setBusy("save");
    try {
      await sharing.setIntegrationCredential(kind, payload);
      setValues({});
      setOpen(false);
      onNotice(`${kind} credential saved.`);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : `Couldn't save the ${kind} credential.`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!sharing.deleteIntegrationCredential) return;
    if (!window.confirm(`Remove the stored ${kind} credential? Sync for it stops until a new one is saved.`)) return;
    setBusy("remove");
    try {
      await sharing.deleteIntegrationCredential(kind);
      setValues({});
      onNotice(`${kind} credential removed.`);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : `Couldn't remove the ${kind} credential.`);
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    if (!sharing.syncIntegration) return;
    setBusy("sync");
    try {
      const res = await sharing.syncIntegration(kind);
      const counts = Object.entries(res)
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => `${v} ${k}`)
        .join(" · ");
      onNotice(`${kind} sync: ${counts || "done"}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : `${kind} sync failed.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ border: "1px solid var(--glass-border)", borderRadius: 8, marginBottom: 8 }}>
      <button
        onClick={() => configurable && openForm()}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", background: "none", border: "none", cursor: configurable ? "pointer" : "default", color: "var(--text-primary)", fontSize: 12.5, textAlign: "left" }}
      >
        {configured ? <CheckCircle2 size={13} color="var(--color-success)" /> : <XCircle size={13} color="var(--text-secondary)" />}
        <span style={{ fontWeight: 600 }}>{kind}</span>
        <span style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>{configured ? "configured" : "not configured"}</span>
        {configurable && <span style={{ marginLeft: "auto", color: "var(--text-secondary)", display: "inline-flex" }}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>}
      </button>
      {open && configurable && (
        <div style={{ padding: "2px 10px 10px", borderTop: "1px solid var(--glass-border)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {fields.map((f) =>
              f.type === "checkbox" ? (
                <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={(values[f.key] as boolean | undefined) ?? f.default ?? false}
                    onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.checked }))}
                  />
                  {f.label}
                </label>
              ) : (
                <div key={f.key}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>
                    {f.label}
                    {f.required && <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}> (required)</span>}
                  </div>
                  <Input
                    type={f.secret ? "password" : "text"}
                    placeholder={f.secret && configured ? "configured — enter to replace" : ""}
                    value={String(values[f.key] ?? "")}
                    onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                  />
                  {f.help && <p style={{ color: "var(--text-secondary)", fontSize: 11.5, margin: "3px 0 0" }}>{f.help}</p>}
                </div>
              ),
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button onClick={() => void save()} disabled={!canSave || busy !== null}><Save size={13} /> Save</Button>
            {configured && SYNCABLE.has(kind) && !!sharing.syncIntegration && (
              <Button variant="ghost" onClick={() => void sync()} disabled={busy !== null}><RefreshCw size={13} /> {busy === "sync" ? "Syncing…" : "Sync now"}</Button>
            )}
            {configured && !!sharing.deleteIntegrationCredential && (
              <Button variant="ghost" onClick={() => void remove()} disabled={busy !== null}><Trash2 size={13} /> Remove</Button>
            )}
          </div>
          <p style={{ color: "var(--text-secondary)", fontSize: 11.5, margin: "8px 0 0" }}>
            Saving replaces the whole credential — stored values are never shown, so re-enter secrets when saving.
          </p>
        </div>
      )}
    </div>
  );
}

export function ServerPanel() {
  const sharing = useCollabSharing();
  const vaultSignal = useVaultChangeSignal();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  // Per-kind, vault-scoped configured-state (GET /api/integrations/<kind>) —
  // the same scope setIntegrationCredential's PUT writes to, and readable by a
  // non-owner admin. null = not loaded / seam absent.
  const [integrationStatus, setIntegrationStatus] = useState<Record<string, IntegrationStatus> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const [ingress, setIngress] = useState<TunnelIngress | null>(null);
  const refresh = useCallback(async () => {
    if (!sharing?.getServerInfo && !sharing?.getIntegrationStatus) return;
    setError(null);
    let infoError: string | null = null;
    if (sharing.getServerInfo) {
      try {
        setInfo(await sharing.getServerInfo());
        if (sharing.getTunnelIngress) setIngress(await sharing.getTunnelIngress().catch(() => null));
      } catch (e) {
        setInfo(null);
        infoError = e instanceof Error ? e.message : "Couldn't load server settings.";
      }
    }
    let statuses: Record<string, IntegrationStatus> | null = null;
    if (sharing.getIntegrationStatus) {
      const rows = await Promise.all(
        Object.keys(INTEGRATION_FIELDS).map(async (k) => {
          try {
            return [k, await sharing.getIntegrationStatus!(k)] as const;
          } catch {
            return null;
          }
        }),
      );
      const ok = rows.filter((r): r is readonly [string, IntegrationStatus] => r !== null);
      if (ok.length > 0) statuses = Object.fromEntries(ok);
    }
    setIntegrationStatus(statuses);
    // A non-owner admin can't read /acl/server (owner-only 403) but can still
    // manage integrations — don't surface that as a page-level error then.
    if (infoError && !statuses) setError(infoError);
  }, [sharing]);

  const applyIngress = useCallback(async () => {
    if (!sharing?.applyTunnelIngress) return;
    if (!window.confirm("Add ingress rules for your workspace subdomains and restart the tunnel? (It rolls back automatically if the tunnel doesn't come back online.)")) return;
    setBusy("ingress");
    setError(null);
    try {
      const res = await sharing.applyTunnelIngress();
      setNotice(res.added.length ? `Routed: ${res.added.join(", ")}.` : "All subdomains already routed.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update tunnel ingress.");
    } finally {
      setBusy(null);
    }
  }, [sharing, refresh]);

  // Re-read on vault switch too: the integration scope follows the active vault.
  useEffect(() => { void refresh(); }, [refresh, vaultSignal]);

  const saveConfig = useCallback(async (key: string) => {
    if (!sharing?.setServerConfig) return;
    const value = edits[key];
    if (value === undefined) return;
    setBusy(key);
    setError(null);
    try {
      const res = await sharing.setServerConfig(key, value);
      setNotice(res.restartRequired ? `${key} saved — restart the server for it to take effect.` : `${key} saved.`);
      setEdits((e) => { const { [key]: _drop, ...rest } = e; return rest; });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Couldn't save ${key}.`);
    } finally {
      setBusy(null);
    }
  }, [sharing, edits, refresh]);

  const tunnel = useCallback(async (action: "start" | "stop" | "restart") => {
    if (!sharing?.controlTunnel) return;
    if (action === "stop" && !window.confirm("Stopping the tunnel takes the PUBLIC site offline. If you're viewing this over the tunnel, you'll lose your connection. Continue?")) return;
    setBusy(`tunnel:${action}`);
    setError(null);
    try {
      const res = await sharing.controlTunnel(action);
      setInfo((prev) => (prev ? { ...prev, tunnel: res.tunnel } : prev));
      setNotice(`Tunnel ${action} requested.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Couldn't ${action} the tunnel.`);
    } finally {
      setBusy(null);
    }
  }, [sharing]);

  if (!sharing?.getServerInfo && !sharing?.getIntegrationStatus) {
    return <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Server settings aren't available here (server owner only).</p>;
  }

  const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 } as const;
  const cardStyle = { border: "1px solid var(--glass-border)", borderRadius: 10, padding: 16, marginBottom: 18, background: "var(--glass-bg)" } as const;
  const rowStyle = { display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", fontSize: 13, borderBottom: "1px solid var(--glass-border)" } as const;

  const t = info?.tunnel;
  const tunnelOnline = t?.status === "online";

  return (
    <div>
      {error && <Badge variant="error">{error}</Badge>}
      {notice && (
        <div style={{ ...cardStyle, display: "flex", gap: 8, alignItems: "center", color: "var(--text-primary)", fontSize: 13 }}>
          <CheckCircle2 size={14} /> {notice}
        </div>
      )}

      {/* Overview */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Server size={16} />
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Server</h2>
          <button onClick={() => void refresh()} title="Refresh" style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
            <RefreshCw size={14} />
          </button>
        </div>
        {info && (
          <div>
            <div style={rowStyle}><span style={{ color: "var(--text-secondary)" }}>Owner</span><span>{info.ownerEmail}</span></div>
            <div style={rowStyle}><span style={{ color: "var(--text-secondary)" }}>App origin</span><span>{info.appOrigin}</span></div>
            <div style={rowStyle}><span style={{ color: "var(--text-secondary)" }}>Parachute</span><span>{info.parachuteUrl} · {info.parachuteVault}</span></div>
            <div style={rowStyle}><span style={{ color: "var(--text-secondary)" }}>Vaults</span><span>{info.vaultCount}</span></div>
            <div style={rowStyle}><span style={{ color: "var(--text-secondary)" }}>Federation</span><span>{info.federationEnabled ? <Badge variant="success">on</Badge> : <Badge>off</Badge>}</span></div>
            <div style={rowStyle}><span style={{ color: "var(--text-secondary)" }}>Local-owner trust</span><span>{info.trustLocal ? <Badge variant="info">on</Badge> : <Badge>off</Badge>}</span></div>
            <div style={{ ...rowStyle, borderBottom: "none" }}><span style={{ color: "var(--text-secondary)" }}>Email delivery</span><span>{info.emailConfigured ? <Badge variant="success">Resend</Badge> : <Badge variant="warning">console only</Badge>}</span></div>
          </div>
        )}
      </div>

      {/* Integrations — known kinds merged with what the server reports, so a
          kind the running server predates (e.g. clickup) is still configurable.
          Configured-state prefers the per-kind vault-scoped status (matches
          where Save writes, and works for non-owner admins); the owner-only
          ServerInfo snapshot (primary vault) is only a fallback. */}
      {(integrationStatus || info) && (
        <div style={cardStyle}>
          <div style={labelStyle}>Sync integrations ({sharing.getActiveVault?.() ?? "primary"} vault)</div>
          {[...new Set([...Object.keys(INTEGRATION_FIELDS), ...Object.keys(info?.integrations ?? {})])].map((k) => (
            <IntegrationRow
              key={k}
              kind={k}
              configured={integrationStatus ? !!integrationStatus[k]?.configured : !!info?.integrations[k]}
              status={integrationStatus?.[k]}
              sharing={sharing}
              onNotice={(m) => { setError(null); setNotice(m); }}
              onError={(m) => { setNotice(null); setError(m); }}
              onChanged={refresh}
            />
          ))}
          {(integrationStatus
            ? Object.values(integrationStatus).some((s) => !s.secretsAvailable)
            : info && !info.secretsAvailable) && (
            <p style={{ color: "var(--color-warning)", fontSize: 12, marginTop: 8 }}>SECRETS_KEY is not set — server-side sync is disabled.</p>
          )}
        </div>
      )}

      {/* Cloudflare tunnel */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Radio size={15} />
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Cloudflare tunnel</h2>
          {t && (tunnelOnline ? <Badge variant="success">online</Badge> : <Badge variant={t.managed ? "warning" : "default"}>{t.status ?? (t.managed ? "stopped" : "unmanaged")}</Badge>)}
        </div>
        {t?.hostname && (
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <Globe size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />
            <a href={`https://${t.hostname}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{t.hostname}</a>
          </div>
        )}
        {t && !t.managed && <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "4px 0" }}>{t.detail ?? "Tunnel not managed by pm2 on this host."}</p>}
        {t?.managed && (
          <>
            <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "4px 0 10px" }}>Process <code>{t.name}</code> · restarts: {t.restarts ?? 0}</p>
            <div style={{ display: "flex", gap: 8 }}>
              <Button onClick={() => void tunnel("restart")} disabled={busy === "tunnel:restart"}><RefreshCw size={13} /> Restart</Button>
              {tunnelOnline ? (
                <Button variant="ghost" onClick={() => void tunnel("stop")} disabled={busy === "tunnel:stop"}><Square size={13} /> Stop</Button>
              ) : (
                <Button onClick={() => void tunnel("start")} disabled={busy === "tunnel:start"}><Play size={13} /> Start</Button>
              )}
            </div>
            <p style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--color-warning)", fontSize: 11.5, margin: "10px 0 0" }}>
              <AlertTriangle size={13} /> Stopping the tunnel takes the public site offline for everyone.
            </p>
          </>
        )}
      </div>

      {/* Workspace subdomain routing (ingress) */}
      {ingress && (
        <div style={cardStyle}>
          <div style={labelStyle}>Workspace subdomains</div>
          {ingress.missing.length === 0 ? (
            <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: 0 }}>
              Every workspace subdomain is routed through the tunnel. Set a subdomain on a workspace (Network → Workspaces)
              to serve it here.
            </p>
          ) : (
            <>
              <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 10px" }}>
                These workspace subdomains need routing: <strong>{ingress.missing.join(", ")}</strong>. Two steps —
                (1) create the DNS route (run per hostname), then (2) add the ingress rule + restart the tunnel.
              </p>
              {ingress.routeDnsCommands.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 4 }}>1. DNS route (run in your terminal):</div>
                  <pre style={{ fontSize: 11.5, background: "var(--glass-active)", borderRadius: 6, padding: "8px 10px", overflowX: "auto", margin: 0 }}>
                    {ingress.routeDnsCommands.join("\n")}
                  </pre>
                </div>
              )}
              <Button onClick={() => void applyIngress()} disabled={busy === "ingress"}>
                <Radio size={13} /> 2. Add ingress rules &amp; restart tunnel
              </Button>
              <p style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--color-warning)", fontSize: 11.5, margin: "10px 0 0" }}>
                <AlertTriangle size={13} /> Restarts the tunnel (brief blip). Auto-rolls-back if it doesn't come back online.
              </p>
            </>
          )}
        </div>
      )}

      {/* Editable config (restart-required) */}
      <div style={cardStyle}>
        <div style={labelStyle}>App settings</div>
        <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 12px" }}>
          These write to the server's <code>.env</code> (backed up first) and take effect after a restart. Secrets and the
          owner email aren't editable here for safety.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {EDITABLE.map((f) => {
            const current = f.key === "APP_ORIGIN" ? info?.appOrigin : f.key === "MAGIC_FROM" ? info?.magicFrom : info?.emailConfigured ? "•••• configured" : "";
            const dirty = edits[f.key] !== undefined;
            return (
              <div key={f.key}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{f.label}</span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Input
                    type={f.secret ? "password" : "text"}
                    placeholder={f.secret ? (current || "not set") : (current ?? "")}
                    value={edits[f.key] ?? (f.secret ? "" : (current ?? ""))}
                    onChange={(e) => setEdits((s) => ({ ...s, [f.key]: e.target.value }))}
                    style={{ flex: 1 }}
                  />
                  <Button onClick={() => void saveConfig(f.key)} disabled={!dirty || busy === f.key}><Save size={13} /> Save</Button>
                </div>
                <p style={{ color: "var(--text-secondary)", fontSize: 11.5, margin: "4px 0 0" }}>{f.help}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
