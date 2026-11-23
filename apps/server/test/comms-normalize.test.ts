import assert from "node:assert/strict";
import { replyOut } from "../src/comms/timeline";
import { describe, it } from "node:test";
import { cpuOf } from "./probe.js";
import { MAX_PENDING, normalizeEvents, type NormalizeCtx } from "../src/comms/normalize.js";
import type { Message } from "../src/comms/types.js";
import type { MatrixEvent } from "../src/worker/matrix.js";

const ME = "@owner:hs.test";
const PUPPET = "@whatsapp_15550009:hs.test";
const ALICE = "@whatsapp_15550001:hs.test";
const BOB = "@whatsapp_15550002:hs.test";
const BRIDGE = "@whatsappbot:hs.test";

const ctx = (over: Partial<NormalizeCtx> = {}): NormalizeCtx => ({
  threadId: "t_test",
  network: "whatsapp",
  selfIds: [ME],
  agentIds: [PUPPET],
  names: { [ME]: "Owner Person", [ALICE]: "Alice", [BOB]: "Bob" },
  avatars: { [ALICE]: "mxc://hs.test/alice", [BOB]: null },
  ...over,
});

let ts = 1_700_000_000_000;
const ev = (event_id: string, sender: string, content: Record<string, unknown>, type = "m.room.message", extra: Partial<MatrixEvent> = {}): MatrixEvent =>
  ({ type, event_id, sender, origin_server_ts: ts += 1000, content, ...extra });
const text = (id: string, sender: string, body: string, extra: Record<string, unknown> = {}) =>
  ev(id, sender, { msgtype: "m.text", body, ...extra });
const react = (id: string, sender: string, target: string, key: string) =>
  ev(id, sender, { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } }, "m.reaction");
const edit = (id: string, sender: string, target: string, body: string) =>
  ev(id, sender, { msgtype: "m.text", body: `* ${body}`, "m.new_content": { msgtype: "m.text", body }, "m.relates_to": { rel_type: "m.replace", event_id: target } });
const status = (id: string, target: string, c: Record<string, unknown>) =>
  ev(id, BRIDGE, { "m.relates_to": { rel_type: "m.reference", event_id: target }, network: "whatsapp", ...c }, "com.beeper.message_send_status");

const one = (events: MatrixEvent[], c = ctx()): Message => {
  const { messages } = normalizeEvents(events, c);
  assert.equal(messages.length, 1, `expected one message, got ${messages.map((m) => m.id).join(",")}`);
  return messages[0]!;
};

