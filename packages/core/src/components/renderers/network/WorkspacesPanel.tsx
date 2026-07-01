// WorkspacesPanel — the server-owner surface (Network → Workspaces) for the
// "one server, many workspaces" model. A workspace groups one-or-more vaults +
// a subdomain. Here the owner creates workspaces, sets each one's public
// subdomain, and assigns vaults to them. Members stay per-vault (managed in the
// Workspace/Members surfaces). Server-owner-gated; hides when the seam lacks
// listWorkspaceEntities (desktop / non-server-owner).
import { useCallback, useEffect, useState } from "react";
import { Building2, Plus, Trash2, Globe, Database, Save, ArrowRightLeft } from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
import { useCollabSharing, type WorkspaceEntity, type VaultSummary } from "../../../data/CollabSharing";

export function WorkspacesPanel() {
  const sharing = useCollabSharing();
  const [workspaces, setWorkspaces] = useState<WorkspaceEntity[]>([]);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newHost, setNewHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [hostEdits, setHostEdits] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!sharing?.listWorkspaceEntities) return;
    setError(null);
    try {
      setWorkspaces(await sharing.listWorkspaceEntities());
      if (sharing.listVaults) setVaults(await sharing.listVaults());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load workspaces.");
    }
  }, [sharing]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(async () => {
    if (!sharing?.createWorkspaceEntity || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await sharing.createWorkspaceEntity(newName.trim(), newHost.trim() || undefined);
      setNewName("");
      setNewHost("");
      setNotice("Workspace created.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create workspace.");
    } finally {
      setBusy(false);
    }
  }, [sharing, newName, newHost, refresh]);

  const saveHost = useCallback(async (id: string) => {
    if (!sharing?.updateWorkspaceEntity) return;
    try {
      await sharing.updateWorkspaceEntity(id, { hostname: hostEdits[id] ? hostEdits[id]!.trim() : null });
      setNotice("Subdomain saved.");
      setHostEdits((e) => { const { [id]: _drop, ...rest } = e; return rest; });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save subdomain.");
    }
  }, [sharing, hostEdits, refresh]);

  const assignVault = useCallback(async (workspaceId: string, vaultId: string) => {
    if (!sharing?.assignVaultToWorkspaceEntity || !vaultId) return;
    try {
      await sharing.assignVaultToWorkspaceEntity(workspaceId, vaultId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't move vault.");
    }
  }, [sharing, refresh]);

  const remove = useCallback(async (id: string) => {
    if (!sharing?.deleteWorkspaceEntity) return;
    if (!window.confirm("Delete this workspace? Its vaults return to the Default workspace.")) return;
    try {
      await sharing.deleteWorkspaceEntity(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete workspace.");
    }
  }, [sharing, refresh]);

  if (!sharing?.listWorkspaceEntities) {
    return <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Workspace management isn't available here (server owner only).</p>;
  }

  const cardStyle = { border: "1px solid var(--glass-border)", borderRadius: 10, padding: 16, marginBottom: 16, background: "var(--glass-bg)" } as const;
  const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 } as const;
  const selectStyle = { fontSize: 12, padding: "4px 6px", borderRadius: 6, background: "var(--glass-bg)", color: "var(--text-primary)", border: "1px solid var(--glass-border)" } as const;

  // Vaults available to move INTO a workspace = those not already in it.
  const otherVaults = (ws: WorkspaceEntity) => vaults.filter((v) => !ws.vaults.some((wv) => wv.id === v.id));

  return (
    <div>
      {error && <Badge variant="error">{error}</Badge>}
      {notice && <div style={{ ...cardStyle, fontSize: 13, color: "var(--text-primary)" }}>{notice}</div>}

      <div style={{ ...cardStyle, display: "flex", gap: 10, alignItems: "flex-start" }}>
        <Building2 size={16} style={{ marginTop: 2 }} />
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Workspaces</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: 0 }}>
            One server, many workspaces. Each groups its own vault(s) and is served on its own subdomain — with its own
            members (managed per vault). Point a Cloudflare hostname at this server for each subdomain.
          </p>
        </div>
      </div>

      {/* Create */}
      <div style={cardStyle}>
        <div style={labelStyle}>New workspace</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Input placeholder="Name (e.g. Spirit of the Front Range)" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <Input placeholder="subdomain (optional, e.g. sotfr.you.com)" value={newHost} onChange={(e) => setNewHost(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <Button onClick={() => void create()} disabled={busy || !newName.trim()}><Plus size={14} /> Create</Button>
        </div>
      </div>

      {/* List */}
      {workspaces.map((ws) => (
        <div key={ws.id} style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Building2 size={15} />
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{ws.name}</h3>
            {ws.isDefault && <Badge>default</Badge>}
            {!ws.isDefault && (
              <button onClick={() => void remove(ws.id)} title="Delete workspace" style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
                <Trash2 size={14} />
              </button>
            )}
          </div>

          {/* Subdomain */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <Globe size={13} style={{ color: "var(--text-muted)" }} />
            <Input
              placeholder="subdomain (e.g. sotfr.you.com)"
              value={hostEdits[ws.id] ?? ws.hostname ?? ""}
              onChange={(e) => setHostEdits((s) => ({ ...s, [ws.id]: e.target.value }))}
              style={{ flex: 1 }}
            />
            <Button variant="ghost" onClick={() => void saveHost(ws.id)} disabled={(hostEdits[ws.id] ?? ws.hostname ?? "") === (ws.hostname ?? "")}>
              <Save size={13} /> Save
            </Button>
          </div>

          {/* Vaults */}
          <div style={labelStyle}>Vaults in this workspace</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {ws.vaults.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>No vaults yet.</span>
            ) : (
              ws.vaults.map((v) => (
                <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, border: "1px solid var(--glass-border)", borderRadius: 6, padding: "3px 8px", color: "var(--text-secondary)" }}>
                  <Database size={11} /> {v.label}
                </span>
              ))
            )}
          </div>
          {otherVaults(ws).length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <ArrowRightLeft size={13} style={{ color: "var(--text-muted)" }} />
              <select
                defaultValue=""
                onChange={(e) => { const v = e.target.value; if (v) void assignVault(ws.id, v); e.target.value = ""; }}
                style={selectStyle}
              >
                <option value="">Move a vault here…</option>
                {otherVaults(ws).map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
