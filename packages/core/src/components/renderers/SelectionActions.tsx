import { useEffect, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { AtSign, Bold, Italic, Underline, Strikethrough, Code, Sparkles, Link2, ChevronDown, MessageSquarePlus, Unlink, Baseline, PenLine } from "lucide-react";
import { useSelectionAsk, useSelectionAskShortcut } from "../../lib/agent/useSelectionAsk";
import { BLOCK_COLORS, type BlockColorName } from "../../editor/blocks";
import { TURN_INTO, blockKind, canTurnInto, selectionStart, structuralEditsAllowed, topBlockAt, turnTopBlocksInto } from "../../lib/tiptap/blockCommands";
import { EditorMenu, type EditorMenuItem } from "./EditorMenu";
import { TURN_INTO_ICONS, colorLabel, highlightValue } from "./blockUi";
import { EDIT_LINK_EVENT, rememberHighlightColor } from "../../lib/tiptap/EditorKeys";
import "./SelectionActions.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";

/** Only web, mail and in-app links; never javascript:/data:. */
export function normalizeLink(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^\/(?!\/)/.test(value) || value.startsWith("#")) return value; // "/page", never "//host"
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
  return null;
}

/**
 * The selection toolbar (bubble). Notion-like order: Ask agent · Turn into ·
 * B I U S code · link · colour · Mention · Comment. ⌘K (with a text selection)
 * opens the inline link field; ⌘⇧H re-applies the last highlight colour. Formatting is hidden when the user
 * cannot edit; Ask agent and Comment follow their own capabilities.
 */
