import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { Editor } from "@tiptap/react";
import { MessageSquarePlus, Check, Trash2, Pencil } from "lucide-react";
import { useThreads, addReply, setResolved, deleteThread, type Thread, type CommentItem } from "../../editor/comments";
import { MentionText, useCommentMentionPicker } from "../../lib/tiptap/MentionText";
import { PageNotificationLevelButton } from "../inbox/PageNotificationLevel";
import "../inbox/inbox.css";

/** Edit (text) or delete one comment of a thread; deleting the last one deletes the thread. */
function changeComment(ydoc: Y.Doc, threadId: string, index: number, text: string | null, editor?: Editor | null): void {
  const thread = ydoc.getMap<Y.Map<unknown>>("comments").get(threadId);
  const items = thread?.get("comments") as Y.Array<CommentItem & { editedAt?: number }> | undefined;
  const current = items?.get(index);
  if (!items || !current) return;
  if (text === null && items.length === 1) return deleteThread(ydoc, threadId, editor);
  ydoc.transact(() => {
    items.delete(index, 1);
    if (text !== null) items.insert(index, [{ ...current, text, editedAt: Date.now() }]);
  });
}

/**
 * Server-authored thread actions for suggest-only people (NP-CO-12): their socket
 * is read-only, so a reply/resolve/delete must go through the command endpoint
 * instead of the shared Y.Doc. Each resolves on a confirmed change and throws
 * (with a message safe to show) otherwise; the live thread list updates from
 * the server's own write.
 */
export interface CommentCommandActions {
  reply(threadId: string, text: string): Promise<void>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  remove(threadId: string): Promise<void>;
  /** Open a page-level thread (NP-CO-02). Absent = this person writes it on the shared doc directly. */
  pageComment?(text: string): Promise<void>;
  /** Show Delete only where this person may delete (the server still decides). */
  canDelete?(thread: Thread): boolean;
}

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
  actions,
  noteId,
}: {
  ydoc: Y.Doc;
  user: { name: string; color: string };
  canComment: boolean;
  editor?: Editor | null;
  focusedThreadId?: string | null;
  actions?: CommentCommandActions;
  /** The page these comments belong to (the per-page notification level). When a host
   *  does not pass it, the control works out the page from where it is mounted. */
  noteId?: string | null;
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
        border: "1px solid " + (tab === key ? "var(--action-bg, var(--color-accent))" : "var(--glass-border)"),
        background: tab === key ? "var(--action-bg, var(--color-accent))" : "transparent",
        color: tab === key ? "var(--action-fg, #fff)" : "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      {label}
      {count > 0 ? ` · ${count}` : ""}
    </button>
  );

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Comments</div>
        {/* NP-CO-04: what this page may tell you about. Hidden for share-link guests (no inbox). */}
        <PageNotificationLevelButton noteId={noteId} />
      </div>

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
            actions={actions}
          />
        ))}
      </div>
    </div>
  );
}

