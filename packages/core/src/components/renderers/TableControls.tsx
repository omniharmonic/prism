import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { BetweenHorizontalStart, BetweenHorizontalEnd, BetweenVerticalStart, BetweenVerticalEnd, Rows3, Columns3, PanelTop, PanelLeft, PaintBucket, Grid2x2X } from "lucide-react";
import { BLOCK_COLORS } from "../../editor/blocks";
import { EditorMenu, type EditorMenuItem } from "./EditorMenu";
import { colorLabel } from "./blockUi";
import { structuralEditsAllowed } from "../../lib/tiptap/blockCommands";

/**
 * A compact toolbar above the table holding the caret: add/remove rows and
 * columns, header row and header column, cell background colour (the selected
 * cells, else the cell holding the caret), delete table. Hidden while a text range is selected
 * (the selection toolbar owns that moment), for read-only users and while
 * suggesting. Tab / Shift+Tab move between cells; Tab in the last cell adds a
 * row (TipTap table keymap).
 */
export function TableControls({ editor }: { editor: Editor }) {
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const colorRef = useRef<HTMLButtonElement>(null);
  const colorOpenRef = useRef(false);
  colorOpenRef.current = colorOpen;

  const sync = useCallback(() => {
    let dom: HTMLElement | null = null;
    try {
      const { selection } = editor.state;
      if (colorOpenRef.current) return; // the colour menu holds focus (the editor's blur must not unmount it)
      if (!editor.isFocused || !structuralEditsAllowed(editor) || !editor.isActive("table") || (selection instanceof TextSelection && !selection.empty)) { setBox(null); return; }
      const at = editor.view.domAtPos(selection.from).node as Node;
      dom = (at instanceof HTMLElement ? at : at.parentElement)?.closest(".tableWrapper, table") as HTMLElement | null;
    } catch { setBox(null); return; }
    if (!dom) { setBox(null); return; }
    const r = dom.getBoundingClientRect();
    const top = r.top - 40;
    setBox({ top: top < 8 ? r.bottom + 6 : top, left: Math.max(8, Math.min(r.left, window.innerWidth - 404)) });
  }, [editor]);

  useEffect(() => {
    editor.on("selectionUpdate", sync);
    editor.on("transaction", sync);
    editor.on("focus", sync);
    const onBlur = () => setTimeout(() => { if (!document.activeElement?.closest(".table-controls")) sync(); }, 0);
    editor.on("blur", onBlur);
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      editor.off("selectionUpdate", sync); editor.off("transaction", sync); editor.off("focus", sync); editor.off("blur", onBlur);
      window.removeEventListener("scroll", sync, true); window.removeEventListener("resize", sync);
    };
  }, [editor, sync]);

  if (!box) return null;
  const run = (fn: () => boolean) => { fn(); editor.commands.focus(); };
  const can = editor.can();
  const actions = [
    { label: "Add row above", icon: <BetweenHorizontalStart size={15} />, ok: can.addRowBefore(), run: () => editor.chain().focus().addRowBefore().run() },
    { label: "Add row below", icon: <BetweenHorizontalEnd size={15} />, ok: can.addRowAfter(), run: () => editor.chain().focus().addRowAfter().run() },
    { label: "Delete row", icon: <Rows3 size={15} />, ok: can.deleteRow(), run: () => editor.chain().focus().deleteRow().run() },
    { label: "Add column left", icon: <BetweenVerticalStart size={15} />, ok: can.addColumnBefore(), run: () => editor.chain().focus().addColumnBefore().run() },
    { label: "Add column right", icon: <BetweenVerticalEnd size={15} />, ok: can.addColumnAfter(), run: () => editor.chain().focus().addColumnAfter().run() },
    { label: "Delete column", icon: <Columns3 size={15} />, ok: can.deleteColumn(), run: () => editor.chain().focus().deleteColumn().run() },
    { label: "Toggle header row", icon: <PanelTop size={15} />, ok: can.toggleHeaderRow(), run: () => editor.chain().focus().toggleHeaderRow().run() },
    { label: "Toggle header column", icon: <PanelLeft size={15} />, ok: can.toggleHeaderColumn(), run: () => editor.chain().focus().toggleHeaderColumn().run() },
    { label: "Delete table", icon: <Grid2x2X size={15} />, ok: can.deleteTable(), run: () => editor.chain().focus().deleteTable().run(), danger: true },
  ];
  const cellAttrs = editor.isActive("tableHeader") ? editor.getAttributes("tableHeader") : editor.getAttributes("tableCell");
  const cellColor = (cellAttrs.cellColor as string | null | undefined) ?? null;
  const setColor = (color: string | null) => { setColorOpen(false); editor.chain().focus().setCellAttribute("cellColor", color).run(); };
  const colorItems: EditorMenuItem[] = [
    { id: "none", label: "No background", checked: cellColor === null, icon: <span className="block-color-swatch" />, onSelect: () => setColor(null) },
    ...BLOCK_COLORS.map((c) => ({ id: c, label: `${colorLabel(c)} background`, checked: cellColor === c, icon: <span className="block-color-swatch" data-block-color={`${c}_background`} />, onSelect: () => setColor(c) })),
  ];
  return createPortal(
    <div className="table-controls" role="toolbar" aria-label="Table" style={{ top: box.top, left: box.left }} onMouseDown={(e) => e.preventDefault()}>
      {actions.map((a, i) => (
        <span key={a.label} className="contents">
          {(i === 3 || i === 6) && <span className="selection-divider" aria-hidden="true" />}
          {a.danger && (
            <span className="selection-dropdown">
              <button ref={colorRef} type="button" data-editor-menu-anchor aria-label="Cell background color" title="Cell background color" aria-haspopup="menu" aria-expanded={colorOpen}
                onClick={() => setColorOpen((v) => !v)}><PaintBucket size={15} /></button>
              {colorOpen && (() => {
                // Fixed: the toolbar scrolls sideways on phones and would clip an absolutely placed menu.
                const r = colorRef.current?.getBoundingClientRect();
                const top = r ? (r.bottom + 240 > window.innerHeight ? Math.max(8, r.top - 236) : r.bottom + 4) : 8;
                return <EditorMenu label="Cell background" items={colorItems} style={{ position: "fixed", zIndex: 70, top, left: Math.max(8, Math.min(r?.left ?? 8, window.innerWidth - 248)) }} onClose={() => { setColorOpen(false); editor.commands.focus(); }} />;
              })()}
            </span>
          )}
          <button type="button" aria-label={a.label} title={a.label} disabled={!a.ok} className={a.danger ? "is-danger" : undefined} onClick={() => run(a.run)}>{a.icon}</button>
        </span>
      ))}
    </div>,
    document.body,
  );
}
