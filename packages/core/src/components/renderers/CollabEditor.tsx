import { useCallback, useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import Placeholder from "@tiptap/extension-placeholder";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import type { Editor } from "@tiptap/react";
import { Check, X, MessageSquarePlus } from "lucide-react";
import { collabExtensions } from "../../editor/collabSchema";
import { SuggestionMode, suggestionAt } from "../../editor/suggestions";
import { CommentOnly, commentOnRange } from "../../editor/comments";
import { WikilinkExtension } from "../../lib/tiptap/WikilinkMark";
import { CollabToolbar } from "./CollabToolbar";

export interface CollabUser {
  name: string;
  color: string;
}

/** Minimal shape of a Yjs provider with awareness (e.g. HocuspocusProvider). */
export interface AwarenessProvider {
  awareness: unknown;
}

/**
 * Real-time collaborative editor bound to a shared Y.Doc (CRDT). History is
 * delegated to Yjs (StarterKit undoRedo disabled). Remote carets/selections are
 * shown via CollaborationCaret using the provider's awareness.
 *
 * Seeding: the document starts empty. After a short settle (to let a peer sync
 * existing content), if the shared fragment is still empty, `seedContent()` is
 * pulled in once and marked in a shared meta map so peers don't double-seed.
 * `onChange` fires on every local/remote update for persistence by the caller.
 */
export function CollabEditor({
  ydoc,
  provider,
  user,
  seedContent,
  onChange,
  seedReady,
  toolbar,
  editable = true,
  suggesting,
  onSetSuggesting,
  canReview,
  commentOnly,
  canComment,
  onEditor,
}: {
  ydoc: Y.Doc;
  provider: AwarenessProvider | null;
  user: CollabUser;
  seedContent?: () => Promise<string | null>;
  onChange?: (html: string) => void;
  /** Gate seeding until the doc is known-synced with the server (so a late
   *  server sync can't be clobbered by a stale seed). When undefined, falls
   *  back to a short delay (e.g. P2P with no sync signal). */
  seedReady?: boolean;
  /** Show the formatting toolbar (Google-Docs-style). */
  toolbar?: boolean;
  /** When false, the editor is read-only (view/comment grants). */
  editable?: boolean;
  /** Suggest-mode on: typing/deletes become tracked suggestions. */
  suggesting?: boolean;
  /** If provided, the toolbar shows an Editing/Suggesting toggle. Omit to lock
   *  the mode (e.g. a suggest-level user can't switch to direct editing). */
  onSetSuggesting?: (on: boolean) => void;
  /** Show Accept all / Reject all (for edit/owner reviewers). */
  canReview?: boolean;
  /** Comment-only mode: selectable + commentable but content edits blocked. */
  commentOnly?: boolean;
  /** Can this user add comments? Enables the on-selection "Comment" bubble. */
  canComment?: boolean;
  /** Receives the editor instance (for an external comments sidebar). */
  onEditor?: (editor: Editor | null) => void;
}) {
  // Inline comment composer anchored to a captured selection range.
  const [composer, setComposer] = useState<{ from: number; to: number; top: number; left: number } | null>(null);
  const [draft, setDraft] = useState("");
  const handleUpdate = useCallback(
    ({ editor }: { editor: { getHTML: () => string } }) => onChange?.(editor.getHTML()),
    [onChange],
  );

  const editor = useEditor({
    extensions: [
      // Shared content schema (StarterKit + Link/Typography/Highlight/Tasks) —
      // the SAME list the Prism Server uses to seed/persist the Yjs doc, so the
      // HTML↔CRDT round-trip is loss-free. View-only plugins are added here.
      ...collabExtensions(),
      Placeholder.configure({ placeholder: "Start writing together…" }),
      WikilinkExtension.configure({ onNavigate: () => {} }),
      SuggestionMode.configure({ user }),
      CommentOnly.configure({ active: !!commentOnly }),
      Collaboration.configure({ document: ydoc }),
      ...(provider
        ? [CollaborationCaret.configure({ provider: provider as never, user })]
        : []),
    ],
    editable,
    editorProps: { attributes: { class: "prose-editor outline-none min-h-[300px]" } },
    onUpdate: handleUpdate,
  });

  // Reflect editable changes (e.g. level resolved after connect) onto the editor.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // Reflect suggest-mode onto the editor's suggestion plugin.
  useEffect(() => {
    editor?.commands.setSuggesting(!!suggesting);
  }, [editor, suggesting]);

  // Keep the comment-only guard in sync, and surface the editor to the parent.
  useEffect(() => {
    const store = editor?.storage as unknown as Record<string, { active: boolean }> | undefined;
    if (store?.commentOnly) store.commentOnly.active = !!commentOnly;
  }, [editor, commentOnly]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  // One-time seed from the backing store, but only once the doc is synced with
  // the server (seedReady) — so a late server sync can't be overwritten by a
  // stale seed. When no readiness signal is given, fall back to a short delay.
  useEffect(() => {
    if (!editor || seedReady === false) return;
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      // If a peer/server already populated the shared doc, never overwrite it.
      if (ydoc.getXmlFragment("default").length > 0) return;
      const content = seedContent ? await seedContent() : null;
      // Re-check after the async fetch in case content synced in the meantime.
      if (cancelled || !content || editor.isDestroyed) return;
      if (ydoc.getXmlFragment("default").length > 0) return;
      editor.commands.setContent(content);
    };
    const timer = seedReady === undefined ? setTimeout(run, 900) : undefined;
    if (seedReady === true) void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editor, ydoc, seedContent, seedReady]);

  return (
    <>
      <style>{`
        .collaboration-caret__caret, .collaboration-cursor__caret {
          border-left: 1px solid currentColor; border-right: 1px solid currentColor;
          margin-left: -1px; margin-right: -1px; pointer-events: none; position: relative; word-break: normal;
        }
        .collaboration-caret__label, .collaboration-cursor__label {
          position: absolute; top: -1.4em; left: -1px; font-size: 11px; font-weight: 600;
          line-height: 1; color: #fff; padding: 1px 4px; border-radius: 4px 4px 4px 0; white-space: nowrap; user-select: none;
        }
      `}</style>
      {toolbar && editor && editable && !commentOnly && (
        <CollabToolbar
          editor={editor}
          suggesting={!!suggesting}
          onSetSuggesting={onSetSuggesting}
          canReview={canReview}
        />
      )}
      <style>{`
        span[data-suggestion='insert'] { background: rgba(34,197,94,0.12); }
        span[data-suggestion='delete'] { background: rgba(239,68,68,0.10); }
        .cd-bubble { display:flex; gap:2px; padding:4px; border-radius:9px; border:1px solid var(--glass-border); background: var(--bg-surface,#1a1a1f); box-shadow: 0 6px 24px rgba(0,0,0,0.35); }
        .cd-bubble button { display:inline-flex; align-items:center; gap:5px; height:30px; padding:0 10px; border:none; border-radius:6px; background:transparent; color:var(--text-secondary); font-size:12.5px; font-weight:600; cursor:pointer; }
        .cd-bubble button:hover { background: var(--glass-hover); }
      `}</style>

      {/* On-selection "Comment" bubble (Google-Docs style). */}
      {editor && canComment && (
        <BubbleMenu
          editor={editor}
          pluginKey="commentBubble"
          shouldShow={({ state }) => {
            const { from, to, empty } = state.selection;
            if (empty || from === to) return false;
            return !suggestionAt(state, from); // the suggestion bubble owns that case
          }}
        >
          <div className="cd-bubble">
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const sel = editor.state.selection;
                const c = editor.view.coordsAtPos(sel.to);
                setComposer({
                  from: sel.from,
                  to: sel.to,
                  top: c.bottom + 6,
                  left: Math.max(8, Math.min(c.left, window.innerWidth - 288)),
                });
                setDraft("");
              }}
            >
              <MessageSquarePlus size={14} /> Comment
            </button>
          </div>
        </BubbleMenu>
      )}

      {/* Per-suggestion Accept / Reject bubble (when the cursor is in a change). */}
      {editor && canReview && (
        <BubbleMenu
          editor={editor}
          pluginKey="suggestionBubble"
          shouldShow={({ state }) => !!suggestionAt(state, state.selection.from)}
        >
          <div className="cd-bubble">
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().acceptSuggestion().run()}>
              <Check size={14} color="#22c55e" /> Accept
            </button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().rejectSuggestion().run()}>
              <X size={14} color="#ef4444" /> Reject
            </button>
          </div>
        </BubbleMenu>
      )}

      <EditorContent editor={editor} />

      {/* Comment composer, anchored to the captured selection. */}
      {composer && editor && (
        <div
          style={{
            position: "fixed",
            top: composer.top,
            left: composer.left,
            zIndex: 60,
            width: 272,
            padding: 10,
            borderRadius: 12,
            border: "1px solid var(--glass-border)",
            background: "var(--bg-surface, #1a1a1f)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
          }}
        >
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setComposer(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment();
            }}
            placeholder="Add a comment…  (⌘↵ to post)"
            rows={3}
            style={{
              width: "100%",
              resize: "vertical",
              background: "var(--glass, rgba(255,255,255,0.04))",
              border: "1px solid var(--glass-border)",
              borderRadius: 8,
              outline: "none",
              color: "var(--text-primary)",
              fontSize: 13,
              padding: "8px 10px",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
            <button
              onClick={() => setComposer(null)}
              style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 12.5, cursor: "pointer", padding: "6px 8px" }}
            >
              Cancel
            </button>
            <button
              onClick={submitComment}
              disabled={!draft.trim()}
              style={{
                background: "var(--color-accent)",
                color: "#fff",
                border: "none",
                borderRadius: 7,
                fontSize: 12.5,
                fontWeight: 600,
                padding: "6px 12px",
                cursor: "pointer",
                opacity: draft.trim() ? 1 : 0.5,
              }}
            >
              Comment
            </button>
          </div>
        </div>
      )}
    </>
  );

  function submitComment() {
    if (!editor || !composer || !draft.trim()) return;
    commentOnRange(editor, ydoc, user, draft.trim(), composer.from, composer.to);
    // Collapse the selection so the on-selection "Comment" bubble dismisses.
    editor.chain().setTextSelection(composer.to).run();
    setComposer(null);
    setDraft("");
  }
}
