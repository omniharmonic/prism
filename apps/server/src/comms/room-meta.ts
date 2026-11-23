import { detectPlatform, isBridgeBot, type MatrixEvent } from "../worker/matrix.js";

export type Network =
  | "whatsapp" | "telegram" | "discord" | "messenger" | "x" | "imessage" | "sms" | "email" | "matrix"
  | "signal" | "slack" | "instagram" | "linkedin";

export interface Capabilities {
  react: boolean;
  edit: boolean;
  unsend: boolean;
  reply: boolean;
  typing: boolean;
  receipts: boolean;
  attachments: boolean;
  /** Comms can send here now (wire only: set per request by comms/send.ts withSendFlag, never
   *  stored — it depends on the server's flags). Missing = false. */
  send?: boolean;
  /** The room is end-to-end encrypted (m.room.encryption state). Present only when true. Comms
   *  never sends plaintext into it (send:false, the route answers 409 encrypted_room). */
  encrypted?: boolean;
  /** `@Name` mentions can be sent here (wire only, withSendFlag: a sendable bridged network whose
   *  bridge turns a Matrix mention pill into a native mention). Present only when true. */
  mentions?: boolean;
}

export interface RoomMeta {
  network: Network;
  kind: "dm" | "group";
  roomName: string | null;
  roomAvatar: string | null;
  channelName: string | null;
  channelAvatar: string | null;
  /** Which of the owner's accounts the room belongs to, when a network has several: the Slack
   *  workspace (m.bridge `network.displayname`, the portal's top-level parent). null otherwise. */
  accountName: string | null;
  capabilities: Capabilities;
  memberIds: string[];
  /** A Telegram forum TOPIC room (owner-testing round 4, item 5 groundwork): the forum it belongs
   *  to. See `forumOf`. Null for every other room. */
  forum: ForumRef | null;
}

/** The forum a topic room belongs to: `key` is stable per forum (network + forum chat id). */
export interface ForumRef { key: string; name: string | null; avatar: string | null; topicId: string }

/**
 * mautrix-telegram (bridgev2) bridges each forum TOPIC as its own portal room. Its `m.bridge`
 * state names the topic portal in `channel.id` = `channel:<channelID>:<topicID>`
 * (pkg/connector/ids/ids.go MakeTopicPortalID; the forum's own space room is topic `-1`,
 * MakeForumParentPortalID) and — because the topic portal has the forum as its parent —
 * bridgev2 getBridgeInfo adds `network` = the top-level parent: {id: "channel:<channelID>:-1",
 * displayname: <forum name>, avatar_url}. Verified against mautrix/telegram and mautrix/go
 * main, 2026-11-22. A plain channel/supergroup (`channel:<id>`) or the forum space itself is
 * not a topic.
 */
export function forumOf(protoId: string | null | undefined, bridge: Record<string, unknown> | undefined): ForumRef | null {
  if (protoId !== "telegram" || !bridge) return null;
  const channelId = str(asRec(bridge.channel)?.id);
  const m = channelId ? /^channel:(-?\d{1,20}):(\d{1,20})$/.exec(channelId) : null;
  if (!m || m[2] === "0") return null;
  const parent = asRec(bridge.network);
  return { key: `telegram:channel:${m[1]}`, name: str(parent?.displayname), avatar: str(parent?.avatar_url), topicId: m[2]! };
}

const NETWORKS = new Map<string, Network>(Object.entries({
  whatsapp: "whatsapp", telegram: "telegram", discord: "discord",
  facebook: "messenger", messenger: "messenger", meta: "messenger",
  twitter: "x", x: "x", imessage: "imessage", gmessages: "sms", sms: "sms", email: "email",
  // mautrix-signal / mautrix-slack bridgev2 NetworkIDs (pkg/connector GetName().NetworkID).
  signal: "signal", slack: "slack",
  // mautrix-meta (ig build) and mautrix-linkedin, both bridgev2: Instagram is its own network, no longer Messenger.
  instagram: "instagram", linkedin: "linkedin",
} satisfies Record<string, Network>));

const asRec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const find = (state: MatrixEvent[], type: string) => state.find((e) => asRec(e) && e.type === type)?.content;

/** mautrix CapabilitySupportLevel (event/capabilities.go:212-227): ints, > 0 = partial/full support; booleans also accepted. */
const level = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : typeof v === "number" ? v > 0 : undefined;

