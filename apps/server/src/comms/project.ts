// Comms projection builder: vault `message-thread` notes + live Matrix room metadata become
// comms_conversations rows and display threads (Phase 1: one thread per conversation).
import { createHash } from "node:crypto";
import type { Note } from "../parachute";
import type { MatrixClient, MatrixEvent } from "../worker/matrix.js";
import { agentSenderIds, isBridgeBot } from "../worker/matrix.js";
import { isAgentPuppet, isManagementRoom } from "./bridge-like.js";
import { db } from "../db";
import { bridgeRoomType, projectionState, roomMetaFromState } from "./room-meta.js";
import { previewText, resolveAvatar, resolveTitle } from "./naming.js";
import { normalizeEvents } from "./normalize.js";
import { detectOwners, ghostNetworkOf, reconcileOwners, type RoomMembers } from "./owner-detect.js";
import { config } from "../config";
import { ownerBlockedNetworks, ownerDetectionMode, redactMxid, setOwnerBlockedNetworks, storeOwnerSenders, storedOwnerSenderRows, storedOwnerSenders, type OwnerSender } from "./owner.js";
import { appendEvent, ensureSingleThread, removeConversation, replaceConversationMembers, setThreadPerson, upsertConversation, type Folder } from "./store.js";
import { commsStatus } from "./triage.js";
import { attachTopic, detachTopic, mergeForumThreads } from "./forums.js";
import type { MessagePreview } from "./types.js";
import { clipText } from "./wire.js";

export interface ProjectDeps {
  vault: { listByTag(tag: string): Promise<Note[]> };
  reader: Pick<MatrixClient, "roomState" | "memberProfiles" | "whoami">
    & Partial<Pick<MatrixClient, "timelinePage" | "joinedRooms">>;
  people: { byMatrixId(mxid: string): { id: string; name: string; photo?: string } | null };
  /** Extra self ids (the agent's own senders). The account's mxid always comes from reader.whoami(). */
  extraSelfIds?: readonly string[];
  /** The owner's Matrix ids his person note / owner config claims (ownerProfile().matrixIds) — the
   *  set the vault ingest calls ownerSenderIds. His bridge ghosts are detected by the rebuild. */
  ownerIds?: readonly string[];
  /** True for a member the people index resolves to the OWNER's own person note. */
  isOwner?: (mxid: string) => boolean;
  /** The owner's own names (person note, configured aliases): a veto for ghost detection only. */
  ownerNames?: readonly string[];
}

/** Events read from the source when a note lacks preview evidence or the folder needs it. */
export const RECENT_EVENTS = 50;

export const ROOM_TIMEOUT_MS = 10_000;
const MAX_PREVIEW_CHARS = 1000;
/** Members recorded per conversation (people mapping): a bigger room keeps its first members. */
const MAX_MEMBER_ROWS = 500;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** R14: lowercase RFC 4648 base32 (no padding) of sha256("matrix:"+roomId), first 20 chars. */
export function conversationIdFor(roomId: string): string {
  return conversationIdForKey(`matrix:${roomId}`);
}

/** The same encoding over any source key (`bluebubbles:<chat guid>`, …): one id scheme for every source. */
export function conversationIdForKey(key: string): string {
  const bytes = createHash("sha256").update(key).digest();
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out.slice(0, 20);
}

const md = (n: Note): Record<string, unknown> => (n.metadata ?? {}) as Record<string, unknown>;
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const firstName = (n: string | null | undefined): string => n?.trim().split(/\s+/)[0] ?? "";

/** The edited text recorded for this conversation's edit event `eventId` (live listener), if any. */
function editedPreview(conversationId: string, eventId: unknown): string | null {
  if (typeof eventId !== "string" || !eventId) return null;
  const row = db.prepare(`SELECT text FROM comms_edit_previews WHERE conversation_id = ? AND event_id = ?`).get(conversationId, eventId) as { text: string } | undefined;
  return row?.text ?? null;
}

/** Record the edited text (m.new_content, normalized) of an edit event in `roomId` (e2e B2). */
export function recordEditPreview(roomId: string, eventId: string, text: string): void {
  db.prepare(`INSERT INTO comms_edit_previews (conversation_id, event_id, text) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET event_id = excluded.event_id, text = excluded.text`).run(conversationIdFor(roomId), eventId, clipText(text, MAX_PREVIEW_CHARS));
}

