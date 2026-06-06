import { useNote } from "../../../app/hooks/useParachute";
import type { DashboardWidgetConfig } from "../../../lib/dashboard/widget-registry";

interface EmbedWidgetProps {
  config: DashboardWidgetConfig;
}

export function EmbedWidget({ config }: EmbedWidgetProps) {
  const noteId = config.noteId ?? null;
  const maxHeight = config.maxHeight ?? 300;
  const { data: note, isLoading } = useNote(noteId);

  if (!noteId) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>
        No note selected. Edit this widget to choose a note.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-4 rounded animate-pulse"
            style={{
              background: "var(--glass)",
              width: `${80 - i * 15}%`,
            }}
          />
        ))}
      </div>
    );
  }

  if (!note) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>
        Note not found
      </div>
    );
  }

  // Convert plain content to simple HTML paragraphs
  const htmlContent = note.content
    .split("\n\n")
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");

  return (
    <div
      className="overflow-auto prose-sm"
      style={{
        maxHeight,
        color: "var(--text-primary)",
        lineHeight: 1.6,
        fontSize: "0.875rem",
      }}
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br/>");
}