export function ThreadCard({
  ydoc,
  thread,
  user,
  canComment,
  editor,
  focused,
  actions,
}: {
  ydoc: Y.Doc;
  thread: Thread;
  user: { name: string; color: string };
  canComment: boolean;
  editor?: Editor | null;
  focused?: boolean;
  actions?: CommentCommandActions;
}) {
  const [reply, setReply] = useState("");
  const replyRef = useRef<HTMLInputElement>(null);
  const replyMentions = useCommentMentionPicker(replyRef, reply, setReply);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // Commands keep the typed reply until the server confirms it.
  const act = async (fn: () => Promise<void>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await fn();
      after?.();
    } catch (e) {
      setFailure(e instanceof Error && e.message ? e.message : "That didn’t go through. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const sendReply = () => {
    const text = reply.trim();
    if (!text) return;
    if (actions) void act(() => actions.reply(thread.id, text), () => setReply(""));
    else {
      addReply(ydoc, thread.id, { author: user.name, color: user.color, text, createdAt: Date.now() });
      setReply("");
    }
  };
  const resolve = (value: boolean) => (actions ? void act(() => actions.resolve(thread.id, value)) : setResolved(ydoc, thread.id, value, editor));
  const remove = () => (actions ? void act(() => actions.remove(thread.id)) : deleteThread(ydoc, thread.id, editor));
  const mayDelete = !actions || (actions.canDelete?.(thread) ?? true);
  const cardRef = useRef<HTMLDivElement>(null);

  // When the matching comment is clicked in the doc, bring this card into view.
  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  return (
    <div
      ref={cardRef}
      data-comment-id={thread.id}
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
      {thread.page && !thread.quote && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>Page comment</div>
      )}
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
        <CommentRow
          key={i}
          item={c as CommentItem & { editedAt?: number; agent?: boolean }}
          // Editing/deleting ONE comment is a raw Y.Doc write: not offered to command (suggest-only) users.
          own={!actions && canComment && c.author === user.name && !(c as { agent?: boolean }).agent}
          onSave={(text) => changeComment(ydoc, thread.id, i, text, editor)}
          onDelete={() => changeComment(ydoc, thread.id, i, null, editor)}
        />
      ))}

      {!thread.resolved && canComment && (
        <>
        <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
          <input
            ref={replyRef}
            aria-label="Reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onSelect={replyMentions.onSelect}
            onInput={replyMentions.onInput}
            {...replyMentions.fieldProps}
            onKeyDown={(e) => {
              if (replyMentions.onKeyDown(e)) return;
              if (e.key === "Enter" && reply.trim()) sendReply();
            }}
            placeholder="Reply…"
            disabled={busy}
            /* 16px so iOS doesn't zoom the viewport when this field is focused */
            style={{ flex: 1, minWidth: 0, fontSize: 16, padding: "5px 8px", borderRadius: 6, background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", outline: "none" }}
          />
          <button onClick={() => resolve(true)} disabled={busy} title="Resolve" aria-label="Resolve thread" className="p-1 rounded prism-comment-icon" style={{ color: "#22c55e" }}>
            <Check size={14} />
          </button>
          {mayDelete && <DeleteButton confirm={confirmDelete} setConfirm={setConfirmDelete} onDelete={remove} label="Delete thread" />}
        </div>
        {replyMentions.menu}
        </>
      )}

      {thread.resolved && canComment && (
        <div style={{ display: "flex", gap: 10, marginTop: 4, alignItems: "center" }}>
          <button onClick={() => resolve(false)} disabled={busy} className="text-xs" style={{ color: "var(--text-muted)" }}>
            Reopen
          </button>
          {mayDelete && <DeleteButton confirm={confirmDelete} setConfirm={setConfirmDelete} onDelete={remove} label="Delete thread" />}
        </div>
      )}
      {failure && <p role="alert" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-danger, #ef4444)" }}>{failure}</p>}
    </div>
  );
}

/** One comment: author, text (person mentions as chips), and edit / delete for your own. */
function CommentRow({ item, own, onSave, onDelete }: {
  item: CommentItem & { editedAt?: number };
  own: boolean;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mentions = useCommentMentionPicker(ref, text, setText);
  const save = () => {
    if (!text.trim()) return;
    onSave(text.trim());
    setEditing(false);
  };
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 16, height: 16, borderRadius: 999, background: item.color, color: "#fff", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {item.author.charAt(0).toUpperCase()}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>{item.author}</span>
        {item.editedAt && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>(edited)</span>}
        {own && !editing && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
            <button onClick={() => { setText(item.text); setEditing(true); }} title="Edit comment" aria-label="Edit comment" className="p-1 rounded prism-comment-icon" style={{ color: "var(--text-muted)" }}>
              <Pencil size={12} />
            </button>
            <DeleteButton confirm={confirm} setConfirm={setConfirm} onDelete={onDelete} label="Delete comment" />
          </span>
        )}
      </div>
      {editing ? (
        <div style={{ marginTop: 4 }}>
          <textarea
            ref={ref}
            aria-label="Edit comment"
            autoFocus
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onSelect={mentions.onSelect}
            onInput={mentions.onInput}
            {...mentions.fieldProps}
            onKeyDown={(e) => {
              if (mentions.onKeyDown(e)) return;
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            }}
            style={{ width: "100%", boxSizing: "border-box", fontSize: 16, padding: "5px 8px", borderRadius: 6, background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", outline: "none", resize: "vertical" }}
          />
          {mentions.menu}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
            <button className="text-xs" style={{ color: "var(--text-muted)", padding: "4px 6px" }} onClick={() => setEditing(false)}>Cancel</button>
            <button className="text-xs" style={{ color: "var(--text-accent)", fontWeight: 600, padding: "4px 6px" }} disabled={!text.trim()} onClick={save}>Save</button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-primary)", marginTop: 2, overflowWrap: "anywhere" }}><MentionText text={item.text} /></div>
      )}
    </div>
  );
}

/** Trash icon that asks for one confirmation click before deleting. */
function DeleteButton({ confirm, setConfirm, onDelete, label = "Delete comment" }: { confirm: boolean; setConfirm: (v: boolean) => void; onDelete: () => void; label?: string }) {
  // Safari does not focus a button on click, and React keeps the same <button> for both states
  // (so `autoFocus` never runs): without this the confirmation had no focus to lose and
  // "moving away cancels" never happened there. For the same reason the confirming press must
  // not move focus (Safari would blur the button on mousedown and cancel before the click).
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirm && document.activeElement !== button.current) button.current?.focus(); }, [confirm]);
  if (confirm) {
    return (
      <button
        ref={button}
        onMouseDown={(e) => e.preventDefault()}
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
    <button ref={button} onClick={() => setConfirm(true)} onBlur={() => setConfirm(false)} title={label} aria-label={label} className="p-1 rounded prism-comment-icon" style={{ color: "var(--text-muted)" }}>
      <Trash2 size={13} />
    </button>
  );
}