describe("comms normalize", () => {
  it("isSelf from identity only", () => {
    const { messages } = normalizeEvents([
      text("$1", ME, "from owner"),
      text("$2", PUPPET, "from puppet"),
      text("$3", "@whatsapp_15550003:hs.test", "impostor"),
    ], ctx({ names: { [ME]: "Owner Person", "@whatsapp_15550003:hs.test": "Owner Person" } }));
    assert.deepEqual(messages.map((m) => [m.id, m.sender.isSelf, m.sender.isOmni]), [
      ["$1", true, false],
      ["$2", true, false],
      ["$3", false, false],
    ]);
    assert.equal(messages[2]!.sender.name, "Owner Person");
  });

  it("omni-agent's own user is isOmni", () => {
    const m = one([text("$1", "@omni-agent:localhost", "drafted")], ctx({ agentIds: ["@omni-agent:localhost"] }));
    assert.equal(m.sender.isSelf, true);
    assert.equal(m.sender.isOmni, true);
  });

  it("Omni's bridge puppet (an agent id like the Omni Telegram bot) is incoming isOmni, never the owner", () => {
    const bot = "@telegram_777:hs.test";
    const m = one([text("$1", bot, "your brief")], ctx({ agentIds: ["@omni-agent:localhost", bot, PUPPET], selfIds: [ME, bot, PUPPET], ownerIds: [ME, PUPPET] }));
    assert.equal(m.sender.isSelf, false);
    assert.equal(m.sender.isOmni, true);
    // The owner's own ghost stays the owner even when listed as an agent id.
    const own = one([text("$2", PUPPET, "mine")], ctx({ agentIds: [bot, PUPPET], selfIds: [ME, bot, PUPPET], ownerIds: [ME, PUPPET] }));
    assert.equal(own.sender.isSelf, true);
    assert.equal(own.sender.isOmni, false);
  });

  it("a reply names the quoted sender: You (the owner, incl. what Comms sent via the stored account), Omni (agent), else the name", () => {
    const quote = (sender: string, c = ctx()) => normalizeEvents([
      text("$p", sender, "parent"),
      { ...text("$r", ALICE, "answer"), content: { msgtype: "m.text", body: "answer", "m.relates_to": { "m.in_reply_to": { event_id: "$p" } } } },
    ], c).messages.find((m) => m.id === "$r")!.replyTo!;
    assert.equal(replyOut(quote(ME)).senderName, "You");
    assert.equal(replyOut(quote(PUPPET)).senderName, "You");
    assert.equal(replyOut(quote("@omni-agent:localhost", ctx({ agentIds: ["@omni-agent:localhost"] }))).senderName, "Omni");
    const a = replyOut(quote(ALICE));
    assert.equal(a.senderName, "Alice");
    assert.equal("senderSelf" in a || "senderOmni" in a, false, "server-only flags never reach the wire");
  });

  it("base fields", () => {
    const m = one([text("$a", ALICE, "hi")]);
    assert.equal(m.id, "$a");
    assert.equal(m.threadId, "t_test");
    assert.equal(m.source.network, "whatsapp");
    assert.equal(m.source.eventId, "$a");
    assert.equal(m.sender.name, "Alice");
    assert.deepEqual(m.sender.avatar, { mxc: "mxc://hs.test/alice" });
    assert.equal(m.sentAt, new Date(ts).toISOString());
    assert.equal(m.body?.plain, "hi");
    assert.equal(m.delivery, null);
    assert.equal(m.redacted, false);
    assert.deepEqual(m.reactions, []);
  });

  it("unknown senders use formatHandle, never a raw mxid", () => {
    const m = one([text("$a", "@whatsapp_15550077:hs.test", "hi")], ctx({ names: {} }));
    assert.equal(m.sender.name, "+1 555-0077");
    assert.equal(m.sender.avatar, null);
  });

  it("edit replaces content", () => {
    const m = one([text("$a", ALICE, "hello"), edit("$b", ALICE, "$a", "hello!")]);
    assert.equal(m.id, "$a");
    assert.equal(m.body?.plain, "hello!");
    assert.ok(m.editedAt);
  });

  it("latest edit wins regardless of input order; edits by other senders are ignored", () => {
    const a = text("$a", ALICE, "v0");
    const e1 = edit("$e1", ALICE, "$a", "v1");
    const e2 = edit("$e2", ALICE, "$a", "v2");
    const forged = edit("$e3", BOB, "$a", "forged");
    const m = one([forged, e2, e1, a]);
    assert.equal(m.body?.plain, "v2");
    assert.equal(m.editedAt, new Date(e2.origin_server_ts!).toISOString());
  });

  it("reactions aggregate", () => {
    const m = one([
      text("$a", ALICE, "hi"),
      react("$r1", ME, "$a", "👍"),
      react("$r2", ALICE, "$a", "❤️"),
      react("$r3", BOB, "$a", "👍"),
    ]);
    assert.deepEqual(m.reactions.map(({ key, count, mine }) => ({ key, count, mine })), [
      { key: "👍", count: 2, mine: true },
      { key: "❤️", count: 1, mine: false },
    ]);
    assert.deepEqual(m.reactions[0]!.senders.map((s) => s.name), ["Owner Person", "Bob"]);
  });

  it("redacted reaction is removed", () => {
    const m = one([
      text("$a", ALICE, "hi"),
      react("$r1", BOB, "$a", "👍"),
      ev("$x", BOB, { redacts: "$r1" }, "m.room.redaction"),
    ]);
    assert.deepEqual(m.reactions, []);
  });

  it("redaction", () => {
    const img = ev("$a", ALICE, { msgtype: "m.image", body: "p.jpg", url: "mxc://hs.test/p" });
    const viaEvent = one([img, ev("$x", ALICE, {}, "m.room.redaction", { redacts: "$a" } as Partial<MatrixEvent>)]);
    assert.equal(viaEvent.redacted, true);
    assert.equal(viaEvent.body, null);
    assert.deepEqual(viaEvent.attachments, []);
    const already = one([ev("$b", ALICE, {}, "m.room.message", { unsigned: { redacted_because: { type: "m.room.redaction" } } })]);
    assert.equal(already.redacted, true);
    assert.equal(already.body, null);
  });

  it("reply", () => {
    const long = "x".repeat(200);
    const { messages } = normalizeEvents([
      text("$a", ALICE, long),
      ev("$b", BOB, {
        msgtype: "m.text",
        body: `> <${ALICE}> ${long}\n\nsure`,
        format: "org.matrix.custom.html",
        formatted_body: `<mx-reply><blockquote>${long}</blockquote></mx-reply>sure`,
        "m.relates_to": { "m.in_reply_to": { event_id: "$a" } },
      }),
    ], ctx());
    const b = messages[1]!;
    assert.deepEqual(b.replyTo, { messageId: "$a", snippet: "x".repeat(120), senderName: "Alice" });
    assert.equal(b.body?.plain, "sure");
  });

  it("reply snippet reflects the target's edit", () => {
    const { messages } = normalizeEvents([
      text("$a", ALICE, "old"),
      text("$b", BOB, "ok", { "m.relates_to": { "m.in_reply_to": { event_id: "$a" } } }),
      edit("$e", ALICE, "$a", "new"),
    ], ctx());
    assert.equal(messages[1]!.replyTo?.snippet, "new");
  });

  it("relation before target across pages", () => {
    const old = text("$old", ALICE, "old text");
    const page1 = [edit("$e", ALICE, "$old", "old text (edited)"), react("$r", BOB, "$old", "😂"), text("$new", BOB, "newer")];
    const r1 = normalizeEvents(page1, ctx());
    assert.deepEqual(r1.messages.map((m) => m.id), ["$new"]);
    assert.equal(r1.pendingRelations.length, 2);
    const known = new Map(r1.messages.map((m) => [m.id, m]));
    const r2 = normalizeEvents([old, ...r1.pendingRelations], ctx({ known }));
    assert.equal(r2.messages.length, 1);
    const m = r2.messages[0]!;
    assert.equal(m.id, "$old");
    assert.equal(m.body?.plain, "old text (edited)");
    assert.deepEqual(m.reactions.map((x) => [x.key, x.count]), [["😂", 1]]);
    assert.equal(r2.pendingRelations.length, 0);
  });

  it("relations onto known messages come back as updated copies, idempotently", () => {
    const base = normalizeEvents([text("$a", ALICE, "hi")], ctx()).messages[0]!;
    const known = new Map([["$a", base]]);
    const r = react("$r", ME, "$a", "👍");
    const out = normalizeEvents([r], ctx({ known }));
    assert.deepEqual(out.messages, []);
    assert.equal(out.pendingRelations.length, 0);
    assert.equal(out.updated.length, 1);
    assert.deepEqual(out.updated[0]!.reactions.map((x) => [x.key, x.count, x.mine]), [["👍", 1, true]]);
    assert.deepEqual(base.reactions, [], "ctx.known is not mutated");
    const again = normalizeEvents([r, edit("$f", BOB, "$a", "forged")], ctx({ known: new Map([["$a", out.updated[0]!]]) }));
    assert.deepEqual(again.updated, [], "re-applied reaction and a forged edit change nothing");
    const unreact = normalizeEvents([ev("$x", ME, { redacts: "$r" }, "m.room.redaction")], ctx({ known: new Map([["$a", out.updated[0]!]]) }));
    assert.deepEqual(unreact.updated[0]!.reactions, []);
  });

  it("send status", () => {
    const failed = one([text("$a", ME, "hi"), status("$s", "$a", { status: "FAIL", reason: "m_foreign_network_error", message: "Not delivered" })]);
    assert.equal(failed.delivery, "failed");
    assert.equal(failed.deliveryError, "Not delivered");
    const delivered = one([text("$a", ME, "hi"), status("$s", "$a", { status: "SUCCESS", delivered_to_users: [ALICE] })]);
    assert.equal(delivered.delivery, "delivered");
    assert.equal(delivered.deliveryError, undefined);
    const sent = one([text("$a", ME, "hi"), status("$s", "$a", { status: "SUCCESS" })]);
    assert.equal(sent.delivery, "sent");
    const retried = one([text("$a", ME, "hi"), status("$s1", "$a", { status: "FAIL", message: "Not delivered" }), status("$s2", "$a", { status: "SUCCESS" })]);
    assert.equal(retried.delivery, "sent");
    assert.equal(retried.deliveryError, undefined);
  });

  it("link previews", () => {
    const m = one([text("$a", ALICE, "see https://example.test/x", {
      "com.beeper.linkpreviews": [{
        matched_url: "https://example.test/x",
        "og:title": "Example",
        "og:description": "An example page",
        "og:image": "mxc://s/img",
        "og:site_name": "Example Site",
      }],
    })]);
    assert.deepEqual(m.linkPreviews[0], {
      url: "https://example.test/x",
      title: "Example",
      description: "An example page",
      siteName: "Example Site",
      imageMxc: "mxc://s/img",
    });
  });

  it("attachments", () => {
    const img = one([ev("$a", ALICE, { msgtype: "m.image", body: "photo.jpg", url: "mxc://hs.test/img", info: { w: 800, h: 600, mimetype: "image/jpeg", size: 12345 } })]);
    assert.deepEqual(img.attachments, [{ kind: "image", mxc: "mxc://hs.test/img", mime: "image/jpeg", size: 12345, w: 800, h: 600, name: "photo.jpg" }]);
    assert.equal(img.body, null, "a bare filename is not a caption");
    const voice = one([ev("$b", ALICE, { msgtype: "m.audio", body: "voice.ogg", url: "mxc://hs.test/v", info: { duration: 7000, mimetype: "audio/ogg" }, "org.matrix.msc3245.voice": {} })]);
    assert.equal(voice.attachments[0]!.kind, "voice");
    assert.equal(voice.attachments[0]!.durationMs, 7000);
    const captioned = one([ev("$c", ALICE, { msgtype: "m.image", body: "look at this", filename: "p.jpg", url: "mxc://hs.test/p" })]);
    assert.equal(captioned.body?.plain, "look at this");
    assert.equal(captioned.attachments[0]!.name, "p.jpg");
    const sticker = one([ev("$d", ALICE, { body: "smile", url: "mxc://hs.test/s", info: { mimetype: "image/webp" } }, "m.sticker")]);
    assert.equal(sticker.attachments[0]!.kind, "sticker");
    const loc = one([ev("$e", ALICE, { msgtype: "m.location", body: "Here", geo_uri: "geo:1.5,2.5" })]);
    assert.deepEqual(loc.attachments[0], { kind: "location", geo: "geo:1.5,2.5", name: "Here" });
  });

  it("system events", () => {
    const { messages } = normalizeEvents([
      ev("$j", ALICE, { membership: "join", displayname: "Alice" }, "m.room.member", { state_key: ALICE }),
      ev("$n", ALICE, { name: "Trail Crew" }, "m.room.name", { state_key: "" }),
    ], ctx());
    assert.deepEqual(messages.map((m) => m.system), [
      { kind: "member", text: "Alice joined" },
      { kind: "name", text: "Alice named the conversation “Trail Crew”" },
    ]);
    assert.equal(messages[0]!.body, null);
  });

  it("member profile changes are not shown; invites name both sides", () => {
    const { messages } = normalizeEvents([
      ev("$p", ALICE, { membership: "join", displayname: "Alice B" }, "m.room.member", { state_key: ALICE, unsigned: { prev_content: { membership: "join", displayname: "Alice" } } } as Partial<MatrixEvent>),
      ev("$i", ALICE, { membership: "invite" }, "m.room.member", { state_key: BOB }),
      ev("$l", BOB, { membership: "leave" }, "m.room.member", { state_key: BOB }),
    ], ctx());
    assert.deepEqual(messages.map((m) => m.system?.text), ["Alice invited Bob", "Bob left"]);
  });

  it("output is newest-last and deduplicated; non-message events are dropped", () => {
    const a = text("$a", ALICE, "1");
    const b = text("$b", BOB, "2");
    const { messages } = normalizeEvents([b, a, b, ev("$pl", ALICE, {}, "m.room.power_levels", { state_key: "" })], ctx());
    assert.deepEqual(messages.map((m) => m.id), ["$a", "$b"]);
  });

  it("thread replies carry threadRoot and roots count them", () => {
    const { messages } = normalizeEvents([
      text("$root", ALICE, "root"),
      text("$t1", BOB, "in thread", { "m.relates_to": { rel_type: "m.thread", event_id: "$root", is_falling_back: true, "m.in_reply_to": { event_id: "$root" } } }),
    ], ctx());
    assert.equal(messages[0]!.replyCount, 1);
    assert.equal(messages[1]!.threadRoot, "$root");
    assert.equal(messages[1]!.replyTo, undefined);
  });

  it("100-event page stays fast", () => {
    const events: MatrixEvent[] = [];
    for (let i = 0; i < 50; i++) events.push(text(`$m${i}`, i % 2 ? ALICE : BOB, `message ${i}`));
    for (let i = 0; i < 50; i++) events.push(react(`$r${i}`, ME, `$m${i % 50}`, "👍"));
    const c = ctx();
    const { value, cpuMs } = cpuOf(() => { let n = 0; for (let i = 0; i < 100; i++) n += normalizeEvents(events, c).messages.length; return n; });
    assert.equal(value, 5000);
    assert.ok(cpuMs < 2000, `100 pages took ${cpuMs} ms of CPU`);
  });

  describe("fix round 1: hostile input", () => {
    it("prototype keys in msgtype, names and avatars do not reach the prototype", () => {
      for (const mt of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const m = one([ev(`$${mt}`, ALICE, { msgtype: mt, body: "x" })]);
        assert.deepEqual(m.attachments, [], mt);
        assert.equal(m.body?.plain, "x");
      }
      for (const id of ["constructor", "__proto__", "toString"]) {
        const m = one([text("$p", id, "x")], ctx({ names: {}, avatars: {} }));
        assert.equal(typeof m.sender.name, "string", id);
        assert.equal(m.sender.avatar, null, id);
      }
    });

    it("unusable origin_server_ts is clamped, never throws, never breaks ordering", () => {
      for (const bad of [9e15, -1e16, Number.NaN, Infinity, "abc" as unknown as number]) {
        const later = text("$ok", ALICE, "ok");
        const weird = { ...text("$w", ALICE, "w"), origin_server_ts: bad };
        const e = { ...edit("$e", ALICE, "$ok", "edited"), origin_server_ts: bad };
        const { messages } = normalizeEvents([later, weird, e], ctx());
        assert.equal(messages.length, 2, String(bad));
        for (const m of messages) assert.ok(!Number.isNaN(Date.parse(m.sentAt)), String(bad));
        assert.ok(!Number.isNaN(Date.parse(messages.find((m) => m.id === "$ok")!.editedAt ?? "")) || messages.find((m) => m.id === "$ok")!.editedAt === undefined);
      }
      const clamped = one([{ ...text("$big", ALICE, "x"), origin_server_ts: 9e15 }]);
      assert.equal(clamped.sentAt, new Date(8.64e15).toISOString());
    });

    it("un-react with the reaction and its redaction both re-seen against a known message", () => {
      const a = normalizeEvents([text("$a", ALICE, "hi")], ctx()).messages[0]!;
      const r = react("$r", BOB, "$a", "👍");
      const k1 = normalizeEvents([r], ctx({ known: new Map([["$a", a]]) })).updated[0]!;
      assert.equal(k1.reactions.length, 1);
      const x = ev("$x", BOB, { redacts: "$r" }, "m.room.redaction");
      const out = normalizeEvents([r, x], ctx({ known: new Map([["$a", k1]]) }));
      assert.equal(out.updated.length, 1);
      assert.deepEqual(out.updated[0]!.reactions, []);
      assert.equal(out.pendingRelations.length, 0);
    });

    it("send status is accepted only from a bridge bot about the owner's own message", () => {
      const forged = one([text("$m", ME, "hi"), ev("$s", "@evil:hs.test", { status: "FAIL", message: "pwned", "m.relates_to": { rel_type: "m.reference", event_id: "$m" } }, "com.beeper.message_send_status")]);
      assert.equal(forged.delivery, "sent");
      assert.equal(forged.deliveryError, undefined);
      const notMine = one([text("$m", ALICE, "hi"), status("$s", "$m", { status: "FAIL", message: "Not delivered" })]);
      assert.equal(notMine.delivery, null);
      assert.equal(notMine.deliveryError, undefined);
    });

    it("a reply loaded before its target heals when the older page arrives", () => {
      const reply = text("$b", BOB, "ok", { "m.relates_to": { "m.in_reply_to": { event_id: "$a" } } });
      const p1 = normalizeEvents([reply], ctx());
      assert.deepEqual(p1.messages[0]!.replyTo, { messageId: "$a", snippet: "", senderName: "" });
      const known = new Map(p1.messages.map((m) => [m.id, m]));
      const p2 = normalizeEvents([text("$a", ALICE, "the original")], ctx({ known }));
      assert.deepEqual(p2.messages.map((m) => m.id), ["$a"]);
      assert.equal(p2.updated.length, 1);
      assert.deepEqual(p2.updated[0]!.replyTo, { messageId: "$a", snippet: "the original", senderName: "Alice" });
      assert.equal(known.get("$b")!.replyTo!.senderName, "", "ctx.known is not mutated");
    });

    it("pendingRelations is capped, keeping the newest", () => {
      const evs: MatrixEvent[] = [];
      for (let i = 0; i < MAX_PENDING + 50; i++) evs.push(react(`$pr${i}`, `@u${i}:hs.test`, "$missing", "👍"));
      const { pendingRelations } = normalizeEvents(evs, ctx());
      assert.equal(pendingRelations.length, MAX_PENDING);
      assert.equal(pendingRelations.at(-1)!.event_id, `$pr${MAX_PENDING + 49}`);
      assert.equal(pendingRelations[0]!.event_id, "$pr50");
    });

    it("encrypted edits and reactions are not bubbles", () => {
      const { messages } = normalizeEvents([
        text("$a", ALICE, "hi"),
        ev("$e1", ALICE, { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x", "m.relates_to": { rel_type: "m.replace", event_id: "$a" } }, "m.room.encrypted"),
        ev("$e2", BOB, { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x", "m.relates_to": { rel_type: "m.annotation", event_id: "$a" } }, "m.room.encrypted"),
        ev("$e3", BOB, { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" }, "m.room.encrypted"),
      ], ctx());
      assert.deepEqual(messages.map((m) => [m.id, m.system?.kind ?? null]), [["$a", null], ["$e3", "undecryptable"]]);
    });
  });

  describe("fix round 2: non-string event fields", () => {
    it("non-string senders and contents never throw and never count", () => {
      for (const bad of [1, {}, ["x"], null, true] as unknown as string[]) {
        const events: MatrixEvent[] = [
          text("$m", ME, "hi"),
          { ...status("$s", "$m", { status: "FAIL", message: "x" }), sender: bad },
          { ...text("$o", ALICE, "x"), sender: bad },
          { ...react("$r", ALICE, "$m", "👍"), sender: bad },
          text("$gone", ALICE, "to be redacted"),
          { ...ev("$x", ALICE, { redacts: "$gone" }, "m.room.redaction"), sender: bad },
          { ...text("$c", ALICE, "x"), content: "not an object" as unknown as Record<string, unknown> },
          { ...text("$d", ALICE, "x"), content: ["x"] as unknown as Record<string, unknown> },
        ];
        const out = normalizeEvents(events, ctx());
        const m = out.messages.find((x) => x.id === "$m")!;
        assert.equal(m.delivery, "sent", JSON.stringify(bad));
        assert.deepEqual(m.reactions, [], JSON.stringify(bad));
        assert.ok(!out.messages.some((x) => x.id === "$o"), JSON.stringify(bad));
        for (const x of out.messages) assert.equal(typeof x.sender.id, "string");
      }
    });
  });
});

describe("comms normalize: names go through the naming filter (ledger F2)", () => {
  const GHOST = "@whatsapp_15550001:hs.test";
  const TG = "@telegram_987654321:hs.test";
  const ghostCtx = () => ctx({ names: { [ME]: "Owner Person", [GHOST]: "whatsapp_15550001", [TG]: "telegram_987654321", [BOB]: "Bob" } });
  it("system lines never show a raw ghost localpart", () => {
    const { messages } = normalizeEvents([
      ev("$j", GHOST, { membership: "join", displayname: "whatsapp_15550001" }, "m.room.member", { state_key: GHOST }),
      ev("$i", BOB, { membership: "invite" }, "m.room.member", { state_key: TG }),
      ev("$n", GHOST, { name: "Trail Crew" }, "m.room.name", { state_key: "" }),
    ], ghostCtx());
    const texts = messages.map((m) => m.system?.text);
    assert.deepEqual(texts, ["+1 555-0001 joined", "Bob invited @987654321", "+1 555-0001 named the conversation “Trail Crew”"]);
    for (const t of texts) assert.doesNotMatch(t!, /whatsapp_|telegram_|:hs\.test/);
  });
  it("a ghost sender's display name is formatted (so 'X unsent a message' reads well)", () => {
    const { messages } = normalizeEvents([text("$t", GHOST, "hi"), ev("$r", GHOST, { redacts: "$t" }, "m.room.redaction", { redacts: "$t" } as Partial<MatrixEvent>)], ghostCtx());
    assert.equal(messages[0]!.sender.name, "+1 555-0001");
    assert.equal(messages[0]!.redacted, true);
    // real names are untouched
    assert.equal(one([text("$b", BOB, "yo")], ghostCtx()).sender.name, "Bob");
  });
});
