import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock, RefreshCw, Plus, MapPin, Users, ExternalLink, FileText, Trash2, Pencil, X, Video } from "lucide-react";
import { calendarApi, calendarDate } from "../../lib/sync/client";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { isDesktop } from "../../lib/platform";
import { useHostServices } from "../../data/HostServicesContext";
import { useLiveActions } from "../../data/LiveActionsContext";
import { LiveActionError, liveActionErrorText, type CalendarUpdateParams, type LiveActionsClient, type RsvpResponse } from "../../lib/actions/client";
import { useUIStore } from "../../app/stores/ui";
import { Spinner } from "../ui/Spinner";
import { EventTranscripts } from "./EventTranscripts";
import type { RendererProps } from "../renderers/RendererProps";

type CalEvent = {
  id?: string;
  vaultNoteId?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  hangoutLink?: string;
  meetUrl?: string;
  /** Set on events synced from Google (vault `meeting` notes with a calendarEventId). */
  htmlLink?: string | null;
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
  const scope = useAgentChatStore((s) => s.scope);
  return <ScopedCalendarDashboard key={scope ?? "legacy-local"} />;
}

function ScopedCalendarDashboard() {
  const client = useVaultClient();
  const scope = useAgentChatStore((s) => s.scope);
  const mobile = useIsMobile();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const today = new Date();
  const [view, setView] = useState<ViewMode>(mobile ? "day" : "month");
  const [noteError, setNoteError] = useState<string | null>(null);
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
  // Web/native: create + RSVP through the server (WP1.5 live actions, gog) when
  // it offers calendar actions. Desktop keeps its Tauri commands (isDesktop).
  const liveCal = useLiveActions("calendar");
  const host = useHostServices();
  const canCreate = isDesktop || !!liveCal;
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
    queryKey: ["calendar", scope, view, rangeStart.toISOString(), rangeEnd.toISOString()],
    // Read from the vault (works on web + desktop), not live from Google.
    queryFn: () => calendarApi.listEventsFromVault(rangeStart.toISOString(), rangeEnd.toISOString(), client),
    retry: 1,
  });

  const events: CalEvent[] = !isError && Array.isArray(data) ? (data as CalEvent[]) : [];

  const refreshEvents = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["calendar"] });
  }, [queryClient]);

  const handleEventClick = useCallback((ev: CalEvent) => {
    setNoteError(null);
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

  // Desktop: its Tauri command behind a confirm(). Web/native: the server's live
  // action, behind the detail panel's own two-step confirm (with "notify guests").
  const handleDeleteEvent = useCallback(async (eventId: string, notify = true, scope?: "all") => {
    if (isDesktop) {
      if (!confirm("Delete this event?")) return;
      await calendarApi.deleteEvent(eventId);
    } else if (liveCal) {
      // Throws on failure — the panel shows the message and keeps the event open.
      await liveCal.calendarDelete(eventId, { notify, ...(scope ? { scope } : {}) });
    } else {
      return;
    }
    setSelectedEvent(null);
    refreshEvents();
  }, [refreshEvents, liveCal]);

  const handleOpenMeetingNote = useCallback(async (ev: CalEvent) => {
    setNoteError(null);
    try {
      if (!ev.vaultNoteId) throw new Error("Missing meeting identity");
      const note = await client.getNote(ev.vaultNoteId);
      if (!mounted.current || useAgentChatStore.getState().scope !== scope) return;
      if ((note.metadata?.calendarEventId || note.id) !== ev.id) throw new Error("Meeting identity changed");
      openTab(note.id, note.path?.split("/").pop() || "Meeting Notes", "document");
    } catch { setNoteError("This meeting note is unavailable. Refresh the calendar and try again."); }
  }, [openTab, client, scope]);

  const closePanel = useCallback(() => { setSelectedEvent(null); setShowCreateForm(false); setEditingEvent(null); setSelectedDate(null); }, []);

  // On-demand sync: when the view range changes, sync that range into Parachute
  const [syncing, setSyncing] = useState(false);
  const rangeKey = `${rangeStart.toISOString()}-${rangeEnd.toISOString()}`;
  const [syncedRanges, setSyncedRanges] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Google → vault range sync: the desktop runs it through its Tauri command;
    // a thin client (PWA / Prism Client, server owner) asks the Prism Server
    // (POST /api/calendar/sync, WP4.3). Anyone else just reads the meeting notes
    // the server's calendar ingest persists.
    const syncRange = isDesktop ? calendarApi.syncRange : host ? host.calendarSyncRange : null;
    if (!syncRange) return;
    if (syncedRanges.has(rangeKey)) return;
    let cancelled = false;
    setSyncing(true);
    const fromStr = rangeStart.toISOString().split("T")[0];
    const toStr = rangeEnd.toISOString().split("T")[0];
    syncRange(fromStr, toStr)
      .then((result) => {
        if (!cancelled) {
          setSyncedRanges((prev) => new Set(prev).add(rangeKey));
          if (result.synced > 0) {
            console.log("Calendar sync:", result.synced, "events synced for", fromStr, "to", toStr);
            // Surface the newly-persisted meeting notes in the current view.
            queryClient.invalidateQueries({ queryKey: ["calendar"] });
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
  }, [rangeKey, queryClient, host]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const ev of events) {
      const ds = ev.start?.dateTime || ev.start?.date;
      if (!ds) continue;
      const d = calendarDate(ds);
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
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
          <div className="flex items-center gap-1">
            <button aria-label="Previous period" onClick={prev} className="p-2 rounded hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)" }}><ChevronLeft size={16} /></button>
            <button aria-label="Next period" onClick={next} className="p-2 rounded hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)" }}><ChevronRight size={16} /></button>
          </div>
          <button onClick={goToday} className="px-2 py-0.5 rounded text-xs hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>Today</button>
          {syncing && (
            <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
              <RefreshCw size={10} className="animate-spin" style={{ animationDuration: "2s" }} />
              Syncing...
            </span>
          )}
          {canCreate && (
            <button
              onClick={() => handleCreateClick()}
              className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
              style={{ color: "var(--color-accent)" }}
              title="Create event"
            >
              <Plus size={16} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(["month", "week", "day"] as ViewMode[]).map((v) => (
            <button
              key={v}
              aria-pressed={view === v}
              onClick={() => {
                setView(v);
                if (v === "week") setWeekStart(startOfWeek(selectedDate || today));
                if (v === "day") setDayDate(selectedDate || today);
              }}
              className="px-3 py-2 rounded text-xs transition-colors"
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
        <div className="min-w-0 flex-1 flex flex-col min-h-0 overflow-auto">
          {view === "month" && <MonthView days={getMonthDays(year, month)} month={month} today={today} selectedDate={selectedDate} eventsByDate={eventsByDate} onSelect={setSelectedDate} onEventClick={handleEventClick} />}
          {view === "week" && <WeekView days={getWeekDays(weekStart)} today={today} selectedDate={selectedDate} eventsByDate={eventsByDate} onSelect={setSelectedDate} onEventClick={handleEventClick} />}
          {view === "day" && <DayView date={dayDate} today={today} events={eventsByDate.get(dateKey(dayDate)) || []} onEventClick={handleEventClick} />}
        </div>

        {/* Side panel — event detail, create form, or day overview */}
        <CalendarDetailsPanel open={!!selectedEvent || showCreateForm || !!selectedDate} onClose={closePanel}>
          {noteError && <p role="alert" className="px-4 py-2 text-sm">{noteError}</p>}
          {selectedEvent ? (
            <EventDetailPanel
              key={selectedEvent.vaultNoteId ?? selectedEvent.id}
              event={selectedEvent}
              onClose={() => setSelectedEvent(null)}
              onEdit={() => { setEditingEvent(selectedEvent); setSelectedEvent(null); setShowCreateForm(true); }}
              onDelete={(notify, scope) => (selectedEvent.id ? handleDeleteEvent(selectedEvent.id, notify, scope) : Promise.resolve())}
              onOpenNotes={() => handleOpenMeetingNote(selectedEvent)}
              onOpenTranscript={(noteId, label) => openTab(noteId, label, "document")}
              live={liveCal}
            />
          ) : showCreateForm ? (
            <EventFormPanel
              key={editingEvent?.id ?? createDate?.toISOString() ?? "new"}
              event={editingEvent}
              defaultDate={createDate}
              live={isDesktop ? null : liveCal}
              onClose={() => { setShowCreateForm(false); setEditingEvent(null); }}
              onSaved={() => { setShowCreateForm(false); setEditingEvent(null); refreshEvents(); }}
            />
          ) : selectedDate ? (
            <div className="p-3">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                </div>
                {canCreate && (
                  <button onClick={() => handleCreateClick(selectedDate)} className="p-1 rounded hover:bg-[var(--glass-hover)]" title="Add event">
                    <Plus size={14} style={{ color: "var(--color-accent)" }} />
                  </button>
                )}
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
        </CalendarDetailsPanel>
      </div>
    </div>
  );
}

function CalendarDetailsPanel({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const mobile = useIsMobile();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!mobile || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, [mobile, open]);
  if (!mobile) return open ? <aside className="w-[300px] flex-shrink-0 overflow-auto border-l" style={{ borderColor: "var(--glass-border)", background: "var(--bg-surface)" }}>{children}</aside> : null;
  return <dialog ref={dialog} aria-label="Calendar details" onCancel={(e) => { e.preventDefault(); onClose(); }} className="fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none overflow-auto border-0 p-4" style={{ background: "var(--bg-surface)", color: "var(--text-primary)" }}>
    <div className="mb-3 flex items-center justify-between"><h2 className="font-medium">Calendar details</h2><button aria-label="Close calendar details" className="focus-ring rounded-lg p-3" onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>;
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
            <div key={i} className="flex min-w-0 flex-col p-1 text-left"
              style={{ background: isSel ? "var(--glass-active)" : "var(--bg-surface)", opacity: isMonth ? 1 : 0.4, minHeight: 60 }}>
              <button aria-label={`Select ${day.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`} onClick={() => onSelect(day)} className="focus-ring text-xs font-medium self-end min-w-8 min-h-8 flex items-center justify-center rounded-full"
                style={{ color: isToday ? "white" : "var(--text-primary)", background: isToday ? "var(--color-accent)" : "transparent" }}>
                {day.getDate()}
              </button>
              {dayEvts.slice(0, 3).map((ev, j) => (
                <button key={ev.vaultNoteId ?? j} onClick={() => onEventClick(ev)} className="focus-ring text-left text-[10px] truncate px-1 py-1 rounded mt-0.5 hover:opacity-100" style={{ background: "var(--color-accent)", color: "white", opacity: 0.85 }}>{ev.summary || "Event"}</button>
              ))}
              {dayEvts.length > 3 && <button onClick={() => onSelect(day)} className="focus-ring text-left text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>+{dayEvts.length - 3} more</button>}
            </div>
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
    <div className="min-w-[640px] flex-1 flex flex-col min-h-0">
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

      <div className="grid grid-cols-8 border-b text-xs" style={{ borderColor: "var(--glass-border)" }}>
        <span className="p-2" style={{ color: "var(--text-muted)" }}>All day</span>
        {days.map((day) => <div key={dateKey(day)} className="min-w-0 space-y-1 border-l p-1" style={{ borderColor: "var(--glass-border)" }}>
          {(eventsByDate.get(dateKey(day)) ?? []).filter((event) => !event.start?.dateTime).map((event) => <button key={event.vaultNoteId ?? event.id} onClick={() => onEventClick(event)} className="focus-ring w-full truncate rounded px-1 py-2 text-left" style={{ background: "var(--glass-active)" }}>{event.summary || "Event"}</button>)}
        </div>)}
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
                {dayEvts.filter((event) => !!event.start?.dateTime).map((ev, ei) => {
                  const hour = getHour(ev.start?.dateTime) + new Date(ev.start!.dateTime!).getMinutes() / 60;
                  const endHour = ev.end?.dateTime ? getHour(ev.end.dateTime) + new Date(ev.end.dateTime).getMinutes() / 60 : hour + 1;
                  const duration = Math.max(0.5, endHour - hour);
                  return (
                    <button key={ei} onClick={() => onEventClick(ev)} className="focus-ring absolute left-0.5 right-0.5 rounded px-1 py-0.5 text-left text-[10px] overflow-hidden hover:opacity-100 transition-opacity"
                      style={{ top: hour * 48 + 2, height: duration * 48 - 4, background: "var(--color-accent)", color: "white", opacity: 0.9 }}>
                      <div className="font-medium truncate">{ev.summary || "Event"}</div>
                      <div className="opacity-75">{formatTime(ev.start?.dateTime)}</div>
                    </button>
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
  const mobile = useIsMobile();
  const isToday = isSameDay(date, today);
  if (mobile) return <div className="space-y-3 overflow-auto p-4">
    {!events.length && <p className="py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>No events for this day.</p>}
    {[...events].sort((a, b) => (a.start?.dateTime ?? "").localeCompare(b.start?.dateTime ?? "")).map((event) => <button key={event.vaultNoteId ?? event.id} onClick={() => onEventClick(event)} className="interactive focus-ring w-full rounded-xl border p-4 text-left" style={{ borderColor: "var(--glass-border)", background: "var(--bg-surface)" }}>
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>{event.start?.dateTime ? `${formatTime(event.start.dateTime)}${event.end?.dateTime ? ` – ${formatTime(event.end.dateTime)}` : ""}` : "All day"}</span>
      <span className="mt-1 block break-words text-sm font-medium">{event.summary || "Untitled event"}</span>
      {event.location && <span className="mt-2 block break-words text-xs" style={{ color: "var(--text-secondary)" }}>{event.location}</span>}
    </button>)}
  </div>;

  return (
    <div className="flex-1 overflow-auto">
      {events.some((event) => !event.start?.dateTime) && <div className="space-y-2 border-b p-3" style={{ borderColor: "var(--glass-border)" }}>
        <h3 className="text-xs" style={{ color: "var(--text-muted)" }}>All day</h3>
        {events.filter((event) => !event.start?.dateTime).map((event) => <button key={event.vaultNoteId ?? event.id} onClick={() => onEventClick(event)} className="interactive focus-ring block w-full rounded-lg px-3 py-2 text-left text-sm" style={{ background: "var(--glass-active)" }}>{event.summary || "Event"}</button>)}
      </div>}
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
          {events.filter((event) => !!event.start?.dateTime).map((ev, i) => {
            const hour = getHour(ev.start?.dateTime);
            const endHour = ev.end?.dateTime ? getHour(ev.end.dateTime) : hour + 1;
            const startMin = ev.start?.dateTime ? new Date(ev.start.dateTime).getMinutes() : 0;
            const endMin = ev.end?.dateTime ? new Date(ev.end.dateTime).getMinutes() : 0;
            const topPx = hour * 48 + (startMin / 60) * 48;
            const heightPx = Math.max(24, (endHour - hour) * 48 + ((endMin - startMin) / 60) * 48);
            return (
              <button key={i} onClick={() => onEventClick(ev)} className="focus-ring absolute left-1 right-1 rounded-md px-2 py-1 text-left overflow-hidden hover:opacity-100 transition-opacity"
                style={{ top: topPx, height: heightPx, background: "var(--color-accent)", color: "white", opacity: 0.9 }}>
                <div className="text-xs font-medium truncate">{ev.summary || "Event"}</div>
                <div className="text-[10px] opacity-80">{formatTime(ev.start?.dateTime)} – {formatTime(ev.end?.dateTime)}</div>
                {ev.location && <div className="text-[10px] opacity-70 truncate mt-0.5">{ev.location}</div>}
              </button>
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

function EventDetailPanel({ event, onClose, onEdit, onDelete, onOpenNotes, onOpenTranscript, live }: {
  event: CalEvent;
  onClose: () => void;
  onEdit: () => void;
  /** `notify` = email guests about the cancellation; `scope: "all"` = every
   *  occurrence of a recurring SERIES (live path only, after its own confirm). */
  onDelete: (notify: boolean, scope?: "all") => Promise<void>;
  onOpenNotes: () => void;
  onOpenTranscript: (noteId: string, label: string) => void;
  /** Server live actions (web/native): RSVP, edit and delete a Google-synced event. */
  live?: LiveActionsClient | null;
}) {
  const meetUrl = event.hangoutLink || event.meetUrl;
  // Edit / delete mutate Google Calendar: the desktop through Tauri, a thin client
  // through the server's live actions — only for events that came from Google.
  const canMutate = isDesktop || (!!live && !!event.id && !!event.htmlLink);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notifyGuests, setNotifyGuests] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The server refuses a recurring SERIES id unless the owner confirms "ALL
  // occurrences" separately (security review H1); an occurrence is always alone.
  const [seriesConfirm, setSeriesConfirm] = useState(false);
  const doDelete = async (scope?: "all") => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(notifyGuests, scope);
    } catch (e) {
      if (e instanceof LiveActionError && e.code === "recurring_series") setSeriesConfirm(true);
      setDeleteError(liveActionErrorText(e));
    } finally {
      setDeleting(false);
    }
  };
  // RSVP only for events that came from Google (they carry an htmlLink) and
  // have guests; the id is then the Google event id.
  const canRsvp = !!live && !!event.id && !!event.htmlLink && (event.attendees?.length ?? 0) > 0;
  const [rsvpMsg, setRsvpMsg] = useState<string | null>(null);
  // Organizer isn't stored on the note, so the server's "rsvp_not_applicable"
  // answer (you organize it / no guests) is what hides the buttons.
  const [rsvpNA, setRsvpNA] = useState(false);
  const rsvp = async (response: RsvpResponse) => {
    if (!live) return;
    setRsvpMsg(null);
    try {
      await live.calendarRsvp(event.id ?? "", response);
      setRsvpMsg(response === "accepted" ? "Accepted" : response === "declined" ? "Declined" : "Marked tentative");
    } catch (e) {
      if (e instanceof LiveActionError && e.code === "rsvp_not_applicable") setRsvpNA(true);
      setRsvpMsg(liveActionErrorText(e));
    }
  };


  return (
    <div className="p-3 space-y-3">
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold pr-2" style={{ color: "var(--text-primary)" }}>{event.summary || "Untitled"}</h3>
        <button aria-label="Close event details" onClick={onClose} className="hidden md:block p-2 rounded hover:bg-[var(--glass-hover)] flex-shrink-0">
          <X size={14} style={{ color: "var(--text-muted)" }} />
        </button>
      </div>

      {/* Time */}
      <div className="flex items-center gap-2">
        <Clock size={12} style={{ color: "var(--text-muted)" }} />
        <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
          <div>{event.start?.dateTime || event.start?.date ? calendarDate(event.start.dateTime || event.start.date!).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "Date unavailable"}</div>
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

      <EventTranscripts noteId={event.vaultNoteId} eventId={event.id} onOpen={onOpenTranscript} />

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2" style={{ borderTop: "1px solid var(--glass-border)" }}>
        <button onClick={onOpenNotes} className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--color-accent)", border: "1px solid var(--glass-border)" }}>
          <FileText size={12} /> Meeting Notes
        </button>
        {canMutate && (
          <>
            <button onClick={onEdit} className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
              <Pencil size={12} /> Edit
            </button>
            <button
              onClick={() => (isDesktop ? void onDelete(true) : setConfirmDelete(true))}
              aria-label="Delete event"
              title="Delete event"
              className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]"
              style={{ color: "var(--color-danger)", border: "1px solid var(--glass-border)" }}
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
      {confirmDelete && !isDesktop && (
        <div className="space-y-2 rounded p-2" style={{ border: "1px solid var(--color-danger)" }} role="alertdialog" aria-label="Confirm delete">
          <div className="text-xs" style={{ color: "var(--text-primary)" }}>
            Delete this occurrence from Google Calendar? Only this one is removed if the event repeats. Its meeting note is kept (marked cancelled).
          </div>
          {(event.attendees?.length ?? 0) > 0 && (
            <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
              <input type="checkbox" checked={notifyGuests} onChange={(e) => setNotifyGuests(e.target.checked)} />
              {notifyGuests ? "Guests will be emailed a cancellation" : "Don't email guests"}
            </label>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => void doDelete()}
              disabled={deleting}
              className="px-2 py-1 rounded text-xs font-medium disabled:opacity-50"
              style={{ background: "var(--color-danger)", color: "white" }}
            >
              {deleting ? "Deleting..." : "Delete this occurrence"}
            </button>
            <button onClick={() => { setConfirmDelete(false); setDeleteError(null); }} disabled={deleting} className="px-2 py-1 rounded text-xs" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
              Cancel
            </button>
          </div>
          {deleteError && <div className="text-xs" style={{ color: "var(--color-danger)" }}>{deleteError}</div>}
          {seriesConfirm && (
            <div className="space-y-1 pt-1" style={{ borderTop: "1px solid var(--glass-border)" }}>
              <div className="text-xs font-medium" style={{ color: "var(--color-danger)" }}>
                This removes EVERY occurrence of the series from Google Calendar{notifyGuests && (event.attendees?.length ?? 0) > 0 ? " and emails every guest" : ""}.
              </div>
              <button
                onClick={() => void doDelete("all")}
                disabled={deleting}
                className="px-2 py-1 rounded text-xs font-medium disabled:opacity-50"
                style={{ background: "var(--color-danger)", color: "white" }}
                data-testid="delete-all-occurrences"
              >
                Delete ALL occurrences
              </button>
            </div>
          )}
        </div>
      )}
      {canRsvp && (
        <div className="flex items-center gap-2 flex-wrap">
          {!rsvpNA && <span className="text-xs" style={{ color: "var(--text-muted)" }}>RSVP</span>}
          {!rsvpNA && (["accepted", "tentative", "declined"] as RsvpResponse[]).map((r) => (
            <button key={r} onClick={() => rsvp(r)} className="px-2 py-1 rounded text-xs transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
              {r === "accepted" ? "Yes" : r === "tentative" ? "Maybe" : "No"}
            </button>
          ))}
          {rsvpMsg && <span className="text-xs" style={{ color: "var(--text-muted)" }}>{rsvpMsg}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Event Form Panel (Create / Edit) ───────────────────────

function EventFormPanel({ event, defaultDate, onClose, onSaved, live }: {
  event: CalEvent | null; // null = create, non-null = edit
  defaultDate: Date | null;
  onClose: () => void;
  onSaved: () => void;
  /** Server live actions (web/native): create, and edit a Google-synced event. */
  live?: LiveActionsClient | null;
}) {
  const [saveError, setSaveError] = useState<string | null>(null);
  // A recurring SERIES id is refused unless "ALL occurrences" is confirmed (H1).
  const [seriesEdit, setSeriesEdit] = useState(false);
  const isEdit = !!event;
  const dateStr = defaultDate ? `${defaultDate.getFullYear()}-${String(defaultDate.getMonth() + 1).padStart(2, "0")}-${String(defaultDate.getDate()).padStart(2, "0")}` : new Date().toISOString().slice(0, 10);

  const [summary, setSummary] = useState(event?.summary || "");
  // Date and time both in the browser's local zone (security review L8): the
  // stored dateTime may carry another offset; slicing its date would mix zones.
  const [date, setDate] = useState(event?.start?.dateTime ? formatDateInput(event.start.dateTime) : event?.start?.date || dateStr);
  const [startTime, setStartTime] = useState(event?.start?.dateTime ? formatTimeInput(event.start.dateTime) : "09:00");
  const [endTime, setEndTime] = useState(event?.end?.dateTime ? formatTimeInput(event.end.dateTime) : "10:00");
  const [locationVal, setLocationVal] = useState(event?.location || "");
  const [descVal, setDescVal] = useState(event?.description || "");
  const [attendeesVal, setAttendeesVal] = useState("");
  const [notifyAttendees, setNotifyAttendees] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const canSave = isDesktop || !!live;
  // The form's starting values, to send only real changes on a live edit.
  const [initial] = useState(() => ({ date, startTime, endTime }));

  const handleSave = async (scopeAll = false) => {
    if (!summary.trim() || !canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const start = `${date}T${startTime}:00`;
      const end = `${date}T${endTime}:00`;

      setSaveError(null);
      if (isEdit && event?.id && live) {
        // Server live action: send ONLY what the owner changed (an untouched
        // all-day event is never turned into a timed one; an untouched guest list
        // is never replaced).
        const p: CalendarUpdateParams = { eventId: event.id, notify: notifyAttendees, ...(scopeAll ? { scope: "all" as const } : {}) };
        if (summary.trim() !== (event.summary || "")) p.title = summary.trim();
        if (date !== initial.date || startTime !== initial.startTime || endTime !== initial.endTime) {
          p.start = new Date(start).toISOString();
          p.end = new Date(end).toISOString();
        }
        if (locationVal !== (event.location || "")) p.location = locationVal;
        if (descVal !== (event.description || "")) p.description = descVal;
        if (attendeesVal.trim()) p.attendees = attendeesVal.split(",").map((s) => s.trim()).filter(Boolean);
        if (Object.keys(p).length <= (scopeAll ? 3 : 2)) {
          onClose();
          return;
        }
        await live.calendarUpdate(p);
      } else if (isEdit && event?.id) {
        await calendarApi.updateEvent(event.id, summary, start, end, attendeesVal ? attendeesVal.split(",").map((s) => s.trim()) : undefined, descVal || undefined);
      } else if (live) {
        // The server wants RFC 3339 with an offset: the form's local wall time → UTC.
        await live.calendarCreate({
          title: summary.trim(),
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          attendees: attendeesVal ? attendeesVal.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          description: descVal || undefined,
          location: locationVal || undefined,
          notify: notifyAttendees,
        });
      } else {
        await calendarApi.createEvent(summary, start, end, attendeesVal ? attendeesVal.split(",").map((s) => s.trim()) : undefined, descVal || undefined, locationVal || undefined);
      }
      onSaved();
    } catch (e) {
      console.error("Failed to save event:", e);
      setSaveError(liveActionErrorText(e));
      if (e instanceof LiveActionError && e.code === "recurring_series") setSeriesEdit(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{isEdit ? "Edit Event" : "New Event"}</h3>
        <button aria-label="Close event details" onClick={onClose} className="p-2 rounded hover:bg-[var(--glass-hover)]">
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

        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Event date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="col-span-2 min-w-0 rounded px-2 py-2 text-base outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
          <input aria-label="Start time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
            className="min-w-0 rounded px-2 py-2 text-base outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
          <input aria-label="End time" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
            className="min-w-0 rounded px-2 py-2 text-base outline-none"
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
        {live && !isEdit && attendeesVal.trim() && (
          <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={notifyAttendees} onChange={(e) => setNotifyAttendees(e.target.checked)} />
            {notifyAttendees ? "Attendees will be emailed an invite" : "Don't email attendees an invite"}
          </label>
        )}
        {live && isEdit && ((event?.attendees?.length ?? 0) > 0 || attendeesVal.trim()) && (
          <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={notifyAttendees} onChange={(e) => setNotifyAttendees(e.target.checked)} />
            {notifyAttendees ? "Guests will be emailed about the change" : "Don't email guests about the change"}
          </label>
        )}
        {live && isEdit && (
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Changes apply to this occurrence only. Leave attendees empty to keep the current guest list; a list replaces it.
          </div>
        )}

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
        onClick={() => void handleSave()}
        disabled={!summary.trim() || saving || !canSave}
        className="w-full py-2 rounded text-xs font-medium transition-colors disabled:opacity-50"
        style={{ background: "var(--color-accent)", color: "white" }}
      >
        {saving ? "Saving..." : isEdit ? "Update Event" : "Create Event"}
      </button>
      {!canSave && <p role="status" className="text-xs">Calendar editing is unavailable. Reconnect to your server and try again.</p>}
      {saveError && <div role="alert" className="text-xs" style={{ color: "var(--color-danger)" }}>{saveError}</div>}
      {seriesEdit && live && isEdit && (
        <button
          onClick={() => void handleSave(true)}
          disabled={saving}
          className="w-full py-1.5 rounded text-xs font-medium disabled:opacity-50"
          style={{ background: "var(--color-danger)", color: "white" }}
          data-testid="update-all-occurrences"
        >
          Apply to ALL occurrences of the series
        </button>
      )}
    </div>
  );
}

function formatDateInput(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTimeInput(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch { return "09:00"; }
}
