import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import {
  Sparkles, Type, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, Code2, Minus,
  ChevronRight, MessageSquareText, Table as TableIcon, Image as ImageIcon, Link2, Columns2, Columns3, ImageUp,
  Paperclip, FileText, Music, Film, Bookmark as BookmarkIcon, PlayCircle, ListTree, FilePlus, Columns4,
} from "lucide-react";
import { canCreateChildPage, createChildPage } from "../../lib/tiptap/childPage";
import { useSelectionAsk } from "../../lib/agent/useSelectionAsk";
import { dismissSlashCommand, type SlashCommandState } from "../../lib/tiptap/SlashCommand";
import { turnTopBlocksInto, type TurnIntoKind } from "../../lib/tiptap/blockCommands";
import { canUploadImages, pickAndUploadImages, canUploadFiles, pickAndUploadFiles } from "../../lib/tiptap/ImageUpload";
import { editorUnfurler, insertLinkBlock } from "../../lib/tiptap/UrlPaste";
import { canInsertDatabase, requestDatabaseInsert } from "../../lib/tiptap/databaseView";
import { describeEditorPopup } from "../../lib/tiptap/popupAria";
import "./editor-blocks.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** "Mod-Alt-1" → "⌘⌥1" on Apple platforms, "Ctrl+Alt+1" elsewhere. */
export function shortcutLabel(spec: string): string {
  const parts = spec.split("-");
  if (isMac) return parts.map((p) => ({ Mod: "⌘", Alt: "⌥", Shift: "⇧" } as Record<string, string>)[p] ?? p.toUpperCase()).join("");
  return parts.map((p) => ({ Mod: "Ctrl" } as Record<string, string>)[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join("+");
}

type Group = "Basic blocks" | "Media" | "Database" | "Advanced" | "Agent";

interface SlashItem {
  id: string;
  group: Group;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  keywords: string[];
  /** A keyboard shortcut (TipTap spec) or a markdown prefix shown as a hint. */
  shortcut?: string;
  markdown?: string;
  agent?: boolean;
  /** Runs after the "/query" text was removed. */
  run: (editor: Editor) => void;
}

/** Re-shape the caret's block when it is a top-level paragraph, else insert after it. */
function shapeBlock(editor: Editor, kind: TurnIntoKind) {
  const { $from } = editor.state.selection;
  if ($from.depth === 1 && $from.parent.type.name === "paragraph") {
    const tr = turnTopBlocksInto(editor.state, $from.pos, $from.pos, kind);
    if (tr) { editor.view.dispatch(tr); editor.commands.focus(); return; }
  }
  const json = kind === "toggle"
    ? { type: "toggle", content: [{ type: "toggleSummary" }, { type: "paragraph" }] }
    : { type: "callout", content: [{ type: "paragraph" }] };
  const at = $from.after(1);
  editor.chain().focus().insertContentAt(at, json).setTextSelection(at + 2).run();
}

/** A toggle whose summary is a heading (NP-ED-08): re-shapes the caret's paragraph, else inserts one after it. */
function insertToggleHeading(editor: Editor, level: 1 | 2 | 3) {
  const { state } = editor;
  const { $from } = state.selection;
  const n = state.schema.nodes;
  if ($from.depth < 1 || !n.toggle) return;
  const start = $from.before(1);
  const block = state.doc.nodeAt(start);
  const reshape = $from.depth === 1 && block?.type.name === "paragraph";
  const toggle = n.toggle.create({ level }, [n.toggleSummary.create(null, reshape ? block!.content : null), n.paragraph.create()]);
  const tr = state.tr;
  const at = reshape ? start : $from.after(1);
  if (reshape) tr.replaceWith(start, start + block!.nodeSize, toggle);
  else tr.insert(at, toggle);
  editor.view.dispatch(tr);
  editor.chain().focus().setTextSelection(Math.min(at + 2 + (reshape ? block!.content.size : 0), editor.state.doc.content.size)).run();
}

function insertColumns(editor: Editor, count: 2 | 3 | 4 | 5) {
  const { $from } = editor.state.selection;
  const empty = $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0;
  const json = { type: "columns", content: Array.from({ length: count }, () => ({ type: "column", content: [{ type: "paragraph" }] })) };
  const from = empty ? $from.before(1) : $from.after(1);
  const to = empty ? $from.after(1) : from;
  // columns(+1) column(+1) paragraph(+1)
  editor.chain().focus().insertContentAt({ from, to }, json).setTextSelection(from + 3).run();
}

function insertImageByUrl(editor: Editor) {
  const url = window.prompt("Image URL");
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && !/^\/(?!\/)/.test(url)) return; // http(s) or same-origin path; never javascript:/data:/protocol-relative
  editor.chain().focus().setImage({ src: url }).run();
}

function promptLinkBlock(editor: Editor, type: "bookmark" | "embed") {
  const url = window.prompt(type === "embed" ? "Link to embed (YouTube, Vimeo, Loom, Figma, Google Docs, Spotify…)" : "Link for the bookmark");
  if (!url) return;
  insertLinkBlock(editor, url, type, editorUnfurler(editor));
}

function insertToc(editor: Editor) {
  const { $from } = editor.state.selection;
  const empty = $from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0;
  const from = empty ? $from.before(1) : $from.after(1);
  editor.chain().focus().insertContentAt({ from, to: empty ? $from.after(1) : from }, { type: "tableOfContents" }).run();
}

const BASE: SlashItem[] = [
  { id: "text", group: "Basic blocks", title: "Text", subtitle: "Plain paragraph", icon: <Type size={16} />, keywords: ["text", "paragraph", "p", "body", "plain"], shortcut: "Mod-Alt-0", run: (e) => e.chain().focus().setParagraph().run() },
  { id: "h1", group: "Basic blocks", title: "Heading 1", subtitle: "Large section heading", icon: <Heading1 size={16} />, keywords: ["h1", "heading", "title", "big"], shortcut: "Mod-Alt-1", markdown: "#", run: (e) => e.chain().focus().setNode("heading", { level: 1 }).run() },
  { id: "h2", group: "Basic blocks", title: "Heading 2", subtitle: "Medium section heading", icon: <Heading2 size={16} />, keywords: ["h2", "heading", "subtitle"], shortcut: "Mod-Alt-2", markdown: "##", run: (e) => e.chain().focus().setNode("heading", { level: 2 }).run() },
  { id: "h3", group: "Basic blocks", title: "Heading 3", subtitle: "Small section heading", icon: <Heading3 size={16} />, keywords: ["h3", "heading"], shortcut: "Mod-Alt-3", markdown: "###", run: (e) => e.chain().focus().setNode("heading", { level: 3 }).run() },
  { id: "bullet", group: "Basic blocks", title: "Bulleted list", subtitle: "A simple bulleted list", icon: <List size={16} />, keywords: ["bullet", "ul", "list", "unordered", "point"], shortcut: "Mod-Shift-8", markdown: "-", run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "numbered", group: "Basic blocks", title: "Numbered list", subtitle: "A list with numbering", icon: <ListOrdered size={16} />, keywords: ["numbered", "ol", "ordered", "list", "1"], shortcut: "Mod-Shift-7", markdown: "1.", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "todo", group: "Basic blocks", title: "To-do list", subtitle: "Track tasks with checkboxes", icon: <ListChecks size={16} />, keywords: ["todo", "task", "checkbox", "check", "list"], shortcut: "Mod-Shift-9", markdown: "[]", run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: "toggle", group: "Basic blocks", title: "Toggle", subtitle: "Hide content inside a toggle", icon: <ChevronRight size={16} />, keywords: ["toggle", "collapse", "details", "expand", "accordion"], markdown: ">>", run: (e) => shapeBlock(e, "toggle") },
  { id: "toggle-h1", group: "Basic blocks", title: "Toggle heading 1", subtitle: "A large heading that hides content", icon: <Heading1 size={16} />, keywords: ["toggle heading", "collapsible heading", "h1"], run: (e) => insertToggleHeading(e, 1) },
  { id: "toggle-h2", group: "Basic blocks", title: "Toggle heading 2", subtitle: "A medium heading that hides content", icon: <Heading2 size={16} />, keywords: ["toggle heading", "collapsible heading", "h2"], run: (e) => insertToggleHeading(e, 2) },
  { id: "toggle-h3", group: "Basic blocks", title: "Toggle heading 3", subtitle: "A small heading that hides content", icon: <Heading3 size={16} />, keywords: ["toggle heading", "collapsible heading", "h3"], run: (e) => insertToggleHeading(e, 3) },
  { id: "quote", group: "Basic blocks", title: "Quote", subtitle: "Capture a quotation", icon: <Quote size={16} />, keywords: ["quote", "blockquote", "cite"], shortcut: "Mod-Shift-B", markdown: ">", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "callout", group: "Basic blocks", title: "Callout", subtitle: "Make writing stand out", icon: <MessageSquareText size={16} />, keywords: ["callout", "note", "info", "tip", "warning", "box"], run: (e) => shapeBlock(e, "callout") },
  { id: "divider", group: "Basic blocks", title: "Divider", subtitle: "Visually divide sections", icon: <Minus size={16} />, keywords: ["divider", "hr", "rule", "separator", "line"], markdown: "---", run: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: "image", group: "Media", title: "Image", subtitle: "Upload or embed with a link", icon: <ImageIcon size={16} />, keywords: ["image", "picture", "photo", "img", "upload"], run: (e) => (canUploadImages(e) ? pickAndUploadImages(e) : insertImageByUrl(e)) },
  { id: "bookmark", group: "Media", title: "Web bookmark", subtitle: "A link preview card", icon: <BookmarkIcon size={16} />, keywords: ["bookmark", "preview", "card", "url", "web"], run: (e) => promptLinkBlock(e, "bookmark") },
  { id: "embed", group: "Media", title: "Embed", subtitle: "YouTube, Vimeo, Loom, Figma, Google Docs…", icon: <PlayCircle size={16} />, keywords: ["embed", "video", "youtube", "vimeo", "loom", "figma", "google", "spotify", "tweet", "iframe"], run: (e) => promptLinkBlock(e, "embed") },
  { id: "toc", group: "Advanced", title: "Table of contents", subtitle: "Jump to a heading on this page", icon: <ListTree size={16} />, keywords: ["toc", "table of contents", "contents", "outline", "headings"], run: insertToc },
  { id: "code", group: "Advanced", title: "Code", subtitle: "Capture a code snippet", icon: <Code2 size={16} />, keywords: ["code", "codeblock", "pre", "snippet"], shortcut: "Mod-Alt-C", markdown: "```", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: "table", group: "Advanced", title: "Table", subtitle: "Rows and columns with a header", icon: <TableIcon size={16} />, keywords: ["table", "grid", "rows", "columns", "spreadsheet"], run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: "link", group: "Advanced", title: "Link to page", subtitle: "Link to another page with [[", icon: <Link2 size={16} />, keywords: ["link", "page", "wikilink", "mention", "reference"], markdown: "[[", run: (e) => e.chain().focus().insertContent("[[").run() },
  { id: "columns2", group: "Advanced", title: "2 columns", subtitle: "Side-by-side blocks", icon: <Columns2 size={16} />, keywords: ["columns", "column", "layout", "side", "2"], run: (e) => insertColumns(e, 2) },
  { id: "columns3", group: "Advanced", title: "3 columns", subtitle: "Three blocks side by side", icon: <Columns3 size={16} />, keywords: ["columns", "column", "layout", "side", "3"], run: (e) => insertColumns(e, 3) },
  { id: "columns4", group: "Advanced", title: "4 columns", subtitle: "Four blocks side by side", icon: <Columns4 size={16} />, keywords: ["columns", "column", "layout", "side", "4"], run: (e) => insertColumns(e, 4) },
  { id: "columns5", group: "Advanced", title: "5 columns", subtitle: "Five blocks side by side", icon: <Columns4 size={16} />, keywords: ["columns", "column", "layout", "side", "5"], run: (e) => insertColumns(e, 5) },
];

const FILE_ITEMS: SlashItem[] = [
  { id: "file", group: "Media", title: "File", subtitle: "Upload any file", icon: <Paperclip size={16} />, keywords: ["file", "upload", "attachment", "attach", "document"], run: (e) => pickAndUploadFiles(e) },
  { id: "pdf", group: "Media", title: "PDF", subtitle: "Upload a PDF to preview inline", icon: <FileText size={16} />, keywords: ["pdf", "document", "file"], run: (e) => pickAndUploadFiles(e, "application/pdf,.pdf") },
  { id: "audio", group: "Media", title: "Audio", subtitle: "Upload a recording or song", icon: <Music size={16} />, keywords: ["audio", "sound", "music", "mp3", "voice", "recording"], run: (e) => pickAndUploadFiles(e, "audio/*") },
  { id: "video", group: "Media", title: "Video", subtitle: "Upload a video to play inline", icon: <Film size={16} />, keywords: ["video", "movie", "mp4", "clip"], run: (e) => pickAndUploadFiles(e, "video/*") },
];

const DATABASE_ITEMS: SlashItem[] = [
  { id: "db-table", group: "Database", title: "Table view", subtitle: "A new database as a table", icon: <TableIcon size={16} />, keywords: ["database", "table view", "inline", "db"], run: (e) => requestDatabaseInsert(e, "new", "table") },
  { id: "db-board", group: "Database", title: "Board view", subtitle: "A new database as a kanban board", icon: <Columns3 size={16} />, keywords: ["database", "board view", "kanban", "inline"], run: (e) => requestDatabaseInsert(e, "new", "board") },
  { id: "db-gallery", group: "Database", title: "Gallery", subtitle: "A new database as cards", icon: <ImageIcon size={16} />, keywords: ["database", "gallery view", "cards", "inline"], run: (e) => requestDatabaseInsert(e, "new", "gallery") },
  { id: "db-list", group: "Database", title: "List", subtitle: "A new database as a list", icon: <List size={16} />, keywords: ["database", "list view", "inline"], run: (e) => requestDatabaseInsert(e, "new", "list") },
  { id: "db-calendar", group: "Database", title: "Calendar", subtitle: "A new database on a calendar", icon: <ListChecks size={16} />, keywords: ["database", "calendar view", "dates", "inline"], run: (e) => requestDatabaseInsert(e, "new", "calendar") },
  // NP-DB-01 "Database – full page": a new database as a sub-page, opened in its own tab.
  { id: "db-page", group: "Database", title: "Full-page database", subtitle: "Database – full page: a new database as a sub-page", icon: <TableIcon size={16} />, keywords: ["database - full page", "full page", "database page", "page database"], run: (e) => requestDatabaseInsert(e, "page", "table") },
  { id: "db-linked", group: "Database", title: "Linked view of database", subtitle: "Show an existing database here", icon: <Link2 size={16} />, keywords: ["linked", "database", "view", "existing", "embed database"], run: (e) => requestDatabaseInsert(e, "linked", "table") },
];

/** A sub-page created in place and shown as a link row (NP-PG-15). */
const PAGE_ITEM: SlashItem = { id: "page", group: "Basic blocks", title: "Page", subtitle: "Add a sub-page inside this page", icon: <FilePlus size={16} />, keywords: ["page", "subpage", "sub-page", "child", "new page"], run: (e) => { void createChildPage(e).catch(() => {}); } };

const IMAGE_URL: SlashItem = { id: "image-url", group: "Media", title: "Image from URL", subtitle: "Embed an image by its address", icon: <ImageUp size={16} />, keywords: ["image", "url", "link", "embed"], run: insertImageByUrl };

/** Fuzzy score: prefix > word prefix > substring > in-order letters. 0 = no match. */
export function slashScore(query: string, item: { title: string; keywords: string[] }): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  let best = 0;
  for (const raw of [item.title, ...item.keywords]) {
    const s = raw.toLowerCase();
    const weight = raw === item.title ? 1 : 0.9;
    if (s === q) best = Math.max(best, 120 * weight);
    else if (s.startsWith(q)) best = Math.max(best, 100 * weight);
    else if (s.split(/[\s-]+/).some((w) => w.startsWith(q))) best = Math.max(best, 80 * weight);
    else if (s.includes(q)) best = Math.max(best, 60 * weight);
    else {
      let i = 0;
      let gaps = 0;
      let last = -1;
      for (let j = 0; j < s.length && i < q.length; j++) {
        if (s[j] === q[i]) { if (last >= 0) gaps += j - last - 1; last = j; i++; }
      }
      if (i === q.length && q.length >= 2) best = Math.max(best, Math.max(5, 40 - gaps * 3) * weight);
    }
  }
  return best;
}

