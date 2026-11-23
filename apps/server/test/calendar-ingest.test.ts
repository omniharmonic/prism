/**
 * Server Calendar ingest (Architecture v2 WP1.3). Fake vault + fake `gog` only —
 * the real CLI is never invoked (it reads OAuth from the macOS keychain). All
 * fixture data is synthetic.
 *
 * The fake vault behaves like the real one where it matters: a POST to a taken
 * path is a 409 unless `if_exists` is set ("ignore" returns the existing note);
 * PATCH merges metadata (RFC 7386: null deletes), unions links, adds/removes tags;
 * lean listings carry `links` but no content.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Note, NoteLinkInput } from "../src/parachute";
import {
  ARCHIVED_TAG,
  ATTENDED_BY,
  HAS_TRANSCRIPT,
  CalendarClient,
  buildMeetingNote,
  extractEvents,
  isTemplateOnly,
  normalizeAttendee,
  significantWords,
  syncCalendarWindow,
  syncWindow,
  calendarMode,
  runCalendarOnce,
  readCalendarIntents,
  setCalendarGogRunnerForTests,
  type CalEvent,
  type CalendarPassOptions,
  type CalendarVault,
} from "../src/worker/calendar";
import { rustSanitizePath } from "../src/worker/people";
import { config, parseCalendarDeleteMode } from "../src/config";
import { resetDb, installFakeVault, makeSession, sessionCookie, makeCapability, type FakeVault } from "./helpers";
import { putSecret } from "../src/secrets";
import { getVaultRegistry } from "../src/db";
import { getSourceHealth, recordSourceOutcome, resetSourceHealth } from "../src/worker/health";
import { calendar as calendarRoute } from "../src/routes/calendar";
import { acl } from "../src/routes/acl";

// ── fake vault ───────────────────────────────────────────────────────────────

interface Stored extends Note {
  linkSet: Array<{ targetId: string; relationship: string }>;
}

function fakeVault(seed: Array<Partial<Note> & { id: string }> = []) {
  const notes = new Map<string, Stored>();
  for (const n of seed)
    notes.set(n.id, { content: "", path: null, metadata: null, createdAt: "", updatedAt: "", tags: null, ...n, linkSet: [] } as Stored);
  const log = { creates: 0, updates: 0, deletes: 0, conflicts: 0, gets: 0, writes: [] as string[] };
  let seq = 0;
  const resolve = (t: string) => notes.get(t) ?? [...notes.values()].find((n) => n.path === t);
  const addLinks = (n: Stored, links: NoteLinkInput[] = []) => {
    for (const l of links) {
      const t = resolve(l.target);
      if (t && !n.linkSet.some((x) => x.targetId === t.id && x.relationship === l.relationship)) n.linkSet.push({ targetId: t.id, relationship: l.relationship });
    }
  };
  const merge = (n: Stored, md?: Record<string, unknown>) => {
    if (!md) return;
    const out = { ...(n.metadata ?? {}) };
    for (const [k, v] of Object.entries(md)) if (v === null) delete out[k];
    else out[k] = v;
    n.metadata = out;
  };
  const lean = (n: Stored): Note =>
    ({
      id: n.id,
      path: n.path,
      metadata: n.metadata ? { ...n.metadata } : null,
      tags: n.tags ? [...n.tags] : null,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      links: n.linkSet.map((l) => ({ sourceId: n.id, targetId: l.targetId, relationship: l.relationship })),
    }) as unknown as Note;
  const vault: CalendarVault = {
    async listNotes(o) {
      return [...notes.values()].filter((n) => !o.tags?.length || o.tags.some((t) => n.tags?.includes(t))).map(lean);
    },
    async getNote(id) {
      log.gets++;
      const n = notes.get(id);
      if (!n) throw Object.assign(new Error(`GET /notes/${id}: 404`), { status: 404 });
      return { ...lean(n), content: n.content };
    },
    async createNote(p) {
      const hit = p.path ? [...notes.values()].find((n) => n.path === p.path) : undefined;
      if (hit) {
        if ((p.ifExists ?? "error") === "error") {
          log.conflicts++;
          throw new Error("POST /notes: 409 path_conflict");
        }
        return { ...lean(hit), content: hit.content, existed: true };
      }
      const id = `n${++seq}`;
      const n: Stored = { id, content: p.content, path: p.path ?? null, metadata: p.metadata ? { ...p.metadata } : null, tags: p.tags ?? null, createdAt: "t", updatedAt: "t", linkSet: [] };
      notes.set(id, n);
      addLinks(n, p.links);
      log.creates++;
      log.writes.push(`create ${p.path}`);
      return { ...lean(n), content: n.content, ...(p.ifExists ? { existed: false } : {}) };
    },
    async updateNote(id, p) {
      const n = notes.get(id);
      if (!n) throw new Error(`PATCH /notes/${id}: 404`);
      merge(n, p.metadata);
      addLinks(n, p.links?.add);
      if (p.tags) {
        const s = new Set(n.tags ?? []);
        for (const t of p.tags.add ?? []) s.add(t);
        for (const t of p.tags.remove ?? []) s.delete(t);
        n.tags = [...s];
      }
      log.updates++;
      log.writes.push(`update ${n.path}`);
      return { ...lean(n), content: n.content };
    },
    async deleteNote(id) {
      if (!notes.delete(id)) throw new Error(`DELETE /notes/${id}: 404`);
      log.deletes++;
      log.writes.push(`delete ${id}`);
    },
  };
  const byTag = (t: string) => [...notes.values()].filter((n) => n.tags?.includes(t));
  const totalWrites = () => log.creates + log.updates + log.deletes;
  return { vault, notes, log, byTag, totalWrites };
}

function fakeGog(payload: unknown) {
  const calls: string[][] = [];
  let current = payload;
  const run = async (args: string[]) => {
    calls.push(args);
    return typeof current === "string" ? current : JSON.stringify(current);
  };
  return { calls, run, client: new CalendarClient("someone@example.test", run), set: (p: unknown) => (current = p) };
}

const ev = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: "evt001",
  summary: "Roadmap Review: Q4!",
  description: "Agenda: priorities.",
  location: "Room 7",
  start: { dateTime: "2026-10-05T10:00:00-06:00" },
  end: { dateTime: "2026-10-05T11:00:00-06:00" },
  attendees: [
    { email: "ada@example.test", displayName: "Ada Example" },
    { email: "grace@example.test" },
  ],
  hangoutLink: "https://meet.example.test/abc",
  htmlLink: "https://calendar.example.test/e/evt001",
  status: "confirmed",
  ...over,
});

const WINDOW = { from: "2026-10-01", to: "2026-11-01" };
const opts = (over: Partial<CalendarPassOptions> = {}): CalendarPassOptions => ({
  ...WINDOW,
  max: 250,
  shadow: false,
  deleteMode: "delete",
  source: "worker",
  maxOrphans: 0,
  now: Date.UTC(2026, 9, 1),
  ...over,
});

/** A meeting note exactly as the desktop would have left it for `e`. */
function desktopNote(id: string, e: CalEvent, extra: { content?: string; metadata?: Record<string, unknown>; tags?: string[] } = {}) {
  const m = buildMeetingNote(e);
  return { id, path: m.path, content: extra.content ?? m.content, metadata: { ...m.metadata, ...(extra.metadata ?? {}) }, tags: extra.tags ?? ["meeting"] };
}

