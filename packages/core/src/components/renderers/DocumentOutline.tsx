import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, Link2, ListTree } from "lucide-react";
import { noteForEditor } from "../../lib/agent/documentSnapshots";
import { copyHeadingLink } from "../../lib/pages/headingLinks";
import "./DocumentOutline.css";

type Heading = { position: number; level: number; text: string };
function headingsIn(editor: Editor): Heading[] {
  const headings: Heading[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "heading") headings.push({ position, level: node.attrs.level, text: node.textContent || "Untitled heading" });
  });
  return headings;
}

/** The element that scrolls the page: the nearest scrollable ancestor of the editor. */
function scrollerOf(editor: Editor): HTMLElement | null {
  for (let node = editor.view.dom.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * NP-PG-11: the section being read = the last heading at or above the reading
 * line (a little below the top of the scroller); before the first heading, none.
 * Measured from the DOM — never a transaction, never a selection change.
 */
function currentSection(editor: Editor, headings: Heading[]): number | null {
  const scroller = scrollerOf(editor);
  const line = (scroller ? scroller.getBoundingClientRect().top : 0) + 96;
  let current: number | null = null;
  for (const heading of headings) {
    let node: Node | null = null;
    try { node = editor.view.nodeDOM(heading.position); } catch { node = null; }
    if (!(node instanceof HTMLElement)) continue;
    if (node.getBoundingClientRect().top <= line) current = heading.position;
    else break;
  }
  // At the very end of the page the last heading may never reach the line: it is still the section in view.
  if (scroller && headings.length && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 && scroller.scrollTop > 0) {
    const last = headings[headings.length - 1]!;
    let node: Node | null = null;
    try { node = editor.view.nodeDOM(last.position); } catch { node = null; }
    if (node instanceof HTMLElement && node.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom) current = last.position;
  }
  return current;
}

/** Navigation only. Opening or closing never dispatches an editor transaction. */
export function DocumentOutline({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [headings, setHeadings] = useState(() => headingsIn(editor));
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  // "Copy link to heading": available to readers too (the outline is the one heading affordance
  // a read-only page has). `copied` = the row that just answered, announced politely.
  const noteId = open ? noteForEditor(editor)?.noteId ?? null : null;
  const [copied, setCopied] = useState<{ position: number; ok: boolean } | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const copyLink = (heading: Heading) => {
    if (!noteId) return;
    let node: Node | null = null;
    try { node = editor.view.nodeDOM(heading.position); } catch { node = null; }
    void copyHeadingLink(noteId, node instanceof Element ? node : null).then((ok) => setCopied({ position: heading.position, ok }));
  };
  useEffect(() => {
    const update = () => setHeadings(headingsIn(editor));
    update();
    editor.on("update", update);
    return () => { editor.off("update", update); };
  }, [editor]);
  // The current section is tracked only while the outline is open.
  const [current, setCurrent] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const measure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setCurrent(currentSection(editor, headings))); };
    setCurrent(currentSection(editor, headings));
    // Capture: the page scroller is an ancestor of the editor, and scroll does not bubble.
    document.addEventListener("scroll", measure, { capture: true, passive: true });
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("scroll", measure, { capture: true }); window.removeEventListener("resize", measure); };
  }, [open, editor, headings]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      setOpen(false); button.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  // The outline opens in the margin beside the text column when the margin can hold it (it then
  // covers no text, breadcrumb or title); only a window too narrow for that gets the overlay.
  const [fit, setFit] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const from = root.current?.getBoundingClientRect().left;
      const column = (editor.view.dom as HTMLElement).getBoundingClientRect().left;
      const margin = from === undefined ? 0 : column - from - 16;
      setFit(margin >= 168 ? Math.min(280, Math.floor(margin)) : undefined);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, editor]);
  return <div ref={root} className="document-outline">
    <button ref={button} type="button" className="document-outline-toggle focus-ring" aria-expanded={open} aria-controls={id}
      onMouseDown={event => event.preventDefault()} onClick={() => setOpen(value => !value)}>
      <ListTree size={15} aria-hidden="true" /> Outline
    </button>
    {open && <nav id={id} aria-label="Document outline" className="document-outline-popover" data-beside={fit ? "" : undefined} style={fit ? { width: fit } : undefined}>
      <div className="document-outline-title">On this page</div>
      {headings.length ? headings.map(heading => <div key={heading.position} className="document-outline-row">
        <button type="button" id={`${id}-h${heading.position}`} className="document-outline-go focus-ring"
          aria-current={heading.position === current ? "location" : undefined}
          style={{ paddingLeft: 10 + (heading.level - 1) * 12 }}
          onMouseDown={event => event.preventDefault()} onClick={() => {
            // Use this editor's current heading DOM; never change content or cursor.
            const node = editor.view.nodeDOM(heading.position);
            if (node instanceof HTMLElement) node.scrollIntoView({ block: "start", behavior: "auto" });
            setOpen(false);
            button.current?.focus({ preventScroll: true });
          }}>{heading.text}</button>
        {noteId && heading.text.trim() && heading.text !== "Untitled heading" && <button type="button" className="document-outline-link focus-ring"
          aria-label="Copy link to heading" aria-describedby={`${id}-h${heading.position}`} title="Copy link to heading"
          onMouseDown={event => event.preventDefault()} onClick={() => copyLink(heading)}>
          {copied?.position === heading.position && copied.ok ? <Check size={13} aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}
        </button>}
      </div>) : <p>Add headings to navigate this page.</p>}
      <span className="sr-only" aria-live="polite">{copied ? (copied.ok ? "Copied link to heading" : "Couldn’t copy the link") : ""}</span>
    </nav>}
  </div>;
}
