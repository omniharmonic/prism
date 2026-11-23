import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { distinctPeople, roomMetaFromState } from "../src/comms/room-meta.js";
import type { MatrixEvent } from "../src/worker/matrix.js";

const ev = (type: string, content: Record<string, unknown>, state_key = ""): MatrixEvent => ({ type, content, state_key });
const bridge = (id: string, extra: Record<string, unknown> = {}) =>
  ev("m.bridge", { protocol: { id, ...extra }, channel: { displayname: "Chan", avatar_url: "mxc://s/chan" } }, "b");

describe("comms room meta", () => {
  it("m.bridge protocol id wins", () => {
    assert.equal(roomMetaFromState([bridge("whatsapp")], ["@telegram_1:s"], []).network, "whatsapp");
  });
  it("reads legacy uk.half-shot.bridge when m.bridge absent", () => {
    const e = ev("uk.half-shot.bridge", { protocol: { id: "discord" } }, "b");
    assert.equal(roomMetaFromState([e], [], []).network, "discord");
  });
  it("maps protocol ids", () => {
    for (const id of ["facebook", "messenger", "meta"]) assert.equal(roomMetaFromState([bridge(id)], [], []).network, "messenger");
    assert.equal(roomMetaFromState([bridge("twitter")], [], []).network, "x");
  });
  it("fallback to detectPlatform", () => {
    assert.equal(roomMetaFromState([], ["@telegram_1:s"], []).network, "telegram");
    assert.equal(roomMetaFromState([], ["@a:s"], []).network, "matrix");
  });
  it("room type", () => {
    const m = ["@a:s", "@b:s", "@c:s"];
    assert.equal(roomMetaFromState([ev("com.beeper.room_type", { type: "dm" })], m, []).kind, "dm");
    assert.equal(roomMetaFromState([], ["@a:s", "@me:s"], ["@me:s"]).kind, "dm");
    // Off WhatsApp an untyped room keeps the old tolerance (≤ 2 others = DM; S1 is WhatsApp-only).
    assert.equal(roomMetaFromState([], ["@a:s", "@b:s", "@whatsappbot:s", "@me:s"], ["@me:s"]).kind, "dm");
    assert.equal(roomMetaFromState([], ["@a:s", "@whatsappbot:s", "@me:s"], ["@me:s"]).kind, "dm");
    assert.equal(roomMetaFromState([], m, []).kind, "group");
  });
  it("capabilities from com.beeper.room_features", () => {
    const f = ev("com.beeper.room_features", { reaction: false, edit: true, delete: false, reply: true });
    const c = roomMetaFromState([bridge("whatsapp"), f], [], []).capabilities;
    assert.deepEqual([c.react, c.edit, c.unsend, c.reply], [false, true, false, true]);
  });
  it("capability defaults per network", () => {
    for (const n of ["whatsapp", "telegram", "discord", "messenger"]) {
      const c = roomMetaFromState([bridge(n)], [], []).capabilities;
      assert.ok(Object.values(c).every(Boolean), n);
    }
    assert.equal(roomMetaFromState([bridge("twitter")], [], []).capabilities.edit, false);
    assert.ok(Object.values(roomMetaFromState([], [], []).capabilities).every(Boolean));
  });
  it("names", () => {
    const m = roomMetaFromState(
      [bridge("whatsapp"), ev("m.room.name", { name: "Room" }), ev("m.room.avatar", { url: "mxc://s/r" })], [], []);
    assert.equal(m.roomName, "Room");
    assert.equal(m.channelName, "Chan");
    assert.equal(m.roomAvatar, "mxc://s/r");
    assert.equal(m.channelAvatar, "mxc://s/chan");
  });
  it("room type inside m.bridge content (real mautrix shape)", () => {
    const m = ["@a:s", "@b:s", "@c:s"];
    const b = (c: Record<string, unknown>) => [ev("m.bridge", { protocol: { id: "whatsapp" }, ...c }, "b")];
    assert.equal(roomMetaFromState(b({ "com.beeper.room_type": "dm" }), m, []).kind, "dm");
    assert.equal(roomMetaFromState(b({ "com.beeper.room_type.v2": "group_dm", "com.beeper.room_type": "dm" }), m, []).kind, "group");
    assert.equal(roomMetaFromState(b({ "com.beeper.room_type.v2": "space" }), ["@a:s"], []).kind, "group");
    assert.equal(roomMetaFromState(b({ "com.beeper.room_type.v2": "dm" }), m, []).kind, "dm");
  });
  it("real room_features shape: support levels, omitted = unsupported", () => {
    const f = ev("com.beeper.room_features", {
      id: "fake.v1", reaction: 2, edit: 0, delete: -2, reply: 1, typing_notifications: true,
      file: { "m.image": { mime_types: { "image/png": 2, "*/*": -2 } } },
    });
    const c = roomMetaFromState([bridge("whatsapp"), f], [], []).capabilities;
    assert.deepEqual(c, { react: true, edit: false, unsend: false, reply: true, typing: true, receipts: false, attachments: true });
    const none = ev("com.beeper.room_features", { file: { "m.file": { mime_types: { "*/*": -1 } } } });
    assert.equal(roomMetaFromState([none], [], []).capabilities.attachments, false);
  });
  it("prototype-key protocol ids fall back to matrix", () => {
    for (const id of ["constructor", "__proto__", "toString"]) assert.equal(roomMetaFromState([bridge(id)], [], []).network, "matrix");
  });
  it("bridge without protocol id falls through to the next bridge event", () => {
    const state = [ev("m.bridge", {}, "a"), ev("uk.half-shot.bridge", { protocol: { id: "telegram" } }, "b"), null as unknown as MatrixEvent];
    assert.equal(roomMetaFromState(state, [], []).network, "telegram");
  });

  describe("S1: DM vs group in untyped rooms", () => {
    const ME = "@me:s";
    const BOT = "@whatsappbot:s";
    const wa = [bridge("whatsapp")]; // legacy m.bridge without a room type
    it("one WhatsApp contact as phone + LID ghost (same display name) stays a DM", () => {
      const m = [ME, BOT, "@whatsapp_15550001111:s", "@whatsapp_lid-987654321:s"];
      const names = { "@whatsapp_15550001111:s": "Dana Cruz", "@whatsapp_lid-987654321:s": " dana cruz " };
      assert.equal(roomMetaFromState(wa, m, [ME], names).kind, "dm");
    });
    it("phone + LID ghosts with different names, or no names, are two people (group)", () => {
      const m = [ME, BOT, "@whatsapp_15550001111:s", "@whatsapp_lid-987654321:s"];
      assert.equal(roomMetaFromState(wa, m, [ME], { "@whatsapp_15550001111:s": "Dana", "@whatsapp_lid-987654321:s": "Eli" }).kind, "group");
      assert.equal(roomMetaFromState(wa, m, [ME]).kind, "group");
    });
    it("two phone ghosts with the same name are still two people", () => {
      const m = [ME, "@whatsapp_15550001111:s", "@whatsapp_15550002222:s"];
      assert.equal(roomMetaFromState(wa, m, [ME], { "@whatsapp_15550001111:s": "Sam", "@whatsapp_15550002222:s": "Sam" }).kind, "group");
    });
    it("3-person group without a room type is a group", () => {
      const m = [ME, BOT, "@whatsapp_15550001111:s", "@whatsapp_15550002222:s"];
      const meta = roomMetaFromState(wa, m, [ME], { "@whatsapp_15550001111:s": "Dana", "@whatsapp_15550002222:s": "Eli" });
      assert.equal(meta.kind, "group");
      assert.equal(meta.roomName, null);
    });
    it("named group without a room type is a group and keeps its name", () => {
      const m = [ME, BOT, "@whatsapp_15550001111:s", "@whatsapp_15550002222:s"];
      const meta = roomMetaFromState([...wa, ev("m.room.name", { name: "Book club" })], m, [ME]);
      assert.deepEqual([meta.kind, meta.roomName], ["group", "Book club"]);
    });
    it("an explicit room type still wins", () => {
      const m = [ME, "@whatsapp_15550001111:s", "@whatsapp_15550002222:s"];
      assert.equal(roomMetaFromState([ev("m.bridge", { protocol: { id: "whatsapp" }, "com.beeper.room_type": "dm" }, "b")], m, [ME]).kind, "dm");
    });
    it("fix round 1 (I1): an untyped Telegram DM whose owner ghost is NOT in selfIds stays a DM", () => {
      const tg = [ev("m.bridge", { protocol: { id: "telegram" } }, "b")];
      const m = [ME, "@telegrambot:s", "@telegram_111:s" /* the owner's own ghost, undetected */, "@telegram_222:s"];
      assert.equal(roomMetaFromState(tg, m, [ME], { "@telegram_111:s": "Owner", "@telegram_222:s": "Pat" }).kind, "dm");
      // …and 3 others is still a group there.
      assert.equal(roomMetaFromState(tg, [...m, "@telegram_333:s"], [ME]).kind, "group");
    });
    it("fix round 1 (I1): the same shape on WhatsApp (owner ghost + 1 contact, owner ghost not detected) is a group — strict there", () => {
      const m = [ME, BOT, "@whatsapp_15550009999:s", "@whatsapp_15550001111:s"];
      assert.equal(roomMetaFromState(wa, m, [ME], { "@whatsapp_15550009999:s": "Owner", "@whatsapp_15550001111:s": "Pat" }).kind, "group");
      // With the owner ghost detected (production: phone + LID owner ghosts are) it is the DM it is.
      assert.equal(roomMetaFromState(wa, m, [ME, "@whatsapp_15550009999:s"]).kind, "dm");
    });
    it("fix round 1 (M7): two different people with one name in a NAMED group are not collapsed into a DM", () => {
      const m = [ME, BOT, "@whatsapp_15550001111:s", "@whatsapp_lid-987654321:s"];
      const names = { "@whatsapp_15550001111:s": "John", "@whatsapp_lid-987654321:s": "John" };
      assert.equal(roomMetaFromState([...wa, ev("m.room.name", { name: "Climbing" })], m, [ME], names).kind, "group");
      // A legacy DM portal named after the contact still collapses.
      assert.equal(roomMetaFromState([...wa, ev("m.room.name", { name: "John" })], m, [ME], names).kind, "dm");
    });
    it("distinctPeople counts a proven phone/LID pair once", () => {
      const ids = ["@whatsapp_1555:s", "@whatsapp_lid-9:s", "@whatsapp_lid-8:s"];
      assert.equal(distinctPeople(ids, { "@whatsapp_1555:s": "A", "@whatsapp_lid-9:s": "A", "@whatsapp_lid-8:s": "A" }), 2);
      assert.equal(distinctPeople(ids), 3);
    });
  });
});

