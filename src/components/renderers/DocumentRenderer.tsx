import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { useUIStore } from "../../app/stores/ui";
import { useNotes } from "../../app/hooks/useParachute";
import { inferContentType } from "../../lib/schemas/content-types";
import { InlinePrompt } from "../agent/InlinePrompt";
import { WikilinkExtension } from "../../lib/tiptap/WikilinkMark";
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

  const getContent = useCallback(() => contentRef.current, []);
  const { isSaving, lastSaved, scheduleSave, saveNow } = useAutoSave(note.id, getContent);

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

  // Agent write-back is handled via the PanelChat "Apply to document" button
  // which calls invoke("editor_set_content") — the Rust side emits a Tauri event.
  // For now, the PanelChat appends directly via invoke() and we refresh via query invalidation.

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

  if (initialHtml === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>Loading editor...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      {editor && <EditorToolbar editor={editor} />}

      {/* Editor */}
      <div className="flex-1 overflow-auto px-6 py-8">
        <div className="max-w-3xl mx-auto">
          <EditorContent editor={editor} />
        </div>
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
