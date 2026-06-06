import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { CollabEditor } from "@prism/core";
import { GATEWAY_ORIGIN, apiBase, capabilityHeader } from "../config";
import { getCapabilityToken } from "../config";

const COLORS = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];

function collabUrl(): string {
  const base = GATEWAY_ORIGIN || location.origin;
  return base.replace(/^http/, "ws") + "/collab";
}

interface PresenceUser {
  name: string;
  color: string;
}

/**
 * Google-Docs-style collaborative editing of a note, served by the Prism Server
 * (Hocuspocus). The server authorizes (session or ?t= capability), seeds from
 * Parachute, and persists edits back. The editor is read-only for view/comment
 * grants (resolved from the gateway's _level); presence avatars come from Yjs
 * awareness.
 */
export function CollabPage({ noteId }: { noteId: string }) {
  const [ydoc] = useState(() => new Y.Doc());
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [denied, setDenied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [editable, setEditable] = useState(true);
  const [title, setTitle] = useState("Shared document");
  const [presence, setPresence] = useState<PresenceUser[]>([]);

  // Resolve our access level from the gateway → drives read-only + title.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase()}/notes/${encodeURIComponent(noteId)}`, {
          credentials: "include",
          headers: capabilityHeader(),
        });
        if (!r.ok) return;
        const note = await r.json();
        const level: string | undefined = note._level;
        if (level && !["suggest", "edit", "own"].includes(level)) setEditable(false);
        const firstLine = (note.content || "").split("\n").find((l: string) => l.trim());
        if (firstLine) setTitle(firstLine.replace(/^#+\s*/, "").slice(0, 100));
      } catch {
        /* level unknown → default editable; server still enforces */
      }
    })();
  }, [noteId]);

  useEffect(() => {
    const p = new HocuspocusProvider({
      url: collabUrl(),
      name: noteId,
      token: getCapabilityToken() ?? "session",
      document: ydoc,
      onStatus: ({ status }) => setConnected(status === "connected"),
      onSynced: () => setSynced(true),
      onAuthenticationFailed: () => setDenied(true),
    });
    setProvider(p);
    return () => {
      p.destroy();
      ydoc.destroy();
    };
  }, [noteId, ydoc]);

  // Presence: remote users from Yjs awareness (CollaborationCaret sets `user`).
  useEffect(() => {
    if (!provider?.awareness) return;
    const aw = provider.awareness;
    const update = () => {
      const users: PresenceUser[] = [];
      aw.getStates().forEach((s) => {
        const u = (s as { user?: PresenceUser }).user;
        if (u?.name) users.push(u);
      });
      setPresence(users);
    };
    aw.on("change", update);
    update();
    return () => aw.off("change", update);
  }, [provider]);

  const user = useMemo(
    () => ({ name: getCapabilityToken() ? "Guest" : "You", color: COLORS[presence.length % COLORS.length]! }),
    [presence.length],
  );

  if (denied) {
    return (
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div style={{ maxWidth: 420 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>This link isn’t valid</h1>
          <p style={{ fontSize: 14, color: "var(--text-muted, #888)", marginTop: 8 }}>
            Ask the document owner for a fresh share link, or sign in if this note was shared with
            your account.
          </p>
        </div>
      </div>
    );
  }

  if (!provider) return null;

  return (
    <div style={{ minHeight: "100dvh", padding: "0 16px", background: "var(--bg-base, #0d0d0f)" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "16px 0 96px" }}>
        {/* Doc header: title, presence, status */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {title}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted, #888)", marginTop: 2 }}>
              {connected ? (editable ? "Live · editing" : "Live · view only") : "Connecting…"}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <PresenceAvatars users={presence} />
            <span style={{ width: 8, height: 8, borderRadius: 999, background: connected ? "#22c55e" : "#eab308" }} />
          </div>
        </div>

        {/* Paper */}
        <div
          style={{
            background: "var(--bg-surface, rgba(255,255,255,0.03))",
            border: "1px solid var(--glass-border)",
            borderRadius: 14,
            padding: "20px 28px 40px",
            minHeight: "70vh",
          }}
        >
          <CollabEditor ydoc={ydoc} provider={provider as never} user={user} seedReady={synced} toolbar editable={editable} />
        </div>
      </div>
    </div>
  );
}

function PresenceAvatars({ users }: { users: PresenceUser[] }) {
  const shown = users.slice(0, 5);
  return (
    <div style={{ display: "flex" }}>
      {shown.map((u, i) => (
        <div
          key={`${u.name}-${i}`}
          title={u.name}
          style={{
            width: 26,
            height: 26,
            borderRadius: 999,
            background: u.color,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "2px solid var(--bg-base, #0d0d0f)",
            marginLeft: i === 0 ? 0 : -8,
          }}
        >
          {u.name.charAt(0).toUpperCase()}
        </div>
      ))}
    </div>
  );
}
