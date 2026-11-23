/**
 * `GET /api/comms/media/:token` — stream one piece of Matrix media (or an avatar
 * thumbnail) to the owner's Comms client. Mounted inside `commsApi`
 * (routes/comms.ts), so the flag middleware applies; every request also passes
 * `requireCommsOwner` (owner, primary vault, no-store, rate limit) BEFORE the
 * token is looked at. See comms/media.ts for the token.
 *
 * Hardening: the response is rebuilt from an allowlist of upstream headers
 * (type, length, range, accept-ranges, etag — each validated); html/xml/svg/
 * script types become application/octet-stream + attachment; anything that is
 * not image/audio/video is an attachment; nosniff + a sandbox CSP always. The
 * body is streamed (never buffered), capped at MEDIA_MAX_BYTES, with a deadline
 * for the upstream's headers, an idle deadline per chunk and an overall one.
 */
import { Hono } from "hono";
import { config } from "../config";
import { requireCommsOwner } from "./guard";
import { getSecret } from "../secrets";
import { MatrixClient, type MatrixCreds } from "../worker/matrix";
import { mediaFetcherFor, parseBbRef, refreshMediaToken, verifyMediaToken, type BbRef, type Thumb } from "./media";
import { blueBubblesClient } from "../bluebubbles/config";
import { notePhotoAbsent } from "../bluebubbles/contacts";
import { BlueBubblesError } from "../bluebubbles/client";
import { looksActive, sniffAttachment, isInlineType } from "../media/sniff-file";
import { sniffRaster } from "../media/sniff";
import { AUDIO_MAX_INPUT_BYTES, cachedRendition, needsTranscode, sniffAudio, transcodeToM4a, TranscodeError } from "./audio-transcode";

export const MEDIA_MAX_BYTES = 200 * 1024 * 1024;
const HEADERS_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_STREAM_MS = 15 * 60_000;
const MEDIA_MAX_AGE_S = 21_600;
/** The media route's own rate bucket (not the JSON API's 600/min). */
const MEDIA_RATE = { bucket: "comms-media", perMinute: 3000 };

/**
 * Ask the homeserver for the bytes as stored (`Accept-Encoding: identity`).
 * undici decodes a compressed body transparently while its Content-Length stays
 * the COMPRESSED size, so forwarding it would truncate the response and the
 * up-front size check would measure the wrong number.
 */
export function withIdentityEncoding(base: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Accept-Encoding", "identity");
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

const RANGE_RE = /^bytes=(\d{1,15})?-(\d{1,15})?$/;
const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const DANGEROUS_TYPE = /html|xml|svg|script|ecmascript/;
const INLINE_TYPE = /^(image\/(png|jpeg|gif|webp|avif|heic|heif|bmp)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+)$/;
const CONTENT_RANGE_RE = /^bytes (\d{1,15}-\d{1,15}|\*)\/(\d{1,15}|\*)$/;
const ETAG_RE = /^(W\/)?"[\x21\x23-\x7e]{0,200}"$/;

/** A single, well-formed byte range, or nothing (never forward anything else). */
export function safeRange(h: string | undefined): string | undefined {
  if (!h || h.length > 64) return undefined;
  const m = RANGE_RE.exec(h.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
  if (m[1] !== undefined && m[2] !== undefined && Number(m[2]) < Number(m[1])) return undefined;
  return h.trim();
}

/** Upstream content-type → what we send + whether it must be an attachment. */
export function safeContentType(raw: string | null): { type: string; attachment: boolean } {
  const base = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  if (!TYPE_RE.test(base) || DANGEROUS_TYPE.test(base)) return { type: "application/octet-stream", attachment: true };
  return { type: base, attachment: !INLINE_TYPE.test(base) };
}

/** Wrap the upstream body: byte cap, idle deadline per read, overall deadline. */
function guardedBody(body: ReadableStream<Uint8Array>, abort: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const deadline = Date.now() + MAX_STREAM_MS;
  let sent = 0;
  const stop = (err: unknown, ctrl: ReadableStreamDefaultController<Uint8Array>) => {
    abort();
    reader.cancel().catch(() => {});
    ctrl.error(err);
  };
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const wait = Math.max(0, Math.min(IDLE_TIMEOUT_MS, deadline - Date.now()));
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("media stream timeout")), wait);
          }),
        ]);
        if (next.done) {
          ctrl.close();
          return;
        }
        sent += next.value.byteLength;
        if (sent > MEDIA_MAX_BYTES) return stop(new Error("media stream too large"), ctrl);
        ctrl.enqueue(next.value);
      } catch (e) {
        stop(e, ctrl);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel() {
      abort();
      return reader.cancel().catch(() => {});
    },
  });
}

