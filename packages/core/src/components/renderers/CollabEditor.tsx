import { useCallback, useEffect, useRef, useState } from "react";
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
import { CommentOnly, commentOnRange, CommentInteraction } from "../../editor/comments";
import { WikilinkExtension } from "../../lib/tiptap/WikilinkMark";
import { WikilinkAutocomplete, type WikilinkAutocompleteState } from "../../lib/tiptap/WikilinkAutocomplete";
import { WikilinkDropdown } from "./WikilinkDropdown";
import { SlashCommand, type SlashCommandState } from "../../lib/tiptap/SlashCommand";
import { SlashMenu } from "./SlashMenu";
import type { Note } from "../../lib/types";
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
  onCommentActivate,
  onWikilinkNavigate,
  wikilinkNotes,
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
  /** Clicking commented text fires this with the thread id, so the host can
   *  open the sidebar and focus that thread. */
  onCommentActivate?: (id: string) => void;
  /** Navigate when a [[wikilink]] is clicked. In-app this opens the target note
   *  in a tab; on a share link it routes to the target's page (or request-access).
   *  Omitted → links are inert (e.g. a viewer with no navigation context). */
  onWikilinkNavigate?: (target: string) => void;
  /** Vault notes for the `[[` autocomplete dropdown. Omitted → no suggestions
   *  (e.g. a recipient on a share link with no notes list). */
  wikilinkNotes?: Note[];
}) {
  // Inline comment composer anchored to a captured selection range.
  const [composer, setComposer] = useState<{ from: number; to: number; top: number; left: number } | null>(null);
  const [draft, setDraft] = useState("");
  // `[[` autocomplete state, surfaced by the WikilinkAutocomplete plugin.
  const [autocomplete, setAutocomplete] = useState<WikilinkAutocompleteState | null>(null);
  // `/` slash-command menu state.
  const [slash, setSlash] = useState<SlashCommandState | null>(null);
  const handleUpdate = useCallback(
    ({ editor }: { editor: { getHTML: () => string } }) => onChange?.(editor.getHTML()),
    [onChange],
  );

  // The editor (and its wikilink plugin) is created once on mount, so route
  // navigation through a ref that always points at the latest handler — this
  // survives the notes list loading after the editor mounts.
  const navRef = useRef(onWikilinkNavigate);
  useEffect(() => { navRef.current = onWikilinkNavigate; }, [onWikilinkNavigate]);
  const commentActivateRef = useRef(onCommentActivate);
  useEffect(() => { commentActivateRef.current = onCommentActivate; }, [onCommentActivate]);

  const editor = useEditor({
    extensions: [
      // Shared content schema (StarterKit + Link/Typography/Highlight/Tasks) —
      // the SAME list the Prism Server uses to seed/persist the Yjs doc, so the
      // HTML↔CRDT round-trip is loss-free. View-only plugins are added here.
      ...collabExtensions(),
      Placeholder.configure({ placeholder: "Start writing together…" }),
      WikilinkExtension.configure({ onNavigate: (t) => navRef.current?.(t) }),
      WikilinkAutocomplete.configure({ onStateChange: setAutocomplete }),
      SlashCommand.configure({ onStateChange: setSlash }),
      SuggestionMode.configure({ user }),
      CommentOnly.configure({ active: !!commentOnly }),
      CommentInteraction.configure({ onActivate: (id) => commentActivateRef.current?.(id) }),
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
      {/* Collab caret/suggestion/bubble CSS lives in @prism/core styles/collab.css
          (bundled stylesheet) — a runtime React <style> here silently fails to
          register in the desktop production webview. */}
      {toolbar && editor && editable && !commentOnly && (
        <CollabToolbar
          editor={editor}
          suggesting={!!suggesting}
          onSetSuggesting={onSetSuggesting}
          canReview={canReview}
        />
      )}
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

      {/* `[[` wikilink autocomplete dropdown */}
      {editor && autocomplete?.active && (
        <WikilinkDropdown editor={editor} notes={wikilinkNotes || []} autocomplete={autocomplete} />
      )}

      {/* `/` slash-command menu */}
      {editor && slash?.active && (
        <SlashMenu editor={editor} state={slash} onClose={() => setSlash(null)} />
      )}

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
