import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { GripVertical, Plus, Copy, CopyPlus, Trash2, ArrowUp, ArrowDown, Repeat2, Palette, FolderInput, Link2, MessageSquarePlus, Sparkles, FileText, Wand2 } from "lucide-react";
import { BLOCK_COLORS, type BlockColorValue } from "../../editor/blocks";
import {
  TURN_INTO,
  blockKind,
  canColor,
  canTurnInto,
  canUnwrap,
  containsNonText,
  deleteTopBlock,
  unwrapTopBlock,
  duplicateTopBlock,
  moveBlocksBeside,
  moveBlocksBesideIn,
  moveTopBlockIn,
  setTopBlockColor,
  structuralEditsAllowed,
  topBlockAt,
  topLevelBlocks,
  turnTopBlocksInto,
} from "../../lib/tiptap/blockCommands";
import { EditorMenu, type EditorMenuItem } from "./EditorMenu";
import { blockRefAt, locateBlock, mapBlockRef, type BlockRef } from "../../lib/tiptap/blockRef";
import { TURN_INTO_ICONS, colorLabel } from "./blockUi";
import { blockSelectionActive, blockSelectionRange, selectBlocks } from "../../lib/tiptap/EditorKeys";
import { appendBlocksToPage, blocksToHtml, canMoveBlocksToPage, carryAttachments, copyBlocks, moveFailureText, newMoveRequestId } from "../../lib/tiptap/moveBlock";
import { suppressTrashOffer } from "../../lib/tiptap/childPage";
import { copyHeadingLink } from "../../lib/pages/headingLinks";
import { useSelectionAsk } from "../../lib/agent/useSelectionAsk";
import { useHostServices } from "../../data/HostServicesContext";
import { noteForEditor } from "../../lib/agent/documentSnapshots";
import { requestPageAgent, type PageAgentKind } from "../../lib/agent/pageActions";
import { useSyncStore } from "../../lib/sync/syncState";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { noteLinkTitle } from "../../lib/wikilinks";
import { inferContentType } from "../../lib/schemas/content-types";
import { isTrashed, protectionReason } from "../../lib/pages/model";
import type { Note } from "../../lib/types";
import "./ShortcutSheet"; // installs ⌘/ → keyboard shortcuts
import "../../lib/tiptap/toggleAll"; // installs ⌘⌥T → expand / collapse all toggles (view state only)

interface Hovered {
  index: number;
  pos: number;
  /** The block's identity across edits (see blockRef.ts). */
  ref: BlockRef;
  top: number;
  left: number;
}

const COARSE = "(pointer: coarse), (max-width: 767px)";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function textRangeSelected(editor: Editor): boolean {
  const { selection } = editor.state;
  return selection instanceof TextSelection && !selection.empty;
}

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
 * Keyboard: Alt/Option+Shift+↑/↓ moves the block (BlockKeymap), ⌘⇧/ / Ctrl+Shift+/
 * opens the block menu for the block holding the caret.
 *
 * Wave 4A: the menu is searchable and gains Copy, Move to (another page),
 * Comment and Ask agent; dragging a handle inside a block selection moves every
 * selected block; dropping on a block's far left/right edge makes columns.
 */
export interface BlockHandlesProps {
  editor: Editor;
  enabled: boolean;
  /** Pages the block can be moved to ("Move to"). Omitted or empty → the item is hidden. */
  notes?: Note[];
  /** This page's id (never offered as a move target). */
  noteId?: string | null;
  /** Comment on the block's text (live documents). Omitted → the item is hidden. */
  onComment?: (range: { from: number; to: number }) => void;
}

/** Where a dragged block would land. */
type Drop =
  | { kind: "line"; index: number; top: number; left: number; width: number }
  | { kind: "side"; index: number; side: "left" | "right"; top: number; left: number; height: number };

