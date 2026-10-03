/**
 * Attachments + link previews (group 2B: image/file/media blocks, page covers,
 * bookmark cards). Mounted in the gateway BEFORE the owner passthrough, so the
 * owner's `POST /api/notes/:id/attachments` is handled here, not proxied.
 *
 *   POST /api/notes/:id/attachments[?kind=image|file]   multipart `file` → 201 {id,url,name,mimeType,size}
 *   GET  /api/attachments/:id                            the bytes, after a VIEW check on the owning note
 *   GET  /api/unfurl?u=<url>                             {url,title,description,siteName,image,favicon}
 *   POST /api/attachments/sweep {dryRun=true,limit?,cursor?}   server owner: find unreferenced attachments
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
 * - Read is authorized against the ATTACHMENT ROW's vault, not the request's:
 *   an <img>/<video> element cannot send `X-Prism-Vault`, so the caller's role
 *   and grants are re-derived for `row.vault_id` (a capability link must belong
 *   to that vault; an in-process MCP actor must already be bound to it).
 * - A top-level navigation (`Sec-Fetch-Dest: document`) is always a download.
 *   Responses revalidate (`private, no-cache` + ETag, `Vary: Authorization,
 *   Cookie`); the owning note is cached ≤ 5 s.
 *
 * MEMORY + QUOTAS. The vault's `/storage/upload` takes multipart only, so an
 * upload is BUFFERED once: hono parses the request into a File (≤ the size cap,
 * enforced by hono/body-limit while streaming) and that same Blob is handed to
 * the outgoing FormData — no extra Buffer copy; sniffing reads a 64 KB slice.
 * Hence a small global concurrency cap (`ATTACHMENT_MAX_CONCURRENT_UPLOADS`, 2;
 * bounded wait → 503 `busy`): worst-case resident upload bytes ≈ cap × 25 MB.
 * Quotas come from `prism_attachments.size`: per note (250 MB) and per vault
 * (5 GB) → 413 `quota_exceeded` + scope. CAPABILITY-LINK uploads (an "anyone
 * with the link can edit" share) get a smaller cap (5 MB) and rate (6/min per
 * link) — a link is not an accountable person.
 *
 * PURGE. A page's attachments are released only AFTER the vault deleted the page
 * (`purgeAttachmentsForNote(…, {noteGone:true})` from pages.ts): a failed delete
 * leaves the page restorable with its media. The vault keeps the stored files of
 * a deleted note, so those rows become recorded orphans (`orphan_note_deleted`,
 * never served) which the sweep reports as `recorded`. A failed attach after a successful upload is
 * recorded (`orphan_attach_failed`). The owner sweep flags attachments no longer
 * referenced by their note (`orphan_unreferenced`) — it never deletes bytes (a
 * block can come back from version history) and flagged rows stay servable.
 *
 * - Unfurl: signed-in people only (no links/anon/MCP), the media proxy's SSRF
 *   policy (netguard + guardedFetch) inside the media proxy's in-flight pools,
 *   1 MB, a linear HTML scan, one generic `refused` after the pre-network URL
 *   check. `image`/`favicon` come back as SAME-ORIGIN proxied paths
 *   (`/api/media/proxy?u=…`) — a raw third-party URL is never handed out to be
 *   written into a shared document.
 */
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config";
import { grantsForUser, resolveVaultEntry } from "../db";
import type { VaultEntry } from "../config";
import { vaultClient, VaultError, type Note } from "../parachute";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { effectiveCaps, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor, workspaceRole } from "../roles";
import { csrfRefusal } from "./actions";
import { BusyError, Semaphore } from "../media/limits";
import { mediaPolicy, withMediaSlot } from "./media";
import { isNoteId } from "../collab";
import { consumeRateLimit } from "../middleware/ratelimit";
import { isLocked, isTrashed, systemNoteReason } from "@prism/core/pages";
import {
  contentDisposition,
  getAttachment,
  insertAttachment,
  liveRowsPage,
  newAttachmentId,
  recordOrphan,
  recordedOrphans,
  sanitizeName,
  setAttachmentStatus,
  usedBytes,
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
  /** Capability-link uploads: smaller cap, lower rate (keyed by the link). */
  linkMaxBytes: number;
  linkUploadsPerMinute: number;
  noteQuotaBytes: number;
  vaultQuotaBytes: number;
  maxConcurrentUploads: number;
  uploadWaitMs: number;
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
    linkMaxBytes: envNum("ATTACHMENT_LINK_MAX_BYTES", 5 * 1024 * 1024),
    linkUploadsPerMinute: envNum("ATTACHMENT_LINK_UPLOADS_PER_MINUTE", 6),
    noteQuotaBytes: envNum("ATTACHMENT_NOTE_QUOTA_BYTES", 250 * 1024 * 1024),
    vaultQuotaBytes: envNum("ATTACHMENT_VAULT_QUOTA_BYTES", 5 * 1024 * 1024 * 1024),
    maxConcurrentUploads: Math.max(1, envNum("ATTACHMENT_MAX_CONCURRENT_UPLOADS", 2)),
    uploadWaitMs: envNum("ATTACHMENT_UPLOAD_WAIT_MS", 10_000),
    readsPerMinute: envNum("ATTACHMENT_READS_PER_MINUTE", 1200),
    unfurlPerMinute: envNum("UNFURL_PER_MINUTE", 60),
    unfurlMaxBytes: envNum("UNFURL_MAX_BYTES", 1024 * 1024),
    unfurlTimeoutMs: envNum("UNFURL_TIMEOUT_MS", 8_000),
    httpHosts: envList("MEDIA_PROXY_HTTP_HOSTS"),
    extraPorts: envList("MEDIA_PROXY_PORTS").map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536),
  };
}
let cfg = envConfig();
let uploadSlots = new Semaphore(cfg.maxConcurrentUploads, 16);

