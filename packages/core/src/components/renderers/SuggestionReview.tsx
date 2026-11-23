import { useEffect, useRef, useState } from "react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { ChevronLeft, ChevronRight, Check, RefreshCw, X } from "lucide-react";
import "./suggestion-review.css";
import { useEditorState, type Editor } from "@tiptap/react";
import type { Node, Mark } from "@tiptap/pm/model";
import { isAgentAuthor } from "../../lib/collab/colors";
import { nodeSuggestionOf } from "../../editor/suggestionNodes";

type Change = { key: string; from: number; to: number; author: string; before: string; after: string; turn: boolean; /** A suggested paragraph / line break: the position of its node. */ node?: number };

/** Pair identified replacements; keep legacy runs separate instead of inventing provenance. */
function changesIn(doc: Node): Change[] {
  const changes = new Map<string, Change>();
  let previous: { mark: Mark; key: string; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) {
      // A suggested paragraph break / line break is a change of its own (it holds no text to pair with).
      const structure = nodeSuggestionOf(node);
      if (structure) {
        const what = node.isTextblock ? "Paragraph break" : node.type.name === "hardBreak" ? "Line break" : `@${node.attrs.label || node.attrs.date || "mention"}`;
        const key = JSON.stringify(["node", pos, structure.kind, structure.by]);
        changes.set(key, { key, from: node.isTextblock ? pos + 1 : pos, to: pos + node.nodeSize, author: structure.by || "Unknown collaborator", before: structure.kind === "delete" ? what : "", after: structure.kind === "insert" ? what : "", turn: isAgentAuthor(structure.by), node: pos });
      }
      return;
    }
    const mark = node.marks.find((m) => m.type.name === "insertion" || m.type.name === "deletion");
    if (!mark) { previous = null; return; }
    const identity = mark.attrs.suggestionId;
    const key = identity
      ? JSON.stringify([identity, mark.attrs.actorId, mark.attrs.user])
      : previous?.to === pos && previous.mark.eq(mark) ? previous.key : JSON.stringify([pos, mark.toJSON()]);
    const change = changes.get(key) ?? { key, from: pos, to: pos, author: mark.attrs.user || "Unknown collaborator", before: "", after: "", turn: !!mark.attrs.turnId || isAgentAuthor(mark.attrs.user) };
    if (mark.type.name === "deletion") change.before += node.text;
    else change.after += node.text;
    change.to = pos + node.nodeSize;
    changes.set(key, change);
    previous = { mark, key, to: change.to };
  });
  return [...changes.values()];
}

/** Resolve the current live range when acting; remote edits never freeze positions. */
/** The identity of the suggestion a mark belongs to (null: a run typed in Suggesting mode has none). */
export function suggestionIdentity(mark: Mark | null | undefined): string | null {
  return mark?.attrs.suggestionId ? JSON.stringify([mark.attrs.suggestionId, mark.attrs.actorId, mark.attrs.user]) : null;
}

