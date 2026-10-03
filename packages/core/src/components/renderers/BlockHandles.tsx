import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { GripVertical, Plus, Copy, Trash2, ArrowUp, ArrowDown, Repeat2, Palette } from "lucide-react";
import { BLOCK_COLORS, type BlockColorValue } from "../../editor/blocks";
import {
  TURN_INTO,
  blockKind,
  canColor,
  canTurnInto,
  deleteTopBlock,
  duplicateTopBlock,
  moveTopBlock,
  setTopBlockColor,
  topBlockAt,
  topLevelBlocks,
  turnTopBlocksInto,
} from "../../lib/tiptap/blockCommands";
import { EditorMenu, type EditorMenuItem } from "./EditorMenu";
import { TURN_INTO_ICONS, colorLabel } from "./blockUi";

interface Hovered {
  index: number;
  pos: number;
  top: number;
  left: number;
}

const COARSE = "(pointer: coarse), (max-width: 767px)";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** TipTap 3 throws on `editor.view` until the EditorContent has mounted. */
function viewReady(editor: Editor): boolean {
  try { return !editor.isDestroyed && !!editor.view.dom.isConnected; } catch { return false; }
}

/** Is the given top-level block DOM visible inside its scroll container? */
function scrollBounds(dom: HTMLElement): { top: number; bottom: number } {
  const scroller = dom.closest(".document-writing-scroll, .collab-scroll, [data-editor-scroll]") as HTMLElement | null;
  if (!scroller) return { top: 0, bottom: window.innerHeight };
  const r = scroller.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
}

/**
 * Notion-style block gutter for a TipTap editor: hover a top-level block to get
 * `+` (insert below, opens the slash menu) and `⋮⋮` (drag to reorder, click for
 * the block menu). On touch / phone widths there is no hover: the handle follows
 * the block holding the caret and a tap opens the same menu (with Move up/down).
 * Keyboard: Alt/Option+Shift+↑/↓ moves the block (BlockKeymap), ⌘/ / Ctrl+/
 * opens the block menu for the block holding the caret.
 */
