import { useRef, useState } from "react";
import type * as Y from "yjs";
import type { Editor } from "@tiptap/react";
import { MessageSquarePlus } from "lucide-react";
import { createPageThread, useThreads } from "../../editor/comments";
import { useCommentMentionPicker } from "../../lib/tiptap/MentionText";
import { ThreadCard, type CommentCommandActions } from "./CommentsSidebar";
import "./PageDiscussion.css";

/**
 * NP-CO-02 — the page-level discussion: comment threads about the page as a
 * whole, shown under the title instead of beside a passage. They are ordinary
 * threads in the shared `comments` map (marked `page: true`, no anchor in the
 * text), so replies, resolve, reopen, delete, mentions and notifications are
 * the ones every thread has. Starting or answering one needs `suggest`, like
 * any comment: editors write through their socket, suggest-level people through
 * the server's command endpoint (`actions`).
 */
export function PageDiscussion({
  ydoc,
  user,
  canComment,
  editor,
  actions,
  composeOnly = false,
}: {
  /** Only "Add comment" and its field — where the threads are already listed (the phone's Comments drawer). */
  composeOnly?: boolean;
  ydoc: Y.Doc;
  user: { name: string; color: string };
  canComment: boolean;
  editor?: Editor | null;
  actions?: CommentCommandActions;
}) {
  const threads = useThreads(ydoc).filter((t) => t.page);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const [composing, setComposing] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const mentions = useCommentMentionPicker(field, text, setText);

  if (composeOnly ? !canComment : !canComment && threads.length === 0) return null;

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setFailure("");
    if (!actions) {
      createPageThread(ydoc, `c-${crypto.randomUUID()}`, { author: user.name, color: user.color, text: value, createdAt: Date.now() });
      setText("");
      setComposing(false);
      return;
    }
    if (!actions.pageComment) { setFailure("Page comments aren’t available here yet."); return; }
    setBusy(true);
    try {
      await actions.pageComment(value);
      setText("");
      setComposing(false);
    } catch (e) {
      // The typed comment stays until the server confirms it.
      setFailure(e instanceof Error && e.message ? e.message : "That didn’t go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page-discussion" aria-label="Page discussion" data-empty={threads.length === 0 || undefined}>
      {!composeOnly && open.length > 0 && (
        <div className="page-discussion-threads">
          {open.map((t) => (
            <ThreadCard key={t.id} ydoc={ydoc} thread={t} user={user} canComment={canComment} editor={editor} actions={actions} />
          ))}
        </div>
      )}
      {!composeOnly && showResolved && resolved.length > 0 && (
        <div className="page-discussion-threads">
          {resolved.map((t) => (
            <ThreadCard key={t.id} ydoc={ydoc} thread={t} user={user} canComment={canComment} editor={editor} actions={actions} />
          ))}
        </div>
      )}
      <div className="page-discussion-bar">
        {canComment && !composing && (
          <button type="button" className="page-discussion-add focus-ring" onClick={() => { setComposing(true); requestAnimationFrame(() => field.current?.focus()); }}>
            <MessageSquarePlus size={14} aria-hidden="true" /> {threads.length ? "Add a page comment" : "Add comment"}
          </button>
        )}
        {!composeOnly && resolved.length > 0 && (
          <button type="button" className="page-discussion-resolved focus-ring" aria-expanded={showResolved} onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
        )}
      </div>
      {canComment && composing && (
        <div className="page-discussion-composer">
          <textarea
            ref={field}
            aria-label="Comment on this page"
            rows={2}
            value={text}
            placeholder="Comment on this page…"
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onSelect={mentions.onSelect}
            onInput={mentions.onInput}
            {...mentions.fieldProps}
            onKeyDown={(e) => {
              if (mentions.onKeyDown(e)) return;
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setComposing(false); setFailure(""); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
            }}
          />
          {mentions.menu}
          <div className="page-discussion-actions">
            <button type="button" className="focus-ring" onClick={() => { setComposing(false); setFailure(""); }}>Cancel</button>
            <button type="button" className="focus-ring page-discussion-send" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? "Sending…" : "Comment"}</button>
          </div>
          {failure && <p role="alert" className="page-discussion-failure">{failure}</p>}
        </div>
      )}
    </section>
  );
}
