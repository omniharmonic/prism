// AccountSettings — self-service account management, shown as the Settings →
// Account tab when the shell provides an AccountClient (web session; hidden on
// desktop). Manages the signed-in user's OWN display name, avatar, and password.
// The name + avatar feed collab presence so a person's cursor/comments/edits are
// identifiable. Same surface for the owner and for workspace members.
import { useCallback, useEffect, useRef, useState } from "react";
import { User, Camera, Save, KeyRound, Check } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Badge } from "../ui/Badge";
import { useAccount, type AccountProfile } from "../../data/Account";

/** Downscale a picked image to a small square avatar (data URL) so it stays well
 *  under the server's size cap and renders crisply at cursor/comment sizes. */
async function fileToAvatar(file: File, size = 128): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Cover-crop to a square.
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function AccountSettings() {
  const account = useAccount();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const p = await account.getProfile();
      setProfile(p);
      setName(p.name ?? "");
      setAvatar(p.avatar);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your account.");
    }
  }, [account]);

  useEffect(() => { void load(); }, [load]);

  const pickAvatar = useCallback(async (file: File) => {
    setError(null);
    try {
      setAvatar(await fileToAvatar(file));
    } catch {
      setError("Couldn't read that image.");
    }
  }, []);

  const saveProfile = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await account.updateProfile({ name: name.trim() || undefined, avatar });
      setNotice("Profile saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your profile.");
    } finally {
      setBusy(false);
    }
  }, [account, name, avatar, load]);

  const changePassword = useCallback(async () => {
    if (!account) return;
    setPwBusy(true);
    setError(null);
    try {
      await account.changePassword(curPw, newPw);
      setNotice("Password changed.");
      setCurPw("");
      setNewPw("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change your password.");
    } finally {
      setPwBusy(false);
    }
  }, [account, curPw, newPw]);

  if (!account) return null;

  const cardStyle = { border: "1px solid var(--glass-border)", borderRadius: 10, padding: 16, marginBottom: 16, background: "var(--glass-bg)" } as const;
  const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 } as const;

  return (
    <div style={{ maxWidth: 520 }}>
      {error && <Badge variant="error">{error}</Badge>}
      {notice && (
        <div style={{ ...cardStyle, display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--text-primary)" }}>
          <Check size={14} /> {notice}
        </div>
      )}

      {/* Profile: avatar + name; email read-only (it's your login identity) */}
      <div style={cardStyle}>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <button
            onClick={() => fileRef.current?.click()}
            title="Change avatar"
            style={{ position: "relative", width: 64, height: 64, borderRadius: 999, border: "1px solid var(--glass-border)", overflow: "hidden", cursor: "pointer", background: "var(--glass-active)", flexShrink: 0, padding: 0 }}
          >
            {avatar ? (
              <img src={avatar} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <User size={26} style={{ color: "var(--text-muted)" }} />
            )}
            <span style={{ position: "absolute", right: 0, bottom: 0, background: "var(--color-accent)", color: "#fff", borderRadius: 999, padding: 3, display: "inline-flex" }}>
              <Camera size={11} />
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickAvatar(f); e.target.value = ""; }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={labelStyle}>Display name</div>
            <Input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6 }}>
              {profile?.email} <span style={{ opacity: 0.7 }}>· your login (can't be changed here)</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Button onClick={() => void saveProfile()} disabled={busy}><Save size={13} /> Save profile</Button>
          {avatar && <Button variant="ghost" onClick={() => setAvatar(null)} disabled={busy}>Remove photo</Button>}
        </div>
        <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "10px 0 0" }}>
          Your name and photo identify your cursor, comments, and suggested edits to collaborators.
        </p>
      </div>

      {/* Password */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <KeyRound size={14} />
          <div style={labelStyle}>{profile?.hasPassword ? "Change password" : "Set a password"}</div>
        </div>
        {profile?.hasPassword && (
          <Input type="password" placeholder="Current password" value={curPw} onChange={(e) => setCurPw(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        )}
        <Input type="password" placeholder="New password" value={newPw} onChange={(e) => setNewPw(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
        <Button onClick={() => void changePassword()} disabled={pwBusy || !newPw || (!!profile?.hasPassword && !curPw)}>
          <KeyRound size={13} /> {profile?.hasPassword ? "Change password" : "Set password"}
        </Button>
      </div>
    </div>
  );
}
