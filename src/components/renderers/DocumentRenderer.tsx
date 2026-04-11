import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useEditor, EditorContent } from "@tiptap/react";
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

const lowlight = createLowlight(common);

const extensions = [
  StarterKit.configure({
    codeBlock: false,
  }),
  Placeholder.configure({
    placeholder: "Start writing, or press / for commands...",
  }),
  Image,
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  TaskList,
  TaskItem.configure({ nested: true }),
  Highlight.configure({ multicolor: true }),
  Link.configure({ openOnClick: false, autolink: true }),
  CodeBlockLowlight.configure({ lowlight }),
  Typography,
];

export default function DocumentRenderer({ note }: RendererProps) {
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

  // Listen for agent-triggered content updates
  useEffect(() => {
    const unlisten = listen<{ noteId: string; content: string; mode: string }>(
      "editor:set-content",
      async (event) => {
        if (event.payload.noteId !== note.id || !editor) return;
        const { content, mode } = event.payload;

        if (mode === "append") {
          editor.commands.focus("end");
          editor.commands.insertContent(content);
        } else if (mode === "insert_at_cursor") {
          editor.commands.insertContent(content);
        } else {
          // "replace" — set entire content
          const html = await convertApi.markdownToHtml(content);
          editor.commands.setContent(html);
        }
        // Trigger auto-save
        contentRef.current = editor.getHTML();
        scheduleSave();
      },
    );

    const unlistenReplace = listen<{ noteId: string; replacement: string }>(
      "editor:replace-selection",
      (event) => {
        if (event.payload.noteId !== note.id || !editor) return;
        // Replace current selection (or insert at cursor if nothing selected)
        editor.commands.insertContent(event.payload.replacement);
        contentRef.current = editor.getHTML();
        scheduleSave();
      },
    );

    return () => {
      unlisten.then((fn) => fn());
      unlistenReplace.then((fn) => fn());
    };
  }, [note.id, editor, scheduleSave]);

  // Handle Cmd+S for immediate save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveNow();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveNow]);

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
    </div>
  );
}
