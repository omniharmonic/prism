/**
 * BlueBubbles Server REST client (v1.9.x, `/api/v1/*`). Pure transport, `fetch` injectable so
 * tests run against a fake server — never the owner's real BlueBubbles.
 *
 * Auth: BlueBubbles 1.9.12 reads the server password ONLY from the query string
 * (`?password=`, also `guid` / `token`; authMiddleware.ts). So the request URL carries a
 * secret: it is built here, used for exactly one fetch, and NEVER logged, thrown or returned.
 * Every error this module raises names the operation and the HTTP status only.
 *
 * Every request is bounded (`timeoutMs`); redirects are never followed (the password must not
 * reach another host). The base URL is validated as loopback by bluebubbles/config.ts.
 */

export interface BlueBubblesCreds {
  /** BlueBubbles Server password (Settings → Connection → Server Password). */
  password: string;
  /** Shared secret the webhook URL carries (`?secret=`), checked by routes/bluebubbles.ts. */
  webhookSecret: string;
}

/** What BlueBubbles' MessageSerializer emits (the fields this connector reads). */
export interface BbHandle {
  address: string;
  service?: string | null;
  country?: string | null;
}
export interface BbAttachment {
  guid: string;
  mimeType?: string | null;
  uti?: string | null;
  transferName?: string | null;
  totalBytes?: number | null;
  height?: number | null;
  width?: number | null;
  isSticker?: boolean | null;
  hideAttachment?: boolean | null;
  isOutgoing?: boolean | null;
}
export interface BbChat {
  guid: string;
  style?: number | null;
  chatIdentifier?: string | null;
  displayName?: string | null;
  isArchived?: boolean | null;
  participants?: BbHandle[];
  lastMessage?: BbMessage | null;
}
export interface BbMessage {
  guid: string;
  /** Not serialized by BlueBubbles 1.9.12 (`handle.service` carries it); read when a server sends it. */
  service?: string | null;
  text?: string | null;
  subject?: string | null;
  handle?: BbHandle | null;
  handleId?: number | null;
  isFromMe?: boolean | null;
  dateCreated?: number | null;
  dateRead?: number | null;
  dateDelivered?: number | null;
  dateEdited?: number | null;
  dateRetracted?: number | null;
  isDelivered?: boolean | null;
  error?: number | null;
  itemType?: number | null;
  groupTitle?: string | null;
  groupActionType?: number | null;
  isAudioMessage?: boolean | null;
  /** "p:0/<guid>" / "bp:<guid>" for a tapback; the target message. */
  associatedMessageGuid?: string | null;
  /** The REST API sends the NAME for known codes ("love", "-love", …; MessageTypeTransformer)
   *  and the numeric code as a string otherwise ("2006"). Numbers are accepted too. */
  associatedMessageType?: string | number | null;
  threadOriginatorGuid?: string | null;
  attachments?: BbAttachment[];
  chats?: BbChat[];
  tempGuid?: string | null;
}
export interface BbContact {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumbers?: Array<{ address?: string | null }>;
  emails?: Array<{ address?: string | null }>;
  /** base64 image bytes ("" when none); only with extraProperties ["avatar"]. */
  avatar?: string | null;
}

export class BlueBubblesError extends Error {
  constructor(
    readonly op: string,
    readonly status: number | null,
    /** BlueBubbles' own error class/message when it sent one (never the URL). */
    readonly detail?: string,
  ) {
    super(`bluebubbles ${op} → ${status ?? "no response"}${detail ? ` (${detail.slice(0, 120)})` : ""}`);
    this.name = "BlueBubblesError";
  }
}

type FetchLike = typeof fetch;

/** Default cap on a JSON response (a 1000-message page with attachments is well under it). */
const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

/** The body as text, aborting once it passes `max` bytes. */
async function readCapped(r: Response, max: number): Promise<string> {
  const len = r.headers.get("content-length");
  if (len !== null && Number(len) > max) {
    await r.body?.cancel().catch(() => {});
    throw new Error("too large");
  }
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let have = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    have += value.byteLength;
    if (have > max) {
      await reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))).toString("utf8");
}

export interface MessageQuery {
  chatGuid?: string;
  /** Epoch ms (exclusive bounds, BlueBubbles' `after` / `before`). */
  after?: number;
  before?: number;
  limit?: number;
  offset?: number;
  sort?: "ASC" | "DESC";
  with?: string[];
}

