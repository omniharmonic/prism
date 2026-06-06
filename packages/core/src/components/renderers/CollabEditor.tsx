import { useCallback, useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import Typography from "@tiptap/extension-typography";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { WikilinkExtension } from "../../lib/tiptap/WikilinkMark";

export interface CollabUser {
  name: string;
  color: string;
}

/** Minimal shape of a Yjs provider with awareness (e.g. y-webrtc WebrtcProvider). */
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
}) {
  const handleUpdate = useCallback(
    ({ editor }: { editor: { getHTML: () => string } }) => onChange?.(editor.getHTML()),
    [onChange],
  );

  const editor = useEditor({
    extensions: [
      // StarterKit 3.26 bundles Link; disable it so the explicit Link below
      // (with our options) isn't a duplicate — duplicates corrupt the schema
      // and make setContent() silently fail (blank editor).
      StarterKit.configure({ undoRedo: false, link: false }),
      Placeholder.configure({ placeholder: "Start writing together…" }),
      Link.configure({ openOnClick: false, autolink: true }),
      Typography,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      WikilinkExtension.configure({ onNavigate: () => {} }),
      Collaboration.configure({ document: ydoc }),
      ...(provider
        ? [CollaborationCaret.configure({ provider: provider as never, user })]
        : []),
    ],
    editorProps: { attributes: { class: "prose-editor outline-none min-h-[300px]" } },
    onUpdate: handleUpdate,
  });

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
      <EditorContent editor={editor} />
    </>
  );
}
