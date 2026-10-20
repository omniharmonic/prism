import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  AtSign, Bold, Check, CheckSquare, ChevronDown, Code, Image as ImageIcon, IndentDecrease, IndentIncrease, Italic, KeyboardOff,
  Link as LinkIcon, Plus, Redo2, Repeat2, Strikethrough, Underline, Undo2, X,
} from "lucide-react";
import { canUploadImages, pickAndUploadImages } from "../../lib/tiptap/ImageUpload";
import { blockSelectionActive } from "../../lib/tiptap/EditorKeys";
import { isTextControl, useSoftKeyboard } from "../../lib/softKeyboard";
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
 * With a software keyboard up (`useSoftKeyboard().open`, the same fact the phone bottom bar hides
 * itself on) the toolbar's bottom edge is the visual viewport's bottom edge — flush on the keyboard,
 * wherever WebKit panned the page; otherwise (an external keyboard) it sits just above the bottom bar.
 *
 * It exists only while the caret is in THIS document: focus in any other text control (the comments
 * drawer's reply field, a property, the title, search, a composer) takes it away.
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
export function KeyboardToolbar({ editor, force = false, selection, formatting = true, review }: {
  editor: Editor; force?: boolean;
  /** Touch: Accept / Reject for the suggestion under the caret lead the row (no floating bubble there). */
  review?: { at: (editor: Editor) => boolean; accept: () => void; reject: () => void };
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
  // Focus is in a text control that is not this document (nor this row's own link field).
  const [elsewhere, setElsewhere] = useState(false);
  let reviewing = false;
  try { reviewing = !!review && review.at(editor); } catch { reviewing = false; }
  // A reader has no caret to follow: the row exists while text is selected. Suggesting mode also
  // gets it while the caret is in a suggestion that can be accepted or rejected.
  const visible = (coarse || force) && !elsewhere && (commands ? focused || panel !== null : selected || (reviewing && focused));
  const keyboard = useSoftKeyboard();
  const inset = keyboard.inset;
  const [, rerender] = useState(0);

  useEffect(() => {
    const onFocus = () => setFocused(true);
    // Focus that moves INTO the row (the selection's link field, an open menu) keeps the row.
    const onBlur = ({ event }: { event?: FocusEvent }) => {
      if (keepFocus.current || (event?.relatedTarget instanceof Node && bar.current?.contains(event.relatedTarget))) return;
      setFocused(false); setPanel(null);
    };
    const onChange = () => rerender((n) => n + 1);
    // The DOM is the truth about where typing goes: whatever the editor's own events said, a text
    // control outside this document that holds the focus ends the row.
    const sync = () => {
      let outside = false;
      try {
        const active = document.activeElement;
        outside = isTextControl(active) && !editor.view.dom.contains(active) && !bar.current?.contains(active);
      } catch { outside = false; }
      setElsewhere(outside);
      if (outside) { keepFocus.current = false; setFocused(false); setPanel(null); }
    };
    const later = () => window.setTimeout(sync, 0);
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    sync();
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    editor.on("selectionUpdate", onChange);
    editor.on("transaction", onChange);
    document.addEventListener("selectionchange", onChange);
    return () => { document.removeEventListener("focusin", later); document.removeEventListener("focusout", later); document.removeEventListener("selectionchange", onChange); editor.off("focus", onFocus); editor.off("blur", onBlur); editor.off("selectionUpdate", onChange); editor.off("transaction", onChange); };
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
    root.style.setProperty("--keyboard-toolbar-space", `${Math.round(height + (keyboard.open ? inset : 0))}px`);
    const frame = requestAnimationFrame(reveal);
    editor.on("selectionUpdate", reveal);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("selectionUpdate", reveal);
      root.style.removeProperty("--keyboard-toolbar-space");
    };
  }, [visible, inset, keyboard.open, editor]);

  // A row that is wider than the screen scrolls sideways. At rest it must not end in half an icon:
  // the gap between its items is stretched (from 2 px) so that a whole number of them fills the row
  // exactly, and the next one starts beyond its edge. Even spacing falls out of the same sum. A row
  // that fits keeps the 2 px gap. `data-more` (there is more to the right) shows a chevron beside
  // the row — beside it, not over it, so nothing is covered.
  useEffect(() => {
    const host = bar.current;
    if (!visible || !host) return;
    const GAP = 2, MAX_GAP = 24;
    const fit = () => {
      let more = false;
      for (const row of Array.from(host.querySelectorAll<HTMLElement>(".keyboard-toolbar-row"))) {
        const widths = Array.from(row.children).map((child) => {
          const style = getComputedStyle(child);
          return (child as HTMLElement).offsetWidth + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
        }).filter((width) => width > 0);
        const natural = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * GAP;
        const room = row.clientWidth;
        let gap = GAP;
        if (natural > room + 1) {
          let count = 0, used = 0;
          while (count < widths.length && used + widths[count]! + (count ? GAP : 0) <= room) { used += widths[count]! + (count ? GAP : 0); count++; }
          if (count > 1) gap = Math.min(MAX_GAP, GAP + (room - used) / (count - 1));
        }
        const value = `${Math.floor(gap * 100) / 100}px`;
        if (row.style.columnGap !== value) row.style.columnGap = value;
        if (row.scrollWidth - row.clientWidth - row.scrollLeft > 4) more = true;
      }
      host.toggleAttribute("data-more", more);
    };
    fit();
    host.addEventListener("scroll", fit, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(host);
    return () => { host.removeEventListener("scroll", fit, true); observer?.disconnect(); };
  });

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
  // The suggestion under the caret: accept / reject it from the row (the floating bubble is not
  // mounted on a touch device — it sat on the text and behind the keyboard).
  const reviewRow = reviewing && review ? <>
    <button type="button" className="keyboard-toolbar-chip keyboard-toolbar-review focus-ring" data-tone="accept" onMouseDown={hold} onClick={() => review.accept()}><Check size={16} aria-hidden /> Accept</button>
    <button type="button" className="keyboard-toolbar-chip keyboard-toolbar-review focus-ring" data-tone="reject" onMouseDown={hold} onClick={() => review.reject()}><X size={16} aria-hidden /> Reject</button>
    <span className="selection-divider" aria-hidden="true" />
  </> : null;
  const dismiss = btn("Dismiss keyboard", <KeyboardOff size={20} />, () => { editor.commands.blur(); (document.activeElement as HTMLElement | null)?.blur?.(); setFocused(false); });
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
    <div ref={bar} className="keyboard-toolbar" role="toolbar" aria-label={commands ? "Editing toolbar" : reviewing && !selected ? "Suggestion review" : "Selection actions"} data-selection={selected || undefined} onBlur={onRowBlur}
      onPointerDown={press(true)} onPointerUp={press(false)} onPointerCancel={press(false)} style={{ bottom: keyboard.open ? inset : "var(--workspace-bottom-inset, 0px)" }} data-keyboard={keyboard.open ? "open" : undefined} data-keyboard-inset={inset}>
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
      ) : selected || !commands ? (
        // Text is selected: the selection's own actions lead (they were the floating bubble), then
        // what the bubble never had. Insert block waits for a caret.
        <div className="keyboard-toolbar-row keyboard-toolbar-selection no-scrollbar">
          {reviewRow}
          {selected && selection}
          {commands && <>
            <span className="selection-divider" aria-hidden="true" />
            {btn("To-do", <CheckSquare size={18} />, () => chain().toggleTaskList().run(), { active: editor.isActive("taskList") })}
            {btn("Indent", <IndentIncrease size={18} />, () => chain().sinkListItem(listType).run(), { disabled: !inList })}
            {btn("Outdent", <IndentDecrease size={18} />, () => chain().liftListItem(listType).run(), { disabled: !inList })}
            {btn("Undo", <Undo2 size={18} />, () => chain().undo().run(), { disabled: !editor.can().undo() })}
            {btn("Redo", <Redo2 size={18} />, () => chain().redo().run(), { disabled: !editor.can().redo() })}
          </>}
        </div>
      ) : (
        <div className="keyboard-toolbar-row no-scrollbar">
          {reviewRow}
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
        </div>
      )}
      <span className="keyboard-toolbar-more" aria-hidden="true">›</span>
      {/* Always in reach, never scrolled away: the system's own "done" bar is removed in the iOS app. */}
      {commands && panel === null && <div className="keyboard-toolbar-end">{dismiss}</div>}
    </div>
  );
}
