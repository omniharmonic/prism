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
import { HostServiceError } from "../../lib/host/services";
import { CALENDAR_SYNC_SETTLE_MS, calendarSyncChanged, ingestCoversRange, startCalendarSync } from "./calendarSync";
import { EventTranscripts } from "./EventTranscripts";
import { calendarDayKey as dateKey, groupCalendarDays, layoutCalendarDay } from "./calendarLayout";
import type { RendererProps } from "../renderers/RendererProps";

import { formatDate as fmtDate, formatTime as fmtTime, relativeDay, usesSystemTime, weekColumn, weekdayOrder, weekStartsOn } from "../../lib/datetime/format";
import { useRegionPrefs } from "../../lib/datetime/useRegionPrefs";
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

/** "agenda" is the phone's list of the next seven days; a wide window never shows it. */
type ViewMode = "agenda" | "month" | "week" | "day";
const AGENDA_DAYS = 7;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** The meeting notes are listed ONCE (lean: no bodies) and every view/range reads that list, so
 *  moving between days, weeks and views costs no request and never empties the screen. */
const ALL_FROM = "1900-01-01T00:00:00.000Z";
const ALL_TO = "2200-01-01T00:00:00.000Z";
const MEETINGS_STALE_MS = 60_000;
const MEETINGS_KEEP_MS = 30 * 60_000;
/** "ready" = the vault answered; until then nothing may claim a day is empty. */
type LoadState = "loading" | "ready" | "failed";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(dateStr?: string): string {
  if (!dateStr) return "";
  try { return fmtTime(new Date(dateStr), { hour: "numeric", minute: "2-digit" }, { locale: "en-US" }); }
  catch { return ""; }
}

/** An hour label of the time grids. On "System" the grids keep their short labels; a chosen
 *  12/24-hour format (Settings → Language & region) is honoured. */
function hourLabel(h: number, compact: boolean): string {
  if (usesSystemTime()) return compact ? (h === 0 ? "" : `${h % 12 || 12}${h < 12 ? "a" : "p"}`) : h === 0 ? "12 AM" : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
  return compact && h === 0 ? "" : fmtTime(new Date(2000, 0, 1, h), { hour: "numeric", minute: "2-digit" }, { locale: "en-US" });
}

/** All-day first, then by start. */
const byStart = <T extends { start?: { dateTime?: string } }>(events: T[]): T[] =>
  [...events].sort((a, b) => (a.start?.dateTime ? Date.parse(a.start.dateTime) : -Infinity) - (b.start?.dateTime ? Date.parse(b.start.dateTime) : -Infinity));

/** Include the day when a displayed time belongs to a neighboring day. */
function timeOnDay(value: string, day: Date): string {
  const date = calendarDate(value);
  return isSameDay(date, day) ? formatTime(value) : `${fmtDate(date, { weekday: "short" }, { locale: "en-US" })}, ${formatTime(value)}`;
}

/** The first day of the week row `d` is in (Settings → Start week on; NP-AX-09). */
function startOfWeek(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - weekColumn(d));
}

function getMonthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const days: Date[] = [];
  const lead = weekColumn(first);
  for (let i = lead - 1; i >= 0; i--) days.push(new Date(year, month, -i));
  for (let d = 1; d <= last.getDate(); d++) days.push(new Date(year, month, d));
  while (days.length % 7 !== 0) days.push(new Date(year, month + 1, days.length - last.getDate() - lead + 1));
  return days;
}

function getWeekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
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
  // A phone opens on the agenda (the week ahead as a list); every other view stays one tap away.
  const [chosenView, setView] = useState<ViewMode>(mobile ? "agenda" : "month");
  const view: ViewMode = !mobile && chosenView === "agenda" ? "month" : chosenView;
  const [noteError, setNoteError] = useState<string | null>(null);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [weekStart, setWeekStart] = useState(startOfWeek(today));
  // "Start week on" changed while the calendar is open: the week on screen keeps its days' week.
  const firstDay = weekStartsOn({ prefs: useRegionPrefs() });
  useEffect(() => { setWeekStart((current) => { const next = startOfWeek(new Date(current.getFullYear(), current.getMonth(), current.getDate() + 3)); return next.getTime() === current.getTime() ? current : next; }); }, [firstDay]);
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
      const days = getMonthDays(year, month);
      const last = days[days.length - 1];
      return { rangeStart: days[0], rangeEnd: new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59) };
    } else if (view === "week") {
      const end = new Date(weekStart);
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59);
      return { rangeStart: weekStart, rangeEnd: end };
    } else {
      const end = view === "agenda" ? addDays(dayDate, AGENDA_DAYS - 1) : new Date(dayDate);
      end.setHours(23, 59, 59);
      return { rangeStart: new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate()), rangeEnd: end };
    }
  }, [view, year, month, weekStart, dayDate, firstDay]);

  // Read from the vault (works on web + desktop), not live from Google. One listing for the whole
  // calendar, kept while the tool is closed; a failed refetch keeps what was already shown.
  const meetingsKey = useMemo(() => ["calendar", "meetings", scope], [scope]);
  const { data, isFetching, isError } = useQuery({
    queryKey: meetingsKey,
    queryFn: () => calendarApi.listEventsFromVault(ALL_FROM, ALL_TO, client),
    retry: 1,
    staleTime: MEETINGS_STALE_MS,
    gcTime: MEETINGS_KEEP_MS,
  });

  const events = useMemo<CalEvent[]>(() => (Array.isArray(data) ? (data as CalEvent[]) : []), [data]);
  const load: LoadState = data !== undefined ? "ready" : isError ? "failed" : "loading";

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
    // On a phone the day (or first agenda day) on screen is the one a new event is for.
    setCreateDate(date || (mobile && (view === "day" || view === "agenda") ? dayDate : selectedDate || today));
    setShowCreateForm(true);
    setSelectedEvent(null);
    setEditingEvent(null);
  }, [selectedDate, today, mobile, view, dayDate]);

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

  // Google → vault range sync, ALWAYS in the background (calendarSync.ts says when): the desktop
  // runs it through its Tauri command; a thin client (PWA / Prism Client, server owner) asks the
  // Prism Server (POST /api/calendar/sync, WP4.3). Anyone else just reads the meeting notes the
  // server's calendar ingest persists.
  const syncRange = isDesktop ? calendarApi.syncRange : host ? host.calendarSyncRange : null;
  const [syncing, setSyncing] = useState(0);
  const [syncFailed, setSyncFailed] = useState(false);
  const sync = useCallback((from: Date, to: Date, force: boolean) => {
    if (!syncRange) return;
    const fromStr = from.toISOString().split("T")[0];
    const toStr = to.toISOString().split("T")[0];
    const job = startCalendarSync(scope ?? "", fromStr, toStr, force, () => syncRange(fromStr, toStr));
    if (!job) return;
    setSyncing((n) => n + 1);
    job.then((result) => {
      if (!mounted.current) return;
      setSyncFailed(false);
      // Surface the newly-persisted meeting notes; an unchanged calendar costs no second listing.
      if (calendarSyncChanged(result)) queryClient.invalidateQueries({ queryKey: meetingsKey });
    }, (e) => {
      console.warn("Calendar sync error:", e);
      // 409 = this server does not own calendar ingest: nothing the reader can act on.
      if (mounted.current && !(e instanceof HostServiceError && e.status === 409)) setSyncFailed(true);
    }).finally(() => { if (mounted.current) setSyncing((n) => n - 1); });
  }, [syncRange, scope, queryClient, meetingsKey]);

  const rangeKey = `${rangeStart.toISOString()}-${rangeEnd.toISOString()}`;
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) { opened.current = true; sync(rangeStart, rangeEnd, false); return; }
    if (ingestCoversRange(rangeStart, rangeEnd)) return;
    const timer = setTimeout(() => sync(rangeStart, rangeEnd, false), CALENDAR_SYNC_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [rangeKey, sync]);

  /** The one indicator is also the refresh button: re-read the vault and top up from Google. */
  const refreshNow = useCallback(() => {
    sync(rangeStart, rangeEnd, true);
    queryClient.invalidateQueries({ queryKey: meetingsKey });
  }, [sync, rangeStart, rangeEnd, queryClient, meetingsKey]);
  const busy = isFetching || syncing > 0;

  const eventsByDate = useMemo(() => groupCalendarDays(events, rangeStart, rangeEnd), [events, rangeStart, rangeEnd]);

  // Navigation
  const prev = () => {
    if (view === "month") { if (month === 0) { setYear(year - 1); setMonth(11); } else setMonth(month - 1); }
    else if (view === "week") { setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - 7)); }
    else { setDayDate(addDays(dayDate, view === "agenda" ? -AGENDA_DAYS : -1)); }
  };
  const next = () => {
    if (view === "month") { if (month === 11) { setYear(year + 1); setMonth(0); } else setMonth(month + 1); }
    else if (view === "week") { setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7)); }
    else { setDayDate(addDays(dayDate, view === "agenda" ? AGENDA_DAYS : 1)); }
  };
  const goToday = () => {
    setYear(today.getFullYear()); setMonth(today.getMonth());
    setWeekStart(startOfWeek(today)); setDayDate(today); setSelectedDate(today);
  };

  // Title based on view
  const title = view === "month" ? `${MONTH_NAMES[month]} ${year}`
    : view === "week" ? `Week of ${fmtDate(weekStart, { month: "short", day: "numeric" }, { locale: "en-US" })}`
    : fmtDate(dayDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" }, { locale: "en-US" });

  const selectedEvents = selectedDate ? eventsByDate.get(dateKey(selectedDate)) || [] : [];
  const chooseView = (v: ViewMode) => {
    setView(v);
    if (v === "week") setWeekStart(startOfWeek(selectedDate || today));
    if (v === "day" || v === "agenda") setDayDate(selectedDate || today);
  };

  // ── Phone ── two fixed rows: what is on screen + move/create, then the views + Today. Nothing
  // wraps or changes place between views (the desktop header below wraps by title length).
  const short = (d: Date, withYear = d.getFullYear() !== today.getFullYear()) => fmtDate(d, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) }, { locale: "en-US" });
  const span = (from: Date, to: Date) => `${short(from, from.getFullYear() !== to.getFullYear())} – ${from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear() ? to.getDate() : short(to, to.getFullYear() !== today.getFullYear())}`;
  const phoneTitle = view === "month" ? title
    : view === "week" ? span(weekStart, addDays(weekStart, 6))
    : view === "agenda" ? span(dayDate, addDays(dayDate, AGENDA_DAYS - 1))
    : `${isSameDay(dayDate, today) ? "Today · " : ""}${fmtDate(dayDate, { weekday: "short", month: "short", day: "numeric", ...(dayDate.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) }, { locale: "en-US" })}`;
  // Phone month: the chosen day's events are listed under the grid (today until a day is chosen).
  const monthDay = selectedDate ?? (today.getFullYear() === year && today.getMonth() === month ? today : null);
  const detailsTitle = selectedEvent ? "Event" : showCreateForm ? (editingEvent ? "Edit event" : "New event") : "Calendar details";

  return (
    <div className="flex min-w-0 flex-col h-full bg-[var(--bg-base)]">
      {/* Header */}
      {mobile ? (
        <div className="calendar-phone-header flex-shrink-0 px-4 pt-1" style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
          <div className="flex items-center gap-1">
            <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" title={phoneTitle} style={{ color: "var(--text-primary)" }}>{phoneTitle}</h2>
            <RefreshButton busy={busy} onClick={refreshNow} className="size-control flex flex-shrink-0 items-center justify-center" size={18} />
            <button aria-label="Previous period" onClick={prev} className="focus-ring size-control flex flex-shrink-0 items-center justify-center rounded-lg" style={{ color: "var(--text-secondary)" }}><ChevronLeft size={20} /></button>
            <button aria-label="Next period" onClick={next} className="focus-ring size-control flex flex-shrink-0 items-center justify-center rounded-lg" style={{ color: "var(--text-secondary)" }}><ChevronRight size={20} /></button>
            {canCreate && <button onClick={() => handleCreateClick()} title="Create event" className="focus-ring size-control flex flex-shrink-0 items-center justify-center rounded-lg" style={{ color: "var(--color-accent)" }}><Plus size={20} /></button>}
          </div>
          <div className="flex items-center gap-2">
            <div className="prism-tabs flex-1" data-inline role="group" aria-label="Calendar view" style={{ gap: 6 }}>
              {(["agenda", "day", "week", "month"] as ViewMode[]).map((v) => (
                <button key={v} aria-pressed={view === v} onClick={() => chooseView(v)} className="prism-tab">{v.charAt(0).toUpperCase() + v.slice(1)}</button>
              ))}
            </div>
            {isError && <span role="status" className="flex-shrink-0 text-xs" style={{ color: "var(--color-danger)" }}>Not connected</span>}
            <button onClick={goToday} className="focus-ring min-h-control flex-shrink-0 px-2 text-sm font-medium" style={{ color: "var(--color-accent)" }}>Today</button>
          </div>
        </div>
      ) : (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
          <div className="flex items-center gap-1">
            <button aria-label="Previous period" onClick={prev} className="focus-ring min-h-control min-w-control p-2 rounded-lg hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)" }}><ChevronLeft size={16} /></button>
            <button aria-label="Next period" onClick={next} className="focus-ring min-h-control min-w-control p-2 rounded-lg hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)" }}><ChevronRight size={16} /></button>
          </div>
          <button onClick={goToday} className="focus-ring min-h-control px-3 rounded-lg text-sm hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>Today</button>
          <RefreshButton busy={busy} onClick={refreshNow} className="min-h-control min-w-control flex items-center justify-center p-2 hover:bg-[var(--glass-hover)] transition-colors" size={14} />
          {canCreate && (
            <button
              onClick={() => handleCreateClick()}
              className="focus-ring min-h-control min-w-control p-2 rounded-lg hover:bg-[var(--glass-hover)] transition-colors"
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
              onClick={() => chooseView(v)}
              className="focus-ring min-h-control px-3 py-1.5 rounded-lg text-sm transition-colors"
              style={{
                background: view === v ? "var(--surface-active)" : "transparent",
                color: view === v ? "var(--text-primary)" : "var(--text-secondary)",
              }}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
          {isError && <span className="text-xs" style={{ color: "var(--color-danger)" }}>Not connected</span>}
        </div>
      </div>
      )}

      {/* A failed top-up never hides what the vault already has. */}
      {syncFailed && <p role="status" data-testid="calendar-sync-notice" className="flex-shrink-0 px-4 py-1.5 text-xs" style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>Couldn't reach Google Calendar — showing saved events.</p>}

      <div className="flex-1 flex min-h-0">
        {/* Main calendar area */}
        <div className="min-w-0 flex-1 flex flex-col min-h-0 overflow-auto">
          {view === "agenda" && <AgendaView load={load} days={Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(dayDate, i))} today={today} eventsByDate={eventsByDate} onEventClick={handleEventClick} />}
          {view === "month" && !mobile && <MonthView days={getMonthDays(year, month)} month={month} today={today} selectedDate={selectedDate} eventsByDate={eventsByDate} onSelect={setSelectedDate} onEventClick={handleEventClick} />}
          {view === "month" && mobile && <>
            <PhoneMonthGrid days={getMonthDays(year, month)} month={month} today={today} selectedDate={monthDay} eventsByDate={eventsByDate} onSelect={setSelectedDate} />
            <section aria-label="Events on the selected day" className="space-y-3 px-4 pb-4">
              {monthDay ? <>
                <DayHeading day={monthDay} today={today} action={canCreate ? <button onClick={() => handleCreateClick(monthDay)} aria-label="Add event on this day" className="focus-ring size-control flex flex-shrink-0 items-center justify-center rounded-lg" style={{ color: "var(--color-accent)" }}><Plus size={18} /></button> : null} />
                {(eventsByDate.get(dateKey(monthDay)) ?? []).length === 0 && <EmptyDay load={load} className="py-2 text-sm">No events</EmptyDay>}
                {byStart(eventsByDate.get(dateKey(monthDay)) ?? []).map((event) => <PhoneEventCard key={event.vaultNoteId ?? event.id} event={event} day={monthDay} onClick={handleEventClick} />)}
              </> : <p className="py-2 text-sm" style={{ color: "var(--text-muted)" }}>Select a day to see its events.</p>}
            </section>
          </>}
          {/* Phone: a day header opens that day (there is no side panel to list it in). */}
          {view === "week" && <WeekView days={getWeekDays(weekStart)} today={today} selectedDate={selectedDate} eventsByDate={eventsByDate} onSelect={mobile ? (d) => { setSelectedDate(d); setDayDate(d); setView("day"); } : setSelectedDate} onEventClick={handleEventClick} />}
          {view === "day" && <DayView load={load} date={dayDate} today={today} events={eventsByDate.get(dateKey(dayDate)) || []} onEventClick={handleEventClick} />}
        </div>

        {/* Side panel — event detail, create form, or day overview */}
        {/* Phone: the sheet is for an event or the form only — a chosen DAY is shown in the page
            (it used to open the sheet too, so "Today" covered the calendar with a day list). */}
        <CalendarDetailsPanel title={detailsTitle} open={!!selectedEvent || showCreateForm || (!mobile && !!selectedDate)} onClose={mobile ? () => { setSelectedEvent(null); setShowCreateForm(false); setEditingEvent(null); } : closePanel}>
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
                  {fmtDate(selectedDate, { weekday: "long", month: "long", day: "numeric" }, { locale: "en-US" })}
                </div>
                {canCreate && (
                  <button onClick={() => handleCreateClick(selectedDate)} className="p-1 rounded hover:bg-[var(--glass-hover)]" title="Add event">
                    <Plus size={14} style={{ color: "var(--color-accent)" }} />
                  </button>
                )}
              </div>
              {selectedEvents.length === 0 ? (
                <EmptyDay load={load} className="text-xs">No events</EmptyDay>
              ) : (
                <div className="space-y-2">{selectedEvents.map((ev, i) => (
                  <button key={i} className="w-full text-left" onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); handleEventClick(ev); }}>
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

/** THE loading indicator, and the way to refresh: it turns while the vault is read or Google is
 *  being synced, and a tap asks for both. There is never a second spinner next to it. */
function RefreshButton({ busy, onClick, className, size }: { busy: boolean; onClick: () => void; className: string; size: number }) {
  return <button type="button" data-testid="calendar-refresh" aria-label="Refresh calendar" aria-busy={busy} title={busy ? "Refreshing…" : "Refresh calendar"} onClick={onClick} className={`focus-ring rounded-lg ${className}`} style={{ color: busy ? "var(--text-secondary)" : "var(--text-muted)" }}>
    <span aria-hidden className={`flex ${busy ? "animate-spin" : ""}`} style={{ animationDuration: "1.4s" }}><RefreshCw size={size} /></span>
  </button>;
}

/** "No events" is a claim about the calendar: it is only made once the vault has answered. While
 *  loading there is a quiet placeholder (or nothing); a failed first load says so instead. */
function EmptyDay({ load, className, skeleton, children }: { load: LoadState; className: string; skeleton?: boolean; children: ReactNode }) {
  if (load === "ready") return <p className={className} style={{ color: "var(--text-muted)" }}>{children}</p>;
  if (load === "failed") return <p className={className} style={{ color: "var(--text-muted)" }}>Couldn't load events.</p>;
  if (!skeleton) return null;
  return <div aria-hidden data-testid="calendar-skeleton" className="space-y-3">
    {[0, 1, 2].map((i) => <div key={i} className="h-[68px] rounded-xl" style={{ background: "var(--glass-hover)", opacity: 0.6 - i * 0.15 }} />)}
  </div>;
}

function CalendarDetailsPanel({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const mobile = useIsMobile();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!mobile || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, [mobile, open]);
  // Event → its edit form: the new content starts at its top, not where the last one was scrolled to.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [title]);
  if (!mobile) return open ? <aside className="w-[clamp(300px,30%,380px)] flex-shrink-0 overflow-auto border-l" style={{ borderColor: "var(--glass-border)", background: "var(--bg-surface)" }}>{children}</aside> : null;
  // A modal <dialog> is in the top layer, outside the shell's safe-area padding: it pads itself, or
  // its header sits under the status bar / Dynamic Island and its last button under the home bar.
  // The header stays put; the body scrolls (and is what the keyboard pushes around).
  return <dialog ref={dialog} aria-label="Calendar details" onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }} className="calendar-details-sheet fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none overflow-hidden border-0 p-0" style={{ background: "var(--bg-surface)", color: "var(--text-primary)" }}>
    <div className="flex h-full flex-col" style={{ padding: "env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left)" }}>
      <div className="flex flex-shrink-0 items-center justify-between pl-4 pr-2 pt-1"><h2 className="font-medium">{title}</h2><button aria-label="Close calendar details" className="focus-ring size-control flex items-center justify-center rounded-lg" onClick={onClose}><X size={18} /></button></div>
      <div ref={body} className="calendar-details-body min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4" style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>{children}</div>
    </div>
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
        {weekdayOrder().map((d) => <div key={d} className="text-center text-[10px] font-medium py-1" style={{ color: "var(--text-muted)" }}>{WEEKDAYS[d]}</div>)}
      </div>
      <div className="grid grid-cols-7 flex-1 gap-px" style={{ background: "var(--glass-border)" }}>
        {days.map((day, i) => {
          const isMonth = day.getMonth() === month;
          const isToday = isSameDay(day, today);
          const isSel = selectedDate ? isSameDay(day, selectedDate) : false;
          const dayEvts = eventsByDate.get(dateKey(day)) || [];
          return (
            <div key={i} className="flex min-w-0 flex-col p-1 text-left"
              style={{ background: isSel ? "var(--glass-active)" : "var(--bg-surface)", minHeight: 60 }} data-outside-month={isMonth ? undefined : "true"}>
              <button aria-label={`Select ${day.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`} onClick={() => onSelect(day)} className="focus-ring text-xs font-medium self-end min-w-8 min-h-8 flex items-center justify-center rounded-full"
                style={{ color: isToday ? "var(--action-fg, white)" : isMonth ? "var(--text-primary)" : "var(--text-muted)", background: isToday ? "var(--action-bg, var(--color-accent))" : "transparent" }}>
                {day.getDate()}
              </button>
              {dayEvts.slice(0, 3).map((ev, j) => (
                <button key={ev.vaultNoteId ?? j} onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); onEventClick(ev); }} className="focus-ring text-left text-[10px] truncate px-1 py-1 rounded mt-0.5" style={isMonth ? { background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" } : { background: "var(--glass-hover)", color: "var(--text-secondary)" }}>{ev.summary || "Event"}</button>
              ))}
              {dayEvts.length > 3 && <button onClick={() => onSelect(day)} className="focus-ring text-left text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>+{dayEvts.length - 3} more</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Phone: event card, agenda, month grid ───────────────────

function PhoneEventCard({ event, day, onClick }: { event: CalEvent; day: Date; onClick: (ev: CalEvent) => void }) {
  return <button onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); onClick(event); }} className="interactive focus-ring block w-full min-w-0 rounded-xl border p-4 text-left" style={{ borderColor: "var(--glass-border)", background: "var(--bg-surface)", color: "var(--text-primary)" }}>
    <span className="text-xs" style={{ color: "var(--text-muted)" }}>{event.start?.dateTime ? `${timeOnDay(event.start.dateTime, day)}${event.end?.dateTime ? ` – ${timeOnDay(event.end.dateTime, day)}` : ""}` : "All day"}</span>
    <span className="mt-1 block break-words text-sm font-medium">{event.summary || "Untitled event"}</span>
    {event.location && <span className="mt-2 block break-words text-xs [overflow-wrap:anywhere]" style={{ color: "var(--text-secondary)" }}>{event.location}</span>}
  </button>;
}

/** "Today · Mon, Oct 5" — the day's name in a list of days. */
function DayHeading({ day, today, action }: { day: Date; today: Date; action?: ReactNode }) {
  const relative = relativeDay(day, { now: today });
  return <div className="flex min-h-[var(--touch-target)] items-center justify-between gap-2">
    <h3 className="min-w-0 text-sm font-semibold" style={{ color: isSameDay(day, today) ? "var(--color-accent)" : "var(--text-primary)" }}>
      {relative === "Today" || relative === "Tomorrow" ? `${relative} · ` : ""}{fmtDate(day, { weekday: "short", month: "short", day: "numeric" }, { locale: "en-US" })}
    </h3>
    {action}
  </div>;
}

/** The next seven days as one list: a day's name, then its events (or one quiet line). */
function AgendaView({ load, days, today, eventsByDate, onEventClick }: { load: LoadState; days: Date[]; today: Date; eventsByDate: Map<string, CalEvent[]>; onEventClick: (ev: CalEvent) => void }) {
  return <div className="px-4 pb-6" data-testid="calendar-agenda">
    {days.map((day) => {
      const events = byStart(eventsByDate.get(dateKey(day)) ?? []);
      return <section key={dateKey(day)} aria-label={day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} className="space-y-3 pb-2" style={{ borderBottom: "1px solid color-mix(in srgb, var(--glass-border) 60%, transparent)" }}>
        <DayHeading day={day} today={today} action={events.length || load === "loading" ? undefined : <span className="flex-shrink-0 text-sm" style={{ color: "var(--text-muted)" }}>{load === "ready" ? "No events" : "Couldn't load"}</span>} />
        {events.map((event) => <PhoneEventCard key={event.vaultNoteId ?? event.id} event={event} day={day} onClick={onEventClick} />)}
      </section>;
    })}
  </div>;
}

/** A month a thumb can use: each day is ONE target (number + up to three marks); the chosen day's
 *  events are listed under the grid, where their titles can be read. */
function PhoneMonthGrid({ days, month, today, selectedDate, eventsByDate, onSelect }: {
  days: Date[]; month: number; today: Date; selectedDate: Date | null; eventsByDate: Map<string, CalEvent[]>; onSelect: (d: Date) => void;
}) {
  return <div className="flex-shrink-0 pt-2">
    <div className="grid grid-cols-7">
      {weekdayOrder().map((d) => <div key={d} className="py-1 text-center text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>{WEEKDAYS[d]}</div>)}
    </div>
    <div className="grid grid-cols-7">
      {days.map((day) => {
        const isMonth = day.getMonth() === month;
        const isToday = isSameDay(day, today);
        const isSel = selectedDate ? isSameDay(day, selectedDate) : false;
        const count = (eventsByDate.get(dateKey(day)) ?? []).length;
        return <button key={dateKey(day)} onClick={() => onSelect(day)} aria-pressed={isSel} data-outside-month={isMonth ? undefined : "true"}
          aria-label={`Select ${day.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}${count ? `, ${count} ${count === 1 ? "event" : "events"}` : ""}`}
          className="focus-ring flex min-h-[52px] min-w-0 flex-col items-center gap-1 rounded-lg pt-1.5" style={{ background: isSel ? "var(--glass-active)" : "transparent" }}>
          <span className="flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium" style={{ color: isToday ? "var(--action-fg, white)" : isMonth ? "var(--text-primary)" : "var(--text-muted)", background: isToday ? "var(--action-bg, var(--color-accent))" : "transparent" }}>{day.getDate()}</span>
          <span aria-hidden className="flex h-1.5 items-center gap-0.5">
            {Array.from({ length: Math.min(count, 3) }, (_, i) => <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: isMonth ? "var(--color-accent)" : "var(--text-muted)" }} />)}
          </span>
        </button>;
      })}
    </div>
  </div>;
}

// ─── Week View ───────────────────────────────────────────────

function WeekView({ days, today, selectedDate, eventsByDate, onSelect, onEventClick }: {
  days: Date[]; today: Date; selectedDate: Date | null;
  eventsByDate: Map<string, CalEvent[]>; onSelect: (d: Date) => void; onEventClick: (ev: CalEvent) => void;
}) {
  // Phone: open on the morning, not on seven empty hours after midnight.
  const mobile = useIsMobile();
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => { if (mobile && grid.current) grid.current.scrollTop = 7 * 48; }, [mobile]);
  return (
    <div className="min-w-[640px] flex-1 flex flex-col min-h-0">
      {/* Day headers */}
      <div className="grid grid-cols-8 flex-shrink-0" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <div /> {/* empty corner for time column */}
        {days.map((d, i) => {
          const isToday = isSameDay(d, today);
          const isSel = selectedDate ? isSameDay(d, selectedDate) : false;
          return (
            <button key={i} onClick={() => onSelect(d)} aria-label={mobile ? `Open ${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}` : undefined} className="text-center py-2 hover:bg-[var(--glass-hover)] transition-colors"
              style={{ background: isSel ? "var(--glass-active)" : "transparent", borderLeft: "1px solid var(--glass-border)" }}>
              <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{WEEKDAYS[d.getDay()]}</div>
              <div className="text-sm font-medium w-7 h-7 mx-auto flex items-center justify-center rounded-full"
                style={{ color: isToday ? "var(--action-fg, white)" : "var(--text-primary)", background: isToday ? "var(--action-bg, var(--color-accent))" : "transparent" }}>
                {d.getDate()}
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-8 border-b text-xs" style={{ borderColor: "var(--glass-border)" }}>
        <span className="p-2" style={{ color: "var(--text-muted)" }}>All day</span>
        {days.map((day) => <div key={dateKey(day)} className="min-w-0 space-y-1 border-l p-1" style={{ borderColor: "var(--glass-border)" }}>
          {(eventsByDate.get(dateKey(day)) ?? []).filter((event) => !event.start?.dateTime).map((event) => <button key={event.vaultNoteId ?? event.id} onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); onEventClick(event); }} className="focus-ring w-full truncate rounded px-1 py-2 text-left" style={{ background: "var(--glass-active)" }}>{event.summary || "Event"}</button>)}
        </div>)}
      </div>
      {/* Time grid */}
      <div ref={grid} className="flex-1 overflow-auto">
        <div className="grid grid-cols-8" style={{ minHeight: 24 * 48 }}>
          {/* Time labels */}
          <div>
            {HOURS.map((h) => (
              <div key={h} className="text-[10px] text-right pr-2" style={{ height: 48, color: "var(--text-muted)", paddingTop: 2 }}>
                {hourLabel(h, true)}
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
                {layoutCalendarDay(dayEvts, d).map(({ event: ev, start, end, column, columns }, ei) => {
                  return (
                    <button key={ei} onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); onEventClick(ev); }} className="focus-ring absolute rounded px-1 py-0.5 text-left text-[10px] overflow-hidden hover:opacity-100 transition-opacity"
                      style={{ top: start * 0.8 + 2, height: (end - start) * 0.8 - 4, left: `calc(${column / columns * 100}% + 2px)`, width: `calc(${100 / columns}% - 4px)`, background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)", opacity: 0.9 }}>
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

function DayView({ load, date, today, events, onEventClick }: { load: LoadState; date: Date; today: Date; events: CalEvent[]; onEventClick: (ev: CalEvent) => void }) {
  const mobile = useIsMobile();
  const isToday = isSameDay(date, today);
  if (mobile) return <div className="space-y-3 overflow-auto p-4">
    {!events.length && <EmptyDay load={load} skeleton className="py-8 text-center text-sm">No events for this day.</EmptyDay>}
    {byStart(events).map((event) => <PhoneEventCard key={event.vaultNoteId ?? event.id} event={event} day={date} onClick={onEventClick} />)}
  </div>;

  return (
    <div className="flex-1 overflow-auto">
      {events.some((event) => !event.start?.dateTime) && <div className="space-y-2 border-b p-3" style={{ borderColor: "var(--glass-border)" }}>
        <h3 className="text-xs" style={{ color: "var(--text-muted)" }}>All day</h3>
        {events.filter((event) => !event.start?.dateTime).map((event) => <button key={event.vaultNoteId ?? event.id} onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); onEventClick(event); }} className="interactive focus-ring block w-full rounded-lg px-3 py-2 text-left text-sm" style={{ background: "var(--glass-active)" }}>{event.summary || "Event"}</button>)}
      </div>}
      <div className="grid grid-cols-[60px_1fr]" style={{ minHeight: 24 * 48 }}>
        {/* Time labels */}
        <div>
          {HOURS.map((h) => (
            <div key={h} className="text-[10px] text-right pr-2" style={{ height: 48, color: "var(--text-muted)", paddingTop: 2 }}>
              {hourLabel(h, false)}
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
          {layoutCalendarDay(events, date).map(({ event: ev, start, end, column, columns }, i) => {
            return (
              <button key={i} onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); onEventClick(ev); }} className="focus-ring absolute rounded-md px-2 py-1 text-left overflow-hidden hover:opacity-100 transition-opacity"
                style={{ top: start * 0.8, height: (end - start) * 0.8, left: `calc(${column / columns * 100}% + 4px)`, width: `calc(${100 / columns}% - 8px)`, background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)", opacity: 0.9 }}>
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
          {event.end?.dateTime && ` – ${event.start?.dateTime ? timeOnDay(event.end.dateTime, calendarDate(event.start.dateTime)) : formatTime(event.end.dateTime)}`}
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
    <div className="min-w-0 p-4 space-y-5 max-md:px-0">
      <div className="flex items-start justify-between">
        <h3 className="min-w-0 break-words text-xl font-semibold pr-2" style={{ color: "var(--text-primary)" }}>{event.summary || "Untitled"}</h3>
        <button aria-label="Close event details" onClick={onClose} className="focus-ring hidden md:flex min-h-control min-w-control items-center justify-center rounded-lg hover:bg-[var(--glass-hover)] flex-shrink-0">
          <X size={14} style={{ color: "var(--text-muted)" }} />
        </button>
      </div>

      {/* Time */}
      <div className="flex items-center gap-2">
        <Clock size={12} style={{ color: "var(--text-muted)" }} />
        <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
          <div>{event.start?.dateTime || event.start?.date ? fmtDate(calendarDate(event.start.dateTime || event.start.date!), { weekday: "long", month: "long", day: "numeric" }, { locale: "en-US" }) : "Date unavailable"}</div>
          <div>
            {formatTime(event.start?.dateTime) || "All day"}
            {event.end?.dateTime && ` – ${event.start?.dateTime ? timeOnDay(event.end.dateTime, calendarDate(event.start.dateTime)) : formatTime(event.end.dateTime)}`}
          </div>
        </div>
      </div>

      {/* Location */}
      {event.location && (
        <div className="flex items-center gap-2">
          <MapPin size={12} className="flex-shrink-0" style={{ color: "var(--text-muted)" }} />
          <span className="min-w-0 text-sm [overflow-wrap:anywhere]" style={{ color: "var(--text-secondary)" }}>{event.location}</span>
        </div>
      )}

      {/* RSVP — near the top: the one thing most often done to an invitation. */}
      {canRsvp && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="event-rsvp">
          {!rsvpNA && <span className="text-sm" style={{ color: "var(--text-muted)" }}>RSVP</span>}
          {!rsvpNA && (["accepted", "tentative", "declined"] as RsvpResponse[]).map((r) => (
            <button key={r} onClick={() => rsvp(r)} className="focus-ring min-h-control min-w-control px-3 py-1.5 rounded-lg text-sm transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
              {r === "accepted" ? "Yes" : r === "tentative" ? "Maybe" : "No"}
            </button>
          ))}
          {rsvpMsg && <span className="text-sm" style={{ color: "var(--text-muted)" }}>{rsvpMsg}</span>}
        </div>
      )}

      {/* Meet link */}
      {meetUrl && (
        <a
          href={meetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring flex min-h-control items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors hover:bg-[var(--glass-hover)]"
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
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Attendees</span>
          </div>
          <div className="space-y-0.5">
            {event.attendees.map((a, i) => (
              <div key={i} className="min-w-0 break-words py-1 text-sm" style={{ color: "var(--text-secondary)" }}>
                {a.displayName || a.email}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      {event.description && (
        <div className="break-words text-sm leading-relaxed whitespace-pre-wrap rounded-lg p-3" style={{ color: "var(--text-secondary)", background: "var(--glass)" }}>
          {event.description}
        </div>
      )}

      <EventTranscripts noteId={event.vaultNoteId} eventId={event.id} onOpen={onOpenTranscript} />

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-4" style={{ borderTop: "1px solid var(--glass-border)" }}>
        <button onClick={onOpenNotes} className="focus-ring flex min-h-control items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--color-accent)", border: "1px solid var(--glass-border)" }}>
          <FileText size={12} /> Meeting Notes
        </button>
        {canMutate && (
          <>
            <button onClick={onEdit} className="focus-ring flex min-h-control items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
              <Pencil size={12} /> Edit
            </button>
            <button
              onClick={() => (isDesktop ? void onDelete(true) : setConfirmDelete(true))}
              aria-label="Delete event"
              title="Delete event"
              className="focus-ring flex min-h-control min-w-control items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors hover:bg-[var(--glass-hover)]"
              style={{ color: "var(--color-danger)", border: "1px solid var(--glass-border)" }}
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
      {confirmDelete && !isDesktop && (
        <div className="space-y-2 rounded p-2" style={{ border: "1px solid var(--color-danger)" }} role="alertdialog" aria-label="Confirm delete">
          <div className="text-sm" style={{ color: "var(--text-primary)" }}>
            Delete this occurrence from Google Calendar? Only this one is removed if the event repeats. Its meeting note is kept (marked cancelled).
          </div>
          {(event.attendees?.length ?? 0) > 0 && (
            <label className="flex items-center gap-1.5 text-xs coarse:min-h-[var(--touch-target)] coarse:gap-3 coarse:text-sm" style={{ color: "var(--text-secondary)" }}>
              <input type="checkbox" className="coarse:h-5 coarse:w-5 flex-shrink-0" checked={notifyGuests} onChange={(e) => setNotifyGuests(e.target.checked)} />
              {notifyGuests ? "Guests will be emailed a cancellation" : "Don't email guests"}
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void doDelete()}
              disabled={deleting}
              className="focus-ring min-h-control px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
              style={{ background: "var(--danger-bg, var(--color-danger))", color: "#fff" }}
            >
              {deleting ? "Deleting..." : "Delete this occurrence"}
            </button>
            <button onClick={() => { setConfirmDelete(false); setDeleteError(null); }} disabled={deleting} className="focus-ring min-h-control px-3 py-1.5 rounded-lg text-sm" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
              Cancel
            </button>
          </div>
          {deleteError && <div className="text-sm" style={{ color: "var(--color-danger)" }}>{deleteError}</div>}
          {seriesConfirm && (
            <div className="space-y-1 pt-1" style={{ borderTop: "1px solid var(--glass-border)" }}>
              <div className="text-xs font-medium" style={{ color: "var(--color-danger)" }}>
                This removes EVERY occurrence of the series from Google Calendar{notifyGuests && (event.attendees?.length ?? 0) > 0 ? " and emails every guest" : ""}.
              </div>
              <button
                onClick={() => void doDelete("all")}
                disabled={deleting}
                className="focus-ring min-h-control px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: "var(--danger-bg, var(--color-danger))", color: "#fff" }}
                data-testid="delete-all-occurrences"
              >
                Delete ALL occurrences
              </button>
            </div>
          )}
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
  const dateStr = defaultDate ? `${defaultDate.getFullYear()}-${String(defaultDate.getMonth() + 1).padStart(2, "0")}-${String(defaultDate.getDate()).padStart(2, "0")}` : dateKey(new Date());

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
    <div className="p-3 space-y-3 max-md:px-0">
      {/* Phone: the sheet's own header names the form and closes it. */}
      <div className="hidden md:flex items-center justify-between">
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
          className="w-full rounded px-2 py-1.5 text-xs outline-none coarse:min-h-[var(--touch-target)]"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          autoFocus
        />

        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Event date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="col-span-2 min-w-0 rounded px-2 py-2 text-base outline-none coarse:min-h-[var(--touch-target)]"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
          <input aria-label="Start time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
            className="min-w-0 rounded px-2 py-2 text-base outline-none coarse:min-h-[var(--touch-target)]"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
          <input aria-label="End time" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
            className="min-w-0 rounded px-2 py-2 text-base outline-none coarse:min-h-[var(--touch-target)]"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
        </div>

        <input
          value={locationVal}
          onChange={(e) => setLocationVal(e.target.value)}
          placeholder="Location"
          className="w-full rounded px-2 py-1.5 text-xs outline-none coarse:min-h-[var(--touch-target)]"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />

        <input
          value={attendeesVal}
          onChange={(e) => setAttendeesVal(e.target.value)}
          placeholder="Attendees (comma-separated emails)"
          className="w-full rounded px-2 py-1.5 text-xs outline-none coarse:min-h-[var(--touch-target)]"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />
        {live && !isEdit && attendeesVal.trim() && (
          <label className="flex items-center gap-1.5 text-xs coarse:min-h-[var(--touch-target)] coarse:gap-3 coarse:text-sm" style={{ color: "var(--text-secondary)" }}>
            <input type="checkbox" className="coarse:h-5 coarse:w-5 flex-shrink-0" checked={notifyAttendees} onChange={(e) => setNotifyAttendees(e.target.checked)} />
            {notifyAttendees ? "Attendees will be emailed an invite" : "Don't email attendees an invite"}
          </label>
        )}
        {live && isEdit && ((event?.attendees?.length ?? 0) > 0 || attendeesVal.trim()) && (
          <label className="flex items-center gap-1.5 text-xs coarse:min-h-[var(--touch-target)] coarse:gap-3 coarse:text-sm" style={{ color: "var(--text-secondary)" }}>
            <input type="checkbox" className="coarse:h-5 coarse:w-5 flex-shrink-0" checked={notifyAttendees} onChange={(e) => setNotifyAttendees(e.target.checked)} />
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
        className="w-full py-2 rounded text-xs font-medium transition-colors disabled:opacity-50 coarse:min-h-[var(--touch-target)] coarse:text-sm"
        style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
      >
        {saving ? "Saving..." : isEdit ? "Update Event" : "Create Event"}
      </button>
      {!canSave && <p role="status" className="text-xs">Calendar editing is unavailable. Reconnect to your server and try again.</p>}
      {saveError && <div role="alert" className="text-xs" style={{ color: "var(--color-danger)" }}>{saveError}</div>}
      {seriesEdit && live && isEdit && (
        <button
          onClick={() => void handleSave(true)}
          disabled={saving}
          className="w-full py-1.5 rounded text-xs font-medium disabled:opacity-50 coarse:min-h-[var(--touch-target)] coarse:text-sm"
          style={{ background: "var(--danger-bg, var(--color-danger))", color: "#fff" }}
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
