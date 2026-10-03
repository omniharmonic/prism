import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import Placeholder from "@tiptap/extension-placeholder";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import type { Editor } from "@tiptap/react";
import { Check, X } from "lucide-react";
import { collabExtensions } from "../../editor/collabSchema";
import { SuggestionMode, suggestionAt } from "../../editor/suggestions";
import { CommentOnly, commentOnRange, CommentInteraction } from "../../editor/comments";
import { WikilinkExtension } from "../../lib/tiptap/WikilinkMark";
import { WikilinkAutocomplete, type WikilinkAutocompleteState } from "../../lib/tiptap/WikilinkAutocomplete";
import { WikilinkDropdown } from "./WikilinkDropdown";
import { SlashCommand, type SlashCommandState } from "../../lib/tiptap/SlashCommand";
import { SlashMenu } from "./SlashMenu";
import type { Note } from "../../lib/types";
import { SelectionActions } from "./SelectionActions";
import { DocumentOutline } from "./DocumentOutline";
import { CollabToolbar } from "./CollabToolbar";
import { KeyboardToolbar } from "./KeyboardToolbar";
import { SuggestionReview } from "./SuggestionReview";
import "./editor-blocks.css";
import { BlockKeymap } from "../../lib/tiptap/blockCommands";
import { BlockHandles } from "./BlockHandles";
import { TableControls } from "./TableControls";
import { ImageUpload, type ImageUploader, type FileUploader } from "../../lib/tiptap/ImageUpload";
import "../../lib/tiptap/mediaViews";
import { SearchHighlight } from "../../lib/tiptap/SearchHighlight";
import { UrlPaste, type UrlPasteState, type Unfurler } from "../../lib/tiptap/UrlPaste";
import { EditorFindBar } from "./EditorFindBar";
import { PasteUrlMenu } from "./PasteUrlMenu";
import { DatabaseInsert, type DatabaseInsertRequest } from "../../lib/tiptap/databaseView";
import { InsertDatabaseDialog } from "./InsertDatabaseDialog";
import { HumanSuggestionComposer, type ComposerKind, type HumanCommandChannel } from "./HumanSuggestionComposer";
import "../../lib/tiptap/MentionView";
import { MentionSuggest, type MentionSuggestState } from "../../lib/tiptap/MentionSuggest";
import { MentionContext, setMentionNoteId } from "../../lib/tiptap/MentionContext";
import { MentionMenu } from "../../lib/tiptap/MentionMenu";
import { useCommentMentionPicker } from "../../lib/tiptap/MentionText";

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
  uploadImage,
  uploadFile,
  unfurl,
  hostPath,
  onUploadError,
  humanCommands,
  noteId,
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
  /** Store a pasted/dropped/picked image and return its URL. Omitted → upload
   *  is hidden and only "Image from URL" is offered. Read at mount. */
  uploadImage?: ImageUploader;
  /** Store a pasted/dropped/picked non-image file (PDF, audio, video, other). Omitted → no file blocks. Read at mount. */
  uploadFile?: FileUploader;
  /** Link previews for bookmark blocks. Read at mount. */
  unfurl?: Unfurler;
  /** This page's path: enables the inline-database slash items (a new database becomes its sub-page). Omitted → hidden. Read at mount. */
  hostPath?: string | null;
  /** User-facing upload failure message. */
  onUploadError?: (message: string) => void;
  /** Suggest-only (NP-CO-12): the socket is read-only, so suggestions and
   *  comments go through server-authored commands. Implies `editable={false}`. */
  humanCommands?: HumanCommandChannel;
  /** The note this editor shows (date-chip reminders are created for it). */
  noteId?: string;
}) {
  const suggestionBubble = useRef<HTMLDivElement>(null);
  // Inline comment composer anchored to a captured selection range.
  const [composer, setComposer] = useState<{ from: number; to: number; top: number; left: number } | null>(null);
  const [draft, setDraft] = useState("");
  // Suggest-only command composer (anchored at the selection) + its last outcome.
  const [human, setHuman] = useState<{ kind: ComposerKind; empty: boolean; top: number; left: number } | null>(null);
  const [humanNotice, setHumanNotice] = useState("");
  // `[[` autocomplete state, surfaced by the WikilinkAutocomplete plugin.
  const [autocomplete, setAutocomplete] = useState<WikilinkAutocompleteState | null>(null);
  // `/` slash-command menu state.
  const [slash, setSlash] = useState<SlashCommandState | null>(null);
  // `@` mention menu state.
  const [mention, setMention] = useState<MentionSuggestState | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const draftMentions = useCommentMentionPicker(draftRef, draft, setDraft);
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

  const uploadRef = useRef(uploadImage);
  useEffect(() => { uploadRef.current = uploadImage; }, [uploadImage]);
  const uploadFileRef = useRef(uploadFile);
  useEffect(() => { uploadFileRef.current = uploadFile; }, [uploadFile]);
  const unfurlRef = useRef(unfurl);
  useEffect(() => { unfurlRef.current = unfurl; }, [unfurl]);
  const [pasteState, setPasteState] = useState<UrlPasteState | null>(null);
  const [find, setFind] = useState<null | { replace: boolean }>(null);
  const [dbInsert, setDbInsert] = useState<DatabaseInsertRequest | null>(null);
  const hostPathRef = useRef(hostPath);
  useEffect(() => { hostPathRef.current = hostPath; }, [hostPath]);
  const findRef = useRef<HTMLDivElement>(null);
  const uploadErrorRef = useRef(onUploadError);
  useEffect(() => { uploadErrorRef.current = onUploadError; }, [onUploadError]);

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
      MentionSuggest.configure({ onStateChange: setMention }),
      MentionContext.configure({ noteId: noteId ?? null }),
      BlockKeymap,
      ImageUpload.configure({
        upload: uploadImage ? (file) => uploadRef.current!(file) : undefined,
        uploadFile: uploadFile ? (file) => uploadFileRef.current!(file) : undefined,
        onError: (message) => uploadErrorRef.current?.(message),
      }),
      UrlPaste.configure({ onStateChange: setPasteState, unfurl: unfurl ? (url) => unfurlRef.current!(url) : undefined }),
      SearchHighlight,
      DatabaseInsert.configure({ onRequest: hostPath !== undefined ? setDbInsert : undefined }),
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

  // ⌘F find / ⌘⇧H find + replace, while focus is in this editor (or its find bar).
  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const isFind = (e.metaKey || e.ctrlKey) && !e.shiftKey && k === "f";
      const isReplace = (e.metaKey || e.ctrlKey) && e.shiftKey && k === "h";
      if (!isFind && !isReplace) return;
      const active = document.activeElement;
      let inside = false;
      // Only THIS editor (or its own find bar): several live editors may share a page.
      try { inside = !!active && (editor.view.dom.contains(active) || !!findRef.current?.contains(active)); } catch { inside = false; }
      if (!inside) return;
      e.preventDefault();
      setFind({ replace: isReplace });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

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

  useEffect(() => setMentionNoteId(editor, noteId ?? null), [editor, noteId]);

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
      {toolbar && editor && editable && !commentOnly && !suggesting && <KeyboardToolbar editor={editor} />}
      {toolbar && editor && (!editable || commentOnly) && (
        <div className="document-outline-readonly"><DocumentOutline editor={editor} /></div>
      )}
      {editor && <SuggestionReview editor={editor} canReview={!!canReview} />}
      {/* On-selection "Comment" bubble (Google-Docs style). */}
      {editor && (
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
            <SelectionActions
              editor={editor}
              allowFormatting={editable && !commentOnly}
              onSuggest={humanCommands ? () => openHuman("suggest") : undefined}
              onComment={humanCommands ? (canComment ? () => openHuman("comment") : undefined) : canComment ? () => {
                const sel = editor.state.selection;
                const c = editor.view.coordsAtPos(sel.to);
                setComposer({
                  from: sel.from,
                  to: sel.to,
                  top: c.bottom + 6,
                  left: Math.max(8, Math.min(c.left, window.innerWidth - 288)),
                });
                setDraft("");
              } : undefined}
            />
          </div>
        </BubbleMenu>
      )}

      {/* Per-suggestion Accept / Reject bubble (when the cursor is in a change). */}
      {editor && canReview && (
        <BubbleMenu
          editor={editor}
          pluginKey="suggestionBubble"
          shouldShow={({ editor: current, state }) => (current.isFocused || !!suggestionBubble.current?.contains(document.activeElement)) && !!suggestionAt(state, state.selection.from)}
        >
          <div ref={suggestionBubble} className="cd-bubble">
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().acceptSuggestion().run()}>
              <Check size={14} color="#22c55e" /> Accept
            </button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().rejectSuggestion().run()}>
              <X size={14} color="#ef4444" /> Reject
            </button>
          </div>
        </BubbleMenu>
      )}

      {humanCommands && editor && (
        <div className="prism-suggest-banner" role="note" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "0 0 12px", padding: "8px 12px", borderRadius: 10, border: "1px solid var(--glass-border)", background: "color-mix(in srgb, var(--color-accent) 6%, transparent)", fontSize: 12.5, color: "var(--text-secondary)" }}>
          <span style={{ flex: 1, minWidth: 200 }}>You can suggest changes. Select text, then choose <strong>Suggest edit</strong> or <strong>Comment</strong>. An editor reviews each suggestion.</span>
          {editor.state.doc.childCount === 1 && editor.state.doc.firstChild?.isTextblock && editor.state.doc.firstChild.content.size === 0 && (
            <button type="button" onClick={() => openHuman("suggest", true)} style={{ minHeight: 30, padding: "4px 10px", borderRadius: 7, border: "1px solid var(--glass-border)", background: "var(--bg-surface)", color: "var(--text-primary)", cursor: "pointer", fontSize: 12.5 }}>
              Suggest text
            </button>
          )}
        </div>
      )}
      {humanNotice && <p role="status" style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--text-secondary)" }}>{humanNotice}</p>}
      <EditorContent editor={editor} />
      {human && editor && humanCommands && (
        <HumanSuggestionComposer
          editor={editor}
          ydoc={ydoc}
          channel={humanCommands}
          kind={human.kind}
          initialAction={human.empty ? "empty" : "replace"}
          anchorRect={{ top: human.top, left: human.left }}
          onClose={() => setHuman(null)}
          onDone={(message) => {
            setHuman(null);
            setHumanNotice(message);
            window.setTimeout(() => setHumanNotice(""), 4000);
          }}
        />
      )}

      {/* Block gutter. Structural moves are raw edits, so it is off while
          suggesting (tracked changes) or comment-only. */}
      {editor && <BlockHandles editor={editor} enabled={editable && !commentOnly && !suggesting} />}
      {editor && editable && !commentOnly && <TableControls editor={editor} />}

      {/* `[[` wikilink autocomplete dropdown */}
      {editor && autocomplete?.active && (
        <WikilinkDropdown editor={editor} notes={wikilinkNotes || []} autocomplete={autocomplete} />
      )}

      {/* `/` slash-command menu */}
      {editor && slash?.active && (
        <SlashMenu editor={editor} state={slash} onClose={() => setSlash(null)} />
      )}

      {/* "Paste as" menu after a bare URL paste */}
      {editor && pasteState && editable && !commentOnly && !suggesting && (
        <PasteUrlMenu editor={editor} state={pasteState} unfurl={unfurl ? (url) => unfurlRef.current!(url) : undefined} onClose={() => setPasteState(null)} />
      )}

      {editor && dbInsert && editable && !commentOnly && !suggesting && (
        <InsertDatabaseDialog editor={editor} request={dbInsert} hostPath={hostPathRef.current} onClose={() => setDbInsert(null)} />
      )}

      {/* In-note find / replace (works on the live shared document: one transaction per replace) */}
      {editor && find && (
        <div ref={findRef}><EditorFindBar editor={editor} replaceOpen={find.replace} onClose={() => { setFind(null); editor.commands.focus(); }} /></div>
      )}
      {/* `@` mention menu: people, pages, dates, reminders */}
      {editor && mention?.active && <MentionMenu editor={editor} state={mention} notes={wikilinkNotes || []} />}

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
            ref={draftRef}
            autoFocus
            aria-label="Comment"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onSelect={draftMentions.onSelect}
            onInput={draftMentions.onInput}
            {...draftMentions.fieldProps}
            onKeyDown={(e) => {
              if (draftMentions.onKeyDown(e)) return;
              if (e.key === "Escape") setComposer(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment();
            }}
            placeholder="Add a comment… @ to mention  (⌘↵ to post)"
            rows={3}
            style={{
              width: "100%",
              resize: "vertical",
              background: "var(--glass, rgba(255,255,255,0.04))",
              border: "1px solid var(--glass-border)",
              borderRadius: 8,
              outline: "none",
              color: "var(--text-primary)",
              // 16px so iOS doesn't zoom the viewport when composing a comment
              fontSize: 16,
              padding: "8px 10px",
              boxSizing: "border-box",
            }}
          />
          {draftMentions.menu}
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

  /** Open the command composer at the current selection (captured inside it, synchronously). */
  function openHuman(kind: ComposerKind, empty = false) {
    if (!editor) return;
    const sel = editor.state.selection;
    let top = 120, left = 16;
    try {
      const c = editor.view.coordsAtPos(empty ? 1 : sel.to);
      top = c.bottom + 8;
      left = Math.max(8, Math.min(c.left, window.innerWidth - 348));
    } catch { /* keep defaults */ }
    setHumanNotice("");
    setHuman({ kind, empty, top, left });
  }

  function submitComment() {
    if (!editor || !composer || !draft.trim()) return;
    commentOnRange(editor, ydoc, user, draft.trim(), composer.from, composer.to);
    // Collapse the selection so the on-selection "Comment" bubble dismisses.
    editor.chain().setTextSelection(composer.to).run();
    setComposer(null);
    setDraft("");
  }
}
