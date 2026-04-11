import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { format, startOfDay, endOfDay } from "date-fns";
import { calendarApi } from "../../lib/sync/client";

export function CalendarMini() {
  const now = new Date();
  const { data: events, isError } = useQuery({
    queryKey: ["calendar", "today", format(now, "yyyy-MM-dd")],
    queryFn: () => calendarApi.listEvents(startOfDay(now).toISOString(), endOfDay(now).toISOString()),
    retry: 1,
    refetchInterval: 60_000,
  });

  if (isError) {
    return (
      <div className="px-3 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        Calendar not connected
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="px-3 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        No events today
      </div>
    );
  }

  return (
    <div className="py-0.5">
      {events.slice(0, 5).map((event) => (
        <div
          key={event.id}
          className="flex items-center gap-2 px-3 py-1 text-xs"
        >
          <Clock size={11} style={{ color: "var(--text-muted)" }} />
          <span style={{ color: "var(--text-secondary)" }}>
            {event.start.dateTime
              ? format(new Date(event.start.dateTime), "h:mm a")
              : "All day"}
          </span>
          <span className="truncate" style={{ color: "var(--text-primary)" }}>
            {event.summary}
          </span>
        </div>
      ))}
    </div>
  );
}
