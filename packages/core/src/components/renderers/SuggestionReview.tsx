import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Check, X } from "lucide-react";
import "./suggestion-review.css";
import { useEditorState, type Editor } from "@tiptap/react";
import type { Node, Mark } from "@tiptap/pm/model";

type Change = { key: string; from: number; to: number; author: string; before: string; after: string; turn: boolean };

/** Pair identified replacements; keep legacy runs separate instead of inventing provenance. */
function changesIn(doc: Node): Change[] {
  const changes = new Map<string, Change>();
  let previous: { mark: Mark; key: string; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "insertion" || m.type.name === "deletion");
    if (!mark) { previous = null; return; }
    const identity = mark.attrs.suggestionId;
    const key = identity
      ? JSON.stringify([identity, mark.attrs.actorId, mark.attrs.user])
      : previous?.to === pos && previous.mark.eq(mark) ? previous.key : JSON.stringify([pos, mark.toJSON()]);
    const change = changes.get(key) ?? { key, from: pos, to: pos, author: mark.attrs.user || "Unknown collaborator", before: "", after: "", turn: !!mark.attrs.turnId };
    if (mark.type.name === "deletion") change.before += node.text;
    else change.after += node.text;
    change.to = pos + node.nodeSize;
    changes.set(key, change);
    previous = { mark, key, to: change.to };
  });
  return [...changes.values()];
}

/** Resolve the current live range when acting; remote edits never freeze positions. */
export function SuggestionReview({ editor, canReview }: { editor: Editor; canReview: boolean }) {
  const changes = useEditorState({ editor, selector: ({ editor: current }) => changesIn(current.state.doc) });
  const [cursor, setCursor] = useState<{ key: string; index: number } | null>(null);
  const [notice, setNotice] = useState("");
  const review = useRef<HTMLDetailsElement>(null);
  const complete = useRef<HTMLParagraphElement>(null);
  const found = cursor ? changes.findIndex(change => change.key === cursor.key) : 0;
  const index = found >= 0 ? found : Math.min(cursor?.index ?? 0, changes.length - 1);
  const change = changes[index];

  function choose(nextIndex: number) {
    const next = changes[nextIndex];
    if (next) { setCursor({ key: next.key, index: nextIndex }); setNotice(""); }
  }
  function act(key: string, action: "show" | "accept" | "reject") {
    if (editor.isDestroyed) return;
    const current = changesIn(editor.state.doc).find(item => item.key === key);
    if (!current) { setNotice("This change has already been reviewed or changed."); return; }
    if (action !== "show" && !canReview) return;
    const command = editor.chain().focus().setTextSelection(current.from);
    const applied = action === "show" ? command.scrollIntoView().run() : action === "accept" ? command.acceptSuggestion().run() : command.rejectSuggestion().run();
    if (action === "show") { setNotice(""); return; }
    setNotice(applied ? `${action === "accept" ? "Accepted" : "Rejected"} change by ${current.author}.` : "This change could not be reviewed. Check the current document and try again.");
    if (applied) {
      const remaining = changesIn(editor.state.doc);
      const nextIndex = Math.min(index, remaining.length - 1);
      const next = remaining[nextIndex];
      setCursor(next ? { key: next.key, index: nextIndex } : null);
      // Keep keyboard review in the queue rather than dropping into the body.
      requestAnimationFrame(() => {
        const target = review.current?.querySelector<HTMLButtonElement>('[data-review-show]') ?? complete.current;
        target?.focus({ preventScroll: true });
      });
    }
  }
  if (!change) return notice ? <p ref={complete} tabIndex={-1} role="status" className="prism-review-complete">{notice} No suggested changes remain.</p> : null;
  return <details ref={review} className="prism-suggestion-review">
    <summary className="focus-ring">{changes.length} suggested {changes.length === 1 ? "change" : "changes"}</summary>
    <div className="prism-review-body">
      <nav aria-label="Suggested changes" className="prism-review-navigation">
        <span aria-live="polite">Change {index + 1} of {changes.length}</span>
        <div>
          <button className="focus-ring" aria-label="Previous suggested change" disabled={index <= 0} onClick={() => choose(index - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
          <button className="focus-ring" aria-label="Next suggested change" disabled={index >= changes.length - 1} onClick={() => choose(index + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
        </div>
      </nav>
      {!canReview && <p className="prism-review-hint">You can inspect changes. A collaborator with edit access can accept or reject them.</p>}
      <section aria-label={`Change by ${change.author}`}>
        <header className="prism-review-author"><strong>{change.author}</strong>{change.turn && <span>Agent suggestion</span>}</header>
        <div className="prism-review-diff">
          {change.before && <div className="prism-review-before"><span>Remove</span><p>{change.before}</p></div>}
          {change.after && <div className="prism-review-after"><span>Insert</span><p>{change.after}</p></div>}
        </div>
        <div className="prism-review-actions">
          <button data-review-show className="focus-ring" onClick={() => act(change.key, "show")}>Show in document</button>
          {canReview && <><button className="focus-ring" onClick={() => act(change.key, "reject")}><X size={15} aria-hidden="true" />Reject</button><button className="focus-ring prism-review-accept" onClick={() => act(change.key, "accept")}><Check size={15} aria-hidden="true" />Accept</button></>}
        </div>
      </section>
      {notice && <p role="status" className="prism-review-hint">{notice}</p>}
    </div>
  </details>;
}