// ── pure ports ───────────────────────────────────────────────────────────────

test("sanitize/slug + the Rust unit tests carry over", () => {
  assert.equal(rustSanitizePath("Q2 Roadmap: Review!"), "q2-roadmap--review-");
  assert.ok(!rustSanitizePath("a/b\\c").includes("/"));
  const w = significantWords("Meeting: Q2 Roadmap Review with Acme");
  assert.ok(w.includes("roadmap") && w.includes("review") && w.includes("acme"));
  assert.ok(!w.includes("meeting") && !w.includes("with") && !w.includes("q2"));
  assert.equal(normalizeAttendee("Alice Smith"), "alice smith");
  assert.equal(normalizeAttendee("alice.smith@example.com"), "alice smith");
  assert.equal(normalizeAttendee("O'Brien, Pat"), "o brien pat");
});

test("buildMeetingNote reproduces the desktop note byte-for-byte", () => {
  const m = buildMeetingNote(ev());
  assert.equal(m.path, "vault/meetings/2026-10-05/roadmap-review--q4-");
  assert.equal(
    m.content,
    "# Roadmap Review: Q4!\n\n**Date:** 2026-10-05\n**Time:** 2026-10-05T10:00:00-06:00 — 2026-10-05T11:00:00-06:00\n" +
      "**Location:** Room 7\n**Meet:** https://meet.example.test/abc\n**Attendees:** Ada Example, grace@example.test\n" +
      "\n---\n\nAgenda: priorities.\n\n---\n\n## Meeting Notes\n\n",
  );
  assert.deepEqual(m.metadata, {
    type: "meeting",
    title: "Roadmap Review: Q4!",
    calendarEventId: "evt001",
    date: "2026-10-05",
    start: "2026-10-05T10:00:00-06:00",
    end: "2026-10-05T11:00:00-06:00",
    attendees: ["Ada Example", "grace@example.test"],
    attendeeEmails: ["ada@example.test", "grace@example.test"],
    calendarProvider: "google",
    location: "Room 7",
    meetLink: "https://meet.example.test/abc",
    htmlLink: "https://calendar.example.test/e/evt001",
    event_status: "confirmed",
  });
});

test("buildMeetingNote edge cases: all-day, no summary, conference link, missing id, present-but-null displayName", () => {
  const m = buildMeetingNote({ id: "x", start: { date: "2026-10-09" }, end: { date: "2026-10-10" }, conferenceData: { entryPoints: [{ uri: "https://conf.example.test/1" }] } });
  assert.equal(m.path, "vault/meetings/2026-10-09/untitled-event");
  assert.equal(m.metadata.meetLink, "https://conf.example.test/1");
  assert.equal(m.metadata.location, null);
  assert.equal(m.content, "# Untitled Event\n\n**Date:** 2026-10-09\n**Time:** 2026-10-09 — 2026-10-10\n**Meet:** https://conf.example.test/1\n\n---\n\n## Meeting Notes\n\n");
  assert.equal(buildMeetingNote({ id: "y" }).date, "unknown");
  assert.throws(() => buildMeetingNote({ summary: "no id" }), /missing id/);
  // serde `get("displayName").or(get("email"))`: a present null displayName wins, then is not a string → skipped.
  assert.deepEqual(buildMeetingNote(ev({ attendees: [{ displayName: null, email: "z@example.test" }] })).attendees, []);
});

