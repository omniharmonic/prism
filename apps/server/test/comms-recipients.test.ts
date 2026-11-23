// S3 (phase 2b): GET /api/comms/recipients — the To: field of a new message.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { ensureSingleThread, replaceConversationMembers, setThreadPerson, upsertConversation, type ConversationRow } from "../src/comms/store";
import { conversationIdForChat } from "../src/bluebubbles/project";
import { setRecipientSourceForTests } from "../src/comms/recipients";
import { EMPTY_BOOK } from "../src/bluebubbles/contacts";
import type { BbContact } from "../src/bluebubbles/client";
import type { Note } from "../src/parachute";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { issueDeviceToken } from "../src/auth/device";

const prev = process.env.COMMS_ENABLED;
let people: Note[] | null;
let contacts: BbContact[];
let builds = 0;
beforeEach(() => {
  resetDb();
  process.env.COMMS_ENABLED = "true";
  people = [];
  contacts = [];
  builds = 0;
  setRecipientSourceForTests({ people: async () => { builds++; return people; }, contacts: async () => contacts, book: async () => EMPTY_BOOK });
});
afterEach(() => {
  setRecipientSourceForTests(null);
  if (prev === undefined) delete process.env.COMMS_ENABLED; else process.env.COMMS_ENABLED = prev;
});

const person = (id: string, name: string, md: Record<string, unknown> = {}, tags = ["person"]): Note => ({
  id, content: "", path: `People/${name}`, createdAt: "", updatedAt: null, tags, displayTitle: name, metadata: { name, ...md },
});
function conv(id: string, over: Partial<ConversationRow> & { members?: Array<{ memberId: string; personId: string | null }>; personId?: string } = {}): string {
  const { members, personId, ...row } = over;
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title: `Title ${id}`, titleSource: "contact", avatar: null,
    lastEventAt: "2026-11-20T10:00:00.000Z", lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox",
    pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: null, ...row,
  });
  const th = ensureSingleThread(id);
  if (members) replaceConversationMembers(id, members);
  if (personId) setThreadPerson(th, personId);
  return th;
}
const owner = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
const get = async (q: string, headers: Record<string, string> = owner()) => {
  const r = await createApp().request(`/api/comms/recipients?${q}`, { headers });
  return { status: r.status, cc: r.headers.get("cache-control"), body: (await r.json()) as any };
};

test("people from person notes and Contacts: name prefixes, diacritics, phone digits, emails; existing iMessage threads attached", async () => {
  people = [
    person("p1", "Zoë Álvarez", { phone: "+1 555 123 0001", email: "zoe@example.test", photo: "mxc://hs/zoe" }),
    person("p2", "Bob Stone", { phone: "+44 20 7946 0000" }),
    person("p3", "Old Zoe", { status: "merged_into_canonical" }), // tombstone: never offered
    person("p4", "Acme Bot", { type: "bot" }),
  ];
  contacts = [
    { displayName: "Zoey Kim", phoneNumbers: [{ address: "+1 (555) 222-0002" }], emails: [] },
    { displayName: "Zoe A.", phoneNumbers: [{ address: "(555) 123-0001" }], emails: [{ address: "ZOE@work.test" }] }, // same number as p1 → merged into p1
    { displayName: "Local Only", phoneNumbers: [{ address: "555 444 0000" }], emails: [] }, // no country code, no proof → not offered
  ];
  const guid = "iMessage;-;+15551230001";
  const cid = conversationIdForChat(guid);
  const zoeThread = conv(cid, { network: "imessage", sourceRef: guid, title: "Zoë Álvarez", members: [{ memberId: "tel:+15551230001", personId: "p1" }], personId: "p1" });
  const wa = conv("wa1", { network: "whatsapp", title: "Zoë WhatsApp", personId: "p1" });

  const r = await get("q=zoe");
  assert.equal(r.status, 200);
  assert.equal(r.cc, "private, no-store");
  assert.equal(r.body.partial, false);
  assert.deepEqual(r.body.people.map((p: any) => p.name), ["Zoë Álvarez", "Zoey Kim"]);
  const zoe = r.body.people[0];
  assert.equal(zoe.id, "p_p1");
  assert.equal(zoe.personId, "p1");
  assert.equal(zoe.source, "person");
  assert.ok(zoe.avatar.token, "a person photo goes out as a media token, never an mxc");
  assert.deepEqual(zoe.phones, [{ value: "+15551230001", threadId: zoeThread }]);
  assert.deepEqual(zoe.emails.map((e: any) => e.value).sort(), ["zoe@example.test", "zoe@work.test"]);
  const zoey = r.body.people[1];
  assert.match(zoey.id, /^c_[0-9a-f]{16}$/);
  assert.equal(zoey.personId, undefined);
  assert.deepEqual(zoey.phones, [{ value: "+15552220002" }]);
  assert.deepEqual(zoey.avatar, { monogram: "ZK" });
  // Threads: title matches + the person's own threads, any network.
  assert.deepEqual(new Set(r.body.threads.map((t: any) => t.id)), new Set([zoeThread, wa]));
  assert.equal(r.body.handle, null);

  assert.deepEqual((await get("q=stone%20b")).body.people.map((p: any) => p.name), ["Bob Stone"], "every word a prefix, any order");
  assert.deepEqual((await get("q=7946")).body.people.map((p: any) => p.name), ["Bob Stone"], "phone digits");
  assert.deepEqual((await get("q=work.test")).body.people.map((p: any) => p.name), ["Zoë Álvarez"], "email");
  assert.deepEqual((await get("q=local")).body.people, [], "a Contacts number without a country code is not sendable");
  assert.deepEqual((await get("q=old")).body.people, []);
  assert.deepEqual((await get("q=acme")).body.people, []);
  assert.equal(builds, 1, "the directory is built once and served from memory");
});

