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
        timeline?: { events?: MatrixEvent[] };
      }
    >;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
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
      if (
        e.type === "m.room.message" &&
        typeof e.content?.body === "string" &&
        e.content.body.trim()
      ) {
        messages.push({
          sender: e.sender ?? "?",
          body: e.content.body as string,
          ts: e.origin_server_ts ?? 0,
          eventId: e.event_id ?? "",
        });
      }
    }
    rooms.push({
      roomId,
      name,
      memberIds: [...memberIds],
      displayNames,
      messages,
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
 * Tags that mark a thread as already classified by the hourly triage skill.
 * A thread note is updated IN PLACE as messages arrive, so an old verdict would
 * otherwise stick forever — strip them on append so the next run re-triages.
 */
export const TRIAGE_TAGS = [
  "triaged",
  "urgent",
  "action-required",
  "informational",
  "low",
];

/** The minimal vault surface the ingester needs (so tests inject a fake). */
export interface IngestVault {
  listNotes(opts: {
    tags?: string[];
    includeContent?: boolean;
  }): Promise<Note[]>;
  createNote(p: {
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): Promise<Note>;
  updateNote(
    id: string,
    p: { content?: string; metadata?: Record<string, unknown> },
  ): Promise<Note>;
  /** Optional: strip tags (used to clear stale triage verdicts on append). */
  removeTags?(id: string, tags: string[]): Promise<void>;
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
}

/**
 * Ingest one sync pass into the vault: upsert a message-thread note per room
 * with new messages (matched by metadata.matrixRoomId). Returns counts + the
 * nextBatch to persist for the next incremental pass.
 */
export async function ingestMatrix(
  client: Pick<MatrixClient, "sync"> &
    Partial<Pick<MatrixClient, "join" | "pendingInvites" | "joinedRooms" | "leave">>,
  vault: IngestVault,
  opts: {
    since?: string;
    maxRooms?: number;
    autoJoin?: boolean;
    maxJoinsPerRun?: number;
    probeInvites?: boolean;
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
  const byRoom = new Map<string, Note>();
  for (const n of existing) {
    const rid = n.metadata?.matrixRoomId;
    if (typeof rid === "string") byRoom.set(rid, n);
  }

  let messages = 0;
  let created = 0;
  let updated = 0;
  let processed = 0;
  let failed = 0;
  for (const rb of rooms) {
    if (!rb.messages.length) continue;
    if (opts.maxRooms && processed >= opts.maxRooms) break;
    processed++;
    messages += rb.messages.length;
    // One bad room must not abort the pass: the cursor still advances past the
    // others, and the failure is named instead of surfacing as a source-wide DOWN.
    try {
      await ingestRoom(rb, vault, byRoom);
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
  return {
    rooms: processed,
    messages,
    created,
    updated,
    nextBatch,
    invitesPending: invites.length,
    joined,
  };
}

/** Short stable suffix so two rooms with the same display name get distinct paths. */
const roomSlug = (roomId: string): string =>
  roomId.replace(/^!/, "").replace(/:.*$/, "").slice(0, 8).toLowerCase();

async function ingestRoom(
  rb: RoomBatch,
  vault: IngestVault,
  byRoom: Map<string, Note>,
): Promise<void> {
  const platform = detectPlatform(rb.memberIds);
  const lines = rb.messages.map((m) => formatLine(m, rb.displayNames));
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
    await vault.updateNote(note.id, {
      content: `${note.content.trimEnd()}\n${lines.join("\n")}`,
      metadata: {
        ...prev,
        type: "message-thread",
        platform,
        matrixRoomId: rb.roomId,
        lastMessageAt,
        messageCount: prevCount + lines.length,
        ...(mergedParticipants.length
          ? { participants: mergedParticipants }
          : {}),
      },
    });
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
    };
    try {
      await vault.createNote({ ...params, path: base });
    } catch (e) {
      // 409 = a note already lives at that path (another room with the same
      // name — several "Unknown user (WA)" DMs, say). Disambiguate by room id.
      if (!/409/.test(String(e))) throw e;
      await vault.createNote({
        ...params,
        path: `${base}-${roomSlug(rb.roomId)}`,
      });
    }
  }
}
