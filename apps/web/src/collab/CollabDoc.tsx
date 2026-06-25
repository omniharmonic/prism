import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { CollabEditor, CommentsSidebar, CollabCodeEditor, CollabSpreadsheet, CollabCanvas, detectCodeLanguage, inferContentType, PageHeader, FontSwitch, renamePath, useUIStore, type ContentFont, type Note, type Editor } from "@prism/core";
import { MessageSquare, X, Lock } from "lucide-react";
import { GATEWAY_ORIGIN, apiBase, capabilityHeader, getCapabilityToken } from "../config";
import { updateNote as restUpdateNote } from "../parachute/rest";

/** Track a CSS breakpoint without per-render layout thrash. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth <= 820);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

const COLORS = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];

function collabUrl(): string {
  const base = GATEWAY_ORIGIN || location.origin;
  return base.replace(/^http/, "ws") + "/collab";
}

interface PresenceUser {
  name: string;
  color: string;
}

type CollabKind = "document" | "code" | "spreadsheet" | "canvas";

/** Derive the collab kind from the SAME `inferContentType` the renderers use, so
 *  the live editor always matches how the note renders (and how the server seeds
 *  it). Content sniffing inside inferContentType catches tag-less canvases. */
function detectKind(note: { path?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null; content?: string | null }): CollabKind {
  const t = inferContentType(note as never);
  return t === "canvas" || t === "code" || t === "spreadsheet" ? t : "document";
}

/** A readable document title from either markdown or HTML content (collab
 *  persists HTML, so the old "first line" heuristic would show raw tags). */
function deriveTitle(content: string): string {
  const h = content.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
  if (h?.[1]) return h[1].replace(/<[^>]+>/g, "").trim().slice(0, 100) || "Shared document";
  if (!content.includes("<")) {
    const line = content.split("\n").find((l) => l.trim());
    if (line) return line.replace(/^#+\s*/, "").trim().slice(0, 100);
  }
  const text = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 80) || "Shared document";
}

/**
 * The live collaborative document — Hocuspocus-connected, level-aware (read-only
 * for viewers, comment sidebar, suggest mode), with presence. Shared by the
 * full-page share route (CollabPage) and the in-app renderer (CollabDocument)
 * so the owner's main app gets the same real-time editor as recipients.
 *
 * `embedded` drops the full-viewport chrome so it fits inside the app canvas.
 */
