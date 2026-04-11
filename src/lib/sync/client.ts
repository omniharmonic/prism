import { invoke } from "@tauri-apps/api/core";

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

  updateEvent: (eventId: string, summary?: string, start?: string, end?: string, attendees?: string[], description?: string) =>
    invoke<CalendarEvent>("calendar_update_event", { eventId, summary, start, end, attendees, description }),

  deleteEvent: (eventId: string) =>
    invoke<void>("calendar_delete_event", { eventId }),
};
