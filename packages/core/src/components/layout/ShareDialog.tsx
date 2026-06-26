import { useEffect, useState, useCallback } from "react";
import { Check, Copy, X, Link2, Trash2, Loader2 } from "lucide-react";
import type { CollabSharing, NoteAccess, SetPersonResult, ShareLevel } from "../../data/CollabSharing";

const LEVELS: ShareLevel[] = ["view", "comment", "suggest", "edit"];
const LEVEL_LABEL: Record<ShareLevel, string> = {
  view: "Viewer",
  comment: "Commenter",
  suggest: "Suggester",
  edit: "Editor",
};

/**
 * Google-Docs-style share dialog. Manages a note's access: people (by email,
 * with a level each), capability links ("anyone with the link"), and shows
 * tag-grants that already reach this note. Backed by the CollabSharing seam's
 * rich ACL methods (web → Prism Server /acl). Owner-only by construction —
 * the server rejects non-owner ACL calls.
 */
export function ShareDialog({
  noteId,
  sharing,
  onClose,
}: {
  noteId: string;
  sharing: CollabSharing;
  onClose: () => void;
}) {
  const [access, setAccess] = useState<NoteAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [addLevel, setAddLevel] = useState<ShareLevel>("edit");
  const [linkLevel, setLinkLevel] = useState<ShareLevel>("view");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Accept link for a freshly-invited person — shown so the owner can hand it
  // over directly (email delivery may be unconfigured/unpaid).
  const [invite, setInvite] = useState<{ email: string; url: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!sharing.getAccess) return;
    try {
      setAccess(await sharing.getAccess(noteId));
      setError(null);
      // Notify the app so an open editor for this note can flip to live collab.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("prism:acl-changed", { detail: { noteId } }));
      }
    } catch {
      setError("Couldn't load sharing settings.");
    }
  }, [sharing, noteId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Surface the accept link when granting created an invite (the person had no
  // account yet), and pre-copy it so the owner can paste it straight into a DM.
  function onGranted(targetEmail: string, res?: SetPersonResult) {
    if (res?.invited && res.inviteUrl) {
      setInvite({ email: targetEmail, url: res.inviteUrl });
      void navigator.clipboard.writeText(res.inviteUrl).catch(() => {});
      setCopied("invite");
      setTimeout(() => setCopied(null), 2000);
    }
  }

  async function addPerson() {
    if (!sharing.setPerson || !/.+@.+\..+/.test(email)) return;
    setBusy(true);
    try {
      const target = email.trim().toLowerCase();
      const res = await sharing.setPerson(noteId, target, addLevel);
      setEmail("");
      onGranted(target, res);
      await refresh();
    } catch {
      setError("Couldn't add that person.");
    } finally {
      setBusy(false);
    }
  }

  async function changePerson(e: string, level: ShareLevel) {
    if (!sharing.setPerson) return;
    const res = await sharing.setPerson(noteId, e, level);
    onGranted(e, res);
    await refresh();
  }

  async function removePerson(e: string) {
    if (!sharing.removePerson) return;
    await sharing.removePerson(noteId, e);
    await refresh();
  }

  async function createLink() {
    if (!sharing.createLink) return;
    setBusy(true);
    try {
      const link = await sharing.createLink(noteId, linkLevel);
      await navigator.clipboard.writeText(link.url).catch(() => {});
      setCopied(link.id);
      setTimeout(() => setCopied(null), 2000);
      await refresh();
    } catch {
      setError("Couldn't create a link.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeLink(id: string) {
    if (!sharing.revokeLink) return;
    await sharing.revokeLink(noteId, id);
    await refresh();
  }

  async function copyLink(url: string, id: string) {
    await navigator.clipboard.writeText(url).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  const levelSelect = (value: ShareLevel, onChange: (l: ShareLevel) => void) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ShareLevel)}
      className="text-xs px-1.5 py-1 rounded outline-none"
      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }}
    >
      {LEVELS.map((l) => (
        <option key={l} value={l}>
          {LEVEL_LABEL[l]}
        </option>
      ))}
    </select>
  );

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="glass-elevated modal-rise rounded-2xl"
        style={{
          width: "100%",
          maxWidth: 520,
          padding: 22,
          border: "1px solid var(--glass-border)",
          maxHeight: "calc(100dvh - 48px)",
          overflowY: "auto",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Share {access ? `“${access.note.title}”` : "note"}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--glass-hover)]">
            <X size={16} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>

        {error && (
          <p className="text-xs mb-2" style={{ color: "var(--color-danger, #EB5757)" }}>
            {error}
          </p>
        )}

        {/* Add people — field on its own line, then access-level + Add on a tidy
            right-aligned row so nothing crowds or spills on narrow widths. */}
        <div className="mb-3 flex flex-col gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPerson()}
            placeholder="Add people by email"
            type="email"
            className="w-full text-sm px-3 py-2 rounded-lg outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          />
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>as</span>
            {levelSelect(addLevel, setAddLevel)}
            <button
              onClick={addPerson}
              disabled={busy || !/.+@.+\..+/.test(email)}
              className="ml-auto px-4 py-2 rounded-lg text-sm font-medium"
              style={{ background: "var(--color-accent)", color: "white", opacity: busy || !/.+@.+\..+/.test(email) ? 0.5 : 1 }}
            >
              Add person
            </button>
          </div>
        </div>

        {/* Invite link for a freshly-invited person — hand it over directly when
            email delivery isn't set up. */}
        {invite && (
          <div
            className="mb-3 p-2.5 rounded-lg"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                Invite link for {invite.email}
              </span>
              <button onClick={() => setInvite(null)} className="p-0.5 rounded hover:bg-[var(--glass-hover)]">
                <X size={12} style={{ color: "var(--text-muted)" }} />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={invite.url}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 text-xs px-2 py-1.5 rounded outline-none"
                style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }}
              />
              <button
                onClick={() => copyLink(invite.url, "invite")}
                className="px-2 py-1.5 rounded text-xs flex items-center gap-1"
                style={{ background: "var(--color-accent)", color: "white" }}
              >
                {copied === "invite" ? <Check size={13} /> : <Copy size={13} />}
                {copied === "invite" ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-[11px] mt-1.5" style={{ color: "var(--text-muted)" }}>
              Send this so they can create their account. Expires in 7 days.
            </p>
          </div>
        )}

        {/* People with access */}
        <div className="mb-1 text-[11px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          People with access
        </div>
        <div className="flex flex-col gap-1 mb-3" style={{ maxHeight: 180, overflowY: "auto" }}>
          {!access ? (
            <div className="flex items-center gap-2 text-xs py-2" style={{ color: "var(--text-muted)" }}>
              <Loader2 size={13} className="animate-spin" /> Loading…
            </div>
          ) : (
            <>
              {access.people.length === 0 && access.tagAccess.length === 0 && (
                <p className="text-xs py-1" style={{ color: "var(--text-muted)" }}>
                  Only you. Add people or create a link below.
                </p>
              )}
              {access.people.map((p) => (
                <div key={p.email} className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 text-sm truncate" style={{ color: "var(--text-secondary)" }}>
                    {p.email}
                  </span>
                  {levelSelect(p.level, (l) => changePerson(p.email, l))}
                  <button
                    onClick={() => removePerson(p.email)}
                    className="p-1 rounded hover:bg-[var(--glass-hover)]"
                    title="Remove"
                  >
                    <Trash2 size={13} style={{ color: "var(--text-muted)" }} />
                  </button>
                </div>
              ))}
              {access.tagAccess.map((t, i) => (
                <div key={`${t.tag}-${i}`} className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
                  <span className="flex-1 truncate">
                    {t.email ?? t.subjectType} · via tag <code>{t.tag}</code>
                  </span>
                  <span>{LEVEL_LABEL[t.level]}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Links */}
        <div className="mb-1 text-[11px] uppercase tracking-wide flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
          <Link2 size={11} /> Anyone with the link
        </div>
        <div className="flex flex-col gap-1.5">
          {access?.links.map((l) => (
            <div key={l.id} className="flex items-center gap-2">
              <span className="text-xs flex-1 min-w-0 truncate" style={{ color: "var(--text-secondary)" }}>
                {LEVEL_LABEL[l.level]} link · expires {new Date(l.expiresAt).toLocaleDateString()}
              </span>
              <button
                onClick={() => copyLink(l.url, l.id)}
                className="px-2 py-1 rounded text-xs flex items-center gap-1"
                style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }}
              >
                {copied === l.id ? <Check size={12} /> : <Copy size={12} />}
                {copied === l.id ? "Copied" : "Copy"}
              </button>
              <button onClick={() => revokeLink(l.id)} className="p-1 rounded hover:bg-[var(--glass-hover)]" title="Revoke">
                <Trash2 size={13} style={{ color: "var(--text-muted)" }} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 mt-1">
            {levelSelect(linkLevel, setLinkLevel)}
            <button
              onClick={createLink}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1"
              style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
            >
              <Link2 size={12} /> Create link
            </button>
          </div>
        </div>

        <p className="text-[11px] mt-3" style={{ color: "var(--text-muted)" }}>
          People you add sign in with their email. Links work for anyone who has them. The rest of
          your vault stays private.
        </p>
      </div>
    </div>
  );
}
