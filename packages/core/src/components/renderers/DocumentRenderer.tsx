import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { useUIStore } from "../../app/stores/ui";
import { useNotes } from "../../app/hooks/useParachute";
import { inferContentType } from "../../lib/schemas/content-types";
import type { Note } from "../../lib/types";
import { InlinePrompt } from "../agent/InlinePrompt";
import { WikilinkExtension } from "../../lib/tiptap/WikilinkMark";
import { WikilinkAutocomplete, type WikilinkAutocompleteState } from "../../lib/tiptap/WikilinkAutocomplete";
import { SearchHighlight } from "../../lib/tiptap/SearchHighlight";
import { EditorFindBar } from "./EditorFindBar";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Typography from "@tiptap/extension-typography";
import { common, createLowlight } from "lowlight";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { convertApi } from "../../lib/parachute/client";
import { EditorToolbar } from "./EditorToolbar";

const lowlightInstance = createLowlight(common);

export default function DocumentRenderer({ note }: RendererProps) {
  const openTab = useUIStore((s) => s.openTab);
  const { data: allNotes } = useNotes();
  const [autocompleteState, setAutocompleteState] = useState<WikilinkAutocompleteState | null>(null);

  // Wikilink navigation: resolve target name → note ID → open tab
  const handleWikilinkNavigate = useCallback((target: string) => {
    if (!allNotes) return;
    const matched = allNotes.find((n) => {
      const path = n.path || "";
      const name = path.split("/").pop() || "";
      const stripped = path.startsWith("vault/") ? path.slice(6) : path;
      return name.toLowerCase() === target.toLowerCase()
        || path === target
        || stripped === target
        || stripped.split("/").pop()?.toLowerCase() === target.toLowerCase();
    });
    if (matched) {
      const type = inferContentType(matched);
      openTab(matched.id, matched.path?.split("/").pop() || matched.id, type);
    }
  }, [allNotes, openTab]);

  const extensions = useMemo(() => [
    StarterKit.configure({ codeBlock: false }),
    Placeholder.configure({ placeholder: "Start writing, or press / for commands..." }),
    Image,
    Table.configure({ resizable: true }),
    TableRow, TableCell, TableHeader,
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight.configure({ multicolor: true }),
    Link.configure({ openOnClick: false, autolink: true }),
    CodeBlockLowlight.configure({ lowlight: lowlightInstance }),
    Typography,
    WikilinkExtension.configure({ onNavigate: handleWikilinkNavigate }),
    WikilinkAutocomplete.configure({ onStateChange: setAutocompleteState }),
    SearchHighlight,
  ], [handleWikilinkNavigate]);
  const [initialHtml, setInitialHtml] = useState<string | null>(null);
  const contentRef = useRef<string>(note.content);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  // Convert markdown → HTML on load
  useEffect(() => {
    let cancelled = false;
    async function convert() {
      if (!note.content || note.content.trim() === "") {
        setInitialHtml("");
        return;
      }
      // If content looks like HTML already, use directly
      if (note.content.trim().startsWith("<")) {
        setInitialHtml(note.content);
        return;
      }
      const html = await convertApi.markdownToHtml(note.content);
      if (!cancelled) setInitialHtml(html);
    }
    convert();
    return () => { cancelled = true; };
  }, [note.id]); // Only re-convert when opening a different note

  // Track what the user has saved so we can distinguish user saves from agent edits.
  // When note.content changes on the server, if it matches what we last saved,
  // it's our own save round-tripping — not an agent edit.
  const lastKnownContent = useRef(note.content);
  const lastUserSavedContent = useRef<string | null>(null);

  useEffect(() => {
    if (note.content === lastKnownContent.current) return;
    if (!editorRef.current) return;

    // If this server update matches what the user just saved, it's not an agent edit
    if (lastUserSavedContent.current !== null && note.content === lastUserSavedContent.current) {
      lastKnownContent.current = note.content;
      return;
    }

    // External source (agent MCP) changed the note — show as ghost text for review
    const { setGhostText } = useUIStore.getState();
    setGhostText({
      noteId: note.id,
      content: note.content,
      position: "end",
    });
    lastKnownContent.current = note.content;
  }, [note.content, note.id]);

  const getContent = useCallback(() => contentRef.current, []);
  const onSaved = useCallback((content: string) => {
    lastUserSavedContent.current = content;
  }, []);
  const { isSaving, lastSaved, scheduleSave, saveNow } = useAutoSave(note.id, getContent, 2000, onSaved);

  const editor = useEditor({
    extensions,
    content: initialHtml || "",
    editorProps: {
      attributes: {
        class: "prose-editor outline-none min-h-[200px]",
      },
    },
    onUpdate: ({ editor }) => {
      contentRef.current = editor.getHTML();
      scheduleSave();
    },
  }, [initialHtml]); // Re-create editor when initialHtml changes

  editorRef.current = editor;

  // Agent write-back: watch for pending edits from PanelChat via Zustand store
  const pendingEdit = useUIStore((s) => s.pendingEdit);
  const clearPendingEdit = useUIStore((s) => s.clearPendingEdit);

  useEffect(() => {
    if (!pendingEdit || pendingEdit.noteId !== note.id || !editorRef.current) return;

    const applyEdit = async () => {
      const ed = editorRef.current;
      if (!ed) return;

      let html: string;
      // Convert markdown content to HTML for TipTap
      if (pendingEdit.content.trim().startsWith("<")) {
        html = pendingEdit.content;
      } else {
        html = await convertApi.markdownToHtml(pendingEdit.content);
      }

      if (pendingEdit.mode === "replace") {
        ed.commands.setContent(html);
      } else {
        // Append: move cursor to end, insert a separator, then the new content
        ed.commands.focus("end");
        ed.commands.insertContent("<hr>");
        ed.commands.insertContent(html);
      }

      // Update contentRef and trigger save
      contentRef.current = ed.getHTML();
      scheduleSave();
      clearPendingEdit();
    };

    applyEdit();
  }, [pendingEdit, note.id, clearPendingEdit, scheduleSave]);

  // In-note find bar state
  const [findOpen, setFindOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Inline prompt state
  const { inlinePromptOpen, inlinePromptPosition, inlinePromptSelection, openInlinePrompt, closeInlinePrompt } = useUIStore();

  // Handle Cmd+S and Cmd+J
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveNow();
      }
      // ⌘J — inline agent prompt
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        if (!editor) return;
        const { from, to } = editor.state.selection;
        const selectedText = editor.state.doc.textBetween(from, to, " ");
        if (!selectedText.trim()) return; // Need selected text

        // Get selection coordinates for positioning
        const view = editor.view;
        const coords = view.coordsAtPos(from);
        openInlinePrompt(
          { x: coords.left, y: coords.top },
          selectedText,
        );
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveNow, editor, openInlinePrompt]);

  // Cmd+F / Ctrl+F — scoped to the editor container. Only fires when focus is
  // inside this DocumentRenderer's subtree (or when document.activeElement is
  // inside it), so it won't hijack Cmd+F on dashboard/graph/agent views.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      // Only activate if focus (or the event target) is inside this container.
      const active = document.activeElement;
      const target = e.target as Node | null;
      const insideContainer =
        (active && container.contains(active)) ||
        (target && container.contains(target));
      if (!insideContainer) return;
      e.preventDefault();
      setFindOpen(true);
    };

    // Listen on the container itself so the event only bubbles from within.
    container.addEventListener("keydown", handler);
    return () => container.removeEventListener("keydown", handler);
    // Re-run when initialHtml flips from null → string: on first mount the
    // component renders a loading placeholder and containerRef is null, so
    // the listener must re-attach once the real container mounts.
  }, [initialHtml]);

  if (initialHtml === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>Loading editor...</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* Toolbar */}
      {editor && <EditorToolbar editor={editor} />}

      {/* Editor */}
      <div className="flex-1 overflow-auto px-6 py-8 relative">
        <div className="max-w-3xl mx-auto">
          <EditorContent editor={editor} />
        </div>
        {/* Wikilink / @mention autocomplete dropdown */}
        {editor && autocompleteState?.active && (
          <WikilinkDropdown editor={editor} notes={allNotes || []} autocomplete={autocompleteState} />
        )}
        {/* In-note find bar (Cmd+F / Ctrl+F) */}
        {editor && findOpen && (
          <EditorFindBar editor={editor} onClose={() => setFindOpen(false)} />
        )}
      </div>

      {/* Save status */}
      <div
        className="flex items-center justify-end px-4 py-1 text-xs gap-3"
        style={{ color: "var(--text-muted)", borderTop: "1px solid var(--glass-border)" }}
      >
        {isSaving && <span>Saving...</span>}
        {lastSaved && !isSaving && (
          <span>Saved {lastSaved.toLocaleTimeString()}</span>
        )}
      </div>

      {/* Ghost text: agent-generated content awaiting accept/reject */}
      <GhostTextOverlay noteId={note.id} editor={editor} scheduleSave={scheduleSave} contentRef={contentRef} />

      {/* Inline agent prompt (⌘J) */}
      {inlinePromptOpen && inlinePromptPosition && (
        <InlinePrompt
          noteId={note.id}
          selection={inlinePromptSelection}
          position={inlinePromptPosition}
          onAccept={(replacement) => {
            if (editor) {
              editor.commands.insertContent(replacement);
              contentRef.current = editor.getHTML();
              scheduleSave();
            }
            closeInlinePrompt();
          }}
          onReject={closeInlinePrompt}
        />
      )}
    </div>
  );
}

