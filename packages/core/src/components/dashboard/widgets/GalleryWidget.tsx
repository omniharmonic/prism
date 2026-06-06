import { useWidgetData } from "../../../app/hooks/useWidgetData";
import { useUIStore } from "../../../app/stores/ui";
import { inferContentType } from "../../../lib/schemas/content-types";
import type { DashboardWidgetConfig } from "../../../lib/dashboard/widget-registry";
import type { Note } from "../../../lib/types";

interface GalleryWidgetProps {
  config: DashboardWidgetConfig;
}

export function GalleryWidget({ config }: GalleryWidgetProps) {
  const { items, isLoading } = useWidgetData(config);
  const openTab = useUIStore((s) => s.openTab);
  const colCount = config.columnCount ?? 3;
  const cardFields = config.cardFields ?? [];

  const handleOpen = (note: Note) => {
    const type = inferContentType(note);
    const title =
      note.path?.split("/").pop() ??
      note.content?.split("\n")[0]?.slice(0, 60) ??
      note.id;
    openTab(note.id, title, type);
  };

  if (isLoading) {
    return (
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${colCount}, 1fr)` }}
      >
        {Array.from({ length: colCount * 2 }).map((_, i) => (
          <div
            key={i}
            className="h-28 rounded-lg animate-pulse"
            style={{ background: "var(--glass)" }}
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>
        No matching notes
      </div>
    );
  }

  return (
    <div
      className="grid gap-3 max-h-96 overflow-auto"
      style={{ gridTemplateColumns: `repeat(${colCount}, 1fr)` }}
    >
      {items.map((note) => {
        const title =
          note.path?.split("/").pop() ??
          note.content?.split("\n")[0]?.slice(0, 60) ??
          note.id;
        const preview = note.content?.slice(0, 100);

        return (
          <button
            key={note.id}
            onClick={() => handleOpen(note)}
            className="text-left p-3 rounded-lg transition-colors hover:bg-[var(--glass-hover)]"
            style={{
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
            }}
          >
            <div
              className="text-sm font-medium truncate"
              style={{ color: "var(--text-primary)" }}
            >
              {title}
            </div>
            {preview && (
              <div
                className="text-xs mt-1.5 line-clamp-3"
                style={{ color: "var(--text-muted)" }}
              >
                {preview}
              </div>
            )}
            {cardFields.map((field) => {
              const val = note.metadata
                ? (note.metadata as Record<string, unknown>)[field]
                : undefined;
              if (val == null) return null;
              return (
                <div
                  key={field}
                  className="text-xs mt-1 truncate"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <span style={{ color: "var(--text-muted)" }}>{field}: </span>
                  {String(val)}
                </div>
              );
            })}
          </button>
        );
      })}
    </div>
  );
}
