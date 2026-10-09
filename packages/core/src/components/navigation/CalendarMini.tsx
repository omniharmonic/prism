import { Clock } from "lucide-react";
import { format } from "date-fns";
import { meetingsToday, useMeetingListing } from "../../lib/calendar/meetingListing";
import { formatTime, usesSystemTime } from "../../lib/datetime/format";

/** "system" keeps the string this always showed; a chosen 12/24-hour format replaces it (NP-AX-09). */
const clock = (d: Date): string => (usesSystemTime() ? format(d, "h:mm a") : formatTime(d, { hour: "numeric", minute: "2-digit" }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GogEvent = any; // the vault listing has the Google Calendar event shape

export function CalendarMini() {
  // Today, out of THE shared meeting listing (one request serves Home, the Calendar tool and this).
  const listing = useMeetingListing({ refetchInterval: 60_000 });
  const events: GogEvent[] = meetingsToday(listing.events);
  const isError = events.length === 0 && listing.load === "failed";
  // Not yet answered: nothing may say the day is empty.
  if (events.length === 0 && listing.load === "loading") return null;

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
              {startTime ? clock(new Date(startTime)) : "All day"}
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
