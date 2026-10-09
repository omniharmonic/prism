import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveActionsProvider, PlatformProvider, VaultClientProvider, useAgentChatStore, useUIStore, type Note, type VaultClient } from "@prism/core";
import { LiveActionError, type LiveActionsClient } from "../../../packages/core/src/lib/actions/client";
import { HostServicesProvider } from "../../../packages/core/src/data/HostServicesContext";
import type { HostServices } from "../../../packages/core/src/lib/host/services";
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
if (new URLSearchParams(location.search).has("layout")) notes.push(
  note("trip", "Meetings/Offsite", { title: "Multi-day offsite", start: "2026-10-04", end: "2026-10-07" }),
  note("overnight", "Meetings/Overnight", { title: "Overnight handoff", start: "2026-10-04T23:30:00-06:00", end: "2026-10-05T01:00:00-06:00" }),
  note("overlap-a", "Meetings/Overlap A", { title: "Overlapping A", start: "2026-10-05T10:15:00-06:00", end: "2026-10-05T10:45:00-06:00" }),
  note("overlap-b", "Meetings/Overlap B", { title: "Overlapping B", start: "2026-10-05T10:30:00-06:00", end: "2026-10-05T11:30:00-06:00" }),
  note("spillover", "Meetings/September", { title: "Previous-month meeting", start: "2026-09-30T10:00:00-06:00", end: "2026-09-30T11:00:00-06:00" }),
);
// `?phone`: a realistic week for the phone audit (calendar-phone.spec.ts) — several events a day, an
// all-day one, overlaps, a long title, a cancelled event (hidden), a repeating one, an empty day (Oct 8).
if (new URLSearchParams(location.search).has("phone")) {
  const at = (day: number, time: string) => `2026-10-${String(day).padStart(2, "0")}T${time}:00-06:00`;
  const link = (id: string) => `https://calendar.example.test/${id}`;
  const guests = ["morgan@example.test", "A very long display name for a guest <riley.with.a.long.address@subdomain.example.test>", "sam@example.test"];
  for (const day of [5, 6, 7, 9]) notes.push(note(`standup-${day}`, `Meetings/Standup ${day}`, { title: "Weekly standup", calendarEventId: `standup_202610${String(day).padStart(2, "0")}T143000Z`, start: at(day, "08:30"), end: at(day, "08:45"), attendees: guests, htmlLink: link(`standup-${day}`), meetLink: "https://meet.example.test/standup" }));
  notes.push(
    note("long-title", "Meetings/Long", { title: "Quarterly bioregional funding alignment and cross-team dependency review with external partners (extended working session)", calendarEventId: "long-event", start: at(5, "09:00"), end: at(5, "09:45"), location: "Conference room B, 4th floor — https://maps.example.test/a/very/long/location/link/that/does/not/break/naturally", description: "Agenda:\n1. Budget\n2. Dependencies\n3. Next steps\n\nhttps://docs.example.test/a-very-long-document-link-without-any-break-opportunities-in-it", attendees: guests, htmlLink: link("long"), meetLink: "https://meet.example.test/long" }),
    note("overlap-a", "Meetings/Overlap A", { title: "Overlapping A", calendarEventId: "overlap-a-event", start: at(5, "10:15"), end: at(5, "10:45"), htmlLink: link("oa") }),
    note("overlap-b", "Meetings/Overlap B", { title: "Overlapping B", calendarEventId: "overlap-b-event", start: at(5, "10:30"), end: at(5, "11:30"), htmlLink: link("ob") }),
    note("cancelled", "Meetings/Cancelled", { title: "Cancelled sync", calendarEventId: "cancelled-event", start: at(5, "12:00"), end: at(5, "12:30"), event_status: "cancelled", htmlLink: link("c") }),
    note("series", "Meetings/Series", { title: "Monthly review (series)", calendarEventId: "series-master", start: at(5, "16:00"), end: at(5, "17:00"), attendees: guests, htmlLink: link("series") }),
    note("evening", "Meetings/Evening", { title: "Evening call", calendarEventId: "evening-event", start: at(5, "21:00"), end: at(5, "22:30"), htmlLink: link("e") }),
    note("local-only", "Meetings/Local", { title: "Vault-only meeting note", start: at(6, "13:00"), end: at(6, "14:00") }),
    note("tue-a", "Meetings/Tue A", { title: "Partner call", calendarEventId: "tue-a-event", start: at(6, "10:00"), end: at(6, "11:00"), htmlLink: link("ta") }),
    note("tue-b", "Meetings/Tue B", { title: "Lunch with Riley", calendarEventId: "tue-b-event", start: at(6, "12:00"), end: at(6, "13:00"), location: "Café", htmlLink: link("tb") }),
    note("wed-a", "Meetings/Wed A", { title: "Planning", calendarEventId: "wed-a-event", start: at(7, "15:00"), end: at(7, "16:00"), htmlLink: link("wa") }),
    note("trip", "Meetings/Offsite", { title: "Multi-day offsite", calendarEventId: "trip-event", start: "2026-10-09", end: "2026-10-11", htmlLink: link("trip") }),
    ...[1, 2, 3, 4, 5].map((n) => note(`busy-${n}`, `Meetings/Busy ${n}`, { title: `Busy day item ${n}`, calendarEventId: `busy-${n}-event`, start: at(20, `${String(8 + n).padStart(2, "0")}:00`), end: at(20, `${String(8 + n).padStart(2, "0")}:45`), htmlLink: link(`busy-${n}`) })),
  );
}
// Loading (calendar-phone.spec.ts "loading"): `?list=<ms>` delays the vault listing; `?sync[=<ms>]`
// gives the page a FAKE host whose Google sync takes that long (`&syncfail` rejects it, `&syncadds`
// makes it persist one new meeting note, as the server's ingest would). Nothing leaves the page.
const query = new URLSearchParams(location.search);
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const controls = { syncFail: query.has("syncfail"), lists: 0, syncs: [] as { from: string; to: string }[], deny: false, searches: 0, writes: 0, reads: [] as string[], updates: [] as unknown[], creates: [] as unknown[], rsvps: [] as unknown[], deletes: [] as unknown[] };
const vault = {
  listNotes: async () => { controls.lists++; await wait(Number(query.get("list") ?? 0)); return notes.filter((n) => n.tags?.includes("meeting")); },
  getNote: async (id: string) => { controls.reads.push(id); if (controls.deny && id.startsWith("recording")) throw new Error("Denied"); const n = notes.find((n) => n.id === id); if (!n) throw new Error("Missing"); return n; },
  getLinks: async (id: string) => id === "meeting-one" ? [{ sourceId: id, targetId: "recording-one", relationship: "has-transcript" }, { sourceId: id, targetId: "recording-two", relationship: "has-transcript" }] : [],
  search: async () => { controls.searches++; return notes.filter((n) => n.id === "unrelated"); },
  createNote: async () => { controls.writes++; throw new Error("Opening must not create"); },
} as unknown as VaultClient;
const live = {
  status: async () => ({ matrix: { enabled: false, configured: false }, email: { enabled: false, configured: false }, calendar: { enabled: true, configured: true } }),
  calendarUpdate: async (p: unknown) => { controls.updates.push(p); return {}; },
  // Fakes only — nothing here reaches a calendar. The series id is refused until "ALL occurrences", as the server does.
  calendarCreate: async (p: unknown) => { controls.creates.push(p); return { eventId: "created", htmlLink: null }; },
  calendarRsvp: async (eventId: string, response: string) => { controls.rsvps.push({ eventId, response }); return { eventId, response }; },
  calendarDelete: async (eventId: string, o: { notify?: boolean; scope?: "all" } = {}) => {
    controls.deletes.push({ eventId, ...o });
    if (eventId === "series-master" && o.scope !== "all") throw new LiveActionError(409, "recurring_series", undefined, false);
    return { eventId, deleted: true };
  },
} as unknown as LiveActionsClient;
const host = query.has("sync") ? {
  calendarSyncRange: async (from: string, to: string) => {
    controls.syncs.push({ from, to });
    await wait(Number(query.get("sync") || 0));
    if (controls.syncFail) throw new Error("gog: the calendar could not be reached");
    const adds = query.has("syncadds") && !notes.some((n) => n.id === "synced-later");
    if (adds) notes.push(note("synced-later", "Meetings/Synced later", { title: "Synced later", calendarEventId: "synced-later-event", start: "2026-10-07T17:00:00-06:00", end: "2026-10-07T17:30:00-06:00", htmlLink: "https://calendar.example.test/later" }));
    return { synced: 3, errors: 0, total: 3, from, to, created: adds ? 1 : 0, updated: 0, unchanged: adds ? 2 : 3, deleted: 0, cancelled: 0 };
  },
} as unknown as HostServices : null;
useAgentChatStore.setState({ scope: "calendar-fixture-owner-vault" });
Object.assign(window, { prismCalendarFixture: controls, prismCalendarUI: useUIStore });
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PlatformProvider value="web"><VaultClientProvider client={vault}><LiveActionsProvider client={live}><HostServicesProvider client={host}><div style={{ height: "100dvh" }}><CalendarDashboard note={note("calendar", "Calendar", {})} /></div></HostServicesProvider></LiveActionsProvider></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