export function BlockHandles({ editor, enabled, notes, noteId, onComment }: BlockHandlesProps) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [menu, setMenu] = useState<null | "main" | "turn" | "color" | "move">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const client = useOptionalVaultClient();
  const agent = useSelectionAsk(editor);
  const agentHost = useHostServices();
  const online = useSyncStore((st) => st.online);
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia(COARSE).matches);
  const [drop, setDrop] = useState<Drop | null>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const dragFrom = useRef<BlockRef | null>(null);
  /** How many blocks the current drag carries (a block selection moves together). */
  const dragCount = useRef(1);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), Math.max(3500, notice.length * 70));
    return () => clearTimeout(t);
  }, [notice]);
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
    const ref = blockRefAt(editor, block.pos);
    if (!ref) return null;
    return { index, pos: block.pos, ref, top, left: rect.left };
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
        // Re-check when the frame runs: a menu may have opened (or a drag begun) since the
        // move was queued, and an edit above can have shifted another block under the old
        // pointer position — the open menu must keep acting on ITS block.
        if (!viewReady(editor) || menuRef.current || dragFrom.current !== null) return;
        const er = editor.view.dom.getBoundingClientRect();
        const inside = event.clientX >= er.left - 72 && event.clientX <= er.right + 8 && event.clientY >= er.top - 4 && event.clientY <= er.bottom + 4;
        // A text range selection owns the selection toolbar; keep the gutter out of its way.
        if (!inside || (textRangeSelected(editor) && !blockSelectionActive(editor.state))) { setHovered(null); return; }
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

  // Every edit — local or a collaborator's — may shift or replace blocks: follow
  // the hovered block by identity; if it is gone, close its menu and cancel a drag.
  useEffect(() => {
    const onUpdate = ({ transaction }: { transaction: Transaction }) => {
      if (!viewReady(editor) || !transaction.docChanged) return;
      if (dragFrom.current) {
        dragFrom.current = mapBlockRef(dragFrom.current, transaction);
        if (!locateBlock(editor, dragFrom.current)) { dragFrom.current = null; setDrop(null); }
      }
      setHovered((h) => {
        if (!h) return h;
        const ref = mapBlockRef(h.ref, transaction);
        const now = locateBlock(editor, ref);
        if (!ref || !now) { setMenu(null); return null; }
        const placed = place(now.index);
        return placed ? { ...placed, ref } : menuRef.current ? { ...h, ...now, ref } : null;
      });
    };
    const onSelection = () => { if (!coarse && !menuRef.current && textRangeSelected(editor) && !blockSelectionActive(editor.state)) setHovered(null); };
    editor.on("transaction", onUpdate);
    editor.on("selectionUpdate", onSelection);
    return () => { editor.off("transaction", onUpdate); editor.off("selectionUpdate", onSelection); };
  }, [editor, place, coarse]);

  // ⌘⇧/ (Ctrl+Shift+/) opens the block menu for the caret's block. (⌘/ alone is the shortcut sheet.)
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!viewReady(editor) || !editor.view.dom.contains(event.target as Node)) return;
      if ((event.code !== "Slash" && event.key !== "/" && event.key !== "?") || !(isMac ? event.metaKey : event.ctrlKey) || event.altKey || !event.shiftKey) return;
      const block = topBlockAt(editor.state.doc, editor.state.selection.from);
      const at = block && place(block.index);
      if (!at) return;
      event.preventDefault();
      setHovered(at);
      fromKeyboard.current = true;
      setMenu("main");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editor, enabled, place]);

  useEffect(() => { if (!enabled) { setHovered(null); setMenu(null); } }, [enabled]);

  /** The menu was opened by the shortcut while the caret was in the text: closing it returns there. */
  const fromKeyboard = useRef(false);
  const closeMenu = useCallback((refocusEditor = false) => {
    setMenu(null);
    const handle = handleRef.current;
    if (refocusEditor || fromKeyboard.current || !handle || !handle.isConnected) editor.commands.focus();
    else handle.focus({ preventScroll: true });
    fromKeyboard.current = false;
  }, [editor]);

  /** Act on the hovered block where it is NOW; refuse if it no longer exists. */
  const run = (act: (at: { index: number; pos: number }) => Transaction | boolean | null) => {
    const at = hovered && locateBlock(editor, hovered.ref);
    setMenu(null);
    if (!at) { setHovered(null); return; }
    const result = act(at);
    if (result && typeof result === "object") editor.view.dispatch(result);
    editor.commands.focus();
  };

  // ── Drag and drop (desktop) ───────────────────────────────────────────────
  // Drag events are handled at the document in the capture phase while a block
  // drag is active, so ProseMirror's own drop handling never sees them and the
  // move is one replace step (plain) or delete+insert (live; moveTopBlockIn).
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
    const lineAt = (index: number): Drop | null => {
      const blocks = topLevelBlocks(editor.state.doc);
      const er = editor.view.dom.getBoundingClientRect();
      const ref = blocks[Math.min(index, blocks.length - 1)];
      const dom = ref && (editor.view.nodeDOM(ref.pos) as HTMLElement | null);
      if (!(dom instanceof HTMLElement)) return null;
      const r = dom.getBoundingClientRect();
      const ms = getComputedStyle(dom);
      const top = index >= blocks.length ? r.bottom + (parseFloat(ms.marginBottom) || 0) / 2 : r.top - (parseFloat(ms.marginTop) || 0) / 2;
      return { kind: "line", index, top: top - 1, left: er.left, width: er.width };
    };
    // Side zones (NP-ED-09): the page margin LEFT of the handles, and the last
    // stretch of the column on the right. Over a block there = "put it beside".
    const sideAt = (event: DragEvent): Drop | null => {
      if (window.matchMedia("(max-width: 767px)").matches || !editor.schema.nodes.columns) return null;
      const er = editor.view.dom.getBoundingClientRect();
      const side = event.clientX < er.left - 60 ? "left" : event.clientX > er.right - Math.max(40, er.width * 0.12) ? "right" : null;
      if (!side) return null;
      const from = locateBlock(editor, dragFrom.current);
      for (const b of topLevelBlocks(editor.state.doc)) {
        const dom = editor.view.nodeDOM(b.pos) as HTMLElement | null;
        if (!(dom instanceof HTMLElement)) continue;
        const r = dom.getBoundingClientRect();
        if (event.clientY < r.top || event.clientY > r.bottom) continue;
        if (!from || !moveBlocksBeside(editor.state, from.index, dragCount.current, b.index, side)) return null;
        return { kind: "side", index: b.index, side, top: r.top, left: side === "left" ? r.left - 6 : r.right + 3, height: r.height };
      }
      return null;
    };
    // Only the editor column (and its gutter / left margin) is a drop zone:
    // anywhere else the drop is not accepted and the drag simply ends.
    const overEditor = (event: DragEvent) => {
      const er = editor.view.dom.getBoundingClientRect();
      return event.clientX >= er.left - 120 && event.clientX <= er.right + 8 && event.clientY >= er.top - 24 && event.clientY <= er.bottom + 24;
    };
    const dropAt = (event: DragEvent): Drop | null => sideAt(event) ?? (event.clientX >= editor.view.dom.getBoundingClientRect().left - 72 ? lineAt(target(event.clientY)) : null);
    const onOver = (event: DragEvent) => {
      if (dragFrom.current === null || !viewReady(editor)) return;
      if (!overEditor(event)) { setDrop(null); return; }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setDrop(dropAt(event));
    };
    const onDrop = (event: DragEvent) => {
      if (dragFrom.current === null || !viewReady(editor)) return;
      if (!overEditor(event)) { dragFrom.current = null; setDrop(null); return; }
      event.preventDefault();
      event.stopPropagation();
      const from = locateBlock(editor, dragFrom.current);
      const count = dragCount.current;
      const where = dropAt(event);
      dragFrom.current = null;
      dragCount.current = 1;
      setDrop(null);
      if (from && where?.kind === "side") {
        moveBlocksBesideIn(editor, from.index, count, where.index, where.side);
      } else if (from && where) {
        const to = where.index;
        if (moveTopBlockIn(editor, from.index, to, count) && count > 1) {
          // Keep the moved blocks selected where they landed.
          const start = to > from.index ? to - count : to;
          selectBlocks(editor.view, start, start + count - 1);
        }
      }
      // At once, not a frame later (TipTap's focus command waits for the next frame): until the
      // editor has focus again the keyboard belongs to nothing, and ⌘Z right after a drop went to
      // the browser instead of undoing the move.
      editor.view.focus();
      editor.commands.focus();
    };
    document.addEventListener("dragover", onOver, true);
    document.addEventListener("drop", onDrop, true);
    return () => { document.removeEventListener("dragover", onOver, true); document.removeEventListener("drop", onDrop, true); };
  }, [editor, enabled]);

  const noticeEl = notice ? createPortal(<div className="block-notice" role="status">{notice}</div>, document.body) : null;
  if (!enabled || !hovered) return noticeEl;
  const block = editor.state.doc.nodeAt(hovered.pos);
  if (!block) return noticeEl;
  const kind = blockKind(block);
  const narrow = coarse;
  // #44: on a phone the grip keeps ≥ 4 px from the text (16 px wide, its 44 px hit area grows left).
  const gutterLeft = narrow ? Math.max(0, hovered.left - 22) : hovered.left - 52;

  const insertBelow = () => {
    const at = locateBlock(editor, hovered.ref);
    const node = at && editor.state.doc.nodeAt(at.pos);
    if (!at || !node) { setHovered(null); return; }
    const end = at.pos + node.nodeSize;
    const empty = node.type.name === "paragraph" && node.content.size === 0;
    const chain = editor.chain().focus();
    if (empty) chain.setTextSelection(at.pos + 1).insertContent("/");
    else chain.insertContentAt(end, { type: "paragraph", content: [{ type: "text", text: "/" }] }).setTextSelection(end + 2);
    chain.run();
  };

  const textRange = { from: hovered.pos + 1, to: hovered.pos + block.nodeSize - 1 };
  const hasText = block.textContent.trim().length > 0 && textRange.to > textRange.from;
  const targets = (notes ?? []).filter((n) => n.id !== noteId && !isTrashed(n) && !protectionReason(n) && inferContentType(n) === "document");
  const canMove = canMoveBlocksToPage() && targets.length > 0 && structuralEditsAllowed(editor);
  const canAsk = agent.available && hasText;

  /** Select the block's text so Comment / Ask agent act on exactly this block. */
  // `focus: false` for callers that open their own field (the comment composer): TipTap focuses a frame later
  // and would take the keyboard back, so the typed comment replaced the block's text.
  const selectBlockText = (at: { pos: number }, focus = true) => {
    const node = editor.state.doc.nodeAt(at.pos);
    if (!node) return null;
    const range = { from: at.pos + 1, to: at.pos + node.nodeSize - 1 };
    if (focus) editor.chain().focus().setTextSelection(range).run();
    else editor.chain().setTextSelection(range).run();
    return range;
  };
  const moveTo = (target: Note) => {
    const at = locateBlock(editor, hovered.ref);
    const node = at && editor.state.doc.nodeAt(at.pos);
    setMenu(null);
    if (!at || !node) { setHovered(null); return; }
    const ref = hovered.ref;
    const html = blocksToHtml(editor.schema, [node]);
    const title = noteLinkTitle(target);
    const requestId = newMoveRequestId(); // one id per invocation: a resend appends once
    setNotice(`Moving to ${title}…`);
    appendBlocksToPage(target.id, html, requestId).then(async () => {
      // CONFIRMED by the server (never a queued write). Remove the block here only
      // if it is still here, unchanged; a sub-page row that moves is not "deleted".
      const now = editor.isDestroyed ? null : locateBlock(editor, ref);
      const still = now && editor.state.doc.nodeAt(now.pos);
      const removed = !!(now && still && still.eq(node));
      if (removed) {
        suppressTrashOffer(editor);
        const tr = deleteTopBlock(editor.state, now!.pos);
        if (tr) editor.view.dispatch(tr);
      }
      const files = await carryAttachments(client, target.id, html);
      setNotice(`${removed ? `Moved to ${title}` : `Copied to ${title} — the block changed here, so it was kept`}${files ? `. ${files}` : ""}`);
    }, (e) => setNotice(moveFailureText(e, title)));
  };

  const headingNoteId = noteId ?? noteForEditor(editor)?.noteId ?? null;
  const mainItems: EditorMenuItem[] = [
    // Phones have no + button and no "/" key handy: insert lives in the menu.
    ...(narrow ? [{ id: "insert", label: "Insert block below", icon: <Plus size={15} />, onSelect: () => { setMenu(null); insertBelow(); } }] : []),
    ...(canTurnInto(block) ? [{ id: "turn", label: "Turn into", icon: <Repeat2 size={15} />, submenu: true, onSelect: () => setMenu("turn") }] : []),
    // A wrapper holding images/tables cannot be re-shaped without loss: Unwrap keeps everything.
    ...(canUnwrap(block) ? [{ id: "unwrap", label: containsNonText(block) ? "Unwrap (keeps images and tables)" : "Unwrap", icon: <Repeat2 size={15} />, onSelect: () => run((at) => unwrapTopBlock(editor.state, at.pos)) }] : []),
    ...(canColor(block) ? [{ id: "color", label: "Color", icon: <Palette size={15} />, submenu: true, onSelect: () => setMenu("color") }] : []),
    { id: "duplicate", label: "Duplicate", icon: <CopyPlus size={15} />, hint: isMac ? "⌘D" : "Ctrl+D", onSelect: () => run((at) => duplicateTopBlock(editor.state, at.pos)) },
    { id: "copy", label: "Copy", icon: <Copy size={15} />, keywords: "clipboard markdown", onSelect: () => run((at) => {
      const node = editor.state.doc.nodeAt(at.pos);
      if (node) void copyBlocks(editor.schema, [node]).then((ok) => setNotice(ok ? "Copied block" : "Couldn’t copy — the browser refused clipboard access"));
      return null;
    }) },
    // A heading has a shareable address (`<page link>#h-<slug>`); the slug comes from its text.
    ...(block?.type.name === "heading" && block.textContent.trim() && headingNoteId ? [{ id: "copy-heading-link", label: "Copy link to heading", icon: <Link2 size={15} />, keywords: "url anchor section share", onSelect: () => run((at) => {
      let dom: Node | null = null;
      try { dom = editor.view.nodeDOM(at.pos); } catch { dom = null; }
      void copyHeadingLink(headingNoteId, dom instanceof Element ? dom : null).then((ok) => setNotice(ok ? "Copied link to heading" : "Couldn’t copy — the browser refused clipboard access"));
      return null;
    }) }] : []),
    ...(canMove ? [{ id: "move", label: "Move to", icon: <FolderInput size={15} />, keywords: "another page", submenu: true, onSelect: () => setMenu("move") }] : []),
    ...(onComment && hasText ? [{ id: "comment", label: "Comment", icon: <MessageSquarePlus size={15} />, onSelect: () => {
      const at = locateBlock(editor, hovered.ref);
      setMenu(null);
      const range = at && selectBlockText(at, false);
      if (range) onComment(range);
    } }] : []),
    ...(canAsk ? [{ id: "ask", label: "Ask agent", icon: <Sparkles size={15} />, keywords: "ai assistant", disabled: !agent.canAsk, onSelect: () => {
      const at = locateBlock(editor, hovered.ref);
      setMenu(null);
      // The block's text becomes the selection context of the SAME document-bound session.
      if (at && selectBlockText(at)) agent.ask("selection");
    } }] : []),
    // NP-AI-03: the block as the agent's selection — the result is a proposal to review.
    ...(agentHost && hasText ? ([["summarize", "Summarize with agent"], ["draft", "Draft with agent…"], ["transform", "Transform with agent…"]] as Array<[PageAgentKind, string]>).map(([kind, label]) => ({
      id: `agent-${kind}`, label, icon: <Wand2 size={15} />, keywords: "ai rewrite shorter longer grammar tone translate continue expand", disabled: !online, onSelect: () => {
        const at = locateBlock(editor, hovered.ref);
        setMenu(null);
        const open = noteForEditor(editor);
        if (open && at && selectBlockText(at)) requestPageAgent(open.noteId, open.title, kind, "selection");
      } })) : []),
    { id: "up", label: "Move up", icon: <ArrowUp size={15} />, hint: isMac ? "⌘⇧↑" : "Ctrl+Shift+↑", disabled: hovered.index === 0, onSelect: () => run((at) => moveTopBlockIn(editor, at.index, at.index - 1)) },
    { id: "down", label: "Move down", icon: <ArrowDown size={15} />, hint: isMac ? "⌘⇧↓" : "Ctrl+Shift+↓", disabled: hovered.index >= editor.state.doc.childCount - 1, onSelect: () => run((at) => moveTopBlockIn(editor, at.index, at.index + 2)) },
    { id: "delete", label: "Delete", icon: <Trash2 size={15} />, danger: true, onSelect: () => run((at) => deleteTopBlock(editor.state, at.pos)) },
  ];
  const turnItems: EditorMenuItem[] = TURN_INTO.map((t) => ({
    id: t.kind,
    label: t.label,
    icon: TURN_INTO_ICONS[t.kind],
    checked: kind === t.kind,
    onSelect: () => run((at) => turnTopBlocksInto(editor.state, at.pos + 1, at.pos + 1, t.kind)),
  }));
  const currentColor = (block.attrs.blockColor as BlockColorValue | null) ?? null;
  const colorItems: EditorMenuItem[] = [
    { id: "default", label: "Default", section: "Text", checked: currentColor === null, icon: <span className="block-color-swatch" />, onSelect: () => run((at) => setTopBlockColor(editor.state, at.pos, null)) },
    ...BLOCK_COLORS.map((c) => ({ id: c, label: colorLabel(c), checked: currentColor === c, icon: <span className="block-color-swatch" data-text-color={c}>A</span>, onSelect: () => run((at) => setTopBlockColor(editor.state, at.pos, c)) })),
    ...BLOCK_COLORS.map((c, i) => ({ id: `${c}_background`, section: i === 0 ? "Background" : undefined, label: `${colorLabel(c)} background`, checked: currentColor === `${c}_background`, icon: <span className="block-color-swatch" data-block-color={`${c}_background`} />, onSelect: () => run((at) => setTopBlockColor(editor.state, at.pos, `${c}_background` as BlockColorValue)) })),
  ];
  const moveItems: EditorMenuItem[] = targets.slice(0, 200).map((n) => ({
    id: n.id,
    label: noteLinkTitle(n),
    keywords: n.path ?? "",
    icon: typeof n.metadata?.icon === "string" ? <span aria-hidden="true">{n.metadata.icon as string}</span> : <FileText size={15} />,
    onSelect: () => moveTo(n),
  }));
  // Searching the main menu also finds the Turn into kinds and colours.
  const searchPool: EditorMenuItem[] = [
    ...mainItems.filter((it) => !it.submenu || it.id === "move"),
    ...(canTurnInto(block) ? turnItems.map((it) => ({ ...it, id: `turn-${it.id}`, label: `Turn into ${it.label}`, checked: undefined })) : []),
    ...(canColor(block) ? colorItems.map((it) => ({ ...it, id: `color-${it.id}`, label: it.id === "default" ? "Default color" : it.id.endsWith("_background") ? it.label : `${it.label} text`, checked: undefined })) : []),
  ];
  const menuTop = Math.min(hovered.top + 28, window.innerHeight - 380);
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
          onClick={() => { fromKeyboard.current = false; setMenu((m) => (m ? null : "main")); }}
          onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); fromKeyboard.current = false; setMenu("main"); } }}
          onDragStart={(event) => {
            // Inside a block selection the handle carries every selected block (NP-ED-01).
            const range = blockSelectionRange(editor.state);
            const many = range && range.count > 1 && hovered.index >= range.from && hovered.index <= range.to ? range : null;
            const first = many ? blockRefAt(editor, topLevelBlocks(editor.state.doc)[many.from].pos) : hovered.ref;
            dragFrom.current = first ?? hovered.ref;
            dragCount.current = many && first ? many.count : 1;
            setMenu(null);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-prism-block", String(many ? many.from : hovered.index));
            const dom = editor.view.nodeDOM(hovered.pos);
            if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 8);
          }}
          onDragEnd={() => { dragFrom.current = null; dragCount.current = 1; setDrop(null); }}
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>
      </div>
      {drop?.kind === "line" && <div className="block-drop-indicator" data-drop="line" style={{ top: drop.top, left: drop.left, width: drop.width }} aria-hidden="true" />}
      {drop?.kind === "side" && <div className="block-drop-indicator is-side" data-drop={drop.side} style={{ top: drop.top, left: drop.left, height: drop.height }} aria-hidden="true" />}
      {menu === "main" && <EditorMenu label="Block actions" items={mainItems} searchable searchItems={searchPool} onClose={() => closeMenu()} style={{ ...menuStyle, maxHeight: Math.max(220, window.innerHeight - Math.max(8, menuTop) - 12), overflowY: "auto" }} />}
      {menu === "move" && <EditorMenu label="Move to" items={moveItems} searchable searchLabel="Search pages" onClose={() => closeMenu()} onBack={() => setMenu("main")} style={{ ...menuStyle, maxHeight: 360, overflowY: "auto" }} />}
      {menu === "turn" && <EditorMenu label="Turn into" items={turnItems} onClose={() => closeMenu()} onBack={() => setMenu("main")} style={menuStyle} />}
      {menu === "color" && <EditorMenu label="Color" items={colorItems} onClose={() => closeMenu()} onBack={() => setMenu("main")} style={{ ...menuStyle, maxHeight: 360, overflowY: "auto" }} />}
      {notice && <div className="block-notice" role="status">{notice}</div>}
    </>,
    document.body,
  );
}