// ── Telegram forum topics (owner-testing round 4, item 5 groundwork) ────────────────────────────

test("a Telegram forum topic room names its forum (bridgev2 m.bridge channel.id + network = the parent forum)", () => {
  const bridge = (channelId: string, network?: Record<string, unknown>) => [{
    type: "m.bridge", state_key: "x", content: {
      protocol: { id: "telegram", displayname: "Telegram" },
      channel: { id: channelId, displayname: "General" },
      ...(network ? { network } : {}),
    },
  }] as never[];
  const forum = { id: "channel:1001234:-1", displayname: "Treegens DAO", avatar_url: "mxc://example.test/forum" };
  const topic = roomMetaFromState(bridge("channel:1001234:7", forum), ["@telegram_1:x", "@telegram_2:x", "@telegram_3:x"], []);
  assert.deepEqual(topic.forum, { key: "telegram:channel:1001234", name: "Treegens DAO", avatar: "mxc://example.test/forum", topicId: "7" });
  // Two topics of the same forum share the key.
  assert.equal(roomMetaFromState(bridge("channel:1001234:12", forum), [], []).forum?.key, "telegram:channel:1001234");
  // The forum's own space room, a plain supergroup, a chat and other networks are not topics.
  assert.equal(roomMetaFromState(bridge("channel:1001234:-1"), [], []).forum, null);
  assert.equal(roomMetaFromState(bridge("channel:1001234"), [], []).forum, null);
  assert.equal(roomMetaFromState(bridge("chat:555"), [], []).forum, null);
  const slack = [{ type: "m.bridge", state_key: "x", content: { protocol: { id: "slack" }, channel: { id: "channel:1:2" }, network: { displayname: "Acme" } } }] as never[];
  assert.equal(roomMetaFromState(slack, [], []).forum, null);
  // No parent section (an older bridge): still a topic, the name is unknown.
  assert.deepEqual(roomMetaFromState(bridge("channel:42:3"), [], []).forum, { key: "telegram:channel:42", name: null, avatar: null, topicId: "3" });
});
