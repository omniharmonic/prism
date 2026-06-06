import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { marked } from "marked";
import { CollabEditor } from "@prism/core";
import { loadConnection, setActiveConnection } from "../config";
import * as rest from "../parachute/rest";

const COLORS = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

/**
 * Real-time collaborative editing of a note over a CRDT. Room = note id, so a
 * `/collab/:id` link is the invite. Peers sync the Y.Doc peer-to-peer (y-webrtc;
 * same-origin tabs also sync instantly via BroadcastChannel). The owner (a
 * viewer with a vault connection) seeds the initial content and persists changes
 * back to Parachute; collaborators without vault access still edit live via the
 * CRDT.
 *
 * Signaling defaults to y-webrtc's public servers; set VITE_COLLAB_SIGNALING
 * (comma-separated wss URLs) to use your own for production reliability.
 */
export function CollabPage({ noteId }: { noteId: string }) {
  const conn = useMemo(() => loadConnection(), []);
  const [ydoc] = useState(() => new Y.Doc());
  const [provider, setProvider] = useState<WebrtcProvider | null>(null);
  const [peers, setPeers] = useState(1);

  useEffect(() => {
    if (conn) setActiveConnection(conn);
    const signaling = (import.meta.env.VITE_COLLAB_SIGNALING as string | undefined)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const p = new WebrtcProvider(`prism-collab-${noteId}`, ydoc, signaling ? { signaling } : undefined);
    setProvider(p);
    const update = () => setPeers(p.awareness.getStates().size || 1);
    p.awareness.on("change", update);
    update();
    return () => {
      p.awareness.off("change", update);
      p.destroy();
      ydoc.destroy();
    };
  }, [noteId, ydoc, conn]);

  const seedContent = useCallback(async () => {
    if (!conn) return null;
    try {
      const note = await rest.getNote(noteId);
      const md = note.content || "";
      return md.trim().startsWith("<") ? md : (marked.parse(md) as string);
    } catch {
      return null;
    }
  }, [noteId, conn]);

  const onChange = useMemo(() => {
    if (!conn) return undefined;
    let timer: number | undefined;
    return (html: string) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        void rest.updateNote(noteId, { content: html });
      }, 2500);
    };
  }, [noteId, conn]);

  const user = useMemo(() => ({ name: conn ? "You" : "Guest", color: randomColor() }), [conn]);

  if (!provider) return null;

  return (
    <div style={{ minHeight: "100dvh", padding: "0 16px" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 0 96px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
            fontSize: 12,
            color: "var(--text-muted, #888)",
          }}
        >
          <span>Live collaboration{conn ? "" : " · syncing from peers (no vault access)"}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: "#22c55e" }} />
            {peers} here
          </span>
        </div>
        <CollabEditor
          ydoc={ydoc}
          provider={provider}
          user={user}
          seedContent={seedContent}
          onChange={onChange}
        />
      </div>
    </div>
  );
}
