import { useCallback, useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { collabExtensions } from "../../editor/collabSchema";
import { SuggestionMode } from "../../editor/suggestions";
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
}) {
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
      {toolbar && editor && editable && (
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
      `}</style>
      <EditorContent editor={editor} />
    </>
  );
}
