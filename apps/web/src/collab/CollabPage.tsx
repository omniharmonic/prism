import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import YProvider from "y-partyserver/provider";
import { marked } from "marked";
import { CollabEditor } from "@prism/core";
import { loadConnection, setActiveConnection } from "../config";
import { mintGrant } from "./grant";
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
  on(type: string, cb: (...args: unknown[]) => void): void;
  destroy(): void;
};

const usingServer = !!(import.meta.env.VITE_COLLAB_HOST as string | undefined);

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
  const [denied, setDenied] = useState(false);
  const [peers, setPeers] = useState(1);
  const [connected, setConnected] = useState(false);
  // True once the doc is synced with the server (or a fallback elapses). Gates
  // seeding so a late server sync isn't clobbered by a stale seed.
  const [synced, setSynced] = useState(!usingServer);

  useEffect(() => {
    if (conn) setActiveConnection(conn);
    const room = `prism-collab-${noteId}`;
    const host = import.meta.env.VITE_COLLAB_HOST as string | undefined;
    let p: CollabProvider | null = null;
    let cancelled = false;
    let cleanupAwareness: (() => void) | undefined;
    let seedFallback: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      if (host) {
        // The hosted server gates every connection on a per-note grant: a shared
        // link carries one (?t=), and the owner mints one with their vault token.
        const urlGrant = new URLSearchParams(window.location.search).get("t");
        let grant: string | null = urlGrant;
        if (!grant && conn) grant = await mintGrant(noteId, conn.token).catch(() => null);
        if (cancelled) return;
        if (!grant) {
          setDenied(true);
          return;
        }
        p = new YProvider(host, room, ydoc, {
          party: "document",
          params: { t: grant },
          // Periodically re-sync with the server so a dropped update or a
          // half-open socket (sleep/wake, flaky wifi) self-heals instead of
          // silently diverging; reconnect quickly on disconnect.
          resyncInterval: 5000,
          maxBackoffTime: 2500,
        }) as unknown as CollabProvider;
      } else {
        // No hosted server configured → peer-to-peer y-webrtc fallback.
        const signaling = (import.meta.env.VITE_COLLAB_SIGNALING as string | undefined)
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        p = new WebrtcProvider(room, ydoc, signaling ? { signaling } : undefined) as unknown as CollabProvider;
      }
      if (cancelled) {
        p.destroy();
        return;
      }
      setProvider(p);
      const update = () => setPeers(p!.awareness.getStates().size || 1);
      p.awareness.on("change", update);
      update();
      if (host) {
        p.on("status", (...args) => {
          setConnected((args[0] as { status?: string })?.status === "connected");
        });
        p.on("sync", () => setSynced(true));
        p.on("synced", () => setSynced(true));
        // Safety net: seed even if no sync event arrives (CollabEditor still
        // only seeds when the doc is actually empty).
        seedFallback = setTimeout(() => setSynced(true), 2500);
      } else {
        setConnected(true); // y-webrtc P2P fallback has no status event
      }
      cleanupAwareness = () => p!.awareness.off("change", update);
    })();

    return () => {
      cancelled = true;
      cleanupAwareness?.();
      if (seedFallback) clearTimeout(seedFallback);
      p?.destroy();
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

  if (denied) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>This link isn’t valid</h1>
          <p style={{ fontSize: 14, color: "var(--text-muted, #888)", marginTop: 8 }}>
            Ask the document owner for a fresh collaboration link. Links grant access to a single
            note and expire after 30 days.
          </p>
        </div>
      </div>
    );
  }

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
          <span>
            {connected ? "Live collaboration" : "Reconnecting…"}
            {conn ? "" : " · syncing from peers (no vault access)"}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: connected ? "#22c55e" : "#eab308",
              }}
            />
            {peers} here
          </span>
        </div>
        <CollabEditor
          ydoc={ydoc}
          provider={provider}
          user={user}
          seedContent={seedContent}
          onChange={onChange}
          seedReady={usingServer ? synced : undefined}
        />
      </div>
    </div>
  );
}