test("isTemplateOnly: only the auto body under the LAST marker; no marker → false", () => {
  assert.equal(isTemplateOnly(buildMeetingNote(ev()).content), true);
  assert.equal(isTemplateOnly(buildMeetingNote(ev()).content + "<p></p>\n---\n"), true);
  assert.equal(isTemplateOnly(buildMeetingNote(ev()).content + "Decided to ship."), false);
  assert.equal(isTemplateOnly("<h2>Meeting Notes</h2><p>x</p>"), false);
  assert.equal(isTemplateOnly("# Something else entirely"), false);
});

test("extractEvents / syncWindow", () => {
  assert.equal(extractEvents([ev()]).events.length, 1);
  assert.equal(extractEvents({ events: [ev()] }).recognized, true);
  assert.equal(extractEvents({ items: [] }).recognized, true);
  assert.equal(extractEvents({}).recognized, false);
  assert.equal(extractEvents({ events: [], nextPageToken: "p2" }).nextPageToken, "p2");
  assert.deepEqual(syncWindow(Date.UTC(2026, 8, 30, 23, 0)), { from: "2026-09-27", to: "2026-10-31" });
});

test("parseCalendarDeleteMode fails safe to log", () => {
  assert.equal(parseCalendarDeleteMode(undefined), "log");
  assert.equal(parseCalendarDeleteMode("DELETE"), "delete");
  assert.equal(parseCalendarDeleteMode("archive"), "archive");
  assert.equal(parseCalendarDeleteMode("delet"), "log");
});

// ── the pass ─────────────────────────────────────────────────────────────────

test("gog is invoked with the desktop's exact argv", async () => {
  const g = fakeGog({ events: [] });
  await g.client.listEventsRange("2026-10-01", "2026-11-01", 250);
  assert.deepEqual(g.calls[0], ["calendar", "list", "--from", "2026-10-01", "--to", "2026-11-01", "--max", "250", "--account", "someone@example.test", "--json"]);
});

test("new event: one note at the desktop path, template content, tag meeting, if_exists, attendees linked", async () => {
  const v = fakeVault();
  const r = await syncCalendarWindow(fakeGog({ events: [ev()] }).client, v.vault, opts());
  assert.equal(r.created, 1);
  const [n] = v.byTag("meeting");
  assert.equal(n!.path, "vault/meetings/2026-10-05/roadmap-review--q4-");
  assert.equal(n!.content, buildMeetingNote(ev()).content);
  const people = v.byTag("person");
  assert.equal(people.length, 1, "email-only attendee name is refused as a person, like the desktop");
  assert.equal(people[0]!.path, "vault/people/ada-example");
  assert.deepEqual(n!.linkSet, [{ targetId: people[0]!.id, relationship: ATTENDED_BY }]);
  assert.equal(v.log.conflicts, 0);
});

test("converges on a desktop-created note (by calendarEventId): no duplicate, same path, body untouched", async () => {
  const body = buildMeetingNote(ev()).content + "User wrote this.";
  const v = fakeVault([
    desktopNote("d1", ev(), { content: body, metadata: { summaryOld: "kept", event_status: "tentative" } }),
    { id: "p1", path: "vault/people/ada-example", tags: ["person"], metadata: { name: "Ada Example" }, content: "# Ada Example" },
  ]);
  const r = await syncCalendarWindow(fakeGog({ events: [ev()] }).client, v.vault, opts());
  assert.equal(r.created, 0);
  assert.equal(r.updated, 1);
  assert.equal(v.byTag("meeting").length, 1);
  const n = v.notes.get("d1")!;
  assert.equal(n.content, body, "content never overwritten");
  assert.equal(n.metadata!.event_status, "confirmed");
  assert.equal(n.metadata!.summaryOld, "kept", "merge keeps other writers' keys");
  assert.equal(v.byTag("person").length, 1, "existing person reused");
});

test("converges by PATH when the note has no calendarEventId yet", async () => {
  const m = buildMeetingNote(ev());
  const v = fakeVault([{ id: "d1", path: m.path, content: m.content, metadata: { title: "old" }, tags: ["meeting"] }]);
  const r = await syncCalendarWindow(fakeGog({ events: [ev({ attendees: [] })] }).client, v.vault, opts());
  assert.equal(r.created, 0);
  assert.equal(v.notes.get("d1")!.metadata!.calendarEventId, "evt001");
});

test("unchanged event → no write at all (and a second pass is write-free)", async () => {
  const v = fakeVault();
  const g = fakeGog({ events: [ev()] });
  await syncCalendarWindow(g.client, v.vault, opts());
  const before = v.totalWrites();
  const r = await syncCalendarWindow(g.client, v.vault, opts());
  assert.equal(r.unchanged, 1);
  assert.equal(v.totalWrites(), before, "no history version for an unchanged event");
});

test("a desktop note identical in metadata but missing an attendee link IS rewritten (links only matter)", async () => {
  const v = fakeVault([desktopNote("d1", ev({ attendees: [{ email: "ada@example.test", displayName: "Ada Example" }] }))]);
  const r = await syncCalendarWindow(fakeGog({ events: [ev({ attendees: [{ email: "ada@example.test", displayName: "Ada Example" }] })] }).client, v.vault, opts());
  assert.equal(r.updated, 1);
  assert.equal(v.notes.get("d1")!.linkSet.length, 1);
});