export function CollabDoc({
  noteId,
  embedded = false,
  onWikilinkNavigate,
  wikilinkNotes,
}: {
  noteId: string;
  embedded?: boolean;
  /** How to handle a clicked [[wikilink]] (in-app: open a tab; share route: route
   *  to the target or request-access). */
  onWikilinkNavigate?: (target: string) => void;
  /** Vault notes for the `[[` autocomplete (in-app only). */
  wikilinkNotes?: Note[];
}) {
  const [ydoc] = useState(() => new Y.Doc());
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [denied, setDenied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [level, setLevel] = useState<string | null>(null);
  const [title, setTitle] = useState("Shared document");
  const [path, setPath] = useState<string | null>(null);
  const [contentFont, setContentFont] = useState<ContentFont>("sans");
  const [icon, setIcon] = useState<string | null>(null);
  const [kind, setKind] = useState<CollabKind>("document");
  const [language, setLanguage] = useState("plaintext");
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const narrow = useIsNarrow();
  // Comments shown by default on desktop, collapsed on mobile (doc gets full width).
  const [commentsOpen, setCommentsOpen] = useState(false); // closed by default; toggle in the header
  const [editor, setEditor] = useState<Editor | null>(null);
  const [focusedThread, setFocusedThread] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase()}/notes/${encodeURIComponent(noteId)}`, {
          credentials: "include",
          headers: capabilityHeader(),
        });
        if (!r.ok) return;
        const note = await r.json();
        setLevel(note._level ?? "own");
        setPath(note.path ?? null);
        if (typeof note.metadata?.contentFont === "string") setContentFont(note.metadata.contentFont as ContentFont);
        setIcon(typeof note.metadata?.icon === "string" ? note.metadata.icon : null);
        const k = detectKind(note);
        setKind(k);
        if (k === "code") setLanguage(detectCodeLanguage(note.path ?? null, note.metadata ?? null));
        const filename = note.path?.split("/").pop() as string | undefined;
        const titleMeta = typeof note.metadata?.title === "string" ? note.metadata.title : undefined;
        if (k === "document") setTitle(deriveTitle(note.content || ""));
        else if (k === "canvas") setTitle(titleMeta || filename || "Canvas");
        else setTitle(filename || deriveTitle(note.content || ""));
      } catch {
        /* level unknown → server still enforces */
      }
    })();
  }, [noteId]);

  // Rename via the editable page title (preserves folder + extension). Uses the
  // REST client directly (no VaultClient provider on the full-page share route).
  const handleRename = (newName: string) => {
    const next = renamePath(path, newName);
    if (!next) return;
    void restUpdateNote(noteId, { path: next }).catch(() => {});
    setPath(next);
    try { useUIStore.getState().renameTab(noteId, newName.trim()); } catch { /* no tab (share route) */ }
  };

  const handleIconChange = (emoji: string | null) => {
    setIcon(emoji);
    void restUpdateNote(noteId, { metadata: { icon: emoji } }).catch(() => {});
  };

  const isSuggestLevel = level === "suggest";
  const isCommentLevel = level === "comment";
  const canReview = level === null || level === "edit" || level === "own";
  const canComment = level !== "view";
  const editable = level !== "view";
  const commentOnly = isCommentLevel;
  const effectiveSuggesting = isSuggestLevel ? true : suggesting;

  useEffect(() => {
    if (isSuggestLevel) setSuggesting(true);
  }, [isSuggestLevel]);

  // Local-first persistence: the Y.Doc is mirrored to IndexedDB, so edits made
  // while offline (or before the server syncs) survive a reload and merge via
  // CRDT on reconnect — nothing is lost if the network drops mid-edit.
  useEffect(() => {
    const persistence = new IndexeddbPersistence(`prism-collab-${noteId}`, ydoc);
    return () => {
      void persistence.destroy();
    };
  }, [noteId, ydoc]);

  // Track browser connectivity to distinguish "offline (saved locally)" from
  // "connecting" in the status line.
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

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
      <div style={{ minHeight: embedded ? "40vh" : "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", background: "var(--bg-base)" }}>
        <div style={{ maxWidth: 440 }}>
          <div style={{ width: 56, height: 56, borderRadius: "var(--radius-lg)", background: "var(--surface-hover)", color: "var(--text-muted)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
            <Lock size={26} strokeWidth={1.5} />
          </div>
          <h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, margin: 0, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            Request access
          </h1>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.6 }}>
            You don’t have access to this document. Ask the owner to share it with your account, or
            sign in if it was already shared with you.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 22 }}>
            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 36,
                padding: "0 18px",
                borderRadius: "var(--radius-md)",
                background: "var(--color-accent)",
                color: "#fff",
                fontSize: "var(--text-base)",
                fontWeight: 550,
                textDecoration: "none",
              }}
            >
              Sign in
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (!provider) return null;

  const outer: React.CSSProperties = embedded
    ? { padding: "0 16px" }
    : { minHeight: "100dvh", padding: "0 16px", background: "var(--bg-base, #0d0d0f)" };

  const isCode = kind === "code";
  const isSheet = kind === "spreadsheet";
  const isCanvas = kind === "canvas";
  const isDocument = kind === "document";
  const statusText = !connected
    ? online
      ? "Connecting…"
      : "Offline · saved locally"
    : level === "view"
      ? "View only"
      : !isDocument
        ? "Editing"
        : commentOnly
          ? "Commenting"
          : effectiveSuggesting
            ? "Suggesting"
            : "Editing";

  // Comments + suggestions are prose-only; code/spreadsheets are pure collab data.
  const showComments = isDocument;
  const sidebar = <CommentsSidebar ydoc={ydoc} user={user} canComment={canComment} editor={editor} focusedThreadId={focusedThread} />;

  return (
    <div style={outer}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: narrow ? "12px 14px 96px" : "16px 20px 96px" }}>
        {/* Header — shared page chrome, identical to the non-collab document view */}
        <PageHeader
          path={path}
          fallbackName={title}
          onRename={canReview ? handleRename : undefined}
          icon={icon}
          onIconChange={canReview ? handleIconChange : undefined}
          right={
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: connected ? "#22c55e" : online ? "#eab308" : "#ef4444" }} />
                {connected ? "Live · " : ""}{statusText}
              </span>
              {isDocument && <FontSwitch value={contentFont} onChange={setContentFont} />}
              <PresenceAvatars users={presence} />
              {showComments && (
                <button
                  onClick={() => setCommentsOpen((o) => !o)}
                  title="Comments"
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
                    cursor: "pointer",
                    color: commentsOpen ? "#fff" : "var(--text-secondary)",
                    background: commentsOpen ? "var(--color-accent)" : "transparent",
                    border: commentsOpen ? "1px solid var(--color-accent)" : "1px solid var(--glass-border)",
                  }}
                >
                  <MessageSquare size={14} />
                  {!narrow && "Comments"}
                </button>
              )}
            </div>
          }
        />

        {/* Doc + (desktop) inline comments */}
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
          <div
            data-content-font={isDocument ? contentFont : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              // Documents are full-bleed (the prose body self-centers at
              // --content-measure) to match the non-collab DocumentRenderer;
              // code/sheet/canvas keep a contained card.
              background: isDocument ? "transparent" : "var(--bg-surface, rgba(255,255,255,0.03))",
              border: isDocument ? "none" : "1px solid var(--glass-border)",
              borderRadius: isDocument ? 0 : 16,
              padding: isDocument ? "4px 0 64px" : 0,
              minHeight: isCanvas ? undefined : "60vh",
              height: isCanvas ? (narrow ? "78vh" : "80vh") : undefined,
              position: isCanvas ? "relative" : undefined,
              overflow: isDocument ? undefined : "hidden",
              display: isSheet ? "flex" : undefined,
            }}
          >
            {isCanvas ? (
              <CollabCanvas ydoc={ydoc} provider={provider as never} user={user} editable={editable} />
            ) : isCode ? (
              <CollabCodeEditor
                ydoc={ydoc}
                provider={provider as never}
                user={user}
                language={language}
                editable={editable}
              />
            ) : isSheet ? (
              <div style={{ flex: 1, minHeight: "60vh", display: "flex", flexDirection: "column" }}>
                <CollabSpreadsheet ydoc={ydoc} editable={editable} />
              </div>
            ) : (
              <CollabEditor
                ydoc={ydoc}
                provider={provider as never}
                user={user}
                seedReady={synced}
                toolbar
                editable={editable}
                suggesting={effectiveSuggesting}
                onSetSuggesting={isSuggestLevel ? undefined : canReview ? setSuggesting : undefined}
                canReview={canReview}
                commentOnly={commentOnly}
                canComment={canComment}
                onEditor={setEditor}
                onCommentActivate={(id) => {
                  setCommentsOpen(true);
                  setFocusedThread(id);
                }}
                onWikilinkNavigate={onWikilinkNavigate}
                wikilinkNotes={wikilinkNotes}
              />
            )}
          </div>
          {showComments && !narrow && commentsOpen && <div style={{ width: 320, flexShrink: 0 }}>{sidebar}</div>}
        </div>
      </div>

      {/* Mobile comments drawer */}
      {showComments && narrow && commentsOpen && (
        <>
          <div onClick={() => setCommentsOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 40 }} />
          <div
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(360px, 88vw)",
              zIndex: 41,
              background: "var(--bg-base, #0d0d0f)",
              borderLeft: "1px solid var(--glass-border)",
              padding: 16,
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
              <button onClick={() => setCommentsOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}>
                <X size={18} />
              </button>
            </div>
            {sidebar}
          </div>
        </>
      )}
    </div>
  );
}

function PresenceAvatars({ users }: { users: PresenceUser[] }) {
  return (
    <div style={{ display: "flex" }}>
      {users.slice(0, 5).map((u, i) => (
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