/** Test seam: override config (null = env) and clear the caches. */
export function configureAttachments(over: Partial<AttachmentsConfig> | null): void {
  cfg = over ? { ...envConfig(), ...over } : envConfig();
  uploadSlots = new Semaphore(cfg.maxConcurrentUploads, 16);
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

/**
 * Owning-note cache for reads (≤ 5 s): an image-heavy page doesn't re-read its
 * note per image, and a revoked grant / trashed page stops serving within 5 s
 * (grants themselves are read fresh on every request).
 */
const NOTE_TTL_MS = 5_000;
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

/**
 * The caller as seen by `vaultId` — the vault an attachment lives in. A signed-in
 * person gets their role + grants IN THAT VAULT (no membership and no grants there
 * → a guest with nothing, so the view check fails → 404). A capability link is
 * bound to its own grants' vault. An in-process MCP actor is never re-bound (a PAT
 * is tied to one vault). null = not this vault.
 */
function actorInVault(c: Context, actor: Actor, vaultId: string): Actor | null {
  if (actor.vaultId === vaultId) return actor;
  if (actor.kind !== "user" || requestVia(c) === "mcp") return null;
  return { ...actor, vaultId, role: workspaceRole(actor.email, vaultId), grants: grantsForUser(actor.email, vaultId) };
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
  const limited = rateLimited(c, `attach-up:${actorKey(actor)}`, actor.kind === "link" ? cfg.linkUploadsPerMinute : cfg.uploadsPerMinute);
  if (limited) return limited;
  return next();
}

const limitFor = (c: Context): number => {
  const base = uploadKind(c) === "image" ? cfg.maxImageBytes : cfg.maxBytes;
  return resolveActor(c).kind === "link" ? Math.min(base, cfg.linkMaxBytes) : base;
};
/** Enough for every magic-byte check (incl. two MPEG frames) without copying the whole file. */
const SNIFF_BYTES = 64 * 1024;
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
      // True system notes (agent, alert, governance) take no uploads from non-owners.
      if (systemNoteReason(note)) return c.json({ error: "protected", detail: "this is a system note" }, 403);
      if (isLocked(note)) return c.json({ error: "locked", detail: "this page is locked" }, 409);
    } else if (isTrashed(note)) {
      return c.json(NOT_FOUND, 404);
    }

    // Quota pre-check from the declared length (cheap refusal before buffering);
    // re-checked with the real size below.
    const quota = (size: number): "note" | "vault" | null =>
      usedBytes(entry.id, note.id) + size > cfg.noteQuotaBytes ? "note" : usedBytes(entry.id) + size > cfg.vaultQuotaBytes ? "vault" : null;
    const full = quota(1);
    if (full) return c.json({ error: "quota_exceeded", scope: full }, 413);

    // The body is buffered (see the header): bound how many uploads are resident at once.
    let release: () => void;
    try {
      release = await uploadSlots.acquire(cfg.uploadWaitMs);
    } catch (e) {
      if (e instanceof BusyError) {
        c.header("Retry-After", "5");
        return c.json({ error: "busy" }, 503);
      }
      throw e;
    }
    try {
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
      const over = quota(blob.size);
      if (over) return c.json({ error: "quota_exceeded", scope: over }, 413);
      const name = sanitizeName(blob.name);
      const head = Buffer.from(await blob.slice(0, SNIFF_BYTES).arrayBuffer());

      let mime: AttachmentType;
      const sniffed = sniffAttachment(head);
      if (kind === "image") {
        if (!sniffed || !IMAGE_TYPES.has(sniffed)) return c.json({ error: "unsupported_type", detail: "only PNG, JPEG, GIF, WebP and AVIF images" }, 415);
        mime = sniffed;
      } else {
        if (hasBlockedExtension(typeof blob.name === "string" ? blob.name : "")) return c.json({ error: "unsupported_type", detail: "active content is not allowed" }, 415);
        if (!sniffed && looksActive(head)) return c.json({ error: "unsupported_type", detail: "active content is not allowed" }, 415);
        mime = sniffed ?? "application/octet-stream";
      }

      const attId = newAttachmentId();
      const row = {
        id: attId,
        vault_id: entry.id,
        note_id: note.id,
        storage_path: "",
        mime,
        size: blob.size,
        name,
        created_by: actorKey(actor),
        created_at: new Date().toISOString(),
      };
      try {
        const up = await vaultUpload(entry.id, blob, `upload.${ATTACHMENT_EXT[mime]}`);
        row.storage_path = up.path;
      } catch (e) {
        if (e instanceof VaultIoError && e.status === 413) return c.json({ error: "too_large", limit }, 413);
        console.warn(`[attachments] vault upload failed: ${(e as Error).message}`);
        return c.json({ error: "vault_unreachable" }, 502);
      }
      let vaultAttachmentId: string;
      try {
        vaultAttachmentId = (await vaultAttach(entry.id, note.id, row.storage_path, mime)).id;
      } catch (e) {
        // The bytes are in vault storage with no attachment row (no REST delete for
        // storage): record it so the owner's sweep can report it.
        try { recordOrphan(row); } catch { /* best-effort */ }
        console.warn(`[attachments] vault attach failed (orphan recorded ${attId}): ${(e as Error).message}`);
        return c.json({ error: "vault_unreachable" }, 502);
      }
      insertAttachment({ ...row, vault_attachment_id: vaultAttachmentId || null });
      return c.json({ id: attId, url: `/api/attachments/${attId}`, name, mimeType: mime, size: blob.size }, 201);
    } finally {
      release();
    }
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
  // Authorize against the ROW's vault: media elements can't send X-Prism-Vault.
  const here = actorInVault(c, actor, row.vault_id);
  if (!here) return c.json(NOT_FOUND, 404);
  let note: Note | null;
  try {
    note = await owningNote(row.vault_id, row.note_id);
  } catch {
    return c.json({ error: "vault_unreachable" }, 502);
  }
  if (!note) return c.json(NOT_FOUND, 404);
  if (!isAdmin(here)) {
    if (!capsFor(here, ref(note)).has("view")) return c.json(NOT_FOUND, 404);
    if (isTrashed(note)) return c.json(NOT_FOUND, 404);
  }

  // Immutable content per id → a strong ETag; revalidation still runs every check above.
  const etag = `"${row.id}"`;
  const dest = (c.req.header("sec-fetch-dest") ?? "").toLowerCase();
  const pdf = row.mime === "application/pdf";
  // A top-level navigation is always a download; a PDF renders only inside the app's frame.
  const inline = isInlineType(row.mime) && dest !== "document" && (!pdf || dest === "" || dest === "iframe" || dest === "embed" || dest === "object");
  const baseHeaders: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, no-cache",
    ETag: etag,
    Vary: "Authorization, Cookie",
    "Referrer-Policy": "no-referrer",
  };
  const inm = c.req.header("if-none-match");
  if (inm && !c.req.header("range") && inm.split(",").some((v) => v.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
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
  const headers = new Headers({
    ...baseHeaders,
    "Content-Type": row.mime,
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", row.name),
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

/** A third-party image → the same-origin media-proxy path, or null if the proxy would refuse it. */
function proxied(url: string | null, policy: TargetPolicy): string | null {
  if (!url) return null;
  try {
    parseTarget(url, policy);
  } catch {
    return null;
  }
  return `/api/media/proxy?u=${encodeURIComponent(url)}`;
}

async function unfurl(raw: string, policy: TargetPolicy, user: string): Promise<UnfurlResult> {
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
      // Same global + per-user in-flight caps (and bounded wait) as the image proxy.
      const r = await withMediaSlot(user, () =>
        guardedFetch(raw, {
          policy,
          maxBytes: cfg.unfurlMaxBytes,
          timeoutMs: cfg.unfurlTimeoutMs,
          accept: "text/html,application/xhtml+xml;q=0.9",
          transport: cfg.transport,
        }),
      );
      const type = (r.contentType.split(";")[0] ?? "").trim();
      if (type !== "text/html" && type !== "application/xhtml+xml") throw new FetchError("not_html", 415, "not an HTML page");
      const meta = parseUnfurl(r.body.toString("utf8"), r.url);
      // Never hand out raw third-party image URLs (they would be written into a
      // shared document and fetched by every reader): proxied same-origin paths only.
      const imagePolicy = mediaPolicy();
      const value: UnfurlResult = { url: r.url, ...meta, image: proxied(meta.image, imagePolicy), favicon: proxied(meta.favicon, imagePolicy) };
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
    const value = await unfurl(raw, policy, who);
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
    if (e instanceof BusyError) {
      c.header("Retry-After", "2");
      return c.json({ error: "busy" }, 503);
    }
    console.warn("[unfurl] unexpected error:", (e as Error)?.message ?? e);
    return c.json({ error: "upstream", reason: "internal" }, 502);
  }
});

// ── POST /attachments/sweep (server owner) ──────────────────────────────────

/**
 * Find attachments their note no longer references (a block or cover was
 * removed). One page of notes per call (`limit` notes, `cursor` from the last
 * answer); each note is read once. dryRun (default) only reports; otherwise the
 * rows are flagged `orphan_unreferenced` — bytes are never deleted here.
 * Answers ids and sizes only.
 */
attachmentsApi.post("/attachments/sweep", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.role !== "owner" || !isServerOwner(actor)) return c.json({ error: "forbidden" }, 403);
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const limited = rateLimited(c, `attach-sweep:${actorKey(actor)}`, 12);
  if (limited) return limited;
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { dryRun?: unknown; limit?: unknown; cursor?: unknown };
  const dryRun = body.dryRun !== false;
  const limit = Number.isInteger(body.limit) && (body.limit as number) >= 1 ? Math.min(body.limit as number, 1000) : 200;
  const cursor = typeof body.cursor === "string" && body.cursor.length <= 400 ? body.cursor : "";
  const { rows, next } = liveRowsPage(cursor, limit);
  const byNote = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.vault_id}\u0000${r.note_id}`;
    byNote.set(k, [...(byNote.get(k) ?? []), r]);
  }
  const orphans: Array<{ id: string; noteId: string; size: number; reason: string }> = [];
  let checked = 0;
  for (const group of byNote.values()) {
    const first = group[0]!;
    let note: Note | null = null;
    let gone = false;
    try {
      note = await vaultClient(first.vault_id, { timeoutMs: 15_000 }).getNote(first.note_id);
      if (note.id !== first.note_id) { note = null; gone = true; }
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) gone = true;
      else continue; // vault trouble: say nothing about these rows
    }
    // Referenced = named in the body or anywhere in metadata (cover, files properties).
    const hay = note ? `${note.content ?? ""}\n${JSON.stringify(note.metadata ?? {})}` : "";
    for (const r of group) {
      checked++;
      const reason = gone ? "note_deleted" : hay.includes(`/api/attachments/${r.id}`) ? null : "unreferenced";
      if (!reason) continue;
      orphans.push({ id: r.id, noteId: r.note_id, size: r.size, reason });
      if (!dryRun) setAttachmentStatus(r.id, gone ? "orphan_note_deleted" : "orphan_unreferenced");
    }
  }
  // Orphans recorded earlier: pages permanently deleted (the vault keeps their files — see
  // purgeAttachmentsForNote) and attaches that failed after the upload. Ids + sizes only.
  const rec = recordedOrphans();
  return c.json({ dryRun, checked, orphans, next, recorded: rec.rows, recordedTotal: rec.total, recordedBytes: rec.bytes });
});
