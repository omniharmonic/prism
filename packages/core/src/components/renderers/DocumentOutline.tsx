import { useEffect, useId, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ListTree } from "lucide-react";
import "./DocumentOutline.css";

type Heading = { position: number; level: number; text: string };
function headingsIn(editor: Editor): Heading[] {
  const headings: Heading[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "heading") headings.push({ position, level: node.attrs.level, text: node.textContent || "Untitled heading" });
  });
  return headings;
}

/** Navigation only. Opening or closing never dispatches an editor transaction. */
export function DocumentOutline({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [headings, setHeadings] = useState(() => headingsIn(editor));
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const update = () => setHeadings(headingsIn(editor));
    update();
    editor.on("update", update);
    return () => { editor.off("update", update); };
  }, [editor]);
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
  return <div ref={root} className="document-outline">
    <button ref={button} type="button" className="document-outline-toggle focus-ring" aria-expanded={open} aria-controls={id}
      onMouseDown={event => event.preventDefault()} onClick={() => setOpen(value => !value)}>
      <ListTree size={15} aria-hidden="true" /> Outline
    </button>
    {open && <nav id={id} aria-label="Document outline" className="document-outline-popover">
      <div className="document-outline-title">On this page</div>
      {headings.length ? headings.map(heading => <button key={heading.position} type="button" className="focus-ring"
        style={{ paddingLeft: 10 + (heading.level - 1) * 12 }}
        onMouseDown={event => event.preventDefault()} onClick={() => {
          // Use this editor's current heading DOM; never change content or cursor.
          const node = editor.view.nodeDOM(heading.position);
          if (node instanceof HTMLElement) node.scrollIntoView({ block: "start", behavior: "auto" });
          setOpen(false);
          button.current?.focus({ preventScroll: true });
        }}>{heading.text}</button>) : <p>Add headings to navigate this page.</p>}
    </nav>}
  </div>;
}
