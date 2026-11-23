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
 *   metadata: { type:"message-thread", platform, matrixRoomId, lastMessageAt, title }
 *   (`title` = the human name by the Comms precedence, resolveThreadIdentity).
 */
import type { Note } from "../parachute";
import { byteLen, isArchiveNote, isTooLarge, parseThread, rolloverLimits, rolloverThread } from "./matrix-rollover";
import { PeopleIndex, type PersonReview } from "./people";
import type { IfExists, NoteLinkInput } from "../parachute";
import type { LiveBatch } from "../comms/bus";
import { config } from "../config";
import { looksLikeId, resolveTitle } from "../comms/naming";
import { bridgeProtocolId, roomMetaFromState } from "../comms/room-meta";
import { titleOf } from "./people";

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
  /** The RAW timeline events of this room (every type, as /sync sent them) — for the Comms live
   *  bus only (Task 11). The vault writer never reads them: it writes `messages`. */
  events?: MatrixEvent[];
  /** The room's m.receipt EDUs (COMMS_RECEIPTS_ENABLED only) — for the Comms live bus. */
  receipts?: MatrixEvent[];
}
export interface SyncResult {
  nextBatch: string;
  rooms: RoomBatch[];
  /** Rooms the user is INVITED to but has not joined (their timeline is not in /sync). */
  invites: Array<{ roomId: string; name: string | null }>;
}

type FetchLike = typeof fetch;

/** Request deadlines the Comms send ledger derives its "still running" window from. */
export const MATRIX_UPLOAD_TIMEOUT_MS = 120_000;
export const MATRIX_SEND_EVENT_TIMEOUT_MS = 30_000;

/** Minimal Matrix client — the read paths message ingest needs. */
/** What the Comms timeline reads (normalize.ts relationOf + base types). */
export const TIMELINE_EVENT_TYPES = [
  "m.room.message", "m.room.redaction", "m.reaction", "com.beeper.message_send_status", "m.sticker",
  "m.room.member", "m.room.name", "m.room.topic", "m.room.avatar", "m.room.encrypted",
] as const;

export class MatrixClient {
  constructor(
    private creds: MatrixCreds,
    private fetchImpl: FetchLike = fetch,
    private readTimeoutMs?: number,
  ) {}

  private url(path: string): string {
    return `${this.creds.homeserver.replace(/\/+$/, "")}/_matrix/client/v3${path}`;
  }
  /** Every request of the ingest client is bounded by `readTimeoutMs` (reads AND the
   *  join / leave / management-room send): one that never answers must not hold a pass. */
  private bounded(atLeastMs = 0): { signal?: AbortSignal } {
    return this.readTimeoutMs ? { signal: AbortSignal.timeout(Math.max(this.readTimeoutMs, atLeastMs)) } : {};
  }
  private async get(path: string, atLeastMs = 0): Promise<unknown> {
    const r = await this.fetchImpl(this.url(path), {
      headers: { Authorization: `Bearer ${this.creds.accessToken}` },
      ...this.bounded(atLeastMs),
    });
    if (!r.ok) throw new Error(`matrix ${path} → ${r.status}`);
    return r.json();
  }

  /** Confirm the token; returns the user id. */
  async whoami(): Promise<string> {
    return ((await this.get("/account/whoami")) as { user_id: string }).user_id;
  }

  /** whoami with the token's device id (null for a device-less token: admin-minted /
   *  appservice — Synapse then dedupes txn ids only in memory, ~30 min). */
  async whoamiInfo(): Promise<{ userId: string; deviceId: string | null }> {
    const j = (await this.get("/account/whoami")) as { user_id: string; device_id?: unknown };
    return { userId: j.user_id, deviceId: typeof j.device_id === "string" && j.device_id ? j.device_id : null };
  }

