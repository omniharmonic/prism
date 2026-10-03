/**
 * Attachments + link previews (group 2B: image/file/media blocks, page covers,
 * bookmark cards). Mounted in the gateway BEFORE the owner passthrough, so the
 * owner's `POST /api/notes/:id/attachments` is handled here, not proxied.
 *
 *   POST /api/notes/:id/attachments[?kind=image|file]   multipart `file` → 201 {id,url,name,mimeType,size}
 *   GET  /api/attachments/:id                            the bytes, after a VIEW check on the owning note
 *   GET  /api/unfurl?u=<url>                             {url,title,description,siteName,image,favicon}
 *
 * STORAGE is the Parachute vault (`/storage/upload` + `/notes/:id/attachments`,
 * so vault backups include the bytes); `prism_attachments` (src/attachments.ts)
 * is only the id → (vault, note, storage path, type) index.
 *
 * An upload does NOT write the note's content: the client inserts the node
 * itself through its normal (CAS / live-collab) save, so this route makes no
 * history version and needs no `if_updated_at`.
 *
 * SECURITY.
 * - Upload: signed-in user or capability link with `edit` on the note (view
 *   missing → 404 identical to a nonexistent note; view but no edit → 403);
 *   in-process MCP refused; trashed → 404; locked (non-admin) → 409.
 *   CSRF: multipart only, a custom `X-Prism-Upload: 1` header (forces a CORS
 *   preflight a cross-site form can't pass), Sec-Fetch-Site / Origin checks
 *   unless a `pd_` device bearer. Body capped while streaming (hono body-limit).
 * - Type by MAGIC BYTES only (media/sniff-file.ts); SVG/HTML/XML/script refused
 *   by content and by extension; unknown bytes are kept as an octet-stream
 *   download. The vault file name is server-chosen (`upload.<ext>`).
 * - Read: the attachment's own vault must be the actor's (the server owner may
 *   read any); non-admins need `view` on the owning note (private-note rule
 *   included via effectiveCaps); trashed/deleted → 404. Responses are rebuilt:
 *   sniffed type, nosniff, `default-src 'none'; sandbox` CSP (PDF:
 *   `frame-ancestors 'self'` + XFO SAMEORIGIN so the PWA can preview it),
 *   inline only for image/audio/video/pdf, CORP same-origin, private cache.
 * - Unfurl: signed-in people only (no links/anon/MCP), the media proxy's SSRF
 *   policy (netguard + guardedFetch), 1 MB, a linear HTML scan, one generic
 *   `refused` after the pre-network URL check.
 */
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config";
import { resolveVaultEntry } from "../db";
import type { VaultEntry } from "../config";
import { vaultClient, VaultError, type Note } from "../parachute";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { effectiveCaps, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import { isNoteId } from "../collab";
import { consumeRateLimit } from "../middleware/ratelimit";
import { isLocked, isTrashed } from "@prism/core/pages";
import {
  contentDisposition,
  getAttachment,
  insertAttachment,
  newAttachmentId,
  sanitizeName,
  vaultAttach,
  vaultStorageFetch,
  vaultUpload,
  VaultIoError,
} from "../attachments";
import { ATTACHMENT_EXT, hasBlockedExtension, IMAGE_TYPES, isInlineType, looksActive, sniffAttachment, type AttachmentType } from "../media/sniff-file";
import { FetchError, guardedFetch, type Transport } from "../media/fetcher";
import { GuardError, parseTarget, type TargetPolicy } from "../media/netguard";
import { parseUnfurl, type UnfurlMeta } from "../media/unfurl-parse";

const envNum = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return process.env[k] !== undefined && process.env[k] !== "" && Number.isFinite(v) ? v : d;
};
const envList = (k: string): string[] =>
  (process.env[k] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export interface AttachmentsConfig {
  maxBytes: number;
  maxImageBytes: number;
  uploadsPerMinute: number;
  readsPerMinute: number;
  unfurlPerMinute: number;
  unfurlMaxBytes: number;
  unfurlTimeoutMs: number;
  httpHosts: string[];
  extraPorts: number[];
  transport?: Transport;
}
function envConfig(): AttachmentsConfig {
  return {
    maxBytes: envNum("ATTACHMENT_MAX_BYTES", 25 * 1024 * 1024),
    maxImageBytes: envNum("ATTACHMENT_IMAGE_MAX_BYTES", 10 * 1024 * 1024),
    uploadsPerMinute: envNum("ATTACHMENT_UPLOADS_PER_MINUTE", 30),
    readsPerMinute: envNum("ATTACHMENT_READS_PER_MINUTE", 1200),
    unfurlPerMinute: envNum("UNFURL_PER_MINUTE", 60),
    unfurlMaxBytes: envNum("UNFURL_MAX_BYTES", 1024 * 1024),
    unfurlTimeoutMs: envNum("UNFURL_TIMEOUT_MS", 8_000),
    httpHosts: envList("MEDIA_PROXY_HTTP_HOSTS"),
    extraPorts: envList("MEDIA_PROXY_PORTS").map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536),
  };
}
let cfg = envConfig();

