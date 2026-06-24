import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { inferContentType } from "../../lib/schemas/content-types";
import type { Note } from "../../lib/types";
import type { WikilinkAutocompleteState } from "../../lib/tiptap/WikilinkAutocomplete";

/**
 * Wikilink autocomplete dropdown — appears when typing `[[` (or `@`) in any
 * editor. Shows matching vault notes; click to insert `[[path|name]]` at the
 * cursor. Shared by the plain DocumentRenderer and the collaborative editor so
 * the suggest feature works identically in both.
 */
export function WikilinkDropdown({
  editor,
  notes,
  autocomplete,
}: {
  editor: Editor | null;
  notes: Note[];
  autocomplete: WikilinkAutocompleteState;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (!editor) return null;

  const query = (autocomplete.query || "").toLowerCase();
  const matches = query.length > 0
    ? notes.filter((n) => {
        const name = (n.path || "").split("/").pop() || "";
        return name.toLowerCase().includes(query) || (n.path || "").toLowerCase().includes(query);
      }).slice(0, 8)
    : notes.slice(0, 8);

  if (matches.length === 0) return null;

  const coords = editor.view.coordsAtPos(autocomplete.to);

  const handleSelect = (note: Note) => {
    const name = (note.path || "").split("/").pop() || note.id;
    // Both @ and [[ insert the same wikilink format — the decoration renders it clean.
    editor.chain().focus()
      .deleteRange({ from: autocomplete.from, to: autocomplete.to })
      .insertContent(`[[${note.path || name}|${name}]] `)
      .run();
  };

  return (
    <div
      className="fixed glass-elevated overflow-hidden"
      style={{
        left: Math.min(coords.left, window.innerWidth - 300),
        top: coords.bottom + 6,
        width: 288,
        maxHeight: 264,
        overflowY: "auto",
        borderRadius: "var(--radius-lg)",
        padding: 4,
        zIndex: 70,
      }}
    >
      {matches.map((note, i) => {
        const name = (note.path || "").split("/").pop()?.replace(/\.[^.]+$/, "") || note.id;
        const sub = (note.path || "").replace(/^vault\//, "");
        const type = inferContentType(note);
        const emoji = typeof note.metadata?.icon === "string" ? (note.metadata.icon as string) : null;
        return (
          <button
            key={note.id}
            onClick={() => handleSelect(note)}
            onMouseEnter={() => setSelectedIndex(i)}
            className="interactive w-full flex items-center gap-2.5 text-left"
            style={{
              padding: "6px 8px",
              background: i === selectedIndex ? "var(--surface-active)" : "transparent",
              color: "var(--text-primary)",
            }}
          >
            <span className="flex items-center justify-center flex-shrink-0" style={{ width: 18, fontSize: 15, color: "var(--text-muted)" }}>
              {emoji || "·"}
            </span>
            <div className="flex-1 min-w-0">
              <div className="truncate" style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>{name}</div>
              <div className="truncate" style={{ color: "var(--text-muted)", fontSize: 10 }}>{sub} · {type}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