export class BlueBubblesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly password: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  /** The full URL for `path` (password in the query). Never leaves this class. */
  private url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(`${this.baseUrl.replace(/\/+$/, "")}/api/v1/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    u.searchParams.set("password", this.password);
    return u.toString();
  }

  private async call(op: string, path: string, init: RequestInit & { query?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
    const { query, timeoutMs, ...rest } = init;
    let r: Response;
    try {
      r = await this.fetchImpl(this.url(path, query), {
        ...rest,
        redirect: "manual",
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch (e) {
      // A transport error can carry the request URL in its message: never surface it.
      const name = e instanceof Error ? e.name : "error";
      throw new BlueBubblesError(op, null, name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable");
    }
    return r;
  }

  /**
   * JSON envelope `{status, message, data, metadata}` → data; anything else throws (review I8:
   * a non-BlueBubbles service on the port must never read as "BlueBubbles, no messages"). The
   * body is read with a byte cap (I7) — never an unbounded `r.json()`.
   */
  private async json<T>(op: string, path: string, init: RequestInit & { query?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {}): Promise<{ data: T; metadata?: Record<string, unknown> }> {
    const { maxBytes, ...rest } = init;
    const r = await this.call(op, path, rest);
    const text = await readCapped(r, maxBytes ?? DEFAULT_MAX_BODY).catch(() => {
      throw new BlueBubblesError(op, r.status, "response too large or unreadable");
    });
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const env = (body && typeof body === "object" && !Array.isArray(body) ? body : null) as
      { status?: unknown; data?: unknown; metadata?: Record<string, unknown>; error?: { type?: string; message?: string } | string; message?: string } | null;
    if (!r.ok) {
      const err = typeof env?.error === "string" ? env.error : env?.error?.type ?? env?.error?.message ?? env?.message;
      const e = new BlueBubblesError(op, r.status, typeof err === "string" ? err : undefined);
      (e as BlueBubblesError & { data?: unknown }).data = env?.data;
      throw e;
    }
    // A BlueBubbles success is exactly {status: 200, data: …}.
    if (!env || env.status !== 200 || !("data" in env)) throw new BlueBubblesError(op, r.status, "not a BlueBubbles response");
    const metadata = env.metadata && typeof env.metadata === "object" ? env.metadata : undefined;
    return { data: env.data as T, ...(metadata ? { metadata } : {}) };
  }

  /** A list endpoint's data must be an array (else this is not the BlueBubbles we expect). */
  private list<T>(op: string, data: unknown): T[] {
    if (!Array.isArray(data)) throw new BlueBubblesError(op, 200, "not a BlueBubbles response");
    return data as T[];
  }

  /** GET /api/v1/ping — answers exactly `data: "pong"` (GeneralRouter.ping). */
  async ping(): Promise<void> {
    const { data } = await this.json<unknown>("ping", "ping");
    if (data !== "pong") throw new BlueBubblesError("ping", 200, "not a BlueBubbles response");
  }

  /** GET /api/v1/server/info — the server's identity (GeneralInterface.getServerMetadata). */
  async serverInfo(): Promise<{ serverVersion: string; osVersion: string; privateApi: boolean }> {
    const { data } = await this.json<Record<string, unknown>>("server/info", "server/info");
    if (!data || typeof data !== "object" || typeof data.server_version !== "string" || typeof data.os_version !== "string" || typeof data.private_api !== "boolean")
      throw new BlueBubblesError("server/info", 200, "not a BlueBubbles response");
    return { serverVersion: data.server_version, osVersion: data.os_version, privateApi: data.private_api };
  }

  /** POST /api/v1/chat/query — chats with participants (+ the last message). */
  async queryChats(opts: { offset?: number; limit?: number; withLastMessage?: boolean } = {}): Promise<BbChat[]> {
    const body: Record<string, unknown> = { offset: opts.offset ?? 0, limit: opts.limit ?? 1000, with: ["participants", ...(opts.withLastMessage ? ["lastmessage"] : [])] };
    if (opts.withLastMessage) body.sort = "lastmessage";
    const { data } = await this.json<BbChat[]>("chat/query", "chat/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return this.list<BbChat>("chat/query", data).filter((c) => c && typeof c.guid === "string");
  }

  /** GET /api/v1/chat/:guid?with=participants,lastmessage — one chat, or null (404). */
  async getChat(guid: string): Promise<BbChat | null> {
    try {
      const { data } = await this.json<BbChat>("chat", `chat/${encodeURIComponent(guid)}`, { query: { with: "participants,lastmessage" } });
      return data && typeof data.guid === "string" ? data : null;
    } catch (e) {
      if (e instanceof BlueBubblesError && e.status === 404) return null;
      throw e;
    }
  }

  /** POST /api/v1/message/query — messages (with chats + attachments by default). */
  async queryMessages(q: MessageQuery): Promise<{ messages: BbMessage[]; total: number | null }> {
    const body: Record<string, unknown> = {
      limit: Math.max(1, Math.min(1000, Math.floor(q.limit ?? 100))),
      offset: Math.max(0, Math.floor(q.offset ?? 0)),
      sort: q.sort ?? "DESC",
      with: q.with ?? ["chat", "chat.participants", "attachment", "handle"],
    };
    if (q.chatGuid) body.chatGuid = q.chatGuid;
    if (q.after !== undefined) body.after = Math.max(0, Math.floor(q.after));
    if (q.before !== undefined) body.before = Math.max(1, Math.floor(q.before));
    const { data, metadata } = await this.json<BbMessage[]>("message/query", "message/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const total = typeof metadata?.total === "number" ? metadata.total : null;
    return { messages: this.list<BbMessage>("message/query", data).filter((m) => m && typeof m.guid === "string"), total };
  }

  /** GET /api/v1/message/:guid — one message (with its chats + attachments), or null (404). */
  async getMessage(guid: string): Promise<BbMessage | null> {
    try {
      const { data } = await this.json<BbMessage>("message", `message/${encodeURIComponent(guid)}`, { query: { with: "chats,chats.participants,attachment" } });
      return data && typeof data.guid === "string" ? data : null;
    } catch (e) {
      if (e instanceof BlueBubblesError && e.status === 404) return null;
      throw e;
    }
  }

  /** POST /api/v1/contact/query — the Mac's Contacts for these addresses (avatars optional). */
  async queryContacts(addresses: string[], opts: { avatars?: boolean } = {}): Promise<BbContact[]> {
    if (!addresses.length) return [];
    const { data } = await this.json<BbContact[]>("contact/query", "contact/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses, ...(opts.avatars ? { extraProperties: ["avatar"] } : {}) }),
      maxBytes: opts.avatars ? 16 * 1024 * 1024 : DEFAULT_MAX_BODY,
    });
    return this.list<BbContact>("contact/query", data).filter((c) => c && typeof c === "object");
  }

  /**
   * POST /api/v1/contact/query with no addresses = every contact (ContactRouter.query). NO
   * photos (review I7: a whole address book of base64 photos is hundreds of MB); photo
   * presence is learnt per address by the media route.
   */
  async allContacts(): Promise<BbContact[]> {
    const { data } = await this.json<BbContact[]>("contact/query", "contact/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [] }),
      timeoutMs: Math.max(this.timeoutMs, 60_000),
      maxBytes: 32 * 1024 * 1024,
    });
    return this.list<BbContact>("contact/query", data).filter((c) => c && typeof c === "object").map((c) => ({ ...c, avatar: "" }));
  }

  /**
   * GET /api/v1/attachment/:guid/download — the bytes (caller streams + caps + sniffs).
   * A thumbnail asks BlueBubbles to resize (`width`/`height`, images only). Without `original`
   * BlueBubbles converts HEIC → JPEG and CAF → MP3 for us.
   */
  async downloadAttachment(guid: string, opts: { thumb?: { w: number; h: number }; signal?: AbortSignal; range?: string } = {}): Promise<Response> {
    const query: Record<string, string> = {};
    if (opts.thumb) {
      query.width = String(Math.trunc(opts.thumb.w));
      query.height = String(Math.trunc(opts.thumb.h));
    }
    return this.call("attachment/download", `attachment/${encodeURIComponent(guid)}/download`, {
      query,
      ...(opts.range ? { headers: { Range: opts.range } } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * POST /api/v1/message/text, method apple-script (no Private API: SIP stays on, D6).
   * `tempGuid` is REQUIRED by apple-script and dedupes only while a send is in flight
   * (BlueBubbles' sendCache) — durable idempotency is ours (bluebubbles/send.ts).
   */
  async sendText(p: { chatGuid: string; tempGuid: string; message: string }): Promise<BbMessage> {
    const { data } = await this.json<BbMessage>("message/text", "message/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatGuid: p.chatGuid, tempGuid: p.tempGuid, message: p.message, method: "apple-script" }),
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
    return data;
  }

  /** POST /api/v1/message/attachment (multipart: `attachment`, `name`, `chatGuid`, `tempGuid`, method apple-script). */
  async sendAttachment(p: { chatGuid: string; tempGuid: string; name: string; mime: string; bytes: Uint8Array; isAudioMessage?: boolean }): Promise<BbMessage> {
    const form = new FormData();
    form.set("chatGuid", p.chatGuid);
    form.set("tempGuid", p.tempGuid);
    form.set("name", p.name);
    form.set("method", "apple-script");
    if (p.isAudioMessage) form.set("isAudioMessage", "true");
    form.set("attachment", new Blob([p.bytes], { type: p.mime }), p.name);
    const { data } = await this.json<BbMessage>("message/attachment", "message/attachment", { method: "POST", body: form, timeoutMs: Math.max(this.timeoutMs, 300_000) });
    return data;
  }
}