/** Test seam: override config (null = env) and clear the caches. */
export function configureAttachments(over: Partial<AttachmentsConfig> | null): void {
  cfg = over ? { ...envConfig(), ...over } : envConfig();
  noteCache.clear();
  unfurlCache.clear();
  unfurlInflight.clear();
  unfurlFailures.clear();
}

// ── shared helpers ───────────────────────────────────────────────────────────

const ref = (n: Pick<Note, "id" | "tags" | "metadata">): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
});
const actorSubject = (a: Actor): string | null => (a.kind === "user" ? a.email : a.kind === "link" ? a.capabilityId : null);
const capsFor = (actor: Actor, note: NoteRef): Set<Cap> => effectiveCaps(actor.grants, note, roleFloor(actor.role), actorSubject(actor));
const isAdmin = (a: Actor) => roleAtLeast(a.role, "admin");
const isServerOwner = (a: Actor) => a.kind === "user" && a.email.toLowerCase() === config.ownerEmail.toLowerCase();
const entryFor = (c: Context, a: Actor): VaultEntry =>
  isAdmin(a) ? resolveVaultEntry(c.req.header("x-prism-vault")) : resolveVaultEntry(a.vaultId);
const actorKey = (a: Actor): string => (a.kind === "user" ? `u:${a.email.toLowerCase()}` : a.kind === "link" ? `l:${a.capabilityId}` : "anon");
const NOT_FOUND = { error: "not_found" } as const;

function rateLimited(c: Context, key: string, max: number): Response | null {
  const retry = consumeRateLimit(key, max, 60_000);
  if (retry === null) return null;
  c.header("Retry-After", String(retry));
  return c.json({ error: "rate_limited", retryAfter: retry }, 429);
}

/** Owning-note cache for reads (≤ 30 s): an image-heavy page doesn't re-read its note per image. */
const NOTE_TTL_MS = 30_000;
const noteCache = new Map<string, { note: Note | null; expires: number }>();
async function owningNote(vaultId: string, noteId: string): Promise<Note | null> {
  const key = `${vaultId}\u0000${noteId}`;
  const hit = noteCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.note;
  let note: Note | null;
  try {
    note = await vaultClient(vaultId, { timeoutMs: 10_000 }).getNote(noteId);
    if (note.id !== noteId) note = null;
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) note = null;
    else throw e;
  }
  if (noteCache.size > 2000) noteCache.clear();
  noteCache.set(key, { note, expires: Date.now() + NOTE_TTL_MS });
  return note;
}

export const attachmentsApi = new Hono();

// ── POST /notes/:id/attachments ─────────────────────────────────────────────

function uploadKind(c: Context): "image" | "file" | null {
  const k = c.req.query("kind");
  if (k === undefined || k === "" || k === "file") return "file";
  return k === "image" ? "image" : null;
}

