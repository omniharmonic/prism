import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  AtSign, Bold, CheckSquare, ChevronDown, Code, Image as ImageIcon, IndentDecrease, IndentIncrease, Italic,
  Link as LinkIcon, Plus, Redo2, Repeat2, Strikethrough, Underline, Undo2, X,
} from "lucide-react";
import { canUploadImages, pickAndUploadImages } from "../../lib/tiptap/ImageUpload";
import { blockSelectionActive } from "../../lib/tiptap/EditorKeys";
import "./FormattingBar.css";

/** True on touch-first devices (the iOS app, phones, tablets without a pointer). */
export function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const update = () => setCoarse(mql.matches);
    mql.addEventListener?.("change", update);
    return () => mql.removeEventListener?.("change", update);
  }, []);
  return coarse;
}

/** Distance from the layout viewport's bottom to the visual viewport's bottom (= keyboard height). */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) { setInset(0); return; }
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - (vv.offsetTop + vv.height))));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, [active]);
  return inset;
}

/** The page's selection is a range inside this editor. */
function selectionInside(editor: Editor): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return false;
  try { return editor.view.dom.contains(selection.anchorNode); } catch { return false; }
}

const TURN_INTO: Array<[string, (e: Editor) => boolean]> = [
  ["Text", (e) => e.chain().focus().setParagraph().run()],
  ["Heading 1", (e) => e.chain().focus().toggleHeading({ level: 1 }).run()],
  ["Heading 2", (e) => e.chain().focus().toggleHeading({ level: 2 }).run()],
  ["Heading 3", (e) => e.chain().focus().toggleHeading({ level: 3 }).run()],
  ["Bulleted list", (e) => e.chain().focus().toggleBulletList().run()],
  ["Numbered list", (e) => e.chain().focus().toggleOrderedList().run()],
  ["To-do list", (e) => e.chain().focus().toggleTaskList().run()],
  ["Quote", (e) => e.chain().focus().toggleBlockquote().run()],
  ["Code", (e) => e.chain().focus().toggleCodeBlock().run()],
];

/**
 * With a software keyboard up (inset > 120 px, the same rule the phone bottom
 * bar uses to hide itself) the toolbar sits on the keyboard; otherwise (an
 * external keyboard) it sits just above the bottom bar.
 *
 * NP-MB-04: the phone editing toolbar that rides above the on-screen keyboard
 * (pinned to `visualViewport`, so it works in Safari and the iOS app), with
 * insert, Turn into, B/I/U/S, code, link, to-do, indent/outdent, @ mention, image,
 * undo/redo and dismiss keyboard. It scrolls the caret clear of itself and only
 * exists while an editable editor has focus on a touch device.
 *
 * It is the ONE Prism formatting surface on a touch device. The system's own selection
 * callout (Copy / Look Up / …) sits above a selection there, so the selection bubble is not
 * mounted on a coarse pointer (`useCoarsePointer`); its actions are `selection`, shown at the
 * start of this row while text is selected. A page that cannot be edited (a reader, a
 * suggest-only person) and a page in suggesting mode (`formatting={false}`) get the row only
 * while text is selected: Comment / Suggest edit / Ask agent, docked at the bottom.
 */
