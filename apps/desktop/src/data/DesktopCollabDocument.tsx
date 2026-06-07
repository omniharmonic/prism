import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { invoke } from "@tauri-apps/api/core";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  CollabEditor,
  CollabCodeEditor,
  CollabSpreadsheet,
  CollabCanvas,
  detectCodeLanguage,
  inferContentType,
  type Note,
} from "@prism/core";

/**
 * Desktop live-collaborative editor. The Tauri app joins the SAME Prism Server
 * Hocuspocus doc as web/phone (ws://localhost:8787/collab by default), presenting
 * the dedicated COLLAB_TOKEN as the owner. So an edit made on a phone shows up here
 * instantly — and vice versa — with no refresh. The note is already loaded by the
 * app, so we seed kind/title from it (no fetch); the server seeds content from the
 * vault. Comments/suggestions are document-only and omitted here for now — this is
 * about real-time parity of the editing surface across every interface.
 */

interface CollabConfig {
  url: string;
  token: string;
  enabled: boolean;
}

// Fetch the collab config once (cached) — the WS url + dedicated owner token.
let configPromise: Promise<CollabConfig> | null = null;
function loadCollabConfig(): Promise<CollabConfig> {
  configPromise ??= invoke<CollabConfig>("get_collab_config").catch(() => ({ url: "", token: "", enabled: false }));
  return configPromise;
}

/** Should this note render live? True only when collab is configured (a
 *  COLLAB_TOKEN is present) and the id is a real, collab-capable note. */
export function useLiveCollab(noteId: string): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    loadCollabConfig().then((c) => alive && setEnabled(c.enabled));
    return () => {
      alive = false;
    };
  }, []);
  return enabled && !!noteId;
}

type Kind = "document" | "code" | "spreadsheet" | "canvas";
function kindOf(note: Note): Kind {
  const t = inferContentType(note);
  return t === "canvas" || t === "code" || t === "spreadsheet" ? t : "document";
}

const COLORS = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];

export function CollabDocument({ noteId, note }: { noteId: string; note: Note }) {
  const [cfg, setCfg] = useState<CollabConfig | null>(null);
  const [ydoc] = useState(() => new Y.Doc());
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [presenceCount, setPresenceCount] = useState(1);

  useEffect(() => {
    loadCollabConfig().then(setCfg);
  }, []);

  useEffect(() => {
    if (!cfg?.enabled || !noteId) return;
    const p = new HocuspocusProvider({
      url: cfg.url,
      name: noteId,
      token: cfg.token,
      document: ydoc,
      onStatus: ({ status }) => setConnected(status === "connected"),
      onSynced: () => setSynced(true),
    });
    setProvider(p);
    const aw = p.awareness;
    const onAw = () => setPresenceCount(Math.max(1, aw?.getStates().size ?? 1));
    aw?.on("change", onAw);
    return () => {
      aw?.off("change", onAw);
      p.destroy();
    };
  }, [cfg, noteId, ydoc]);

  const kind = useMemo(() => kindOf(note), [note]);
  const language = useMemo(() => detectCodeLanguage(note.path ?? null, note.metadata ?? null), [note]);
  const user = useMemo(() => ({ name: "You", color: COLORS[0]! }), []);

  if (!cfg?.enabled || !provider) return null;

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-2 px-4 py-1.5 text-xs flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", color: "var(--text-muted)" }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: connected ? "#22c55e" : "#eab308" }} />
        Live{presenceCount > 1 ? ` · ${presenceCount} editing` : ""}
      </div>
      <div className="flex-1 min-h-0 overflow-auto" style={{ position: kind === "canvas" ? "relative" : undefined }}>
        {kind === "canvas" ? (
          <CollabCanvas ydoc={ydoc} provider={provider as never} user={user} editable />
        ) : kind === "code" ? (
          <CollabCodeEditor ydoc={ydoc} provider={provider as never} user={user} language={language} editable />
        ) : kind === "spreadsheet" ? (
          <CollabSpreadsheet ydoc={ydoc} editable />
        ) : (
          <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 28px 64px" }}>
            <CollabEditor ydoc={ydoc} provider={provider as never} user={user} seedReady={synced} toolbar editable />
          </div>
        )}
      </div>
    </div>
  );
}