async function selfIdsOf(deps: ProjectDeps, owners: readonly string[] = storedOwnerSenders()): Promise<string[]> {
  // No catch: without the account's mxid every room would be projected wrong, so fail loudly.
  const me = await deps.reader.whoami();
  return [...new Set([me, ...(deps.extraSelfIds ?? []), ...(deps.ownerIds ?? []), ...owners].map((i) => i.trim().toLowerCase()).filter(Boolean))];
}

type Profiles = Awaited<ReturnType<ProjectDeps["reader"]["memberProfiles"]>>;
interface ProjectOpts {
  /** Members already read (the rebuild's first pass). */
  profiles?: Profiles;
  /** Room state already read (without m.room.member events). */
  state?: MatrixEvent[];
  /** Events the caller already holds (a live batch), any order. */
  recent?: MatrixEvent[];
  /** May read the room's recent events from the source when evidence is missing (bounded: one page). */
  probe?: boolean;
  /** A rebuild pass: status-only changes (the first rebuild after the status column was added) are
   *  announced up to STATUS_EVENT_BUDGET, the rest folded into one summary event by the rebuild. */
  burst?: { announced: number; folded: number };
}

/** thread.updated events a rebuild appends for threads whose ONLY change is the triage status. */
export const STATUS_EVENT_BUDGET = 100;

/** The latest real message of `events` (a system line only when there is nothing else), normalized. */
function latestOf(events: MatrixEvent[], roomId: string, network: string, selfIds: string[], profiles: Profiles) {
  const names: Record<string, string> = {};
  const avatars: Record<string, string | null> = {};
  for (const [id, p] of Object.entries(profiles)) {
    if (p?.name) names[id] = p.name;
    avatars[id] = p?.avatar ?? null;
  }
  const agents = agentSenderIds();
  const r = normalizeEvents(events, { threadId: `th_${conversationIdFor(roomId)}`, network: network as never, selfIds, agentIds: agents, ownerIds: selfIds.filter((s) => !isAgentPuppet(s)), names, avatars });
  const real = r.messages.filter((m) => !m.system);
  return { latest: real[real.length - 1] ?? r.messages[r.messages.length - 1] ?? null, selfSpoke: real.some((m) => m.sender.isSelf) };
}

/** The owner epoch: a short hash of the sorted self-id set a projection was computed with. */
export function ownerEpochOf(selfIds: readonly string[]): string {
  return createHash("sha256").update([...new Set(selfIds.map((i) => i.toLowerCase()))].sort().join("\n")).digest("hex").slice(0, 16);
}