test("changed event (moved + renamed location) → metadata patched in place, path + body unchanged", async () => {
  const v = fakeVault([desktopNote("d1", ev({ attendees: [] }))]);
  const moved = ev({ attendees: [], location: "Room 9", start: { dateTime: "2026-10-06T10:00:00-06:00" } });
  await syncCalendarWindow(fakeGog({ events: [moved] }).client, v.vault, opts());
  const n = v.notes.get("d1")!;
  assert.equal(n.metadata!.location, "Room 9");
  assert.equal(n.metadata!.date, "2026-10-06");
  assert.equal(n.path, "vault/meetings/2026-10-05/roadmap-review--q4-", "desktop never moves a note");
  assert.equal(v.byTag("meeting").length, 1);
});

test("an event Google reports as cancelled → event_status cancelled (same as desktop)", async () => {
  const v = fakeVault([desktopNote("d1", ev({ attendees: [] }))]);
  await syncCalendarWindow(fakeGog({ events: [ev({ attendees: [], status: "cancelled" })] }).client, v.vault, opts());
  assert.equal(v.notes.get("d1")!.metadata!.event_status, "cancelled");
});

// ── reconcile ────────────────────────────────────────────────────────────────

function orphanVault() {
  const gone = ev({ id: "gone1", summary: "Vanished sync", attendees: [] });
  const withNotes = ev({ id: "gone2", summary: "Vanished with notes", attendees: [] });
  const withTx = ev({ id: "gone3", summary: "Vanished with transcript", attendees: [] });
  const outside = ev({ id: "gone4", summary: "Old", attendees: [], start: { dateTime: "2026-08-01T10:00:00Z" } });
  const already = ev({ id: "gone5", summary: "Already cancelled", attendees: [] });
  return fakeVault([
    desktopNote("o1", gone),
    desktopNote("o2", withNotes, { content: buildMeetingNote(withNotes).content + "Action items: none." }),
    desktopNote("o3", withTx, { metadata: { transcriptNoteId: "t9" } }),
    desktopNote("o4", outside),
    desktopNote("o5", already, { metadata: { event_status: "cancelled" } }),
    { id: "h1", path: "vault/meetings/2026-10-07/handmade", tags: ["meeting"], metadata: { date: "2026-10-07" }, content: "# Hand made" },
  ]);
}

test("delete mode = desktop: template-only orphan deleted; user content / transcript → soft-cancel; others untouched", async () => {
  const v = orphanVault();
  const r = await syncCalendarWindow(fakeGog({ events: [] }).client, v.vault, opts({ deleteMode: "delete" }));
  assert.equal(r.reconcile.deleted, 1);
  assert.equal(r.reconcile.cancelled, 2);
  assert.equal(v.notes.has("o1"), false);
  assert.equal(v.notes.get("o2")!.metadata!.event_status, "cancelled");
  assert.equal(v.notes.get("o3")!.metadata!.event_status, "cancelled");
  assert.equal(v.notes.get("o4")!.metadata!.event_status, "confirmed", "outside the window");
  assert.ok(v.notes.has("h1"), "hand-made meeting notes are never reconciled");
  assert.equal(v.log.gets, 2, "content fetched only for orphans without a transcript");
});

test("log mode: exactly the desktop's decisions are recorded, and NOTHING is written", async () => {
  const v = orphanVault();
  const r = await syncCalendarWindow(fakeGog({ events: [] }).client, v.vault, opts({ deleteMode: "log" }));
  assert.equal(v.totalWrites(), 0);
  assert.equal(r.reconcile.logged, 3);
  const acts = r.intents.map((i) => `${i.action}:${i.noteId}:${i.effect}`).sort();
  assert.deepEqual(acts, ["cancel:o2:logged", "cancel:o3:logged", "delete:o1:logged"]);
  assert.ok(r.intents.every((i) => i.path && i.reason));
});

test("archive mode: delete → tag + metadata (no delete), cancels as desktop; next pass is write-free", async () => {
  const v = orphanVault();
  const g = fakeGog({ events: [] });
  const r = await syncCalendarWindow(g.client, v.vault, opts({ deleteMode: "archive" }));
  assert.equal(v.log.deletes, 0);
  assert.equal(r.reconcile.archived, 1);
  const o1 = v.notes.get("o1")!;
  assert.ok(o1.tags!.includes(ARCHIVED_TAG));
  assert.equal(o1.metadata!.event_status, "cancelled", "hidden on the calendar");
  assert.ok(typeof o1.metadata!.archivedAt === "string");
  assert.equal(v.notes.get("o2")!.metadata!.event_status, "cancelled");
  const w = v.totalWrites();
  await syncCalendarWindow(g.client, v.vault, opts({ deleteMode: "archive" }));
  assert.equal(v.totalWrites(), w, "already archived/cancelled → untouched");
});

test("archive: an archived event that reappears is un-archived in one write", async () => {
  const e = ev({ id: "gone1", summary: "Vanished sync", attendees: [] });
  const v = fakeVault([desktopNote("o1", e, { tags: ["meeting", ARCHIVED_TAG], metadata: { event_status: "cancelled", archivedAt: "2026-10-01T00:00:00Z" } })]);
  const r = await syncCalendarWindow(fakeGog({ events: [e] }).client, v.vault, opts({ deleteMode: "archive" }));
  assert.equal(r.updated, 1);
  const n = v.notes.get("o1")!;
  assert.equal(n.tags!.includes(ARCHIVED_TAG), false);
  assert.equal(n.metadata!.event_status, "confirmed");
  assert.equal("archivedAt" in n.metadata!, false);
  assert.equal(v.log.updates, 1);
});

