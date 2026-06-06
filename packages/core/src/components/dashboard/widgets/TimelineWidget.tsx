import { useMemo } from "react";
import { format, parseISO, startOfDay } from "date-fns";
import { useWidgetData } from "../../../app/hooks/useWidgetData";
import { useUIStore } from "../../../app/stores/ui";
import { inferContentType } from "../../../lib/schemas/content-types";
import type { DashboardWidgetConfig } from "../../../lib/dashboard/widget-registry";
import type { Note } from "../../../lib/types";

interface TimelineWidgetProps {
  config: DashboardWidgetConfig;
}

function getDateValue(note: Note, field: string): string | null {
  switch (field) {
    case "createdAt":
      return note.createdAt;
    case "updatedAt":
      return note.updatedAt ?? null;
    default: {
      const val = note.metadata
        ? (note.metadata as Record<string, unknown>)[field]
        : undefined;
      return typeof val === "string" ? val : null;
    }
  }
}

export function TimelineWidget({ config }: TimelineWidgetProps) {
  const { items, isLoading } = useWidgetData(config);
  const openTab = useUIStore((s) => s.openTab);
  const dateField = config.dateField ?? "createdAt";
  const cardFields = config.cardFields ?? [];

  // Group notes by day
  const dayGroups = useMemo(() => {
    const map = new Map<string, { date: Date; notes: Note[] }>();

    for (const note of items) {
      const raw = getDateValue(note, dateField);
      if (!raw) continue;
      try {
        const d = parseISO(raw);
        const dayKey = format(startOfDay(d), "yyyy-MM-dd");
        const existing = map.get(dayKey);
        if (existing) {
          existing.notes.push(note);
        } else {
          map.set(dayKey, { date: startOfDay(d), notes: [note] });
        }
      } catch {
        // skip unparseable dates
      }
    }

    // Sort days descending (newest first)
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([, v]) => v);
  }, [items, dateField]);

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
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <div
              className="w-2 h-2 rounded-full mt-1.5 animate-pulse"
              style={{ background: "var(--glass)" }}
            />
            <div className="flex-1 space-y-1">
              <div
                className="h-4 w-24 rounded animate-pulse"
                style={{ background: "var(--glass)" }}
              />
              <div
                className="h-6 rounded animate-pulse"
                style={{ background: "var(--glass)" }}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (dayGroups.length === 0) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>
        No entries to display
      </div>
    );
  }

  return (
    <div className="max-h-80 overflow-auto space-y-4">
      {dayGroups.map(({ date, notes }) => (
        <div key={date.toISOString()}>
          {/* Day marker */}
          <div
            className="text-xs font-medium mb-2 sticky top-0 py-1"
            style={{
              color: "var(--text-secondary)",
              background: "var(--bg-surface)",
            }}
          >
            {format(date, "EEEE, MMM d")}
          </div>

          {/* Entries */}
          <div className="space-y-1 pl-3" style={{ borderLeft: "2px solid var(--glass-border)" }}>
            {notes.map((note) => {
              const raw = getDateValue(note, dateField);
              const time = raw ? format(parseISO(raw), "h:mm a") : "";
              const title =
                note.path?.split("/").pop() ??
                note.content?.split("\n")[0]?.slice(0, 60) ??
                note.id;

              return (
                <button
                  key={note.id}
                  onClick={() => handleOpen(note)}
                  className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--glass-hover)] transition-colors relative"
                >
                  {/* Dot */}
                  <div
                    className="absolute -left-[17px] top-2.5 w-2 h-2 rounded-full"
                    style={{ background: "var(--color-accent)" }}
                  />

                  {time && (
                    <span
                      className="text-xs flex-shrink-0 w-16 pt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {time}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-sm truncate"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {title}
                    </div>
                    {cardFields.map((field) => {
                      const val = note.metadata
                        ? (note.metadata as Record<string, unknown>)[field]
                        : undefined;
                      if (val == null) return null;
                      return (
                        <div
                          key={field}
                          className="text-xs truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {String(val)}
                        </div>
                      );
                    })}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
