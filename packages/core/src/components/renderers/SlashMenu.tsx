import { useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Type, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, Code2, Minus } from "lucide-react";
import type { SlashCommandState } from "../../lib/tiptap/SlashCommand";

interface SlashItem {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  keywords: string[];
  run: (editor: Editor) => void;
}

const ITEMS: SlashItem[] = [
  { title: "Text", subtitle: "Plain paragraph", icon: <Type size={16} />, keywords: ["text", "paragraph", "p", "body"], run: (e) => e.chain().focus().setParagraph().run() },
  { title: "Heading 1", subtitle: "Large section heading", icon: <Heading1 size={16} />, keywords: ["h1", "heading", "title", "big"], run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { title: "Heading 2", subtitle: "Medium heading", icon: <Heading2 size={16} />, keywords: ["h2", "heading", "subtitle"], run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { title: "Heading 3", subtitle: "Small heading", icon: <Heading3 size={16} />, keywords: ["h3", "heading"], run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { title: "Bullet List", subtitle: "Unordered list", icon: <List size={16} />, keywords: ["bullet", "ul", "list", "unordered", "point"], run: (e) => e.chain().focus().toggleBulletList().run() },
  { title: "Numbered List", subtitle: "Ordered list", icon: <ListOrdered size={16} />, keywords: ["numbered", "ol", "ordered", "list", "1"], run: (e) => e.chain().focus().toggleOrderedList().run() },
  { title: "To-do List", subtitle: "Checklist with checkboxes", icon: <ListChecks size={16} />, keywords: ["todo", "task", "checkbox", "check", "list"], run: (e) => e.chain().focus().toggleTaskList().run() },
  { title: "Quote", subtitle: "Capture a quotation", icon: <Quote size={16} />, keywords: ["quote", "blockquote", "cite"], run: (e) => e.chain().focus().toggleBlockquote().run() },
  { title: "Code", subtitle: "Code block", icon: <Code2 size={16} />, keywords: ["code", "codeblock", "pre", "snippet"], run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { title: "Divider", subtitle: "Horizontal rule", icon: <Minus size={16} />, keywords: ["divider", "hr", "rule", "separator", "line"], run: (e) => e.chain().focus().setHorizontalRule().run() },
];

/**
 * Notion/Anytype-style slash-command menu. Rendered when the SlashCommand plugin
 * reports an active `/` trigger; filters block types by query, supports keyboard
 * navigation, and on select removes the `/query` text and applies the block.
 * Shared by the plain and collaborative editors.
 */
export function SlashMenu({
  editor,
  state,
  onClose,
}: {
  editor: Editor | null;
  state: SlashCommandState;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const q = state.query.toLowerCase();
  const items = useMemo(
    () => (q ? ITEMS.filter((it) => it.title.toLowerCase().includes(q) || it.keywords.some((k) => k.includes(q))) : ITEMS),
    [q],
  );

  useEffect(() => setSelected(0), [q]);

  const select = (it: SlashItem) => {
    if (!editor) return;
    editor.chain().focus().deleteRange({ from: state.from, to: state.to }).run();
    it.run(editor);
    onClose();
  };

  // Keyboard nav in the capture phase so it intercepts before the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!items.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setSelected((i) => (i + 1) % items.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setSelected((i) => (i - 1 + items.length) % items.length); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); select(items[selected]); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selected, editor, state.from, state.to]);

  if (!editor || items.length === 0) return null;
  const coords = editor.view.coordsAtPos(state.to);

  return (
    <div
      className="fixed glass-elevated overflow-hidden"
      style={{
        left: Math.min(coords.left, window.innerWidth - 320),
        top: coords.bottom + 6,
        width: 300,
        maxHeight: 332,
        overflowY: "auto",
        borderRadius: "var(--radius-lg)",
        padding: 4,
        zIndex: 70,
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.title}
          onClick={() => select(it)}
          onMouseEnter={() => setSelected(i)}
          className="interactive w-full flex items-center gap-3 text-left"
          style={{ padding: "7px 8px", background: i === selected ? "var(--surface-active)" : "transparent", color: "var(--text-primary)" }}
        >
          <span
            className="flex items-center justify-center flex-shrink-0"
            style={{ width: 30, height: 30, borderRadius: "var(--radius-sm)", background: "var(--surface-hover)", color: "var(--text-secondary)" }}
          >
            {it.icon}
          </span>
          <div className="min-w-0">
            <div className="truncate" style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>{it.title}</div>
            <div className="truncate" style={{ fontSize: 10, color: "var(--text-muted)" }}>{it.subtitle}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