test("truncation guard: a full page (== max) never reconciles", async () => {
  const v = orphanVault();
  const events = Array.from({ length: 5 }, (_, i) => ev({ id: `f${i}`, summary: `Filler ${i}`, attendees: [] }));
  const r = await syncCalendarWindow(fakeGog({ events }).client, v.vault, opts({ max: 5 }));
  assert.match(r.reconcile.skipped!, /truncated/);
  assert.equal(v.log.deletes, 0);
  assert.ok(v.notes.has("o1"));
});

test("reconcile also stands down on a nextPageToken or an unrecognised response", async () => {
  for (const payload of [{ events: [], nextPageToken: "more" }, {}, { error: "quota" }]) {
    const v = orphanVault();
    const r = await syncCalendarWindow(fakeGog(payload).client, v.vault, opts());
    assert.ok(r.reconcile.skipped, JSON.stringify(payload));
    assert.equal(v.totalWrites(), 0);
  }
});

test("a gog failure throws before anything is written", async () => {
  const v = orphanVault();
  const run = async () => {
    throw new Error("gog calendar list failed: token expired");
  };
  await assert.rejects(syncCalendarWindow(new CalendarClient("a@example.test", run), v.vault, opts()), /token expired/);
  assert.equal(v.totalWrites(), 0);
});

test("mass-orphan brake: archive/delete apply nothing above CALENDAR_MAX_ORPHANS_PER_PASS", async () => {
  const v = orphanVault();
  const r = await syncCalendarWindow(fakeGog({ events: [] }).client, v.vault, opts({ deleteMode: "delete", maxOrphans: 2 }));
  assert.equal(v.totalWrites(), 0);
  assert.equal(r.reconcile.blocked, 3);
  assert.ok(r.intents.every((i) => i.effect === "blocked"));
});

// ── shadow ───────────────────────────────────────────────────────────────────

test("SHADOW writes nothing at all — no notes, people, links, cancels or deletes — but records every intent", async () => {
  const v = orphanVault();
  v.notes.set("t1", { id: "t1", path: "vault/transcripts/x", tags: ["transcript"], metadata: { date: "2026-10-05", title: "Roadmap review", attendees: [] }, content: "", createdAt: "", updatedAt: "", linkSet: [] } as never);
  const changed = desktopNote("c1", ev({ id: "chg", summary: "Changed", attendees: [] }));
  v.notes.set("c1", { ...changed, createdAt: "", updatedAt: "", linkSet: [] } as never);
  const events = [ev(), ev({ id: "chg", summary: "Changed", attendees: [], location: "Elsewhere" })];
  const r = await syncCalendarWindow(fakeGog({ events }).client, v.vault, opts({ shadow: true, deleteMode: "delete" }));
  assert.equal(v.totalWrites(), 0);
  const kinds = new Set(r.intents.map((i) => i.action));
  for (const k of ["create", "update", "delete", "cancel", "person-create", "link-transcript"]) assert.ok(kinds.has(k as never), `intent ${k}`);
  assert.ok(r.intents.every((i) => i.effect === "shadow" && i.mode === "shadow"));
});

// ── people + transcripts + collisions ────────────────────────────────────────

test("attendee person linking via people.ts: found by email, created once, role addresses skipped", async () => {
  const v = fakeVault([{ id: "p1", path: "vault/people/grace-h", tags: ["person"], metadata: { name: "Grace H", channels: { email: ["GRACE@example.test"] } }, content: "# Grace H" }]);
  const att = [
    { email: "grace@example.test", displayName: "Grace Hopper" },
    { email: "lin@example.test", displayName: "Lin Example" },
    { email: "noreply@example.test", displayName: "Calendar Bot" },
  ];
  const events = [ev({ attendees: att }), ev({ id: "evt002", summary: "Second", attendees: att })];
  await syncCalendarWindow(fakeGog({ events }).client, v.vault, opts());
  const people = v.byTag("person");
  assert.equal(people.length, 2, "grace reused by email; lin created once; the bot never");
  const lin = people.find((p) => p.path === "vault/people/lin-example")!;
  for (const m of v.byTag("meeting")) {
    assert.deepEqual(m.linkSet.map((l) => l.targetId).sort(), ["p1", lin.id].sort());
    assert.ok(m.linkSet.every((l) => l.relationship === ATTENDED_BY));
  }
});

test("each attendee keeps their OWN email (no zip misalignment when one has none)", async () => {
  const v = fakeVault();
  await syncCalendarWindow(
    fakeGog({ events: [ev({ attendees: [{ displayName: "Room Resource" }, { displayName: "Kai Example", email: "kai@example.test" }] })] }).client,
    v.vault,
    opts(),
  );
  const kai = v.byTag("person").find((p) => p.path === "vault/people/kai-example")!;
  assert.deepEqual(kai.metadata!.email, "kai@example.test");
  const room = v.byTag("person").find((p) => p.path === "vault/people/room-resource")!;
  assert.equal(room.metadata!.email, undefined);
});

