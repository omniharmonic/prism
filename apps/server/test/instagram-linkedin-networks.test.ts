// Instagram (mautrix-meta ig build) + LinkedIn (mautrix-linkedin v26.11), both bridgev2.
// Synthetic fixtures only. Instagram was folded into Messenger before; it is its own network now.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { bridgeRoomType, roomMetaFromState } from "../src/comms/room-meta";
import { formatHandle, looksLikeId, resolveTitle } from "../src/comms/naming";
import { ghostNetworkOf } from "../src/comms/owner-detect";
import { rebuildProjection, conversationIdFor, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { getThread, upsertConversation, ensureSingleThread, listThreads } from "../src/comms/store";
import { PeopleIndex } from "../src/worker/people";
import { COMMS_CAPABILITIES } from "../src/comms/index";
import { ghostContact } from "../src/comms/people";
import { detectPlatform } from "../src/worker/matrix";
import type { MatrixEvent } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

const OWNER = "@owner:hs";
const IG_BOT = "@instagrambot:hs";
const LI_BOT = "@linkedinbot:hs";
const ig = (id: string) => `@instagram_${id}:hs`;
const li = (id: string) => `@linkedin_${id}:hs`;

const bridge = (proto: string, bot: string, o: { dm?: boolean; channel?: string } = {}): MatrixEvent => ({
  type: "m.bridge", state_key: `fi.mau.${proto}://${proto}/x`,
  content: {
    bridgebot: bot, creator: bot, protocol: { id: proto, displayname: proto },
    channel: { id: "x", ...(o.channel ? { displayname: o.channel } : {}) },
    ...(o.dm ? { "com.beeper.room_type": "dm", "com.beeper.room_type.v2": "dm" } : {}),
  },
});

test("room meta: instagram and linkedin protocol ids are their own networks; Messenger stays Messenger", () => {
  assert.equal(roomMetaFromState([bridge("instagram", IG_BOT, { dm: true })], [OWNER, IG_BOT, ig("17841400000")], [OWNER]).network, "instagram");
  assert.equal(roomMetaFromState([bridge("linkedin", LI_BOT, { dm: true })], [OWNER, LI_BOT, li("acoaabc123")], [OWNER]).network, "linkedin");
  for (const p of ["facebook", "messenger", "meta"]) assert.equal(roomMetaFromState([bridge(p, "@metabot:hs")], [OWNER, "@messenger_1000000001:hs"], [OWNER]).network, "messenger");
  // no m.bridge: the ghost prefix decides
  assert.equal(roomMetaFromState([], [OWNER, ig("17841400000")], [OWNER]).network, "instagram");
  assert.equal(roomMetaFromState([], [OWNER, li("acoaabc123")], [OWNER]).network, "linkedin");
  // a Meta-family protocol id over Instagram ghosts is still Instagram
  assert.equal(roomMetaFromState([bridge("meta", "@metabot:hs")], [OWNER, ig("17841400000")], [OWNER]).network, "instagram");
});

test("room meta: bridgev2 types DMs; an untyped Instagram/LinkedIn m.bridge is a group, not a member-count guess", () => {
  for (const [p, bot, other] of [["instagram", IG_BOT, ig("1784140000")], ["linkedin", LI_BOT, li("acoaabc123")]] as const) {
    const two = [OWNER, bot, other];
    assert.equal(bridgeRoomType([bridge(p, bot)]), "group");
    assert.equal(roomMetaFromState([bridge(p, bot)], two, [OWNER]).kind, "group");
    assert.equal(roomMetaFromState([bridge(p, bot, { dm: true })], two, [OWNER]).kind, "dm");
  }
});

test("capabilities, route filter, platform detection, owner-detect network names", async () => {
  for (const n of ["instagram", "linkedin"]) assert.ok(COMMS_CAPABILITIES.networks.includes(n as never));
  assert.equal(detectPlatform([OWNER, ig("1784140000")]), "instagram");
  assert.equal(detectPlatform([OWNER, li("acoaabc123")]), "linkedin");
  assert.equal(ghostNetworkOf(ig("1784140000")), "instagram");
  assert.equal(ghostNetworkOf(li("acoaabc123")), "linkedin");
  process.env.COMMS_ENABLED = "true";
  const get = (q: string) => createApp().request(`/api/comms/threads?${q}`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  assert.equal((await get("network=instagram&network=linkedin")).status, 200);
  assert.equal((await get("network=myspace")).status, 400);
});

test("naming: Instagram/LinkedIn ghosts are never phones or raw ids", () => {
  assert.equal(formatHandle(ig("17841400000")), "@17841400000"); // a platform user id, not a phone
  assert.equal(formatHandle(li("acoaabcdef123")), "LinkedIn user");
  assert.ok(looksLikeId("linkedin_acoaab1234"));
  assert.ok(looksLikeId("instagram_17841400000"));
  assert.equal(resolveTitle({ roomName: null, memberDisplayNames: ["Dana (Instagram)"], kind: "dm" }).title, "Dana");
  assert.equal(resolveTitle({ roomName: null, memberDisplayNames: ["Lee Example (LinkedIn)"], kind: "dm" }).title, "Lee Example");
  assert.deepEqual(ghostContact(ig("17841400000")).handle, { network: "instagram", value: "17841400000", kind: "userId" });
  assert.equal(ghostContact(ig("17841400000")).phone, undefined);
});

// ── rebuild: an Instagram thread projected as messenger flips ───────────────────────────────

beforeEach(() => { resetDb(); process.env.COMMS_ENABLED = "true"; });
afterEach(() => { delete process.env.COMMS_ENABLED; });

test("rebuild flips an Instagram conversation projected as messenger to instagram (list filter follows)", async () => {
  const roomId = "!igdm:hs";
  const dana = ig("17841400000");
  const id = conversationIdFor(roomId);
  upsertConversation({
    id, network: "messenger", sourceRef: roomId, kind: "dm", title: "Dana", titleSource: "contact", avatar: null,
    lastEventAt: "2026-11-20T00:00:00.000Z", lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox",
    pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: "n1",
  });
  ensureSingleThread(id);
  assert.equal(listThreads({ limit: 10, networks: ["messenger"] }).threads.length, 1);
  const n: Note = {
    id: "n1", content: "", path: "vault/messages/instagram/dana", createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z", tags: ["message-thread"],
    metadata: { type: "message-thread", platform: "instagram", matrixRoomId: roomId, lastMessageAt: Date.UTC(2026, 10, 22), lastMessageText: "hey", lastMessageSender: dana, lastMessageIsSelf: false },
  };
  const deps: ProjectDeps = {
    vault: { listByTag: async () => [n] },
    reader: {
      whoami: async () => OWNER,
      roomState: async () => [bridge("instagram", IG_BOT, { dm: true })] as never,
      memberProfiles: async () => ({ [OWNER]: { name: "Owner", avatar: null }, [IG_BOT]: { name: "Instagram bridge bot", avatar: null }, [dana]: { name: "Dana Example", avatar: null } }),
    },
    people: peopleAdapter(new PeopleIndex([])),
  };
  await rebuildProjection(deps);
  assert.deepEqual(getThread(`th_${id}`)!.networks, ["instagram"]);
  assert.equal(getThread(`th_${id}`)!.channels[0]!.network, "instagram");
  assert.equal(listThreads({ limit: 10, networks: ["messenger"] }).threads.length, 0);
  assert.equal(listThreads({ limit: 10, networks: ["instagram"] }).threads.length, 1);
});

test("vault hygiene: schema-fixes thread-platform holds instagram + linkedin and still upgrades every earlier enum", () => {
  const fixes = JSON.parse(readFileSync(new URL("../../../scripts/vault-hygiene/schema-fixes.json", import.meta.url), "utf8"));
  const f = (fixes.changes ?? fixes).find((c: any) => c.id === "thread-platform");
  assert.ok(f.to.enum.includes("instagram") && f.to.enum.includes("linkedin") && f.to.enum.includes("slack"));
  const earlier = f.alsoFrom.map((a: any) => a.enum.length);
  // The shipped enums (before slack, with slack, with linkedin — before imessage/sms) stay upgradable.
  assert.deepEqual(earlier, [9, 10, 11]);
  assert.ok(f.alsoFrom.slice(0, 2).every((a: any) => !a.enum.includes("linkedin")));
  assert.ok(f.to.enum.includes("imessage") && f.to.enum.includes("sms"));
  assert.ok(f.alsoFrom.every((a: any) => !a.enum.includes("imessage")));
});
