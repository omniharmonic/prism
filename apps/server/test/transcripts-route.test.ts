import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { db, addVaultEntry, removeVaultEntry } from "../src/db";
import { config } from "../src/config";
import { setTranscriptLinkVaultForTests } from "../src/transcript-links";
import { resetDb, installFakeVault, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault, type FakeNote } from "./helpers";

let fv: FakeVault;
const OWNER = config.ownerEmail;
const MEMBER = "member@test.local";

const meta = (id: string, store: Map<string, FakeNote> = fv.notes) => store.get(id)!.metadata ?? {};
const stamp = (id: string, store: Map<string, FakeNote> = fv.notes) => store.get(id)!.updatedAt!;
const typed = (id: string) => (fv.notes.get(id)!.links ?? []).filter((l) => l.relationship === "has-transcript").map((l) => l.targetId).sort();
const journal = () => db.prepare("SELECT transcript_id, state, actor, revision FROM transcript_link_decisions ORDER BY created_at, rowid").all() as Array<{ transcript_id: string; state: string; actor: string; revision: number }>;
const patches = (id: string) => fv.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/notes/${id}`));

function meeting(id: string, extra: Record<string, unknown> = {}, tags = ["meeting", "team"]) {
  return fv.put({ id, path: `vault/meetings/2026-10-05/${id}`, tags, content: `BODY ${id}`, metadata: { title: `Meeting ${id}`, calendarEventId: `ev-${id}`, date: "2026-10-05", start: "2026-10-05T10:00:00Z", attendees: ["Ada Example"], ...extra } });
}
function transcript(id: string, extra: Record<string, unknown> = {}, tags = ["transcript", "team"]) {
  return fv.put({ id, path: `vault/transcripts/${id}`, tags, content: `BODY ${id}`, createdAt: "2026-10-05T12:00:00.000Z", metadata: { title: `Recording ${id}`, date: "2026-10-05", attendees: ["Ada Example"], ...extra } });
}

const headers = (email: string | null, extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  "X-Prism-Vault": "primary",
  ...(email ? { cookie: sessionCookie(makeSession(email)), "X-Prism-Write-Actor": `user:${email}` } : {}),
  ...extra,
});
const review = (email: string | null, id = "M", query = "", extra: Record<string, string> = {}) =>
  createApp().request(`/api/transcripts/events/${id}${query ? `?query=${encodeURIComponent(query)}` : ""}`, { headers: headers(email, extra) });
type Body = { transcriptId: string; action: "link" | "unlink"; reason: string; meetingUpdatedAt: string; transcriptUpdatedAt: string; expectedRevision: number; requestId: string };
const body = (over: Partial<Body> & { meetingId?: string } = {}): Body => {
  const { meetingId = "M", ...rest } = over;
  const transcriptId = rest.transcriptId ?? "T1";
  return { transcriptId, action: "link", reason: "same call", meetingUpdatedAt: stamp(meetingId), transcriptUpdatedAt: stamp(transcriptId), expectedRevision: 0, requestId: "req-1", ...rest };
};
const decide = (email: string | null, b: unknown, id = "M", extra: Record<string, string> = {}) =>
  createApp().request(`/api/transcripts/events/${id}/decisions`, { method: "POST", headers: headers(email, extra), body: typeof b === "string" ? b : JSON.stringify(b) });
type Review = {
  meeting: { id: string; eventId: string; title: string; updatedAt: string };
  linked: Array<{ id: string; title: string; start?: string; updatedAt: string; decisionRevision: number; canManage: boolean }>;
  candidates: Array<{ id: string; title: string; updatedAt: string; decisionRevision: number; canManage: boolean; score: number; evidence: string[]; linkedElsewhere: boolean }>;
  limited: boolean;
  canManage: boolean;
};

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  meeting("M");
  transcript("T1", { title: "Meeting M", start: "2026-10-05T10:02:00Z" });
  transcript("T2", { title: "Meeting M", start: "2026-10-05T09:58:00Z" });
});
afterEach(() => {
  setTranscriptLinkVaultForTests(null);
  fv.restore();
});

test("only a signed-in user is served: anon and capability links → 401; a foreign vault header → 409", async () => {
  assert.equal((await review(null)).status, 401);
  assert.equal((await decide(null, body())).status, 401);
  const cap = makeCapability("tag", "team", "edit");
  const linkHeaders = { "Content-Type": "application/json", Authorization: `Capability ${cap}` };
  assert.equal((await createApp().request(`/api/transcripts/events/M?t=${encodeURIComponent(cap)}`, { headers: linkHeaders })).status, 401);
  assert.equal((await createApp().request(`/api/transcripts/events/M/decisions?t=${encodeURIComponent(cap)}`, { method: "POST", headers: linkHeaders, body: JSON.stringify(body()) })).status, 401);
  // An id the registry no longer knows resolves to primary; the header mismatch is refused.
  const gone = await review(OWNER, "M", "", { "X-Prism-Vault": "retired-vault" });
  assert.equal(gone.status, 409);
  assert.deepEqual(await gone.json(), { error: "vault_unavailable" });
  assert.equal((await decide(OWNER, body(), "M", { "X-Prism-Vault": "retired-vault" })).status, 409);
  assert.deepEqual(journal(), []);
});

test("GET returns the agreed shape; equal candidates are BOTH listed and nothing is linked", async () => {
  transcript("FAR", { title: "Unrelated topic", date: "2026-01-01", attendees: [] });
  const r = await review(OWNER);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  const data = (await r.json()) as Review;
  assert.deepEqual(data.meeting, { id: "M", eventId: "ev-M", title: "Meeting M", updatedAt: stamp("M") });
  assert.deepEqual(data.linked, []);
  assert.deepEqual(data.candidates.map((c) => c.id), ["T1", "T2"], "the unscored recording is not offered");
  assert.equal(data.candidates[0]!.score, data.candidates[1]!.score, "ambiguous: equal evidence");
  assert.deepEqual(Object.keys(data.candidates[0]!).sort(), ["canManage", "decisionRevision", "evidence", "id", "linkedElsewhere", "score", "start", "title", "updatedAt"]);
  assert.deepEqual(data.candidates[0], { id: "T1", title: "Meeting M", start: "2026-10-05T10:02:00Z", updatedAt: stamp("T1"), decisionRevision: 0, canManage: true, score: data.candidates[0]!.score, evidence: data.candidates[0]!.evidence, linkedElsewhere: false });
  assert.ok(data.candidates[0]!.evidence.includes("same-date"));
  transcript("DATE-ONLY", { title: "Meeting M" });
  const dateOnly = ((await (await review(OWNER)).json()) as Review).candidates.find((c) => c.id === "DATE-ONLY")!;
  assert.equal("start" in dateOnly, false, "a date-only record omits start instead of inventing a time");
  assert.equal(data.limited, false);
  assert.equal(data.canManage, true);
  assert.equal(fv.calls.filter((c) => c.method !== "GET").length, 0, "a review never writes");
  assert.deepEqual(journal(), []);
});

test("GET: a missing, non-meeting or unviewable meeting are the same 404", async () => {
  fv.put({ id: "DOC", path: "notes/doc", tags: ["team"], content: "x" });
  meeting("SECRET", {}, ["meeting", "private-team"]);
  grantUser(MEMBER, "tag", "team", "view");
  const answers = [];
  for (const id of ["nope", "DOC", "SECRET"]) {
    const r = await review(MEMBER, id);
    answers.push([r.status, await r.text()]);
  }
  assert.deepEqual(answers, [[404, '{"error":"not_found"}'], [404, '{"error":"not_found"}'], [404, '{"error":"not_found"}']]);
  assert.equal((await review("stranger@test.local")).status, 404, "authentication is not authorization");
});

test("GET: linked = union of singular, plural, typed link, journal and backpointer; canManage is honest per note", async () => {
  transcript("S", {});
  transcript("P", {});
  transcript("L", {});
  transcript("B", { meetingNoteId: "M" });
  transcript("RO", {}, ["transcript", "readonly"]);
  const m = fv.notes.get("M")!;
  m.metadata = { ...m.metadata, transcriptNoteId: "S", transcriptNoteIds: ["P", "RO", "dangling-id"] };
  m.links = [{ sourceId: "M", targetId: "L", relationship: "has-transcript" }];
  grantUser(MEMBER, "tag", "team", "edit");
  grantUser(MEMBER, "tag", "readonly", "view");
  assert.equal((await decide(OWNER, body())).status, 200); // journal: T1
  const data = (await (await review(MEMBER)).json()) as Review;
  assert.deepEqual(data.linked.map((l) => l.id).sort(), ["B", "L", "P", "RO", "S", "T1"]);
  assert.equal(data.linked.find((l) => l.id === "T1")!.decisionRevision, 1);
  assert.equal(data.linked.find((l) => l.id === "RO")!.canManage, false, "view-only on that recording");
  assert.equal(data.linked.find((l) => l.id === "S")!.canManage, true);
  assert.equal(data.canManage, true);
  assert.ok(!data.candidates.some((c) => data.linked.some((l) => l.id === c.id)));

  grantUser("viewer@test.local", "tag", "team", "view");
  const viewer = (await (await review("viewer@test.local")).json()) as Review;
  assert.equal(viewer.canManage, false);
  assert.ok(viewer.linked.length > 0 && viewer.linked.every((l) => !l.canManage));
  assert.ok(viewer.candidates.every((c) => !c.canManage));
});

test("private candidates and a private old meeting are never disclosed", async () => {
  grantUser(MEMBER, "tag", "team", "edit");
  transcript("PRIVATE-REC", { title: "Meeting M", prism_visibility: "private", prism_creator: "someone@else.test" });
  transcript("HIDDEN-LINKED", { title: "Meeting M", prism_visibility: "private", prism_creator: "someone@else.test", meetingNoteId: "M" });
  meeting("OLD-SECRET", { title: "Confidential acquisition sync", prism_visibility: "private", prism_creator: "someone@else.test" });
  transcript("MOVED", { title: "Meeting M", meetingNoteId: "OLD-SECRET" });
  meeting("OLD-OPEN", { title: "Open planning" });
  transcript("MOVABLE", { title: "Meeting M", meetingNoteId: "OLD-OPEN" });

  const r = await review(MEMBER);
  const raw = await r.text();
  const data = JSON.parse(raw) as Review;
  assert.ok(!raw.includes("PRIVATE-REC") && !raw.includes("HIDDEN-LINKED"), "unviewable recordings are silently dropped");
  assert.ok(!raw.includes("OLD-SECRET") && !raw.includes("Confidential") && !raw.includes("OLD-OPEN") && !raw.includes("Open planning"), "the other meeting's id/title never leaves the server");
  const moved = data.candidates.find((c) => c.id === "MOVED")!;
  assert.equal(moved.linkedElsewhere, true);
  assert.equal(moved.canManage, false, "cannot write the meeting it would be moved from");
  const movable = data.candidates.find((c) => c.id === "MOVABLE")!;
  assert.equal(movable.linkedElsewhere, true);
  assert.equal(movable.canManage, true);
  assert.equal(data.candidates.find((c) => c.id === "T1")!.linkedElsewhere, false);

  // Mutations agree with what the review said.
  const hidden = await decide(MEMBER, body({ transcriptId: "PRIVATE-REC" }));
  assert.equal(hidden.status, 404);
  const move = await decide(MEMBER, body({ transcriptId: "MOVED", requestId: "mv" }));
  assert.equal(move.status, 404);
  assert.deepEqual(await move.json(), { error: "not_found" });
  assert.deepEqual(journal(), []);
  assert.equal(meta("MOVED").meetingNoteId, "OLD-SECRET");
  assert.equal(patches("OLD-SECRET").length, 0);
  // The permitted move is a real three-note change.
  const ok = await decide(MEMBER, body({ transcriptId: "MOVABLE", requestId: "mv-ok" }));
  assert.deepEqual([ok.status, await ok.json()], [200, { status: "applied", revision: 1 }]);
  assert.equal(meta("MOVABLE").meetingNoteId, "M");
});

test("candidate enumeration is bounded and says so; query is a title/path filter capped at 50", async () => {
  for (let i = 0; i < 205; i++) transcript(`bulk-${String(i).padStart(3, "0")}`, { title: i < 60 ? `Budget offsite ${i}` : `Meeting M ${i}`, date: i < 60 ? "2025-01-01" : "2026-10-05", attendees: [] });
  const wide = (await (await review(OWNER)).json()) as Review;
  assert.equal(wide.limited, true);
  assert.ok(wide.candidates.length <= 200);
  const hits = (await (await review(OWNER, "M", "budget OFFSITE")).json()) as Review;
  assert.equal(hits.candidates.length, 50);
  assert.equal(hits.limited, true);
  assert.ok(hits.candidates.every((c) => c.title.startsWith("Budget offsite") && c.score === 0 && c.evidence.length === 0));
  const one = (await (await review(OWNER, "M", "transcripts/bulk-07")).json()) as Review;
  assert.equal(one.candidates.length, 10, "path substring");
  assert.equal(one.limited, false);
});

test("POST validates strictly: content type, exact keys, reason length, revision and request id", async () => {
  assert.equal((await decide(OWNER, body(), "M", { "Content-Type": "text/plain" })).status, 415);
  const bad: unknown[] = [
    "{not json",
    [],
    { ...body(), extra: 1 },
    { ...body(), reason: "   " },
    { ...body(), reason: "x".repeat(501) },
    { ...body(), action: "move" },
    { ...body(), expectedRevision: -1 },
    { ...body(), expectedRevision: 1.5 },
    { ...body(), expectedRevision: "0" },
    { ...body(), requestId: "has space" },
    { ...body(), requestId: "" },
    { ...body(), transcriptId: 7 },
    (({ reason: _r, ...rest }) => rest)(body()),
  ];
  for (const b of bad) assert.equal((await decide(OWNER, b)).status, 400, JSON.stringify(b).slice(0, 60));
  assert.equal((await decide(OWNER, { ...body(), reason: "x".repeat(500) })).status, 200);
  assert.equal(journal().length, 1);
});

test("POST needs view AND edit on both notes: unviewable → 404, viewable but not editable → 403, non-notes → 404", async () => {
  grantUser(MEMBER, "tag", "team", "view");
  assert.equal((await decide(MEMBER, body())).status, 403);
  meeting("ME", {}, ["meeting", "mine"]);
  transcript("TE", {}, ["transcript", "mine"]);
  grantUser(MEMBER, "tag", "mine", "edit");
  assert.equal((await decide(MEMBER, body({ meetingId: "ME" }), "ME")).status, 403, "edit on the meeting, view-only on the transcript");
  assert.equal((await decide(MEMBER, body({ transcriptId: "TE" }))).status, 403, "edit on the transcript, view-only on the meeting");
  transcript("NOVIEW", {}, ["transcript", "elsewhere"]);
  assert.equal((await decide(MEMBER, body({ meetingId: "ME", transcriptId: "NOVIEW" }), "ME")).status, 404);
  assert.equal((await decide(MEMBER, { ...body({ meetingId: "ME" }), transcriptId: "missing" }, "ME")).status, 404);
  assert.equal((await decide(MEMBER, body({ meetingId: "ME", transcriptId: "M" }), "ME")).status, 404, "a non-transcript note is not a target");
  assert.equal((await decide(MEMBER, body({ meetingId: "TE", transcriptId: "TE" }), "TE")).status, 404, "a non-meeting note is not an event");
  assert.deepEqual(journal(), []);
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0);
  // A create-only caps grant is not view: the level ladder is never the gate.
  db.prepare("UPDATE grants SET caps=? WHERE subject=? AND resource='mine'").run(JSON.stringify(["create"]), MEMBER);
  assert.equal((await decide(MEMBER, body({ meetingId: "ME", transcriptId: "TE" }), "ME")).status, 404);
  const ok = await decide("editor@test.local", body({ meetingId: "ME", transcriptId: "TE" }), "ME");
  assert.equal(ok.status, 404);
  grantUser("editor@test.local", "tag", "mine", "edit");
  assert.equal((await decide("editor@test.local", body({ meetingId: "ME", transcriptId: "TE" }), "ME")).status, 200);
});

test("POST link then unlink round-trips through the review; a cancelled and a hand-made meeting can be linked manually", async () => {
  const linked = await decide(OWNER, body());
  assert.deepEqual([linked.status, await linked.json()], [200, { status: "applied", revision: 1 }]);
  assert.equal(linked.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(meta("M").transcriptNoteIds, ["T1"]);
  assert.deepEqual(typed("M"), ["T1"]);
  assert.equal(meta("T1").meetingNoteId, "M");
  let data = (await (await review(OWNER)).json()) as Review;
  assert.deepEqual(data.linked.map((l) => [l.id, l.decisionRevision, l.canManage]), [["T1", 1, true]]);
  assert.deepEqual(data.candidates.map((c) => c.id), ["T2"]);

  const item = data.linked[0]!;
  const un = await decide(OWNER, { transcriptId: "T1", action: "unlink", reason: "wrong call", meetingUpdatedAt: data.meeting.updatedAt, transcriptUpdatedAt: item.updatedAt, expectedRevision: item.decisionRevision, requestId: "req-2" });
  assert.deepEqual([un.status, await un.json()], [200, { status: "applied", revision: 2 }]);
  data = (await (await review(OWNER)).json()) as Review;
  assert.deepEqual(data.linked, []);
  assert.equal(data.candidates.find((c) => c.id === "T1")!.decisionRevision, 2);
  assert.ok(fv.notes.has("T1"), "unlinking never deletes the transcript");

  meeting("CANCELLED", { event_status: "cancelled" });
  const hand = fv.put({ id: "HAND", path: "notes/offsite", tags: ["meeting", "team"], metadata: { title: "Offsite" }, content: "" });
  const none = (await (await review(OWNER, "CANCELLED")).json()) as Review;
  assert.deepEqual(none.candidates, [], "a cancelled event is never auto-suggested");
  const found = (await (await review(OWNER, "CANCELLED", "meeting m")).json()) as Review;
  assert.deepEqual(found.candidates.map((c) => [c.id, c.score]), [["T1", 0], ["T2", 0]]);
  assert.equal((await decide(OWNER, body({ meetingId: "CANCELLED", transcriptId: "T2", requestId: "c1" }), "CANCELLED")).status, 200);
  assert.equal(((await (await review(OWNER, "HAND")).json()) as Review).meeting.eventId, "");
  assert.equal((await decide(OWNER, { ...body({ transcriptId: "T1", requestId: "h1", expectedRevision: 2 }), meetingUpdatedAt: hand.updatedAt }, "HAND")).status, 200);
  assert.equal(meta("T1").meetingNoteId, "HAND");
});

test("stale revision or updatedAt → 409 with nothing journaled", async () => {
  for (const over of [{ expectedRevision: 3 }, { meetingUpdatedAt: "2020-01-01T00:00:00.000Z" }, { transcriptUpdatedAt: "2020-01-01T00:00:00.000Z" }]) {
    const r = await decide(OWNER, body(over));
    assert.deepEqual([r.status, await r.json()], [409, { error: "stale" }]);
  }
  assert.deepEqual(journal(), []);
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("lost acknowledgement over HTTP: 200 pending, then the byte-identical retry answers applied without a duplicate write; a reused id with another body is 422", async () => {
  let dropAck = true;
  setTranscriptLinkVaultForTests((v) => ({
    getNote: (id, o) => v.getNote(id, o),
    updateNote: async (id, p) => {
      const r = await v.updateNote(id, p);
      if (dropAck && id === "M") {
        dropAck = false;
        throw new Error("socket hang up");
      }
      return r;
    },
  }));
  const sent = JSON.stringify(body());
  const first = await decide(OWNER, sent);
  assert.deepEqual([first.status, await first.json()], [200, { status: "pending", revision: 1 }]);
  assert.notEqual(stamp("M"), JSON.parse(sent).meetingUpdatedAt, "the client's meetingUpdatedAt is stale now");
  const during = (await (await review(OWNER)).json()) as Review;
  assert.equal(during.linked[0]!.decisionRevision, 1);

  const reused = await decide(OWNER, { ...JSON.parse(sent), reason: "edited reason" });
  assert.deepEqual([reused.status, await reused.json()], [422, { error: "request_reused" }]);
  // Another signed-in editor's id space is separate: the same request id is a new, stale request for them.
  grantUser(MEMBER, "tag", "team", "edit");
  assert.equal((await decide(MEMBER, sent)).status, 409);

  const retry = await decide(OWNER, sent);
  assert.deepEqual([retry.status, await retry.json()], [200, { status: "applied", revision: 1 }]);
  assert.equal(patches("M").length, 1);
  assert.equal(patches("T1").length, 1);
  assert.deepEqual(journal(), [{ transcript_id: "T1", state: "applied", actor: `user:${OWNER}`, revision: 1 }]);
});

test("access revoked between the journal and the next write → refused (404 no access, 403 view-only), the row stays pending; another editor may supersede it", async () => {
  grantUser(MEMBER, "tag", "team", "edit");
  setTranscriptLinkVaultForTests((v) => ({
    getNote: (id, o) => v.getNote(id, o),
    updateNote: async (id, p) => {
      const r = await v.updateNote(id, p);
      if (id === "M") db.prepare("DELETE FROM grants WHERE subject=?").run(MEMBER); // revoked mid-decision
      return r;
    },
  }));
  const sent = JSON.stringify(body());
  const r = await decide(MEMBER, sent);
  assert.equal(r.status, 404, "all access gone: indistinguishable from missing");
  assert.equal(meta("T1").meetingNoteId, undefined, "the transcript was not written after the revocation");
  assert.deepEqual(journal(), [{ transcript_id: "T1", state: "pending", actor: `user:${MEMBER}`, revision: 1 }]);

  grantUser(MEMBER, "tag", "team", "view");
  assert.equal((await decide(MEMBER, sent)).status, 403, "downgraded to view: refused, still pending");
  assert.equal(journal()[0]!.state, "pending");
  assert.equal(patches("T1").length, 0);

  // Another editor may supersede the stranded decision with a fresh one…
  const data = (await (await review(OWNER)).json()) as Review;
  const t1 = data.linked.find((l) => l.id === "T1")!;
  const fix = await decide(OWNER, { transcriptId: "T1", action: "unlink", reason: "clean up", meetingUpdatedAt: data.meeting.updatedAt, transcriptUpdatedAt: t1.updatedAt, expectedRevision: t1.decisionRevision, requestId: "owner-fix" });
  assert.deepEqual([fix.status, await fix.json()], [200, { status: "applied", revision: 2 }]);
  assert.deepEqual(journal().map((j) => j.state), ["superseded", "applied"]);
  // …after which the original request can no longer be replayed, even with access back.
  grantUser(MEMBER, "tag", "team", "edit");
  const late = await decide(MEMBER, sent);
  assert.deepEqual([late.status, await late.json()], [409, { error: "superseded" }]);
  assert.equal(meta("M").transcriptNoteIds, undefined);
});

test("registry replacement: an in-flight decision is refused 409, and the new identity starts at revision 0 with no receipts", async () => {
  const entry = (vault: string) => ({ id: "second", label: "Second", url: "http://vault.test", vault, token: "test-token" });
  addVaultEntry(entry("second-a"));
  const seed = (name: string) => {
    fv.putIn(name, { id: "M", path: "vault/meetings/m", tags: ["meeting"], metadata: { title: "Meeting M", calendarEventId: "ev", date: "2026-10-05", attendees: ["Ada Example"] } });
    fv.putIn(name, { id: "T1", path: "vault/transcripts/t1", tags: ["transcript"], createdAt: "2026-10-05T12:00:00.000Z", metadata: { title: "Meeting M", date: "2026-10-05", attendees: ["Ada Example"] } });
    return fv.addVault(name);
  };
  const a = seed("second-a");
  const b = seed("second-b");
  const inSecond = { "X-Prism-Vault": "second" };
  const req = (store: Map<string, FakeNote>, requestId: string, expectedRevision = 0) => ({ transcriptId: "T1", action: "link", reason: "same call", meetingUpdatedAt: stamp("M", store), transcriptUpdatedAt: stamp("T1", store), expectedRevision, requestId });

  const first = await decide(OWNER, req(a, "same-id"), "M", inSecond);
  assert.deepEqual([first.status, await first.json()], [200, { status: "applied", revision: 1 }]);
  assert.equal(meta("T1", a).meetingNoteId, "M");
  assert.equal(meta("T1").meetingNoteId, undefined, "the primary vault's same-id notes are untouched");
  assert.equal((await ((await review(OWNER, "M", "", inSecond)).json() as Promise<Review>)).linked[0]!.decisionRevision, 1);

  // The registry entry is replaced WHILE an unlink is between two note writes.
  setTranscriptLinkVaultForTests((v) => ({
    getNote: (id, o) => v.getNote(id, o),
    updateNote: async (id, p) => {
      const r = await v.updateNote(id, p);
      if (id === "T1") {
        removeVaultEntry("second");
        addVaultEntry(entry("second-b"));
      }
      return r;
    },
  }));
  const unlink = { ...req(a, "unlink-1", 1), action: "unlink" };
  const mid = await decide(OWNER, unlink, "M", inSecond);
  assert.deepEqual([mid.status, await mid.json()], [409, { error: "vault_unavailable" }]);
  assert.deepEqual(meta("M", a).transcriptNoteIds, ["T1"], "no further note of the old vault was written");
  setTranscriptLinkVaultForTests(null);

  // Same vault id, new identity: revision 0, and the old request id is not a receipt.
  const fresh = (await (await review(OWNER, "M", "", inSecond)).json()) as Review;
  assert.deepEqual(fresh.linked, []);
  assert.deepEqual(fresh.candidates.map((c) => [c.id, c.decisionRevision]), [["T1", 0]]);
  const stale = await decide(OWNER, req(b, "x", 1), "M", inSecond);
  assert.equal(stale.status, 409);
  const again = await decide(OWNER, req(b, "same-id"), "M", inSecond);
  assert.deepEqual([again.status, await again.json()], [200, { status: "applied", revision: 1 }]);
  assert.equal(meta("T1", b).meetingNoteId, "M");

  // A vault removed outright: the id no longer resolves → 409.
  removeVaultEntry("second");
  assert.equal((await review(OWNER, "M", "", inSecond)).status, 409);
  assert.equal((await decide(OWNER, req(b, "y", 1), "M", inSecond)).status, 409);
});