export function SuggestionReview({ editor, canReview, onStale }: { editor: Editor; canReview: boolean; /** The change that "Needs refresh" (its identity), or null — so other accept controls withhold too. */ onStale?: (key: string | null) => void }) {
  const changes = useEditorState({ editor, selector: ({ editor: current }) => changesIn(current.state.doc) });
  const [cursor, setCursor] = useState<{ key: string; index: number } | null>(null);
  const [notice, setNotice] = useState("");
  const review = useRef<HTMLDetailsElement>(null);
  const complete = useRef<HTMLParagraphElement>(null);
  const found = cursor ? changes.findIndex(change => change.key === cursor.key) : 0;
  const index = found >= 0 ? found : Math.min(cursor?.index ?? 0, changes.length - 1);
  const change = changes[index];

  // NP-CO-12 / NP-AI-02 "Needs refresh": the change on screen was EDITED BY SOMEONE ELSE after
  // the reviewer was shown it (its words differ now and a collaborator's transaction arrived in
  // between). Accept is withheld until they look again (Refresh) — nobody accepts words they
  // have not read. The reviewer's own edits inside a suggestion never raise it. Only a change
  // with an identity can be followed (an agent's, a suggest-only person's); a run typed in
  // Suggesting mode has none, and a change that is gone is the "already reviewed" notice below.
  const shown = useRef<{ key: string; before: string; after: string } | null>(null);
  if (!change) shown.current = null;
  else if (shown.current?.key !== change.key) shown.current = { key: change.key, before: change.before, after: change.after };
  const [staleKey, setStaleKey] = useState<string | null>(null);
  useEffect(() => {
    const on = ({ editor: current, transaction }: { editor: Editor; transaction: { docChanged: boolean; getMeta(key: unknown): unknown } }) => {
      const seen = shown.current;
      if (!transaction.docChanged || !seen) return;
      const now = changesIn(current.state.doc).find((item) => item.key === seen.key);
      if (!now || (now.before === seen.before && now.after === seen.after)) return;
      // A collaborator's (or an agent's) edit arrives through Yjs; the reviewer's own does not.
      // (Only while the queue is open — a closed queue has shown nobody anything.)
      // The reviewer's OWN undo / redo also arrives through Yjs: that is theirs, not someone else's.
      const sync = transaction.getMeta(ySyncPluginKey) as { isUndoRedoOperation?: boolean } | undefined;
      if (sync && !sync.isUndoRedoOperation && review.current?.open) setStaleKey(seen.key);
      else shown.current = { key: seen.key, before: now.before, after: now.after };
    };
    editor.on("transaction", on);
    return () => { editor.off("transaction", on); };
  }, [editor]);
  const stale = !!change && staleKey === change.key;
  useEffect(() => { onStale?.(stale ? staleKey : null); }, [stale, staleKey, onStale]);
  const refresh = () => {
    if (change) shown.current = { key: change.key, before: change.before, after: change.after };
    setStaleKey(null);
    setNotice("");
  };

  function choose(nextIndex: number) {
    const next = changes[nextIndex];
    if (next) { setCursor({ key: next.key, index: nextIndex }); setNotice(""); }
  }
  function act(key: string, action: "show" | "accept" | "reject") {
    if (editor.isDestroyed) return;
    const current = changesIn(editor.state.doc).find(item => item.key === key);
    if (!current) { setNotice("This change has already been reviewed or changed."); return; }
    if (action !== "show" && !canReview) return;
    if (action === "accept" && stale) return;
    const command = editor.chain().focus().setTextSelection(current.from);
    const applied = action === "show" ? command.scrollIntoView().run() : action === "accept" ? command.acceptSuggestion(current.node).run() : command.rejectSuggestion(current.node).run();
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
  function bulk(action: "accept" | "reject") {
    if (editor.isDestroyed || !canReview) return;
    const total = changes.length;
    const applied = action === "accept" ? editor.chain().focus().acceptAllSuggestions().run() : editor.chain().focus().rejectAllSuggestions().run();
    setCursor(null);
    setNotice(applied ? `${action === "accept" ? "Accepted" : "Rejected"} ${total} suggested ${total === 1 ? "change" : "changes"}.` : "These changes could not be reviewed. Check the current document and try again.");
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
        <header className="prism-review-author"><strong>{change.author}</strong>{change.turn && <span>Agent suggestion</span>}{stale && <span className="prism-review-stale">Needs refresh</span>}</header>
        {stale && <p role="status" className="prism-review-hint">This change was edited after you opened it. Refresh to read it as it is now.</p>}
        <div className="prism-review-diff">
          {change.before && <div className="prism-review-before"><span>Remove</span><p>{change.before}</p></div>}
          {change.after && <div className="prism-review-after"><span>Insert</span><p>{change.after}</p></div>}
        </div>
        <div className="prism-review-actions">
          <button data-review-show className="focus-ring" onClick={() => act(change.key, "show")}>Show in document</button>
          {stale && <button className="focus-ring" onClick={refresh}><RefreshCw size={15} aria-hidden="true" />Refresh</button>}
          {canReview && <><button className="focus-ring" onClick={() => act(change.key, "reject")}><X size={15} aria-hidden="true" />Reject</button>{!stale && <button className="focus-ring prism-review-accept" onClick={() => act(change.key, "accept")}><Check size={15} aria-hidden="true" />Accept</button>}</>}
        </div>
      </section>
      {/* Phone: "accept / reject all" live here, not in the page's chrome row — so they exist only
          while there is something to review (CSS shows this group ≤ 767 px; the row keeps them on desktop). */}
      {canReview && <div className="prism-review-bulk" role="group" aria-label="All suggested changes">
        <button className="focus-ring" aria-label="Reject all suggestions" onClick={() => bulk("reject")}><X size={15} aria-hidden="true" />Reject all</button>
        <button className="focus-ring" aria-label="Accept all suggestions" onClick={() => bulk("accept")}><Check size={15} aria-hidden="true" />Accept all</button>
      </div>}
      {notice && <p role="status" className="prism-review-hint">{notice}</p>}
    </div>
  </details>;
}
