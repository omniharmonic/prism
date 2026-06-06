import { FileText } from "lucide-react";
import { useNotes } from "../../../app/hooks/useParachute";
import { useUIStore } from "../../../app/stores/ui";
import { inferContentType } from "../../../lib/schemas/content-types";
import type { Note } from "../../../lib/types";

interface NoteListWidgetProps {
  filter?: Record<string, unknown>;
}

export function NoteListWidget({ filter }: NoteListWidgetProps) {
  const filterTag = filter?.tag as string | undefined;
  const filterPath = filter?.path as string | undefined;

  // If a tag filter is set, fetch by tag; otherwise fetch all
  const { data: notes, isLoading } = useNotes(filterTag ? { tag: filterTag } : undefined);
  const openTab = useUIStore((s) => s.openTab);

  const filtered = (notes || []).filter((n) => {
    if (filterPath && n.path && !n.path.startsWith(filterPath)) return false;
    return true;
  });

  const handleOpen = (n: Note) => {
    const type = inferContentType(n);
    const title = n.path?.split("/").pop() || n.id;
    openTab(n.id, title, type);
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-8 rounded animate-pulse" style={{ background: "var(--glass)" }} />
        ))}
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="text-sm py-2" style={{ color: "var(--text-muted)" }}>
        No notes found
      </div>
    );
  }

  return (
    <div className="space-y-0.5 max-h-64 overflow-auto">
      {filtered.slice(0, 20).map((note) => {
        const title = note.path?.split("/").pop() || note.content?.slice(0, 60) || note.id;
        const date = note.updatedAt || note.createdAt;

        return (
          <button
            key={note.id}
            onClick={() => handleOpen(note as Note)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-[var(--glass-hover)] transition-colors"
          >
            <FileText size={13} style={{ color: "var(--text-muted)" }} />
            <span className="flex-1 truncate" style={{ color: "var(--text-primary)" }}>
              {title}
            </span>
            {date && (
              <span className="text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>
                {formatShortDate(date)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}
