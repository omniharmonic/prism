import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { Editor } from "@tiptap/react";
import { MessageSquarePlus, Check, Trash2 } from "lucide-react";
import { useThreads, addReply, setResolved, deleteThread, type Thread } from "../../editor/comments";

/**
 * Google-Docs-style comments sidebar: live thread list (Yjs `comments` map) with
 * Open / Resolved tabs. Resolved threads drop out of the Open view and their doc
 * highlight clears (the mark's resolved flag is synced on resolve). Clicking a
 * comment in the document sets `focusedThreadId`, which selects the right tab and
 * scrolls/flashes that card. Comments are added from the on-selection bubble in
 * the editor; `editor` is needed to mutate the anchor mark on resolve/delete.
 */
export function CommentsSidebar({
  ydoc,
  user,
  canComment,
  editor,
  focusedThreadId,
}: {
  ydoc: Y.Doc;
  user: { name: string; color: string };
  canComment: boolean;
  editor?: Editor | null;
  focusedThreadId?: string | null;
}) {
  const threads = useThreads(ydoc);
  const [tab, setTab] = useState<"open" | "resolved">("open");

  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  // A click in the document focuses a thread — jump to whichever tab holds it.
  useEffect(() => {
    if (!focusedThreadId) return;
    const t = threads.find((x) => x.id === focusedThreadId);
    if (t) setTab(t.resolved ? "resolved" : "open");
  }, [focusedThreadId, threads]);

  const list = tab === "open" ? open : resolved;

  const tabBtn = (key: "open" | "resolved", label: string, count: number) => (
    <button
      onClick={() => setTab(key)}
      style={{
        flex: 1,
        height: 28,
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 7,
        border: "1px solid " + (tab === key ? "var(--color-accent)" : "var(--glass-border)"),
        background: tab === key ? "var(--color-accent)" : "transparent",
        color: tab === key ? "#fff" : "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      {label}
      {count > 0 ? ` · ${count}` : ""}
    </button>
  );

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Comments</div>

      <div style={{ display: "flex", gap: 6 }}>
        {tabBtn("open", "Open", open.length)}
        {tabBtn("resolved", "Resolved", resolved.length)}
      </div>

      {canComment && threads.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, display: "flex", alignItems: "center", gap: 6 }}>
          <MessageSquarePlus size={14} /> Select text in the document, then click <strong>Comment</strong>.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
        {threads.length > 0 && list.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {tab === "open" ? "No open comments." : "No resolved comments."}
          </p>
        )}
        {list.map((t) => (
          <ThreadCard
            key={t.id}
            ydoc={ydoc}
            thread={t}
            user={user}
            canComment={canComment}
            editor={editor}
            focused={t.id === focusedThreadId}
          />
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
  editor,
  focused,
}: {
  ydoc: Y.Doc;
  thread: Thread;
  user: { name: string; color: string };
  canComment: boolean;
  editor?: Editor | null;
  focused?: boolean;
}) {
  const [reply, setReply] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // When the matching comment is clicked in the doc, bring this card into view.
  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  return (
    <div
      ref={cardRef}
      className="glass"
      style={{
        padding: 10,
        borderRadius: 10,
        border: "1px solid " + (focused ? "var(--color-accent)" : "var(--glass-border)"),
        boxShadow: focused ? "0 0 0 2px var(--color-accent)" : undefined,
        opacity: thread.resolved ? 0.7 : 1,
        transition: "box-shadow 0.2s, border-color 0.2s",
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
        <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
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
            /* 16px so iOS doesn't zoom the viewport when this field is focused */
            style={{ flex: 1, fontSize: 16, padding: "5px 8px", borderRadius: 6, background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", outline: "none" }}
          />
          <button onClick={() => setResolved(ydoc, thread.id, true, editor)} title="Resolve" className="p-1 rounded" style={{ color: "#22c55e" }}>
            <Check size={14} />
          </button>
          <DeleteButton confirm={confirmDelete} setConfirm={setConfirmDelete} onDelete={() => deleteThread(ydoc, thread.id, editor)} />
        </div>
      )}

      {thread.resolved && canComment && (
        <div style={{ display: "flex", gap: 10, marginTop: 4, alignItems: "center" }}>
          <button onClick={() => setResolved(ydoc, thread.id, false, editor)} className="text-xs" style={{ color: "var(--text-muted)" }}>
            Reopen
          </button>
          <DeleteButton confirm={confirmDelete} setConfirm={setConfirmDelete} onDelete={() => deleteThread(ydoc, thread.id, editor)} />
        </div>
      )}
    </div>
  );
}

/** Trash icon that asks for one confirmation click before deleting. */
function DeleteButton({ confirm, setConfirm, onDelete }: { confirm: boolean; setConfirm: (v: boolean) => void; onDelete: () => void }) {
  if (confirm) {
    return (
      <button
        onClick={onDelete}
        onBlur={() => setConfirm(false)}
        autoFocus
        title="Click again to delete"
        className="text-xs"
        style={{ color: "#ef4444", fontWeight: 600 }}
      >
        Delete?
      </button>
    );
  }
  return (
    <button onClick={() => setConfirm(true)} onBlur={() => setConfirm(false)} title="Delete comment" className="p-1 rounded" style={{ color: "var(--text-muted)" }}>
      <Trash2 size={13} />
    </button>
  );
}
