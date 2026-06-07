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
  Link as LinkIcon,
  PencilLine,
  Check,
  X,
} from "lucide-react";

/**
 * Slim formatting toolbar for the collaborative editor. Only exposes commands
 * present in the shared collab schema (collabExtensions) — no table/image/undo,
 * which aren't registered there (calling them would throw). Undo/redo is handled
 * by Yjs, not a toolbar button.
 */
export function CollabToolbar({
  editor,
  suggesting = false,
  onSetSuggesting,
  canReview = false,
}: {
  editor: Editor;
  suggesting?: boolean;
  onSetSuggesting?: (on: boolean) => void;
  canReview?: boolean;
}) {
  const Btn = ({
    on,
    active,
    children,
    label,
  }: {
    on: () => void;
    active?: boolean;
    children: React.ReactNode;
    label: string;
  }) => (
    <button
      type="button"
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={on}
      className="p-1.5 rounded transition-colors"
      style={{
        color: active ? "var(--color-accent)" : "var(--text-muted)",
        background: active ? "var(--glass-hover)" : "transparent",
      }}
    >
      {children}
    </button>
  );

  const c = () => editor.chain().focus();

  return (
    <div
      className="flex items-center gap-0.5 flex-wrap"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 5,
        padding: "6px 10px",
        marginBottom: 12,
        borderRadius: 10,
        border: "1px solid var(--glass-border)",
        background: "var(--bg-surface, rgba(255,255,255,0.04))",
        backdropFilter: "blur(8px)",
      }}
    >
      <Btn label="Bold" on={() => c().toggleBold().run()} active={editor.isActive("bold")}>
        <Bold size={15} />
      </Btn>
      <Btn label="Italic" on={() => c().toggleItalic().run()} active={editor.isActive("italic")}>
        <Italic size={15} />
      </Btn>
      <Btn label="Strikethrough" on={() => c().toggleStrike().run()} active={editor.isActive("strike")}>
        <Strikethrough size={15} />
      </Btn>
      <Btn label="Code" on={() => c().toggleCode().run()} active={editor.isActive("code")}>
        <Code size={15} />
      </Btn>
      <span style={{ width: 1, height: 18, background: "var(--glass-border)", margin: "0 4px" }} />
      <Btn label="Heading 1" on={() => c().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })}>
        <Heading1 size={15} />
      </Btn>
      <Btn label="Heading 2" on={() => c().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })}>
        <Heading2 size={15} />
      </Btn>
      <Btn label="Heading 3" on={() => c().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })}>
        <Heading3 size={15} />
      </Btn>
      <span style={{ width: 1, height: 18, background: "var(--glass-border)", margin: "0 4px" }} />
      <Btn label="Bullet list" on={() => c().toggleBulletList().run()} active={editor.isActive("bulletList")}>
        <List size={15} />
      </Btn>
      <Btn label="Numbered list" on={() => c().toggleOrderedList().run()} active={editor.isActive("orderedList")}>
        <ListOrdered size={15} />
      </Btn>
      <Btn label="Task list" on={() => c().toggleTaskList().run()} active={editor.isActive("taskList")}>
        <ListChecks size={15} />
      </Btn>
      <Btn label="Quote" on={() => c().toggleBlockquote().run()} active={editor.isActive("blockquote")}>
        <Quote size={15} />
      </Btn>
      <span style={{ width: 1, height: 18, background: "var(--glass-border)", margin: "0 4px" }} />
      <Btn
        label="Link"
        on={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url = window.prompt("Link URL", prev ?? "https://");
          if (url === null) return;
          if (url === "") c().unsetLink().run();
          else c().setLink({ href: url }).run();
        }}
        active={editor.isActive("link")}
      >
        <LinkIcon size={15} />
      </Btn>

      {/* Suggesting mode + review (right side) */}
      {(onSetSuggesting || canReview || suggesting) && (
        <span style={{ width: 1, height: 18, background: "var(--glass-border)", margin: "0 4px" }} />
      )}
      {onSetSuggesting ? (
        <button
          type="button"
          title={suggesting ? "Suggesting — changes are tracked" : "Switch to suggesting"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSetSuggesting(!suggesting)}
          className="px-2 py-1 rounded text-xs flex items-center gap-1"
          style={{
            color: suggesting ? "#fff" : "var(--text-muted)",
            background: suggesting ? "#22c55e" : "transparent",
            border: "1px solid var(--glass-border)",
          }}
        >
          <PencilLine size={13} />
          {suggesting ? "Suggesting" : "Editing"}
        </button>
      ) : suggesting ? (
        <span className="px-2 py-1 rounded text-xs flex items-center gap-1" style={{ color: "#22c55e" }}>
          <PencilLine size={13} /> Suggesting
        </span>
      ) : null}

      {canReview && (
        <>
          <button
            type="button"
            title="Accept all suggestions"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor.chain().focus().acceptAllSuggestions().run()}
            className="p-1.5 rounded"
            style={{ color: "#22c55e" }}
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            title="Reject all suggestions"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor.chain().focus().rejectAllSuggestions().run()}
            className="p-1.5 rounded"
            style={{ color: "#ef4444" }}
          >
            <X size={15} />
          </button>
        </>
      )}
    </div>
  );
}