  /** Is the room end-to-end encrypted (an m.room.encryption state event)? 404 → false. */
  async roomEncrypted(roomId: string): Promise<boolean> {
    const r = await this.fetchImpl(this.url(`/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`), {
      headers: { Authorization: `Bearer ${this.creds.accessToken}` },
      ...this.bounded(),
    });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`matrix encryption state → ${r.status}`);
    const j = (await r.json().catch(() => ({}))) as { algorithm?: unknown };
    return typeof j.algorithm === "string" && j.algorithm.length > 0;
  }

  /**
   * One /sync pass. Parses, per joined room, the room name + joined member ids +
   * the recent m.room.message events — all from the sync payload (no per-room
   * /state calls). `since` resumes from a prior nextBatch (incremental).
   */
  async sync(since?: string, timeoutMs = 0): Promise<SyncResult> {
    // A long-poll (timeoutMs > 0, COMMS_SYNC_LONGPOLL) must only wake for what a pass uses —
    // timeline + state (+ invites): typing, receipts, presence and account data would answer
    // it at once, all day. timeoutMs = 0 keeps the filter exactly as before.
    const filter = encodeURIComponent(
      JSON.stringify(
        timeoutMs > 0
          ? {
              // COMMS_RECEIPTS_ENABLED (Task 8): read receipts only — never typing.
              room: { timeline: { limit: 30 }, ephemeral: { types: config.commsReceiptsEnabled ? ["m.receipt"] : [] }, account_data: { types: [] } },
              presence: { types: [] },
              account_data: { types: [] },
            }
          : { room: { timeline: { limit: 30 } } },
      ),
    );
    const qs = [
      `filter=${filter}`,
      `timeout=${timeoutMs}`,
      since ? `since=${encodeURIComponent(since)}` : "",
    ]
      .filter(Boolean)
      .join("&");
    // A long-poll (COMMS_SYNC_LONGPOLL) holds the request open for `timeoutMs`: the read bound
    // must outlast it. timeoutMs = 0 keeps exactly the old bound.
    const data = (await this.get(`/sync?${qs}`, timeoutMs > 0 ? timeoutMs + 30_000 : 0)) as MatrixSyncResponse;
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
    return this.backwardPage(roomId, from, limit, ["m.room.message", "m.room.redaction"]);
  }

  /** One backward page for the Comms timeline: every event type the normalizer folds
   *  (reactions, send status, stickers, state lines, undecryptable events). */
  async timelinePage(roomId: string, from?: string, limit = 50, types: readonly string[] = TIMELINE_EVENT_TYPES): Promise<{ chunk: MatrixEvent[]; start: string | null; end: string | null }> {
    return this.backwardPage(roomId, from, limit, types);
  }

  private async backwardPage(roomId: string, from: string | undefined, limit: number, types: readonly string[]): Promise<{ chunk: MatrixEvent[]; start: string | null; end: string | null }> {
    const query = new URLSearchParams({ dir: "b", limit: String(Math.min(100, Math.max(1, limit))), filter: JSON.stringify({ types }) });
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

  /** Full room state (GET /rooms/{id}/state): bridge, room-type, features, name, avatar events. */
  async roomState(roomId: string): Promise<MatrixEvent[]> {
    const r = await this.get(`/rooms/${encodeURIComponent(roomId)}/state`);
    return Array.isArray(r) ? (r as unknown[]).filter((e): e is MatrixEvent => !!e && typeof e === "object" && !Array.isArray(e)) : [];
  }

  /** Joined member id → displayname + avatar mxc (null when unset). */
  async memberProfiles(roomId: string): Promise<Record<string, { name: string | null; avatar: string | null }>> {
    const r = (await this.get(
      `/rooms/${encodeURIComponent(roomId)}/joined_members`,
    )) as { joined?: Record<string, { display_name?: string | null; avatar_url?: string | null }> };
    const out: Record<string, { name: string | null; avatar: string | null }> = {};
    for (const [id, v] of Object.entries(r.joined ?? {}))
      out[id] = { name: v.display_name?.trim() || null, avatar: v.avatar_url || null };
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
        ...this.bounded(),
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
        ...this.bounded(),
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
        signal: AbortSignal.timeout(MATRIX_SEND_EVENT_TIMEOUT_MS),
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

  /**
   * Comms read receipt (D10): `POST /rooms/{room}/receipt/m.read/{event}`. Called ONLY by
   * comms/read-state.ts maybeSendReceipt, behind the server flag + the owner's toggle.
   */
  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    const r = await this.fetchImpl(
      this.url(`/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.creds.accessToken}`, "Content-Type": "application/json" },
        body: "{}",
        ...this.bounded(),
      },
    );
    if (!r.ok) throw new Error(`matrix receipt → ${r.status}`);
  }

  /**
   * Upload bytes to the homeserver's media repository (Comms send). Returns the
   * mxc:// content URI. Media upload is not a send: an orphaned upload reaches
   * nobody, so every failure here is "nothing was sent". `filename` is passed as
   * the query parameter only (never a header).
   */
  async uploadMedia(bytes: Uint8Array, contentType: string, filename: string): Promise<string> {
    const base = `${this.creds.homeserver.replace(/\/+$/, "")}/_matrix/media/v3/upload`;
    const r = await this.fetchImpl(`${base}?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.creds.accessToken}`, "Content-Type": contentType },
      body: bytes,
      redirect: "manual",
      signal: AbortSignal.timeout(MATRIX_UPLOAD_TIMEOUT_MS),
    });
    if (!r.ok) {
      const err = new Error(`matrix upload → ${r.status}`) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    const j = (await r.json().catch(() => ({}))) as { content_uri?: unknown };
    if (typeof j.content_uri !== "string" || !parseMxc(j.content_uri)) throw new Error("matrix upload: no content_uri");
    return j.content_uri;
  }

  /** The homeserver's upload limit (`m.upload.size`, bytes), or null when it declares none.
   *  Authenticated media config (MSC3916) first, the legacy path as a fallback. */
  async mediaConfig(): Promise<number | null> {
    const hs = this.creds.homeserver.replace(/\/+$/, "");
    for (const path of ["/_matrix/client/v1/media/config", "/_matrix/media/v3/config"]) {
      const r = await this.fetchImpl(`${hs}${path}`, {
        headers: { Authorization: `Bearer ${this.creds.accessToken}` },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      if (!r?.ok) continue;
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      const n = j["m.upload.size"];
      return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }
    throw new Error("matrix media config unavailable");
  }

  /** Does `eventId` exist in `roomId` (visible to this account)? 404 → false; other failures throw. */
  async eventExists(roomId: string, eventId: string): Promise<boolean> {
    const r = await this.fetchImpl(this.url(`/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`), {
      headers: { Authorization: `Bearer ${this.creds.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`matrix event → ${r.status}`);
    return true;
  }

  /**
   * The m.reaction annotations on `eventId` in `roomId` (Matrix v1.x relations API), newest
   * first, at most `maxPages` × 100. Redacted reactions are not returned by the homeserver.
   */
  async reactionsTo(roomId: string, eventId: string, maxPages = 5): Promise<Array<{ eventId: string; sender: string; key: string }>> {
    const base = `${this.creds.homeserver.replace(/\/+$/, "")}/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}/m.annotation/m.reaction`;
    const out: Array<{ eventId: string; sender: string; key: string }> = [];
    let from: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.fetchImpl(`${base}?limit=100${from ? `&from=${encodeURIComponent(from)}` : ""}`, {
        headers: { Authorization: `Bearer ${this.creds.accessToken}` },
        redirect: "manual",
        ...this.bounded(),
      });
      if (!r.ok) {
        const err = new Error(`matrix relations → ${r.status}`) as Error & { status?: number };
        err.status = r.status;
        throw err;
      }
      const j = (await r.json().catch(() => ({}))) as { chunk?: MatrixEvent[]; next_batch?: unknown };
      for (const e of j.chunk ?? []) {
        const rel = (e?.content as Record<string, unknown> | undefined)?.["m.relates_to"] as Record<string, unknown> | undefined;
        if (e?.type === "m.reaction" && typeof e.event_id === "string" && typeof e.sender === "string" && rel?.rel_type === "m.annotation" && rel.event_id === eventId && typeof rel.key === "string") {
          out.push({ eventId: e.event_id, sender: e.sender, key: rel.key });
        }
      }
      from = typeof j.next_batch === "string" && j.next_batch ? j.next_batch : null;
      if (!from) break;
    }
    return out;
  }

  /** Redact one event with a caller-chosen txn id (deduped by the homeserver). */
  async redactEvent(roomId: string, eventId: string, txnId: string): Promise<string> {
    const r = await this.fetchImpl(this.url(`/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`), {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.creds.accessToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(MATRIX_SEND_EVENT_TIMEOUT_MS),
    });
    if (!r.ok) {
      const err = new Error(`matrix redact → ${r.status}`) as Error & { status?: number };
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
      ...this.bounded(),
    });
    if (!r.ok) throw new Error(`matrix leave ${roomId} → ${r.status}`);
  }

  /**
   * Fetch one piece of media through AUTHENTICATED media (MSC3916,
   * `/_matrix/client/v1/media/…`) with the bearer token. The mxc is validated
   * strictly and both segments are encoded, so it can never steer the request
   * off the homeserver's media paths. Redirects are NOT followed (`manual`): a
   * 3xx comes back as-is and the caller treats it as an upstream failure, so the
   * bearer never reaches another host. The caller owns the body (stream it).
   */
  async downloadMedia(
    mxc: string,
    opts: { thumb?: { w: number; h: number }; range?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const parsed = parseMxc(mxc);
    if (!parsed) throw new Error("matrix media: invalid mxc");
    const base = `${this.creds.homeserver.replace(/\/+$/, "")}/_matrix/client/v1/media`;
    const where = `${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`;
    const url = opts.thumb
      ? `${base}/thumbnail/${where}?width=${Math.trunc(opts.thumb.w)}&height=${Math.trunc(opts.thumb.h)}&method=scale`
      : `${base}/download/${where}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.creds.accessToken}` };
    if (opts.range) headers.Range = opts.range;
    const signal = opts.signal ?? this.bounded().signal;
    return this.fetchImpl(url, { headers, redirect: "manual", ...(signal ? { signal } : {}) });
  }
}

/** Strict mxc:// parse: `mxc://<server name>/<media id>`, nothing else. */
const MXC_RE = /^mxc:\/\/([A-Za-z0-9.\-:\[\]]+)\/([A-Za-z0-9_\-]+)$/;
export function parseMxc(mxc: unknown): { server: string; mediaId: string } | null {
  if (typeof mxc !== "string" || mxc.length > 512) return null;
  const m = MXC_RE.exec(mxc);
  if (!m || m[1]!.length > 255 || m[2]!.length > 255) return null;
  return { server: m[1]!, mediaId: m[2]! };
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
        ephemeral?: { events?: MatrixEvent[] };
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
/** The m.receipt EDUs of a room's ephemeral block (Task 8), only with COMMS_RECEIPTS_ENABLED. */
function receiptsOf(events: MatrixEvent[] | undefined): MatrixEvent[] | null {
  if (!config.commsReceiptsEnabled || !Array.isArray(events)) return null;
  const r = events.filter((e) => e && typeof e === "object" && e.type === "m.receipt" && e.content && typeof e.content === "object");
  return r.length ? r : null;
}

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
      events: room.timeline?.events ?? [],
      ...(receiptsOf(room.ephemeral?.events) ? { receipts: receiptsOf(room.ephemeral?.events)! } : {}),
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
    [/^@slack_/i, "slack"], // mautrix-slack: slack_<team>-<user>, lowercased
    [/^@linkedin_/i, "linkedin"], // mautrix-linkedin (bridgev2): linkedin_<id>, bot @linkedinbot
  ];
  for (const id of memberIds)
    for (const [re, name] of prefixes) if (re.test(id)) return name;
  return "matrix";
}

/**
 * The platform a thread note keeps when a batch is appended (e2e O3). `detected` comes from
 * the batch's member ids, which on an incremental /sync are DELTAS — often only the owner and
 * the bridge bot — so it reads "matrix" for a WhatsApp chat. A specific detection wins; a
 * plain "matrix" never replaces a specific platform the note already has.
 */
export function keepPlatform(stored: unknown, detected: string): string {
  if (detected !== "matrix") return detected;
  return typeof stored === "string" && stored && stored !== "matrix" ? stored : detected;
}

/** m.bridge protocol ids in this module's platform vocabulary (detectPlatform's names). */
const PROTOCOL_PLATFORM: Record<string, string> = {
  whatsapp: "whatsapp", telegram: "telegram", signal: "signal", discord: "discord", instagram: "instagram",
  messenger: "messenger", facebook: "messenger", meta: "messenger", twitter: "twitter", x: "twitter",
  slack: "slack", linkedin: "linkedin",
};

/** What a thread note is called, and the platform its bridge state names (null = no m.bridge). */
export interface ThreadIdentity {
  title: string;
  platform: string | null;
}

/** Who must never name a thread: the owner (and the agent), by id or by their own person note. */
export interface IdentityContext {
  selfIds: readonly string[];
  /** The DM counterpart's person-note name, if one is known (never the owner's own note). */
  personName?: (mxid: string) => string | null;
  /** True for a member the people index knows as the owner (their own person note claims the id). */
  isOwner?: (mxid: string) => boolean;
}

/** Default cap on the two identity reads together (MATRIX_IDENTITY_TIMEOUT_MS) — far below the
 *  client's own read timeout, so a slow homeserver delays one room's write by seconds, not minutes. */
export const IDENTITY_TIMEOUT_MS = 8000;
const identityTimeoutMs = (): number => {
  const v = Number(process.env.MATRIX_IDENTITY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : IDENTITY_TIMEOUT_MS;
};

/** `p`, or null once it fails or `ms` passes (the read is abandoned, not awaited). */
function bounded<T>(p: Promise<T> | undefined, ms: number): Promise<T | null> {
  if (!p) return Promise.resolve(null);
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => {
    t = setTimeout(() => r(null), ms); // cleared when the read settles: lives at most `ms`
  });
  return Promise.race([p.catch(() => null), timeout]).finally(() => clearTimeout(t));
}

/**
 * A thread note's human title, by the Comms precedence (comms/naming.ts `resolveTitle`):
 * the DM counterpart's person note → m.room.name → m.bridge channel name → the other
 * members' display names (never self, the owner's own ghost or person note, the agent or a
 * bridge bot) → a formatted handle. Never a room id, a raw mxid or a ghost localpart (e2e O4).
 *
 * Reads the room's FULL state and joined members, in parallel, bounded by `timeoutMs` (an
 * incremental /sync holds member DELTAS only — a title guessed from those could be wrong for
 * good). null = neither read succeeded, or nothing better than "Unknown": the caller persists
 * no title and tries again after a back-off.
 */
export async function resolveThreadIdentity(
  client: Partial<Pick<MatrixClient, "roomState" | "joinedMembers">>,
  rb: Pick<RoomBatch, "roomId" | "name" | "memberIds" | "displayNames">,
  ctx: IdentityContext,
  timeoutMs: number = identityTimeoutMs(),
): Promise<ThreadIdentity | null> {
  return (await identityOutcome(client, rb, ctx, timeoutMs)).identity;
}

/** The joined members of a room from its full state (m.room.member, membership "join") → displayname. */
function joinedFromState(state: MatrixEvent[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const e of state)
    if (e.type === "m.room.member" && typeof e.state_key === "string" && e.state_key && e.content?.membership === "join")
      out[e.state_key] = typeof e.content.displayname === "string" ? e.content.displayname.trim() : "";
  return Object.keys(out).length ? out : null;
}

/** What a room's identity reads came to. `answered` = at least one read gave a usable answer
 *  (false = both failed or timed out: the per-pass breaker counts it). */
interface IdentityOutcome {
  identity: ThreadIdentity | null;
  answered: boolean;
  /** No read was made (the pass's breaker is open): the caller leaves the back-off as it is. */
  skipped?: boolean;
}

async function identityOutcome(
  client: Partial<Pick<MatrixClient, "roomState" | "joinedMembers">>,
  rb: Pick<RoomBatch, "roomId" | "name" | "memberIds" | "displayNames">,
  ctx: IdentityContext,
  timeoutMs: number,
): Promise<IdentityOutcome> {
  const [stateRaw, joinedRaw] = await Promise.all([
    bounded(client.roomState?.(rb.roomId), timeoutMs),
    bounded(client.joinedMembers?.(rb.roomId), timeoutMs),
  ]);
  const state = Array.isArray(stateRaw) && stateRaw.length ? stateRaw : null;
  // The member list comes from a FULL read only — joined_members, else the state's own
  // m.room.member events — never from the batch's deltas (a partial title would stick).
  const joined = (joinedRaw && Object.keys(joinedRaw).length ? joinedRaw : null) ?? (state ? joinedFromState(state) : null);
  if (!state && !joined) return { identity: null, answered: false };
  if (!joined) return { identity: null, answered: true };
  const memberIds = Object.keys(joined);
  const nameOf = (id: string) => joined[id]?.trim() || rb.displayNames[id]?.trim() || null;
  const self = new Set(ctx.selfIds.map((i) => i.toLowerCase()));
  const isSelf = (id: string) => self.has(id.toLowerCase()) || !!ctx.isOwner?.(id);
  const selfMembers = memberIds.filter(isSelf);
  const others = memberIds.filter((id) => !isSelf(id) && !isBridgeBot(id));
  const meta = state ? roomMetaFromState(state, memberIds, [...new Set([...self, ...ctx.selfIds, ...selfMembers])], Object.fromEntries(memberIds.map((id) => [id, nameOf(id)]))) : null;
  const kind = meta?.kind ?? (others.length <= 1 ? "dm" : "group");
  const person = kind === "dm" ? others.map((id) => ctx.personName?.(id) ?? null).find((n) => !!n) ?? null : null;
  const { title } = resolveTitle({
    person: person ? { name: person } : null,
    roomName: meta?.roomName ?? rb.name,
    channelName: meta?.channelName ?? null,
    memberDisplayNames: others.map(nameOf).filter((n): n is string => !!n),
    handle: others[0] ?? null,
    kind,
    network: meta?.network ?? null,
  });
  if (title === "Unknown") return { identity: null, answered: true };
  const proto = state ? bridgeProtocolId(state) : null;
  return { identity: { title, platform: proto ? PROTOCOL_PLATFORM[proto] ?? null : null }, answered: true };
}

/** Consecutive identity reads in one pass that got no answer before the pass stops reading
 *  (a hung homeserver must not stretch a pass by the identity timeout × every new room). */
export const IDENTITY_BREAKER_FAILURES = 3;

/**
 * Per pass: room batch → a lazy `ingestRoom` identity reader. The context (who is self, the
 * people index, the owner's person note) is built once per pass on first use; `whoami` is asked
 * at most once, and only when self is otherwise unknown (a DM must never be titled by its owner).
 */
function threadIdentityFactory(
  client: Partial<Pick<MatrixClient, "roomState" | "joinedMembers" | "whoami">>,
  ctx: {
    context: () => Promise<{ selfIds: string[]; people: PeopleIndex | null; ownerPersonId: string | null }>;
    whoami: boolean;
    timeoutMs?: number;
  },
): (rb: RoomBatch) => () => Promise<IdentityOutcome> {
  let built: Promise<IdentityContext> | undefined;
  let unanswered = 0;
  const build = async (): Promise<IdentityContext> => {
    const { selfIds, people, ownerPersonId } = await ctx.context();
    const self = [...selfIds];
    if (ctx.whoami && client.whoami) {
      const w = await bounded(client.whoami(), ctx.timeoutMs ?? identityTimeoutMs());
      if (w) self.push(w);
    }
    if (!people) return { selfIds: self };
    const personOf = (mxid: string) => people.find({ matrixId: mxid });
    return {
      selfIds: self,
      isOwner: (mxid) => !!ownerPersonId && personOf(mxid)?.id === ownerPersonId,
      personName: (mxid) => {
        const p = personOf(mxid);
        if (!p || p.id === ownerPersonId) return null;
        return (typeof p.metadata?.name === "string" && p.metadata.name.trim()) || titleOf(p);
      },
    };
  };
  return (rb) => async () => {
    if (unanswered >= IDENTITY_BREAKER_FAILURES) return { identity: null, answered: false, skipped: true };
    const out = await identityOutcome(client, rb, await (built ??= build()), ctx.timeoutMs ?? identityTimeoutMs());
    unanswered = out.answered ? 0 : unanswered + 1;
    if (unanswered === IDENTITY_BREAKER_FAILURES)
      console.warn(`[worker] matrix: ${unanswered} room identity reads in a row got no answer — no more this pass (titles retried later)`);
    return out;
  };
}

/** A candidate name that a person would call the chat (resolveTitle's own id/slug/ghost filters,
 *  a network suffix like " (WA)" dropped), or null — also for the bridges' "Unknown user". */
function humanName(raw: unknown, network?: string | null): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const r = resolveTitle({ roomName: raw, memberDisplayNames: [], kind: "group", network });
  return r.titleSource === "room" && !/^unknown(\s+user)?$/i.test(r.title) ? r.title : null;
}

/** The name in a thread body's `# <name> — <platform>` heading, or null. */
function headingName(content: string | undefined): string | null {
  const first = (content ?? "").split("\n", 1)[0] ?? "";
  const m = /^# (.+?)(?: — \S+)?\s*$/.exec(first);
  return m ? m[1]! : null;
}

/** Retry back-off for a room whose title could not be resolved: 1 h, doubling, at most 7 days. */
const TITLE_RETRY_BASE_MS = 60 * 60 * 1000;
const TITLE_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export function titleRetryDue(meta: Record<string, unknown> | null | undefined, now: number): boolean {
  const at = Number(meta?.titleCheckedAt);
  if (!Number.isFinite(at) || at <= 0) return true;
  const tries = Math.max(1, Number(meta?.titleChecks) || 1);
  return now - at >= Math.min(TITLE_RETRY_BASE_MS * 2 ** (tries - 1), TITLE_RETRY_MAX_MS);
}

/**
 * What a write does about the thread's title (e2e O4):
 *  - `keep`: the note has a human title and the batch names no other room name;
 *  - `set`: a title known with NO Matrix read — the batch's own m.room.name (a rename, M5),
 *    or, for an untitled old note, its human `# heading` (adopted as is: no reads at cutover);
 *  - `read`: resolve it from the room (new notes; untitled notes with a room-id heading);
 *  - `wait`: an earlier read found nothing; its back-off has not passed.
 */
export type TitlePlan = { kind: "keep" } | { kind: "set"; title: string } | { kind: "read" } | { kind: "wait" };
export function planTitle(note: Note | undefined, rb: Pick<RoomBatch, "name">, now: number): TitlePlan {
  // The note's platform decides what counts as a name (a Slack channel's kebab slug is one).
  const net = typeof note?.metadata?.platform === "string" ? note.metadata.platform : null;
  const roomName = humanName(rb.name, net);
  if (!note) return { kind: "read" };
  // A stored title stands unless it is an identifier (a formatted phone handle is a title).
  const t = note.metadata?.title;
  const stored = typeof t === "string" && t.trim() && !looksLikeId(t, net) ? t : null;
  if (stored) return roomName && roomName !== stored ? { kind: "set", title: roomName } : { kind: "keep" };
  if (roomName) return { kind: "set", title: roomName };
  const heading = humanName(headingName(note.content), net);
  if (heading) return { kind: "set", title: heading };
  return titleRetryDue(note.metadata, now) ? { kind: "read" } : { kind: "wait" };
}

/** The body's `# <name> — <platform>` heading with `title` in place of a room-id name or of the
 *  previous title (a rename); any other heading is left untouched. The path never changes. */
function retitledContent(content: string, roomId: string, title: string, platform: string, prevTitle?: string | null): string {
  const nl = content.indexOf("\n");
  const first = nl < 0 ? content : content.slice(0, nl);
  const m = /^# (.+?) — (\S+)\s*$/.exec(first);
  // A room-id heading, or (a rename) the heading that still reads the previous title.
  if (!m || !(m[1] === roomId || looksLikeId(m[1]!, platform) || (!!prevTitle && m[1] === prevTitle))) return content;
  return `# ${title} — ${m[2] === "matrix" ? platform : m[2]}${nl < 0 ? "" : content.slice(nl)}`;
}

export const sanitizePath = (s: string): string =>
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
      /^(whatsapp|telegram|signal|discord|instagram|messenger|twitter|slack|linkedin)_/i,
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
        "join" | "pendingInvites" | "joinedRooms" | "leave" | "messagesBefore" | "joinedMembers" | "profileName" | "roomName" | "roomState" | "whoami"
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
    ownerSenderIds?: (people: PeopleIndex) => string[];
    /** The agent's own Matrix senders (agentSenderIds): never inbound, never owed. */
    agentSenderIds?: readonly string[];
    /** Whose owner ids these are (the vault): the last verified list is kept per key. */
    identityKey?: string;
    /** The owner's own person note for THREAD TITLES only (it never names a thread; links are
     *  unaffected — `ownerPersonId` stays the linking switch). Defaults to `ownerPersonId`. */
    titleOwnerPersonId?: (people: PeopleIndex) => string | null;
    /** Cap on a room's two identity reads (default MATRIX_IDENTITY_TIMEOUT_MS / 8 s). */
    identityTimeoutMs?: number;
    /** PEOPLE_QUEUE_ON_INGEST: collects unresolved DM counterparts; flushed with the thread's note id. */
    reviewSink?: { collect(roomId: string): (r: PersonReview) => void; flush(roomId: string, noteId: string | null | undefined): void };
    /** Rooms an EARLIER pass failed on (its `failedRooms`), replayed before this
     *  pass's own rooms: everything between that pass's cursor and this one's. */
    replay?: RoomReplay[];
    /** COMMS_SYNC_LONGPOLL: the /sync long-poll timeout. Absent = the call is exactly `sync(since)`. */
    syncTimeoutMs?: number;
    /** Comms live bus (Task 11): told each synced room's RAW timeline events, only AFTER that room's
     *  vault write succeeded (or when the room needed none). Never awaited; a throw is swallowed. */
    publish?: (b: LiveBatch) => void;
  } = {},
): Promise<IngestResult> {
  const { nextBatch, rooms, invites: fresh } = opts.syncTimeoutMs ? await client.sync(opts.since, opts.syncTimeoutMs) : await client.sync(opts.since);
  const published = new Set<string>();
  const send = (b: LiveBatch) => {
    if (!opts.publish) return;
    published.add(b.roomId);
    try {
      opts.publish(b);
    } catch (e) {
      console.warn(`[worker] matrix: live publish for ${b.roomId} failed: ${String(e)}`);
    }
  };
  const publish = (rb: RoomBatch, noteId?: string) => {
    if (!rb.events?.length && !rb.receipts?.length) return;
    send({ roomId: rb.roomId, events: rb.events ?? [], ...(rb.receipts?.length ? { receipts: rb.receipts } : {}), ...(rb.limited ? { limited: true } : {}), ...(noteId ? { noteId } : {}) });
  };
  /** Every synced room the live bus did NOT hear (its write or gap-fill failed, or the pass
   *  stopped before it): announced flagged `stale` (its vault note lags; replayed next pass) but
   *  WITH its raw timeline, so the live stream keeps flowing for that thread (e2e B1 — an empty
   *  announcement made the window stale and every later reaction/edit was dropped). The Comms
   *  window reads Matrix, not the vault, so these events are complete unless `limited`. */
  const announceSuppressed = () => {
    if (!opts.publish) return;
    for (const rb of rooms)
      if (!published.has(rb.roomId) && (rb.events?.length || rb.messages.length || rb.receipts?.length))
        send({ roomId: rb.roomId, events: rb.events ?? [], ...(rb.receipts?.length ? { receipts: rb.receipts } : {}), ...(rb.limited ? { limited: true } : {}), stale: true });
  };

  // COMMS_SYNC_LONGPOLL only (the flag-off pass is unchanged): a long-poll that came back with
  // no room message, no truncated (limited) timeline whose gap-fill could recover messages, no invite, no replay owed and no invite probe due needs no vault at all —
  // no thread listing, no people index, no oversize sweep. Rooms with only relations/receipts
  // (reactions, send statuses) are announced to the live bus without a note id.
  if (
    opts.syncTimeoutMs &&
    !fresh.length &&
    !opts.replay?.length &&
    !(opts.probeInvites && client.pendingInvites) &&
    rooms.every((r) => !r.messages.length && !r.limited)
  ) {
    for (const rb of rooms) publish(rb);
    return {
      rooms: 0, messages: 0, created: 0, updated: 0, nextBatch, invitesPending: 0, joined: 0,
      peopleLinked: 0, peopleCreated: 0, failedRooms: [], replayed: { ok: [], failed: [], messages: 0 },
    };
  }
  let people: PeopleIndex | null = null;
  let ownerSenderIds:string[]=[];
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
  if(opts.ownerSenderIds)ownerSenderIds=await loadOwnerSenderIds(vault,opts.ownerSenderIds,opts.identityKey??"default",(p)=>{people=p;});
  const byRoom = threadsByRoom(existing);
  await sweepOversizedThreads(vault, byRoom);
  // Thread titles (e2e O4): self = the owner's senders (their bridge ghosts too), the sync user
  // and the agent; the sync user is asked of the homeserver (once a pass) only when no one
  // passed it; the owner's own person note never names a thread.
  const identityFor = threadIdentityFactory(client, {
    context: async () => {
      const p = people as PeopleIndex | null;
      const ownerOf = opts.titleOwnerPersonId ?? opts.ownerPersonId;
      return {
        selfIds: [...ownerSenderIds, ...(opts.selfUserId ? [opts.selfUserId] : []), ...(opts.agentSenderIds ?? [])],
        people: p,
        ownerPersonId: p && ownerOf ? ownerOf(p) : null,
      };
    },
    whoami: !opts.selfUserId,
    ...(opts.identityTimeoutMs ? { timeoutMs: opts.identityTimeoutMs } : {}),
  });

  // S2 — the no-drop layer under a failed room. A room that failed in an earlier
  // pass lost that pass's messages while the cursor moved on; once NEWER messages
  // land, `lastMessageAt` passes the lost ones and the reconcile sweep reads "not
  // behind". So before anything else, re-fetch exactly that window — the failed
  // pass's cursor up to this pass's — and append what the note does not hold.
  const replayed = { ok: [] as string[], failed: [] as string[], messages: 0 };
  for (const p of opts.replay ?? []) {
    try {
      if (!client.messagesBefore || !opts.since) throw new Error("no cursor to replay up to");
      // A room with NO thread note yet (a newly joined portal whose first write or
      // gap-fill failed) has its whole history before the failed pass's cursor: page
      // to the room's start, exactly like the new-room gap-fill — a window bounded by
      // that cursor would fetch one pass's worth and leave the rest "not behind".
      const window = byRoom.has(p.roomId) && p.since ? { to: p.since } : { sinceTs: 0 };
      const gap = await client.messagesBefore(p.roomId, { from: opts.since, ...window });
      if (gap.capped) console.warn(`[worker] matrix: replay of ${p.roomId} hit its cap — oldest messages of the window skipped`);
      if (gap.messages.length) {
        // NOT swallowed: without the member list the lines would be rendered with
        // fallback ids; fail the replay and try again next pass instead.
        const members = client.joinedMembers ? await client.joinedMembers(p.roomId) : {};
        const rb: RoomBatch = {
          roomId: p.roomId,
          name: byRoom.has(p.roomId) || !client.roomName ? null : await client.roomName(p.roomId).catch(() => null),
          memberIds: Object.keys(members),
          displayNames: Object.fromEntries(Object.entries(members).filter(([, v]) => v)),
          messages: gap.messages,
        };
        await resolveDisplayNames(client, rb);
        // A thread created here must be the one this pass's own batch appends to.
        if (await ingestRoom(rb, vault, byRoom, { dedupe: true,selfUserId:ownerSenderIds,agentIds:opts.agentSenderIds, identity: identityFor(rb), onCreated: (n) => byRoom.set(p.roomId, n) })) replayed.messages += gap.messages.length;
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
    if (!rb.messages.length) {
      // Nothing for the vault (reactions, receipts of delivery, state): the live bus still hears it,
      // unless the gap-fill failed (then the room is replayed and nothing is announced).
      if (!failedRooms.has(rb.roomId)) publish(rb, byRoom.get(rb.roomId)?.id);
      continue;
    }
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
    let createdId: string | undefined;
    try {
      await ingestRoom(rb, vault, byRoom, { dedupe, links,selfUserId:ownerSenderIds,agentIds:opts.agentSenderIds, identity: identityFor(rb), ...(opts.storeParticipantIds ? { participantIds: memberIds ?? rb.memberIds } : {}), ...(opts.publish ? { onCreated: (n: Note) => { createdId = n.id; } } : {}) });
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
    // The vault write for this room succeeded: only now may the live bus hear of it.
    // A failed gap-fill (tail written, window replayed next pass) is not announced.
    if (!failedRooms.has(rb.roomId)) publish(rb, byRoom.get(rb.roomId)?.id ?? createdId);
    if (byRoom.has(rb.roomId)) updated++;
    else created++;
  }
  announceSuppressed();
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

/** A vault 409/428 — by the error's status, never by its text (a body or a path may contain "409"). */
const isConflict = (e: unknown): boolean => {
  const st = (e as { status?: unknown })?.status;
  return st === 409 || st === 428;
};

/**
 * DEDUPE IDENTITY of a message in a thread: its stamp + its body — NOT the
 * rendered sender. The same event is rendered "251731455: hi" by a pass whose
 * member lookup failed and "Rin: hi" by the next one; comparing whole lines made
 * a replay / a 409 retry append the batch a second time. The note stores no event
 * id, so this is as exact as it gets (see the residuals in CLAUDE.md). Trailing
 * whitespace is ignored on both sides (the append `trimEnd`s the body it extends).
 */
const messageKey = (m: MatrixMessage): string => `${formatStamp(m.ts)} ${m.body.trimEnd()}`;
/** The same key, read back from a stored entry (`[stamp] Sender: body`). */
function entryKey(entry: string): string | null {
  const close = entry.indexOf("] ");
  if (!entry.startsWith("[") || close === -1) return null;
  const sep = entry.indexOf(": ", close + 2);
  // A sender with an empty body is stored as "…Sender:" — never written (toMessage drops it).
  if (sep === -1) return null;
  return `${entry.slice(0, close + 1)} ${entry.slice(sep + 2).trimEnd()}`;
}
/** How many times each message key occurs among the entries of `content`. */
function keyCounts(content: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of parseThread(content).entries) {
    const k = entryKey(e);
    if (k !== null) out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}
/** The pairs whose message is NOT accounted for by `have` — each stored copy cancels
 *  ONE incoming copy, so two genuinely identical messages still land twice. */
function notIn<T extends { key: string }>(items: T[], have: Map<string, number>): T[] {
  return items.filter((it) => {
    const n = have.get(it.key) ?? 0;
    if (n > 0) have.set(it.key, n - 1);
    return n === 0;
  });
}

/**
 * After a 409: which of our messages did SOMEONE ELSE already put in the note since
 * we read it? When the fresh body is our copy plus an appended tail, only the tail
 * counts; otherwise (trimmed by a rollover, edited) the whole body does.
 */
function notYetWritten<T extends { key: string }>(items: T[], loaded: Note, fresh: Note): T[] {
  const before = (loaded.content ?? "").trimEnd();
  const now = fresh.content ?? "";
  return notIn(items, keyCounts(now.startsWith(before) ? now.slice(before.length) : now));
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
/** The last owner sender ids that loaded, per vault: a failed people read falls back to them. */
const lastOwnerSenderIds = new Map<string, string[]>();
const ownerIdsWarned = new Set<string>();
export function resetOwnerSenderIdsForTests(): void {
  lastOwnerSenderIds.clear();
  ownerIdsWarned.clear();
}
/**
 * The owner's own Matrix ids for this pass. If the people index cannot be read, the owner is
 * NOT silently forgotten (which would make every owner message look inbound): the last
 * verified list is used, and with none the pass logs that self evidence is unknown — the
 * evidence is then written as unknown (`lastMessageIsSelf: null`), never as "not self".
 */
async function loadOwnerSenderIds(vault: IngestVault, pick: (people: PeopleIndex) => string[], key: string, loaded: (p: PeopleIndex) => void): Promise<string[]> {
  try {
    const people = await PeopleIndex.load(vault);
    loaded(people);
    const ids = pick(people);
    if (ids.length) {
      lastOwnerSenderIds.set(key, ids);
      ownerIdsWarned.delete(key);
    } else if (!ownerIdsWarned.has(key)) {
      ownerIdsWarned.add(key);
      console.warn("[worker] matrix: no owner Matrix id is known (owner person note / PEOPLE_OWNER_*): reply evidence is written as unknown");
    }
    return ids;
  } catch (e) {
    const last = lastOwnerSenderIds.get(key);
    console.warn(`[worker] matrix: people index unavailable (${String(e).slice(0, 200)}); ${last ? "using the last verified owner ids" : "no verified owner ids yet — reply evidence is written as unknown"}`);
    return last ?? [];
  }
}

/**
 * The agent's OWN voices: messages Omni / Hermes wrote (its Matrix user, `@omni-agent:localhost`
 * by default, and any bridge ghost that relays one of its bots — OMNI_AGENT_MATRIX_IDS), plus
 * bridge management bots. Such a message is never someone the owner owes a reply to.
 */
export const DEFAULT_AGENT_MATRIX_IDS = ["@omni-agent:localhost"];
export function agentSenderIds(env: string | undefined = process.env.OMNI_AGENT_MATRIX_IDS): string[] {
  const listed = (env ?? "").split(",").map((v) => v.trim().toLowerCase()).filter((v) => /^@[^:\s]+:\S+$/.test(v));
  return [...new Set([...DEFAULT_AGENT_MATRIX_IDS, ...listed])];
}
export interface EvidenceContext {
  /** The agent's own senders (see `agentSenderIds`); bridge bots always count as agents when this is given. */
  agentIds?: readonly string[];
}

/** Identity evidence is taken from Matrix event fields, never transcript text/display names. */
export function lastMessageEvidence(messages: MatrixMessage[], previous?:Record<string,unknown>, selfUserId?:string|string[]|null, ctx:EvidenceContext={}):Record<string,unknown> {
 const selfIds=new Set(Array.isArray(selfUserId)?selfUserId:selfUserId?[selfUserId]:[]);
 const agents=ctx.agentIds?new Set(ctx.agentIds.map(a=>a.trim().toLowerCase())):null;
 const isAgent=(sender:string)=>!!agents&&(agents.has(sender.toLowerCase())||isBridgeBot(sender));
 // The agent's messages are neither inbound nor the owner's reply: chronology reads people only.
 const people=agents?messages.filter(m=>!isAgent(m.sender)):messages;
 const chronology:Record<string,unknown>={};let inbound=Number(previous?.lastInboundMessageAt??0);
 if(selfIds.size){
  for(const m of [...people].sort((a,b)=>a.ts-b.ts)){
   if(!selfIds.has(m.sender))inbound=Math.max(inbound,m.ts);
   else if(inbound>0&&inbound<m.ts&&m.ts>Number(previous?.lastSelfReplyAt??0)&&!people.some(other=>other.ts===m.ts&&!selfIds.has(other.sender))){
    chronology.lastSelfReplyAt=m.ts;chronology.lastReplyInboundAt=inbound;
   }
  }
  if(inbound>0)chronology.lastInboundMessageAt=inbound;
 }
 const at=Math.max(...messages.map(m=>m.ts));
 if(!Number.isFinite(at)||at<Number(previous?.lastMessageAt??0))return chronology;
 const latest=messages.filter(m=>m.ts===at),senders=new Set(latest.map(m=>m.sender));
 const agentFlag=agents?{lastMessageIsAgent:false}:{};
 // The latest word is the agent's own (its user, a relay of its bot, a bridge bot): owner-side,
 // so it never reads as an inbound message waiting on the owner — whatever owner ids are known.
 if(agents&&latest.every(m=>isAgent(m.sender))){
  const message=latest[latest.length-1]!;
  return {...chronology,lastMessageSender:message.sender,lastMessageEventId:message.eventId,lastMessageText:message.body.slice(0,1000),lastMessageIsSelf:true,lastMessageIsAgent:true};
 }
 const sender=senders.size===1?latest[latest.length-1]?.sender:null;
 const conflicts=at===previous?.lastMessageAt&&previous?.lastMessageSender&&previous.lastMessageSender!==sender;
 if(!sender||conflicts)return {...chronology,lastMessageSender:null,lastMessageEventId:null,lastMessageText:null,lastMessageIsSelf:null,...agentFlag};
 const message=latest[latest.length-1]!;
 return {...chronology,lastMessageSender:message.sender,lastMessageEventId:message.eventId,lastMessageText:message.body.slice(0,1000),lastMessageIsSelf:selfIds.size?selfIds.has(message.sender):null,...agentFlag};
}

async function ingestRoom(
  rb: RoomBatch,
  vault: IngestVault,
  byRoom: Map<string, Note>,
  opts: {
    dedupe?: boolean;
    selfUserId?:string|string[]|null;
    /** The agent's own senders (lastMessageEvidence). */
    agentIds?: readonly string[];
    links?: NoteLinkInput[];
    /** Stable member ids to keep on the note (MATRIX_STORE_PARTICIPANT_IDS). */
    participantIds?: string[];
    /** Told the thread note this call created (the replay keeps the room → note map current). */
    onCreated?: (n: Note) => void;
    /** The thread's human title + bridge platform (resolveThreadIdentity). Asked only when
     *  `planTitle` says `read` (a new note; an untitled one with a room-id heading whose back-off
     *  has passed): once a note has a real title nothing more is read for it. */
    identity?: () => Promise<IdentityOutcome>;
  } = {},
): Promise<boolean> {
  const linkAdd = opts.links?.length ? { links: { add: opts.links } } : {};
  let platform = detectPlatform(rb.memberIds);
  let items = rb.messages.map((m) => ({ line: formatLine(m, rb.displayNames), key: messageKey(m) }));
  if (!items.length) return false;
  // The listing row carries no body: read the note NOW, once, and build the
  // dedupe, the append, the metadata merge and any rollover on that fresh copy.
  const row = byRoom.get(rb.roomId);
  let note = row ? await loadThread(vault, row) : undefined;
  // The thread's title (e2e O4): kept, set with no read, or read from the room (planTitle).
  const now = Date.now();
  const plan = planTitle(note, rb, now);
  let identity: ThreadIdentity | null = null;
  let nothingFound = false;
  if (plan.kind === "read" && opts.identity) {
    const out = await opts.identity().catch((): IdentityOutcome => ({ identity: null, answered: false }));
    identity = out.identity;
    if (identity?.platform) platform = identity.platform; // the bridge's own protocol id beats member prefixes
    nothingFound = !identity && !out.skipped; // a skipped read (breaker open) leaves the back-off as it is
    // The reads took time: build the write on the note as the vault holds it NOW (fewer 409s).
    if (!out.skipped && note && row) note = await loadThread(vault, row);
  }
  // A new room whose reads found nothing keeps the batch's own m.room.name if it is a real name.
  const title = plan.kind === "set" ? plan.title : identity?.title ?? (note ? null : humanName(rb.name, platform));
  const titleMeta: Record<string, unknown> = title
    ? { title }
    : nothingFound // durable back-off: an unresolvable room is not re-read every batch (M4)
      ? { titleCheckedAt: now, titleChecks: (Number(note?.metadata?.titleChecks) || 0) + 1 }
      : {};
  if (opts.dedupe) items = notIn(items, keyCounts(note?.content ?? ""));
  if (!items.length) return false;
  let lines = items.map((it) => it.line);
  const lastMessageAt = Math.max(...rb.messages.map((m) => m.ts));
  const participants = rb.memberIds.map(
    (id) => rb.displayNames[id] ?? shortSender(id),
  );
  if (note && row) {
    // An existing note gets its human title on this write: metadata.title and a room-id
    // heading only — its PATH never changes (links, history).
    // The append is COMPARE-AND-SET on the copy just read. Reading the body right
    // before the write made a second writer visible (a listing-time body used to
    // make an overlapping pass rewrite the same text; a fresh one would append the
    // same events again), so: on a 409, re-read, drop what is already there,
    // recount, and try ONCE more. A second 409 fails the room for this pass (it is
    // replayed by the next one).
    const wanted = items;
    for (let attempt = 0; ; attempt++) {
      try {
        await appendToThread(rb, vault, byRoom, note, lines, { platform, lastMessageAt, participants, linkAdd, participantIds: opts.participantIds,selfUserId:opts.selfUserId,agentIds:opts.agentIds, titleMeta, ...(title ? { title } : {}) });
        break;
      } catch (e) {
        if (!isConflict(e) || attempt >= 1) throw e;
        const fresh = await loadThread(vault, row);
        lines = notYetWritten(wanted, note, fresh).map((it) => it.line);
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
    const name = title ?? rb.name ?? rb.roomId;
    const base = `vault/messages/${platform}/${sanitizePath(name)}`;
    const params = {
      content: `# ${name} — ${platform}\n\n${lines.join("\n")}`,
      tags: ["message-thread"],
      metadata: {
        type: "message-thread",
        platform,
        ...titleMeta,
        matrixRoomId: rb.roomId,
        lastMessageAt,
        ...lastMessageEvidence(rb.messages,undefined,opts.selfUserId,{agentIds:opts.agentIds}),
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
  ctx: { platform: string; lastMessageAt: number; participants: string[]; linkAdd: { links?: { add: NoteLinkInput[] } }; participantIds?: string[];selfUserId?:string|string[]|null;agentIds?:readonly string[];
    /** A new human title: replaces a room-id heading (other headings are left as they are). */
    title?: string;
    /** metadata.title, or the title back-off marker (planTitle). */
    titleMeta?: Record<string, unknown> },
): Promise<void> {
  const { lastMessageAt, participants, linkAdd } = ctx;
  const cas = note.updatedAt ? { ifUpdatedAt: note.updatedAt } : {};
  const prev = note.metadata ?? {};
  const platform = keepPlatform(prev.platform, ctx.platform);
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
    ...lastMessageEvidence(rb.messages,prev,ctx.selfUserId,{agentIds:ctx.agentIds}),
    messageCount: prevCount + lines.length,
    ...(mergedParticipants.length ? { participants: mergedParticipants } : {}),
    ...(ctx.participantIds ? { participantIds: mergeIds(prev.participantIds, ctx.participantIds) } : {}),
    ...(ctx.titleMeta ?? {}),
  };
  const prevTitle = typeof prev.title === "string" ? prev.title : null;
  if (ctx.title) note = { ...note, content: retitledContent(note.content, rb.roomId, ctx.title, platform, prevTitle) };
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
  /** Rooms actually PROBED by this sweep (not the number joined — that is `rooms`). */
  scanned: number;
  /** Joined rooms in all. */
  rooms: number;
  /** Rooms still owed after this sweep — a probe that threw, a repair that failed, ran out
   *  of time or was over the per-sweep budget. Hand it back as `retry`: the next sweep
   *  asks about them again (each after its back-off), wherever the resume point is. */
  retry?: OwedRoom[];
  /** Rooms given up on after RECONCILE_MAX_TRIES failures in a row (ids). They are asked about in the ordinary rotation only. */
  stuck?: string[];
  /** This was a retry-only sweep (owed rooms only: no rotation, no joined-rooms listing). */
  retryOnly?: boolean;
  /** Joined rooms whose newest message is not in the vault. */
  behind: number;
  repaired: number;
  messages: number;
  /** Rooms still behind after this sweep (over the per-sweep repair budget). */
  deferred: number;
  /** Present (> 0) only when the sweep hit its deadline: joined rooms it never
   *  probed, plus behind rooms it had no time to repair. Left for the next sweep. */
  unprobed?: number;
  /** Present only when the deadline cut the PROBE short: the last room id probed
   *  (rooms are probed in sorted order). Hand it back as `resumeAfter` and the next
   *  sweep continues behind it instead of starting at the front again. */
  resumeAfter?: string;
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
    Partial<Pick<MatrixClient, "profileName" | "roomState" | "whoami">>,
  vault: IngestVault,
  opts: {
    upTo: string;
    /** The agent's own Matrix senders (agentSenderIds): never inbound, never owed. */
    agentSenderIds?: readonly string[];
    /** The owner's own Matrix senders (their bridge ghosts too): never a thread's title. */
    ownerSenderIds?: (people: PeopleIndex) => string[];
    /** The owner's own person note: never a thread's title. */
    ownerPersonId?: (people: PeopleIndex) => string | null;
    /** Whose owner ids these are (the vault), as for ingestMatrix. */
    identityKey?: string;
    /** Cap on a room's two identity reads (default MATRIX_IDENTITY_TIMEOUT_MS / 8 s). */
    identityTimeoutMs?: number;
    maxRepairs?: number;
    cap?: number;
    concurrency?: number;
    /** Overall budget for the sweep (MATRIX_RECONCILE_DEADLINE_MS). Past it no further
     *  room is probed or repaired; what is left waits for the next sweep. */
    deadlineMs?: number;
    /** Where the previous sweep's probe stopped (its `resumeAfter`): this sweep probes
     *  only the rooms sorted AFTER that id, to the end of the list. A sweep that
     *  reaches the end returns no `resumeAfter`, so the one after starts at the front
     *  — every room is probed once per cycle however many sweeps a cycle takes. */
    resumeAfter?: string | null;
    /** The previous sweep's `retry` (ids alone are accepted: an older cursor). */
    retry?: Array<OwedRoom | string>;
    /** The previous sweep's `stuck`. */
    stuck?: string[];
    /** Ask about the owed rooms only: no rotation slice, no joined-rooms listing, the resume point is left where it is. */
    retryOnly?: boolean;
    /** Most owed rooms asked about in this sweep (default 24). */
    retryMax?: number;
    /** Wall clock for the owed rooms' back-off (default Date.now; `now` is the deadline clock). */
    wallNow?: () => number;
    /** Share of `deadlineMs` that probing may use (default 0.6); the rest is kept for repairs. */
    probeShare?: number;
    now?: () => number;
  },
): Promise<ReconcileResult> {
  const clock = opts.now ?? Date.now;
  const wall = (opts.wallNow ?? Date.now)();
  const startedAt = clock();
  const bounded = !!opts.deadlineMs && opts.deadlineMs > 0;
  const deadlineAt = bounded ? startedAt + opts.deadlineMs! : Infinity;
  // Probing gets only PART of the budget: what a sweep finds behind must still be
  // repaired in that sweep (probing to the very deadline left every finding unrepaired
  // while the resume point moved past it).
  const probeUntil = bounded ? startedAt + opts.deadlineMs! * Math.min(1, Math.max(0.05, opts.probeShare ?? 0.6)) : Infinity;
  const retryOnly = opts.retryOnly === true;
  // …and the owed rooms get only HALF of the probe window (all of it in a retry-only sweep):
  // a pile of rooms whose probes hang must not eat every sweep and stall the rotation.
  const retryUntil = retryOnly || !bounded ? probeUntil : startedAt + (probeUntil - startedAt) / 2;
  const expired = () => clock() >= deadlineAt;
  let unprobed = 0;
  // A retry-only sweep asks about a handful of rooms: it needs neither the joined-rooms list nor the size sweep.
  const joined = retryOnly ? null : await client.joinedRooms();
  // Lean: rows only. A body is read by `loadThread`, for a note about to be written.
  const existing = await listThreadRows(vault);
  const byRoom = threadsByRoom(existing);
  if (!retryOnly) await sweepOversizedThreads(vault, byRoom);
  // Thread titles (e2e O4): the same self as the ingest pass — the owner's senders (loaded
  // lazily, only if a title is resolved this sweep), the agent, and the sync user via whoami.
  const identityFor = threadIdentityFactory(client, {
    context: async () => {
      let people: PeopleIndex | null = null;
      const owner = opts.ownerSenderIds
        ? await loadOwnerSenderIds(vault, opts.ownerSenderIds, opts.identityKey ?? "default", (p) => { people = p; })
        : [];
      const p = people as PeopleIndex | null;
      return {
        selfIds: [...owner, ...(opts.agentSenderIds ?? [])],
        people: p,
        ownerPersonId: p && opts.ownerPersonId ? opts.ownerPersonId(p) : null,
      };
    },
    whoami: true,
    ...(opts.identityTimeoutMs ? { timeoutMs: opts.identityTimeoutMs } : {}),
  });

  // Probe: newest message per room (one cheap /messages call each).
  const behind: Array<{ roomId: string; latest: number; cutoff: number; first: boolean }> = [];
  // Sorted, so "after room X" means the same thing in every sweep whatever order
  // the homeserver lists rooms in, and whatever was joined or left in between.
  const order = joined ? [...joined].sort() : [];
  const isJoined = joined ? new Set(order) : null;
  const after = opts.resumeAfter ?? null;
  const from = after === null ? 0 : Math.max(0, order.findIndex((id) => id > after));
  // Rooms an earlier sweep left OWED (probe threw, repair failed / ran out of time / was over
  // the per-sweep budget). The resume point has moved past them, so they are asked about
  // again here — each after its own back-off, a bounded number per sweep, and before the
  // rotation continues.
  const owedIn = new Map<string, OwedRoom>();
  for (const o of opts.retry ?? []) {
    const row: OwedRoom = typeof o === "string" ? { id: o, tries: 0, at: 0 } : o;
    if (row && typeof row.id === "string" && (!isJoined || isJoined.has(row.id))) owedIn.set(row.id, { id: row.id, tries: Number(row.tries) || 0, at: Number(row.at) || 0, ...(row.repair ? { repair: true } : {}) });
  }
  const stuck = new Set((opts.stuck ?? []).filter((id) => !isJoined || isJoined.has(id)));
  const due = [...owedIn.values()].filter((o) => owedDue(o, wall)).sort((a, b) => Number(!!b.repair) - Number(!!a.repair) || a.tries - b.tries || (a.id < b.id ? -1 : 1));
  const retryNow = due.slice(0, Math.max(1, opts.retryMax ?? RECONCILE_RETRY_PER_SWEEP));
  /** Still owed after this sweep. Starts as everything not attempted now; attempts update or remove their entry. */
  const owed = new Map(owedIn);
  const retryQueue = retryNow.map((o) => o.id);
  const rotation = order.slice(from).filter((id) => !owedIn.has(id));
  let lastProbed: string | null = after;
  let cut = false;
  let probed = 0;
  const failed = (id: string, repair: boolean): void => {
    if (stuck.has(id)) return; // already given up on: it is asked about in the rotation, never owed again
    const tries = (owedIn.get(id)?.tries ?? 0) + 1;
    if (tries >= RECONCILE_MAX_TRIES) {
      owed.delete(id);
      stuck.add(id);
      console.warn(`[worker] matrix reconcile: ${id} failed ${tries} times in a row — given up on for now (it stays in the ordinary rotation; see /acl/workers)`);
    } else owed.set(id, { id, tries, at: wall, ...(repair ? { repair: true } : {}) });
  };
  const probe = async (id: string): Promise<void> => {
    probed++;
    try {
      const { messages } = await client.messagesBefore(id, { from: opts.upTo, cap: 1 });
      const latest = messages[0]?.ts;
      const note = byRoom.get(id);
      const cutoff = note ? lastMessageAtOf(note) : -1;
      if (latest !== undefined && latest > cutoff) behind.push({ roomId: id, latest, cutoff: Math.max(cutoff, 0), first: !!owedIn.get(id)?.repair });
      else {
        owed.delete(id); // in step (or no messages ever): nothing is owed
        stuck.delete(id);
      }
    } catch (e) {
      failed(id, !!owedIn.get(id)?.repair);
      console.warn(`[worker] matrix reconcile: probe ${id} failed: ${String(e)}`);
    }
  };
  const drain = (queue: string[], until: number, onCut: (left: string[]) => void) => async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      if (clock() >= until) {
        onCut([id, ...queue.splice(0)]);
        return;
      }
      if (queue === rotation) lastProbed = id;
      await probe(id);
    }
  };
  const workers = opts.concurrency ?? 8;
  await Promise.all(Array.from({ length: workers }, drain(retryQueue, retryUntil, () => undefined))); // the unreached stay owed, untouched
  if (!retryOnly) {
    await Promise.all(Array.from({ length: workers }, drain(rotation, probeUntil, (left) => {
      unprobed += left.length;
      cut = true;
    })));
  }

  // Repairs: rooms already deferred once go first, then the most recently active.
  behind.sort((a, b) => Number(b.first) - Number(a.first) || b.latest - a.latest);
  const budget = opts.maxRepairs ?? 25;
  let repaired = 0;
  let messages = 0;
  const todo = behind.slice(0, budget);
  const later = (id: string): void => void owed.set(id, { id, tries: owedIn.get(id)?.tries ?? 0, at: wall, repair: true }); // not a failure: no strike
  for (const over of behind.slice(budget)) later(over.roomId); // over this sweep's repair budget
  for (let i = 0; i < todo.length; i++) {
    const b = todo[i]!;
    if (expired()) {
      unprobed += todo.length - i;
      for (const rest of todo.slice(i)) later(rest.roomId);
      break;
    }
    try {
      const gap = await client.messagesBefore(b.roomId, {
        from: opts.upTo,
        sinceTs: b.cutoff,
        cap: opts.cap ?? 5000,
      });
      if (gap.capped)
        console.warn(`[worker] matrix reconcile: ${b.roomId} gap hit its cap — oldest skipped`);
      if (gap.messages.length) {
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
        if (await ingestRoom(rb, vault, byRoom, { dedupe: true, agentIds: opts.agentSenderIds, identity: identityFor(rb) })) {
          repaired++;
          messages += gap.messages.length;
        }
      }
      owed.delete(b.roomId);
      stuck.delete(b.roomId);
    } catch (e) {
      failed(b.roomId, true);
      console.warn(`[worker] matrix reconcile: repair ${b.roomId} failed: ${String(e)}`);
    }
  }
  const retry = [...owed.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (retry.length > RECONCILE_RETRY_CAP) console.warn(`[worker] matrix reconcile: ${retry.length} rooms owed — only ${RECONCILE_RETRY_CAP} are kept for the next sweep, the rest wait for the rotation`);
  const resume = retryOnly ? after : cut ? lastProbed : null;
  return {
    scanned: probed,
    rooms: joined ? joined.length : 0,
    behind: behind.length,
    repaired,
    messages,
    deferred: Math.max(0, behind.length - budget),
    ...(unprobed > 0 ? { unprobed } : {}),
    ...(resume !== null ? { resumeAfter: resume } : {}),
    ...(retry.length ? { retry: retry.slice(0, RECONCILE_RETRY_CAP) } : {}),
    ...(stuck.size ? { stuck: [...stuck].sort().slice(-RECONCILE_STUCK_CAP) } : {}),
    ...(retryOnly ? { retryOnly: true } : {}),
  };
}
/** A room a sweep still owes an answer about. `tries` = failed attempts in a row; `at` = the last attempt (wall clock);
 *  `repair` = it was found behind and not repaired (over budget / out of time / the repair failed): repaired FIRST next time. */
export interface OwedRoom {
  id: string;
  tries: number;
  at: number;
  repair?: boolean;
}
/** Most rooms a sweep hands on as owed. */
const RECONCILE_RETRY_CAP = 2000;
/** Most owed rooms ONE sweep asks about again (the rest keep waiting, in order of fewest tries). */
const RECONCILE_RETRY_PER_SWEEP = 24;
/** Failed attempts in a row after which a room is given up on: back to the ordinary rotation, and surfaced. */
export const RECONCILE_MAX_TRIES = 6;
const RECONCILE_STUCK_CAP = 500;
/** When may an owed room be asked about again? 5 min after it was deferred or first failed, then 15 min, then hourly. */
export const owedBackoffMs = (tries: number): number => (tries <= 1 ? 5 : tries === 2 ? 15 : 60) * 60_000;
export const owedDue = (o: OwedRoom, wallNow: number): boolean => wallNow - o.at >= owedBackoffMs(o.tries);
