import { Clock, Calendar } from "lucide-react";
import { format } from "date-fns";
import { meetingsToday, useMeetingListing } from "../../../lib/calendar/meetingListing";
import { formatTime, usesSystemTime } from "../../../lib/datetime/format";

/** "system" keeps the string this always showed; a chosen 12/24-hour format replaces it (NP-AX-09). */
const clock = (d: Date): string => (usesSystemTime() ? format(d, "h:mm a") : formatTime(d, { hour: "numeric", minute: "2-digit" }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GogEvent = any;

export function CalendarWidget() {
  // Today, out of THE shared meeting listing (one request serves Home, the Calendar tool and this).
  const listing = useMeetingListing({ refetchInterval: 60_000 });
  const events: GogEvent[] = meetingsToday(listing.events);
  // Events drawn from this device's copy stay while the fresh listing is on its way (or failed).
  const isLoading = events.length === 0 && listing.load === "loading";
  const isError = events.length === 0 && listing.load === "failed";

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-8 rounded animate-pulse" style={{ background: "var(--glass)" }} />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Calendar size={14} style={{ color: "var(--text-muted)" }} />
        <span className="text-sm" style={{ color: "var(--text-muted)" }}>
          Calendar not connected
        </span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="text-sm py-2" style={{ color: "var(--text-muted)" }}>
        No events today
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {events.slice(0, 8).map((event: GogEvent, i: number) => {
        const startTime = event?.start?.dateTime;
        const endTime = event?.end?.dateTime;
        return (
          <div
            key={event?.id || i}
            className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-[var(--glass-hover)] transition-colors"
          >
            <Clock size={13} style={{ color: "var(--text-muted)" }} />
            <span className="text-xs flex-shrink-0 w-20" style={{ color: "var(--text-secondary)" }}>
              {startTime ? clock(new Date(startTime)) : "All day"}
              {endTime && startTime ? ` - ${format(new Date(endTime), "h:mm")}` : ""}
            </span>
            <span className="text-sm truncate" style={{ color: "var(--text-primary)" }}>
              {event?.summary || "Untitled"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