test("transcript auto-link: unambiguous date ±1 + exact attendee/title evidence, both sides stamped", async () => {
  const v = fakeVault([
    { id: "t1", path: "vault/transcripts/a", tags: ["transcript"], metadata: { date: "2026-10-04", title: "Roadmap review notes", attendees: ["Ada Example"] }, content: "" },
    { id: "t2", path: "vault/transcripts/b", tags: ["transcript"], metadata: { date: "2026-10-05", title: "Unrelated", attendees: [], meetingNoteId: "other" }, content: "" },
  ]);
  const r = await syncCalendarWindow(fakeGog({ events: [ev()] }).client, v.vault, opts());
  assert.equal(r.transcriptLinks, 1);
  const m = v.byTag("meeting")[0]!;
  assert.equal(m.metadata!.transcriptNoteId, "t1");
  assert.ok(m.linkSet.some((l) => l.targetId === "t1" && l.relationship === HAS_TRANSCRIPT));
  assert.equal(v.notes.get("t1")!.metadata!.meetingNoteId, m.id);
  const w = v.totalWrites();
  await syncCalendarWindow(fakeGog({ events: [ev()] }).client, v.vault, opts());
  assert.equal(v.totalWrites(), w, "already linked → nothing");
});

test("two same-titled events on one day: no flip-flop between them (desktop would clobber every pass)", async () => {
  const a = ev({ id: "A", summary: "Standup", attendees: [] });
  const b = ev({ id: "B", summary: "Standup", attendees: [] });
  const v = fakeVault([desktopNote("d1", a)]);
  const g = fakeGog({ events: [a, b] });
  const r = await syncCalendarWindow(g.client, v.vault, opts());
  assert.equal(v.notes.get("d1")!.metadata!.calendarEventId, "A");
  assert.ok(r.intents.some((i) => i.action === "skip-collision" && i.eventId === "B"));
  assert.equal(v.totalWrites(), 0);
  assert.equal(r.reconcile.orphans, 0);
});

test("equal transcript candidates are disclosed without creating a first-match link", async () => {
  const v = fakeVault(["one", "two"].map((id) => ({ id, tags: ["transcript"], metadata: { date: "2026-10-05", title: "Roadmap review", attendees: ["Ada Example"] } })));
  const r = await syncCalendarWindow(fakeGog({ events: [ev()] }).client, v.vault, opts());
  assert.equal(r.transcriptLinks, 0);
  assert.ok(r.intents.some((i) => i.action === "link-transcript" && i.effect === "blocked" && i.reason?.includes("Ambiguous")));
  assert.equal(v.byTag("meeting")[0]!.metadata!.transcriptNoteId, undefined);
});

test("incomplete calendar pages defer fuzzy matching and known competing events remain candidates", async () => {
  const recording = { id: "recording", tags: ["transcript"], metadata: { date: "2026-10-05", title: "Roadmap review", attendees: ["Ada Example"] } };
  const v = fakeVault([recording]);
  const incomplete = await syncCalendarWindow(fakeGog({ events: [ev()], nextPageToken: "another-page" }).client, v.vault, opts());
  assert.equal(incomplete.transcriptLinks, 0);
  assert.ok(incomplete.intents.some((i) => i.reason?.includes("incomplete")));
  const other = desktopNote("other-meeting", ev({ id: "other-event" }));
  other.path += "-other";
  const known = fakeVault([recording, other]);
  const competing = await syncCalendarWindow(fakeGog({ events: [ev()] }).client, known.vault, opts());
  assert.equal(competing.transcriptLinks, 0);
  assert.ok(competing.intents.some((i) => i.reason?.includes("Ambiguous")));
});

test("a partial matcher link is repaired on the next pass without overwriting a manual choice", async () => {
  const v = fakeVault([{ id: "recording", tags: ["transcript"], metadata: { date: "2026-10-05", title: "Roadmap review", attendees: ["Ada Example"] } }]);
  const update = v.vault.updateNote.bind(v.vault);
  let fail = true;
  v.vault.updateNote = async (id, body) => { if (id === "recording" && fail) throw new Error("simulated backlink failure"); return update(id, body); };
  const g = fakeGog({ events: [ev()] });
  const first = await syncCalendarWindow(g.client, v.vault, opts());
  assert.ok(first.intents.some((i) => i.action === "link-transcript" && i.effect === "failed"));
  const note = v.byTag("meeting")[0]!;
  assert.equal(note.metadata!.transcriptLinkOrigin, "calendar-match-v1");
  assert.equal(v.notes.get("recording")!.metadata!.meetingNoteId, undefined);
  fail = false;
  const repaired = await syncCalendarWindow(g.client, v.vault, opts());
  assert.equal(v.notes.get("recording")!.metadata!.meetingNoteId, note.id);
  assert.ok(repaired.intents.some((i) => i.reason === "Repaired incomplete transcript backlink"));
  v.notes.get("recording")!.metadata!.meetingNoteId = "manual-choice";
  const blocked = await syncCalendarWindow(g.client, v.vault, opts());
  assert.equal(v.notes.get("recording")!.metadata!.meetingNoteId, "manual-choice");
  assert.ok(blocked.intents.some((i) => i.action === "link-transcript" && i.effect === "blocked"));
});

