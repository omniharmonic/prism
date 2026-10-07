/**
 * Messages → People: a person's conversations are resolved at READ time from
 * strong identity keys — no stored link is needed (the production vault has
 * almost none). A display name never associates anybody; tombstones, non-human
 * notes and anything the caller cannot view stay out.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { peopleApi } from "../src/routes/people";
import { config } from "../src/config";
import { resetConversationIndex } from "../src/people-conversations";
import { resetDb, makeSession, sessionCookie, grantUser, installFakeVault, type FakeVault } from "./helpers";

let fv: FakeVault;
const T = Date.UTC(2026, 9, 1, 12);
beforeEach(() => {
  resetDb();
  resetConversationIndex();
  fv = installFakeVault();
  // People. Nobody is linked to anything unless a test says so.
  fv.put({ id: "morgan", path: "vault/people/Morgan Example", tags: ["person", "team"], metadata: { name: "Morgan Example", email: "morgan@example.org", matrix: "@telegram_4242:bridge.example.org" } });
  fv.put({ id: "stub", path: "vault/people/morgan-old", tags: ["person", "merged-stub", "team"], metadata: { name: "morgan-old", email: "old@example.org", merged_into: "vault/people/Morgan Example", status: "merged_into_canonical" } });
  fv.put({ id: "river", path: "vault/people/River Stone", tags: ["person", "team"], metadata: { name: "River Stone" } });
  fv.put({ id: "bot", path: "vault/people/Notetaker", tags: ["person", "bot"], metadata: { name: "Notetaker", email: "bot@example.org" } });
  // Mail: from Morgan, to Morgan, from the merged-away address, from a bot, and one that only NAMES River.
  fv.put({ id: "mail-in", path: "vault/messages/email/budget-1", tags: ["email", "team"], metadata: { subject: "Budget question", from: "Morgan Example <Morgan@Example.org>", to: config.ownerEmail, lastMessageAt: T - 3_600_000, isUnread: true } });
  fv.put({ id: "mail-out", path: "vault/messages/email/budget-2", tags: ["email"], metadata: { subject: "Re: Budget question", from: config.ownerEmail, to: "morgan@example.org, someone@else.test", lastMessageAt: T - 1_800_000 } });
  fv.put({ id: "mail-old", path: "vault/messages/email/older", tags: ["email"], metadata: { subject: "From the old address", from: "old@example.org", to: config.ownerEmail, lastMessageAt: T - 86_400_000 } });
  fv.put({ id: "mail-bot", path: "vault/messages/email/bot", tags: ["email"], metadata: { subject: "Recording ready", from: "bot@example.org", lastMessageAt: T } });
  fv.put({ id: "mail-river", path: "vault/messages/email/river", tags: ["email"], metadata: { subject: "Hello from River", from: "River Stone <someone@else.test>", lastMessageAt: T } });
  // Chat: one thread carries Morgan's bridged id; another only a display name.
  fv.put({ id: "chat", path: "vault/messages/telegram/Workshop planning", tags: ["message-thread"], metadata: { platform: "telegram", participants: ["Morgan", "Alex"], participantIds: ["@telegram_4242:bridge.example.org", "@owner:example.org"], matrixRoomId: "!room:example.org", lastMessageAt: T } });
  fv.put({ id: "chat-names", path: "vault/messages/signal/River", tags: ["message-thread"], metadata: { platform: "signal", participants: ["River Stone", "Morgan Example"], lastMessageAt: T } });
  fv.put({ id: "meet", path: "vault/meetings/2026-09-30/Review", tags: ["meeting"], metadata: { title: "Budget review", start: "2026-09-30T15:00:00Z", attendees: ["Morgan Example"], attendeeEmails: ["morgan@example.org", config.ownerEmail] } });
});
afterEach(() => fv.restore());
const as = (email: string) => ({ cookie: sessionCookie(makeSession(email)) });
type Row = { id: string; name: string; platforms: string[]; lastMessageAt: number; count: number; unread: number; hasIdentity: boolean };
type List = { people: Row[]; total: number; withoutIdentity: number };
type Timeline = { person: { id: string; hasIdentity: boolean; count: number }; items: Array<{ id: string; kind: string; platform: string; title: string; at: number }>; mergedFrom?: string };
const list = async (email: string, q = "") => (await (await peopleApi.request(`/conversations${q}`, { headers: as(email) })).json()) as List;

test("with NO stored links, a person's mail, chat and meetings are found by address and Matrix id", async () => {
  assert.ok([...fv.notes.values()].every((n) => !(n as { links?: unknown[] }).links?.length), "the fixture stores no link at all");
  const r = await list(config.ownerEmail);
  assert.deepEqual(r.people.map((p) => p.id), ["morgan"], "only the person with conversations — not the stub, the bot, or the name-only match");
  const morgan = r.people[0]!;
  assert.equal(morgan.count, 5);
  assert.equal(morgan.unread, 1);
  assert.equal(morgan.lastMessageAt, T);
  assert.deepEqual([...morgan.platforms].sort(), ["email", "meeting", "telegram"]);
  assert.equal(morgan.platforms[0], "telegram", "most recent platform first");

  const t = (await (await peopleApi.request("/morgan/conversations", { headers: as(config.ownerEmail) })).json()) as Timeline;
  assert.deepEqual(t.items.map((i) => i.id), ["chat", "mail-out", "mail-in", "meet", "mail-old"], "ONE timeline across platforms, newest first");
  assert.deepEqual(t.items.map((i) => i.kind), ["chat", "email", "email", "meeting", "email"]);
  assert.equal(t.items[0]!.platform, "telegram");
  assert.equal(t.items[2]!.title, "Budget question");
  assert.equal(JSON.stringify(t).includes("example.org"), false, "no address or handle travels in the answer");
});

test("a display name alone never associates a conversation — and the person is explained, not silently missing", async () => {
  const all = await list(config.ownerEmail);
  assert.equal(all.people.some((p) => p.id === "river"), false);
  assert.equal(all.withoutIdentity, 1, "River has no email or handle on file");
  const found = await list(config.ownerEmail, "?q=river");
  assert.deepEqual(found.people.map((p) => [p.id, p.count, p.hasIdentity]), [["river", 0, false]]);
  const t = (await (await peopleApi.request("/river/conversations", { headers: as(config.ownerEmail) })).json()) as Timeline;
  assert.deepEqual(t.items, []);
  assert.equal(t.person.hasIdentity, false);
});

test("stored links are honoured too, for a person with no key on file", async () => {
  fv.put({ id: "river", path: "vault/people/River Stone", tags: ["person", "team"], metadata: { name: "River Stone" }, links: [{ sourceId: "mail-river", targetId: "river", relationship: "email-from" }] });
  const r = await list(config.ownerEmail);
  assert.deepEqual(r.people.map((p) => p.id).sort(), ["morgan", "river"]);
  assert.equal(r.people.find((p) => p.id === "river")!.count, 1);
});

test("tombstones and non-human notes: never listed; a merged id opens the canonical person's timeline", async () => {
  const r = await list(config.ownerEmail, "?q=o");
  assert.equal(r.people.some((p) => p.id === "stub" || p.id === "bot"), false);
  const via = (await (await peopleApi.request("/stub/conversations", { headers: as(config.ownerEmail) })).json()) as Timeline;
  assert.equal(via.person.id, "morgan");
  assert.equal(via.mergedFrom, "stub");
  assert.equal((await peopleApi.request("/bot/conversations", { headers: as(config.ownerEmail) })).status, 404);
  assert.equal((await peopleApi.request("/mail-in/conversations", { headers: as(config.ownerEmail) })).status, 404, "a note that is not a person");
});

test("only what the caller can view: hidden threads are neither listed nor counted, a hidden person is a 404", async () => {
  const reader = "reader@test.local";
  // Nothing granted: no person, no thread.
  assert.deepEqual((await list(reader)).people, []);
  assert.equal((await peopleApi.request("/morgan/conversations", { headers: as(reader) })).status, 404);
  // The `team` tag reaches Morgan's note and ONE of the five conversations.
  grantUser(reader, "tag", "team", "view");
  const r = await list(reader);
  assert.deepEqual(r.people.map((p) => [p.id, p.count, p.platforms]), [["morgan", 1, ["email"]]]);
  const t = (await (await peopleApi.request("/morgan/conversations", { headers: as(reader) })).json()) as Timeline;
  assert.deepEqual(t.items.map((i) => i.id), ["mail-in"]);
  assert.equal(t.person.count, 1);
  // Somebody else's private thread is hidden from the owner as well.
  fv.put({ id: "chat", path: "vault/messages/telegram/Workshop planning", tags: ["message-thread"], metadata: { platform: "telegram", participantIds: ["@telegram_4242:bridge.example.org"], lastMessageAt: T, prism_visibility: "private", prism_creator: "other@test.local" } });
  resetConversationIndex();
  const own = (await (await peopleApi.request("/morgan/conversations", { headers: as(config.ownerEmail) })).json()) as Timeline;
  assert.equal(own.items.some((i) => i.id === "chat"), false);
});

test("signed-in accounts only; the listings are lean and reused for a minute", async () => {
  assert.equal((await peopleApi.request("/conversations")).status, 401);
  assert.equal((await peopleApi.request("/morgan/conversations")).status, 401);
  fv.calls.length = 0;
  await list(config.ownerEmail);
  await list(config.ownerEmail, "?q=mor");
  await peopleApi.request("/morgan/conversations", { headers: as(config.ownerEmail) });
  const reads = fv.calls.filter((c) => c.method === "GET");
  assert.equal(reads.length, 4, "four listings for three requests");
  assert.ok(reads.every((c) => !c.search.includes("include_content=true")), "no bodies");
  assert.ok(fv.calls.every((c) => c.method === "GET"), "nothing is written");
});