test("a Contacts number without a country code is offered in the E.164 form an existing conversation proves", async () => {
  contacts = [{ displayName: "Local Pal", phoneNumbers: [{ address: "(555) 444-0000" }], emails: [] }];
  const guid = "SMS;-;+15554440000";
  const th = conv(conversationIdForChat(guid), { network: "sms", sourceRef: guid, members: [{ memberId: "tel:+15554440000", personId: null }] });
  const r = await get("q=pal");
  assert.deepEqual(r.body.people[0].phones, [{ value: "+15554440000", threadId: th }]);
});

test("q that is itself an address comes back as `handle` (E.164 / lowercased email) with its thread", async () => {
  const guid = "iMessage;-;+15550009999";
  const th = conv(conversationIdForChat(guid), { network: "imessage", sourceRef: guid, members: [{ memberId: "tel:+15550009999", personId: null }] });
  assert.deepEqual((await get(`q=${encodeURIComponent("+1 555-000-9999")}`)).body.handle, { kind: "phone", value: "+15550009999", threadId: th });
  assert.deepEqual((await get("q=New%40Example.test")).body.handle, { kind: "email", value: "new@example.test" });
  assert.equal((await get("q=5550009999")).body.handle, null, "no country code → not a handle");
});

test("validation, owner only, comms-native device token allowed, limit bounds", async () => {
  assert.equal((await get("q=")).status, 400);
  assert.equal((await get("q=" + "a".repeat(101))).status, 400);
  assert.equal((await get("q=a&limit=0")).body.error, "invalid_limit");
  assert.equal((await get("q=a&limit=21")).status, 400);
  assert.equal((await get("q=a", { cookie: sessionCookie(makeSession("stranger@test.local")) })).status, 403);
  const dev = { authorization: `Bearer ${issueDeviceToken(config.ownerEmail, "Comms (test)", "comms-native").token}` };
  assert.equal((await get("q=a", dev)).status, 200);
  people = Array.from({ length: 50 }, (_, i) => person(`p${i}`, `Anna ${i}`));
  setRecipientSourceForTests({ people: async () => people, contacts: async () => [], book: async () => EMPTY_BOOK });
  assert.equal((await get("q=anna&limit=5")).body.people.length, 5);
});

test("the vault unreachable: threads still answer, people empty, partial", async () => {
  setRecipientSourceForTests({ people: () => new Promise(() => {}), contacts: async () => [], book: async () => EMPTY_BOOK });
  conv("x1", { title: "Book club" });
  // The first load waits a bounded time, then answers without people.
  const r = await get("q=book");
  assert.equal(r.body.partial, true);
  assert.deepEqual(r.body.people, []);
  assert.equal(r.body.threads.length, 1);
});

test("fix round 1 (I2): a shared landline never moves a Contacts card under another person, nor hides it", async () => {
  people = [person("bob", "Bob Stone", { phone: "+1 555 111 2222" })];
  contacts = [{ displayName: "Carol Diaz", phoneNumbers: [{ address: "+1 555 111 2222" }, { address: "+1 555 333 4444" }], emails: [{ address: "carol@x.test" }] }];
  const bob = (await get("q=bob")).body.people;
  assert.deepEqual(bob.map((p: any) => [p.name, p.phones.map((x: any) => x.value), p.emails.length]), [["Bob Stone", ["+15551112222"], 0]]);
  const carol = (await get("q=carol")).body.people;
  assert.deepEqual(carol.map((p: any) => [p.name, p.source, p.phones.map((x: any) => x.value).sort(), p.emails.map((x: any) => x.value)]),
    [["Carol Diaz", "contact", ["+15551112222", "+15553334444"], ["carol@x.test"]]]);
});

test("fix round 1 (I2): a number without a country code is never matched across countries or on the last 10 digits", async () => {
  const us = "iMessage;-;+12079460018";
  conv(conversationIdForChat(us), { network: "imessage", sourceRef: us, members: [{ memberId: "tel:+12079460018", personId: null }] });
  contacts = [
    { displayName: "Uk Friend", phoneNumbers: [{ address: "020 7946 0018" }], emails: [] }, // UK trunk-0 national form
    { displayName: "Us Friend", phoneNumbers: [{ address: "(207) 946-0018" }], emails: [] }, // US national form
  ];
  assert.deepEqual((await get("q=uk")).body.people, [], "the UK number is not offered as the US one");
  assert.deepEqual((await get("q=us%20friend")).body.people[0].phones.map((x: any) => x.value), ["+12079460018"]);
  // Once a +44 number with the same national digits is known too, the US form is ambiguous → dropped.
  const uk = "iMessage;-;+442079460018";
  conv(conversationIdForChat(uk), { network: "imessage", sourceRef: uk, members: [{ memberId: "tel:+442079460018", personId: null }] });
  setRecipientSourceForTests({ people: async () => [], contacts: async () => contacts, book: async () => EMPTY_BOOK });
  assert.deepEqual((await get("q=us%20friend")).body.people, []);
});

test("fix round 1 (M5): a FAILED vault listing answers partial (Contacts still offered) and is rebuilt soon, not cached as complete", async () => {
  let calls = 0;
  contacts = [{ displayName: "Zed Contact", phoneNumbers: [{ address: "+15550007777" }], emails: [] }];
  setRecipientSourceForTests({ people: async () => { calls++; return null; }, contacts: async () => contacts, book: async () => EMPTY_BOOK });
  const r = await get("q=zed");
  assert.equal(r.body.partial, true);
  assert.deepEqual(r.body.people.map((p: any) => p.name), ["Zed Contact"]);
  assert.equal((await get("q=zed")).body.partial, true);
  assert.equal(calls, 1, "served from the short-lived cache meanwhile");
});