/** Bridges built on mautrix bridgev2 that always type their DMs: bridgev2 getBridgeInfo sets
 *  `com.beeper.room_type: "dm"` (v2 "dm" / "group_dm") on every DM portal and leaves both keys
 *  out for a channel or group (RoomType "", omitempty). On these an untyped m.bridge is a group —
 *  never guessed from the member count (a Slack channel syncs only 5 participants). */
const TYPED_BRIDGES = new Set(["signal", "slack", "instagram", "linkedin"]);

/** mautrix BridgeEventContent (event/state.go:260-269): room type lives inside m.bridge content. */
function roomType(bridges: Record<string, unknown>[], state: MatrixEvent[], protoId?: string | null): "dm" | "group" | null {
  const raw =
    bridges.map((b) => str(b["com.beeper.room_type.v2"]) ?? str(b["com.beeper.room_type"])).find(Boolean) ??
    str(asRec(find(state, "com.beeper.room_type"))?.type) ?? // standalone-event fallback
    null;
  if (raw === null) return protoId && TYPED_BRIDGES.has(protoId) ? "group" : null;
  return raw === "dm" ? "dm" : "group";
}

/** True when any file mime type is supported (RoomFeatures.File → FileFeatures.MimeTypes, capabilities.go:271). */
function filesSupported(file: unknown): boolean | undefined {
  const f = asRec(file);
  if (!f) return undefined;
  return Object.values(f).some((e) => Object.values(asRec(asRec(e)?.mime_types) ?? {}).some((l) => level(l)));
}

/** The room's bridge state contents (m.bridge first, then the legacy uk.half-shot.bridge). */
function bridgesOf(state: MatrixEvent[]): Record<string, unknown>[] {
  return state
    .filter((e) => asRec(e) && (e.type === "m.bridge" || e.type === "uk.half-shot.bridge"))
    .sort((a, b) => Number(b.type === "m.bridge") - Number(a.type === "m.bridge"))
    .map((e) => asRec(e.content))
    .filter((c): c is Record<string, unknown> => !!c);
}

/** The bridge's room type for this room ("dm" / "group"), or null when it names none. */
export function bridgeRoomType(state: MatrixEvent[]): "dm" | "group" | null {
  const st = state.filter((e) => asRec(e));
  return roomType(bridgesOf(st), st, bridgeProtocolId(st));
}

/** The state events the projection reads (room-meta + naming): everything but m.room.member,
 *  which is the bulk of a big room's state and comes from joined_members instead. */
export function projectionState(state: MatrixEvent[]): MatrixEvent[] {
  return state.filter((e) => asRec(e) && e.type !== "m.room.member");
}

/** The bridge's protocol id (m.bridge `protocol.id`, lowercased), or null for a plain Matrix room. */
export function bridgeProtocolId(state: MatrixEvent[]): string | null {
  for (const b of bridgesOf(state)) {
    const id = str(asRec(b.protocol)?.id);
    if (id) return id.toLowerCase();
  }
  return null;
}

/** `@whatsapp_<digits>` (phone form) / `@whatsapp_lid-<digits>` (LID form) — mautrix-whatsapp ghosts. */
const WA_GHOST = /^@whatsapp_(lid-)?\d+:/i;

/**
 * How many distinct people `people` (non-self, non-bot member ids) are. WhatsApp moved contacts to
 * LIDs, so one person can sit in a portal twice: their phone ghost and their LID ghost. Such a pair
 * counts once ONLY when the room proves it is one person: one phone-form and one LID-form ghost with
 * the same non-empty display name. Anything else is as many people as ids (S1, 2026-11-22: untyped
 * WhatsApp rooms with the owner + 2 others were projected as DMs titled after one member).
 * `roomName` (m.room.name, review M7): a WhatsApp group always has a subject, so in a NAMED room a pair
 * collapses only when the room is named after that very person (a legacy DM portal with
 * private_chat_portal_meta) — two different "John"s in a named group stay two people.
 */