export const commsMediaRoute = new Hono();

/** Tokens one refresh call may exchange. */
const REFRESH_MAX_TOKENS = 100;

/**
 * `POST /api/comms/media/refresh` `{tokens: string[]}` → `{tokens: {<old>: <new> | null}}`.
 * Exchanges expired media tokens (signature + device binding still checked; see
 * `refreshMediaToken`) for fresh ones; a token this credential may not refresh maps to null.
 * Owner-only like every comms route; nothing upstream is contacted.
 */
commsMediaRoute.post("/refresh", async (c) => {
  // The media bucket: a refresh rides along with the media fetches it unblocks.
  const g = requireCommsOwner(c, MEDIA_RATE);
  if (!g.ok) return g.res;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid", detail: "expected {tokens: string[]}" }, 400);
  }
  const tokens = (body as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(tokens) || tokens.length > REFRESH_MAX_TOKENS || !tokens.every((t) => typeof t === "string" && t.length <= 2048))
    return c.json({ error: "invalid", detail: `expected {tokens: string[]} (at most ${REFRESH_MAX_TOKENS})` }, 400);
  const out: Record<string, string | null> = {};
  for (const t of tokens as string[]) out[t] = refreshMediaToken(t, g.actor);
  return c.json({ tokens: out });
});

commsMediaRoute.get("/:token", async (c) => {
  const g = requireCommsOwner(c, MEDIA_RATE);
  if (!g.ok) return g.res;
  const v = verifyMediaToken(c.req.param("token"), g.actor);
  if (!v.ok) return c.json({ error: v.status === 410 ? "media_expired" : "forbidden" }, v.status);
  const bb = parseBbRef(v.claims.mxc);
  // `?format=m4a`: a rendition AVFoundation can play (Ogg/Opus, AMR, WebM → AAC); see audio-transcode.ts.
  if (c.req.query("format") === "m4a" && !v.claims.thumb) return servePlayableAudio(c, g.vaultId, v.claims.mxc, bb, v.claims.exp);
  if (bb) return serveBlueBubbles(c, bb, v.claims.thumb, v.claims.exp);

  let creds: MatrixCreds | null = null;
  try {
    creds = JSON.parse(getSecret(g.vaultId, config.ownerEmail, "matrix") ?? "null") as MatrixCreds | null;
  } catch {
    creds = null;
  }
  if (!creds?.homeserver || !creds.accessToken) return c.json({ error: "source_unconfigured" }, 503);

  const ctrl = new AbortController();
  const headersTimer = setTimeout(() => ctrl.abort(), HEADERS_TIMEOUT_MS);
  let up: Response;
  try {
    const fetcher = mediaFetcherFor(creds, (cr) => new MatrixClient(cr, withIdentityEncoding(fetch)));
    up = await fetcher.downloadMedia(v.claims.mxc, {
      ...(v.claims.thumb ? { thumb: v.claims.thumb } : {}),
      ...(safeRange(c.req.header("range")) ? { range: safeRange(c.req.header("range")) } : {}),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(headersTimer);
    ctrl.abort();
    return c.json({ error: "media_upstream" }, 502);
  } finally {
    clearTimeout(headersTimer);
  }

  const discard = () => {
    ctrl.abort();
    up.body?.cancel().catch(() => {});
  };
  if (up.status === 404) {
    discard();
    return c.json({ error: "media_unavailable" }, 404);
  }
  if (up.status === 401 || up.status === 403) {
    // The homeserver refused OUR token (expired / revoked): a config problem, like threads.ts.
    discard();
    return c.json({ error: "source_unconfigured" }, 503);
  }
  if (up.status === 416) {
    discard();
    return c.json({ error: "range_not_satisfiable" }, 416);
  }
  // Anything else — 3xx included — is an upstream failure. Redirects are
  // deliberately NOT followed (downloadMedia uses redirect: "manual"): the
  // bearer must never reach a host we did not choose.
  if ((up.status !== 200 && up.status !== 206) || !up.body) {
    discard();
    return c.json({ error: "media_upstream" }, 502);
  }
  // Despite identity, a server may still encode: then the declared length and any
  // byte range describe the ENCODED bytes, not what we stream — drop the length
  // (the streamed cap still applies) and refuse a partial response.
  const enc = up.headers.get("content-encoding");
  const encoded = !!enc && enc.trim().toLowerCase() !== "identity";
  if (encoded && up.status === 206) {
    discard();
    return c.json({ error: "media_upstream" }, 502);
  }
  const len = encoded ? null : up.headers.get("content-length");
  if (len !== null && (!/^\d{1,15}$/.test(len) || Number(len) > MEDIA_MAX_BYTES)) {
    discard();
    return c.json({ error: "media_upstream" }, 502);
  }
  const range = up.headers.get("content-range");
  if (up.status === 206 && (!range || !CONTENT_RANGE_RE.test(range))) {
    discard();
    return c.json({ error: "media_upstream" }, 502);
  }

  const ct = safeContentType(up.headers.get("content-type"));
  const maxAge = Math.max(0, Math.min(MEDIA_MAX_AGE_S, Math.floor((v.claims.exp - Date.now()) / 1000)));
  c.header("Cache-Control", `private, max-age=${maxAge}`);
  c.header("Content-Type", ct.type);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'; sandbox");
  if (ct.attachment) c.header("Content-Disposition", "attachment");
  if (len !== null) c.header("Content-Length", len);
  if (up.status === 206 && range) c.header("Content-Range", range);
  const ar = up.headers.get("accept-ranges");
  if (!encoded && (ar === "bytes" || ar === "none")) c.header("Accept-Ranges", ar);
  const etag = up.headers.get("etag");
  if (etag && ETAG_RE.test(etag)) c.header("ETag", etag);
  return c.body(guardedBody(up.body, () => ctrl.abort()), up.status as 200 | 206);
});

// ── BlueBubbles media (iMessage/SMS attachments, contact photos) ─────────────────────────────
// The bytes come from the LOCAL BlueBubbles Server (loopback, bluebubbles/config.ts). The type
// served is the one SNIFFED from the bytes (media/sniff-file.ts, like uploaded attachments) —
// never BlueBubbles' Content-Type or the file name; active content (SVG/HTML/XML/script) is
// refused; anything unrecognised is an inert octet-stream download. Same caps and deadlines as
// Matrix media (MEDIA_MAX_BYTES, idle + overall deadline).

/** Enough for every magic-byte check (incl. two MPEG frames). */
const SNIFF_BYTES = 64 * 1024;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

function hardened(c: import("hono").Context, type: string, inline: boolean, exp: number): void {
  const maxAge = Math.max(0, Math.min(MEDIA_MAX_AGE_S, Math.floor((exp - Date.now()) / 1000)));
  c.header("Cache-Control", `private, max-age=${maxAge}`);
  c.header("Content-Type", type);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'; sandbox");
  if (!inline) c.header("Content-Disposition", "attachment");
}

async function serveBlueBubbles(c: import("hono").Context, ref: BbRef, thumb: Thumb | null, exp: number): Promise<Response> {
  const client = blueBubblesClient();
  if (!client) return c.json({ error: "source_unconfigured" }, 503);
  if (ref.kind === "contact") {
    let bytes: Buffer | null = null;
    try {
      const contacts = await client.queryContacts([ref.value], { avatars: true });
      const raw = contacts.map((x) => x.avatar).find((a): a is string => typeof a === "string" && a.length > 0);
      if (raw && raw.length <= Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 4) bytes = Buffer.from(raw, "base64");
    } catch (e) {
      return c.json({ error: e instanceof BlueBubblesError && e.status === 401 ? "source_unconfigured" : "media_upstream" }, e instanceof BlueBubblesError && e.status === 401 ? 503 : 502);
    }
    const type = bytes ? sniffRaster(bytes) : null;
    if (!bytes || !type) {
      notePhotoAbsent(ref.value); // the projection stops offering this avatar (for a day)
      return c.json({ error: "media_unavailable" }, 404);
    }
    hardened(c, type, true, exp);
    c.header("Content-Length", String(bytes.length));
    return c.body(new Uint8Array(bytes), 200);
  }

  const ctrl = new AbortController();
  const headersTimer = setTimeout(() => ctrl.abort(), HEADERS_TIMEOUT_MS);
  let up: Response;
  try {
    up = await client.downloadAttachment(ref.value, { ...(thumb ? { thumb } : {}), signal: ctrl.signal });
  } catch {
    ctrl.abort();
    return c.json({ error: "media_upstream" }, 502);
  } finally {
    clearTimeout(headersTimer);
  }
  const discard = () => {
    ctrl.abort();
    up.body?.cancel().catch(() => {});
  };
  if (up.status === 404) {
    discard();
    return c.json({ error: "media_unavailable" }, 404);
  }
  if (up.status === 401 || up.status === 403) {
    discard();
    return c.json({ error: "source_unconfigured" }, 503);
  }
  if (up.status !== 200 || !up.body) {
    discard();
    return c.json({ error: "media_upstream" }, 502);
  }
  const len = up.headers.get("content-length");
  if (len !== null && (!/^\d{1,15}$/.test(len) || Number(len) > MEDIA_MAX_BYTES)) {
    discard();
    return c.json({ error: "too_large" }, 502);
  }
  // Read the head for the sniff, then stream head + the rest through the guarded body.
  const reader = up.body.getReader();
  const chunks: Uint8Array[] = [];
  let have = 0;
  try {
    while (have < SNIFF_BYTES) {
      let timer: NodeJS.Timeout | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), IDLE_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) break;
      chunks.push(next.value);
      have += next.value.byteLength;
      if (have > MEDIA_MAX_BYTES) throw new Error("too large");
    }
  } catch {
    ctrl.abort();
    reader.cancel().catch(() => {});
    return c.json({ error: "media_upstream" }, 502);
  }
  const head = Buffer.concat(chunks.map((u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength)));
  const sniffed = sniffAttachment(head);
  if (!sniffed && looksActive(head)) {
    ctrl.abort();
    reader.cancel().catch(() => {});
    return c.json({ error: "unsupported_type" }, 415);
  }
  const type = sniffed ?? "application/octet-stream";
  let sentHead = false;
  const joined = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (!sentHead) {
        sentHead = true;
        if (head.length) {
          ctl.enqueue(new Uint8Array(head));
          return;
        }
      }
      const next = await reader.read();
      if (next.done) ctl.close();
      else ctl.enqueue(next.value);
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });
  hardened(c, type, isInlineType(type) && type !== "application/pdf", exp);
  if (len !== null) c.header("Content-Length", len);
  return c.body(guardedBody(joined, () => ctrl.abort()), 200);
}

