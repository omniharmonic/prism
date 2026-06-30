// MembersPanel — the team-workspace surface (Network → Members). Manage who
// belongs to the ACTIVE vault and at what role, share a folder/tag with an email,
// and grant whole-workspace access. Everything flows through useCollabSharing()
// (web-owner/admin only); the panel hides when the seam lacks listMembers.
//
// Phase 2 of the multi-tenant platform — docs/roadmap/platform-roadmap.md.
import { useCallback, useEffect, useState } from "react";
import { Users, UserPlus, Trash2, Copy, FolderInput, KeyRound } from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
import {
  useCollabSharing,
  type WorkspaceMember,
  type WorkspaceRole,
  type ShareLevel,
} from "../../../data/CollabSharing";

const ROLES: WorkspaceRole[] = ["guest", "member", "admin", "owner"];
const LEVELS: ShareLevel[] = ["view", "comment", "suggest", "edit"];

export function MembersPanel() {
  const sharing = useCollabSharing();

  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");

  const [tag, setTag] = useState("");
  const [tagEmail, setTagEmail] = useState("");
  const [tagLevel, setTagLevel] = useState<ShareLevel>("edit");

  const refresh = useCallback(async () => {
    if (!sharing?.listMembers) return;
    setError(null);
    try {
      setMembers(await sharing.listMembers());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load members.");
    }
  }, [sharing]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showInvite = (r: { invited: boolean; inviteUrl?: string }, who: string) => {
    if (r.invited && r.inviteUrl) {
      void navigator.clipboard?.writeText(r.inviteUrl).catch(() => {});
      setNotice(`Invite link for ${who} copied to your clipboard — send it to them to join.`);
    } else {
      setNotice(`${who} updated.`);
    }
  };

  const addMember = useCallback(async () => {
    if (!sharing?.setMember || !email.trim()) return;
    try {
      const res = await sharing.setMember(email.trim().toLowerCase(), role);
      showInvite(res, email.trim().toLowerCase());
      setEmail("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add member.");
    }
  }, [sharing, email, role, refresh]);

  const removeMember = useCallback(
    async (m: WorkspaceMember) => {
      if (!sharing?.removeMember) return;
      await sharing.removeMember(m.email);
      await refresh();
    },
    [sharing, refresh],
  );

  const shareFolder = useCallback(async () => {
    if (!sharing?.setTagPerson || !tag.trim() || !tagEmail.trim()) return;
    try {
      const res = await sharing.setTagPerson(tag.trim(), tagEmail.trim().toLowerCase(), tagLevel);
      showInvite(res, `${tagEmail.trim().toLowerCase()} (folder #${tag.trim()})`);
      setTagEmail("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't share folder.");
    }
  }, [sharing, tag, tagEmail, tagLevel]);

  if (!sharing?.listMembers) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        Member management isn't available here (web owner/admin only).
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

  return (
    <div>
      {error && <Badge variant="error">{error}</Badge>}
      {notice && (
        <div style={{ ...cardStyle, display: "flex", gap: 8, alignItems: "center", color: "var(--text-primary)", fontSize: 13 }}>
          <Copy size={14} /> {notice}
        </div>
      )}

      {/* Members list */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Users size={16} />
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Members of this workspace</h2>
        </div>
        {members.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: 0 }}>
            No members yet. Invite someone below — they'll get a link to create an account.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {members.map((m) => (
              <div key={m.email} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--glass-border)" }}>
                <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)" }}>
                  {m.name ? `${m.name} · ` : ""}
                  <span style={{ color: "var(--text-secondary)" }}>{m.email}</span>
                </span>
                <select
                  value={m.role}
                  onChange={async (e) => {
                    await sharing.setMember?.(m.email, e.target.value as WorkspaceRole);
                    await refresh();
                  }}
                  style={{ fontSize: 12, padding: "2px 6px", borderRadius: 6, background: "var(--glass-bg)", color: "var(--text-primary)", border: "1px solid var(--glass-border)" }}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <button onClick={() => void removeMember(m)} title="Remove" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Invite a member */}
      <div style={cardStyle}>
        <div style={labelStyle}>Invite a member</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Input placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} style={{ fontSize: 13, padding: "6px 8px", borderRadius: 6, background: "var(--glass-bg)", color: "var(--text-primary)", border: "1px solid var(--glass-border)" }}>
            {ROLES.filter((r) => r !== "owner").map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <Button onClick={() => void addMember()} disabled={!email.trim()}>
            <UserPlus size={14} /> Invite
          </Button>
        </div>
      </div>

      {/* Share a folder/tag */}
      {sharing.setTagPerson && (
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <FolderInput size={15} />
            <div style={labelStyle}>Share a folder (tag) with someone</div>
          </div>
          <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 10px" }}>
            They'll see every note carrying this tag (dynamic — future notes included), at the level you choose.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Input placeholder="tag (e.g. projects)" value={tag} onChange={(e) => setTag(e.target.value)} style={{ width: 160 }} />
            <Input placeholder="email@example.com" value={tagEmail} onChange={(e) => setTagEmail(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <select value={tagLevel} onChange={(e) => setTagLevel(e.target.value as ShareLevel)} style={{ fontSize: 13, padding: "6px 8px", borderRadius: 6, background: "var(--glass-bg)", color: "var(--text-primary)", border: "1px solid var(--glass-border)" }}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            <Button onClick={() => void shareFolder()} disabled={!tag.trim() || !tagEmail.trim()}>
              <KeyRound size={14} /> Share
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
