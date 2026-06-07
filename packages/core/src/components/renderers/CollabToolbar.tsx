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
 * Slim formatting toolbar for the collaborative editor. Two groups —
 * formatting (left) and mode/review (right) — so it wraps as coherent units,
 * never a lone button on a second row. Only exposes commands present in the
 * shared collab schema. Per-suggestion accept/reject lives in the inline bubble;
 * the review buttons here are bulk (accept/reject all).
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
  const c = () => editor.chain().focus();

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
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={on}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        borderRadius: 7,
        border: "none",
        cursor: "pointer",
        transition: "background 120ms, color 120ms",
        color: active ? "#fff" : "var(--text-muted)",
        background: active ? "var(--color-accent)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--glass-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );

  const Sep = () => <span style={{ width: 1, height: 18, background: "var(--glass-border)", margin: "0 2px" }} />;

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 5,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 8px",
        marginBottom: 16,
        borderRadius: 12,
        border: "1px solid var(--glass-border)",
        background: "color-mix(in srgb, var(--bg-surface, #1a1a1f) 88%, transparent)",
        backdropFilter: "blur(10px)",
      }}
    >
      {/* Left: formatting */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
        <Btn label="Bold" on={() => c().toggleBold().run()} active={editor.isActive("bold")}><Bold size={16} /></Btn>
        <Btn label="Italic" on={() => c().toggleItalic().run()} active={editor.isActive("italic")}><Italic size={16} /></Btn>
        <Btn label="Strikethrough" on={() => c().toggleStrike().run()} active={editor.isActive("strike")}><Strikethrough size={16} /></Btn>
        <Btn label="Code" on={() => c().toggleCode().run()} active={editor.isActive("code")}><Code size={16} /></Btn>
        <Sep />
        <Btn label="Heading 1" on={() => c().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })}><Heading1 size={16} /></Btn>
        <Btn label="Heading 2" on={() => c().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })}><Heading2 size={16} /></Btn>
        <Btn label="Heading 3" on={() => c().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })}><Heading3 size={16} /></Btn>
        <Sep />
        <Btn label="Bullet list" on={() => c().toggleBulletList().run()} active={editor.isActive("bulletList")}><List size={16} /></Btn>
        <Btn label="Numbered list" on={() => c().toggleOrderedList().run()} active={editor.isActive("orderedList")}><ListOrdered size={16} /></Btn>
        <Btn label="Task list" on={() => c().toggleTaskList().run()} active={editor.isActive("taskList")}><ListChecks size={16} /></Btn>
        <Btn label="Quote" on={() => c().toggleBlockquote().run()} active={editor.isActive("blockquote")}><Quote size={16} /></Btn>
        <Btn
          label="Link"
          active={editor.isActive("link")}
          on={() => {
            const prev = editor.getAttributes("link").href as string | undefined;
            const url = window.prompt("Link URL", prev ?? "https://");
            if (url === null) return;
            if (url === "") c().unsetLink().run();
            else c().setLink({ href: url }).run();
          }}
        >
          <LinkIcon size={16} />
        </Btn>
      </div>

      {/* Right: mode + bulk review */}
      {(onSetSuggesting || canReview || suggesting) && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {onSetSuggesting ? (
            <button
              type="button"
              title={suggesting ? "Suggesting — your changes are tracked" : "Switch to suggesting"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSetSuggesting(!suggesting)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 32,
                padding: "0 10px",
                borderRadius: 7,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                color: suggesting ? "#fff" : "var(--text-secondary)",
                background: suggesting ? "#22c55e" : "transparent",
                border: `1px solid ${suggesting ? "#22c55e" : "var(--glass-border)"}`,
              }}
            >
              <PencilLine size={14} />
              {suggesting ? "Suggesting" : "Editing"}
            </button>
          ) : suggesting ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 600, color: "#22c55e", padding: "0 6px" }}>
              <PencilLine size={14} /> Suggesting
            </span>
          ) : null}

          {canReview && (
            <>
              <Btn label="Accept all suggestions" on={() => c().acceptAllSuggestions().run()}>
                <Check size={16} color="#22c55e" />
              </Btn>
              <Btn label="Reject all suggestions" on={() => c().rejectAllSuggestions().run()}>
                <X size={16} color="#ef4444" />
              </Btn>
            </>
          )}
        </div>
      )}
    </div>
  );
}