/** Auth + CSRF + rate limit, all before a byte of the body is read. */
async function uploadGate(c: Context, next: Next) {
  const via = requestVia(c);
  if (via === "mcp") return c.json({ error: "forbidden", detail: "agents cannot upload attachments" }, 403);
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "multipart/form-data") return c.json({ error: "unsupported_media_type", detail: "Content-Type must be multipart/form-data" }, 415);
  if (c.req.header("x-prism-upload") !== "1") return c.json({ error: "csrf_refused", detail: "missing X-Prism-Upload header" }, 403);
  if (via !== "device") {
    const site = (c.req.header("sec-fetch-site") ?? "").toLowerCase();
    if (site === "cross-site" || site === "same-site") return c.json({ error: "csrf_refused", detail: "cross-site request refused" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const o = origin.replace(/\/+$/, "");
      if (o !== config.appOrigin && !config.nativeOrigins.includes(o)) return c.json({ error: "csrf_refused", detail: "request origin not allowed" }, 403);
    }
  }
  if (!uploadKind(c)) return c.json({ error: "bad_request", detail: "kind must be image or file" }, 400);
  const limited = rateLimited(c, `attach-up:${actorKey(actor)}`, cfg.uploadsPerMinute);
  if (limited) return limited;
  return next();
}

const limitFor = (c: Context): number => (uploadKind(c) === "image" ? cfg.maxImageBytes : cfg.maxBytes);
// Multipart framing adds a little over the file itself.
const FRAMING = 16 * 1024;

