import { invoke } from "@tauri-apps/api/core";
import { vaultApi } from "../parachute/client";

export interface SyncConfig {
  adapter: string;
  remote_id: string;
  last_synced: string;
  direction: string;
  conflict_strategy: string;
  auto_sync: boolean;
}

export interface SyncStatus {
  adapter: string;
  remote_id: string;
  state: "synced" | "syncing" | "conflict" | "error" | "never_synced";
  last_synced: string | null;
  error: string | null;
}

export interface SyncResult {
  status: "no_change" | "pushed" | "pulled" | "conflict" | "error";
  content?: string;
  local?: string;
  remote?: string;
  message?: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  start: { dateTime: string | null; date: string | null; timeZone: string | null };
  end: { dateTime: string | null; date: string | null; timeZone: string | null };
  location: string | null;
  attendees: { email: string; displayName: string | null; responseStatus: string | null }[];
  meetUrl: string | null;
  calendarId: string;
  status: string;
  htmlLink: string | null;
}

export const syncApi = {
  trigger: (noteId: string) =>
    invoke<SyncResult[]>("sync_trigger", { noteId }),

  pull: (noteId: string) =>
    invoke<SyncResult>("sync_pull", { noteId }),

  status: (noteId: string) =>
    invoke<SyncStatus[]>("sync_status", { noteId }),

  addConfig: (noteId: string, adapter: string, direction?: string, autoSync?: boolean) =>
    invoke<void>("sync_add_config", { noteId, adapter, direction, autoSync }),

  removeConfig: (noteId: string, adapter: string, remoteId: string) =>
    invoke<void>("sync_remove_config", { noteId, adapter, remoteId }),

  resolveConflict: (noteId: string, adapter: string, resolution: string, mergedContent?: string) =>
    invoke<void>("sync_resolve_conflict", { noteId, adapter, resolution, mergedContent }),
};

export const calendarApi = {
  listEvents: (from: string, to: string, calendarId?: string) =>
    invoke<CalendarEvent[]>("calendar_list_events", { from, to, calendarId }),

  createEvent: (summary: string, start: string, end: string, attendees?: string[], description?: string, location?: string, withMeet?: boolean) =>
    invoke<CalendarEvent>("calendar_create_event", { summary, start, end, attendees, description, location, withMeet }),

  updateEvent: (eventId: string, summary?: string, start?: string, end?: string, attendees?: string[], description?: string, location?: string) =>
    invoke<CalendarEvent>("calendar_update_event", { eventId, summary, start, end, attendees, description, location }),

  deleteEvent: (eventId: string) =>
    invoke<void>("calendar_delete_event", { eventId }),

  /** On-demand sync: fetch Google Calendar events for a date range into Parachute */
  syncRange: (from: string, to: string) =>
    invoke<{ synced: number; errors: number; total: number; from: string; to: string }>(
      "calendar_sync_range", { from, to }
    ),

  /**
   * Read events from the Parachute vault (the `meeting` notes the desktop
   * calendar-sync service persists), NOT live from Google. This goes through the
   * VaultClient seam, so it works in BOTH shells — including the web PWA, which
   * has no Google access. Returns the same `CalendarEvent` shape as `listEvents`.
   *
   * `from`/`to` are ISO datetime strings; an event is included when it overlaps
   * that window.
   */
  listEventsFromVault: async (from: string, to: string): Promise<CalendarEvent[]> => {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const notes = await vaultApi.listNotes({ tag: "meeting", limit: 5000 });

    const events: CalendarEvent[] = [];
    for (const note of notes) {
      const m = (note.metadata ?? {}) as Record<string, unknown>;
      const startRaw = (m.start as string) || (m.date as string) || null;
      if (!startRaw) continue;
      const endRaw = (m.end as string) || startRaw;

      const startMs = Date.parse(startRaw);
      if (Number.isNaN(startMs)) continue;
      const endMs = Date.parse(endRaw);
      // Overlap test: event ends after the window starts AND starts before it ends.
      if ((Number.isNaN(endMs) ? startMs : endMs) < fromMs || startMs > toMs) continue;

      const hasTime = startRaw.includes("T");
      const attendees = Array.isArray(m.attendees) ? (m.attendees as unknown[]) : [];

      events.push({
        id: (m.calendarEventId as string) || note.id,
        summary: (m.title as string) || note.path?.split("/").pop() || "Untitled Event",
        description: (m.description as string) ?? null,
        start: { dateTime: hasTime ? startRaw : null, date: hasTime ? null : startRaw, timeZone: null },
        end: { dateTime: hasTime ? endRaw : null, date: hasTime ? null : endRaw, timeZone: null },
        location: (m.location as string) ?? null,
        attendees: attendees.map((a) => {
          const s = String(a);
          return { email: s, displayName: s, responseStatus: null };
        }),
        meetUrl: (m.meetLink as string) ?? null,
        calendarId: "primary",
        status: (m.event_status as string) || "confirmed",
        htmlLink: (m.htmlLink as string) ?? null,
      });
    }
    return events;
  },
};