// ── playable audio (owner-testing round 4) ───────────────────────────────────────────────────

/** Read a whole upstream body, capped, with an idle deadline per chunk. Null = too large / stalled. */
async function readAllCapped(body: ReadableStream<Uint8Array>, max: number, abort: () => void): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let have = 0;
  const deadline = Date.now() + MAX_STREAM_MS;
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), Math.max(0, Math.min(IDLE_TIMEOUT_MS, deadline - Date.now()))); }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) return Buffer.concat(chunks);
      have += next.value.byteLength;
      if (have > max) throw new Error("too large");
      chunks.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength));
    }
  } catch {
    abort();
    reader.cancel().catch(() => {});
    return null;
  }
}

/** The original bytes + the type the source declared, or an error response. */
async function originalBytes(c: import("hono").Context, vaultId: string, mxc: string, bb: BbRef | null): Promise<{ bytes: Buffer; declared: string | null } | Response> {
  const ctrl = new AbortController();
  const headersTimer = setTimeout(() => ctrl.abort(), HEADERS_TIMEOUT_MS);
  let up: Response;
  try {
    if (bb) {
      if (bb.kind === "contact") return c.json({ error: "unsupported_type" }, 415);
      const client = blueBubblesClient();
      if (!client) return c.json({ error: "source_unconfigured" }, 503);
      up = await client.downloadAttachment(bb.value, { signal: ctrl.signal });
    } else {
      let creds: MatrixCreds | null = null;
      try {
        creds = JSON.parse(getSecret(vaultId, config.ownerEmail, "matrix") ?? "null") as MatrixCreds | null;
      } catch {
        creds = null;
      }
      if (!creds?.homeserver || !creds.accessToken) return c.json({ error: "source_unconfigured" }, 503);
      up = await mediaFetcherFor(creds, (cr) => new MatrixClient(cr, withIdentityEncoding(fetch))).downloadMedia(mxc, { signal: ctrl.signal });
    }
  } catch (e) {
    ctrl.abort();
    if (e instanceof BlueBubblesError && e.status === 401) return c.json({ error: "source_unconfigured" }, 503);
    return c.json({ error: "media_upstream" }, 502);
  } finally {
    clearTimeout(headersTimer);
  }
  const discard = () => {
    ctrl.abort();
    up.body?.cancel().catch(() => {});
  };
  if (up.status === 404) { discard(); return c.json({ error: "media_unavailable" }, 404); }
  if (up.status === 401 || up.status === 403) { discard(); return c.json({ error: "source_unconfigured" }, 503); }
  if (up.status !== 200 || !up.body) { discard(); return c.json({ error: "media_upstream" }, 502); }
  const len = up.headers.get("content-length");
  if (len !== null && /^\d{1,15}$/.test(len) && Number(len) > AUDIO_MAX_INPUT_BYTES) { discard(); return c.json({ error: "too_large" }, 413); }
  const bytes = await readAllCapped(up.body, AUDIO_MAX_INPUT_BYTES, () => ctrl.abort());
  if (!bytes) return c.json({ error: "too_large" }, 413);
  return { bytes, declared: up.headers.get("content-type") };
}