/**
 * Notion-style `/` menu: grouped blocks, fuzzy search, keyboard navigation and
 * shortcut hints. The editor keeps focus (combobox pattern): the editor DOM
 * points at the active option with aria-activedescendant. Shared by the plain
 * and collaborative editors.
 */
export function SlashMenu({ editor, state, onClose }: { editor: Editor | null; state: SlashCommandState; onClose: () => void }) {
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const action = useSelectionAsk(editor);
  const q = state.query;
  const documentText = editor && editor.state.doc.textBetween(0, state.from, "\n") + editor.state.doc.textBetween(state.to, editor.state.doc.content.size, "\n");
  const canAsk = action.canAsk && editor?.isEditable && !!documentText?.trim();
  const uploads = canUploadImages(editor);
  const fileUploads = canUploadFiles(editor);
  const databases = canInsertDatabase(editor);
  const subPages = canCreateChildPage(editor);
  const items = useMemo(() => {
    const all: SlashItem[] = [...BASE];
    if (subPages) all.splice(all.findIndex((i) => i.id === "text") + 1, 0, PAGE_ITEM);
    if (uploads) all.splice(all.findIndex((i) => i.id === "image") + 1, 0, IMAGE_URL);
    if (fileUploads) all.splice(all.findIndex((i) => i.id === (uploads ? "image-url" : "image")) + 1, 0, ...FILE_ITEMS);
    if (databases) all.splice(all.findIndex((i) => i.id === "toc"), 0, ...DATABASE_ITEMS);
    if (canAsk) all.push({ id: "ask", agent: true, group: "Agent", title: "Ask agent", subtitle: "Discuss this page in your conversation", icon: <Sparkles size={16} />, keywords: ["ask", "agent", "ai", "assistant"], shortcut: "Mod-J", run: () => {} });
    if (!q.trim()) return all;
    return all
      .map((it, i) => ({ it, i, score: slashScore(q, it) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((r) => r.it);
  }, [q, canAsk, uploads, fileUploads, databases, subPages]);

  useEffect(() => setSelected(0), [q]);

  const select = (it: SlashItem) => {
    if (!editor) return;
    if (it.agent) { if (action.ask("document", { from: state.from, to: state.to })) onClose(); return; }
    editor.chain().focus().deleteRange({ from: state.from, to: state.to }).run();
    onClose();
    it.run(editor);
  };

  // Keyboard nav in the capture phase so it intercepts before the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const dismiss = () => { if (editor) dismissSlashCommand(editor, state.from); onClose(); };
      if (!items.length) { if (e.key === "Escape") { e.preventDefault(); dismiss(); } return; }
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { stop(); setSelected((i) => (i + 1) % items.length); }
      else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) { stop(); setSelected((i) => (i - 1 + items.length) % items.length); }
      else if (e.key === "Home" && !e.shiftKey) { stop(); setSelected(0); }
      else if (e.key === "End" && !e.shiftKey) { stop(); setSelected(items.length - 1); }
      else if (e.key === "Enter" || e.key === "Tab") { stop(); select(items[Math.min(selected, items.length - 1)]); }
      else if (e.key === "Escape") { stop(); dismiss(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selected, editor, state.from, state.to, action.ask]);

  // Combobox semantics on the editor surface while the menu is open.
  const activeId = items[selected] ? `${listId}-${items[selected].id}` : undefined;
  useEffect(() => {
    let dom: HTMLElement | null = null;
    try { dom = editor?.view.dom ?? null; } catch { dom = null; }
    if (!dom) return;
    return describeEditorPopup(dom, listId, activeId);
  }, [editor, listId, activeId]);

  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, items]);

  if (!editor || items.length === 0) return null;
  let coords: { left: number; top: number; bottom: number };
  try { coords = editor.view.coordsAtPos(state.to); } catch { return null; }
  const width = Math.min(320, window.innerWidth - 16);
  const maxHeight = 360;
  const below = window.innerHeight - coords.bottom - 12;
  const top = below >= Math.min(maxHeight, 220) ? coords.bottom + 6 : Math.max(8, coords.top - 6 - Math.min(maxHeight, coords.top - 14));
  const height = below >= Math.min(maxHeight, 220) ? Math.min(maxHeight, below) : Math.min(maxHeight, coords.top - 14);
  const grouped = !q.trim();
  let lastGroup: Group | null = null;

  return createPortal(
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label="Insert block"
      className="slash-menu editor-menu"
      style={{ position: "fixed", left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)), top, width, maxWidth: width, maxHeight: height, zIndex: 70 }}
      onMouseDown={(e) => e.preventDefault() /* keep the caret in the editor */}
    >
      {items.map((it, i) => {
        const header = grouped && it.group !== lastGroup ? it.group : null;
        lastGroup = it.group;
        const hint = it.shortcut ? shortcutLabel(it.shortcut) : it.markdown;
        return (
          <div key={it.id} role="presentation">
            {header && <div className="editor-menu-section" role="presentation">{header}</div>}
            <div
              id={`${listId}-${it.id}`}
              role="option"
              aria-selected={i === selected}
              aria-label={`${it.title} ${it.subtitle}`}
              className="slash-menu-option editor-menu-item"
              data-active={i === selected || undefined}
              onClick={() => select(it)}
              onMouseMove={() => { if (i !== selected) setSelected(i); }}
            >
              <span className="slash-menu-icon" aria-hidden="true">{it.icon}</span>
              <span className="slash-menu-text">
                <span className="slash-menu-title">{it.title}</span>
                <span className="slash-menu-subtitle">{it.subtitle}</span>
              </span>
              {hint && <kbd className="editor-menu-hint" aria-hidden="true">{hint}</kbd>}
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
