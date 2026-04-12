import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock, RefreshCw } from "lucide-react";
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

type ViewMode = "month" | "week" | "day";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(dateStr?: string): string {
  if (!dateStr) return "";
  try { return new Date(dateStr).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

function getHour(dateStr?: string): number {
  if (!dateStr) return 0;
  try { return new Date(dateStr).getHours(); } catch { return 0; }
}

function startOfWeek(d: Date): Date {
  const day = d.getDay();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

function getMonthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const days: Date[] = [];
  for (let i = first.getDay() - 1; i >= 0; i--) days.push(new Date(year, month, -i));
  for (let d = 1; d <= last.getDate(); d++) days.push(new Date(year, month, d));
  while (days.length % 7 !== 0) days.push(new Date(year, month + 1, days.length - last.getDate() - first.getDay() + 1));
  return days;
}

function getWeekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export default function CalendarDashboard(_props: RendererProps) {
  const today = new Date();
  const [view, setView] = useState<ViewMode>("month");
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [weekStart, setWeekStart] = useState(startOfWeek(today));
  const [dayDate, setDayDate] = useState(today);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  // Compute date range based on current view
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (view === "month") {
      return { rangeStart: new Date(year, month, 1), rangeEnd: new Date(year, month + 1, 0, 23, 59, 59) };
    } else if (view === "week") {
      const end = new Date(weekStart);
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59);
      return { rangeStart: weekStart, rangeEnd: end };
    } else {
      const end = new Date(dayDate);
      end.setHours(23, 59, 59);
      return { rangeStart: new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate()), rangeEnd: end };
    }
  }, [view, year, month, weekStart, dayDate]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["calendar", view, rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn: () => calendarApi.listEvents(rangeStart.toISOString(), rangeEnd.toISOString()),
    retry: 1,
  });

  const events: CalEvent[] = Array.isArray(data) ? (data as CalEvent[]) : [];

  // On-demand sync: when the view range changes, sync that range into Parachute
  const [syncing, setSyncing] = useState(false);
  const rangeKey = `${rangeStart.toISOString()}-${rangeEnd.toISOString()}`;
  const [syncedRanges, setSyncedRanges] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (syncedRanges.has(rangeKey)) return;
    let cancelled = false;
    setSyncing(true);
    const fromStr = rangeStart.toISOString().split("T")[0];
    const toStr = rangeEnd.toISOString().split("T")[0];
    calendarApi.syncRange(fromStr, toStr)
      .then((result) => {
        if (!cancelled) {
          setSyncedRanges((prev) => new Set(prev).add(rangeKey));
          if (result.synced > 0) {
            console.log("Calendar sync:", result.synced, "events synced for", fromStr, "to", toStr);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) console.warn("Calendar sync error:", e);
      })
      .finally(() => {
        if (!cancelled) setSyncing(false);
      });
    return () => { cancelled = true; };
  }, [rangeKey]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const ev of events) {
      const ds = ev.start?.dateTime || ev.start?.date;
      if (!ds) continue;
      const d = new Date(ds);
      const k = dateKey(d);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(ev);
    }
    return map;
  }, [events]);

  // Navigation
  const prev = () => {
    if (view === "month") { if (month === 0) { setYear(year - 1); setMonth(11); } else setMonth(month - 1); }
    else if (view === "week") { setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - 7)); }
    else { setDayDate(new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate() - 1)); }
  };
  const next = () => {
    if (view === "month") { if (month === 11) { setYear(year + 1); setMonth(0); } else setMonth(month + 1); }
    else if (view === "week") { setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7)); }
    else { setDayDate(new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate() + 1)); }
  };
  const goToday = () => {
    setYear(today.getFullYear()); setMonth(today.getMonth());
    setWeekStart(startOfWeek(today)); setDayDate(today); setSelectedDate(today);
  };

  // Title based on view
  const title = view === "month" ? `${MONTH_NAMES[month]} ${year}`
    : view === "week" ? `Week of ${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : dayDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const selectedEvents = selectedDate ? eventsByDate.get(dateKey(selectedDate)) || [] : [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 flex-shrink-0" style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
          <div className="flex items-center gap-1">
            <button onClick={prev} className="p-1 rounded hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)" }}><ChevronLeft size={16} /></button>
            <button onClick={next} className="p-1 rounded hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)" }}><ChevronRight size={16} /></button>
          </div>
          <button onClick={goToday} className="px-2 py-0.5 rounded text-xs hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>Today</button>
          {syncing && (
            <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
              <RefreshCw size={10} className="animate-spin" style={{ animationDuration: "2s" }} />
              Syncing...
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(["month", "week", "day"] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => {
                setView(v);
                if (v === "week") setWeekStart(startOfWeek(selectedDate || today));
                if (v === "day") setDayDate(selectedDate || today);
              }}
              className="px-2.5 py-1 rounded text-xs transition-colors"
              style={{
                background: view === v ? "var(--color-accent)" : "transparent",
                color: view === v ? "white" : "var(--text-secondary)",
              }}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
          {isLoading && <Spinner size={14} />}
          {isError && <span className="text-xs" style={{ color: "var(--color-danger)" }}>Not connected</span>}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Main calendar area */}
        <div className="flex-1 flex flex-col min-h-0">
          {view === "month" && <MonthView days={getMonthDays(year, month)} month={month} today={today} selectedDate={selectedDate} eventsByDate={eventsByDate} onSelect={setSelectedDate} />}
          {view === "week" && <WeekView days={getWeekDays(weekStart)} today={today} selectedDate={selectedDate} eventsByDate={eventsByDate} onSelect={setSelectedDate} />}
          {view === "day" && <DayView date={dayDate} today={today} events={eventsByDate.get(dateKey(dayDate)) || []} />}
        </div>

        {/* Side panel — day detail (month/week views) */}
        {view !== "day" && selectedDate && (
          <div className="flex-shrink-0 overflow-auto" style={{ width: 280, borderLeft: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
            <div className="p-3">
              <div className="text-sm font-medium mb-3" style={{ color: "var(--text-primary)" }}>
                {selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </div>
              {selectedEvents.length === 0 ? (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>No events</div>
              ) : (
                <div className="space-y-2">{selectedEvents.map((ev, i) => <EventCard key={i} event={ev} />)}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Month View ──────────────────────────────────────────────

function MonthView({ days, month, today, selectedDate, eventsByDate, onSelect }: {
  days: Date[]; month: number; today: Date; selectedDate: Date | null;
  eventsByDate: Map<string, CalEvent[]>; onSelect: (d: Date) => void;
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0 p-2">
      <div className="grid grid-cols-7 mb-1">
        {WEEKDAYS.map((d) => <div key={d} className="text-center text-[10px] font-medium py-1" style={{ color: "var(--text-muted)" }}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 flex-1 gap-px" style={{ background: "var(--glass-border)" }}>
        {days.map((day, i) => {
          const isMonth = day.getMonth() === month;
          const isToday = isSameDay(day, today);
          const isSel = selectedDate ? isSameDay(day, selectedDate) : false;
          const dayEvts = eventsByDate.get(dateKey(day)) || [];
          return (
            <button key={i} onClick={() => onSelect(day)} className="flex flex-col p-1 text-left transition-colors hover:bg-[var(--glass-hover)]"
              style={{ background: isSel ? "var(--glass-active)" : "var(--bg-surface)", opacity: isMonth ? 1 : 0.4, minHeight: 60 }}>
              <span className="text-xs font-medium self-end w-5 h-5 flex items-center justify-center rounded-full"
                style={{ color: isToday ? "white" : "var(--text-primary)", background: isToday ? "var(--color-accent)" : "transparent" }}>
                {day.getDate()}
              </span>
              {dayEvts.slice(0, 3).map((ev, j) => (
                <div key={j} className="text-[9px] truncate px-0.5 rounded mt-0.5" style={{ background: "var(--color-accent)", color: "white", opacity: 0.85 }}>{ev.summary || "Event"}</div>
              ))}
              {dayEvts.length > 3 && <div className="text-[8px] mt-0.5" style={{ color: "var(--text-muted)" }}>+{dayEvts.length - 3} more</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Week View ───────────────────────────────────────────────

function WeekView({ days, today, selectedDate, eventsByDate, onSelect }: {
  days: Date[]; today: Date; selectedDate: Date | null;
  eventsByDate: Map<string, CalEvent[]>; onSelect: (d: Date) => void;
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Day headers */}
      <div className="grid grid-cols-8 flex-shrink-0" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <div /> {/* empty corner for time column */}
        {days.map((d, i) => {
          const isToday = isSameDay(d, today);
          const isSel = selectedDate ? isSameDay(d, selectedDate) : false;
          return (
            <button key={i} onClick={() => onSelect(d)} className="text-center py-2 hover:bg-[var(--glass-hover)] transition-colors"
              style={{ background: isSel ? "var(--glass-active)" : "transparent", borderLeft: "1px solid var(--glass-border)" }}>
              <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{WEEKDAYS[i]}</div>
              <div className="text-sm font-medium w-7 h-7 mx-auto flex items-center justify-center rounded-full"
                style={{ color: isToday ? "white" : "var(--text-primary)", background: isToday ? "var(--color-accent)" : "transparent" }}>
                {d.getDate()}
              </div>
            </button>
          );
        })}
      </div>

      {/* Time grid */}
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-8" style={{ minHeight: 24 * 48 }}>
          {/* Time labels */}
          <div>
            {HOURS.map((h) => (
              <div key={h} className="text-[10px] text-right pr-2" style={{ height: 48, color: "var(--text-muted)", paddingTop: 2 }}>
                {h === 0 ? "" : `${h % 12 || 12}${h < 12 ? "a" : "p"}`}
              </div>
            ))}
          </div>
          {/* Day columns */}
          {days.map((d, di) => {
            const dayEvts = eventsByDate.get(dateKey(d)) || [];
            return (
              <div key={di} className="relative" style={{ borderLeft: "1px solid var(--glass-border)" }}>
                {HOURS.map((h) => (
                  <div key={h} style={{ height: 48, borderBottom: "1px solid color-mix(in srgb, var(--glass-border) 50%, transparent)" }} />
                ))}
                {/* Event blocks */}
                {dayEvts.map((ev, ei) => {
                  const hour = getHour(ev.start?.dateTime);
                  const endHour = ev.end?.dateTime ? getHour(ev.end.dateTime) : hour + 1;
                  const duration = Math.max(1, endHour - hour);
                  return (
                    <div key={ei} className="absolute left-0.5 right-0.5 rounded px-1 py-0.5 text-[9px] overflow-hidden"
                      style={{ top: hour * 48 + 2, height: duration * 48 - 4, background: "var(--color-accent)", color: "white", opacity: 0.9 }}>
                      <div className="font-medium truncate">{ev.summary || "Event"}</div>
                      <div className="opacity-75">{formatTime(ev.start?.dateTime)}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Day View ────────────────────────────────────────────────

function DayView({ date, today, events }: { date: Date; today: Date; events: CalEvent[] }) {
  const isToday = isSameDay(date, today);

  return (
    <div className="flex-1 overflow-auto">
      <div className="grid grid-cols-[60px_1fr]" style={{ minHeight: 24 * 48 }}>
        {/* Time labels */}
        <div>
          {HOURS.map((h) => (
            <div key={h} className="text-[10px] text-right pr-2" style={{ height: 48, color: "var(--text-muted)", paddingTop: 2 }}>
              {h === 0 ? "12 AM" : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`}
            </div>
          ))}
        </div>
        {/* Day column */}
        <div className="relative" style={{ borderLeft: "1px solid var(--glass-border)" }}>
          {HOURS.map((h) => (
            <div key={h} style={{ height: 48, borderBottom: "1px solid color-mix(in srgb, var(--glass-border) 50%, transparent)" }}>
              {/* Current time indicator */}
              {isToday && h === today.getHours() && (
                <div className="absolute left-0 right-0" style={{ top: h * 48 + (today.getMinutes() / 60) * 48, height: 2, background: "var(--color-danger)", zIndex: 10 }} />
              )}
            </div>
          ))}
          {/* Event blocks */}
          {events.map((ev, i) => {
            const hour = getHour(ev.start?.dateTime);
            const endHour = ev.end?.dateTime ? getHour(ev.end.dateTime) : hour + 1;
            const startMin = ev.start?.dateTime ? new Date(ev.start.dateTime).getMinutes() : 0;
            const endMin = ev.end?.dateTime ? new Date(ev.end.dateTime).getMinutes() : 0;
            const topPx = hour * 48 + (startMin / 60) * 48;
            const heightPx = Math.max(24, (endHour - hour) * 48 + ((endMin - startMin) / 60) * 48);
            return (
              <div key={i} className="absolute left-1 right-1 rounded-md px-2 py-1 overflow-hidden"
                style={{ top: topPx, height: heightPx, background: "var(--color-accent)", color: "white", opacity: 0.9 }}>
                <div className="text-xs font-medium truncate">{ev.summary || "Event"}</div>
                <div className="text-[10px] opacity-80">{formatTime(ev.start?.dateTime)} – {formatTime(ev.end?.dateTime)}</div>
                {ev.location && <div className="text-[10px] opacity-70 truncate mt-0.5">{ev.location}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Event Card (sidebar) ────────────────────────────────────

function EventCard({ event }: { event: CalEvent }) {
  return (
    <div className="glass p-2.5 rounded-md" style={{ border: "1px solid var(--glass-border)" }}>
      <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>{event.summary || "Untitled"}</div>
      <div className="flex items-center gap-1 mt-1">
        <Clock size={10} style={{ color: "var(--text-muted)" }} />
        <span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>
          {formatTime(event.start?.dateTime) || "All day"}
          {event.end?.dateTime && ` – ${formatTime(event.end.dateTime)}`}
        </span>
      </div>
      {event.location && <div className="text-[10px] mt-1 truncate" style={{ color: "var(--text-muted)" }}>{event.location}</div>}
    </div>
  );
}
