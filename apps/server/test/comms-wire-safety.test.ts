/**
 * Final wave I2a: every Comms response must decode in the strict Swift client — integer
 * numeric fields, and no lone UTF-16 surrogate anywhere (JSON.stringify emits "\ud83d" for
 * one, which JSONDecoder rejects). Each text cut lands on a code-point / grapheme boundary.
 * Synthetic fixtures only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "./helpers";
import { normalizeEvents, type NormalizeCtx } from "../src/comms/normalize";
import { fromMarkdownLite, MAX_BODY_CHARS } from "../src/comms/richtext";
import { messageOut, threadOut } from "../src/comms/timeline";
import { clipText, wellFormed, wellFormedDeep } from "../src/comms/wire";
import { rebuildProjection, conversationIdFor, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { PeopleIndex } from "../src/worker/people";
import { getThread } from "../src/comms/store";
import type { MatrixEvent } from "../src/worker/matrix";
import type { Note } from "../src/parachute";
import type { Message } from "../src/comms/types";

beforeEach(() => resetDb());

const E = "😀"; // two UTF-16 units
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** "a"×(n-1) then an emoji: a UTF-16 cut at n splits the emoji. */
const straddle = (n: number) => "a".repeat(n - 1) + E + "tail";
function assertWire(v: unknown, what: string) {
  const s = JSON.stringify(v);
  assert.ok(!/\\ud[89a-f][0-9a-f]{2}/i.test(s), `${what}: JSON has a lone surrogate escape`);
}
const ME = "@owner:hs.test";
const ALICE = "@alice:hs.test";
const BRIDGE = "@whatsappbot:hs.test";
const ctx = (): NormalizeCtx => ({ threadId: "th_x", network: "whatsapp", selfIds: [ME], agentIds: [], names: { [ALICE]: "Alice" }, avatars: {} });
let ts = 1_700_000_000_000;
const ev = (id: string, sender: string, content: Record<string, unknown>, type = "m.room.message", extra: Record<string, unknown> = {}): MatrixEvent =>
  ({ type, event_id: id, sender, origin_server_ts: ts += 1000, content, ...extra }) as MatrixEvent;

test("clipText cuts on code-point and grapheme boundaries; wellFormed repairs lone surrogates", () => {
  assert.equal(clipText(straddle(10), 10), "a".repeat(9));
  assert.equal(clipText("ab" + E, 3), "ab");
  assert.equal(clipText("short", 10), "short");
  // a ZWJ family is one grapheme: never cut inside it
  const fam = "👨‍👩‍👧";
  assert.equal(clipText("ab" + fam + "c", 5), "ab");
  // a flag (two regional indicators) is one grapheme
  assert.equal(clipText("x🇺🇸y", 3), "x");
  // a trailing lone high surrogate (an earlier UTF-16 cut) is dropped, not rendered
  assert.equal(clipText("abc\ud83d", 1000), "abc");
  assert.equal(wellFormed("a\ud83db"), "a�b");
  assert.equal(wellFormed("a\ude00b"), "a�b");
  assert.equal(wellFormed(`ok${E}`), `ok${E}`);
  assert.deepEqual(wellFormedDeep({ a: ["x\ud800", { b: "\udc00" }], n: 1, z: null }), { a: ["x�", { b: "�" }], n: 1, z: null });
});

test("attachment numbers are integers: fractions rounded, unsafe/negative dropped", () => {
  const { messages } = normalizeEvents([
    ev("$img", ALICE, { msgtype: "m.image", body: "p.png", url: "mxc://hs/p", info: { w: 1.5, h: 47.4, size: 6297.9, mimetype: "image/png" } }),
    ev("$vid", ALICE, { msgtype: "m.video", body: "v.mp4", url: "mxc://hs/v", info: { w: 1e300, h: -3, size: Number.MAX_SAFE_INTEGER * 4, duration: 1234.56 } }),
  ], ctx());
  const [img, vid] = messages.map((m) => m.attachments[0]!);
  assert.deepEqual([img!.w, img!.h, img!.size], [2, 47, 6298]);
  assert.equal(vid!.w, undefined);
  assert.equal(vid!.h, undefined);
  assert.equal(vid!.size, undefined);
  assert.equal(vid!.durationMs, 1235);
  for (const a of [img!, vid!]) for (const k of ["w", "h", "size", "durationMs"] as const) {
    if (a[k] !== undefined) assert.ok(Number.isSafeInteger(a[k]), `${k} integer`);
  }
});

