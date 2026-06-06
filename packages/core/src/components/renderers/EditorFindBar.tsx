import { useEffect, useRef, useState } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import type { useEditor } from "@tiptap/react";
import { searchHighlightKey } from "../../lib/tiptap/SearchHighlight";

interface EditorFindBarProps {
  editor: ReturnType<typeof useEditor>;
  onClose: () => void;
}

/**
 * Floating in-note find bar. Dispatches search-plugin meta transactions
 * (no doc mutations) so auto-save is not triggered by typing in the input.
 */
export function EditorFindBar({ editor, onClose }: EditorFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  // Focus input when bar mounts
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Clear plugin state on unmount
  useEffect(() => {
    return () => {
      if (!editor) return;
      const { tr } = editor.state;
      editor.view.dispatch(tr.setMeta(searchHighlightKey, { clear: true }));
    };
  }, [editor]);

  // Push query to plugin whenever it changes
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    editor.view.dispatch(tr.setMeta(searchHighlightKey, { query, activeIndex: 0 }));
    // Read back plugin state to update UI counters
    const pluginState = searchHighlightKey.getState(editor.state);
    // Plugin state update is async relative to dispatch; read on next microtask
    queueMicrotask(() => {
      const ps = searchHighlightKey.getState(editor.state);
      const count = ps?.matches.length ?? 0;
      setMatchCount(count);
      setActiveIndex(ps?.activeIndex ?? 0);
      if (count > 0 && ps) {
        scrollActiveIntoView(editor, ps.matches[ps.activeIndex]);
      }
    });
    void pluginState;
  }, [query, editor]);

  const goToMatch = (direction: 1 | -1) => {
    if (!editor || matchCount === 0) return;
    const next = (activeIndex + direction + matchCount) % matchCount;
    const { tr } = editor.state;
    editor.view.dispatch(tr.setMeta(searchHighlightKey, { activeIndex: next }));
    setActiveIndex(next);
    const ps = searchHighlightKey.getState(editor.state);
    if (ps) scrollActiveIntoView(editor, ps.matches[next]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
  };

  return (
    <div
      className="absolute top-2 right-4 z-40 glass-elevated rounded-lg shadow-xl flex items-center gap-1 px-2 py-1.5"
      style={{
        border: "1px solid var(--glass-border)",
        minWidth: 280,
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in note..."
        className="flex-1 h-7 rounded px-2 text-sm outline-none"
        style={{
          background: "var(--glass)",
          border: "1px solid var(--glass-border)",
          color: "var(--text-primary)",
        }}
      />
      <span
        className="text-xs whitespace-nowrap px-1 tabular-nums"
        style={{ color: "var(--text-muted)", minWidth: 48, textAlign: "right" }}
      >
        {query ? (matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : "0 / 0") : ""}
      </span>
      <button
        onClick={() => goToMatch(-1)}
        disabled={matchCount === 0}
        className="p-1 rounded hover:bg-[var(--glass-hover)] disabled:opacity-40"
        style={{ color: "var(--text-secondary)" }}
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </button>
      <button
        onClick={() => goToMatch(1)}
        disabled={matchCount === 0}
        className="p-1 rounded hover:bg-[var(--glass-hover)] disabled:opacity-40"
        style={{ color: "var(--text-secondary)" }}
        title="Next match (Enter)"
      >
        <ChevronDown size={14} />
      </button>
      <button
        onClick={onClose}
        className="p-1 rounded hover:bg-[var(--glass-hover)]"
        style={{ color: "var(--text-muted)" }}
        title="Close (Esc)"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function scrollActiveIntoView(
  editor: ReturnType<typeof useEditor>,
  match: { from: number; to: number } | undefined,
) {
  if (!editor || !match) return;
  try {
    const coords = editor.view.coordsAtPos(match.from);
    // Walk up from the DOM position to find a scrollable ancestor and scroll it.
    const domAt = editor.view.domAtPos(match.from);
    const node = domAt.node instanceof Element ? domAt.node : domAt.node.parentElement;
    if (node && "scrollIntoView" in node) {
      (node as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
    }
    void coords;
  } catch {
    // ignore — coordsAtPos can throw if the doc was just replaced
  }
}
