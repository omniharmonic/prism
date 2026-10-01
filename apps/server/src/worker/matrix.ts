/**
 * Matrix → vault ingester (Phase 3 — server-first runtime). A Node port of the
 * desktop's message_sync, so a tenant's bridged messaging (WhatsApp/Telegram/…
 * via mautrix) lands in their vault from the SERVER, with no desktop running.
 * The credential is read from the per-tenant secret store (kind="matrix"); this
 * module is pure transport + mapping, with `fetch` + the vault client injectable
 * so the parsing/mapping is unit-tested without a live homeserver.
 *
 * Note shape matches the desktop (so Prism's message renderer is unchanged):
 *   tags: ["message-thread"], path: vault/messages/<platform>/<room>,
 *   metadata: { type:"message-thread", platform, matrixRoomId, lastMessageAt }.
 */
import type { Note } from "../parachute";
import { byteLen, isArchiveNote, isTooLarge, rolloverLimits, rolloverThread } from "./matrix-rollover";
import { PeopleIndex } from "./people";
import type { IfExists, NoteLinkInput } from "../parachute";

export interface MatrixCreds {
  homeserver: string;
  accessToken: string;
}
export interface MatrixMessage {
  sender: string;
  body: string;
  ts: number;
  eventId: string;
}
export interface RoomBatch {
  roomId: string;
  name: string | null;
  memberIds: string[];
  /** Joined member id → displayname (from m.room.member state), when known. */
  displayNames: Record<string, string>;
  messages: MatrixMessage[];
  /**
   * The homeserver truncated this room's timeline (more events arrived since the
   * cursor than the filter's limit). `messages` is then only the TAIL — the gap
   * before it must be fetched from `prevBatch` or it is silently lost.
   */
  limited?: boolean;
  prevBatch?: string;
}
export interface SyncResult {
  nextBatch: string;
  rooms: RoomBatch[];
  /** Rooms the user is INVITED to but has not joined (their timeline is not in /sync). */
  invites: Array<{ roomId: string; name: string | null }>;
}

type FetchLike = typeof fetch;