function sendAudio(c: import("hono").Context, bytes: Buffer, type: string, exp: number): Response {
  hardened(c, type, true, exp);
  c.header("Accept-Ranges", "bytes");
  const range = safeRange(c.req.header("range"));
  const m = range ? RANGE_RE.exec(range) : null;
  if (m) {
    const size = bytes.length;
    let start = m[1] !== undefined ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] !== undefined && m[2] !== undefined ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (m[1] === undefined) end = size - 1;
    if (start >= size || start > end) {
      c.header("Content-Range", `bytes */${size}`);
      return c.json({ error: "range_not_satisfiable" }, 416);
    }
    start = Math.max(0, start);
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(end - start + 1));
    return c.body(new Uint8Array(bytes.subarray(start, end + 1)), 206);
  }
  c.header("Content-Length", String(bytes.length));
  return c.body(new Uint8Array(bytes), 200);
}

async function servePlayableAudio(c: import("hono").Context, vaultId: string, mxc: string, bb: BbRef | null, exp: number): Promise<Response> {
  // A rendition made earlier: no upstream call at all.
  const cached = await cachedRendition(mxc);
  if (cached) return sendAudio(c, cached, "audio/mp4", exp);
  const orig = await originalBytes(c, vaultId, mxc, bb);
  if (orig instanceof Response) return orig;
  const head = orig.bytes.subarray(0, 64);
  if (!needsTranscode(head, orig.declared)) {
    // Already playable (AAC/MP4, MP3, CAF, WAV, …): the original, typed by its bytes.
    const type = sniffAudio(head);
    if (!type) return c.json({ error: "unsupported_type" }, 415);
    return sendAudio(c, orig.bytes, type, exp);
  }
  try {
    return sendAudio(c, await transcodeToM4a(mxc, orig.bytes), "audio/mp4", exp);
  } catch (e) {
    const code = e instanceof TranscodeError ? e.code : "failed";
    if (code === "too_large") return c.json({ error: "too_large" }, 413);
    if (code === "unavailable") return c.json({ error: "transcode_unavailable" }, 503);
    if (code === "busy") return c.json({ error: "busy" }, 503);
    console.warn(`[comms-media] audio transcode ${code}`);
    return c.json({ error: "transcode_failed" }, 422);
  }
}
