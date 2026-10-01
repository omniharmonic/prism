import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveActionsProvider, PlatformProvider, VaultClientProvider, useAgentChatStore, useUIStore, type Note, type VaultClient } from "@prism/core";
import type { LiveActionsClient } from "../../../packages/core/src/lib/actions/client";
import CalendarDashboard from "../../../packages/core/src/components/comms/CalendarDashboard";

const note = (id: string, path: string, metadata: Record<string, unknown>, tags = ["meeting"]): Note => ({ id, path, metadata, tags, content: "Synthetic meeting record.", createdAt: "2026-10-01", updatedAt: "2026-10-01" });
const notes = [
  note("meeting-one", "Meetings/Original record", { title: "Design review", calendarEventId: "event-one", start: "2026-10-05T10:00:00-06:00", end: "2026-10-05T11:00:00-06:00", timeZone: "America/Denver", transcriptNoteId: "recording-one", attendees: ["Morgan"], htmlLink: "https://calendar.example.test/one" }),
  note("meeting-two", "Meetings/Another record", { title: "Design review", calendarEventId: "event-two", start: "2026-10-05T14:00:00-06:00", end: "2026-10-05T15:00:00-06:00", htmlLink: "https://calendar.example.test/two" }),
  note("all-day", "Meetings/Workshop", { title: "All-day workshop", calendarEventId: "all-day-event", start: "2026-10-05", end: "2026-10-06", htmlLink: "https://calendar.example.test/day" }),
  note("recording-one", "Transcripts/First recording", { date: "2026-10-05" }, ["transcript"]),
  note("recording-two", "Transcripts/Second recording", { date: "2026-10-05" }, ["transcript"]),
  note("unrelated", "Transcripts/Unrelated same-day recording", { date: "2026-10-05" }, ["transcript"]),
];
const controls = { deny: false, searches: 0, writes: 0, reads: [] as string[], updates: [] as unknown[] };
const vault = {
  listNotes: async () => notes.filter((n) => n.tags?.includes("meeting")),
  getNote: async (id: string) => { controls.reads.push(id); if (controls.deny && id.startsWith("recording")) throw new Error("Denied"); const n = notes.find((n) => n.id === id); if (!n) throw new Error("Missing"); return n; },
  getLinks: async (id: string) => id === "meeting-one" ? [{ sourceId: id, targetId: "recording-one", relationship: "has-transcript" }, { sourceId: id, targetId: "recording-two", relationship: "has-transcript" }] : [],
  search: async () => { controls.searches++; return notes.filter((n) => n.id === "unrelated"); },
  createNote: async () => { controls.writes++; throw new Error("Opening must not create"); },
} as unknown as VaultClient;
const live = {
  status: async () => ({ matrix: { enabled: false, configured: false }, email: { enabled: false, configured: false }, calendar: { enabled: true, configured: true } }),
  calendarUpdate: async (p: unknown) => { controls.updates.push(p); return {}; },
} as unknown as LiveActionsClient;
useAgentChatStore.setState({ scope: "calendar-fixture-owner-vault" });
Object.assign(window, { prismCalendarFixture: controls, prismCalendarUI: useUIStore });
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PlatformProvider value="web"><VaultClientProvider client={vault}><LiveActionsProvider client={live}><div style={{ height: "100dvh" }}><CalendarDashboard note={note("calendar", "Calendar", {})} /></div></LiveActionsProvider></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