export function distinctPeople(people: string[], names: Record<string, string | null | undefined> = {}, roomName: string | null = null): number {
  const room = roomName?.trim().toLowerCase() || null;
  const byName = new Map<string, { phone: number; lid: number }>();
  for (const id of people) {
    const m = WA_GHOST.exec(id);
    const name = names[id]?.trim().toLowerCase();
    if (!m || !name) continue;
    const e = byName.get(name) ?? { phone: 0, lid: 0 };
    if (m[1]) e.lid++;
    else e.phone++;
    byName.set(name, e);
  }
  let pairs = 0;
  for (const [name, e] of byName) if (!room || room === name) pairs += Math.min(e.phone, e.lid);
  return people.length - pairs;
}

/** Networks where an untyped room is a DM only with ONE distinct other person (S1). WhatsApp only,
 *  by ruling (2026-11-22): the bug was seen there and the owner's WhatsApp ghosts (phone + LID) are
 *  detected on production. Elsewhere an owner ghost missing from the self set would turn every
 *  untyped DM into a group, so the old tolerance (≤ 2 others) stays until a dry run
 *  (scripts/comms-kind-dryrun.ts) shows what would flip. */
export const STRICT_DM_NETWORKS: ReadonlySet<Network> = new Set<Network>(["whatsapp"]);

/** The kind of a room the bridge did not type. */
export function untypedKind(
  network: Network, people: string[], memberNames: Record<string, string | null | undefined> = {}, roomName: string | null = null,
  strict = STRICT_DM_NETWORKS.has(network),
): "dm" | "group" {
  if (strict) return distinctPeople(people, memberNames, roomName) <= 1 ? "dm" : "group";
  return people.length <= 2 ? "dm" : "group";
}

/**
 * `memberNames` (member id → display name, optional) lets a phone + LID ghost pair of one WhatsApp
 * contact count as one person (distinctPeople). Kind: the bridge's explicit room type first; an
 * untyped room: untypedKind (strict on STRICT_DM_NETWORKS, the old ≤ 2 others elsewhere).
 */
export function roomMetaFromState(state: MatrixEvent[], memberIds: string[], selfIds: string[], memberNames: Record<string, string | null | undefined> = {}): RoomMeta {
  state = state.filter((e) => asRec(e));
  const bridges = bridgesOf(state);
  const br = bridges.find((b) => str(asRec(b.protocol)?.id)) ?? bridges[0];
  const channel = asRec(br?.channel);
  const protoId = bridgeProtocolId(state) ?? undefined;
  let network: Network =
    (protoId && NETWORKS.get(protoId)) || NETWORKS.get(detectPlatform(memberIds)) || "matrix";
  // A Meta-family protocol id (facebook / messenger / meta) over Instagram ghosts is Instagram.
  if (network === "messenger" && memberIds.some((m) => /^@instagram_/i.test(m))) network = "instagram";

  const self = new Set(selfIds.map((i) => i.toLowerCase()));
  const people = memberIds.filter((m) => !self.has(m.toLowerCase()) && !isBridgeBot(m));
  const type = roomType(bridges, state, protoId);
  const roomName = str(asRec(find(state, "m.room.name"))?.name);
  // A Telegram forum topic is always a group (Comms shows its forum as one group thread).
  const forum = forumOf(protoId, br);
  const kind: "dm" | "group" = forum ? "group" : type ?? untypedKind(network, people, memberNames, roomName);

  // Real mautrix room_features (capabilities.go:50-75): omitted field = unsupported, so once the event exists absent keys are false.
  const featRaw = asRec(find(state, "com.beeper.room_features"));
  const feat = featRaw ?? {};
  const flag = (k: string, d: boolean) => (featRaw ? (level(feat[k]) ?? false) : d);
  const capabilities: Capabilities = {
    react: flag("reaction", true),
    edit: featRaw ? (level(feat.edit) ?? false) : network !== "x",
    unsend: flag("delete", true),
    reply: flag("reply", true),
    typing: flag("typing_notifications", true),
    receipts: flag("read_receipts", true),
    attachments: featRaw ? (filesSupported(feat.file) ?? false) : true,
  };
  const enc = asRec(find(state, "m.room.encryption"));
  if (enc && str(enc.algorithm)) capabilities.encrypted = true;

  return {
    network, kind,
    roomName,
    roomAvatar: str(asRec(find(state, "m.room.avatar"))?.url),
    channelName: str(channel?.displayname),
    channelAvatar: str(channel?.avatar_url),
    accountName: network === "slack" ? str(asRec(br?.network)?.displayname) : null,
    capabilities, memberIds,
    forum,
  };
}
