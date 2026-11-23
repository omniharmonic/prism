/**
 * Browser node view for `columns` (NP-ED-09): a gutter handle between adjacent
 * columns. Dragging it (or ←/→ on the focused handle) re-divides the two
 * neighbours' share; the result is stored as each column's `width` (a flex-grow
 * ratio) in ONE transaction on release — nothing is written while dragging.
 * The schema node is in editor/blocks.ts; on the server and in stored HTML the
 * columns render through plain renderHTML.
 */
import type { NodeViewRenderer } from "@tiptap/core";
import { columnWidth, registerBlockViews } from "../../editor/blocks";
import { structuralEditsAllowed } from "./blockCommands";

const MIN_PX = 72;

const columnsView: NodeViewRenderer = ({ node, editor, getPos }) => {
  let current = node;
  // `editor.view` is not available yet while the initial document's views are built.
  const doc = document;
  const dom = doc.createElement("div");
  dom.className = "prism-columns";
  const content = doc.createElement("div");
  content.setAttribute("data-type", "columns");
  content.setAttribute("data-count", String(node.childCount));
  dom.appendChild(content);
  let handles: HTMLButtonElement[] = [];

  const columns = () => Array.from(content.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.getAttribute("data-type") === "column");

  const layout = () => {
    const cols = columns();
    const want = editor.isEditable ? Math.max(0, cols.length - 1) : 0;
    while (handles.length > want) handles.pop()!.remove();
    while (handles.length < want) handles.push(makeHandle(handles.length));
    const base = dom.getBoundingClientRect();
    handles.forEach((h, i) => {
      const a = cols[i].getBoundingClientRect();
      const b = cols[i + 1].getBoundingClientRect();
      h.style.left = `${Math.round((a.right + b.left) / 2 - base.left)}px`;
    });
  };

  /** Store the new split of columns `i` and `i+1`: one transaction, total share unchanged. */
  const commit = (i: number, leftPx: number, rightPx: number) => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined || !structuralEditsAllowed(editor)) return;
    const parent = editor.state.doc.nodeAt(pos);
    if (!parent || parent.type.name !== "columns" || i + 1 >= parent.childCount) return;
    const a = parent.child(i);
    const b = parent.child(i + 1);
    const total = (columnWidth(a.attrs.width) ?? 1) + (columnWidth(b.attrs.width) ?? 1);
    const left = columnWidth((total * leftPx) / (leftPx + rightPx));
    const right = left === null ? null : columnWidth(total - left);
    if (left === null || right === null) return;
    let at = pos + 1;
    for (let k = 0; k < i; k++) at += parent.child(k).nodeSize;
    const tr = editor.state.tr;
    tr.setNodeMarkup(at, undefined, { ...a.attrs, width: left });
    tr.setNodeMarkup(at + a.nodeSize, undefined, { ...b.attrs, width: right });
    editor.view.dispatch(tr);
  };

  function makeHandle(index: number): HTMLButtonElement {
    const handle = doc.createElement("button");
    handle.type = "button";
    handle.className = "prism-column-resize";
    handle.contentEditable = "false";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Resize columns ${index + 1} and ${index + 2}`);
    handle.title = "Drag to resize";
    const sizes = () => {
      const cols = columns();
      return { left: cols[index]?.getBoundingClientRect().width ?? 0, right: cols[index + 1]?.getBoundingClientRect().width ?? 0 };
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !structuralEditsAllowed(editor)) return;
      event.preventDefault();
      const startX = event.clientX;
      const startLeft = parseFloat(handle.style.left) || 0;
      const { left, right } = sizes();
      const clamp = (dx: number) => Math.max(MIN_PX - left, Math.min(dx, right - MIN_PX));
      handle.setAttribute("data-dragging", "");
      handle.setPointerCapture?.(event.pointerId);
      const move = (e: PointerEvent) => { handle.style.left = `${startLeft + clamp(e.clientX - startX)}px`; };
      const up = (e: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", cancel);
        handle.removeAttribute("data-dragging");
        const dx = clamp(e.clientX - startX);
        if (Math.abs(dx) >= 2 && left + right > 2 * MIN_PX) commit(index, left + dx, right - dx);
        else layout();
      };
      const cancel = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", cancel); handle.removeAttribute("data-dragging"); layout(); };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", cancel);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const { left, right } = sizes();
      const step = Math.max(8, (left + right) * 0.05) * (event.key === "ArrowLeft" ? -1 : 1);
      const dx = Math.max(MIN_PX - left, Math.min(step, right - MIN_PX));
      if (left + right > 2 * MIN_PX && dx !== 0) commit(index, left + dx, right - dx);
    });
    // Double-click: back to equal shares for this pair.
    handle.addEventListener("dblclick", (event) => { event.preventDefault(); commit(index, 1, 1); });
    dom.appendChild(handle);
    return handle;
  }

  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => layout()) : null;
  observer?.observe(content);
  const frame = requestAnimationFrame(layout);

  return {
    dom,
    contentDOM: content,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      const count = String(next.childCount);
      if (content.getAttribute("data-count") !== count) content.setAttribute("data-count", count);
      requestAnimationFrame(layout);
      return true;
    },
    // Our own chrome (handles, the wrapper, data-count) is not document content.
    ignoreMutation(mutation) {
      if (mutation.type === "selection") return false;
      return !content.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === content);
    },
    stopEvent(event) {
      return event.target instanceof Element && !!event.target.closest(".prism-column-resize");
    },
    destroy() {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    },
  };
};

let registered = false;
export function registerColumnsView(): void {
  if (registered || typeof document === "undefined") return;
  registered = true;
  registerBlockViews({ columns: columnsView });
}
registerColumnsView();
