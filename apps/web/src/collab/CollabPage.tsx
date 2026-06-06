import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { CollabEditor } from "@prism/core";
import { GATEWAY_ORIGIN, getCapabilityToken } from "../config";

const COLORS = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];

/** ws(s):// URL for the Prism Server collab endpoint (same-origin by default). */
function collabUrl(): string {
  const base = GATEWAY_ORIGIN || location.origin;
  return base.replace(/^http/, "ws") + "/collab";
}

/**
 * Real-time collaborative editing of a note, served by the Prism Server
 * (Hocuspocus). documentName = note id. The server authorizes the connection
 * (session cookie or ?t= capability), seeds the doc from Parachute, and
 * persists edits back — so no vault token or owner browser is needed here. A
 * view/comment grant connects read-only (the server drops its edits).
 */
export function CollabPage({ noteId }: { noteId: string }) {
  const [ydoc] = useState(() => new Y.Doc());
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [denied, setDenied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState(1);

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

  useEffect(() => {
    if (!provider) return;
    const update = () => setPeers(provider.awareness?.getStates().size || 1);
    provider.awareness?.on("change", update);
    update();
    return () => provider.awareness?.off("change", update);
  }, [provider]);

  const user = useMemo(
    () => ({ name: getCapabilityToken() ? "Guest" : "You", color: COLORS[peers % COLORS.length] ?? COLORS[0]! }),
    [peers],
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
          <span>{connected ? "Live collaboration" : "Connecting…"}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: connected ? "#22c55e" : "#eab308" }} />
            {peers} here
          </span>
        </div>
        <CollabEditor ydoc={ydoc} provider={provider as never} user={user} seedReady={synced} />
      </div>
    </div>
  );
}