attachmentsApi.post(
  "/notes/:id/attachments",
  uploadGate,
  (c, next) => {
    const limit = limitFor(c);
    return bodyLimit({ maxSize: limit + FRAMING, onError: (cc) => cc.json({ error: "too_large", limit }, 413) })(c, next);
  },
  async (c) => {
    const actor = resolveActor(c);
    const kind = uploadKind(c)!;
    const limit = limitFor(c);
    const id = c.req.param("id");
    if (!id || !isNoteId(id)) return c.json(NOT_FOUND, 404);
    const entry = entryFor(c, actor);
    let note: Note;
    try {
      note = await vaultClient(entry.id, { timeoutMs: 15_000 }).getNote(id);
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) return c.json(NOT_FOUND, 404);
      return c.json({ error: "vault_unreachable" }, 502);
    }
    if (note.id !== id) return c.json(NOT_FOUND, 404);
    const admin = isAdmin(actor);
    if (!admin) {
      const caps = capsFor(actor, ref(note));
      if (!caps.has("view")) return c.json(NOT_FOUND, 404);
      if (isTrashed(note)) return c.json(NOT_FOUND, 404);
      if (!caps.has("edit")) return c.json({ error: "forbidden", detail: "edit access required" }, 403);
      if (isLocked(note)) return c.json({ error: "locked", detail: "this page is locked" }, 409);
    } else if (isTrashed(note)) {
      return c.json(NOT_FOUND, 404);
    }

    let form: FormData;
    try {
      form = (await c.req.formData()) as unknown as FormData;
    } catch {
      return c.json({ error: "bad_request", detail: "expected multipart/form-data with a `file` field" }, 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return c.json({ error: "bad_request", detail: "file is required" }, 400);
    const blob = file as File;
    if (blob.size === 0) return c.json({ error: "bad_request", detail: "empty file" }, 400);
    if (blob.size > limit) return c.json({ error: "too_large", limit }, 413);
    const name = sanitizeName(blob.name);
    const bytes = Buffer.from(await blob.arrayBuffer());

    let mime: AttachmentType;
    const sniffed = sniffAttachment(bytes);
    if (kind === "image") {
      if (!sniffed || !IMAGE_TYPES.has(sniffed)) return c.json({ error: "unsupported_type", detail: "only PNG, JPEG, GIF, WebP and AVIF images" }, 415);
      mime = sniffed;
    } else {
      if (hasBlockedExtension(typeof blob.name === "string" ? blob.name : "")) return c.json({ error: "unsupported_type", detail: "active content is not allowed" }, 415);
      if (!sniffed && looksActive(bytes)) return c.json({ error: "unsupported_type", detail: "active content is not allowed" }, 415);
      mime = sniffed ?? "application/octet-stream";
    }

    let storagePath: string;
    try {
      const up = await vaultUpload(entry.id, bytes, `upload.${ATTACHMENT_EXT[mime]}`);
      storagePath = up.path;
      await vaultAttach(entry.id, note.id, storagePath, mime);
    } catch (e) {
      if (e instanceof VaultIoError && e.status === 413) return c.json({ error: "too_large", limit }, 413);
      console.warn(`[attachments] vault store failed: ${(e as Error).message}`);
      return c.json({ error: "vault_unreachable" }, 502);
    }
    const attId = newAttachmentId();
    insertAttachment({
      id: attId,
      vault_id: entry.id,
      note_id: note.id,
      storage_path: storagePath,
      mime,
      size: bytes.length,
      name,
      created_by: actorKey(actor),
      created_at: new Date().toISOString(),
    });
    return c.json({ id: attId, url: `/api/attachments/${attId}`, name, mimeType: mime, size: bytes.length }, 201);
  },
);

// ── GET /attachments/:id ────────────────────────────────────────────────────

const STORAGE_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const RANGE = /^bytes=\d{0,15}-\d{0,15}$/;

attachmentsApi.get("/attachments/:id", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json(NOT_FOUND, 404);
  const limited = rateLimited(c, `attach-read:${actorKey(actor)}`, cfg.readsPerMinute);
  if (limited) return limited;
  const row = getAttachment(c.req.param("id"));
  if (!row || !STORAGE_PATH.test(row.storage_path) || row.storage_path.includes("..")) return c.json(NOT_FOUND, 404);
  if (row.vault_id !== actor.vaultId && !isServerOwner(actor)) return c.json(NOT_FOUND, 404);
  let note: Note | null;
  try {
    note = await owningNote(row.vault_id, row.note_id);
  } catch {
    return c.json({ error: "vault_unreachable" }, 502);
  }
  if (!note) return c.json(NOT_FOUND, 404);
  const adminHere = isServerOwner(actor) || (isAdmin(actor) && row.vault_id === actor.vaultId);
  if (!adminHere) {
    if (!capsFor(actor, ref(note)).has("view")) return c.json(NOT_FOUND, 404);
    if (isTrashed(note)) return c.json(NOT_FOUND, 404);
  }

  const rawRange = c.req.header("range");
  const range = rawRange && RANGE.test(rawRange.trim()) && rawRange.trim() !== "bytes=-" ? rawRange.trim() : null;
  let upstream: Response;
  try {
    upstream = await vaultStorageFetch(row.vault_id, row.storage_path, range);
  } catch {
    return c.json({ error: "vault_unreachable" }, 502);
  }
  if (upstream.status === 404) {
    await upstream.body?.cancel().catch(() => {});
    return c.json(NOT_FOUND, 404);
  }
  if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
    await upstream.body?.cancel().catch(() => {});
    return c.json({ error: "vault_unreachable" }, 502);
  }
  const pdf = row.mime === "application/pdf";
  const headers = new Headers({
    "Content-Type": row.mime,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, max-age=300",
    "Accept-Ranges": "bytes",
    "Referrer-Policy": "no-referrer",
    "Content-Disposition": contentDisposition(isInlineType(row.mime) ? "inline" : "attachment", row.name),
    "Content-Security-Policy": pdf ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; sandbox",
  });
  if (pdf) headers.set("X-Frame-Options", "SAMEORIGIN");
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (upstream.status === 416) {
    await upstream.body?.cancel().catch(() => {});
    return new Response(null, { status: 416, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});

// ── GET /unfurl ─────────────────────────────────────────────────────────────

/** A signed-in person (session / device token / loopback owner) — never a link, anon or MCP. */
function signedInKey(c: Context): string | null {
  const via = requestVia(c);
  if (via !== "session" && via !== "device" && via !== "local-token") return null;
  const actor = resolveActor(c);
  return actor.kind === "user" ? actor.email.toLowerCase() : null;
}

/** Never fetch ourselves, the vault or the hub (by name; their IPs are private anyway). */
function forbiddenHosts(): string[] {
  const out: string[] = [];
  for (const u of [config.appOrigin, config.parachuteUrl, config.hubOrigin, config.hubJwksOrigin, ...config.hubAllowedIssuers]) {
    try {
      out.push(new URL(u).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return out;
}

export interface UnfurlResult extends UnfurlMeta {
  url: string;
}
const UNFURL_TTL_MS = 10 * 60_000;
const UNFURL_MAX_ENTRIES = 500;
const unfurlCache = new Map<string, { value: UnfurlResult; expires: number }>();
const unfurlInflight = new Map<string, Promise<UnfurlResult>>();
const unfurlFailures = new Map<string, { err: unknown; until: number }>();

async function unfurl(raw: string, policy: TargetPolicy): Promise<UnfurlResult> {
  const hit = unfurlCache.get(raw);
  if (hit && hit.expires > Date.now()) {
    unfurlCache.delete(raw); // LRU touch
    unfurlCache.set(raw, hit);
    return hit.value;
  }
  const failed = unfurlFailures.get(raw);
  if (failed && failed.until > Date.now()) throw failed.err;
  const pending = unfurlInflight.get(raw);
  if (pending) return pending;
  const run = (async () => {
    try {
      const r = await guardedFetch(raw, {
        policy,
        maxBytes: cfg.unfurlMaxBytes,
        timeoutMs: cfg.unfurlTimeoutMs,
        accept: "text/html,application/xhtml+xml;q=0.9",
        transport: cfg.transport,
      });
      const type = (r.contentType.split(";")[0] ?? "").trim();
      if (type !== "text/html" && type !== "application/xhtml+xml") throw new FetchError("not_html", 415, "not an HTML page");
      const value: UnfurlResult = { url: r.url, ...parseUnfurl(r.body.toString("utf8"), r.url) };
      unfurlCache.set(raw, { value, expires: Date.now() + UNFURL_TTL_MS });
      while (unfurlCache.size > UNFURL_MAX_ENTRIES) unfurlCache.delete(unfurlCache.keys().next().value!);
      return value;
    } catch (e) {
      if (e instanceof GuardError || e instanceof FetchError) {
        if (unfurlFailures.size > 5_000) unfurlFailures.clear();
        unfurlFailures.set(raw, { err: e, until: Date.now() + 60_000 });
      }
      throw e;
    } finally {
      unfurlInflight.delete(raw);
    }
  })();
  unfurlInflight.set(raw, run);
  return run;
}

attachmentsApi.get("/unfurl", async (c) => {
  const who = signedInKey(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const limited = rateLimited(c, `unfurl:${who}`, cfg.unfurlPerMinute);
  if (limited) return limited;
  const raw = (c.req.query("u") ?? "").trim();
  const policy: TargetPolicy = { httpHosts: cfg.httpHosts, extraPorts: cfg.extraPorts, forbiddenHosts: forbiddenHosts() };
  try {
    parseTarget(raw, policy);
  } catch (e) {
    if (e instanceof GuardError) return c.json({ error: "refused", reason: e.code }, 400);
    throw e;
  }
  try {
    const value = await unfurl(raw, policy);
    c.header("Cache-Control", "private, max-age=600");
    return c.json(value);
  } catch (e) {
    if (e instanceof GuardError) {
      console.warn(`[unfurl] refused: ${e.code}`);
      return c.json({ error: "refused", reason: "refused" }, 400);
    }
    if (e instanceof FetchError) {
      const status = e.status === 404 ? 404 : e.status === 413 ? 413 : e.status === 415 ? 415 : e.status === 504 ? 504 : 502;
      return c.json({ error: "upstream", reason: e.code }, status);
    }
    console.warn("[unfurl] unexpected error:", (e as Error)?.message ?? e);
    return c.json({ error: "upstream", reason: "internal" }, 502);
  }
});