export function BlockHandles({ editor, enabled }: { editor: Editor; enabled: boolean }) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [menu, setMenu] = useState<null | "main" | "turn" | "color">(null);
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia(COARSE).matches);
  const [drop, setDrop] = useState<{ index: number; top: number; left: number; width: number } | null>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const dragFrom = useRef<number | null>(null);
  const menuOpen = menu !== null;
  const menuRef = useRef(menuOpen);
  menuRef.current = menuOpen;

  useEffect(() => {
    const mq = window.matchMedia(COARSE);
    const on = () => setCoarse(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  /** Position the gutter against the top-level block `index`. */
  const place = useCallback((index: number): Hovered | null => {
    if (!viewReady(editor)) return null;
    const blocks = topLevelBlocks(editor.state.doc);
    const block = blocks[index];
    if (!block) return null;
    const dom = editor.view.nodeDOM(block.pos) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect();
    const bounds = scrollBounds(dom);
    const style = getComputedStyle(dom);
    const firstLine = Math.min(rect.height, parseFloat(style.lineHeight) || 24);
    const top = rect.top + parseFloat(style.paddingTop || "0") + Math.max(0, (firstLine - 24) / 2);
    if (top < bounds.top - 4 || top > bounds.bottom - 20) return null;
    return { index, pos: block.pos, top, left: rect.left };
  }, [editor]);

  const blockIndexAtY = useCallback((y: number): number | null => {
    if (!viewReady(editor)) return null;
    const blocks = topLevelBlocks(editor.state.doc);
    let best: number | null = null;
    for (const b of blocks) {
      const dom = editor.view.nodeDOM(b.pos) as HTMLElement | null;
      if (!(dom instanceof HTMLElement)) continue;
      const r = dom.getBoundingClientRect();
      const ms = getComputedStyle(dom);
      const top = r.top - (parseFloat(ms.marginTop) || 0);
      const bottom = r.bottom + (parseFloat(ms.marginBottom) || 0);
      if (y >= top && y <= bottom) return b.index;
      if (y > bottom) best = b.index;
    }
    return best;
  }, [editor]);

  // Desktop: follow the pointer across the editor column and its left gutter.
  useEffect(() => {
    if (!enabled || coarse) return;
    let frame = 0;
    const onMove = (event: MouseEvent) => {
      if (menuRef.current || dragFrom.current !== null) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!viewReady(editor)) return;
        const er = editor.view.dom.getBoundingClientRect();
        const inside = event.clientX >= er.left - 72 && event.clientX <= er.right + 8 && event.clientY >= er.top - 4 && event.clientY <= er.bottom + 4;
        if (!inside) { setHovered(null); return; }
        const index = blockIndexAtY(event.clientY);
        setHovered(index === null ? null : place(index));
      });
    };
    document.addEventListener("mousemove", onMove);
    return () => { document.removeEventListener("mousemove", onMove); cancelAnimationFrame(frame); };
  }, [editor, enabled, coarse, place, blockIndexAtY]);

  // Touch / phone: follow the caret while the editor has focus.
  useEffect(() => {
    if (!enabled || !coarse) return;
    const sync = () => {
      if (menuRef.current) return;
      if (!editor.isFocused) { setHovered(null); return; }
      const block = topBlockAt(editor.state.doc, editor.state.selection.from);
      setHovered(block ? place(block.index) : null);
    };
    sync();
    editor.on("selectionUpdate", sync);
    editor.on("focus", sync);
    editor.on("blur", sync);
    editor.on("update", sync);
    return () => { editor.off("selectionUpdate", sync); editor.off("focus", sync); editor.off("blur", sync); editor.off("update", sync); };
  }, [editor, enabled, coarse, place]);

  // Keep the gutter attached while scrolling; hide it when its block scrolls away.
  useEffect(() => {
    if (!hovered) return;
    const onScroll = () => setHovered((h) => (h ? place(h.index) : h));
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onScroll); };
  }, [hovered?.index, place]); // eslint-disable-line react-hooks/exhaustive-deps

  // Document edits shift blocks: re-place (and close a menu whose block vanished).
  useEffect(() => {
    const onUpdate = () => setHovered((h) => (h ? place(Math.min(h.index, editor.state.doc.childCount - 1)) : h));
    editor.on("update", onUpdate);
    return () => { editor.off("update", onUpdate); };
  }, [editor, place]);

  // ⌘/ (Ctrl+/) opens the block menu for the caret's block.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!viewReady(editor) || !editor.view.dom.contains(event.target as Node)) return;
      if (event.key !== "/" || !(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
      const block = topBlockAt(editor.state.doc, editor.state.selection.from);
      const at = block && place(block.index);
      if (!at) return;
      event.preventDefault();
      setHovered(at);
      setMenu("main");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editor, enabled, place]);

  useEffect(() => { if (!enabled) { setHovered(null); setMenu(null); } }, [enabled]);

  const closeMenu = useCallback((refocusEditor = false) => {
    setMenu(null);
    if (refocusEditor) editor.commands.focus();
    else handleRef.current?.focus({ preventScroll: true });
  }, [editor]);

  const run = (build: () => ReturnType<typeof moveTopBlock>) => {
    const tr = build();
    if (tr) editor.view.dispatch(tr);
    setMenu(null);
    editor.commands.focus();
  };

  // ── Drag and drop (desktop) ───────────────────────────────────────────────
  // Drag events are handled at the document in the capture phase while a block
  // drag is active, so ProseMirror's own drop handling never sees them and the
  // move is exactly one replace step (moveTopBlock).
  useEffect(() => {
    if (!enabled) return;
    const target = (y: number) => {
      const blocks = topLevelBlocks(editor.state.doc);
      let index = blocks.length;
      for (const b of blocks) {
        const dom = editor.view.nodeDOM(b.pos) as HTMLElement | null;
        if (!(dom instanceof HTMLElement)) continue;
        const r = dom.getBoundingClientRect();
        if (y < r.top + r.height / 2) { index = b.index; break; }
      }
      return index;
    };
    const lineAt = (index: number) => {
      const blocks = topLevelBlocks(editor.state.doc);
      const er = editor.view.dom.getBoundingClientRect();
      const ref = blocks[Math.min(index, blocks.length - 1)];
      const dom = ref && (editor.view.nodeDOM(ref.pos) as HTMLElement | null);
      if (!(dom instanceof HTMLElement)) return null;
      const r = dom.getBoundingClientRect();
      const ms = getComputedStyle(dom);
      const top = index >= blocks.length ? r.bottom + (parseFloat(ms.marginBottom) || 0) / 2 : r.top - (parseFloat(ms.marginTop) || 0) / 2;
      return { index, top: top - 1, left: er.left, width: er.width };
    };
    const onOver = (event: DragEvent) => {
      if (dragFrom.current === null || !viewReady(editor)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setDrop(lineAt(target(event.clientY)));
    };
    const onDrop = (event: DragEvent) => {
      if (dragFrom.current === null || !viewReady(editor)) return;
      event.preventDefault();
      event.stopPropagation();
      const from = dragFrom.current;
      dragFrom.current = null;
      setDrop(null);
      const tr = moveTopBlock(editor.state, from, target(event.clientY));
      if (tr) editor.view.dispatch(tr);
      editor.commands.focus();
    };
    document.addEventListener("dragover", onOver, true);
    document.addEventListener("drop", onDrop, true);
    return () => { document.removeEventListener("dragover", onOver, true); document.removeEventListener("drop", onDrop, true); };
  }, [editor, enabled]);

  if (!enabled || !hovered) return null;
  const block = editor.state.doc.nodeAt(hovered.pos);
  if (!block) return null;
  const kind = blockKind(block);
  const narrow = coarse;
  const gutterLeft = narrow ? Math.max(0, hovered.left - 21) : hovered.left - 52;

  const insertBelow = () => {
    const end = hovered.pos + block.nodeSize;
    const empty = block.type.name === "paragraph" && block.content.size === 0;
    const chain = editor.chain().focus();
    if (empty) chain.setTextSelection(hovered.pos + 1).insertContent("/");
    else chain.insertContentAt(end, { type: "paragraph", content: [{ type: "text", text: "/" }] }).setTextSelection(end + 2);
    chain.run();
  };

  const mainItems: EditorMenuItem[] = [
    ...(canTurnInto(block) ? [{ id: "turn", label: "Turn into", icon: <Repeat2 size={15} />, submenu: true, onSelect: () => setMenu("turn") }] : []),
    ...(canColor(block) ? [{ id: "color", label: "Color", icon: <Palette size={15} />, submenu: true, onSelect: () => setMenu("color") }] : []),
    { id: "duplicate", label: "Duplicate", icon: <Copy size={15} />, onSelect: () => run(() => duplicateTopBlock(editor.state, hovered.pos)) },
    { id: "up", label: "Move up", icon: <ArrowUp size={15} />, hint: isMac ? "⌥⇧↑" : "Alt+Shift+↑", disabled: hovered.index === 0, onSelect: () => run(() => moveTopBlock(editor.state, hovered.index, hovered.index - 1)) },
    { id: "down", label: "Move down", icon: <ArrowDown size={15} />, hint: isMac ? "⌥⇧↓" : "Alt+Shift+↓", disabled: hovered.index >= editor.state.doc.childCount - 1, onSelect: () => run(() => moveTopBlock(editor.state, hovered.index, hovered.index + 2)) },
    { id: "delete", label: "Delete", icon: <Trash2 size={15} />, danger: true, onSelect: () => run(() => deleteTopBlock(editor.state, hovered.pos)) },
  ];
  const turnItems: EditorMenuItem[] = TURN_INTO.map((t) => ({
    id: t.kind,
    label: t.label,
    icon: TURN_INTO_ICONS[t.kind],
    checked: kind === t.kind,
    onSelect: () => run(() => turnTopBlocksInto(editor.state, hovered.pos + 1, hovered.pos + 1, t.kind)),
  }));
  const currentColor = (block.attrs.blockColor as BlockColorValue | null) ?? null;
  const colorItems: EditorMenuItem[] = [
    { id: "default", label: "Default", section: "Text", checked: currentColor === null, icon: <span className="block-color-swatch" />, onSelect: () => run(() => setTopBlockColor(editor.state, hovered.pos, null)) },
    ...BLOCK_COLORS.map((c) => ({ id: c, label: colorLabel(c), checked: currentColor === c, icon: <span className="block-color-swatch" data-text-color={c}>A</span>, onSelect: () => run(() => setTopBlockColor(editor.state, hovered.pos, c)) })),
    ...BLOCK_COLORS.map((c, i) => ({ id: `${c}_background`, section: i === 0 ? "Background" : undefined, label: `${colorLabel(c)} background`, checked: currentColor === `${c}_background`, icon: <span className="block-color-swatch" data-block-color={`${c}_background`} />, onSelect: () => run(() => setTopBlockColor(editor.state, hovered.pos, `${c}_background` as BlockColorValue)) })),
  ];
  const menuTop = Math.min(hovered.top + 28, window.innerHeight - 340);
  const menuStyle: React.CSSProperties = { position: "fixed", top: Math.max(8, menuTop), left: Math.max(8, Math.min(gutterLeft, window.innerWidth - 248)), zIndex: 70 };

  return createPortal(
    <>
      <div className={`block-gutter${narrow ? " is-narrow" : ""}${menuOpen ? " is-active" : ""}`} style={{ top: hovered.top, left: gutterLeft }} data-block-index={hovered.index}>
        {!narrow && (
          <button type="button" className="block-gutter-button" aria-label="Insert block below" title="Insert block below"
            onMouseDown={(event) => event.preventDefault()} onClick={insertBelow}>
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
        <button
          ref={handleRef}
          type="button"
          data-editor-menu-anchor
          className="block-gutter-button block-gutter-grip"
          aria-label={narrow ? "Block actions" : "Drag to move, click for block actions"}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={narrow ? "Block actions" : "Drag to move · Click for actions"}
          draggable={!narrow}
          // Desktop: no preventDefault on mousedown — it would cancel the native
          // drag. Narrow: keep the editor focused so the caret-following handle stays.
          onMouseDown={narrow ? (event) => event.preventDefault() : undefined}
          onClick={() => setMenu((m) => (m ? null : "main"))}
          onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setMenu("main"); } }}
          onDragStart={(event) => {
            dragFrom.current = hovered.index;
            setMenu(null);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-prism-block", String(hovered.index));
            const dom = editor.view.nodeDOM(hovered.pos);
            if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 8);
          }}
          onDragEnd={() => { dragFrom.current = null; setDrop(null); }}
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>
      </div>
      {drop && <div className="block-drop-indicator" style={{ top: drop.top, left: drop.left, width: drop.width }} aria-hidden="true" />}
      {menu === "main" && <EditorMenu label="Block actions" items={mainItems} onClose={() => closeMenu()} style={menuStyle} />}
      {menu === "turn" && <EditorMenu label="Turn into" items={turnItems} onClose={() => closeMenu()} onBack={() => setMenu("main")} style={menuStyle} />}
      {menu === "color" && <EditorMenu label="Color" items={colorItems} onClose={() => closeMenu()} onBack={() => setMenu("main")} style={{ ...menuStyle, maxHeight: 360, overflowY: "auto" }} />}
    </>,
    document.body,
  );
}
