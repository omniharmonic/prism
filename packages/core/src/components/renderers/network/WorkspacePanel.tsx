// WorkspacePanel — the server-owner surface (Network → Workspace). A WORKSPACE is
// the whole server: a permission boundary grouping every vault. Here the owner
// sees the people × vaults access matrix and, in one step, adds a person to a
// CHOSEN vault at a chosen access level (and optionally a management role).
// Everything flows through useCollabSharing() and is server-owner-gated server-side;
// the panel hides when the seam lacks getWorkspace (desktop / non-server-owner).
import { useCallback, useEffect, useState } from "react";
import { Building2, UserPlus, Trash2, Copy, Database, ShieldCheck } from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
import {
  useCollabSharing,
  useVaultChangeSignal,
  type WorkspaceOverview,
  type WorkspaceRole,
  type ShareLevel,
} from "../../../data/CollabSharing";

const LEVELS: ShareLevel[] = ["view", "comment", "suggest", "edit"];
const MANAGE_ROLES: (WorkspaceRole | "none")[] = ["none", "member", "admin", "owner"];

export function WorkspacePanel() {
  const sharing = useCollabSharing();
  const vaultSignal = useVaultChangeSignal();

  const [data, setData] = useState<WorkspaceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [level, setLevel] = useState<ShareLevel>("edit");
  const [role, setRole] = useState<WorkspaceRole | "none">("none");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!sharing?.getWorkspace) return;
    setError(null);
    try {
      const ws = await sharing.getWorkspace();
      setData(ws);
      // Default the "add" vault selector to the first vault once loaded.
      setVaultId((v) => v || ws.vaults[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the workspace.");
    }
  }, [sharing]);

  useEffect(() => {
    void refresh();
  }, [refresh, vaultSignal]);

  const showInvite = (r: { invited: boolean; inviteUrl?: string }, who: string) => {
    if (r.invited && r.inviteUrl) {
      void navigator.clipboard?.writeText(r.inviteUrl).catch(() => {});
      setNotice(`Invite link for ${who} copied — send it to them to join.`);
    } else {
      setNotice(`${who} updated.`);
    }
  };

  const addPerson = useCallback(async () => {
    if (!sharing?.setWorkspaceAccess || !email.trim() || !vaultId) return;
    const who = email.trim().toLowerCase();
    setBusy(true);
    setError(null);
    try {
      // Access to the chosen vault at the chosen level, plus an optional
      // management role in that same vault.
      const res = await sharing.setWorkspaceAccess(who, vaultId, level);
      if (role !== "none" && sharing.setWorkspaceMemberRole) {
        await sharing.setWorkspaceMemberRole(who, vaultId, role);
      }
      const vaultLabel = data?.vaults.find((v) => v.id === vaultId)?.label ?? vaultId;
      showInvite(res, `${who} → ${vaultLabel} (${level}${role !== "none" ? `, ${role}` : ""})`);
      setEmail("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the person.");
    } finally {
      setBusy(false);
    }
  }, [sharing, email, vaultId, level, role, data, refresh]);

  const removeAccess = useCallback(
    async (who: string, vid: string) => {
      if (!sharing?.removeWorkspaceAccess) return;
      try {
        await sharing.removeWorkspaceAccess(vid, who);
        if (sharing.removeWorkspaceMemberRole) await sharing.removeWorkspaceMemberRole(vid, who);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't remove access.");
      }
    },
    [sharing, refresh],
  );

  if (!sharing?.getWorkspace) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        Workspace management isn't available here (server owner only).
      </p>
    );
  }

  const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 } as const;
  const cardStyle = {
    border: "1px solid var(--glass-border)",
    borderRadius: 10,
    padding: 16,
    marginBottom: 18,
    background: "var(--glass-bg)",
  } as const;
  const selectStyle = {
    fontSize: 13,
    padding: "6px 8px",
    borderRadius: 6,
    background: "var(--glass-bg)",
    color: "var(--text-primary)",
    border: "1px solid var(--glass-border)",
  } as const;

  const vaults = data?.vaults ?? [];
  const people = data?.people ?? [];

  return (
    <div>
      {error && <Badge variant="error">{error}</Badge>}
      {notice && (
        <div style={{ ...cardStyle, display: "flex", gap: 8, alignItems: "center", color: "var(--text-primary)", fontSize: 13 }}>
          <Copy size={14} /> {notice}
        </div>
      )}

      {/* What this is */}
      <div style={{ ...cardStyle, display: "flex", gap: 10, alignItems: "flex-start" }}>
        <Building2 size={16} style={{ marginTop: 2 }} />
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>This workspace</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: 0 }}>
            The whole server — grouping {vaults.length} {vaults.length === 1 ? "vault" : "vaults"}. Add people and set their
            access per vault. Access = what they can see/do; role = management rights over that vault.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {vaults.map((v) => (
              <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text-secondary)", border: "1px solid var(--glass-border)", borderRadius: 6, padding: "3px 8px" }}>
                <Database size={12} /> {v.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Add a person to a chosen vault */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <UserPlus size={15} />
          <div style={labelStyle}>Add someone to a vault</div>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 10px" }}>
          They'll get access to the chosen vault at the chosen level. If they have no account yet, you'll get an invite
          link to send them.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Input placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <select value={vaultId} onChange={(e) => setVaultId(e.target.value)} style={selectStyle} title="Vault">
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value as ShareLevel)} style={selectStyle} title="Access level">
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole | "none")} style={selectStyle} title="Management role">
            {MANAGE_ROLES.map((r) => (
              <option key={r} value={r}>{r === "none" ? "no mgmt role" : `${r} (manage)`}</option>
            ))}
          </select>
          <Button onClick={() => void addPerson()} disabled={busy || !email.trim() || !vaultId}>
            <UserPlus size={14} /> Add
          </Button>
        </div>
      </div>

      {/* People × vaults matrix */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <ShieldCheck size={16} />
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>People &amp; access</h2>
        </div>
        {people.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: 0 }}>No one has access yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {people.map((p) => (
              <div key={p.email} style={{ padding: "8px 0", borderBottom: "1px solid var(--glass-border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
                    {p.name ? `${p.name} · ` : ""}
                    <span style={{ color: "var(--text-secondary)" }}>{p.email}</span>
                  </span>
                  {p.isServerOwner && <Badge variant="success">server owner</Badge>}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {vaults.map((v) => {
                    const a = p.access[v.id];
                    if (!a || (!a.role && !a.level)) return null;
                    return (
                      <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, border: "1px solid var(--glass-border)", borderRadius: 6, padding: "3px 8px", color: "var(--text-secondary)" }}>
                        <Database size={11} /> {v.label}
                        {a.level && <Badge>{a.level}</Badge>}
                        {a.role && <Badge variant="info">{a.role}</Badge>}
                        {!p.isServerOwner && (
                          <button
                            onClick={() => void removeAccess(p.email, v.id)}
                            title={`Remove ${p.email} from ${v.label}`}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", padding: 0, display: "inline-flex" }}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {vaults.every((v) => { const a = p.access[v.id]; return !a || (!a.role && !a.level); }) && (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>no vault access</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
