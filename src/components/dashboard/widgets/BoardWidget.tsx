import { useWidgetData } from "../../../app/hooks/useWidgetData";
import { useUIStore } from "../../../app/stores/ui";
import { inferContentType } from "../../../lib/schemas/content-types";
import type { DashboardWidgetConfig } from "../../../lib/dashboard/widget-registry";
import type { Note } from "../../../lib/types";

interface BoardWidgetProps {
  config: DashboardWidgetConfig;
}

function getCardTitle(note: Note): string {
  return (
    note.path?.split("/").pop() ??
    note.content?.split("\n")[0]?.slice(0, 60) ??
    note.id
  );
}

export function BoardWidget({ config }: BoardWidgetProps) {
  const { groups, isLoading } = useWidgetData(config);
  const openTab = useUIStore((s) => s.openTab);
  const cardFields = config.cardFields ?? [];

  const handleOpen = (note: Note) => {
    const type = inferContentType(note);
    openTab(note.id, getCardTitle(note), type);
  };

  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex-shrink-0 w-56 h-40 rounded-lg animate-pulse"
            style={{ background: "var(--glass)" }}
          />
        ))}
      </div>
    );
  }

  if (!groups || groups.size === 0) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>
        No data to display. Set a group field in widget settings.
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2" style={{ minHeight: 180 }}>
      {Array.from(groups.entries()).map(([groupKey, notes]) => (
        <div
          key={groupKey}
          className="flex-shrink-0 w-56 rounded-lg flex flex-col"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
          }}
        >
          {/* Column header */}
          <div
            className="px-3 py-2 text-xs font-medium flex items-center justify-between"
            style={{
              color: "var(--text-secondary)",
              borderBottom: "1px solid var(--glass-border)",
            }}
          >
            <span className="truncate">{groupKey}</span>
            <span
              className="flex-shrink-0 px-1.5 rounded-full text-[10px]"
              style={{ background: "var(--glass)", color: "var(--text-muted)" }}
            >
              {notes.length}
            </span>
          </div>

          {/* Cards */}
          <div className="p-2 space-y-1.5 overflow-y-auto max-h-60 flex-1">
            {notes.map((note) => (
              <button
                key={note.id}
                onClick={() => handleOpen(note)}
                className="w-full text-left p-2 rounded-md transition-colors hover:bg-[var(--glass-hover)]"
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--glass-border)",
                }}
              >
                <div
                  className="text-sm truncate font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {getCardTitle(note)}
                </div>
                {cardFields.map((field) => {
                  const val = note.metadata
                    ? (note.metadata as Record<string, unknown>)[field]
                    : undefined;
                  if (val == null) return null;
                  return (
                    <div
                      key={field}
                      className="text-xs mt-1 truncate"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {String(val)}
                    </div>
                  );
                })}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
