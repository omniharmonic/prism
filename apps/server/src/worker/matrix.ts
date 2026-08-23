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
    const r = await this.fetchImpl(this.url(path), { headers: { Authorization: `Bearer ${this.creds.accessToken}` } });
    if (!r.ok) throw new Error(`matrix ${path} → ${r.status}`);
    return r.json();
  }

  /** Confirm the token; returns the user id. */
  async whoami(): Promise<string> {
    return (await this.get("/account/whoami") as { user_id: string }).user_id;
  }

  /**
   * One /sync pass. Parses, per joined room, the room name + joined member ids +
   * the recent m.room.message events — all from the sync payload (no per-room
   * /state calls). `since` resumes from a prior nextBatch (incremental).
   */
  async sync(since?: string, timeoutMs = 0): Promise<SyncResult> {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 30 } } }));
    const qs = [`filter=${filter}`, `timeout=${timeoutMs}`, since ? `since=${encodeURIComponent(since)}` : ""]
      .filter(Boolean)
      .join("&");
    const data = (await this.get(`/sync?${qs}`)) as MatrixSyncResponse;
    return parseSync(data);
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
  rooms?: { join?: Record<string, { state?: { events?: MatrixEvent[] }; timeline?: { events?: MatrixEvent[] } }> };
}

/** Parse a raw /sync response into per-room name + members + messages. */
export function parseSync(data: MatrixSyncResponse): SyncResult {
  const rooms: RoomBatch[] = [];
  const joined = data.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(joined)) {
    const events = [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])];
    let name: string | null = null;
    const memberIds = new Set<string>();
    const displayNames: Record<string, string> = {};
    const messages: MatrixMessage[] = [];
    for (const e of events) {
      if (e.type === "m.room.name" && typeof e.content?.name === "string") name = e.content.name;
      if (e.type === "m.room.member" && e.content?.membership === "join" && e.state_key) {
        memberIds.add(e.state_key);
        if (typeof e.content.displayname === "string" && e.content.displayname.trim()) displayNames[e.state_key] = e.content.displayname.trim();
      }
      if (e.type === "m.room.message" && typeof e.content?.body === "string" && e.content.body.trim()) {
        messages.push({
          sender: e.sender ?? "?",
          body: e.content.body as string,
          ts: e.origin_server_ts ?? 0,
          eventId: e.event_id ?? "",
        });
      }
    }
    rooms.push({ roomId, name, memberIds: [...memberIds], displayNames, messages });
  }
  return { nextBatch: data.next_batch ?? "", rooms };
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
  for (const id of memberIds) for (const [re, name] of prefixes) if (re.test(id)) return name;
  return "matrix";
}

const sanitizePath = (s: string): string =>
  (s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

const shortSender = (id: string): string => id.replace(/^@/, "").replace(/:.+$/, "").replace(/^(whatsapp|telegram|signal|discord|instagram|messenger|twitter)_/i, "");

/** `[YYYY-MM-DD HH:MM]` in UTC — the desktop message_sync format, so readers can date every line. */
export const formatStamp = (ts: number): string => {
  const d = new Date(ts);
  if (!ts || Number.isNaN(d.getTime())) return "[unknown]";
  return `[${d.toISOString().slice(0, 16).replace("T", " ")}]`;
};

/** One transcript line: `[2026-08-23 20:12] Display Name: body` (falls back to the short sender id). */
export function formatLine(m: MatrixMessage, displayNames: Record<string, string> = {}): string {
  const who = displayNames[m.sender] ?? shortSender(m.sender);
  return `${formatStamp(m.ts)} ${who}: ${m.body}`;
}

/**
 * Tags that mark a thread as already classified by the hourly triage skill.
 * A thread note is updated IN PLACE as messages arrive, so an old verdict would
 * otherwise stick forever — strip them on append so the next run re-triages.
 */
export const TRIAGE_TAGS = ["triaged", "urgent", "action-required", "informational", "low"];

/** The minimal vault surface the ingester needs (so tests inject a fake). */
export interface IngestVault {
  listNotes(opts: { tags?: string[]; includeContent?: boolean }): Promise<Note[]>;
  createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note>;
  updateNote(id: string, p: { content?: string; metadata?: Record<string, unknown> }): Promise<Note>;
  /** Optional: strip tags (used to clear stale triage verdicts on append). */
  removeTags?(id: string, tags: string[]): Promise<void>;
}

export interface IngestResult {
  rooms: number;
  messages: number;
  created: number;
  updated: number;
  nextBatch: string;
}

/**
 * Ingest one sync pass into the vault: upsert a message-thread note per room
 * with new messages (matched by metadata.matrixRoomId). Returns counts + the
 * nextBatch to persist for the next incremental pass.
 */
export async function ingestMatrix(
  client: Pick<MatrixClient, "sync">,
  vault: IngestVault,
  opts: { since?: string; maxRooms?: number } = {},
): Promise<IngestResult> {
  const { nextBatch, rooms } = await client.sync(opts.since);
  const existing = await vault.listNotes({ tags: ["message-thread"], includeContent: true });
  const byRoom = new Map<string, Note>();
  for (const n of existing) {
    const rid = n.metadata?.matrixRoomId;
    if (typeof rid === "string") byRoom.set(rid, n);
  }

  let messages = 0;
  let created = 0;
  let updated = 0;
  let processed = 0;
  for (const rb of rooms) {
    if (!rb.messages.length) continue;
    if (opts.maxRooms && processed >= opts.maxRooms) break;
    processed++;
    messages += rb.messages.length;

    const platform = detectPlatform(rb.memberIds);
    const lines = rb.messages.map((m) => formatLine(m, rb.displayNames));
    const lastMessageAt = Math.max(...rb.messages.map((m) => m.ts));
    const participants = rb.memberIds.map((id) => rb.displayNames[id] ?? shortSender(id));
    const note = byRoom.get(rb.roomId);
    if (note) {
      const prev = note.metadata ?? {};
      const prevCount = typeof prev.messageCount === "number" ? prev.messageCount : 0;
      // Keep the desktop's participant list if this sync pass carried no member state.
      const mergedParticipants = participants.length ? participants : prev.participants;
      await vault.updateNote(note.id, {
        content: `${note.content.trimEnd()}\n${lines.join("\n")}`,
        metadata: {
          ...prev,
          type: "message-thread",
          platform,
          matrixRoomId: rb.roomId,
          lastMessageAt,
          messageCount: prevCount + lines.length,
          ...(mergedParticipants ? { participants: mergedParticipants } : {}),
        },
      });
      const stale = TRIAGE_TAGS.filter((t) => note.tags?.includes(t));
      if (stale.length && vault.removeTags) {
        await vault.removeTags(note.id, stale).catch((e) => console.warn(`[worker] matrix: could not clear triage tags on ${note.id}: ${String(e)}`));
      }
      updated++;
    } else {
      const name = rb.name ?? rb.roomId;
      await vault.createNote({
        content: `# ${name} — ${platform}\n\n${lines.join("\n")}`,
        path: `vault/messages/${platform}/${sanitizePath(name)}`,
        tags: ["message-thread"],
        metadata: { type: "message-thread", platform, matrixRoomId: rb.roomId, lastMessageAt, messageCount: lines.length, participants },
      });
      created++;
    }
  }
  return { rooms: processed, messages, created, updated, nextBatch };
}
