import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import YProvider from "y-partyserver/provider";
import { marked } from "marked";
import { CollabEditor } from "@prism/core";
import { loadConnection, setActiveConnection } from "../config";
import * as rest from "../parachute/rest";

const COLORS = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

/** Minimal shape shared by the y-partyserver and y-webrtc providers. */
type CollabProvider = {
  awareness: {
    getStates(): Map<number, unknown>;
    on(type: string, cb: () => void): void;
    off(type: string, cb: () => void): void;
  };
  destroy(): void;
};

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
  const [provider, setProvider] = useState<CollabProvider | null>(null);
  const [peers, setPeers] = useState(1);

  useEffect(() => {
    if (conn) setActiveConnection(conn);
    const room = `prism-collab-${noteId}`;
    const host = import.meta.env.VITE_COLLAB_HOST as string | undefined;
    // Prefer the hosted y-partyserver sync server (durable, server-relayed,
    // works without peers being simultaneously online); fall back to
    // peer-to-peer y-webrtc when no host is configured.
    let p: CollabProvider;
    if (host) {
      p = new YProvider(host, room, ydoc, { party: "document" }) as unknown as CollabProvider;
    } else {
      const signaling = (import.meta.env.VITE_COLLAB_SIGNALING as string | undefined)
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      p = new WebrtcProvider(room, ydoc, signaling ? { signaling } : undefined) as unknown as CollabProvider;
    }
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