/** Minimal Matrix client — the read paths message ingest needs. */
export class MatrixClient {
  constructor(
    private creds: MatrixCreds,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private url(path: string): string {
    return `${this.creds.homeserver.replace(/\/+$/, "")}/_matrix/client/v3${path}`;
  }
  private async get(path: string): Promise<unknown> {
    const r = await this.fetchImpl(this.url(path), {
      headers: { Authorization: `Bearer ${this.creds.accessToken}` },
    });
    if (!r.ok) throw new Error(`matrix ${path} → ${r.status}`);
    return r.json();
  }

  /** Confirm the token; returns the user id. */
  async whoami(): Promise<string> {
    return ((await this.get("/account/whoami")) as { user_id: string }).user_id;
  }

  /**
   * One /sync pass. Parses, per joined room, the room name + joined member ids +
   * the recent m.room.message events — all from the sync payload (no per-room
   * /state calls). `since` resumes from a prior nextBatch (incremental).
   */
  async sync(since?: string, timeoutMs = 0): Promise<SyncResult> {
    const filter = encodeURIComponent(
      JSON.stringify({ room: { timeline: { limit: 30 } } }),
    );
    const qs = [
      `filter=${filter}`,
      `timeout=${timeoutMs}`,
      since ? `since=${encodeURIComponent(since)}` : "",
    ]
      .filter(Boolean)
      .join("&");
    const data = (await this.get(`/sync?${qs}`)) as MatrixSyncResponse;
    return parseSync(data);
  }

  /**
   * ALL pending invites. An incremental /sync (with `since`) only lists invites
   * that changed after the cursor, so a backlog from before the cursor is
   * invisible to it. This is a full /sync with everything but the invite list
   * filtered out (no timeline, no room state, no presence) — cheap even with
   * hundreds of joined rooms. Its next_batch is deliberately NOT returned: the
   * ingest cursor must keep advancing from the incremental stream.
   */
  async pendingInvites(): Promise<SyncResult["invites"]> {
    const filter = encodeURIComponent(
      JSON.stringify({
        room: {
          timeline: { limit: 0 },
          state: { types: [] },
          ephemeral: { types: [] },
          account_data: { types: [] },
        },
        presence: { types: [] },
        account_data: { types: [] },
      }),
    );
    const data = (await this.get(
      `/sync?filter=${filter}&timeout=0`,
    )) as MatrixSyncResponse;
    return parseSync(data).invites;
  }

  /** Authoritative joined-room ids (the invite probe can be served from Synapse's cache and lag). */
  async joinedRooms(): Promise<string[]> {
    return (
      ((await this.get("/joined_rooms")) as { joined_rooms: string[] })
        .joined_rooms ?? []
    );
  }

  /**
   * Paginate a room's m.room.message history BACKWARD from `from` (a sync or
   * /messages token), stopping at the `to` token when given (exact — the previous
   * sync cursor), else at the first message with ts <= `sinceTs`. Returned
   * oldest-first. `cap` bounds a runaway room; hitting it is logged by callers.
   */
  async messagesBefore(
    roomId: string,
    opts: { from?: string; to?: string; sinceTs?: number; cap?: number },
  ): Promise<{ messages: MatrixMessage[]; capped: boolean }> {
    const cap = opts.cap ?? 5000;
    const filter = encodeURIComponent(JSON.stringify({ types: ["m.room.message"] }));
    const out: MatrixMessage[] = [];
    let from = opts.from;
    for (;;) {
      const qs = [
        "dir=b",
        "limit=100",
        `filter=${filter}`,
        from ? `from=${encodeURIComponent(from)}` : "",
        opts.to ? `to=${encodeURIComponent(opts.to)}` : "",
      ].filter(Boolean).join("&");
      const page = (await this.get(
        `/rooms/${encodeURIComponent(roomId)}/messages?${qs}`,
      )) as { chunk?: MatrixEvent[]; end?: string };
      const chunk = page.chunk ?? [];
      for (const e of chunk) {
        const m = toMessage(e);
        if (!m) continue;
        if (!opts.to && opts.sinceTs !== undefined && m.ts <= opts.sinceTs) {
          // Keep boundary-equal messages — the caller dedupes them by line.
          if (m.ts === opts.sinceTs) out.push(m);
          return { messages: out.reverse(), capped: false };
        }
        out.push(m);
        if (out.length >= cap) return { messages: out.reverse(), capped: true };
      }
      if (!chunk.length || !page.end || page.end === from)
        return { messages: out.reverse(), capped: false };
      from = page.end;
    }
  }

  /** Joined member id → displayname (a room we have no sync state for). */
  async joinedMembers(roomId: string): Promise<Record<string, string>> {
    const r = (await this.get(
      `/rooms/${encodeURIComponent(roomId)}/joined_members`,
    )) as { joined?: Record<string, { display_name?: string | null }> };
    const out: Record<string, string> = {};
    for (const [id, v] of Object.entries(r.joined ?? {}))
      out[id] = v.display_name?.trim() || "";
    return out;
  }

  /** A user's global displayname (senders no longer in the room), or null. */
  async profileName(userId: string): Promise<string | null> {
    try {
      const r = (await this.get(
        `/profile/${encodeURIComponent(userId)}/displayname`,
      )) as { displayname?: string | null };
      return r.displayname?.trim() || null;
    } catch {
      return null;
    }
  }

  /** The room's m.room.name, or null. */
  async roomName(roomId: string): Promise<string | null> {
    try {
      const r = (await this.get(
        `/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
      )) as { name?: string };
      return typeof r.name === "string" && r.name ? r.name : null;
    } catch {
      return null; // 404 = unnamed room (DMs)
    }
  }

  /** Accept a pending invite. The room's timeline shows up in the NEXT /sync. */
  async join(roomId: string): Promise<void> {
    const r = await this.fetchImpl(
      this.url(`/join/${encodeURIComponent(roomId)}`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.creds.accessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    if (!r.ok) throw new Error(`matrix join ${roomId} → ${r.status}`);
  }

  /** Post a plain-text message (bridge management-room commands). */
  async sendText(roomId: string, body: string): Promise<void> {
    const txn = `prism${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const r = await this.fetchImpl(
      this.url(`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`),
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.creds.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ msgtype: "m.text", body }),
      },
    );
    if (!r.ok) throw new Error(`matrix send ${roomId} → ${r.status}`);
  }

  /**
   * Send an event with a CALLER-chosen transaction id (WP1.5 live actions). The
   * homeserver dedupes a repeated txnId for the same access token, so a retry
   * with the same id never posts twice. Returns the event id.
   */
  async sendEvent(roomId: string, eventType: "m.room.message" | "m.reaction", txnId: string, content: Record<string, unknown>): Promise<string> {
    const r = await this.fetchImpl(
      this.url(`/rooms/${encodeURIComponent(roomId)}/send/${eventType}/${encodeURIComponent(txnId)}`),
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.creds.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(content),
        // A stalled homeserver must not hold the request (and its idempotency
        // key) forever; a timeout is reported as outcome-unknown by the caller.
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!r.ok) {
      const err = new Error(`matrix send ${eventType} → ${r.status}`) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    const j = (await r.json().catch(() => ({}))) as { event_id?: string };
    return typeof j.event_id === "string" ? j.event_id : "";
  }

  /** Reject a pending invite (leave). Removes it from the pending-invite list. */
  async leave(roomId: string): Promise<void> {
    const r = await this.fetchImpl(this.url(`/rooms/${encodeURIComponent(roomId)}/leave`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.creds.accessToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) throw new Error(`matrix leave ${roomId} → ${r.status}`);
  }
}

// ── pure parsing + mapping (unit-tested without a homeserver) ─────────────────

interface MatrixEvent {
  type?: string;
  sender?: string;
  event_id?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
  state_key?: string;
}
interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      {
        state?: { events?: MatrixEvent[] };
        timeline?: {
          events?: MatrixEvent[];
          limited?: boolean;
          prev_batch?: string;
        };
      }
    >;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
  };
}

/** An m.room.message event → MatrixMessage (null for non-text / empty bodies). */
function toMessage(e: MatrixEvent): MatrixMessage | null {
  if (
    e.type !== "m.room.message" ||
    typeof e.content?.body !== "string" ||
    !e.content.body.trim()
  )
    return null;
  return {
    sender: e.sender ?? "?",
    body: e.content.body,
    ts: e.origin_server_ts ?? 0,
    eventId: e.event_id ?? "",
  };
}

/** Parse a raw /sync response into per-room name + members + messages. */
export function parseSync(data: MatrixSyncResponse): SyncResult {
  const rooms: RoomBatch[] = [];
  const joined = data.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(joined)) {
    const events = [
      ...(room.state?.events ?? []),
      ...(room.timeline?.events ?? []),
    ];
    let name: string | null = null;
    const memberIds = new Set<string>();
    const displayNames: Record<string, string> = {};
    const messages: MatrixMessage[] = [];
    for (const e of events) {
      if (e.type === "m.room.name" && typeof e.content?.name === "string")
        name = e.content.name;
      if (
        e.type === "m.room.member" &&
        e.content?.membership === "join" &&
        e.state_key
      ) {
        memberIds.add(e.state_key);
        if (
          typeof e.content.displayname === "string" &&
          e.content.displayname.trim()
        )
          displayNames[e.state_key] = e.content.displayname.trim();
      }
      const m = toMessage(e);
      if (m) messages.push(m);
    }
    rooms.push({
      roomId,
      name,
      memberIds: [...memberIds],
      displayNames,
      messages,
      ...(room.timeline?.limited
        ? { limited: true, prevBatch: room.timeline.prev_batch }
        : {}),
    });
  }
  const invites: SyncResult["invites"] = [];
  for (const [roomId, room] of Object.entries(data.rooms?.invite ?? {})) {
    const nameEv = (room.invite_state?.events ?? []).find(
      (e) => e.type === "m.room.name",
    );
    invites.push({
      roomId,
      name:
        typeof nameEv?.content?.name === "string" ? nameEv.content.name : null,
    });
  }
  return { nextBatch: data.next_batch ?? "", rooms, invites };
}

/** Detect the bridged platform from member ids (mautrix puppet prefixes). */
export function detectPlatform(memberIds: string[]): string {
  const prefixes: Array<[RegExp, string]> = [
    [/^@whatsapp_/i, "whatsapp"],
    [/^@telegram_/i, "telegram"],
    [/^@signal_/i, "signal"],
    [/^@discord/i, "discord"],
    [/^@instagram_/i, "instagram"],
    [/^@messenger_|@facebook_/i, "messenger"],
    [/^@twitter_/i, "twitter"],
  ];
  for (const id of memberIds)
    for (const [re, name] of prefixes) if (re.test(id)) return name;
  return "matrix";
}

const sanitizePath = (s: string): string =>
  (s || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

const shortSender = (id: string): string =>
  id
    .replace(/^@/, "")
    .replace(/:.+$/, "")
    .replace(
      /^(whatsapp|telegram|signal|discord|instagram|messenger|twitter)_/i,
      "",
    );

/** `[YYYY-MM-DD HH:MM]` in UTC — the desktop message_sync format, so readers can date every line. */
export const formatStamp = (ts: number): string => {
  const d = new Date(ts);
  if (!ts || Number.isNaN(d.getTime())) return "[unknown]";
  return `[${d.toISOString().slice(0, 16).replace("T", " ")}]`;
};

/** One transcript line: `[2026-08-23 20:12] Display Name: body` (falls back to the short sender id). */
export function formatLine(
  m: MatrixMessage,
  displayNames: Record<string, string> = {},
): string {
  const who = displayNames[m.sender] ?? shortSender(m.sender);
  return `${formatStamp(m.ts)} ${who}: ${m.body}`;
}

/**
 * Tags recording the hourly triage skill's verdict on a thread — either a
 * successful classification (`triaged` + one importance label) or a failure it
 * parked for review (`triage-failed`).
 *
 * A thread note is updated IN PLACE as messages arrive, so a stale verdict would
 * otherwise stick forever — strip them on append so the next run re-triages.
 *
 * `triage-failed` MUST be in this list. The classifier hard-excludes that tag
 * from its candidate set (structured_skill.rs), so a thread that fails once is
 * skipped by every later run; without stripping it here, new messages on that
 * thread can never earn a fresh attempt and the note is silently dropped from
 * triage for good. Stripping it costs at most one retry per thread per append.
 */
export const TRIAGE_TAGS = [
  "triaged",
  "urgent",
  "action-required",
  "informational",
  "low",
  "triage-failed",
];

/** The minimal vault surface the ingester needs (so tests inject a fake). */
export interface IngestVault {
  listNotes(opts: {
    tags?: string[];
    pathPrefix?: string;
    includeContent?: boolean;
  }): Promise<Note[]>;
  createNote(p: {
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    links?: NoteLinkInput[];
    ifExists?: IfExists;
  }): Promise<Note & { existed?: boolean }>;
  updateNote(
    id: string,
    p: {
      content?: string;
      metadata?: Record<string, unknown>;
      ifUpdatedAt?: string;
      links?: { add?: NoteLinkInput[] };
    },
  ): Promise<Note>;
  /** Optional: strip tags (used to clear stale triage verdicts on append). */
  removeTags?(id: string, tags: string[]): Promise<void>;
  /** Optional: re-read one note (thread rollover retries on a 409 with it). */
  getNote?(id: string): Promise<Note>;
}

/**
 * room id → thread note. Archives (message-archive, `archiveOf`) are never
 * adopted, even if a tag hierarchy or a hand edit ever put them in the listing.
 */
function threadsByRoom(notes: Note[]): Map<string, Note> {
  const byRoom = new Map<string, Note>();
  for (const n of notes) {
    if (isArchiveNote(n)) continue;
    const rid = n.metadata?.matrixRoomId;
    if (typeof rid === "string") byRoom.set(rid, n);
  }
  return byRoom;
}

/**
 * Roll over every thread already past MATRIX_THREAD_MAX_BYTES (the pre-upgrade
 * sweep: on vault ≥0.7.9 a >2 MB thread can no longer be updated at all, so this
 * must have run on 0.6.1 first). Piggybacks on the full thread listing each pass
 * already loads — no extra reads unless a thread is actually oversized. Updates
 * `byRoom` in place so the same pass appends to the trimmed note.
 */
export async function sweepOversizedThreads(
  vault: IngestVault,
  byRoom: Map<string, Note>,
  opts: { maxPerPass?: number } = {},
): Promise<{ rolled: number; archives: number }> {
  const { maxBytes } = rolloverLimits();
  let rolled = 0;
  let archives = 0;
  for (const [roomId, note] of byRoom) {
    if (rolled >= (opts.maxPerPass ?? 10)) break;
    if (byteLen(note.content ?? "") <= maxBytes) continue;
    try {
      const out = await rolloverThread(vault, note);
      if (!out) continue;
      byRoom.set(roomId, out.note);
      rolled++;
      archives += out.created;
      console.log(
        `[worker] matrix: rolled over ${note.path ?? note.id} (${byteLen(note.content ?? "")} bytes) → ${out.created} new archive note(s)${out.recovered ? `, ${out.recovered} already-archived message(s) trimmed` : ""}`,
      );
    } catch (e) {
      logRolloverFailure(note, e);
    }
  }
  return { rolled, archives };
}

function logRolloverFailure(note: Note, e: unknown): void {
  const size = byteLen(note.content ?? "");
  if (isTooLarge(e))
    console.error(
      `[worker] matrix: ERROR thread ${note.path ?? note.id} (${size} bytes) cannot be updated — the vault refused it (413). ` +
        `With note history on, a note over 2 MB can't be written at all, so it can't even be trimmed. Remedy: set ` +
        `\`history:\\n  enabled: false\` in that vault's vault.yaml, restart the vault, let this rollover run once, then re-enable history. ` +
        `Until then new messages for this room are NOT being stored (reconcileMatrix back-fills them afterwards). ${String(e)}`,
    );
  else console.error(`[worker] matrix: ERROR rollover of ${note.path ?? note.id} (${size} bytes) failed: ${String(e)}`);
}

export interface IngestResult {
  rooms: number;
  messages: number;
  created: number;
  updated: number;
  nextBatch: string;
  /** Pending invites seen this pass (all of them, whether or not any were accepted). */
  invitesPending: number;
  /** Invites accepted this pass (0 unless opts.autoJoin). */
  joined: number;
  /** Thread→person links written this pass (0 unless opts.linkPeople). */
  peopleLinked: number;
  /** Person notes created this pass (0 unless opts.linkPeople). */
  peopleCreated: number;
}

/** Above this many joined members a room is a group chat, not a relationship:
 *  known people are still linked, but nobody is CREATED from a group roster
 *  (message_sync.rs MAX_MEMBERS_FOR_PERSON_CREATION — the ~3.3k junk-stub fix). */
export const MAX_MEMBERS_FOR_PERSON_CREATION = 3;

/** Bridge bots / appservice ghosts never become people (message_sync.rs rule). */
export const isBridgeBot = (mxid: string): boolean => mxid.includes("bot:") || mxid.startsWith("@_");

/**
 * The desktop's `link_participants`, over the index in worker/people.ts: resolve
 * every joined member (display name, else the mxid) to a person note — created
 * only in rooms of <= MAX_MEMBERS_FOR_PERSON_CREATION members — and return the
 * `messages-with` links to write with the thread. Deviation from the desktop:
 * the sync user itself is skipped (it would link every thread to one hub note).
 */
export async function participantLinks(
  members: Record<string, string>,
  people: PeopleIndex,
  vault: Pick<IngestVault, "createNote">,
  opts: { platform: string; selfUserId?: string | null },
): Promise<NoteLinkInput[]> {
  const ids = Object.keys(members);
  const allowCreate = ids.length <= MAX_MEMBERS_FOR_PERSON_CREATION;
  const out: NoteLinkInput[] = [];
  const seen = new Set<string>();
  for (const mid of ids) {
    if (isBridgeBot(mid) || mid === opts.selfUserId) continue;
    const name = members[mid] || mid;
    const r = await people
      .findOrCreate(vault, name, { matrixId: mid, platform: opts.platform, allowCreate })
      .catch(() => null);
    if (r && !seen.has(r.id)) {
      seen.add(r.id);
      out.push({ target: r.id, relationship: "messages-with" });
    }
  }
  return out;
}

/**
 * Ingest one sync pass into the vault: upsert a message-thread note per room
 * with new messages (matched by metadata.matrixRoomId). Returns counts + the
 * nextBatch to persist for the next incremental pass.
 */
export async function ingestMatrix(
  client: Pick<MatrixClient, "sync"> &
    Partial<
      Pick<
        MatrixClient,
        "join" | "pendingInvites" | "joinedRooms" | "leave" | "messagesBefore" | "joinedMembers" | "profileName"
      >
    >,
  vault: IngestVault,
  opts: {
    since?: string;
    maxRooms?: number;
    autoJoin?: boolean;
    maxJoinsPerRun?: number;
    probeInvites?: boolean;
    /** MATRIX_LINK_PEOPLE: link each thread to its participants' person notes. */
    linkPeople?: boolean;
    /** The sync user's mxid (never linked as a participant). */
    selfUserId?: string | null;
  } = {},
): Promise<IngestResult> {
  const { nextBatch, rooms, invites: fresh } = await client.sync(opts.since);
  // Incremental sync only carries NEW invites; the probe sees the whole backlog.
  const invites = [...fresh];
  if (opts.probeInvites && client.pendingInvites) {
    try {
      const seen = new Set(invites.map((i) => i.roomId));
      // Synapse can serve the full-sync probe from cache for a while after a
      // join, so it re-lists rooms joined last pass; /joined_rooms is live.
      // Without this every pass burns its join budget on 200-no-op re-joins.
      const joinedNow = new Set(
        client.joinedRooms ? await client.joinedRooms() : [],
      );
      for (const inv of await client.pendingInvites())
        if (!seen.has(inv.roomId) && !joinedNow.has(inv.roomId))
          invites.push(inv);
    } catch (e) {
      console.warn(`[worker] matrix: invite probe failed: ${String(e)}`);
    }
  }

  // Accept pending invites (opt-in). Joined rooms' timelines arrive on the next
  // /sync, so nothing else happens this pass. Throttled so a 1000-portal backlog
  // drains over many passes instead of hammering the homeserver + vault at once.
  let joined = 0;
  if (opts.autoJoin && client.join) {
    const cap = opts.maxJoinsPerRun ?? 20;
    for (const inv of invites.slice(0, cap)) {
      try {
        await client.join(inv.roomId);
        joined++;
      } catch (e) {
        const msg = String(e);
        console.warn(
          `[worker] matrix: join ${inv.roomId} (${inv.name ?? "?"}) failed: ${msg}`,
        );
        // Synapse rate-limits joins (rc_joins: burst ~10, then 0.1/s). The rest
        // of this batch would 429 too — stop, and let the next pass retry; the
        // rooms stay pending and the probe re-lists them.
        if (/→ 429$/.test(msg)) break;
        // Any OTHER failure (404 = dead room, 403 = revoked invite, …) fails
        // identically forever, and the probe lists invites in a stable order —
        // so one poisoned invite wedges the head of every batch and starves the
        // rest once the 429 budget burns. Reject it so it leaves the queue.
        if (client.leave) {
          await client.leave(inv.roomId).then(
            () => console.warn(`[worker] matrix: rejected un-joinable invite ${inv.roomId} (${inv.name ?? "?"})`),
            (le) => console.warn(`[worker] matrix: could not reject ${inv.roomId}: ${String(le)}`),
          );
        }
      }
    }
  }
  const existing = await vault.listNotes({
    tags: ["message-thread"],
    includeContent: true,
  });
  const byRoom = threadsByRoom(existing);
  await sweepOversizedThreads(vault, byRoom);

  let messages = 0;
  let created = 0;
  let updated = 0;
  let processed = 0;
  let failed = 0;
  let gapFilled = 0;
  let peopleLinked = 0;
  // Built lazily, once per pass, only when a room actually needs linking.
  let people: PeopleIndex | null = null;
  const peopleBefore = () => people?.created ?? 0;
  const peopleAtStart = peopleBefore();
  for (const rb of rooms) {
    // A limited timeline is only the tail: more than the filter's 30 events
    // arrived since the cursor (a busy group, or a bridge backfilling a chat).
    // Fetch the gap back to the previous cursor BEFORE writing, or it is lost.
    let dedupe = false;
    if (rb.limited && rb.prevBatch && client.messagesBefore) {
      try {
        const note = byRoom.get(rb.roomId);
        // Exact `to` bound only for a room we already hold: a room joined since
        // the last pass has its whole history (bridge backfill included) BEFORE
        // that cursor, so it must page back to the start instead.
        const exact = Boolean(opts.since && note);
        const gap = await client.messagesBefore(rb.roomId, {
          from: rb.prevBatch,
          ...(exact
            ? { to: opts.since }
            : { sinceTs: note ? lastMessageAtOf(note) : 0 }),
        });
        if (gap.capped)
          console.warn(
            `[worker] matrix: gap-fill for ${rb.roomId} (${rb.name ?? "?"}) hit its cap — oldest messages of the gap skipped`,
          );
        const seen = new Set(rb.messages.map((m) => m.eventId));
        const older = gap.messages.filter((m) => !seen.has(m.eventId));
        rb.messages = [...older, ...rb.messages];
        gapFilled += older.length;
        // Without an exact `to` boundary the gap is timestamp-bounded, so a
        // boundary message may already be in the note — dedupe by line.
        dedupe = !exact;
      } catch (e) {
        console.warn(
          `[worker] matrix: gap-fill for ${rb.roomId} failed (tail only): ${String(e)}`,
        );
      }
    }
    if (!rb.messages.length) continue;
    if (opts.maxRooms && processed >= opts.maxRooms) break;
    processed++;
    // An incremental sync carries member-state DELTAS only, so most senders
    // arrive with no displayname — without this every line reads as a bare
    // bridge id (e.g. "251731455" for a Telegram user).
    await resolveDisplayNames(client, rb);
    messages += rb.messages.length;
    // One bad room must not abort the pass: the cursor still advances past the
    // others, and the failure is named instead of surfacing as a source-wide DOWN.
    // Person links ride in the thread's own write (idempotent on the vault), so
    // linking costs no extra PATCH. Full joined membership decides the group
    // cap — an incremental sync only carries member deltas.
    let links: NoteLinkInput[] = [];
    if (opts.linkPeople && client.joinedMembers) {
      try {
        const members = await client.joinedMembers(rb.roomId);
        people ??= await PeopleIndex.load(vault);
        links = await participantLinks(members, people, vault, {
          platform: detectPlatform(Object.keys(members)),
          selfUserId: opts.selfUserId,
        });
      } catch (e) {
        console.warn(`[worker] matrix: people for ${rb.roomId} skipped: ${String(e)}`);
      }
    }
    try {
      await ingestRoom(rb, vault, byRoom, { dedupe, links });
      peopleLinked += links.length;
    } catch (e) {
      failed++;
      console.warn(
        `[worker] matrix: room ${rb.roomId} (${rb.name ?? "?"}) failed: ${String(e)}`,
      );
      continue;
    }
    if (byRoom.has(rb.roomId)) updated++;
    else created++;
  }
  if (failed)
    console.warn(
      `[worker] matrix: ${failed} room(s) failed this pass (see above)`,
    );
  if (gapFilled)
    console.log(
      `[worker] matrix: recovered ${gapFilled} message(s) from truncated sync timelines`,
    );
  return {
    rooms: processed,
    messages,
    created,
    updated,
    nextBatch,
    invitesPending: invites.length,
    joined,
    peopleLinked,
    peopleCreated: peopleBefore() - peopleAtStart,
  };
}

/**
 * Fill `rb.displayNames` for every sender that lacks one: current members first
 * (one call), then the global profile for senders who have since left.
 * Best-effort — a failure leaves the id fallback in place.
 */
export async function resolveDisplayNames(
  client: Partial<Pick<MatrixClient, "joinedMembers" | "profileName">>,
  rb: Pick<RoomBatch, "roomId" | "messages" | "displayNames">,
): Promise<void> {
  const missing = () =>
    [...new Set(rb.messages.map((m) => m.sender))].filter((id) => !rb.displayNames[id]);
  if (!missing().length) return;
  if (client.joinedMembers) {
    const members = await client.joinedMembers(rb.roomId).catch(() => ({}) as Record<string, string>);
    for (const [id, n] of Object.entries(members))
      if (n && !rb.displayNames[id]) rb.displayNames[id] = n;
  }
  if (client.profileName)
    for (const id of missing()) {
      const n = await client.profileName(id).catch(() => null);
      if (n) rb.displayNames[id] = n;
    }
}

/** Short stable suffix so two rooms with the same display name get distinct paths. */
const roomSlug = (roomId: string): string =>
  roomId.replace(/^!/, "").replace(/:.*$/, "").slice(0, 8).toLowerCase();

/** A thread note's high-water mark (0 when absent — e.g. hand-made notes). */
export function lastMessageAtOf(note: Note): number {
  const v = note.metadata?.lastMessageAt;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Upsert one room's batch. Returns false when nothing was written (every line
 * was a duplicate). `dedupe` drops lines already present in the note verbatim —
 * used by the repair paths, whose timestamp boundary can overlap what the note
 * already holds.
 */
async function ingestRoom(
  rb: RoomBatch,
  vault: IngestVault,
  byRoom: Map<string, Note>,
  opts: { dedupe?: boolean; links?: NoteLinkInput[] } = {},
): Promise<boolean> {
  const linkAdd = opts.links?.length ? { links: { add: opts.links } } : {};
  const platform = detectPlatform(rb.memberIds);
  let lines = rb.messages.map((m) => formatLine(m, rb.displayNames));
  if (opts.dedupe) {
    const have = new Set((byRoom.get(rb.roomId)?.content ?? "").split("\n"));
    lines = lines.filter((l) => !have.has(l));
  }
  if (!lines.length) return false;
  const lastMessageAt = Math.max(...rb.messages.map((m) => m.ts));
  const participants = rb.memberIds.map(
    (id) => rb.displayNames[id] ?? shortSender(id),
  );
  const note = byRoom.get(rb.roomId);
  if (note) {
    const prev = note.metadata ?? {};
    const prevCount =
      typeof prev.messageCount === "number" ? prev.messageCount : 0;
    // Incremental /sync only carries member DELTAS — union with the stored list
    // (which the desktop seeded from full room state) rather than replacing it.
    const prevParticipants = Array.isArray(prev.participants)
      ? (prev.participants as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [];
    const mergedParticipants = [
      ...new Set([...prevParticipants, ...participants]),
    ];
    const metadata = {
      ...prev,
      type: "message-thread",
      platform,
      matrixRoomId: rb.roomId,
      // Monotonic: a bridge backfilling a gap posts OLD timestamps late, and
      // must not rewind the high-water mark the repair sweep compares against.
      lastMessageAt: Math.max(lastMessageAt, lastMessageAtOf(note)),
      messageCount: prevCount + lines.length,
      ...(mergedParticipants.length
        ? { participants: mergedParticipants }
        : {}),
    };
    const content = `${note.content.trimEnd()}\n${lines.join("\n")}`;
    // Past the size limit, append + archive the oldest messages in ONE live
    // write (archives first — see matrix-rollover.ts).
    const rolled =
      byteLen(content) > rolloverLimits().maxBytes
        ? await rolloverThread(vault, note, { appendEntries: lines, metadata }).catch((e) => {
            logRolloverFailure(note, e);
            throw e;
          })
        : null;
    if (rolled) byRoom.set(rb.roomId, rolled.note);
    else {
      try {
        await vault.updateNote(note.id, { content, metadata, ...linkAdd });
      } catch (e) {
        if (!isTooLarge(e)) throw e;
        // The vault refused the write as too large (history_overflow on ≥0.7.9).
        // Say so loudly, then try to shed the oldest messages in the same write.
        console.error(
          `[worker] matrix: ERROR vault refused append to ${note.path ?? note.id} for room ${rb.roomId} (${byteLen(content)} bytes, 413) — attempting rollover`,
        );
        const out = await rolloverThread(vault, note, { appendEntries: lines, metadata, force: true }).catch((re) => {
          logRolloverFailure(note, re);
          throw re;
        });
        if (!out) throw e;
        byRoom.set(rb.roomId, out.note);
      }
    }
    const stale = TRIAGE_TAGS.filter((t) => note.tags?.includes(t));
    if (stale.length && vault.removeTags) {
      await vault
        .removeTags(note.id, stale)
        .catch((e) =>
          console.warn(
            `[worker] matrix: could not clear triage tags on ${note.id}: ${String(e)}`,
          ),
        );
    }
  } else {
    const name = rb.name ?? rb.roomId;
    const base = `vault/messages/${platform}/${sanitizePath(name)}`;
    const params = {
      content: `# ${name} — ${platform}\n\n${lines.join("\n")}`,
      tags: ["message-thread"],
      metadata: {
        type: "message-thread",
        platform,
        matrixRoomId: rb.roomId,
        lastMessageAt,
        messageCount: lines.length,
        participants,
      },
      ...(opts.links?.length ? { links: opts.links } : {}),
    };
    // WP0.6: a same-named room's thread already at `base` (several "Unknown user
    // (WA)" DMs, say) is known from the listing — take the room-id path up front
    // instead of eating a 409 first. The catch below stays as the race backstop.
    const taken = [...byRoom.values()].some((n) => n.path === base);
    try {
      await vault.createNote({ ...params, path: taken ? `${base}-${roomSlug(rb.roomId)}` : base });
    } catch (e) {
      // 409 = a note already lives at that path (another room with the same
      // name — several "Unknown user (WA)" DMs, say). Disambiguate by room id.
      if (!/409/.test(String(e)) || taken) throw e;
      await vault.createNote({
        ...params,
        path: `${base}-${roomSlug(rb.roomId)}`,
      });
    }
  }
  return true;
}

export interface ReconcileResult {
  scanned: number;
  /** Joined rooms whose newest message is not in the vault. */
  behind: number;
  repaired: number;
  messages: number;
  /** Rooms still behind after this sweep (over the per-sweep repair budget). */
  deferred: number;
}

/**
 * The safety net under the incremental sync: for EVERY joined room, compare the
 * newest m.room.message (as of `upTo`, the sync cursor just persisted) with the
 * note's lastMessageAt, and fetch any gap. Anything a sync pass ever missed — a
 * truncated timeline before gap-fill existed, a lost/reset cursor, a failed
 * vault write, a room joined out-of-band — converges here instead of vanishing.
 *
 * Bounded to `upTo` so it never overlaps the next incremental pass. Most-recently
 * active rooms are repaired first; `maxRepairs` caps writes per sweep (each one
 * re-queues the thread for the local-model triage skill — pace it).
 */
export async function reconcileMatrix(
  client: Pick<
    MatrixClient,
    "joinedRooms" | "messagesBefore" | "joinedMembers" | "roomName"
  > &
    Partial<Pick<MatrixClient, "profileName">>,
  vault: IngestVault,
  opts: { upTo: string; maxRepairs?: number; cap?: number; concurrency?: number },
): Promise<ReconcileResult> {
  const joined = await client.joinedRooms();
  const existing = await vault.listNotes({
    tags: ["message-thread"],
    includeContent: true,
  });
  const byRoom = threadsByRoom(existing);
  await sweepOversizedThreads(vault, byRoom);

  // Probe: newest message per room (one cheap /messages call each).
  const behind: Array<{ roomId: string; latest: number; cutoff: number }> = [];
  const queue = [...joined];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        const { messages } = await client.messagesBefore(id, { from: opts.upTo, cap: 1 });
        const latest = messages[0]?.ts;
        if (latest === undefined) continue; // no messages ever — nothing to hold
        const note = byRoom.get(id);
        const cutoff = note ? lastMessageAtOf(note) : -1;
        if (latest > cutoff) behind.push({ roomId: id, latest, cutoff: Math.max(cutoff, 0) });
      } catch (e) {
        console.warn(`[worker] matrix reconcile: probe ${id} failed: ${String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));

  behind.sort((a, b) => b.latest - a.latest);
  const budget = opts.maxRepairs ?? 25;
  let repaired = 0;
  let messages = 0;
  for (const b of behind.slice(0, budget)) {
    try {
      const gap = await client.messagesBefore(b.roomId, {
        from: opts.upTo,
        sinceTs: b.cutoff,
        cap: opts.cap ?? 5000,
      });
      if (gap.capped)
        console.warn(`[worker] matrix reconcile: ${b.roomId} gap hit its cap — oldest skipped`);
      if (!gap.messages.length) continue;
      const displayNames = await client.joinedMembers(b.roomId);
      const rb: RoomBatch = {
        roomId: b.roomId,
        name: byRoom.has(b.roomId) ? null : await client.roomName(b.roomId),
        memberIds: Object.keys(displayNames),
        displayNames: Object.fromEntries(
          Object.entries(displayNames).filter(([, v]) => v),
        ),
        messages: gap.messages,
      };
      await resolveDisplayNames(client, rb);
      if (await ingestRoom(rb, vault, byRoom, { dedupe: true })) {
        repaired++;
        messages += gap.messages.length;
      }
    } catch (e) {
      console.warn(`[worker] matrix reconcile: repair ${b.roomId} failed: ${String(e)}`);
    }
  }
  return {
    scanned: joined.length,
    behind: behind.length,
    repaired,
    messages,
    deferred: Math.max(0, behind.length - budget),
  };
}
