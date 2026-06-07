import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { CollabEditor, CommentsSidebar, CollabCodeEditor, detectCodeLanguage } from "@prism/core";
import { MessageSquare, X } from "lucide-react";
import { GATEWAY_ORIGIN, apiBase, capabilityHeader, getCapabilityToken } from "../config";

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

type CollabKind = "document" | "code";

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb", "c", "cpp", "h", "hpp",
  "css", "scss", "less", "json", "yaml", "yml", "toml", "sh", "bash", "zsh", "sql",
  "php", "swift", "kt", "lua", "r", "jl", "ex", "exs", "clj", "html", "htm", "xml",
]);

/** Client mirror of the server's noteKind — keep the two in sync so the editor
 *  matches how the server seeds/persists the Y.Doc. */
function detectKind(note: { path?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null }): CollabKind {
  if (note.metadata?.["prism_type"] === "code") return "code";
  if ((note.tags ?? []).includes("code")) return "code";
  const ext = note.path?.split(".").pop()?.toLowerCase();
  if (ext && CODE_EXTS.has(ext)) return "code";
  return "document";
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
export function CollabDoc({ noteId, embedded = false }: { noteId: string; embedded?: boolean }) {
  const [ydoc] = useState(() => new Y.Doc());
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [denied, setDenied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [level, setLevel] = useState<string | null>(null);
  const [title, setTitle] = useState("Shared document");
  const [kind, setKind] = useState<CollabKind>("document");
  const [language, setLanguage] = useState("plaintext");
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const narrow = useIsNarrow();
  // Comments shown by default on desktop, collapsed on mobile (doc gets full width).
  const [commentsOpen, setCommentsOpen] = useState(() => (typeof window !== "undefined" ? window.innerWidth > 820 : true));

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
        const k = detectKind(note);
        setKind(k);
        if (k === "code") {
          setLanguage(detectCodeLanguage(note.path ?? null, note.metadata ?? null));
          // Code notes have a path/filename title; fall back to derived text.
          setTitle((note.path?.split("/").pop() as string) || deriveTitle(note.content || ""));
        } else {
          setTitle(deriveTitle(note.content || ""));
        }
      } catch {
        /* level unknown → server still enforces */
      }
    })();
  }, [noteId]);

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
      <div style={{ minHeight: embedded ? "40vh" : "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
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

  const outer: React.CSSProperties = embedded
    ? { padding: "0 16px" }
    : { minHeight: "100dvh", padding: "0 16px", background: "var(--bg-base, #0d0d0f)" };

  const isCode = kind === "code";
  const statusText = !connected
    ? "Connecting…"
    : level === "view"
      ? "View only"
      : isCode
        ? "Editing"
        : commentOnly
          ? "Commenting"
          : effectiveSuggesting
            ? "Suggesting"
            : "Editing";

  // Comments + suggestions are prose-only; code is pure collaborative text.
  const showComments = !isCode;
  const sidebar = <CommentsSidebar ydoc={ydoc} user={user} canComment={canComment} />;

  return (
    <div style={outer}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: narrow ? "12px 14px 96px" : "16px 20px 96px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: narrow ? 16 : 18, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {title}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted, #888)", marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: connected ? "#22c55e" : "#eab308" }} />
              Live · {statusText}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <PresenceAvatars users={presence} />
            {showComments && (
            <button
              onClick={() => setCommentsOpen((o) => !o)}
              title="Comments"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 32,
                padding: "0 10px",
                borderRadius: 8,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                color: commentsOpen ? "#fff" : "var(--text-secondary)",
                background: commentsOpen ? "var(--color-accent)" : "transparent",
                border: `1px solid ${commentsOpen ? "var(--color-accent)" : "var(--glass-border)"}`,
              }}
            >
              <MessageSquare size={14} />
              {!narrow && "Comments"}
            </button>
            )}
          </div>
        </div>

        {/* Doc + (desktop) inline comments */}
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              background: "var(--bg-surface, rgba(255,255,255,0.03))",
              border: "1px solid var(--glass-border)",
              borderRadius: 16,
              padding: isCode ? 0 : narrow ? "16px 16px 36px" : "24px 32px 48px",
              minHeight: "60vh",
              overflow: isCode ? "hidden" : undefined,
            }}
          >
            {isCode ? (
              <CollabCodeEditor
                ydoc={ydoc}
                provider={provider as never}
                user={user}
                language={language}
                editable={editable}
              />
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
