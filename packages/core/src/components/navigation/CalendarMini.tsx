import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { format } from "date-fns";
import { calendarApi } from "../../lib/sync/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GogEvent = any; // gog returns standard Google Calendar event JSON

export function CalendarMini() {
  const now = new Date();
  const { data, isError } = useQuery({
    queryKey: ["calendar", "today", format(now, "yyyy-MM-dd")],
    queryFn: () => calendarApi.listEvents(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
    ),
    retry: 1,
    refetchInterval: 60_000,
  });

  // data is the events array directly (Rust command extracts from gog's { events: [...] })
  const events: GogEvent[] = Array.isArray(data) ? data : [];

  if (isError) {
    return (
      <div className="px-3 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        Calendar not connected
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="px-3 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        No events today
      </div>
    );
  }

  return (
    <div className="py-0.5">
      {events.slice(0, 5).map((event: GogEvent, i: number) => {
        const startTime = event?.start?.dateTime;
        return (
          <div key={event?.id || i} className="flex items-center gap-2 px-3 py-1 text-xs">
            <Clock size={11} style={{ color: "var(--text-muted)" }} />
            <span style={{ color: "var(--text-secondary)" }}>
              {startTime ? format(new Date(startTime), "h:mm a") : "All day"}
            </span>
            <span className="truncate" style={{ color: "var(--text-primary)" }}>
              {event?.summary || "Untitled"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