async function projectOne(deps: ProjectDeps, roomId: string, note: Note, selfIds: string[], opts: ProjectOpts = {}): Promise<string> {
  const m = md(note);
  const epoch = ownerEpochOf(selfIds);
  const [state, profiles] = await Promise.all([opts.state ?? deps.reader.roomState(roomId), opts.profiles ?? deps.reader.memberProfiles(roomId)]);
  const memberIds = Object.keys(profiles);
  // A member the people index knows as the owner (his own person note claims it) is self too.
  const ownerMembers = deps.isOwner ? memberIds.filter((id) => deps.isOwner!(id)) : [];
  if (ownerMembers.length) selfIds = [...new Set([...selfIds, ...ownerMembers.map((i) => i.toLowerCase())])];
  const meta = roomMetaFromState(state, memberIds, selfIds, Object.fromEntries(memberIds.map((id) => [id, profiles[id]?.name ?? null])));
  // Omni's bridge puppets (the Omni Telegram bot) are the other side of a chat, never the owner.
  const self = new Set(selfIds.filter((s) => !isAgentPuppet(s)).map((s) => s.toLowerCase()));
  const isSelfId = (id: string | null | undefined) => !!id && self.has(id.toLowerCase());
  const others = memberIds.filter((id) => !isSelfId(id) && !isBridgeBot(id));
  // A bridge management / status room is not a conversation: never listed, and a row an earlier
  // build made for it is dropped ("" = not projected).
  if (isManagementRoom(memberIds, isSelfId)) {
    removeConversation(conversationIdFor(roomId));
    return "";
  }

  const person = meta.kind === "dm" ? others.map((id) => deps.people.byMatrixId(id)).find((p) => !!p) ?? null : null;
  const names = others.map((id) => profiles[id]?.name).filter((n): n is string => !!n);
  const { title, titleSource } = resolveTitle({
    person, roomName: meta.roomName, channelName: meta.channelName, memberDisplayNames: names,
    handle: others[0] ?? null, kind: meta.kind, network: meta.network,
  });
  const avatar = resolveAvatar({
    personPhoto: person?.photo ?? null, roomAvatar: meta.roomAvatar, channelAvatar: meta.channelAvatar,
    dmMemberAvatar: meta.kind === "dm" ? others.map((id) => profiles[id]?.avatar).find((a) => !!a) ?? null : null,
    title, memberAvatars: others.map((id) => profiles[id]?.avatar ?? null),
  });

  // Recent source events, read at most once and only when something needs them.
  let recentRead: Promise<MatrixEvent[] | null> | null = null;
  const recent = (): Promise<MatrixEvent[] | null> => (recentRead ??= (async () => {
    if (opts.recent?.length) return opts.recent;
    if (!opts.probe || !deps.reader.timelinePage) return null;
    try {
      return (await deps.reader.timelinePage(roomId, undefined, RECENT_EVENTS)).chunk;
    } catch {
      return null; // the preview / folder simply stay as the vault evidence has them
    }
  })());

  let lastAt = num(m.lastMessageAt);
  const sender = typeof m.lastMessageSender === "string" ? m.lastMessageSender : null;
  // The vault wrote lastMessageIsSelf with the owner ids IT knew: his bridge ghosts may be missing.
  let isSelf = sender && isAgentPuppet(sender) ? false : m.lastMessageIsSelf === true || isSelfId(sender);
  // The vault cut lastMessageText with a UTF-16 slice: never let half an emoji reach the wire.
  // When the latest line is an edit, the vault holds its "* …" fallback: use the edited text.
  const rawText = editedPreview(conversationIdFor(roomId), m.lastMessageEventId) ?? m.lastMessageText;
  let text = typeof rawText === "string" ? clipText(rawText, MAX_PREVIEW_CHARS).replace(/\s+/g, " ").trim() : "";
  // Sender names go through the title filter: a ghost/handle-like name never reaches a preview.
  const clean = (raw: string | null | undefined): string | null => {
    const r = raw?.trim();
    return r && resolveTitle({ memberDisplayNames: [r], kind: "dm" }).titleSource === "contact" ? r : null;
  };
  let senderName = isSelf ? null : clean(sender ? profiles[sender]?.name : null) ?? clean(sender ? deps.people.byMatrixId(sender)?.name : null);
  const id = conversationIdFor(roomId);
  const before = db.prepare("SELECT * FROM comms_conversations WHERE id = ?").get(id) as
    { folder?: string; last_preview_json?: string | null; last_event_at?: string } | undefined;
  const evidence = db.prepare("SELECT owner_epoch, preview_sender FROM comms_projection_evidence WHERE conversation_id = ?").get(id) as
    { owner_epoch: string; preview_sender: string | null } | undefined;
  let previewSender: string | null = sender;
  let fromSource = false;
  let selfSpoke = false;
  let recentSeen = false; // the recent events were read and normalized already
  let reused: MessagePreview | null = null;
  if (!text) {
    // The source preview an earlier rebuild made still stands while the note names no newer
    // message: a restart must not re-read every evidence-less room (review round 1, item 6) —
    // but only when it was computed with THIS owner-id set. A row from a build that knew fewer
    // owner ids (no ghost detection, before the first detection, before a reset) has a stale
    // isSelf / folder: it is re-derived from one bounded read (prod 2026-11-22: 58 of 60
    // "unknown" DMs held the owner's own messages).
    const prior = before?.last_preview_json ? (JSON.parse(before.last_preview_json) as MessagePreview) : null;
    const priorAt = before?.last_event_at ? Date.parse(before.last_event_at) : NaN;
    if (prior?.text && Number.isFinite(priorAt) && priorAt >= lastAt && evidence?.owner_epoch === epoch) {
      // isSelf from the stored sender against the current set where it is known.
      previewSender = evidence.preview_sender;
      isSelf = previewSender ? isSelfId(previewSender) : prior.isSelf;
      reused = isSelf === prior.isSelf ? prior : { ...prior, isSelf, senderName: isSelf ? null : prior.senderName };
    } else {
      // Notes written before the evidence fields existed have none: one bounded source read.
      const events = await recent();
      const got = events?.length ? latestOf(events, roomId, meta.network, selfIds, profiles) : null;
      recentSeen = !!events;
      if (got?.latest) {
        const l = got.latest;
        isSelf = l.sender.isSelf;
        previewSender = l.sender.id;
        senderName = isSelf ? null : clean(profiles[l.sender.id]?.name) ?? clean(deps.people.byMatrixId(l.sender.id)?.name);
        text = clipText(previewText(l, "", false), MAX_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
        const at = Date.parse(l.sentAt);
        if (Number.isFinite(at) && at > lastAt) lastAt = at;
        fromSource = true;
      }
      selfSpoke = !!got?.selfSpoke;
    }
  }
  const lastEventAt = reused ? before!.last_event_at! : new Date(lastAt || Date.parse(note.updatedAt ?? note.createdAt) || 0).toISOString();
  const lastPreview: MessagePreview | null = reused ?? (text
    ? {
        text: meta.kind === "group" && !isSelf && senderName ? `${firstName(senderName)}: ${text}` : text,
        senderName, isSelf, sentAt: lastEventAt,
      }
    : null);

  const tags = note.tags ?? [];
  let folder: Folder = "inbox";
  if (tags.includes("low")) folder = "low";
  else if (meta.kind === "dm" && !person && !num(m.lastSelfReplyAt) && !isSelf && !selfSpoke) {
    // "Unknown" = a stranger the owner never wrote to. The vault's lastSelfReplyAt misses his
    // bridge ghosts, so the room's recent events decide (a live batch, else one bounded read).
    if (recentSeen) folder = "unknown";
    // A reused source preview was made by this code from the same events under the same owner
    // set (owner epoch): so was its folder.
    else if (reused && (before?.folder === "unknown" || before?.folder === "inbox")) folder = before.folder as Folder;
    else {
      const events = await recent();
      selfSpoke = !!events?.length && latestOf(events, roomId, meta.network, selfIds, profiles).selfSpoke;
      // A live pass reads nothing: without new evidence the folder the rebuild chose stands.
      if (!selfSpoke && !events && before?.folder && before.folder !== "unknown") folder = before.folder as Folder;
      else folder = selfSpoke ? "inbox" : "unknown";
    }
  }

  upsertConversation({
    id, network: meta.network, sourceRef: roomId, kind: meta.kind, title, titleSource, avatar, lastEventAt, lastPreview,
    // Phase 1: no read markers exist yet, so any non-self last message is unread (count 1), untrusted.
    unreadCount: (lastAt > 0 || fromSource || reused) && !isSelf ? 1 : 0, unreadTrusted: false,
    folder, pinned: false, muted: false, archived: false, triage: null, status: commsStatus(note.tags), accountLabel: meta.accountName,
    capabilities: meta.capabilities, vaultNoteId: note.id,
  });
  db.prepare(`INSERT INTO comms_projection_evidence (conversation_id, owner_epoch, preview_sender) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET owner_epoch = excluded.owner_epoch, preview_sender = excluded.preview_sender`).run(id, epoch, previewSender);
  // A Telegram forum topic is a sub-conversation of its forum's thread (comms/forums.ts); any other
  // room is a thread of its own (a room that stopped being a topic goes back to one).
  let forumChanged = false;
  let threadId: string;
  if (meta.forum) {
    const a = attachTopic(id, meta.forum, title);
    threadId = a.threadId;
    forumChanged = a.changed;
  } else {
    detachTopic(id);
    threadId = ensureSingleThread(id);
  }
  // Who is here (people index): a DM keeps every non-self member's ghost id (call routing / contact
  // data) and its person; a group keeps the members that map to a person note (shared chats).
  const resolved = others.slice(0, MAX_MEMBER_ROWS).map((memberId) => ({ memberId, personId: deps.people.byMatrixId(memberId)?.id ?? null }));
  replaceConversationMembers(id, meta.kind === "dm" ? resolved : resolved.filter((m) => m.personId));
  setThreadPerson(threadId, meta.kind === "dm" ? person?.id ?? null : null);
  const after = db.prepare("SELECT * FROM comms_conversations WHERE id = ?").get(id);
  if (forumChanged || JSON.stringify(before) !== JSON.stringify(after)) {
    const strip = (r: unknown) => { const { status: _s, ...rest } = (r ?? {}) as Record<string, unknown>; return JSON.stringify(rest); };
    const statusOnly = !!before && !!opts.burst && strip(before) === strip(after);
    if (statusOnly && opts.burst!.announced >= STATUS_EVENT_BUDGET) opts.burst!.folded++;
    else {
      if (statusOnly) opts.burst!.announced++;
      appendEvent("thread.updated", threadId, { threadId });
    }
  }
  return threadId;
}

/** Project one room; returns its thread id and appends thread.updated. `recent` = the live batch. */
export async function projectRoom(deps: ProjectDeps, roomId: string, note?: Note, recent?: MatrixEvent[]): Promise<string> {
  const n = note ?? (await deps.vault.listByTag("message-thread")).find((x) => md(x).matrixRoomId === roomId);
  if (!n) throw new Error(`no message-thread note for ${roomId}`);
  // Probe only for a room not projected yet (a live pass must not cost a source read per message).
  const known = !!db.prepare("SELECT 1 FROM comms_conversations WHERE id = ?").get(conversationIdFor(roomId));
  const threadId = await projectOne(deps, roomId, n, await selfIdsOf(deps), { recent, probe: !known });
  mergeForumThreads();
  return threadId;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new TimeoutError(what)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
class TimeoutError extends Error {
  constructor(what: string) { super(`timeout: ${what}`); this.name = "TimeoutError"; }
}

/** A failure's class for the log — never its message (Matrix errors carry the room id). */
export function errorClass(e: unknown): string {
  if (e instanceof TimeoutError) return "timeout";
  const name = e instanceof Error ? e.name : typeof e;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const status = e instanceof Error ? /→ (\d{3})\b/.exec(e.message)?.[1] : undefined;
  return status ? `http_${status}` : name || "error";
}
/** The owner is not (or no longer) in the room: the homeserver refuses its reads. */
const isLeft = (e: unknown) => /^http_(403|404)$/.test(errorClass(e));
/** A redacted room reference for logs: the first 8 characters of its conversation id. */
export const redactRoom = (roomId: string) => `c_${conversationIdFor(roomId).slice(0, 8)}`;

/** Pass 1 keeps full member profiles only for rooms up to this size; a bigger room keeps its id
 *  list and is read again in pass 2 (bounded retention on the memory-constrained host). */
export const PROFILE_RETAIN_MAX_MEMBERS = 50;
/** More than this share of pass-1 reads failing = a degraded pass: owner ids are kept, not replaced. */
export const DEGRADED_FAILURE_SHARE = 0.1;
/** A joined-rooms list holding fewer than this share of the notes' rooms is not believed. */
export const JOINED_MIN_SHARE = 0.5;

export interface RebuildResult {
  conversations: number;
  failed: string[];
  left: number;
  failures: Record<string, number>;
  /** Owner ghosts in effect after this rebuild (detected, kept or overridden). */
  ownerGhosts: number;
  ownerDetection: "auto" | "override" | "off";
  degraded: boolean;
}

/**
 * The owner's ids for this rebuild (review rounds 1–2). Detection never forgets an id on missing
 * or marginal evidence (`reconcileOwners`: hysteresis, degraded passes keep everything), never
 * adopts a replacement on a network whose earlier ghost vanished (blocked until a reset or an
 * override), and every change is logged as a warning with redacted ids.
 */
function resolveOwners(rooms: RoomMembers[], exclude: string[], healthy: boolean, deps: ProjectDeps, personIds: string[], displayNames: Map<string, string>): OwnerSender[] {
  const mode = ownerDetectionMode();
  let ghosts: OwnerSender[] = [];
  if (mode === "override") ghosts = config.commsOwnerGhosts.map((mxid) => ({ mxid, source: "override" }));
  else if (mode === "auto") {
    const prev = storedOwnerSenderRows().filter((r) => r.source === "detected").map((r) => r.mxid);
    const d = detectOwners(rooms, exclude, { ownerNames: deps.ownerNames ?? [], displayNames, stats: prev });
    for (const v of d.vetoed) console.warn(`[comms] owner ghost on ${ghostNetworkOf(v) ?? "matrix"} vetoed by name: ${redactMxid(v)} (add an owner alias, or set COMMS_OWNER_GHOSTS)`);
    const r = reconcileOwners(d, prev, ownerBlockedNetworks(), healthy);
    setOwnerBlockedNetworks(r.blocked);
    if (r.added.length || r.removed.length)
      console.warn(`[comms] owner ghosts changed: +[${r.added.map(redactMxid).join(", ")}] -[${r.removed.map(redactMxid).join(", ")}]`);
    if (r.suppressed.length)
      console.warn(`[comms] owner ghosts: a new candidate on ${r.suppressed.join(", ")} was NOT adopted (an earlier ghost there stands or vanished) — set COMMS_OWNER_GHOSTS or reset via POST /api/comms/admin/owner-ids/reset`);
    ghosts = r.ids.map((mxid) => ({ mxid, source: "detected" as const, stats: d.stats[mxid] ?? d.combined([mxid]) }));
  }
  const ex = new Set(exclude.map((x) => x.toLowerCase()));
  const seen = new Set<string>();
  const out: OwnerSender[] = [];
  for (const o of [
    ...(deps.ownerIds ?? []).map((mxid) => ({ mxid, source: "configured" as const })),
    ...personIds.map((mxid) => ({ mxid, source: "person" as const })),
    ...ghosts,
  ] as OwnerSender[]) {
    const k = o.mxid.trim().toLowerCase();
    if (!k || ex.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ ...o, mxid: k });
  }
  return out;
}

export async function rebuildProjection(
  deps: ProjectDeps,
  opts: { concurrency?: number; roomTimeoutMs?: number } = {},
): Promise<RebuildResult> {
  const notes = (await deps.vault.listByTag("message-thread")).filter(
    (n) => !(n.tags ?? []).includes("message-archive") && typeof md(n).matrixRoomId === "string" && md(n).matrixRoomId,
  );
  const me = await deps.reader.whoami();
  // Rooms the account left (or was removed from) are not conversations any more: excluded, and
  // a row an earlier rebuild made for one is dropped. The joined list is one cheap call — but an
  // empty or badly short one (a homeserver hiccup) is not believed: per-room 403s decide then.
  let joined: Set<string> | null = null;
  if (deps.reader.joinedRooms) {
    try {
      joined = new Set(await deps.reader.joinedRooms());
    } catch {
      joined = null;
    }
    const inJoined = joined ? notes.filter((n) => joined!.has(md(n).matrixRoomId as string)).length : 0;
    if (joined && (joined.size === 0 || inJoined < JOINED_MIN_SHARE * notes.length)) {
      console.warn(`[comms] projection: joined-rooms list holds ${inJoined} of ${notes.length} thread rooms — ignored`);
      joined = null;
    }
  }
  const leftRooms: string[] = [];
  const live = notes.filter((n) => {
    const r = md(n).matrixRoomId as string;
    if (joined && !joined.has(r)) { leftRooms.push(r); return false; }
    return true;
  });
  const failed: string[] = [];
  const failures: Record<string, number> = {};
  const fail = (roomId: string, e: unknown): boolean => {
    if (isLeft(e)) { leftRooms.push(roomId); return false; }
    const cls = errorClass(e);
    failed.push(roomId);
    failures[cls] = (failures[cls] ?? 0) + 1;
    console.warn(`[comms] projection: room ${redactRoom(roomId)} failed (${cls})`);
    return true;
  };
  const timeoutMs = opts.roomTimeoutMs ?? ROOM_TIMEOUT_MS;
  const pool = async <T>(items: T[], each: (x: T) => Promise<void>) => {
    let next = 0;
    const worker = async () => { while (next < items.length) await each(items[next++]!); };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, items.length || 1)) }, worker));
  };

  // Pass 1: every room's member ids. The owner's bridge ghosts are only visible across rooms.
  // Full profiles are kept for small rooms only (I4); a big room is read again in pass 2.
  // The room's state is read here too (its bridge room type feeds detection), kept WITHOUT its
  // m.room.member events (the bulk) and handed to pass 2, so no room's state is read twice.
  const members = new Map<string, string[]>();
  const profiles = new Map<string, Profiles>();
  const states = new Map<string, MatrixEvent[]>();
  const rooms: RoomMembers[] = [];
  const displayNames = new Map<string, string>();
  let pass1Failed = 0;
  await pool(live, async (n) => {
    const roomId = md(n).matrixRoomId as string;
    try {
      const [p, st] = await withTimeout(Promise.all([deps.reader.memberProfiles(roomId), deps.reader.roomState(roomId)]), timeoutMs, "members");
      const ids = Object.keys(p);
      members.set(roomId, ids);
      const slim = projectionState(st);
      states.set(roomId, slim);
      rooms.push({ members: ids, type: bridgeRoomType(slim) });
      for (const id of ids) if (ghostNetworkOf(id) && p[id]?.name && !displayNames.has(id.toLowerCase())) displayNames.set(id.toLowerCase(), p[id]!.name!);
      if (ids.length <= PROFILE_RETAIN_MAX_MEMBERS) profiles.set(roomId, p);
    } catch (e) {
      if (fail(roomId, e)) pass1Failed++;
    }
  });
  const healthy = pass1Failed <= DEGRADED_FAILURE_SHARE * live.length;
  const exclude = [me, ...(deps.extraSelfIds ?? []), ...agentSenderIds()];
  const lists = [...members.values()];
  const personIds = deps.isOwner ? [...new Set(lists.flat().filter((id) => deps.isOwner!(id)))] : [];
  const owners = resolveOwners(rooms, exclude, healthy, deps, personIds, displayNames);
  storeOwnerSenders(owners.map((o) => ({ id: o.mxid, source: o.source, stats: o.stats ?? null })));
  const ghostRows = owners.filter((o) => o.source === "detected" || o.source === "override");
  console.log(`[comms] owner ghosts (${ownerDetectionMode()}${healthy ? "" : ", degraded pass: earlier ids kept"}): ${ghostRows.map((o) => redactMxid(o.mxid)).join(", ") || "none"}`);
  const selfIds = await selfIdsOf(deps, owners.map((o) => o.mxid));

  // Pass 2: project (re-reading members for the rooms whose profiles were not retained).
  let done = 0;
  const burst = { announced: 0, folded: 0 };
  await pool(live.filter((n) => members.has(md(n).matrixRoomId as string)), async (n) => {
    const roomId = md(n).matrixRoomId as string;
    try {
      const kept = profiles.get(roomId);
      const state = states.get(roomId);
      profiles.delete(roomId); // released as soon as the room is projected
      states.delete(roomId);
      await withTimeout(projectOne(deps, roomId, n, selfIds, { ...(kept ? { profiles: kept } : {}), ...(state ? { state } : {}), probe: true, burst }), timeoutMs, "project");
      done++;
    } catch (e) {
      fail(roomId, e);
    }
  });
  // Threads past the budget changed only in status: one summary event (threadId null) tells clients to refetch the list.
  if (burst.folded) appendEvent("thread.updated", null, { threadId: null, reason: "status" });
  for (const r of leftRooms) removeConversation(conversationIdFor(r));
  // Telegram forums: per-topic threads from before grouping become the forum thread (state merged, ids redirected).
  const forumsMerged = mergeForumThreads();
  if (forumsMerged) console.log(`[comms] forums: ${forumsMerged} per-topic threads merged into their forum threads`);
  return { conversations: done, failed, left: leftRooms.length, failures, ownerGhosts: ghostRows.length, ownerDetection: ownerDetectionMode(), degraded: !healthy };
}