export function SelectionActions({ editor, allowFormatting, onComment, onSuggest }: { editor: Editor; allowFormatting: boolean; onComment?: () => void; /** Suggest-only people: open the suggestion composer (NP-CO-12). */ onSuggest?: () => void }) {
  const action = useSelectionAsk(editor);
  useSelectionAskShortcut(editor, action.ask, action.hasClient);
  const [menu, setMenu] = useState<null | "turn" | "color">(null);
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState(false);
  // The editor does not re-render React on every transaction (TipTap 3), so
  // subscribe to exactly what the toolbar shows.
  useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { from, to } = e.state.selection;
      return `${from}:${to}:${["bold", "italic", "underline", "strike", "code", "link"].map((m) => (e.isActive(m) ? 1 : 0)).join("")}:${e.getAttributes("textColor").color ?? ""}:${e.getAttributes("highlight").color ?? ""}:${e.isEditable}:${(e.storage as unknown as Record<string, { suggesting?: boolean } | undefined>).suggestionMode?.suggesting ? 1 : 0}`;
    },
  });
  const turnRef = useRef<HTMLButtonElement>(null);
  const colorRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLButtonElement>(null);

  // A new selection resets transient UI.
  useEffect(() => {
    const reset = () => { setMenu(null); setLinking(false); setLinkError(false); };
    editor.on("selectionUpdate", reset);
    return () => { editor.off("selectionUpdate", reset); };
  }, [editor]);

  const { from, to } = editor.state.selection;
  const block = topBlockAt(editor.state.doc, selectionStart(editor.state.doc, from, to));
  const structural = allowFormatting && structuralEditsAllowed(editor);
  // Tracked suggestions record text only: colour, highlight and links would be
  // untracked edits, so they are off while suggesting.
  const suggesting = !!(editor.storage as unknown as Record<string, { suggesting?: boolean } | undefined>).suggestionMode?.suggesting;
  const decorate = allowFormatting && !suggesting;
  const turnable = structural && !!block && canTurnInto(block.node) && (topBlockAt(editor.state.doc, to)?.node ? canTurnInto(topBlockAt(editor.state.doc, to)!.node) : true);
  const currentKind = block ? blockKind(block.node) : null;
  const currentLabel = TURN_INTO.find((t) => t.kind === currentKind)?.label ?? "Turn into";

  const closeMenu = (ref: React.RefObject<HTMLButtonElement | null>) => { setMenu(null); ref.current?.focus({ preventScroll: true }); };

  const turnItems: EditorMenuItem[] = TURN_INTO.map((t) => ({
    id: t.kind, label: t.label, icon: TURN_INTO_ICONS[t.kind], checked: currentKind === t.kind,
    onSelect: () => {
      const tr = turnTopBlocksInto(editor.state, from, to, t.kind);
      if (tr) editor.view.dispatch(tr);
      setMenu(null);
      editor.commands.focus();
    },
  }));

  const activeText = editor.getAttributes("textColor").color as BlockColorName | undefined;
  const activeHighlight = editor.getAttributes("highlight").color as string | undefined;
  const colorItems: EditorMenuItem[] = [
    { id: "text-default", section: "Text color", label: "Default", checked: !activeText, icon: <span className="block-color-swatch">A</span>, onSelect: () => { editor.chain().focus().unsetTextColor().run(); setMenu(null); } },
    ...BLOCK_COLORS.map((c) => ({ id: `text-${c}`, label: colorLabel(c), checked: activeText === c, icon: <span className="block-color-swatch" data-text-color={c}>A</span>, onSelect: () => { editor.chain().focus().setTextColor(c).run(); setMenu(null); } })),
    { id: "bg-default", section: "Highlight", label: "No highlight", checked: !activeHighlight, icon: <span className="block-color-swatch" />, onSelect: () => { editor.chain().focus().unsetHighlight().run(); setMenu(null); } },
    ...BLOCK_COLORS.map((c) => ({ id: `bg-${c}`, label: `${colorLabel(c)} highlight`, checked: activeHighlight === highlightValue(c), icon: <span className="block-color-swatch" data-block-color={`${c}_background`} />, onSelect: () => { rememberHighlightColor(highlightValue(c)); editor.chain().focus().setHighlight({ color: highlightValue(c) }).run(); setMenu(null); } })),
  ];

  const openLink = () => {
    setHref((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinkError(false);
    setLinking(true);
  };
  // ⌘K / Ctrl+K with a text selection (EditorKeys) opens the same inline field.
  const decorateRef = useRef(false);
  decorateRef.current = decorate;
  useEffect(() => {
    let dom: HTMLElement;
    try { dom = editor.view.dom; } catch { return; }
    const onEditLink = () => { if (decorateRef.current) openLink(); };
    dom.addEventListener(EDIT_LINK_EVENT, onEditLink);
    return () => dom.removeEventListener(EDIT_LINK_EVENT, onEditLink);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  /** Mention after the selection: collapses to its end and opens the `@` menu there. */
  const mention = () => {
    const { to: end } = editor.state.selection;
    const before = editor.state.doc.textBetween(Math.max(0, end - 1), end, "\n", "\ufffc");
    const needsSpace = before !== "" && !/[\s([{"'“‘]/.test(before);
    editor.chain().focus().setTextSelection(end).insertContent(needsSpace ? " @" : "@").run();
  };
  const canMention = editor.extensionManager.extensions.some((e) => e.name === "mentionSuggest");
  const applyLink = () => {
    const url = normalizeLink(href);
    if (!url) { setLinkError(true); return; }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    setLinking(false);
  };

  if (linking) {
    return (
      <form className="selection-link-form" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
        <Link2 size={14} aria-hidden="true" />
        <input
          autoFocus
          aria-label="Link address"
          aria-invalid={linkError || undefined}
          placeholder="Paste or type a link…"
          value={href}
          onChange={(event) => { setHref(event.target.value); setLinkError(false); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setLinking(false); linkRef.current?.focus(); editor.commands.focus(); } }}
        />
        <button type="submit" className="selection-link-apply">Apply</button>
        {editor.isActive("link") && (
          <button type="button" aria-label="Remove link" title="Remove link" onMouseDown={(e) => e.preventDefault()}
            onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinking(false); }}>
            <Unlink size={14} aria-hidden="true" />
          </button>
        )}
        {linkError && <span role="alert" className="selection-link-error">Use a web, mail or page link.</span>}
      </form>
    );
  }

  const marks = [
    { label: "Bold selection", name: "bold", icon: <Bold size={14} />, hint: `${mod}B`, run: () => editor.chain().focus().toggleBold().run() },
    { label: "Italic selection", name: "italic", icon: <Italic size={14} />, hint: `${mod}I`, run: () => editor.chain().focus().toggleItalic().run() },
    { label: "Underline selection", name: "underline", icon: <Underline size={14} />, hint: `${mod}U`, run: () => editor.chain().focus().toggleUnderline().run() },
    { label: "Strikethrough selection", name: "strike", icon: <Strikethrough size={14} />, hint: `${mod}${isMac ? "⇧" : "Shift+"}S`, run: () => editor.chain().focus().toggleStrike().run() },
    { label: "Code selection", name: "code", icon: <Code size={14} />, hint: `${mod}E`, run: () => editor.chain().focus().toggleCode().run() },
  ];

  return <>
    {action.available && <button type="button" className="selection-ask" aria-label="Ask agent about selection" title={action.canAsk ? `Ask agent about selection (${mod}J)` : action.reason}
      disabled={!action.canAsk || !action.selected} onMouseDown={event => event.preventDefault()} onClick={() => action.ask()}>
      <Sparkles size={14} aria-hidden="true" /> Ask agent
    </button>}
    {action.available && (allowFormatting || onComment || onSuggest) && <span className="selection-divider" aria-hidden="true" />}
    {turnable && <span className="selection-dropdown">
      <button ref={turnRef} type="button" data-editor-menu-anchor aria-label={`Turn into (now ${currentLabel})`} aria-haspopup="menu" aria-expanded={menu === "turn"}
        title="Turn into" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === "turn" ? null : "turn")}>
        {currentLabel} <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menu === "turn" && <EditorMenu label="Turn into" items={turnItems} onClose={() => closeMenu(turnRef)} className="selection-menu" />}
    </span>}
    {turnable && <span className="selection-divider" aria-hidden="true" />}
    {allowFormatting && marks.map(item => <button key={item.name} type="button" aria-label={item.label} aria-pressed={editor.isActive(item.name)} title={`${item.label.replace(" selection", "")} (${item.hint})`}
      onMouseDown={event => event.preventDefault()} onClick={item.run}>{item.icon}</button>)}
    {decorate && <button ref={linkRef} type="button" aria-label="Link" aria-pressed={editor.isActive("link")} title={`Link (${mod}K)`}
      onMouseDown={(e) => e.preventDefault()} onClick={openLink}><Link2 size={14} aria-hidden="true" /></button>}
    {decorate && <span className="selection-dropdown">
      <button ref={colorRef} type="button" data-editor-menu-anchor aria-label="Text color and highlight" aria-haspopup="menu" aria-expanded={menu === "color"} title="Color"
        onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === "color" ? null : "color")}>
        <Baseline size={14} aria-hidden="true" /><ChevronDown size={12} aria-hidden="true" />
      </button>
      {menu === "color" && <EditorMenu label="Color" items={colorItems} onClose={() => closeMenu(colorRef)} className="selection-menu" style={{ maxHeight: 320 }} />}
    </span>}
    {decorate && canMention && <button type="button" aria-label="Mention a person, page or date" title="Mention (@)"
      onMouseDown={(e) => e.preventDefault()} onClick={mention}><AtSign size={14} aria-hidden="true" /></button>}
    {onSuggest && <button type="button" aria-label="Suggest an edit to the selection" title="Suggest edit" onMouseDown={(e) => e.preventDefault()} onClick={onSuggest}>
      <PenLine size={14} aria-hidden="true" /> Suggest edit
    </button>}
    {onComment && <>
      {allowFormatting && <span className="selection-divider" aria-hidden="true" />}
      <button type="button" aria-label="Comment on selection" title="Comment" onMouseDown={(e) => e.preventDefault()} onClick={onComment}>
        <MessageSquarePlus size={14} aria-hidden="true" /> Comment
      </button>
    </>}
  </>;
}