test("an emoji straddling every normalizer clip point never leaves a lone surrogate", () => {
  const lp = { "og:url": "https://example.test/a", "og:title": straddle(300), "og:description": straddle(1000), "og:site_name": straddle(200) };
  const events: MatrixEvent[] = [
    ev("$link", ALICE, { msgtype: "m.text", body: "see https://example.test/a", "com.beeper.linkpreviews": [lp] }),
    ev("$file", ALICE, { msgtype: "m.file", body: straddle(255), url: "mxc://hs/f" }),
    ev("$loc", ALICE, { msgtype: "m.location", body: straddle(255), geo_uri: "geo:" + straddle(196) }),
    ev("$notice", BRIDGE, { msgtype: "m.notice", body: straddle(500) }),
    ev("$name", ALICE, { name: straddle(200) }, "m.room.name", { state_key: "" }),
    ev("$topic", ALICE, { topic: straddle(300) }, "m.room.topic", { state_key: "" }),
    ev("$own", ME, { msgtype: "m.text", body: "mine" }),
    ev("$react", ALICE, { "m.relates_to": { rel_type: "m.annotation", event_id: "$link", key: straddle(64) } }, "m.reaction"),
    ev("$fail", BRIDGE, { "m.relates_to": { rel_type: "m.reference", event_id: "$own" }, status: "FAIL", message: straddle(300) }, "com.beeper.message_send_status"),
    ev("$reply", ALICE, { msgtype: "m.text", body: "re", "m.relates_to": { "m.in_reply_to": { event_id: "$notice" } } }),
    ev("$reply2", ALICE, { msgtype: "m.text", body: "re2", "m.relates_to": { "m.in_reply_to": { event_id: "$long" } } }),
    ev("$long", ALICE, { msgtype: "m.text", body: straddle(120) }),
  ];
  const { messages } = normalizeEvents(events, ctx());
  const by = new Map(messages.map((m) => [m.id, m]));
  assert.equal(by.get("$link")!.linkPreviews[0]!.title, "a".repeat(299));
  assert.equal(by.get("$link")!.linkPreviews[0]!.description, "a".repeat(999));
  assert.equal(by.get("$file")!.attachments[0]!.name, "a".repeat(254));
  assert.equal(by.get("$notice")!.system!.text, "a".repeat(499));
  assert.ok(by.get("$name")!.system!.text.includes("a".repeat(199) + "”"));
  assert.ok(by.get("$topic")!.system!.text.includes("a".repeat(299) + "”"));
  assert.equal(by.get("$link")!.reactions[0]!.key, "a".repeat(63));
  assert.equal(by.get("$own")!.deliveryError, "a".repeat(299));
  for (const m of messages) {
    assert.ok(!LONE.test(JSON.stringify(m)), `${m.id}: lone surrogate`);
    assertWire(m, m.id);
  }
  assert.equal(by.get("$reply")!.replyTo!.snippet, "a".repeat(120));
  assert.equal(by.get("$reply2")!.replyTo!.snippet, "a".repeat(119));
});

test("rich text: the 64k plain cut and an emoji at the boundary stay well-formed", () => {
  const r = fromMarkdownLite(straddle(MAX_BODY_CHARS));
  assert.equal(r.truncated, true);
  assert.ok(!LONE.test(r.plain));
  assert.ok(!LONE.test(JSON.stringify(r.spans)));
  assertWire(r, "richtext");
});

test("input lone surrogates (hostile Matrix JSON) are repaired on the wire: messageOut / threadOut", () => {
  const { messages } = normalizeEvents([ev("$bad", ALICE, { msgtype: "m.text", body: "x\ud83dy" })], ctx());
  const out = messageOut(messages[0]!, { email: "owner@test.local" });
  assertWire(out, "messageOut");
  assert.equal(out.body!.plain, "x�y");
  const t = threadOut({ id: "th_1", title: "T\udc00", avatar: { monogram: "T" } } as never, { email: "owner@test.local" });
  assertWire(t, "threadOut");
});

test("thread preview from a vault lastMessageText cut mid-emoji is well-formed", async () => {
  const text = "a".repeat(999) + "\ud83d"; // the vault's body.slice(0, 1000)
  const note: Note = {
    id: "n1", content: "", path: "Messages/n1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags: ["message-thread"],
    metadata: { type: "message-thread", matrixRoomId: "!a:hs", lastMessageAt: 1_760_000_000_000, lastMessageText: text, lastMessageSender: "@b:hs", lastMessageIsSelf: false },
  };
  const deps: ProjectDeps = {
    vault: { listByTag: async () => [note] },
    reader: { whoami: async () => "@me:hs", roomState: async () => [] as never, memberProfiles: async () => ({ "@me:hs": { name: "Me", avatar: null }, "@b:hs": { name: "Bea", avatar: null } }) },
    people: peopleAdapter(new PeopleIndex([])),
  };
  await rebuildProjection(deps);
  const t = getThread(`th_${conversationIdFor("!a:hs")}`)!;
  assert.equal(t.lastMessage!.text, "a".repeat(999));
  assertWire(t, "thread");
});

// Keep the type import used (Message is the wire shape asserted above).
export type _M = Message;
