import { useEffect, useRef, useState } from "react";
import { X, ChevronUp, ChevronDown, ChevronRight } from "lucide-react";
import type { useEditor } from "@tiptap/react";
import { searchHighlightKey, replaceMatch, replaceAllMatches } from "../../lib/tiptap/SearchHighlight";
import { structuralEditsAllowed } from "../../lib/tiptap/blockCommands";

interface EditorFindBarProps {
  editor: ReturnType<typeof useEditor>;
  onClose: () => void;
  /** Open with the replace row expanded (⌘⇧H). */
  replaceOpen?: boolean;
}

/**
 * In-note find and replace (⌘F / ⌘⇧H). Searching dispatches meta-only
 * transactions (no doc change, so no autosave). Replace / Replace all each
 * dispatch ONE transaction — one undo step, in the plain editor and in a live
 * collaborative document alike. Replace is offered only where a raw edit is
 * allowed: never read-only, suggesting (tracked changes) or comment-only.
 */
export function EditorFindBar({ editor, onClose, replaceOpen = false }: EditorFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(replaceOpen);
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [notice, setNotice] = useState("");
  const [, force] = useState(0);
  const canReplace = !!editor && structuralEditsAllowed(editor);

  useEffect(() => { if (replaceOpen) setShowReplace(true); }, [replaceOpen]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Track editability changes (read-only flips, suggest mode) and live edits.
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const ps = searchHighlightKey.getState(editor.state);
      setMatchCount(ps?.matches.length ?? 0);
      setActiveIndex(ps?.activeIndex ?? 0);
      force((n) => n + 1);
    };
    editor.on("transaction", sync);
    return () => { editor.off("transaction", sync); };
  }, [editor]);

  useEffect(() => {
    return () => {
      if (!editor || editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, { clear: true }));
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, { query, activeIndex: 0 }));
    const ps = searchHighlightKey.getState(editor.state);
    const count = ps?.matches.length ?? 0;
    setMatchCount(count);
    setActiveIndex(ps?.activeIndex ?? 0);
    setNotice("");
    if (count > 0 && ps) scrollActiveIntoView(editor, ps.matches[ps.activeIndex]);
  }, [query, editor]);

  const goToMatch = (direction: 1 | -1) => {
    if (!editor || matchCount === 0) return;
    const next = (activeIndex + direction + matchCount) % matchCount;
    editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, { activeIndex: next }));
    setActiveIndex(next);
    const ps = searchHighlightKey.getState(editor.state);
    if (ps) scrollActiveIntoView(editor, ps.matches[next]);
  };

  const replaceOne = () => {
    if (!editor || !canReplace || !matchCount) return;
    replaceMatch(editor, activeIndex, replacement);
    const ps = searchHighlightKey.getState(editor.state);
    if (ps?.matches.length) scrollActiveIntoView(editor, ps.matches[Math.min(activeIndex, ps.matches.length - 1)]);
    setNotice(ps?.matches.length ? "" : "All matches replaced");
  };
  const replaceAll = () => {
    if (!editor || !canReplace || !matchCount) return;
    const n = replaceAllMatches(editor, replacement);
    setNotice(`Replaced ${n} ${n === 1 ? "match" : "matches"}`);
  };

  const onFindKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); goToMatch(e.shiftKey ? -1 : 1); return; }
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "h") { e.preventDefault(); setShowReplace(true); requestAnimationFrame(() => replaceRef.current?.focus()); }
  };
  const onReplaceKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); if (e.metaKey || e.ctrlKey || e.altKey) replaceAll(); else replaceOne(); return; }
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  const iconBtn = "p-1 rounded hover:bg-[var(--glass-hover)] disabled:opacity-40 focus-ring";
  return (
    <div className="prism-find-bar glass-elevated" role="search" aria-label="Find in note">
      <div className="prism-find-row">
        {canReplace && (
          <button
            type="button"
            onClick={() => setShowReplace((v) => !v)}
            className={iconBtn}
            aria-expanded={showReplace}
            aria-label={showReplace ? "Hide replace" : "Show replace"}
            title="Replace (⌘⇧H)"
            style={{ color: "var(--text-muted)" }}
          >
            <ChevronRight size={14} style={{ transform: showReplace ? "rotate(90deg)" : undefined, transition: "transform 120ms" }} />
          </button>
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFindKey}
          placeholder="Find in note…"
          aria-label="Find in note"
          className="prism-find-input"
        />
        <span className="prism-find-count" aria-live="polite">
          {query ? (matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : "0 / 0") : ""}
        </span>
        <button type="button" onClick={() => goToMatch(-1)} disabled={matchCount === 0} className={iconBtn} style={{ color: "var(--text-secondary)" }} title="Previous match (Shift+Enter)" aria-label="Previous match">
          <ChevronUp size={14} />
        </button>
        <button type="button" onClick={() => goToMatch(1)} disabled={matchCount === 0} className={iconBtn} style={{ color: "var(--text-secondary)" }} title="Next match (Enter)" aria-label="Next match">
          <ChevronDown size={14} />
        </button>
        <button type="button" onClick={onClose} className={iconBtn} style={{ color: "var(--text-muted)" }} title="Close (Esc)" aria-label="Close find">
          <X size={14} />
        </button>
      </div>
      {canReplace && showReplace && (
        <div className="prism-find-row">
          <span style={{ width: 22 }} aria-hidden="true" />
          <input
            ref={replaceRef}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={onReplaceKey}
            placeholder="Replace with…"
            aria-label="Replace with"
            className="prism-find-input"
          />
          <button type="button" className="prism-find-action focus-ring" onClick={replaceOne} disabled={!matchCount}>Replace</button>
          <button type="button" className="prism-find-action focus-ring" onClick={replaceAll} disabled={!matchCount}>Replace all</button>
        </div>
      )}
      {notice && <p className="prism-find-notice" role="status">{notice}</p>}
    </div>
  );
}

function scrollActiveIntoView(
  editor: ReturnType<typeof useEditor>,
  match: { from: number; to: number } | undefined,
) {
  if (!editor || !match) return;
  try {
    const domAt = editor.view.domAtPos(match.from);
    const node = domAt.node instanceof Element ? domAt.node : domAt.node.parentElement;
    if (node && "scrollIntoView" in node) {
      (node as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
    }
  } catch {
    // ignore — the doc was just replaced
  }
}
