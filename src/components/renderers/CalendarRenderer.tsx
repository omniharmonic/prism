import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { format, startOfWeek, endOfWeek, addWeeks, subWeeks, eachDayOfInterval, isSameDay } from "date-fns";
import type { RendererProps } from "./RendererProps";
import { calendarApi, type CalendarEvent } from "../../lib/sync/client";

export default function CalendarRenderer({ note: _note }: RendererProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<"week" | "day">("week");

  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });

  const { data: events, isLoading, isError } = useQuery({
    queryKey: ["calendar", "events", weekStart.toISOString(), weekEnd.toISOString()],
    queryFn: () => calendarApi.listEvents(weekStart.toISOString(), weekEnd.toISOString()),
    retry: 1,
  });

  const days = useMemo(() => eachDayOfInterval({ start: weekStart, end: weekEnd }), [weekStart, weekEnd]);

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-lg font-medium" style={{ color: "var(--text-secondary)" }}>
          Calendar unavailable
        </p>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Configure Google Calendar OAuth in Settings to connect.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center gap-2">
          <button onClick={() => setCurrentDate(subWeeks(currentDate, 1))} className="p-1 rounded hover:bg-[var(--glass-hover)]">
            <ChevronLeft size={16} style={{ color: "var(--text-secondary)" }} />
          </button>
          <h2 className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {format(weekStart, "MMM d")} – {format(weekEnd, "MMM d, yyyy")}
          </h2>
          <button onClick={() => setCurrentDate(addWeeks(currentDate, 1))} className="p-1 rounded hover:bg-[var(--glass-hover)]">
            <ChevronRight size={16} style={{ color: "var(--text-secondary)" }} />
          </button>
          <button
            onClick={() => setCurrentDate(new Date())}
            className="text-xs px-2 py-0.5 rounded hover:bg-[var(--glass-hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            Today
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
            <button
              onClick={() => setView("week")}
              className="px-2 py-0.5 text-xs"
              style={{
                background: view === "week" ? "var(--glass-active)" : "transparent",
                color: "var(--text-primary)",
              }}
            >
              Week
            </button>
            <button
              onClick={() => setView("day")}
              className="px-2 py-0.5 text-xs"
              style={{
                background: view === "day" ? "var(--glass-active)" : "transparent",
                color: "var(--text-primary)",
              }}
            >
              Day
            </button>
          </div>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading events...</span>
          </div>
        ) : view === "week" ? (
          <WeekView days={days} events={events || []} />
        ) : (
          <DayView date={currentDate} events={(events || []).filter((e) => {
            const eventDate = e.start.dateTime || e.start.date || "";
            return isSameDay(new Date(eventDate), currentDate);
          })} />
        )}
      </div>
    </div>
  );
}

function WeekView({ days, events }: { days: Date[]; events: CalendarEvent[] }) {
  const hours = Array.from({ length: 14 }, (_, i) => i + 7); // 7 AM to 8 PM

  return (
    <div className="flex flex-1 min-h-0">
      {/* Time labels */}
      <div className="w-14 flex-shrink-0 pt-8">
        {hours.map((h) => (
          <div key={h} className="h-12 text-xs text-right pr-2" style={{ color: "var(--text-muted)" }}>
            {h > 12 ? `${h - 12}p` : h === 12 ? "12p" : `${h}a`}
          </div>
        ))}
      </div>

      {/* Day columns */}
      {days.map((day) => {
        const dayEvents = events.filter((e) => {
          const eventDate = e.start.dateTime || e.start.date || "";
          return isSameDay(new Date(eventDate), day);
        });
        const isToday = isSameDay(day, new Date());

        return (
          <div key={day.toISOString()} className="flex-1 min-w-0" style={{ borderLeft: "1px solid var(--glass-border)" }}>
            {/* Day header */}
            <div
              className="text-center py-1.5 text-xs sticky top-0"
              style={{
                borderBottom: "1px solid var(--glass-border)",
                background: "var(--bg-surface)",
                color: isToday ? "var(--color-accent)" : "var(--text-secondary)",
                fontWeight: isToday ? 600 : 400,
              }}
            >
              {format(day, "EEE d")}
            </div>

            {/* Hour slots */}
            <div className="relative">
              {hours.map((h) => (
                <div key={h} className="h-12" style={{ borderBottom: "1px solid var(--glass-border)" }} />
              ))}

              {/* Event blocks */}
              {dayEvents.map((event) => {
                const startTime = event.start.dateTime ? new Date(event.start.dateTime) : null;
                const endTime = event.end.dateTime ? new Date(event.end.dateTime) : null;
                if (!startTime || !endTime) return null;

                const startHour = startTime.getHours() + startTime.getMinutes() / 60;
                const endHour = endTime.getHours() + endTime.getMinutes() / 60;
                const top = (startHour - 7) * 48; // 48px per hour
                const height = Math.max((endHour - startHour) * 48, 20);

                return (
                  <div
                    key={event.id}
                    className="absolute left-0.5 right-0.5 rounded px-1.5 py-0.5 text-xs overflow-hidden cursor-pointer"
                    style={{
                      top: `${top}px`,
                      height: `${height}px`,
                      background: "var(--color-accent)",
                      color: "white",
                      opacity: 0.9,
                    }}
                    title={`${event.summary}\n${format(startTime, "h:mm a")} – ${format(endTime, "h:mm a")}`}
                  >
                    <div className="font-medium truncate">{event.summary}</div>
                    {height > 30 && (
                      <div className="opacity-75">{format(startTime, "h:mm a")}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayView({ date, events }: { date: Date; events: CalendarEvent[] }) {
  return (
    <div className="p-4 space-y-2">
      <h3 className="text-lg font-medium mb-4" style={{ color: "var(--text-primary)" }}>
        {format(date, "EEEE, MMMM d, yyyy")}
      </h3>

      {events.length === 0 ? (
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>No events scheduled.</div>
      ) : (
        events.map((event) => (
          <div key={event.id} className="glass p-3 rounded-lg">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {event.summary}
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                  {event.start.dateTime
                    ? `${format(new Date(event.start.dateTime), "h:mm a")} – ${format(new Date(event.end.dateTime!), "h:mm a")}`
                    : "All day"
                  }
                </div>
                {event.location && (
                  <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    {event.location}
                  </div>
                )}
              </div>
              {event.meetUrl && (
                <a
                  href={event.meetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-2 py-1 rounded"
                  style={{ background: "var(--color-accent)", color: "white" }}
                >
                  Join Meet
                </a>
              )}
            </div>
            {event.attendees.length > 0 && (
              <div className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
                {event.attendees.map((a) => a.displayName || a.email).join(", ")}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
