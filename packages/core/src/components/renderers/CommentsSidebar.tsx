import { useState } from "react";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import { MessageSquarePlus, Check } from "lucide-react";
import { useThreads, addReply, setResolved, commentOnSelection, type Thread } from "../../editor/comments";

/**
 * Google-Docs-style comments sidebar. Threads come from the Yjs `comments` map
 * (live + persisted). Add a comment on the current selection; reply and resolve
 * threads. Available to anyone with at least comment access.
 */
export function CommentsSidebar({
  ydoc,
  editor,
  user,
  canComment,
}: {
  ydoc: Y.Doc;
  editor: Editor | null;
  user: { name: string; color: string };
  canComment: boolean;
}) {
  const threads = useThreads(ydoc);
  const [draft, setDraft] = useState("");

  function add() {
    if (!editor || !draft.trim()) return;
    const id = commentOnSelection(editor, ydoc, user, draft.trim());
    if (id) setDraft("");
  }

  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  return (
    <div
      style={{
        width: 300,
        flexShrink: 0,
        borderLeft: "1px solid var(--glass-border)",
        paddingLeft: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Comments</div>

      {canComment && (
        <div className="glass" style={{ padding: 10, borderRadius: 10, border: "1px solid var(--glass-border)" }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Select text, then comment…"
            rows={2}
            style={{
              width: "100%",
              resize: "vertical",
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text-primary)",
              fontSize: 13,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={add}
              disabled={!draft.trim()}
              className="px-2.5 py-1 rounded text-xs flex items-center gap-1"
              style={{ background: "var(--color-accent)", color: "#fff", opacity: draft.trim() ? 1 : 0.5 }}
            >
              <MessageSquarePlus size={13} /> Comment
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
        {open.length === 0 && resolved.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No comments yet.</p>
        )}
        {open.map((t) => (
          <ThreadCard key={t.id} ydoc={ydoc} thread={t} user={user} canComment={canComment} />
        ))}
        {resolved.length > 0 && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Resolved</div>
        )}
        {resolved.map((t) => (
          <ThreadCard key={t.id} ydoc={ydoc} thread={t} user={user} canComment={canComment} />
        ))}
      </div>
    </div>
  );
}

function ThreadCard({
  ydoc,
  thread,
  user,
  canComment,
}: {
  ydoc: Y.Doc;
  thread: Thread;
  user: { name: string; color: string };
  canComment: boolean;
}) {
  const [reply, setReply] = useState("");
  return (
    <div
      className="glass"
      style={{
        padding: 10,
        borderRadius: 10,
        border: "1px solid var(--glass-border)",
        opacity: thread.resolved ? 0.6 : 1,
      }}
    >
      {thread.quote && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            borderLeft: "2px solid #eab308",
            paddingLeft: 6,
            marginBottom: 6,
          }}
        >
          “{thread.quote}”
        </div>
      )}
      {thread.comments.map((c, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 16, height: 16, borderRadius: 999, background: c.color, color: "#fff", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {c.author.charAt(0).toUpperCase()}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>{c.author}</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-primary)", marginTop: 2 }}>{c.text}</div>
        </div>
      ))}

      {!thread.resolved && canComment && (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && reply.trim()) {
                addReply(ydoc, thread.id, { author: user.name, color: user.color, text: reply.trim(), createdAt: Date.now() });
                setReply("");
              }
            }}
            placeholder="Reply…"
            style={{ flex: 1, fontSize: 12, padding: "4px 8px", borderRadius: 6, background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", outline: "none" }}
          />
          <button
            onClick={() => setResolved(ydoc, thread.id, true)}
            title="Resolve"
            className="p-1 rounded"
            style={{ color: "#22c55e" }}
          >
            <Check size={14} />
          </button>
        </div>
      )}
      {thread.resolved && canComment && (
        <button
          onClick={() => setResolved(ydoc, thread.id, false)}
          className="text-xs"
          style={{ color: "var(--text-muted)", marginTop: 4 }}
        >
          Reopen
        </button>
      )}
    </div>
  );
}
