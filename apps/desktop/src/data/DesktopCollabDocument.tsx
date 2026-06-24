import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { invoke } from "@tauri-apps/api/core";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  CollabEditor,
  CommentsSidebar,
  CollabCodeEditor,
  CollabSpreadsheet,
  CollabCanvas,
  detectCodeLanguage,
  inferContentType,
  PageHeader,
  FontSwitch,
  renamePath,
  useUpdateNote,
  useUIStore,
  useWikilinkNavigate,
  useNotes,
  type ContentFont,
  type Note,
} from "@prism/core";
import { MessageSquare } from "lucide-react";

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
  const [suggesting, setSuggesting] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false); // closed by default

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

  // Shared document-chrome state (matches DocumentRenderer + web CollabDoc).
  const updateNote = useUpdateNote();
  const renameTab = useUIStore((s) => s.renameTab);
  const navigateWikilink = useWikilinkNavigate();
  const { data: allNotes } = useNotes();
  const [contentFont, setContentFont] = useState<ContentFont>((note.metadata?.contentFont as ContentFont) || "sans");
  const [icon, setIcon] = useState<string | null>(typeof note.metadata?.icon === "string" ? note.metadata.icon : null);
  useEffect(() => {
    setContentFont((note.metadata?.contentFont as ContentFont) || "sans");
    setIcon(typeof note.metadata?.icon === "string" ? note.metadata.icon : null);
  }, [note.id, note.metadata]);

  const handleRename = (newName: string) => {
    const next = renamePath(note.path, newName);
    if (!next) return;
    updateNote.mutate({ id: noteId, path: next });
    renameTab(noteId, newName.trim());
  };
  const handleIcon = (emoji: string | null) => {
    setIcon(emoji);
    updateNote.mutate({ id: noteId, metadata: { icon: emoji } });
  };
  const handleFont = (f: ContentFont) => {
    setContentFont(f);
    updateNote.mutate({ id: noteId, metadata: { contentFont: f } });
  };

  if (!cfg?.enabled || !provider) return null;
  const isDoc = kind === "document";

  const headerRight = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 4 }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: connected ? "#22c55e" : "#eab308" }} />
        Live{presenceCount > 1 ? ` · ${presenceCount}` : ""}
      </span>
      {isDoc && <FontSwitch value={contentFont} onChange={handleFont} />}
      {isDoc && (
        <button
          onClick={() => setCommentsOpen((o) => !o)}
          className="interactive"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 30,
            padding: "0 10px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            fontWeight: 600,
            color: commentsOpen ? "#fff" : "var(--text-secondary)",
            background: commentsOpen ? "var(--color-accent)" : "transparent",
            border: commentsOpen ? "1px solid var(--color-accent)" : "1px solid var(--glass-border)",
          }}
        >
          <MessageSquare size={13} /> Comments
        </button>
      )}
    </div>
  );

  return (
    <div className="h-full overflow-auto" style={{ padding: "0 16px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "16px 20px 96px" }}>
        <PageHeader
          path={note.path}
          onRename={handleRename}
          icon={icon}
          onIconChange={handleIcon}
          right={headerRight}
        />
        <div
          data-content-font={isDoc ? contentFont : undefined}
          style={{ display: "flex", gap: 20, alignItems: "flex-start" }}
        >
          <div
            style={{
              flex: 1,
              minWidth: 0,
              position: kind === "canvas" ? "relative" : undefined,
              height: kind === "canvas" ? "78vh" : undefined,
              minHeight: kind === "canvas" ? undefined : "50vh",
            }}
          >
            {kind === "canvas" ? (
              <CollabCanvas ydoc={ydoc} provider={provider as never} user={user} editable />
            ) : kind === "code" ? (
              <CollabCodeEditor ydoc={ydoc} provider={provider as never} user={user} language={language} editable />
            ) : kind === "spreadsheet" ? (
              <CollabSpreadsheet ydoc={ydoc} editable />
            ) : (
              <CollabEditor
                ydoc={ydoc}
                provider={provider as never}
                user={user}
                seedReady={synced}
                toolbar
                editable
                suggesting={suggesting}
                onSetSuggesting={setSuggesting}
                canReview
                canComment
                onWikilinkNavigate={navigateWikilink}
                wikilinkNotes={allNotes ?? []}
              />
            )}
          </div>
          {isDoc && commentsOpen && (
            <div style={{ width: 300, flexShrink: 0 }}>
              <CommentsSidebar ydoc={ydoc} user={user} canComment />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
