import { Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { Note } from "../../lib/types";

interface HistoryPanelProps {
  note: Note;
}

export function HistoryPanel({ note }: HistoryPanelProps) {
  // Build a timeline from available timestamps
  const events: { label: string; time: string; icon: string }[] = [];

  events.push({ label: "Created", time: note.createdAt, icon: "create" });

  if (note.updatedAt && note.updatedAt !== note.createdAt) {
    events.push({ label: "Last modified", time: note.updatedAt, icon: "edit" });
  }

  // Check sync metadata for sync events
  const meta = note.metadata as Record<string, unknown> | null;
  const syncConfigs = (meta?.sync as Array<Record<string, unknown>>) || [];
  for (const config of syncConfigs) {
    if (config.last_synced) {
      events.push({
        label: `Synced to ${config.adapter}`,
        time: config.last_synced as string,
        icon: "sync",
      });
    }
  }

  // Sort by time descending
  events.sort((a, b) => b.time.localeCompare(a.time));

  return (
    <div className="space-y-3">
      {events.length === 0 ? (
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>
          No history available.
        </div>
      ) : (
        <div className="space-y-0">
          {events.map((event, i) => (
            <div key={i} className="flex items-start gap-2.5 py-2 relative">
              {/* Timeline line */}
              {i < events.length - 1 && (
                <div
                  className="absolute left-[9px] top-8 bottom-0 w-px"
                  style={{ background: "var(--glass-border)" }}
                />
              )}

              {/* Dot */}
              <div
                className="w-[18px] h-[18px] rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ background: "var(--glass)" }}
              >
                <Clock size={10} style={{ color: "var(--text-muted)" }} />
              </div>

              {/* Event info */}
              <div className="flex-1 min-w-0">
                <div className="text-sm" style={{ color: "var(--text-primary)" }}>
                  {event.label}
                </div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {formatTime(event.time)}
                  <span className="mx-1">·</span>
                  {formatDistanceToNow(new Date(event.time), { addSuffix: true })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs pt-2" style={{ color: "var(--text-muted)", borderTop: "1px solid var(--glass-border)" }}>
        Full version history requires Parachute versioning support (future).
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
