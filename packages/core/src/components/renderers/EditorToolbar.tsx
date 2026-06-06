import type { Editor } from "@tiptap/react";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  CodeSquare,
  Minus,
  Link as LinkIcon,
  Image as ImageIcon,
  Table as TableIcon,
  Undo2,
  Redo2,
} from "lucide-react";
import { cn } from "../../lib/cn";

interface EditorToolbarProps {
  editor: Editor;
}

export function EditorToolbar({ editor }: EditorToolbarProps) {
  return (
    <div
      className="flex items-center gap-0.5 px-3 py-1 overflow-x-auto flex-shrink-0"
      style={{
        borderBottom: "1px solid var(--glass-border)",
        background: "var(--bg-surface)",
      }}
    >
      {/* Undo / Redo */}
      <ToolbarButton
        icon={<Undo2 size={15} />}
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        title="Undo"
      />
      <ToolbarButton
        icon={<Redo2 size={15} />}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        title="Redo"
      />

      <Divider />

      {/* Text formatting */}
      <ToolbarButton
        icon={<Bold size={15} />}
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
        title="Bold (&#8984;B)"
      />
      <ToolbarButton
        icon={<Italic size={15} />}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
        title="Italic (&#8984;I)"
      />
      <ToolbarButton
        icon={<Strikethrough size={15} />}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        title="Strikethrough"
      />
      <ToolbarButton
        icon={<Code size={15} />}
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive("code")}
        title="Inline code"
      />

      <Divider />

      {/* Headings */}
      <ToolbarButton
        icon={<Heading1 size={15} />}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
        title="Heading 1"
      />
      <ToolbarButton
        icon={<Heading2 size={15} />}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        title="Heading 2"
      />
      <ToolbarButton
        icon={<Heading3 size={15} />}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })}
        title="Heading 3"
      />

      <Divider />

      {/* Lists */}
      <ToolbarButton
        icon={<List size={15} />}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        title="Bullet list"
      />
      <ToolbarButton
        icon={<ListOrdered size={15} />}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        title="Ordered list"
      />
      <ToolbarButton
        icon={<ListChecks size={15} />}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        active={editor.isActive("taskList")}
        title="Task list"
      />

      <Divider />

      {/* Blocks */}
      <ToolbarButton
        icon={<Quote size={15} />}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
        title="Blockquote"
      />
      <ToolbarButton
        icon={<CodeSquare size={15} />}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive("codeBlock")}
        title="Code block"
      />
      <ToolbarButton
        icon={<Minus size={15} />}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Divider"
      />

      <Divider />

      {/* Link */}
      <ToolbarButton
        icon={<LinkIcon size={15} />}
        onClick={() => {
          const url = window.prompt("URL");
          if (url) {
            editor.chain().focus().setLink({ href: url }).run();
          }
        }}
        active={editor.isActive("link")}
        title="Link"
      />

      {/* Image */}
      <ToolbarButton
        icon={<ImageIcon size={15} />}
        onClick={() => {
          const url = window.prompt("Image URL");
          if (url) {
            editor.chain().focus().setImage({ src: url }).run();
          }
        }}
        title="Image"
      />

      {/* Table */}
      <ToolbarButton
        icon={<TableIcon size={15} />}
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
        title="Insert table"
      />
    </div>
  );
}

function ToolbarButton({
  icon,
  onClick,
  active,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "p-1.5 rounded-md transition-colors",
        "disabled:opacity-30 disabled:pointer-events-none",
        active
          ? "bg-[var(--glass-active)] text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--glass-hover)] hover:text-[var(--text-primary)]",
      )}
    >
      {icon}
    </button>
  );
}

function Divider() {
  return (
    <div
      className="w-px h-5 mx-1"
      style={{ background: "var(--glass-border)" }}
    />
  );
}