export function KeyboardToolbar({ editor, force = false, selection, formatting = true }: {
  editor: Editor; force?: boolean;
  /** The selection's actions (`<SelectionActions>`): rendered only while text is selected. */
  selection?: React.ReactNode;
  /** False = no editing commands, only `selection` (suggesting mode: untracked edits are not offered). */
  formatting?: boolean;
}) {
  const coarse = useCoarsePointer();
  const [focused, setFocused] = useState(() => editor.isFocused);
  const [panel, setPanel] = useState<null | "turn" | "link">(null);
  const [href, setHref] = useState("");
  const bar = useRef<HTMLDivElement>(null);
  const keepFocus = useRef(false);
  const pressing = useRef(false);
  const commands = formatting && editor.isEditable;
  // A page that cannot be edited keeps its last editor selection when the reader selects something
  // else on the screen (the title): there the page's own selection must still be the document's.
  const selected = !!selection && !editor.state.selection.empty && !blockSelectionActive(editor.state) && (editor.isEditable || selectionInside(editor));
  // A reader has no caret to follow: the row exists while text is selected, wherever focus is.
  const visible = (coarse || force) && (commands ? focused || panel !== null : selected);
  const inset = useKeyboardInset(visible);
  const [, rerender] = useState(0);

  useEffect(() => {
    const onFocus = () => setFocused(true);
    // Focus that moves INTO the row (the selection's link field, an open menu) keeps the row.
    const onBlur = ({ event }: { event?: FocusEvent }) => {
      if (keepFocus.current || (event?.relatedTarget instanceof Node && bar.current?.contains(event.relatedTarget))) return;
      setFocused(false); setPanel(null);
    };
    const onChange = () => rerender((n) => n + 1);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    editor.on("selectionUpdate", onChange);
    editor.on("transaction", onChange);
    document.addEventListener("selectionchange", onChange);
    return () => { document.removeEventListener("selectionchange", onChange); editor.off("focus", onFocus); editor.off("blur", onBlur); editor.off("selectionUpdate", onChange); editor.off("transaction", onChange); };
  }, [editor]);

  // Never cover the caret: scroll the editor's scroller by the overlap.
  useEffect(() => {
    if (!visible) return;
    const reveal = () => {
      const top = bar.current?.getBoundingClientRect().top;
      if (top === undefined) return;
      let caret: { bottom: number };
      try { caret = editor.view.coordsAtPos(editor.state.selection.head); } catch { return; }
      let node: HTMLElement | null = editor.view.dom.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) break;
        node = node.parentElement;
      }
      const scroller = node && node !== document.body ? node : null;
      // Visible bottom = above the toolbar AND inside the scroller (a footer may end it sooner).
      const limit = Math.min(top, scroller ? scroller.getBoundingClientRect().bottom : top);
      const overlap = caret.bottom + 12 - limit;
      if (overlap <= 0) return;
      if (scroller) scroller.scrollTop += overlap;
      else window.scrollBy(0, overlap);
    };
    // Room to scroll a short page's caret above the toolbar + keyboard.
    const root = document.documentElement;
    const height = bar.current?.getBoundingClientRect().height ?? 52;
    root.style.setProperty("--keyboard-toolbar-space", `${Math.round(height + (inset > 120 ? inset : 0))}px`);
    const frame = requestAnimationFrame(reveal);
    editor.on("selectionUpdate", reveal);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("selectionUpdate", reveal);
      root.style.removeProperty("--keyboard-toolbar-space");
    };
  }, [visible, inset, editor]);

  if (!visible) return null;
  const run = (fn: () => void) => () => { fn(); };
  const hold = (e: React.PointerEvent | React.MouseEvent) => { e.preventDefault(); };
  const btn = (label: string, icon: React.ReactNode, onClick: () => void, opts: { active?: boolean; disabled?: boolean } = {}) => (
    <button type="button" aria-label={label} title={label} aria-pressed={opts.active ?? undefined} disabled={opts.disabled}
      className="keyboard-toolbar-button focus-ring" onMouseDown={hold} onClick={run(onClick)}>{icon}</button>
  );
  const chain = () => editor.chain().focus();
  // Focus that leaves the row for anything but the editor ends it (the editor's own focus event brings
  // it back). Decided AFTER the tap that caused it: WebKit blurs the selection's link field with no
  // `relatedTarget` when its Apply button is tapped, and the row must still be there for the click.
  const onRowBlur = () => {
    const settle = () => {
      if (pressing.current) { window.setTimeout(settle, 100); return; }
      if (keepFocus.current || bar.current?.contains(document.activeElement) || editor.isDestroyed || editor.isFocused) return;
      setFocused(false);
    };
    window.setTimeout(settle, 0);
  };
  const press = (down: boolean) => () => { if (down) pressing.current = true; else window.setTimeout(() => { pressing.current = false; }, 300); };
  const dismiss = btn("Dismiss keyboard", <ChevronDown size={20} />, () => { editor.commands.blur(); (document.activeElement as HTMLElement | null)?.blur?.(); setFocused(false); });
  const inList = editor.isActive("listItem") || editor.isActive("taskItem");
  const listType = editor.isActive("taskItem") ? "taskItem" : "listItem";
  const applyLink = () => {
    const url = href.trim();
    keepFocus.current = false;
    if (url) chain().extendMarkRange("link").setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` }).run();
    else chain().extendMarkRange("link").unsetLink().run();
    setPanel(null);
  };

  return (
    <div ref={bar} className="keyboard-toolbar" role="toolbar" aria-label={commands ? "Editing toolbar" : "Selection actions"} data-selection={selected || undefined} onBlur={onRowBlur}
      onPointerDown={press(true)} onPointerUp={press(false)} onPointerCancel={press(false)} style={{ bottom: inset > 120 ? inset : "var(--workspace-bottom-inset, 0px)" }} data-keyboard-inset={inset}>
      {panel === "turn" ? (
        <div className="keyboard-toolbar-row" role="group" aria-label="Turn into">
          {TURN_INTO.map(([label, apply]) => (
            <button key={label} type="button" className="keyboard-toolbar-chip focus-ring" onMouseDown={hold} onClick={() => { apply(editor); setPanel(null); }}>{label}</button>
          ))}
          {btn("Close Turn into", <X size={18} />, () => setPanel(null))}
        </div>
      ) : panel === "link" ? (
        <form className="keyboard-toolbar-row" onSubmit={(e) => { e.preventDefault(); applyLink(); }}>
          <input aria-label="Link address" className="keyboard-toolbar-input" inputMode="url" autoFocus placeholder="Paste or type a link"
            value={href} onChange={(e) => setHref(e.target.value)}
            onBlur={() => { keepFocus.current = false; }} />
          <button type="submit" className="keyboard-toolbar-chip focus-ring" onMouseDown={hold}>Apply</button>
          {btn("Cancel link", <X size={18} />, () => { keepFocus.current = false; setPanel(null); editor.commands.focus(); })}
        </form>
      ) : selected ? (
        // Text is selected: the selection's own actions lead (they were the floating bubble), then
        // what the bubble never had. Insert block waits for a caret.
        <div className="keyboard-toolbar-row keyboard-toolbar-selection no-scrollbar">
          {selection}
          {commands && <>
            <span className="selection-divider" aria-hidden="true" />
            {btn("To-do", <CheckSquare size={18} />, () => chain().toggleTaskList().run(), { active: editor.isActive("taskList") })}
            {btn("Indent", <IndentIncrease size={18} />, () => chain().sinkListItem(listType).run(), { disabled: !inList })}
            {btn("Outdent", <IndentDecrease size={18} />, () => chain().liftListItem(listType).run(), { disabled: !inList })}
            {btn("Undo", <Undo2 size={18} />, () => chain().undo().run(), { disabled: !editor.can().undo() })}
            {btn("Redo", <Redo2 size={18} />, () => chain().redo().run(), { disabled: !editor.can().redo() })}
            {dismiss}
          </>}
        </div>
      ) : (
        <div className="keyboard-toolbar-row no-scrollbar">
          {btn("Insert block", <Plus size={19} />, () => {
            // A new block, then the same "/" menu a keyboard user would type.
            const { $from } = editor.state.selection;
            if ($from.parent.textContent.trim()) chain().enter().insertContent("/").run();
            else chain().insertContent("/").run();
          })}
          <button type="button" className="keyboard-toolbar-chip focus-ring" aria-label="Turn into" onMouseDown={hold} onClick={() => setPanel("turn")}><Repeat2 size={16} aria-hidden /> Turn into <ChevronDown size={13} aria-hidden /></button>
          {btn("Bold", <Bold size={18} />, () => chain().toggleBold().run(), { active: editor.isActive("bold") })}
          {btn("Italic", <Italic size={18} />, () => chain().toggleItalic().run(), { active: editor.isActive("italic") })}
          {btn("Underline", <Underline size={18} />, () => chain().toggleUnderline().run(), { active: editor.isActive("underline") })}
          {btn("Strikethrough", <Strikethrough size={18} />, () => chain().toggleStrike().run(), { active: editor.isActive("strike") })}
          {btn("Code", <Code size={18} />, () => chain().toggleCode().run(), { active: editor.isActive("code") })}
          {btn("Link", <LinkIcon size={18} />, () => { keepFocus.current = true; setHref((editor.getAttributes("link").href as string) ?? ""); setPanel("link"); }, { active: editor.isActive("link") })}
          {btn("To-do", <CheckSquare size={18} />, () => chain().toggleTaskList().run(), { active: editor.isActive("taskList") })}
          {btn("Indent", <IndentIncrease size={18} />, () => chain().sinkListItem(listType).run(), { disabled: !inList })}
          {btn("Outdent", <IndentDecrease size={18} />, () => chain().liftListItem(listType).run(), { disabled: !inList })}
          {btn("Mention", <AtSign size={18} />, () => chain().insertContent("@").run())}
          {btn("Image", <ImageIcon size={18} />, () => pickAndUploadImages(editor), { disabled: !canUploadImages(editor) })}
          {btn("Undo", <Undo2 size={18} />, () => chain().undo().run(), { disabled: !editor.can().undo() })}
          {btn("Redo", <Redo2 size={18} />, () => chain().redo().run(), { disabled: !editor.can().redo() })}
          {dismiss}
        </div>
      )}
    </div>
  );
}