test("a create that finds its path taken by the SAME event (desktop race) merges; a foreign note is never touched", async () => {
  const v = fakeVault();
  const m = buildMeetingNote(ev({ attendees: [] }));
  // Simulate the race: the listing is empty, but the path exists at create time.
  const realList = v.vault.listNotes;
  v.vault.listNotes = async (o) => (o.tags?.includes("meeting") ? [] : realList(o));
  v.notes.set("race", { id: "race", path: m.path, content: "x", metadata: { calendarEventId: "evt001" }, tags: ["meeting"], createdAt: "", updatedAt: "", linkSet: [] } as never);
  const r1 = await syncCalendarWindow(fakeGog({ events: [ev({ attendees: [] })] }).client, v.vault, opts());
  assert.equal(r1.updated, 1);
  assert.equal(v.notes.get("race")!.content, "x");
  v.notes.set("race", { id: "race", path: m.path, content: "foreign", metadata: { other: true }, tags: ["page"], createdAt: "", updatedAt: "", linkSet: [] } as never);
  const r2 = await syncCalendarWindow(fakeGog({ events: [ev({ attendees: [] })] }).client, v.vault, opts());
  assert.equal(r2.failed, 1);
  assert.deepEqual(v.notes.get("race")!.metadata, { other: true });
  assert.equal(v.log.conflicts, 0);
});

// ── scheduler / config / health (fetch-stubbed vault) ─────────────────────────

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetSourceHealth();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  fv = installFakeVault();
});
afterEach(() => {
  fv.restore();
  setCalendarGogRunnerForTests(null);
});

function withConfig<T>(over: Partial<typeof config>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(over)) prev[k] = (config as Record<string, unknown>)[k];
  Object.assign(config, over);
  return fn().finally(() => Object.assign(config, prev));
}
const putGoogle = () => putSecret("primary", config.ownerEmail, "google", JSON.stringify({ account: "someone@example.test" }));

test("defaults: CALENDAR_SYNC_ENABLED/SHADOW off, delete mode log — the worker does nothing, gog never runs", async () => {
  assert.equal(config.calendarSyncEnabled, false);
  assert.equal(config.calendarShadow, false);
  assert.equal(config.calendarDeleteMode, "log");
  assert.equal(calendarMode(), "off");
  putGoogle();
  const g = fakeGog({ events: [ev()] });
  assert.equal(await runCalendarOnce(getVaultRegistry()[0]!, { run: g.run, force: true }), 0);
  assert.equal(g.calls.length, 0);
  assert.equal(fv.calls.length, 0, "vault never touched");
});

test("shadow wins over enabled; live pass uses the desktop window + max 250, throttled per 5-min slot", async () => {
  await withConfig({ calendarSyncEnabled: true, calendarShadow: true }, async () => assert.equal(calendarMode(), "shadow"));
  await withConfig({ calendarSyncEnabled: true, calendarIntervalMs: 300_000 }, async () => {
    putGoogle();
    const g = fakeGog({ events: [ev({ attendees: [] })] });
    const now = Date.UTC(2026, 8, 30, 12, 0);
    const entry = getVaultRegistry()[0]!;
    assert.equal(await runCalendarOnce(entry, { run: g.run, now }), 1);
    assert.deepEqual(g.calls[0]!.slice(0, 8), ["calendar", "list", "--from", "2026-09-27", "--to", "2026-10-31", "--max", "250"]);
    await runCalendarOnce(entry, { run: g.run, now: now + 1000 });
    assert.equal(g.calls.length, 1, "same slot → throttled");
    const posts = fv.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal((posts[0]!.body as { if_exists?: string }).if_exists, "ignore");
    assert.ok(readCalendarIntents("primary").some((i) => i.action === "create" && i.effect === "applied"));
  });
});

test("worker in shadow: fetch + diff against the vault, zero vault writes, intents persisted", async () => {
  await withConfig({ calendarShadow: true }, async () => {
    putGoogle();
    fv.put({ id: "o1", path: "vault/meetings/2026-10-02/gone", tags: ["meeting"], metadata: { calendarEventId: "gone", date: "2026-10-02" }, content: "# Gone\n\n## Meeting Notes\n\n" });
    const g = fakeGog({ events: [ev({ attendees: [] })] });
    await runCalendarOnce(getVaultRegistry()[0]!, { run: g.run, force: true, now: Date.UTC(2026, 8, 30) });
    assert.equal(fv.calls.filter((c) => c.method !== "GET").length, 0);
    const intents = readCalendarIntents("primary");
    assert.ok(intents.some((i) => i.action === "delete" && i.noteId === "o1" && i.effect === "shadow"));
    assert.ok(intents.some((i) => i.action === "create" && i.effect === "shadow"));
  });
});

test("health: calendar is a SERVER source when live; shadow adds calendar-shadow and keeps the desktop inference", async () => {
  const list = async () => [];
  let h = await getSourceHealth({ list });
  assert.equal(h.find((s) => s.name === "calendar")!.kind, "desktop");
  assert.equal(h.find((s) => s.name === "calendar-shadow"), undefined);
  await withConfig({ calendarSyncEnabled: true }, async () => {
    resetSourceHealth();
    putGoogle();
    recordSourceOutcome("primary", "calendar", new Error("gog failed"));
    h = await getSourceHealth({ list });
    const cal = h.filter((s) => s.name === "calendar");
    assert.equal(cal.length, 1, "no duplicate desktop entry");
    assert.equal(cal[0]!.kind, "server");
    assert.equal(cal[0]!.failureStreak, 1);
    assert.equal(cal[0]!.staleAfterMs, config.workerStaleMs.calendarServer);
  });
  await withConfig({ calendarShadow: true }, async () => {
    resetSourceHealth();
    h = await getSourceHealth({ list });
    assert.equal(h.find((s) => s.name === "calendar-shadow")!.kind, "server");
    assert.equal(h.find((s) => s.name === "calendar")!.kind, "desktop");
  });
});

