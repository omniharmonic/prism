import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { calendarApi } from "../../lib/sync/client";
import { Spinner } from "../ui/Spinner";
import type { RendererProps } from "../renderers/RendererProps";

type CalEvent = {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function getMonthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const days: Date[] = [];
  // Pad start to Sunday
  for (let i = first.getDay() - 1; i >= 0; i--) {
    days.push(new Date(year, month, -i));
  }
  // Month days
  for (let d = 1; d <= last.getDate(); d++) {
    days.push(new Date(year, month, d));
  }
  // Pad end to Saturday
  while (days.length % 7 !== 0) {
    days.push(new Date(year, month + 1, days.length - last.getDate() - first.getDay() + 1));
  }
  return days;
}

function formatTime(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export default function CalendarDashboard(_props: RendererProps) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  const monthStart = new Date(year, month, 1).toISOString();
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59).toISOString();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["calendar", "month", year, month],
    queryFn: () => calendarApi.listEvents(monthStart, monthEnd),
    retry: 1,
  });

  const events: CalEvent[] = Array.isArray(data) ? (data as CalEvent[]) : [];
  const days = useMemo(() => getMonthDays(year, month), [year, month]);

  // Map events to dates
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const ev of events) {
      const dateStr = ev.start?.dateTime || ev.start?.date;
      if (!dateStr) continue;
      const d = new Date(dateStr);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    return map;
  }, [events]);

  const prevMonth = () => {
    if (month === 0) { setYear(year - 1); setMonth(11); }
    else setMonth(month - 1);
  };

  const nextMonth = () => {
    if (month === 11) { setYear(year + 1); setMonth(0); }
    else setMonth(month + 1);
  };

  const goToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
    setSelectedDate(today);
  };

  // Events for selected date
  const selectedEvents = selectedDate
    ? eventsByDate.get(`${selectedDate.getFullYear()}-${selectedDate.getMonth()}-${selectedDate.getDate()}`) || []
    : [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            {MONTH_NAMES[month]} {year}
          </h2>
          <div className="flex items-center gap-1">
            <button onClick={prevMonth} className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors" style={{ color: "var(--text-secondary)" }}>
              <ChevronLeft size={16} />
            </button>
            <button onClick={nextMonth} className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors" style={{ color: "var(--text-secondary)" }}>
              <ChevronRight size={16} />
            </button>
          </div>
          <button
            onClick={goToday}
            className="px-2 py-0.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}
          >
            Today
          </button>
        </div>
        {isLoading && <Spinner size={14} />}
        {isError && <span className="text-xs" style={{ color: "var(--color-danger)" }}>Calendar not connected</span>}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Calendar grid */}
        <div className="flex-1 flex flex-col min-h-0 p-2">
          {/* Weekday headers */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((d) => (
              <div key={d} className="text-center text-[10px] font-medium py-1" style={{ color: "var(--text-muted)" }}>
                {d}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 flex-1 gap-px" style={{ background: "var(--glass-border)" }}>
            {days.map((day, i) => {
              const isCurrentMonth = day.getMonth() === month;
              const isToday = isSameDay(day, today);
              const isSelected = selectedDate ? isSameDay(day, selectedDate) : false;
              const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
              const dayEvents = eventsByDate.get(key) || [];

              return (
                <button
                  key={i}
                  onClick={() => setSelectedDate(day)}
                  className="flex flex-col p-1 text-left transition-colors hover:bg-[var(--glass-hover)]"
                  style={{
                    background: isSelected ? "var(--glass-active)" : "var(--bg-surface)",
                    opacity: isCurrentMonth ? 1 : 0.4,
                    minHeight: 60,
                  }}
                >
                  <span
                    className="text-xs font-medium self-end w-5 h-5 flex items-center justify-center rounded-full"
                    style={{
                      color: isToday ? "white" : "var(--text-primary)",
                      background: isToday ? "var(--color-accent)" : "transparent",
                    }}
                  >
                    {day.getDate()}
                  </span>
                  {dayEvents.slice(0, 3).map((ev, j) => (
                    <div
                      key={j}
                      className="text-[9px] truncate px-0.5 rounded mt-0.5"
                      style={{ background: "var(--color-accent)", color: "white", opacity: 0.85 }}
                    >
                      {ev.summary || "Event"}
                    </div>
                  ))}
                  {dayEvents.length > 3 && (
                    <div className="text-[8px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                      +{dayEvents.length - 3} more
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Event detail panel (when a day is selected) */}
        {selectedDate && (
          <div
            className="flex-shrink-0 overflow-auto"
            style={{ width: 280, borderLeft: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
          >
            <div className="p-3">
              <div className="text-sm font-medium mb-3" style={{ color: "var(--text-primary)" }}>
                {selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </div>

              {selectedEvents.length === 0 ? (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>No events</div>
              ) : (
                <div className="space-y-2">
                  {selectedEvents.map((ev, i) => (
                    <div
                      key={i}
                      className="glass p-2.5 rounded-md"
                      style={{ border: "1px solid var(--glass-border)" }}
                    >
                      <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                        {ev.summary || "Untitled"}
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <Clock size={10} style={{ color: "var(--text-muted)" }} />
                        <span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>
                          {formatTime(ev.start?.dateTime) || "All day"}
                          {ev.end?.dateTime && ` – ${formatTime(ev.end.dateTime)}`}
                        </span>
                      </div>
                      {ev.location && (
                        <div className="text-[10px] mt-1 truncate" style={{ color: "var(--text-muted)" }}>
                          {ev.location}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
