import { useCallback, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { Search } from "lucide-react";

// Excalidraw types are not reliably importable from deep paths — use loose types
type ExcalidrawAPI = {
  getSceneElements: () => readonly any[];
  updateScene: (scene: { elements: readonly any[] }) => void;
};
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { useSettingsStore } from "../../app/stores/settings";
import { useNotes } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { Note } from "../../lib/types";

/** Parse stored canvas content — returns Excalidraw elements or empty array */
function parseCanvasData(content: string): { elements: readonly any[]; appState?: Record<string, any>; files?: Record<string, any> } {
  if (!content || content.trim() === "" || content.trim() === " ") {
    return { elements: [] };
  }
  try {
    const data = JSON.parse(content);
    return {
      elements: data.elements || [],
      appState: data.appState || undefined,
      files: data.files || undefined,
    };
  } catch {
    return { elements: [] };
  }
}

export default function CanvasRenderer({ note }: RendererProps) {
  const theme = useSettingsStore((s) => s.theme);
  const contentRef = useRef(note.content || "");
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const [showNotePicker, setShowNotePicker] = useState(false);

  const getContent = useCallback(() => contentRef.current, []);
  const { isSaving, lastSaved, scheduleSave } = useAutoSave(note.id, getContent);
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  const initialData = parseCanvasData(note.content);

  const handleChange = useCallback((elements: readonly any[], appState: any, files: any) => {
    const serialized = JSON.stringify({
      elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
        gridStep: appState.gridStep,
        zoom: appState.zoom,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
      },
      files,
    });
    contentRef.current = serialized;
    scheduleSaveRef.current();
  }, []);

  const handleAddNoteCard = useCallback((noteToAdd: Note) => {
    const api = apiRef.current;
    if (!api) return;

    const title = noteToAdd.path?.split("/").pop() || "Untitled";
    const elements = api.getSceneElements();

    // Place new card slightly offset from center
    const x = 100 + (elements.length % 5) * 220;
    const y = 100 + Math.floor(elements.length / 5) * 150;

    // Create a text element representing the note card
    const newElement = {
      type: "rectangle" as const,
      x,
      y,
      width: 200,
      height: 80,
      strokeColor: "#1e1e1e",
      backgroundColor: "#e9ecef",
      fillStyle: "solid" as const,
      strokeWidth: 1,
      roundness: { type: 3, value: 8 },
      id: `note-${noteToAdd.id}-${Date.now()}`,
      customData: { prismNoteId: noteToAdd.id, prismNotePath: noteToAdd.path },
    };

    const labelElement = {
      type: "text" as const,
      x: x + 12,
      y: y + 12,
      width: 176,
      height: 56,
      text: title,
      fontSize: 14,
      fontFamily: 1,
      textAlign: "left" as const,
      verticalAlign: "top" as const,
      strokeColor: "#1e1e1e",
      id: `label-${noteToAdd.id}-${Date.now()}`,
      containerId: newElement.id,
      customData: { prismNoteId: noteToAdd.id },
    };

    api.updateScene({
      elements: [...elements, newElement as any, labelElement as any],
    });

    setShowNotePicker(false);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-4 py-1.5 text-xs flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: "var(--text-secondary)" }}>
            {note.path?.split("/").pop() || "Canvas"}
          </span>
          <button
            onClick={() => setShowNotePicker(!showNotePicker)}
            className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-secondary)" }}
          >
            <Search size={12} />
            Add note
          </button>
        </div>
        <span style={{ color: "var(--text-muted)" }}>
          {isSaving ? "Saving..." : lastSaved ? `Saved ${lastSaved.toLocaleTimeString()}` : ""}
        </span>
      </div>

      {/* Note picker dropdown */}
      {showNotePicker && (
        <NotePicker
          onSelect={handleAddNoteCard}
          onClose={() => setShowNotePicker(false)}
        />
      )}

      {/* Excalidraw canvas — explicit dimensions + style isolation */}
      <div
        className="flex-1 min-h-0 relative"
        style={{ width: "100%", height: "100%", overflow: "hidden" }}
      >
        <Excalidraw
          excalidrawAPI={(api) => { apiRef.current = api; }}
          initialData={{
            elements: initialData.elements as any,
            appState: { ...initialData.appState, theme: theme === "dark" ? "dark" : "light" } as any,
            files: initialData.files,
          }}
          onChange={handleChange as any}
          theme={theme === "dark" ? "dark" : "light"}
        />
      </div>
    </div>
  );
}

/** Searchable note picker for adding notes to canvas */
function NotePicker({ onSelect, onClose }: { onSelect: (note: Note) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const { data: allNotes } = useNotes();
  const openTab = useUIStore((s) => s.openTab);

  const filtered = (allNotes || [])
    .filter((n) => {
      const name = n.path?.split("/").pop()?.toLowerCase() || "";
      return name.includes(query.toLowerCase());
    })
    .slice(0, 8);

  return (
    <div
      className="px-4 py-2"
      style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search notes to place on canvas..."
        autoFocus
        className="w-full h-7 rounded-md px-2 text-xs outline-none mb-1"
        style={{
          background: "var(--glass)",
          border: "1px solid var(--glass-border)",
          color: "var(--text-primary)",
        }}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      />
      {query.length > 0 && (
        <div className="max-h-40 overflow-auto space-y-0.5">
          {filtered.map((n) => (
            <button
              key={n.id}
              onClick={() => onSelect(n)}
              onDoubleClick={() => {
                const type = inferContentType(n);
                openTab(n.id, n.path?.split("/").pop() || "Untitled", type);
              }}
              className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors truncate"
              style={{ color: "var(--text-secondary)" }}
            >
              {n.path || "Untitled"}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="text-xs py-1" style={{ color: "var(--text-muted)" }}>No matching notes</div>
          )}
        </div>
      )}
    </div>
  );
}
