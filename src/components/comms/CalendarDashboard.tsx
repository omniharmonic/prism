import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock, RefreshCw, Plus, MapPin, Users, ExternalLink, FileText, Trash2, Pencil, X, Video } from "lucide-react";
import { calendarApi } from "../../lib/sync/client";
import { vaultApi } from "../../lib/parachute/client";
import { useUIStore } from "../../app/stores/ui";
import { Spinner } from "../ui/Spinner";
import type { RendererProps } from "../renderers/RendererProps";

type CalEvent = {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  hangoutLink?: string;
  meetUrl?: string;
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
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
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createDate, setCreateDate] = useState<Date | null>(null);
  const [editingEvent, setEditingEvent] = useState<CalEvent | null>(null);
  const queryClient = useQueryClient();
  const openTab = useUIStore((s) => s.openTab);

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

  const refreshEvents = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["calendar"] });
  }, [queryClient]);

  const handleEventClick = useCallback((ev: CalEvent) => {
    setSelectedEvent(ev);
    setShowCreateForm(false);
    setEditingEvent(null);
  }, []);

  const handleCreateClick = useCallback((date?: Date) => {
    setCreateDate(date || selectedDate || today);
    setShowCreateForm(true);
    setSelectedEvent(null);
    setEditingEvent(null);
  }, [selectedDate, today]);

  const handleDeleteEvent = useCallback(async (eventId: string) => {
    if (!confirm("Delete this event?")) return;
    await calendarApi.deleteEvent(eventId);
    setSelectedEvent(null);
    refreshEvents();
  }, [refreshEvents]);

  const handleOpenMeetingNote = useCallback(async (ev: CalEvent) => {
    try {
      const dateStr = (ev.start?.dateTime || ev.start?.date || "").slice(0, 10);
      const slug = (ev.summary || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
      const path = `vault/meetings/${dateStr}/${slug}`;

      // Search by title (not event ID — Parachute search doesn't index metadata)
      const existing = await vaultApi.search(ev.summary || slug, ["meeting"], 10);
      const match = existing.find((n) =>
        n.path === path ||
        (n.metadata as Record<string, unknown>)?.calendarEventId === ev.id
      );

      if (match) {
        openTab(match.id, match.path?.split("/").pop() || "Meeting Notes", "document");
      } else {
        const content = `# ${ev.summary || "Meeting"}\n\n**Date:** ${dateStr}\n**Time:** ${formatTime(ev.start?.dateTime)} – ${formatTime(ev.end?.dateTime)}\n${ev.location ? `**Location:** ${ev.location}\n` : ""}\n---\n\n## Notes\n\n`;
        const note = await vaultApi.createNote({ content, path, tags: ["meeting"], metadata: { type: "meeting", calendarEventId: ev.id, date: dateStr } });
        if (note?.id) {
          openTab(note.id, slug, "document");
        }
      }
    } catch (err) {
      console.error("Failed to open/create meeting note:", err);
    }
  }, [openTab]);

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
          <button
            onClick={() => handleCreateClick()}
            className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--color-accent)" }}
            title="Create event"
          >
            <Plus size={16} />
          </button>
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
          {view === "month" && <MonthView days={getMonthDays(year, month)} month={month} today={today} selectedDate={selectedDate} eventsByDate={eventsByDate} onSelect={setSelectedDate} onEventClick={handleEventClick} />}
          {view === "week" && <WeekView days={getWeekDays(weekStart)} today={today} selectedDate={selectedDate} eventsByDate={eventsByDate} onSelect={setSelectedDate} onEventClick={handleEventClick} />}
          {view === "day" && <DayView date={dayDate} today={today} events={eventsByDate.get(dateKey(dayDate)) || []} onEventClick={handleEventClick} />}
        </div>

        {/* Side panel — event detail, create form, or day overview */}
        <div className="flex-shrink-0 overflow-auto" style={{ width: 300, borderLeft: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
          {selectedEvent ? (
            <EventDetailPanel
              event={selectedEvent}
              onClose={() => setSelectedEvent(null)}
              onEdit={() => { setEditingEvent(selectedEvent); setSelectedEvent(null); setShowCreateForm(true); }}
              onDelete={() => selectedEvent.id && handleDeleteEvent(selectedEvent.id)}
              onOpenNotes={() => handleOpenMeetingNote(selectedEvent)}
              onOpenTranscript={(noteId, label) => openTab(noteId, label, "document")}
            />
          ) : showCreateForm ? (
            <EventFormPanel
              event={editingEvent}
              defaultDate={createDate}
              onClose={() => { setShowCreateForm(false); setEditingEvent(null); }}
              onSaved={() => { setShowCreateForm(false); setEditingEvent(null); refreshEvents(); }}
            />
          ) : selectedDate ? (
            <div className="p-3">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                </div>
                <button onClick={() => handleCreateClick(selectedDate)} className="p-1 rounded hover:bg-[var(--glass-hover)]" title="Add event">
                  <Plus size={14} style={{ color: "var(--color-accent)" }} />
                </button>
              </div>
              {selectedEvents.length === 0 ? (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>No events</div>
              ) : (
                <div className="space-y-2">{selectedEvents.map((ev, i) => (
                  <button key={i} className="w-full text-left" onClick={() => handleEventClick(ev)}>
                    <EventCard event={ev} />
                  </button>
                ))}</div>
              )}
            </div>
          ) : (
            <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>Select a date to see events</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Month View ──────────────────────────────────────────────

function MonthView({ days, month, today, selectedDate, eventsByDate, onSelect, onEventClick }: {
  days: Date[]; month: number; today: Date; selectedDate: Date | null;
  eventsByDate: Map<string, CalEvent[]>; onSelect: (d: Date) => void; onEventClick: (ev: CalEvent) => void;
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
                <div key={j} onClick={(e) => { e.stopPropagation(); onEventClick(ev); }} className="text-[9px] truncate px-0.5 rounded mt-0.5 cursor-pointer hover:opacity-100" style={{ background: "var(--color-accent)", color: "white", opacity: 0.85 }}>{ev.summary || "Event"}</div>
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

function WeekView({ days, today, selectedDate, eventsByDate, onSelect, onEventClick }: {
  days: Date[]; today: Date; selectedDate: Date | null;
  eventsByDate: Map<string, CalEvent[]>; onSelect: (d: Date) => void; onEventClick: (ev: CalEvent) => void;
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
                    <div key={ei} onClick={() => onEventClick(ev)} className="absolute left-0.5 right-0.5 rounded px-1 py-0.5 text-[9px] overflow-hidden cursor-pointer hover:opacity-100 transition-opacity"
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

function DayView({ date, today, events, onEventClick }: { date: Date; today: Date; events: CalEvent[]; onEventClick: (ev: CalEvent) => void }) {
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
              <div key={i} onClick={() => onEventClick(ev)} className="absolute left-1 right-1 rounded-md px-2 py-1 overflow-hidden cursor-pointer hover:opacity-100 transition-opacity"
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
    <div className="glass p-2.5 rounded-md hover:bg-[var(--glass-hover)] transition-colors" style={{ border: "1px solid var(--glass-border)" }}>
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

// ─── Event Detail Panel ──────────────────────────────────────

function EventDetailPanel({ event, onClose, onEdit, onDelete, onOpenNotes, onOpenTranscript }: {
  event: CalEvent;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenNotes: () => void;
  onOpenTranscript: (noteId: string, label: string) => void;
}) {
  const meetUrl = event.hangoutLink || event.meetUrl;

  // Check for linked transcript
  const dateStr = (event.start?.dateTime || event.start?.date || "").slice(0, 10);
  const { data: transcriptMatch } = useQuery({
    queryKey: ["transcript-link", event.id, dateStr],
    queryFn: async () => {
      // First try: search for transcript by meeting title keywords + date
      const slug = (event.summary || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const searchTerms = slug ? `${dateStr} ${slug}` : dateStr;
      const results = await vaultApi.search(searchTerms, ["transcript"], 5);
      if (results.length > 0) {
        // Find one matching the date
        const match = results.find((n) => {
          const meta = n.metadata as Record<string, unknown> | undefined;
          return meta?.date === dateStr;
        });
        if (match) return match;
        return results[0]; // Best effort
      }
      return null;
    },
    enabled: !!dateStr,
    staleTime: 60_000,
  });

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold pr-2" style={{ color: "var(--text-primary)" }}>{event.summary || "Untitled"}</h3>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-[var(--glass-hover)] flex-shrink-0">
          <X size={14} style={{ color: "var(--text-muted)" }} />
        </button>
      </div>

      {/* Time */}
      <div className="flex items-center gap-2">
        <Clock size={12} style={{ color: "var(--text-muted)" }} />
        <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
          <div>{event.start?.dateTime ? new Date(event.start.dateTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : event.start?.date}</div>
          <div>
            {formatTime(event.start?.dateTime) || "All day"}
            {event.end?.dateTime && ` – ${formatTime(event.end.dateTime)}`}
          </div>
        </div>
      </div>

      {/* Location */}
      {event.location && (
        <div className="flex items-center gap-2">
          <MapPin size={12} style={{ color: "var(--text-muted)" }} />
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{event.location}</span>
        </div>
      )}

      {/* Meet link */}
      {meetUrl && (
        <a
          href={meetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]"
          style={{ color: "var(--color-accent)", border: "1px solid var(--glass-border)" }}
        >
          <Video size={12} /> Join meeting
          <ExternalLink size={10} className="ml-auto" />
        </a>
      )}

      {/* Attendees */}
      {event.attendees && event.attendees.length > 0 && (
        <div>
          <div className="flex items-center gap-1 mb-1">
            <Users size={12} style={{ color: "var(--text-muted)" }} />
            <span className="text-[10px] font-medium" style={{ color: "var(--text-muted)" }}>Attendees</span>
          </div>
          <div className="space-y-0.5">
            {event.attendees.map((a, i) => (
              <div key={i} className="text-xs truncate" style={{ color: "var(--text-secondary)" }}>
                {a.displayName || a.email}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      {event.description && (
        <div className="text-xs whitespace-pre-wrap rounded p-2" style={{ color: "var(--text-secondary)", background: "var(--glass)" }}>
          {event.description}
        </div>
      )}

      {/* Transcript link */}
      {transcriptMatch && (
        <button
          onClick={() => onOpenTranscript(transcriptMatch.id, transcriptMatch.path?.split("/").pop() || "Transcript")}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]"
          style={{ color: "var(--text-secondary)", background: "var(--glass)", border: "1px solid var(--glass-border)" }}
        >
          <FileText size={12} style={{ color: "var(--color-accent)" }} />
          <span className="truncate">Transcript available</span>
          <ExternalLink size={10} className="ml-auto flex-shrink-0" style={{ color: "var(--text-muted)" }} />
        </button>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2" style={{ borderTop: "1px solid var(--glass-border)" }}>
        <button onClick={onOpenNotes} className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--color-accent)", border: "1px solid var(--glass-border)" }}>
          <FileText size={12} /> Meeting Notes
        </button>
        <button onClick={onEdit} className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
          <Pencil size={12} /> Edit
        </button>
        <button onClick={onDelete} className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--color-danger)", border: "1px solid var(--glass-border)" }}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── Event Form Panel (Create / Edit) ───────────────────────

function EventFormPanel({ event, defaultDate, onClose, onSaved }: {
  event: CalEvent | null; // null = create, non-null = edit
  defaultDate: Date | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!event;
  const dateStr = defaultDate ? `${defaultDate.getFullYear()}-${String(defaultDate.getMonth() + 1).padStart(2, "0")}-${String(defaultDate.getDate()).padStart(2, "0")}` : new Date().toISOString().slice(0, 10);

  const [summary, setSummary] = useState(event?.summary || "");
  const [date, setDate] = useState(event?.start?.dateTime?.slice(0, 10) || event?.start?.date || dateStr);
  const [startTime, setStartTime] = useState(event?.start?.dateTime ? formatTimeInput(event.start.dateTime) : "09:00");
  const [endTime, setEndTime] = useState(event?.end?.dateTime ? formatTimeInput(event.end.dateTime) : "10:00");
  const [locationVal, setLocationVal] = useState(event?.location || "");
  const [descVal, setDescVal] = useState(event?.description || "");
  const [attendeesVal, setAttendeesVal] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!summary.trim()) return;
    setSaving(true);
    try {
      const start = `${date}T${startTime}:00`;
      const end = `${date}T${endTime}:00`;

      if (isEdit && event?.id) {
        await calendarApi.updateEvent(event.id, summary, start, end, attendeesVal ? attendeesVal.split(",").map((s) => s.trim()) : undefined, descVal || undefined);
      } else {
        await calendarApi.createEvent(summary, start, end, attendeesVal ? attendeesVal.split(",").map((s) => s.trim()) : undefined, descVal || undefined, locationVal || undefined);
      }
      onSaved();
    } catch (e) {
      console.error("Failed to save event:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{isEdit ? "Edit Event" : "New Event"}</h3>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-[var(--glass-hover)]">
          <X size={14} style={{ color: "var(--text-muted)" }} />
        </button>
      </div>

      <div className="space-y-2">
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Event title"
          className="w-full rounded px-2 py-1.5 text-xs outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          autoFocus
        />

        <div className="grid grid-cols-3 gap-1.5">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="col-span-1 rounded px-2 py-1.5 text-xs outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
            className="rounded px-2 py-1.5 text-xs outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
            className="rounded px-2 py-1.5 text-xs outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
        </div>

        <input
          value={locationVal}
          onChange={(e) => setLocationVal(e.target.value)}
          placeholder="Location"
          className="w-full rounded px-2 py-1.5 text-xs outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />

        <input
          value={attendeesVal}
          onChange={(e) => setAttendeesVal(e.target.value)}
          placeholder="Attendees (comma-separated emails)"
          className="w-full rounded px-2 py-1.5 text-xs outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />

        <textarea
          value={descVal}
          onChange={(e) => setDescVal(e.target.value)}
          placeholder="Description (optional)"
          rows={3}
          className="w-full rounded px-2 py-1.5 text-xs outline-none resize-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />
      </div>

      <button
        onClick={handleSave}
        disabled={!summary.trim() || saving}
        className="w-full py-2 rounded text-xs font-medium transition-colors disabled:opacity-50"
        style={{ background: "var(--color-accent)", color: "white" }}
      >
        {saving ? "Saving..." : isEdit ? "Update Event" : "Create Event"}
      </button>
    </div>
  );
}

function formatTimeInput(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch { return "09:00"; }
}
