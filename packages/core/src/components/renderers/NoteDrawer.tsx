import { useMemo, useState } from "react";
import { Filter, X } from "lucide-react";
import { useNotes, useTags } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { Note } from "../../lib/types";

/**
 * Searchable / tag-filtered sidebar for picking vault notes to embed as cards on
 * the canvas. Talks to the vault through the `useNotes`/`useTags` hooks (the
 * VaultClient seam), so it works unchanged in both the desktop and web shells.
 * Shared by `CanvasRenderer` (offline) and `CollabCanvas` (collaborative).
 */
export function NoteDrawer({
  onAddNote,
  canvasNoteIds,
}: {
  onAddNote: (note: Note) => void;
  canvasNoteIds: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { data: allNotes } = useNotes();
  const { data: allTags } = useTags();
  const openTab = useUIStore((s) => s.openTab);

  const filtered = useMemo(() => {
    let notes = allNotes || [];
    if (selectedTag) notes = notes.filter((n) => n.tags?.includes(selectedTag));
    if (query) {
      const q = query.toLowerCase();
      notes = notes.filter((n) => (n.path?.split("/").pop()?.toLowerCase() || "").includes(q));
    }
    return notes.slice(0, 50);
  }, [allNotes, selectedTag, query]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addSelected = () => {
    for (const n of filtered) {
      if (selectedIds.has(n.id)) onAddNote(n);
    }
    setSelectedIds(new Set());
  };

  return (
    <div className="flex flex-col h-full" style={{ width: 260, borderRight: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
      <div className="p-2 space-y-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes..."
          className="w-full h-7 rounded-md px-2 text-xs outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />
        <div className="flex items-center gap-1 flex-wrap">
          <Filter size={11} style={{ color: "var(--text-muted)" }} />
          {selectedTag ? (
            <button onClick={() => setSelectedTag(null)} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]" style={{ background: "var(--color-accent)", color: "white" }}>
              {selectedTag} <X size={9} />
            </button>
          ) : (
            <select value="" onChange={(e) => setSelectedTag(e.target.value || null)} className="h-5 rounded px-1 text-[10px] outline-none cursor-pointer" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }}>
              <option value="">All tags</option>
              {(allTags || []).map((t) => (
                <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="px-2 pb-1">
          <button onClick={addSelected} className="w-full py-1 rounded-md text-xs font-medium" style={{ background: "var(--color-accent)", color: "white" }}>
            Add {selectedIds.size} to canvas
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto px-1">
        {filtered.map((n) => {
          const onCanvas = canvasNoteIds.has(n.id);
          const isSelected = selectedIds.has(n.id);
          const tags = n.tags || [];
          const title = n.path?.split("/").pop() || "Untitled";

          return (
            <div key={n.id} className="flex items-start gap-1.5 px-2 py-1.5 rounded-md transition-colors hover:bg-[var(--glass-hover)]" style={{ opacity: onCanvas ? 0.5 : 1 }}>
              <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(n.id)} disabled={onCanvas} className="mt-0.5 cursor-pointer" />
              <button
                onClick={() => onAddNote(n)}
                onDoubleClick={() => openTab(n.id, title, inferContentType(n))}
                disabled={onCanvas}
                className="flex-1 text-left min-w-0"
              >
                <div className="text-xs truncate" style={{ color: "var(--text-primary)" }}>{title}</div>
                {tags.length > 0 && (
                  <div className="flex gap-1 mt-0.5 flex-wrap">
                    {tags.slice(0, 3).map((t) => (
                      <span key={t} className="text-[9px] px-1 rounded" style={{ background: "var(--glass)", color: "var(--text-muted)" }}>{t}</span>
                    ))}
                  </div>
                )}
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="text-xs py-4 text-center" style={{ color: "var(--text-muted)" }}>No notes found</div>}
      </div>
    </div>
  );
}
