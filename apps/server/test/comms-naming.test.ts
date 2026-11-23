import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatHandle } from "../src/comms/naming.js";

describe("comms naming: formatHandle", () => {
  it("NANP numbers", () => {
    assert.equal(formatHandle("@whatsapp_15550001:staging.local"), "+1 555-0001");
    assert.equal(formatHandle("@whatsapp_15555550123:staging.local"), "+1 555-555-0123");
    assert.equal(formatHandle("+15555550123"), "+1 555-555-0123");
  });
  it("other country codes group in 3-4", () => {
    assert.equal(formatHandle("@whatsapp_447700900123:s"), "+44 770 090 0123");
    assert.match(formatHandle("@whatsapp_4915550001234:s"), /^\+49 \d{3,4}( \d{3,4})*$/);
  });
  it("non-numeric localparts become @handle with the network prefix removed", () => {
    assert.equal(formatHandle("@telegram_alice_example:s"), "@alice_example");
    assert.equal(formatHandle("@instagram_trail.crew:s"), "@trail.crew");
    assert.equal(formatHandle("@alice:hs.test"), "@alice");
  });
  it("numeric ids on networks without phone numbers are not phones", () => {
    assert.equal(formatHandle("@discord_123456789012345678:s"), "@123456789012345678");
    assert.equal(formatHandle("@telegram_123456789:s"), "@123456789");
  });
  it("never leaks the server", () => {
    for (const raw of ["@whatsapp_15550001:staging.local", "@x:staging.local", "@:staging.local", "staging.local", "@whatsapp_:s"])
      assert.ok(!formatHandle(raw).includes(":"), raw);
  });
});

import { previewText, resolveAvatar, resolveTitle } from "../src/comms/naming.js";
import type { Message } from "../src/comms/types.js";

const base = { memberDisplayNames: [] as string[], kind: "dm" as const };

function msg(over: Partial<Message> & { text?: string; self?: boolean } = {}): Message {
  const { text, self, ...rest } = over;
  return {
    id: "m1", threadId: "t", channel: { network: "whatsapp", accountLabel: null },
    source: { network: "whatsapp", eventId: "$e", ref: "$e" },
    sender: { id: "u", name: "Alice Example", avatar: null, isSelf: !!self, isOmni: false },
    sentAt: "2026-01-01T00:00:00Z",
    body: text === undefined ? null : { spans: [], plain: text, jumboEmoji: false, truncated: false },
    attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false, ...rest,
  } as Message;
}

describe("comms naming: resolveTitle", () => {
  it("person wins", () => {
    assert.deepEqual(resolveTitle({ ...base, person: { name: "Sam Rivera" }, roomName: "Sam" }), { title: "Sam Rivera", titleSource: "person" });
  });
  it("unnamed bridged DM uses the contact name", () => {
    assert.deepEqual(resolveTitle({ ...base, memberDisplayNames: ["Alice Example"] }), { title: "Alice Example", titleSource: "contact" });
  });
  it("never raw ids", () => {
    const r = resolveTitle({ ...base, memberDisplayNames: ["@whatsapp_15550001:staging.local"], handle: "@whatsapp_15550001:staging.local" });
    assert.deepEqual(r, { title: "+1 555-0001", titleSource: "handle" });
    assert.ok(!r.title.includes("@") && !r.title.includes(":staging"));
  });
  it("slug-like room names are treated as missing", () => {
    for (const roomName of ["whatsapp_15550001", "!abc:server", "@bob:server", "#room:server", "vault/messages/whatsapp/alice", "trail-crew-2", "whatsapp-15550001", "sam-rivera-notes", "Empty Room"])
      assert.equal(resolveTitle({ ...base, roomName, memberDisplayNames: ["Alice Example"] }).title, "Alice Example", roomName);
  });
  it("genuine names survive", () => {
    for (const roomName of ["Climbers", "Trail Crew", "Sam", "Q4 Plan", "co-op", "e-bikes", "AC/DC", "Work/Life", "#1: Fans", "Signal_Boost"])
      assert.equal(resolveTitle({ ...base, roomName, kind: "group" }).title, roomName);
  });
  it("channel name is used when no room name; email display name for email DMs", () => {
    assert.equal(resolveTitle({ ...base, channelName: "Book Club", kind: "group" }).title, "Book Club");
    assert.deepEqual(resolveTitle({ ...base, emailDisplayName: "Dana Test", memberDisplayNames: ["dana@example.test"] }), { title: "Dana Test", titleSource: "email" });
  });
  it("group without a name", () => {
    const names = ["Alice", "Bob", "Carol", "Dan"];
    assert.equal(resolveTitle({ ...base, kind: "group", memberDisplayNames: names }).title, "Alice, Bob & 2 others");
    assert.equal(resolveTitle({ ...base, kind: "group", memberDisplayNames: names.slice(0, 2) }).title, "Alice & Bob");
  });
  it("phone-number display names are formatted, typed handle, and lose to real names", () => {
    for (const n of ["+1 555 0001", "15550001", "+1 (555) 0001"])
      assert.deepEqual(resolveTitle({ ...base, memberDisplayNames: [n] }), { title: "+1 555-0001", titleSource: "handle" }, n);
    assert.deepEqual(resolveTitle({ ...base, roomName: "+1 555 555 0123" }), { title: "+1 555-555-0123", titleSource: "handle" });
    assert.deepEqual(resolveTitle({ ...base, kind: "group", memberDisplayNames: ["+15550001", "Alice"] }), { title: "Alice", titleSource: "contact" });
  });
  it("strips network suffixes from display names", () => {
    assert.equal(resolveTitle({ ...base, memberDisplayNames: ["Alice Example (WA)"] }).title, "Alice Example");
    assert.equal(resolveTitle({ ...base, memberDisplayNames: ["Bob (Telegram)"] }).title, "Bob");
    assert.equal(resolveTitle({ ...base, memberDisplayNames: ["Bob (whatsapp) "] }).title, "Bob");
    assert.equal(resolveTitle({ ...base, memberDisplayNames: ["Bob (Work)"] }).title, "Bob (Work)");
  });
  it("3-member group with self excluded by the caller", () => {
    assert.equal(resolveTitle({ ...base, kind: "group", memberDisplayNames: ["Alice", "Bob"] }).title, "Alice & Bob");
    assert.equal(resolveTitle({ ...base, kind: "group", memberDisplayNames: ["Alice", "Bob", "Carol"] }).title, "Alice, Bob & Carol");
  });
  it("nothing at all is never an id", () => {
    assert.equal(resolveTitle({ ...base, roomName: "!x:y" }).title, "Unknown");
  });
});