// ── routes ───────────────────────────────────────────────────────────────────

const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

test("POST /api/calendar/sync requires an admin session", async () => {
  assert.equal((await calendarRoute.request("/sync?from=2026-10-01&to=2026-10-31", { method: "POST" })).status, 403);
  const tok = makeCapability("note", "n1", "edit");
  assert.equal((await calendarRoute.request("/sync?from=2026-10-01&to=2026-10-31", { method: "POST", headers: { authorization: `Capability ${tok}` } })).status, 403);
  const member = sessionCookie(makeSession("member@example.test"));
  assert.equal((await calendarRoute.request("/sync?from=2026-10-01&to=2026-10-31", { method: "POST", headers: { cookie: member } })).status, 403);
});

test("POST /api/calendar/sync: refuses while disabled (409); validates dates before any gog call", async () => {
  const g = fakeGog({ events: [ev()] });
  setCalendarGogRunnerForTests(g.run);
  putGoogle();
  const r = await calendarRoute.request("/sync?from=2026-10-01&to=2026-10-31", { method: "POST", headers: { cookie: ownerCookie() } });
  assert.equal(r.status, 409);
  await withConfig({ calendarSyncEnabled: true }, async () => {
    for (const q of ["from=--help&to=2026-10-31", "from=2026-10-31&to=2026-10-01", "from=2026-1-1&to=2026-10-31", "from=2020-01-01&to=2026-10-31"]) {
      const bad = await calendarRoute.request(`/sync?${q}`, { method: "POST", headers: { cookie: ownerCookie() } });
      assert.equal(bad.status, 400, q);
    }
  });
  assert.equal(g.calls.length, 0);
});

test("POST /api/calendar/sync (live): range semantics = desktop (caller window, max 100, reconcile), desktop response shape", async () => {
  await withConfig({ calendarSyncEnabled: true, calendarDeleteMode: "log" }, async () => {
    putGoogle();
    fv.put({ id: "o1", path: "vault/meetings/2026-10-02/gone", tags: ["meeting"], metadata: { calendarEventId: "gone", date: "2026-10-02" }, content: "# Gone\n\n## Meeting Notes\n\n" });
    const g = fakeGog({ events: [ev({ attendees: [] })] });
    setCalendarGogRunnerForTests(g.run);
    const r = await calendarRoute.request("/sync?from=2026-10-01&to=2026-10-31", { method: "POST", headers: { cookie: ownerCookie() } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.deepEqual(g.calls[0]!.slice(0, 8), ["calendar", "list", "--from", "2026-10-01", "--to", "2026-10-31", "--max", "100"]);
    assert.equal(body.synced, 1);
    assert.equal(body.errors, 0);
    assert.equal(body.deleted, 0, "log mode");
    assert.equal(body.total, 1);
    assert.equal(body.from, "2026-10-01");
    assert.ok(fv.notes.has("o1"), "log mode never deletes");
    assert.equal(fv.calls.filter((c) => c.method === "DELETE").length, 0);
    assert.ok(readCalendarIntents("primary").some((i) => i.source === "range" && i.action === "delete" && i.effect === "logged"));
  });
});

test("POST /api/calendar/sync (live, delete mode) deletes a template-only orphan like the desktop", async () => {
  await withConfig({ calendarSyncEnabled: true, calendarDeleteMode: "delete" }, async () => {
    putGoogle();
    fv.put({ id: "o1", path: "vault/meetings/2026-10-02/gone", tags: ["meeting"], metadata: { calendarEventId: "gone", date: "2026-10-02" }, content: "# Gone\n\n## Meeting Notes\n\n" });
    setCalendarGogRunnerForTests(fakeGog({ events: [] }).run);
    const r = await calendarRoute.request("/sync?from=2026-10-01&to=2026-10-31", { method: "POST", headers: { cookie: ownerCookie() } });
    assert.equal(((await r.json()) as { deleted: number }).deleted, 1);
    assert.equal(fv.notes.has("o1"), false);
  });
});

test("GET /acl/workers/calendar/intents: server-owner only; newest first; ?action filter; ?verify reports what is there now", async () => {
  assert.equal((await acl.request("/workers/calendar/intents")).status, 403);
  assert.equal((await acl.request("/workers/calendar/intents", { headers: { cookie: sessionCookie(makeSession("member@example.test")) } })).status, 403);
  await withConfig({ calendarShadow: true }, async () => {
    putGoogle();
    fv.put({ id: "o1", path: "vault/meetings/2026-10-02/gone", tags: ["meeting"], metadata: { calendarEventId: "gone", date: "2026-10-02" }, content: "# Gone\n\n## Meeting Notes\n\n" });
    await runCalendarOnce(getVaultRegistry()[0]!, { run: fakeGog({ events: [] }).run, force: true, now: Date.UTC(2026, 8, 30) });
    // The desktop then deletes it for real.
    fv.notes.delete("o1");
    const r = await acl.request("/workers/calendar/intents?action=delete&verify=1", { headers: { cookie: ownerCookie() } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { mode: string; intents: Array<{ noteId: string }>; verify: Array<{ noteId: string; now: string }>; lastPass: unknown };
    assert.equal(body.mode, "shadow");
    assert.equal(body.intents[0]!.noteId, "o1");
    assert.deepEqual(body.verify.map((x) => [x.noteId, x.now]), [["o1", "gone"]]);
    assert.ok(body.lastPass);
  });
});
