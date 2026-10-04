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
import { byteLen, isArchiveNote, isTooLarge, parseThread, rolloverLimits, rolloverThread } from "./matrix-rollover";
import { PeopleIndex, type PersonReview } from "./people";
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
    private readTimeoutMs?: number,
  ) {}

  private url(path: string): string {
    return `${this.creds.homeserver.replace(/\/+$/, "")}/_matrix/client/v3${path}`;
  }
  private async get(path: string): Promise<unknown> {
    const r = await this.fetchImpl(this.url(path), {
      headers: { Authorization: `Bearer ${this.creds.accessToken}` },
      ...(this.readTimeoutMs ? { signal: AbortSignal.timeout(this.readTimeoutMs) } : {}),
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
    // A caller that wants at most `cap` messages (the reconcile probe asks for ONE)
    // gets a first page of that size — 1,300 rooms x 100 events an hour was pure
    // waste. Every later page is a full 100, and a small first page that held no
    // usable message never ends the search while the server offers more (a
    // redacted / body-less newest event, or a server that filters after paging).
    let limit = Math.min(100, Math.max(1, Math.floor(cap)));
    for (;;) {
      const qs = [
        "dir=b",
        `limit=${limit}`,
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
      const smallPage = limit < 100;
      if ((!chunk.length && !smallPage) || !page.end || page.end === from)
        return { messages: out.reverse(), capped: false };
      from = page.end;
      limit = 100;
    }
  }

  /** One backward page for the interactive thread, retaining source event IDs. */
  async messagePage(roomId: string, from?: string, limit = 50): Promise<{ chunk: MatrixEvent[]; start: string | null; end: string | null }> {
    const query = new URLSearchParams({ dir: "b", limit: String(Math.min(100, Math.max(1, limit))), filter: JSON.stringify({ types: ["m.room.message", "m.room.redaction"] }) });
    if (from) query.set("from", from);
    const page = await this.get(`/rooms/${encodeURIComponent(roomId)}/messages?${query}`) as { chunk?: MatrixEvent[]; start?: string; end?: string };
    return { chunk: Array.isArray(page.chunk) ? page.chunk.slice(0, 100) : [], start: typeof page.start === "string" ? page.start : null, end: typeof page.end === "string" ? page.end : null };
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

export interface MatrixEvent {
  type?: string;
  sender?: string;
  event_id?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
  state_key?: string;
  unsigned?: { redacted_because?: unknown };
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
    includeMetadata?: string[];
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
  /** Re-read one note: the body of a thread about to be written (the listing is
   *  lean), and the rollover's 409 retry. Optional only for test fakes whose
   *  listing still carries bodies. */
  getNote?(id: string): Promise<Note>;
}

/**
 * THE LEAN THREAD LISTING (2026-10-03 host stall). Every 60 s pass used to list
 * every `message-thread` note WITH its body — ~1,300 threads, up to 1 MB each —
 * pinning the single-threaded vault 1–2 s a tick. A pass now lists rows only:
 * no content, and exactly the metadata keys it reads from the LISTING:
 *   - `matrixRoomId`  the room → note map
 *   - `lastMessageAt` gap-fill lower bound + the reconcile comparison
 *   - `archiveOf`     never adopt an archive as a thread (`isArchiveNote`)
 * plus the row's own id / path / tags / updatedAt / `byteSize`. Everything a
 * WRITE needs (body, messageCount, participants, participantIds, the rest of the
 * metadata, tags) comes from `loadThread` — one fresh read of that one note,
 * immediately before its write. Never read a body or a write input off a row.
 */
export const THREAD_LIST_KEYS = ["matrixRoomId", "lastMessageAt", "archiveOf"];

function listThreadRows(vault: IngestVault): Promise<Note[]> {
  return vault.listNotes({ tags: ["message-thread"], includeContent: false, includeMetadata: THREAD_LIST_KEYS });
}

/**
 * The full, CURRENT note behind a listing row — the only place a thread body is
 * read. Called right before a write to that note (append, dedupe, rollover), so
 * the write is built on what the vault holds now, not on the pass's listing.
 */
async function loadThread(vault: IngestVault, row: Note): Promise<Note> {
  if (vault.getNote) {
    const note = await vault.getNote(row.id);
    if (!note || typeof note.content !== "string") throw new Error(`thread ${row.id} could not be read (no body)`);
    return note;
  }
  // A vault with no single-note read (test fakes): usable only if its listing
  // carried the body anyway. Never write on top of a body we do not have.
  if (typeof row.content === "string") return row;
  throw new Error(`thread ${row.id}: the listing is lean and this vault cannot re-read a note`);
}

/** Size of a thread from its listing row, in UTF-8 bytes: the vault's lean
 *  `byteSize` (0.7.x `NoteIndex`), else a body the listing carried anyway.
 *  null = this listing does not say. */
function rowBytes(row: Note): number | null {
  const b = (row as unknown as { byteSize?: unknown }).byteSize;
  if (typeof b === "number" && Number.isFinite(b)) return b;
  return typeof row.content === "string" && row.content !== "" ? byteLen(row.content) : null;
}

/** Sizes learned by reading a body, for vaults whose lean rows carry no `byteSize`:
 *  note id → the size at that `updatedAt` (one body read per version, at most). */
const probedSizes = new Map<string, { updatedAt: string; bytes: number }>();
/** Rotates which size-less rows a pass may probe, so none starves. */
let sizeProbeCursor = 0;
/** Body reads a pass may spend on rows whose size the listing does not give. */
export const SIZE_PROBES_PER_PASS = 10;

export function _resetThreadSizeCacheForTests(): void {
  probedSizes.clear();
  sizeProbeCursor = 0;
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
 * must have run on 0.6.1 first). Sizes come from the lean listing (`byteSize`);
 * a body is read only for a thread the listing says is oversized (and re-checked
 * on that fresh body). Rows with no size (a vault without `byteSize`) are probed
 * a few per pass, each at most once per `updatedAt`. Independently of this sweep,
 * `ingestRoom` measures the fresh body before every append and rolls over in
 * that same write. Updates `byRoom` in place.
 */
export async function sweepOversizedThreads(
  vault: IngestVault,
  byRoom: Map<string, Note>,
  opts: { maxPerPass?: number; maxSizeProbes?: number } = {},
): Promise<{ rolled: number; archives: number }> {
  const { maxBytes } = rolloverLimits();
  let rolled = 0;
  let archives = 0;
  const roll = async (roomId: string, row: Note, loaded?: Note): Promise<void> => {
    let note = loaded ?? row;
    try {
      note = loaded ?? (await loadThread(vault, row));
      if (byteLen(note.content ?? "") <= maxBytes) return; // the listing was stale
      const out = await rolloverThread(vault, note);
      if (!out) return;
      byRoom.set(roomId, out.note);
      if (out.note.updatedAt) probedSizes.set(row.id, { updatedAt: out.note.updatedAt, bytes: byteLen(out.note.content ?? "") });
      rolled++;
      archives += out.created;
      console.log(
        `[worker] matrix: rolled over ${note.path ?? note.id} (${byteLen(note.content ?? "")} bytes) → ${out.created} new archive note(s)${out.recovered ? `, ${out.recovered} already-archived message(s) trimmed` : ""}`,
      );
    } catch (e) {
      logRolloverFailure(note, e, rowBytes(row));
    }
  };
  const sizeless: Array<[string, Note]> = [];
  for (const [roomId, row] of byRoom) {
    if (rolled >= (opts.maxPerPass ?? 10)) break;
    let bytes = rowBytes(row);
    if (bytes === null) {
      const seen = probedSizes.get(row.id);
      if (seen && row.updatedAt && seen.updatedAt === row.updatedAt) bytes = seen.bytes;
      else {
        sizeless.push([roomId, row]);
        continue;
      }
    }
    if (bytes <= maxBytes) continue;
    await roll(roomId, row);
  }
  // Size-less rows: a bounded number of body reads per pass, rotating.
  const probes = Math.min(sizeless.length, opts.maxSizeProbes ?? SIZE_PROBES_PER_PASS);
  for (let i = 0; i < probes && rolled < (opts.maxPerPass ?? 10); i++) {
    const [roomId, row] = sizeless[(sizeProbeCursor + i) % sizeless.length]!;
    let note: Note;
    try {
      note = await loadThread(vault, row);
    } catch (e) {
      console.warn(`[worker] matrix: could not size ${row.path ?? row.id}: ${String(e)}`);
      continue;
    }
    const bytes = byteLen(note.content ?? "");
    if (note.updatedAt) probedSizes.set(row.id, { updatedAt: note.updatedAt, bytes });
    if (bytes > maxBytes) await roll(roomId, row, note);
  }
  if (sizeless.length) sizeProbeCursor = (sizeProbeCursor + probes) % sizeless.length;
  return { rolled, archives };
}

function logRolloverFailure(note: Note, e: unknown, listedBytes?: number | null): void {
  const size = typeof note.content === "string" && note.content !== "" ? byteLen(note.content) : (listedBytes ?? 0);
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
  /** Rooms whose messages from THIS pass may not all be in the vault (the write,
   *  the body read or the gap-fill failed) although the cursor advances. The caller
   *  must persist them with this pass's `since` and hand them back as `replay`. */
  failedRooms: string[];
  /** Outcome of `opts.replay`: rooms now complete / rooms that failed again. */
  replayed: { ok: string[]; failed: string[]; messages: number };
}

/** A room an earlier pass could not finish; `since` = that pass's cursor (absent: it had none). */
export interface RoomReplay {
  roomId: string;
  since?: string;
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
  opts: {
    platform: string;
    selfUserId?: string | null;
    /** false = MATRIX_LINK_EXISTING: never create a person. */
    allowCreate?: boolean;
    /** Never link this person (the owner's own note — it would become a hub of every thread). */
    skipPersonId?: string | null;
    /** DMs only: told about a counterpart that has a candidate but no exact match. */
    review?: (r: PersonReview) => void;
  },
): Promise<NoteLinkInput[]> {
  const ids = Object.keys(members);
  const allowCreate = opts.allowCreate !== false && ids.length <= MAX_MEMBERS_FOR_PERSON_CREATION;
  const out: NoteLinkInput[] = [];
  const seen = new Set<string>();
  for (const mid of ids) {
    if (isBridgeBot(mid) || mid === opts.selfUserId) continue;
    const name = members[mid] || mid;
    const r = await people
      .findOrCreate(vault, name, { matrixId: mid, platform: opts.platform, allowCreate, ...(opts.review && ids.length <= MAX_MEMBERS_FOR_PERSON_CREATION ? { review: opts.review } : {}) })
      .catch(() => null);
    if (r && r.id !== opts.skipPersonId && !seen.has(r.id)) {
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
        "join" | "pendingInvites" | "joinedRooms" | "leave" | "messagesBefore" | "joinedMembers" | "profileName" | "roomName"
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
    /** MATRIX_LINK_EXISTING: link participants who ALREADY have a person note; create nobody. */
    linkExisting?: boolean;
    /** MATRIX_STORE_PARTICIPANT_IDS: keep the members' stable Matrix ids on the thread note. */
    storeParticipantIds?: boolean;
    /** The sync user's mxid (never linked as a participant). */
    selfUserId?: string | null;
    /** The owner's own person note, resolved from the pass's people index (never linked). */
    ownerPersonId?: (people: PeopleIndex) => string | null;
    /** PEOPLE_QUEUE_ON_INGEST: collects unresolved DM counterparts; flushed with the thread's note id. */
    reviewSink?: { collect(roomId: string): (r: PersonReview) => void; flush(roomId: string, noteId: string | null | undefined): void };
    /** Rooms an EARLIER pass failed on (its `failedRooms`), replayed before this
     *  pass's own rooms: everything between that pass's cursor and this one's. */
    replay?: RoomReplay[];
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
  // Lean: rows only. A body is read by `loadThread`, for a note about to be written.
  const existing = await listThreadRows(vault);
  const byRoom = threadsByRoom(existing);
  await sweepOversizedThreads(vault, byRoom);

  // S2 — the no-drop layer under a failed room. A room that failed in an earlier
  // pass lost that pass's messages while the cursor moved on; once NEWER messages
  // land, `lastMessageAt` passes the lost ones and the reconcile sweep reads "not
  // behind". So before anything else, re-fetch exactly that window — the failed
  // pass's cursor up to this pass's — and append what the note does not hold.
  const replayed = { ok: [] as string[], failed: [] as string[], messages: 0 };
  for (const p of opts.replay ?? []) {
    try {
      if (!client.messagesBefore || !opts.since) throw new Error("no cursor to replay up to");
      const gap = await client.messagesBefore(p.roomId, { from: opts.since, ...(p.since ? { to: p.since } : {}) });
      if (gap.capped) console.warn(`[worker] matrix: replay of ${p.roomId} hit its cap — oldest messages of the window skipped`);
      if (gap.messages.length) {
        const members = client.joinedMembers ? await client.joinedMembers(p.roomId).catch(() => ({}) as Record<string, string>) : {};
        const rb: RoomBatch = {
          roomId: p.roomId,
          name: byRoom.has(p.roomId) || !client.roomName ? null : await client.roomName(p.roomId).catch(() => null),
          memberIds: Object.keys(members),
          displayNames: Object.fromEntries(Object.entries(members).filter(([, v]) => v)),
          messages: gap.messages,
        };
        await resolveDisplayNames(client, rb);
        // A thread created here must be the one this pass's own batch appends to.
        if (await ingestRoom(rb, vault, byRoom, { dedupe: true, onCreated: (n) => byRoom.set(p.roomId, n) })) replayed.messages += gap.messages.length;
      }
      replayed.ok.push(p.roomId);
    } catch (e) {
      replayed.failed.push(p.roomId);
      console.warn(`[worker] matrix: replay of ${p.roomId} failed (kept for the next pass): ${String(e)}`);
    }
  }
  if (replayed.ok.length) console.log(`[worker] matrix: replayed ${replayed.ok.length} room(s) an earlier pass failed on (+${replayed.messages} message(s) fetched)`);

  let messages = 0;
  let created = 0;
  let updated = 0;
  let processed = 0;
  let failed = 0;
  let gapFilled = 0;
  let peopleLinked = 0;
  const failedRooms = new Set<string>();
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
        // The tail is written below, which moves lastMessageAt past the gap.
        failedRooms.add(rb.roomId);
        console.warn(
          `[worker] matrix: gap-fill for ${rb.roomId} failed (tail only; the window is replayed next pass): ${String(e)}`,
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
    let memberIds: string[] | null = null;
    if ((opts.linkPeople || opts.linkExisting) && client.joinedMembers) {
      try {
        const members = await client.joinedMembers(rb.roomId);
        memberIds = Object.keys(members);
        people ??= await PeopleIndex.load(vault);
        links = await participantLinks(members, people, vault, {
          platform: detectPlatform(Object.keys(members)),
          selfUserId: opts.selfUserId,
          allowCreate: !!opts.linkPeople,
          skipPersonId: opts.ownerPersonId?.(people) ?? null,
          ...(opts.reviewSink ? { review: opts.reviewSink.collect(rb.roomId) } : {}),
        });
      } catch (e) {
        console.warn(`[worker] matrix: people for ${rb.roomId} skipped: ${String(e)}`);
      }
    }
    try {
      await ingestRoom(rb, vault, byRoom, { dedupe, links, ...(opts.storeParticipantIds ? { participantIds: memberIds ?? rb.memberIds } : {}) });
      peopleLinked += links.length;
      // A thread created this pass has no id here yet; its counterpart queues on the next append.
      opts.reviewSink?.flush(rb.roomId, byRoom.get(rb.roomId)?.id);
    } catch (e) {
      failed++;
      failedRooms.add(rb.roomId);
      console.warn(
        `[worker] matrix: room ${rb.roomId} (${rb.name ?? "?"}) failed (replayed next pass): ${String(e)}`,
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
    failedRooms: [...failedRooms],
    replayed,
  };
}

const isConflict = (e: unknown): boolean => (e as { status?: number })?.status === 409 || /\b409\b/.test(String(e));

/** Lines AND whole message entries of a thread body (a multi-line message is one entry). */
function linesAndEntries(content: string): Set<string> {
  return new Set([...content.split("\n"), ...parseThread(content).entries]);
}

/**
 * After a 409: which of `lines` did SOMEONE ELSE already put in the note since we
 * read it? Identity is the formatted entry (stamp + sender + body) — the note does
 * not store event ids. When the fresh body is our copy plus an appended tail, each
 * tail entry cancels ONE of ours (so two genuinely identical messages still land
 * twice); otherwise (trimmed by a rollover, edited) anything the body holds is dropped.
 */
function notYetWritten(lines: string[], loaded: Note, fresh: Note): string[] {
  const before = (loaded.content ?? "").trimEnd();
  const now = fresh.content ?? "";
  if (now.startsWith(before)) {
    const tail = new Map<string, number>();
    for (const e of parseThread(now.slice(before.length)).entries) tail.set(e, (tail.get(e) ?? 0) + 1);
    return lines.filter((l) => {
      const n = tail.get(l) ?? 0;
      if (n > 0) tail.set(l, n - 1);
      return n === 0;
    });
  }
  const have = linesAndEntries(now);
  return lines.filter((l) => !have.has(l));
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

/** Union of stored + current Matrix ids (unioned like `participants`: /sync carries deltas). */
const mergeIds = (prev: unknown, now: string[]): string[] => [
  ...new Set([...(Array.isArray(prev) ? prev.filter((x): x is string => typeof x === "string") : []), ...now]),
];

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
  opts: {
    dedupe?: boolean;
    links?: NoteLinkInput[];
    /** Stable member ids to keep on the note (MATRIX_STORE_PARTICIPANT_IDS). */
    participantIds?: string[];
    /** Told the thread note this call created (the replay keeps the room → note map current). */
    onCreated?: (n: Note) => void;
  } = {},
): Promise<boolean> {
  const linkAdd = opts.links?.length ? { links: { add: opts.links } } : {};
  const platform = detectPlatform(rb.memberIds);
  let lines = rb.messages.map((m) => formatLine(m, rb.displayNames));
  if (!lines.length) return false;
  // The listing row carries no body: read the note NOW, once, and build the
  // dedupe, the append, the metadata merge and any rollover on that fresh copy.
  const row = byRoom.get(rb.roomId);
  let note = row ? await loadThread(vault, row) : undefined;
  if (opts.dedupe) {
    const have = linesAndEntries(note?.content ?? "");
    lines = lines.filter((l) => !have.has(l));
  }
  if (!lines.length) return false;
  const lastMessageAt = Math.max(...rb.messages.map((m) => m.ts));
  const participants = rb.memberIds.map(
    (id) => rb.displayNames[id] ?? shortSender(id),
  );
  if (note && row) {
    // The append is COMPARE-AND-SET on the copy just read. Reading the body right
    // before the write made a second writer visible (a listing-time body used to
    // make an overlapping pass rewrite the same text; a fresh one would append the
    // same events again), so: on a 409, re-read, drop what is already there,
    // recount, and try ONCE more. A second 409 fails the room for this pass (it is
    // replayed by the next one).
    const wanted = lines;
    for (let attempt = 0; ; attempt++) {
      try {
        await appendToThread(rb, vault, byRoom, note, lines, { platform, lastMessageAt, participants, linkAdd, participantIds: opts.participantIds });
        break;
      } catch (e) {
        if (!isConflict(e) || attempt >= 1) throw e;
        const fresh = await loadThread(vault, row);
        lines = notYetWritten(wanted, note, fresh);
        note = fresh;
        if (!lines.length) return false; // someone else already wrote every one of them
      }
    }
    const stale = TRIAGE_TAGS.filter((t) => note!.tags?.includes(t));
    if (stale.length && vault.removeTags) {
      const id = note.id;
      await vault
        .removeTags(id, stale)
        .catch((e) =>
          console.warn(
            `[worker] matrix: could not clear triage tags on ${id}: ${String(e)}`,
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
        ...(opts.participantIds ? { participantIds: mergeIds(undefined, opts.participantIds) } : {}),
      },
      ...(opts.links?.length ? { links: opts.links } : {}),
    };
    // WP0.6: a same-named room's thread already at `base` (several "Unknown user
    // (WA)" DMs, say) is known from the listing — take the room-id path up front
    // instead of eating a 409 first. The catch below stays as the race backstop.
    const taken = [...byRoom.values()].some((n) => n.path === base);
    let made: Note;
    try {
      made = await vault.createNote({ ...params, path: taken ? `${base}-${roomSlug(rb.roomId)}` : base });
    } catch (e) {
      // 409 = a note already lives at that path (another room with the same
      // name — several "Unknown user (WA)" DMs, say). Disambiguate by room id.
      if (!/409/.test(String(e)) || taken) throw e;
      made = await vault.createNote({
        ...params,
        path: `${base}-${roomSlug(rb.roomId)}`,
      });
    }
    if (made?.id) opts.onCreated?.({ ...made, path: made.path ?? null, tags: made.tags ?? params.tags, metadata: made.metadata ?? params.metadata });
  }
  return true;
}

/** One attempt at appending `lines` to `note` (the copy just read): metadata merge,
 *  then a plain compare-and-set write — or, past the size limit, the rollover write. */
async function appendToThread(
  rb: RoomBatch,
  vault: IngestVault,
  byRoom: Map<string, Note>,
  note: Note,
  lines: string[],
  ctx: { platform: string; lastMessageAt: number; participants: string[]; linkAdd: { links?: { add: NoteLinkInput[] } }; participantIds?: string[] },
): Promise<void> {
  const { platform, lastMessageAt, participants, linkAdd } = ctx;
  const cas = note.updatedAt ? { ifUpdatedAt: note.updatedAt } : {};
  const prev = note.metadata ?? {};
  const prevCount = typeof prev.messageCount === "number" ? prev.messageCount : 0;
  // Incremental /sync only carries member DELTAS — union with the stored list
  // (which the desktop seeded from full room state) rather than replacing it.
  const prevParticipants = Array.isArray(prev.participants) ? (prev.participants as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const mergedParticipants = [...new Set([...prevParticipants, ...participants])];
  const metadata = {
    ...prev,
    type: "message-thread",
    platform,
    matrixRoomId: rb.roomId,
    // Monotonic: a bridge backfilling a gap posts OLD timestamps late, and
    // must not rewind the high-water mark the repair sweep compares against.
    lastMessageAt: Math.max(lastMessageAt, lastMessageAtOf(note)),
    messageCount: prevCount + lines.length,
    ...(mergedParticipants.length ? { participants: mergedParticipants } : {}),
    ...(ctx.participantIds ? { participantIds: mergeIds(prev.participantIds, ctx.participantIds) } : {}),
  };
  const content = `${note.content.trimEnd()}\n${lines.join("\n")}`;
  // Past the size limit, append + archive the oldest messages in ONE live
  // write (archives first — see matrix-rollover.ts). `noRetry`: a 409 comes back
  // here so the caller re-reads and recounts instead of re-appending blindly.
  const rolled =
    byteLen(content) > rolloverLimits().maxBytes
      ? await rolloverThread(vault, note, { appendEntries: lines, metadata, noRetry: true }).catch((e) => {
          if (!isConflict(e)) logRolloverFailure(note, e);
          throw e;
        })
      : null;
  if (rolled) {
    byRoom.set(rb.roomId, rolled.note);
    return;
  }
  try {
    await vault.updateNote(note.id, { content, metadata, ...cas, ...linkAdd });
  } catch (e) {
    if (!isTooLarge(e)) throw e;
    // The vault refused the write as too large (history_overflow on ≥0.7.9).
    // Say so loudly, then try to shed the oldest messages in the same write.
    console.error(
      `[worker] matrix: ERROR vault refused append to ${note.path ?? note.id} for room ${rb.roomId} (${byteLen(content)} bytes, 413) — attempting rollover`,
    );
    const out = await rolloverThread(vault, note, { appendEntries: lines, metadata, force: true, noRetry: true }).catch((re) => {
      if (!isConflict(re)) logRolloverFailure(note, re);
      throw re;
    });
    if (!out) throw e;
    byRoom.set(rb.roomId, out.note);
  }
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
  // Lean: rows only. A body is read by `loadThread`, for a note about to be written.
  const existing = await listThreadRows(vault);
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
