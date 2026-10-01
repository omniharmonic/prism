import { useState } from "react";
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

/** Read current positions at click time, so remote edits cannot leave stale review ranges. */
export function SuggestionReview({ editor, canReview }: { editor: Editor; canReview: boolean }) {
  const changes = useEditorState({ editor, selector: ({ editor: current }) => changesIn(current.state.doc) });
  const [notice, setNotice] = useState("");
  function act(key: string, action: "show" | "accept" | "reject") {
    if (editor.isDestroyed) return;
    const current = changesIn(editor.state.doc).find((change) => change.key === key);
    if (!current) { setNotice("This change has already been reviewed or changed."); return; }
    if (action !== "show" && !canReview) return;
    const command = editor.chain().focus().setTextSelection(current.from);
    const applied = action === "show" ? command.scrollIntoView().run() : action === "accept" ? command.acceptSuggestion().run() : command.rejectSuggestion().run();
    setNotice(action === "show" ? "" : applied ? `${action === "accept" ? "Accepted" : "Rejected"} change by ${current.author}.` : "This change could not be reviewed. Check the current document and try again.");
  }
  if (!changes.length) return notice ? <p role="status" className="mb-3 text-xs" style={{ color: "var(--text-secondary)" }}>{notice}</p> : null;
  return <details className="mb-4 rounded-xl border text-sm" style={{ borderColor: "var(--glass-border)", background: "var(--bg-surface)" }}>
    <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 font-medium">{changes.length} suggested {changes.length === 1 ? "change" : "changes"}</summary>
    <div className="max-h-80 space-y-3 overflow-y-auto px-3 pb-3">
      {!canReview && <p className="px-1 text-xs" style={{ color: "var(--text-muted)" }}>You can inspect changes. A collaborator with edit access can accept or reject them.</p>}
      {changes.map((change) => <section key={change.key} aria-label={`Change by ${change.author}`} className="rounded-lg border p-3" style={{ borderColor: "var(--glass-border)" }}>
        <div className="mb-2 flex flex-wrap items-center gap-2"><span className="font-medium break-words">{change.author}</span>{change.turn && <span className="text-xs" style={{ color: "var(--text-muted)" }}>Agent suggestion</span>}</div>
        {change.before && <div className="mb-2"><span className="text-xs" style={{ color: "var(--text-muted)" }}>Remove</span><p className="whitespace-pre-wrap break-words line-through [overflow-wrap:anywhere]">{change.before}</p></div>}
        {change.after && <div className="mb-2"><span className="text-xs" style={{ color: "var(--text-muted)" }}>Insert</span><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{change.after}</p></div>}
        <div className="flex flex-wrap gap-2">
          <button className="interactive focus-ring rounded-lg px-3 py-2" onClick={() => act(change.key, "show")}>Show in document</button>
          {canReview && <><button className="interactive focus-ring rounded-lg px-3 py-2" onClick={() => act(change.key, "accept")}>Accept</button><button className="interactive focus-ring rounded-lg px-3 py-2" onClick={() => act(change.key, "reject")}>Reject</button></>}
        </div>
      </section>)}
      {notice && <p role="status" className="px-1 text-xs">{notice}</p>}
    </div>
  </details>;
}