/**
 * Ghost text overlay: shows agent-generated content in a preview panel
 * at the bottom of the editor with Accept/Reject controls.
 */
function GhostTextOverlay({
  noteId,
  editor,
  scheduleSave,
  contentRef,
}: {
  noteId: string;
  editor: ReturnType<typeof useEditor>;
  scheduleSave: () => void;
  contentRef: React.MutableRefObject<string>;
}) {
  const ghostText = useUIStore((s) => s.ghostText);
  const rejectGhostText = useUIStore((s) => s.rejectGhostText);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  // Convert ghost text content to HTML for preview
  useEffect(() => {
    if (!ghostText || ghostText.noteId !== noteId) {
      setPreviewHtml(null);
      return;
    }
    let cancelled = false;
    async function convert() {
      const content = ghostText!.content;
      if (content.trim().startsWith("<")) {
        if (!cancelled) setPreviewHtml(content);
      } else {
        const html = await convertApi.markdownToHtml(content);
        if (!cancelled) setPreviewHtml(html);
      }
    }
    convert();
    return () => { cancelled = true; };
  }, [ghostText, noteId]);

  if (!ghostText || ghostText.noteId !== noteId || !previewHtml) return null;

  const handleAccept = async () => {
    if (!editor) return;
    // Replace the entire document with the agent's version
    editor.commands.setContent(previewHtml);
    contentRef.current = editor.getHTML();
    scheduleSave();
    rejectGhostText();
  };

  return (
    <div
      className="mx-6 mb-2 rounded-lg overflow-hidden"
      style={{ border: "2px dashed var(--color-accent)", background: "var(--glass)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ background: "rgba(var(--accent-rgb, 99,102,241), 0.1)", borderBottom: "1px solid var(--glass-border)" }}
      >
        <span className="text-xs font-medium" style={{ color: "var(--color-accent)" }}>
          Agent edited this document — review changes
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleAccept}
            className="px-3 py-1 rounded text-xs font-medium"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            Accept
          </button>
          <button
            onClick={rejectGhostText}
            className="px-3 py-1 rounded text-xs"
            style={{ color: "var(--text-secondary)", background: "var(--glass)" }}
          >
            Reject
          </button>
        </div>
      </div>
      {/* Preview content */}
      <div
        className="px-4 py-3 prose-editor max-h-64 overflow-auto"
        style={{ opacity: 0.7, color: "var(--text-secondary)" }}
        dangerouslySetInnerHTML={{ __html: previewHtml }}
      />
    </div>
  );
}

/**
 * Wikilink autocomplete dropdown — appears when typing [[ in the editor.
 * Shows matching notes from the vault, click to insert [[target]] at cursor.
 */
function WikilinkDropdown({ editor, notes, autocomplete }: {
  editor: ReturnType<typeof useEditor>;
  notes: Note[];
  autocomplete: WikilinkAutocompleteState;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (!editor) return null;

  const query = (autocomplete.query || "").toLowerCase();
  const matches = query.length > 0
    ? notes.filter((n) => {
        const name = (n.path || "").split("/").pop() || "";
        return name.toLowerCase().includes(query) || (n.path || "").toLowerCase().includes(query);
      }).slice(0, 8)
    : notes.slice(0, 8);

  if (matches.length === 0) return null;

  // Get cursor position for dropdown placement
  const coords = editor.view.coordsAtPos(autocomplete.to);

  const handleSelect = (note: Note) => {
    const name = (note.path || "").split("/").pop() || note.id;

    // Both @ and [[ insert the same wikilink format — the decoration renders it clean
    editor.chain().focus()
      .deleteRange({ from: autocomplete.from, to: autocomplete.to })
      .insertContent(`[[${note.path || name}|${name}]] `)
      .run();
  };

  return (
    <div
      className="fixed z-50 glass-elevated rounded-lg py-1 overflow-hidden"
      style={{
        left: Math.min(coords.left, window.innerWidth - 300),
        top: coords.bottom + 4,
        width: 280,
        maxHeight: 240,
        overflowY: "auto",
      }}
    >
      {matches.map((note, i) => {
        const name = (note.path || "").split("/").pop() || note.id;
        const type = inferContentType(note);
        return (
          <button
            key={note.id}
            onClick={() => handleSelect(note)}
            onMouseEnter={() => setSelectedIndex(i)}
            className="w-full flex items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors"
            style={{
              background: i === selectedIndex ? "var(--glass-hover)" : "transparent",
              color: "var(--text-primary)",
            }}
          >
            <div className="flex-1 min-w-0">
              <div className="truncate font-medium">{name}</div>
              <div className="truncate" style={{ color: "var(--text-muted)", fontSize: "10px" }}>
                {note.path} · {type}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