describe("comms naming: previewText", () => {
  it("tapback quotes truncate at 24 code points", () => {
    const m = msg({ text: "Dinner at 7 works for everyone here" });
    assert.equal(previewText(m, "Sam", false, "❤️"), "Sam loved “Dinner at 7 works for ev…”");
    assert.equal(previewText(msg({ text: "Dinner at 7" }), "Sam", false, "👍"), "Sam liked “Dinner at 7”");
    assert.equal(previewText(msg({ text: "🎉".repeat(30) }), "Sam", false, "🔥"), `Sam reacted 🔥 to “${"🎉".repeat(24)}…”`);
  });
  it("attachments", () => {
    assert.equal(previewText(msg({ attachments: [{ kind: "image" }] }), "Alice", false), "📷 Photo");
    assert.equal(previewText(msg({ attachments: [{ kind: "voice", durationMs: 7000 }] }), "Alice", false), "Voice message 0:07");
  });
  it("group prefix for others, none for own", () => {
    assert.equal(previewText(msg({ text: "hi" }), "Alice", true), "Alice: hi");
    assert.equal(previewText(msg({ text: "hi", self: true }), "Me", true), "hi");
    assert.equal(previewText(msg({ text: "hi" }), "Alice", false), "hi");
  });
});

describe("comms naming: resolveAvatar", () => {
  const t = "Alice Example";
  it("precedence", () => {
    assert.deepEqual(resolveAvatar({ title: t, personPhoto: "mxc://a/p", roomAvatar: "mxc://a/r", channelAvatar: "mxc://a/c", dmMemberAvatar: "mxc://a/d" }), { mxc: "mxc://a/p" });
    assert.deepEqual(resolveAvatar({ title: t, roomAvatar: "mxc://a/r", channelAvatar: "mxc://a/c", dmMemberAvatar: "mxc://a/d" }), { mxc: "mxc://a/r" });
    assert.deepEqual(resolveAvatar({ title: t, channelAvatar: "mxc://a/c", dmMemberAvatar: "mxc://a/d" }), { mxc: "mxc://a/c" });
    assert.deepEqual(resolveAvatar({ title: t, dmMemberAvatar: "mxc://a/d" }), { mxc: "mxc://a/d" });
  });
  it("monograms", () => {
    assert.deepEqual(resolveAvatar({ title: t }), { monogram: "AE" });
    assert.deepEqual(resolveAvatar({ title: "+1 555-0001" }), { monogram: "#" });
    assert.deepEqual(resolveAvatar({ title: "élan 🎉 Club" }), { monogram: "É🎉" });
    assert.deepEqual(resolveAvatar({ title: "Climbers" }), { monogram: "C" });
  });
  it("group with no avatar gets a member cluster of the first 3", () => {
    assert.deepEqual(resolveAvatar({ title: "Crew", memberAvatars: [null, "mxc://a/1", "mxc://a/2", "mxc://a/3", "mxc://a/4"] }), {
      monogram: "", members: [{ mxc: "mxc://a/1" }, { mxc: "mxc://a/2" }, { mxc: "mxc://a/3" }],
    });
    assert.deepEqual(resolveAvatar({ title: "Crew", memberAvatars: [null] }), { monogram: "C" });
  });
});
