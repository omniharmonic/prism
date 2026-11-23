// Signal + Slack (mautrix-signal / mautrix-slack v26.11, both bridgev2), bridged 2026-11-22.
// Synthetic fixtures only: every id, name and text below is invented. The m.bridge SHAPES are
// what bridgev2 `Portal.getBridgeInfo` writes: protocol = the connector's NetworkID, channel =
// the portal itself, network = its top-level parent (the Slack workspace), and
// com.beeper.room_type "dm" (+ room_type.v2 "dm" / "group_dm") on DMs only — channels and Signal
// groups carry neither key (RoomType "" is omitempty).
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "./helpers";
import { bridgeRoomType, roomMetaFromState } from "../src/comms/room-meta";
import { formatHandle, looksLikeId, resolveTitle } from "../src/comms/naming";
import { detectOwners, ghostNetworkOf } from "../src/comms/owner-detect";
import { projectRoom, conversationIdFor, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { getThread } from "../src/comms/store";
import { PeopleIndex } from "../src/worker/people";
import { COMMS_CAPABILITIES } from "../src/comms/index";
import { detectPlatform, ingestMatrix, keepPlatform, planTitle, type IngestVault, type MatrixEvent, type SyncResult } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

const OWNER = "@owner:hs";
const SLACK_BOT = "@slackbot:hs";
const SIGNAL_BOT = "@signalbot:hs";
// mautrix-slack ghosts: slack_<team>-<user>, lowercased (MakeUserID). Two workspaces.
const TEAM_A = "t0aaaa1111", TEAM_B = "t0bbbb2222";
const slackUser = (team: string, u: string) => `@slack_${team}-${u}:hs`;
const OWN_SLACK_A = slackUser(TEAM_A, "u0own00001");
const OWN_SLACK_B = slackUser(TEAM_B, "u0own00002");
// mautrix-signal ghosts: signal_<ACI uuid>.
const sigUser = (i: number) => `@signal_${String(i).padStart(8, "0")}-1c2d-4e3f-8a9b-0c1d2e3f4a5b:hs`;

const slackBridge = (o: { channel: string; channelId?: string; team?: string; teamName?: string; type?: "dm" | "group_dm" }): MatrixEvent => ({
  type: "m.bridge",
  state_key: `fi.mau.slack://slack/${o.channelId ?? "c0chan0001"}`,
  content: {
    bridgebot: SLACK_BOT, creator: SLACK_BOT,
    protocol: { id: "slack", displayname: "Slack", avatar_url: "mxc://maunium.net/slack", external_url: "https://slack.com/" },
    network: { id: o.team ?? TEAM_A, displayname: o.teamName ?? "Acme Corp", avatar_url: "mxc://hs/team" },
    channel: { id: `${o.team ?? TEAM_A}-${o.channelId ?? "c0chan0001"}`, displayname: o.channel, avatar_url: "mxc://hs/team" },
    ...(o.type ? { "com.beeper.room_type": "dm", "com.beeper.room_type.v2": o.type } : {}),
  },
});
const signalBridge = (o: { channel?: string; dm?: boolean }): MatrixEvent => ({
  type: "m.bridge",
  state_key: "fi.mau.signal://signal/x",
  content: {
    bridgebot: SIGNAL_BOT, creator: SIGNAL_BOT,
    protocol: { id: "signal", displayname: "Signal", avatar_url: "mxc://maunium.net/signal", external_url: "https://signal.org/" },
    channel: { id: "x", ...(o.channel ? { displayname: o.channel } : {}) },
    ...(o.dm ? { "com.beeper.room_type": "dm", "com.beeper.room_type.v2": "dm" } : {}),
  },
});
const roomName = (name: string): MatrixEvent => ({ type: "m.room.name", state_key: "", content: { name } });

// ── room meta: network, kind, account ─────────────────────────────────────────────────────

test("room meta: the bridgev2 protocol ids signal and slack are their own networks", () => {
  assert.equal(roomMetaFromState([slackBridge({ channel: "#general" })], [], []).network, "slack");
  assert.equal(roomMetaFromState([signalBridge({ dm: true })], [], []).network, "signal");
  // Ghost-prefix fallback (no m.bridge read yet).
  assert.equal(roomMetaFromState([], [OWNER, slackUser(TEAM_A, "u0alice001")], []).network, "slack");
  assert.equal(roomMetaFromState([], [OWNER, sigUser(1)], []).network, "signal");
});

test("room meta: an untyped Slack channel / Signal group is a group even with two synced members", () => {
  // mautrix-slack syncs only 5 channel participants: the member count says nothing.
  const two = [OWNER, SLACK_BOT, slackUser(TEAM_A, "u0alice001")];
  const ch = roomMetaFromState([slackBridge({ channel: "#eng-on-call" }), roomName("#eng-on-call")], two, [OWNER]);
  assert.equal(ch.kind, "group");
  assert.equal(ch.roomName, "#eng-on-call");
  assert.equal(bridgeRoomType([slackBridge({ channel: "#eng-on-call" })]), "group");
  assert.equal(roomMetaFromState([signalBridge({ channel: "Book club" })], [OWNER, SIGNAL_BOT, sigUser(1)], [OWNER]).kind, "group");
  // Typed DMs: dm; a Slack group DM (mpim) is v2 "group_dm" → group.
  assert.equal(roomMetaFromState([slackBridge({ channel: "Alice", type: "dm" })], two, [OWNER]).kind, "dm");
  assert.equal(roomMetaFromState([slackBridge({ channel: "Alice, Bob", type: "group_dm" })], two, [OWNER]).kind, "group");
  assert.equal(roomMetaFromState([signalBridge({ dm: true })], [OWNER, SIGNAL_BOT, sigUser(1)], [OWNER]).kind, "dm");
  // Older bridges keep the member-count guess (legacy rooms are often untyped).
  const wa = { type: "m.bridge", state_key: "x", content: { protocol: { id: "whatsapp" } } } as MatrixEvent;
  assert.equal(roomMetaFromState([wa], [OWNER, "@whatsapp_15550001:hs"], [OWNER]).kind, "dm");
});

test("room meta: a Slack room's account is its workspace; other networks have none", () => {
  assert.equal(roomMetaFromState([slackBridge({ channel: "#general", teamName: "Acme Corp" })], [], []).accountName, "Acme Corp");
  assert.equal(roomMetaFromState([signalBridge({ dm: true })], [], []).accountName, null);
  const tg = { type: "m.bridge", state_key: "x", content: { protocol: { id: "telegram" }, network: { displayname: "Some Group" } } } as MatrixEvent;
  assert.equal(roomMetaFromState([tg], [], []).accountName, null);
});

test("capabilities: signal and slack are advertised networks", () => {
  assert.ok(COMMS_CAPABILITIES.networks.includes("signal" as never));
  assert.ok(COMMS_CAPABILITIES.networks.includes("slack" as never));
});

// ── naming ────────────────────────────────────────────────────────────────────────────────

test("naming: Slack and Signal ghost ids are never shown raw", () => {
  assert.equal(formatHandle(slackUser(TEAM_A, "u0alice001")), "Slack user");
  assert.equal(formatHandle(sigUser(7)), "Signal user");
  assert.equal(formatHandle("@slack_:hs"), "Slack user");
  assert.ok(looksLikeId(`slack_${TEAM_A}-u0alice001`), "a Slack ghost localpart is an id");
  assert.equal(resolveTitle({ roomName: "Alice Example (Slack)", memberDisplayNames: [], kind: "dm" }).title, "Alice Example");
});

test("naming: a Slack channel's kebab-case name is its real name (elsewhere it is a slug)", () => {
  for (const name of ["eng-on-call", "q3-planning-2", "#eng-on-call"]) {
    const r = resolveTitle({ roomName: name, memberDisplayNames: ["Alice"], kind: "group", network: "slack" });
    assert.deepEqual(r, { title: name, titleSource: "room" }, name);
  }
  assert.equal(resolveTitle({ roomName: "eng-on-call", memberDisplayNames: ["Alice"], kind: "group" }).title, "Alice");
  assert.equal(resolveTitle({ roomName: `slack_${TEAM_A}-c0chan0001`, memberDisplayNames: ["Alice"], kind: "group", network: "slack" }).title, "Alice");
});

// ── vault ingest: path + platform ─────────────────────────────────────────────────────────

function fakeVault(seed: Note[] = []) {
  const creates: Array<{ path?: string; metadata?: Record<string, unknown>; content: string }> = [];
  const updates: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }> = [];
  const notes = new Map(seed.map((n) => [n.id, n]));
  const vault: IngestVault = {
    async listNotes(o) { return [...notes.values()].filter((n) => (o.tags ?? []).every((t) => n.tags?.includes(t))); },
    async createNote(p) {
      creates.push(p);
      const n: Note = { id: `new-${creates.length}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "", updatedAt: "" };
      notes.set(n.id, n);
      return n;
    },
    async updateNote(id, p) {
      updates.push({ id, ...p });
      const prev = notes.get(id)!;
      const n: Note = { ...prev, content: p.content ?? prev.content, metadata: { ...(prev.metadata ?? {}), ...(p.metadata ?? {}) } };
      notes.set(id, n);
      return n;
    },
  };
  return { vault, creates, updates, notes };
}
function sync(roomId: string, o: { name?: string | null; memberIds: string[]; displayNames?: Record<string, string>; sender: string }): SyncResult {
  return {
    nextBatch: "s2", invites: [],
    rooms: [{ roomId, name: o.name ?? null, memberIds: o.memberIds, displayNames: o.displayNames ?? {},
      messages: [{ sender: o.sender, body: "hi", ts: Date.UTC(2026, 10, 22, 9, 0), eventId: "$1" }] }],
  };
}
const client = (s: SyncResult, room: { state: MatrixEvent[]; members: Record<string, string> }) => ({
  sync: async () => s, roomState: async () => room.state, joinedMembers: async () => room.members, whoami: async () => OWNER,
});

test("ingest: detectPlatform knows Slack ghosts", () => {
  assert.equal(detectPlatform([OWNER, slackUser(TEAM_A, "u0alice001")]), "slack");
  assert.equal(detectPlatform([OWNER, sigUser(1)]), "signal");
});

test("ingest: a new Slack channel lands under vault/messages/slack, titled by its channel name", async () => {
  const fv = fakeVault();
  const alice = slackUser(TEAM_A, "u0alice001");
  const s = sync("!slackch:hs", { name: "#eng-on-call", memberIds: [OWNER, SLACK_BOT, alice], displayNames: { [alice]: "Alice Example" }, sender: alice });
  await ingestMatrix(client(s, { state: [slackBridge({ channel: "#eng-on-call" }), roomName("#eng-on-call")], members: { [OWNER]: "", [SLACK_BOT]: "", [alice]: "Alice Example" } }), fv.vault, { selfUserId: OWNER });
  const c = fv.creates[0]!;
  assert.equal(c.path, "vault/messages/slack/eng-on-call");
  assert.equal(c.metadata?.platform, "slack");
  assert.equal(c.metadata?.title, "#eng-on-call");
  assert.match(c.content, /^# #eng-on-call — slack\n/);
});

test("ingest: a private Slack channel keeps its kebab-case name (not its members')", async () => {
  const fv = fakeVault();
  const alice = slackUser(TEAM_A, "u0alice001");
  const s = sync("!slackpriv:hs", { name: "incident-review-2", memberIds: [OWNER, SLACK_BOT, alice], displayNames: { [alice]: "Alice Example" }, sender: alice });
  await ingestMatrix(client(s, { state: [slackBridge({ channel: "incident-review-2" }), roomName("incident-review-2")], members: { [OWNER]: "", [SLACK_BOT]: "", [alice]: "Alice Example" } }), fv.vault, { selfUserId: OWNER });
  assert.equal(fv.creates[0]!.metadata?.title, "incident-review-2");
  assert.equal(fv.creates[0]!.path, "vault/messages/slack/incident-review-2");
  // A stored kebab title on a Slack note is kept with no Matrix read.
  const slackNote = { id: "n", path: "p", content: "# incident-review-2 — slack", tags: [], metadata: { platform: "slack", title: "incident-review-2" }, createdAt: "", updatedAt: "" } as Note;
  assert.deepEqual(planTitle(slackNote, { name: null }, Date.now()), { kind: "keep" });
});

test("ingest: a Slack DM and a Signal DM go under their own platform folders", async () => {
  const bob = slackUser(TEAM_B, "u0bob00001");
  const fv = fakeVault();
  await ingestMatrix(client(sync("!slackdm:hs", { memberIds: [OWNER, SLACK_BOT, bob], sender: bob }),
    { state: [slackBridge({ channel: "Bob Builder", team: TEAM_B, teamName: "Side Project", type: "dm" })], members: { [OWNER]: "", [SLACK_BOT]: "", [bob]: "Bob Builder" } }), fv.vault, { selfUserId: OWNER });
  assert.equal(fv.creates[0]!.path, "vault/messages/slack/bob-builder");
  assert.equal(fv.creates[0]!.metadata?.platform, "slack");

  const carol = sigUser(3);
  const fv2 = fakeVault();
  await ingestMatrix(client(sync("!sigdm:hs", { memberIds: [OWNER, SIGNAL_BOT, carol], sender: carol }),
    { state: [signalBridge({ dm: true })], members: { [OWNER]: "", [SIGNAL_BOT]: "", [carol]: "Carol Example" } }), fv2.vault, { selfUserId: OWNER });
  assert.equal(fv2.creates[0]!.path, "vault/messages/signal/carol-example");
  assert.equal(fv2.creates[0]!.metadata?.platform, "signal");
});

test("ingest: the m.bridge protocol names Slack even when the batch holds no ghost", async () => {
  // A channel's first batch: only the owner's own message, members = owner + bot (deltas).
  const fv = fakeVault();
  const alice = slackUser(TEAM_A, "u0alice001");
  await ingestMatrix(client(sync("!slackquiet:hs", { name: "#random", memberIds: [OWNER, SLACK_BOT], sender: OWNER }),
    { state: [slackBridge({ channel: "#random" }), roomName("#random")], members: { [OWNER]: "", [SLACK_BOT]: "", [alice]: "Alice" } }), fv.vault, { selfUserId: OWNER });
  assert.equal(fv.creates[0]!.path, "vault/messages/slack/random");
  assert.equal(fv.creates[0]!.metadata?.platform, "slack");
});

test("ingest: a Slack/Signal thread's platform is never downgraded by a delta batch", async () => {
  assert.equal(keepPlatform("slack", "matrix"), "slack");
  assert.equal(keepPlatform("signal", "matrix"), "signal");
  const existing: Note = {
    id: "s1", path: "vault/messages/slack/random", content: "# #random — slack\n\n[2026-11-22 08:00] x: old",
    metadata: { type: "message-thread", platform: "slack", title: "#random", matrixRoomId: "!slackquiet:hs", messageCount: 1 },
    tags: ["message-thread"], createdAt: "", updatedAt: "u1",
  };
  const fv = fakeVault([existing]);
  await ingestMatrix(client(sync("!slackquiet:hs", { memberIds: [OWNER, SLACK_BOT], sender: OWNER }), { state: [], members: {} }), fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.platform, "slack");
  assert.equal(fv.notes.get("s1")!.path, "vault/messages/slack/random");
});

// ── owner detection ───────────────────────────────────────────────────────────────────────

test("owner detect: Slack is judged per workspace (one owner ghost in each)", () => {
  assert.equal(ghostNetworkOf(OWN_SLACK_A), `slack:${TEAM_A}`);
  assert.equal(ghostNetworkOf(sigUser(1)), "signal");
  const rooms: string[][] = [];
  // Workspace A: 12 DMs; workspace B: 10 DMs. Each holds the owner's ghost for THAT workspace.
  for (let i = 0; i < 12; i++) rooms.push([OWNER, SLACK_BOT, OWN_SLACK_A, slackUser(TEAM_A, `u0a${String(i).padStart(7, "0")}`)]);
  for (let i = 0; i < 10; i++) rooms.push([OWNER, SLACK_BOT, OWN_SLACK_B, slackUser(TEAM_B, `u0b${String(i).padStart(7, "0")}`)]);
  const d = detectOwners(rooms, [OWNER]);
  assert.deepEqual(d.owners.sort(), [OWN_SLACK_A, OWN_SLACK_B].sort());
  assert.deepEqual(d.judged.sort(), [`slack:${TEAM_A}`, `slack:${TEAM_B}`].sort());
});

test("owner detect: the owner's Signal ghost is found like any other network's", () => {
  const OWN = sigUser(99999999);
  const rooms = Array.from({ length: 11 }, (_, i) => [OWNER, SIGNAL_BOT, OWN, sigUser(i + 1)]);
  assert.deepEqual(detectOwners(rooms, [OWNER]).owners, [OWN]);
});

// ── comms projection ──────────────────────────────────────────────────────────────────────

const prevComms = process.env.COMMS_ENABLED;
beforeEach(() => { resetDb(); process.env.COMMS_ENABLED = "true"; });
afterEach(() => { if (prevComms === undefined) delete process.env.COMMS_ENABLED; else process.env.COMMS_ENABLED = prevComms; });

test("projection: a Slack channel projects as network slack, a group, with its workspace as the account", async () => {
  const roomId = "!slackch:hs";
  const alice = slackUser(TEAM_A, "u0alice001"), bob = slackUser(TEAM_A, "u0bob00001");
  const n: Note = {
    id: "n1", content: "", path: "vault/messages/slack/eng-on-call", createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z", tags: ["message-thread"],
    metadata: { type: "message-thread", platform: "slack", matrixRoomId: roomId, lastMessageAt: Date.UTC(2026, 10, 22), lastMessageText: "deploy done", lastMessageSender: alice, lastMessageIsSelf: false },
  };
  const deps: ProjectDeps = {
    vault: { listByTag: async () => [n] },
    reader: {
      whoami: async () => OWNER,
      roomState: async () => [slackBridge({ channel: "eng-on-call" }), roomName("eng-on-call")] as never,
      memberProfiles: async () => ({ [OWNER]: { name: "Owner", avatar: null }, [SLACK_BOT]: { name: "Slack bridge bot", avatar: null }, [alice]: { name: "Alice Example", avatar: null }, [bob]: { name: "Bob Builder", avatar: null } }),
    },
    people: peopleAdapter(new PeopleIndex([])),
  };
  await projectRoom(deps, roomId, n);
  const t = getThread(`th_${conversationIdFor(roomId)}`)!;
  assert.ok(t, "projected");
  assert.equal(t.kind, "group");
  assert.deepEqual(t.networks, ["slack"]);
  assert.equal(t.title, "eng-on-call");
  assert.equal(t.channels[0]!.accountLabel, "Acme Corp");
});
