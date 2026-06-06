import { Tag, FileText, Code, CheckSquare, Globe, Table2, Presentation } from "lucide-react";
import { useNotes } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType, CONTENT_TYPE_LABELS } from "../../lib/schemas/content-types";
import { Badge } from "../ui/Badge";
import type { Note } from "../../lib/types";

interface TagViewProps {
  tag: string;
}

const TYPE_ICONS: Record<string, typeof FileText> = {
  document: FileText,
  note: FileText,
  code: Code,
  task: CheckSquare,
  website: Globe,
  spreadsheet: Table2,
  presentation: Presentation,
};

export function TagView({ tag }: TagViewProps) {
  const { data: notes, isLoading } = useNotes({ tag });
  const openTab = useUIStore((s) => s.openTab);

  const handleOpenNote = (note: Note) => {
    const type = inferContentType(note);
    const title = note.path?.split("/").pop() || note.id;
    openTab(note.id, title, type);
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Tag header */}
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
          >
            <Tag size={20} style={{ color: "var(--color-accent)" }} />
          </div>
          <div>
            <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
              {tag}
            </h1>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              {isLoading ? "Loading..." : `${notes?.length ?? 0} notes`}
            </p>
          </div>
        </div>

        {/* Note list */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="glass rounded-lg p-3 animate-pulse"
                style={{ height: 56 }}
              />
            ))}
          </div>
        ) : !notes || notes.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No notes tagged with "{tag}"
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {notes.map((note) => {
              const type = inferContentType(note as never);
              const Icon = TYPE_ICONS[type] || FileText;
              const title = note.path?.split("/").pop() || note.content?.slice(0, 60) || note.id;
              const date = note.updatedAt || note.createdAt;

              return (
                <button
                  key={note.id}
                  onClick={() => handleOpenNote(note)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-[var(--glass-hover)] transition-colors group"
                >
                  <Icon size={15} style={{ color: "var(--text-muted)" }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" style={{ color: "var(--text-primary)" }}>
                      {title}
                    </div>
                    {note.path && (
                      <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                        {note.path}
                      </div>
                    )}
                  </div>
                  <Badge>{CONTENT_TYPE_LABELS[type] || type}</Badge>
                  {date && (
                    <span className="text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>
                      {formatShortDate(date)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
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
