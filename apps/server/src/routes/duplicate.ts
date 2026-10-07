/**
 * POST /api/notes/:id/duplicate — "Duplicate" with sub-pages (NP-PG-18).
 *
 *   body  {requestId, withSubpages?=true, confirmShared?}
 *   200   {ok, id, path, title, created, skipped, rows, droppedTags, privateKept, sharingKept,
 *          uncleaned, liveIncomplete, unlinked, files:{copied, failed}, filesPending:[copyId…], audience}
 *   207   {error:"partial_duplicate", id, path, created, remaining, failed:{reason}, …}
 *         — call again with the SAME requestId to finish, or trash `id` to undo
 *   413   {error:"too_large", notes|bytes, limit}  — counted BEFORE anything is written
 *   409   {error:"confirm_shared", audience}       — see AUDIENCE
 *   409   busy (+Retry-After) · undone (the copy is in the Trash) · moved_or_deleted (a
 *         journaled copy is gone, or the root copy moved before the rest was made)
 *
 * The copy lands BESIDE the source ("<Title> (copy)", made unique) and every
 * descendant by path is re-created under it with the same relative path and order.
 *
 * WHO. A signed-in person (session / device token). Links and anon → 401; the
 * Prism MCP and the loopback owner token → 403. CSRF guard, per-account rate limit,
 * strict note id (an alias that resolves to another id is a 404).
 *
 * SOURCE. The caller must VIEW the page (unviewable = missing = trashed → 404).
 * 🔒 Someone ELSE's private page is never copied, for any role (an admin included),
 * as the root (404) or as a sub-page (left out, not counted). System notes and
 * ingest-owned notes — by place or tag (`protectionReason`) or by metadata (an
 * ingester's `source`, any ingest key but the importer's stamp: `ingestMarked`) — are
 * never duplicated, for any role (403 as the root; left out and counted as a sub-page).
 * A page under one that is not copied is not copied either (no orphans; counted). A DESCENDANT is copied only when it
 * is live, viewable, not system/ingest, and — for a non-admin — a page they could
 * create at its new path. `skipped` counts the pages the caller CAN see that were
 * not copied — never the ones they cannot see. Rows of a database page inside the
 * subtree (descendants carrying every source tag of that database) are not copied
 * (`rows`): the copy shows the same rows by tag.
 *
 * DESTINATION = exactly the rules of a new page there (the member `POST /notes`):
 * the `create` cap from the copy's tags or at the place (`createCapsAt`),
 * `placementRefusal` (protected / exported / trashed parent / taken path /
 * `destinationParentRefusal`). A tag the caller could not add themselves (governed
 * and no create/organize in it; a system tag) is DROPPED from the copy and counted
 * (`droppedTags`) — a duplicate never shares or publishes as a side effect.
 *
 * EACH COPY. Body through `copyBodyOf` (`@prism/core/pages`: suggestions resolved to
 * "rejected", comment anchors unwrapped, mention chips given new uids and no
 * reminder) — a linear scanner; nothing here parses Markdown or HTML. Sub-page rows,
 * page mentions and full-path `[[wikilinks]]` that point INSIDE the duplicated
 * subtree are re-pointed at the copies; everything else stays. Metadata by allowlist
 * (`templateKeepsKey` + the ingest-key rule + `NEVER_COPIED`): never identity, lock,
 * trash, writer stamps or ingest keys. Creator = the duplicator. A PRIVATE page's
 * copy is private to the duplicator. Sub-pages keep their `prism_order`; the root
 * does not.
 *
 * AUDIENCE. A copy is NOT automatically read by the same people as its source: page
 * grants are anchored on note ids and the nearest one wins, so a sub-page can be
 * RESTRICTED for someone who inherits more from above — and the copy has no grant.
 * Under a shared destination, every copy whose source (or a page above it, up to the
 * duplicated root) carries a page grant is created PRIVATE to the duplicator
 * (`sharingKept`), like private pages are; both are counted in `audience.private`,
 * and the caller confirms first (`confirmShared: true`, 409 `confirm_shared`).
 *
 * PUBLIC SITES. A page excluded from a publication (`excluded_note_ids`) is excluded by
 * its id; its copy would be published by the kept tag / folder. Such a copy is created
 * private too (in `sharingKept`), whatever the destination.
 *
 * MEMORY. The page count comes from the tree projection and the byte count from the
 * lean listing's sizes — both BEFORE any body is read. Sources are then read one at a
 * time, just before their copy is written; the loop yields between bodies; a body over
 * 1 MB is copied as it is (`uncleaned`: no clean / re-link scan on this thread).
 *
 * LOAD. One duplicate per account and `DUPLICATE_MAX_RUNNING` (2) server-wide (409
 * `busy` + Retry-After); creates are paced (`DUPLICATE_PAUSE_MS`) and one request
 * creates for at most `DUPLICATE_PASS_BUDGET_MS` (20 s) — then, or when the client
 * has gone, it answers 207 and the same requestId continues.
 *
 * NOT TRANSACTIONAL. Copies are written in path order (root first). A failure
 * midway answers 207; the journal (`page_duplicates`) and each copy's
 * `metadata.prism_client_op` make a retry with the same `requestId` ADOPT what
 * exists instead of creating it twice. Trashing the root copy undoes all of it.
 *
 * FILES. Each copy gets its own attachments through `copyNoteAttachments` (the one
 * implementation behind `POST /notes/:id/attachments/copy`) behind that route's own
 * gate (`attachmentCopyGate`: its caps, its rate bucket), within a time budget and
 * AFTER the server-wide slot is released;
 * copies it did not finish are listed in `filesPending` and the client continues
 * with that route per page.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, randomBytes } from "node:crypto";
import { db, resolveVaultEntry, grantsForResource, listPublications, excludedNoteIds, isCollabUnsaved } from "../db";
import type { VaultEntry } from "../config";
import { vaultClient, VaultError, VaultConflictError, type Note } from "../parachute";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { effectiveCaps, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import { csrfRefusal } from "./actions";
import { consumeRateLimit } from "../middleware/ratelimit";
import { recordAction } from "../actions/store";
import { ensureTree, treeUpsertNote, warmPageAnchors, TREE_META_KEYS } from "../tree";
import { canonicalTag } from "../tags";
import { ingestKeyChanged, INGEST_KEYS, INGEST_SOURCES } from "../ingest-keys";
import { createCapsAt, writerStamp } from "../sharing";
import { placementRefusal, exportedLocation, publishedTag, sharedAncestor, pathKey, noteAtPath, pathUnavailable } from "../pages";
import { copyNoteAttachments, attachmentCopyGate } from "./attachments";
import {
  TRASH_TAG,
  ORDER_KEY,
  PAGE_STYLE_KEY,
  TEMPLATE_TAG,
  TEMPLATE_TAGS_KEY,
  copyBodyOf,
  fileExtension,
  isProtectedPath,
  isTrashed,
  isUnder,
  leafName,
  normalizePagePath,
  parentOf,
  parsePageStyle,
  protectionReason,
  systemNoteReason,
  templateKeepsKey,
  templateTagsOf,
  withoutExtension,
} from "@prism/core/pages";

// ── configuration ───────────────────────────────────────────────────────────

export interface DuplicateConfig {
  maxNotes: number;
  maxBytes: number;
  perMinute: number;
  /** How long one request may spend giving copies their own files. */
  filesBudgetMs: number;
  /** How long one request may spend CREATING copies; past it → 207, the same requestId continues. */
  passBudgetMs: number;
  /** Pause between creates: the vault is single-threaded and shared with everyone. */
  pauseMs: number;
  /** Duplicates running at once, server-wide (one per account). */
  maxRunning: number;
  /** How long one request may wait for open pages to be stored before it copies them. */
  flushDeadlineMs: number;
}
const defaults = (): DuplicateConfig => ({
  maxNotes: Number(process.env.DUPLICATE_MAX_NOTES ?? 500),
  maxBytes: Number(process.env.DUPLICATE_MAX_BYTES ?? 10 * 1024 * 1024),
  perMinute: Number(process.env.DUPLICATE_PER_MINUTE ?? 20),
  filesBudgetMs: Number(process.env.DUPLICATE_FILES_BUDGET_MS ?? 15_000),
  passBudgetMs: Number(process.env.DUPLICATE_PASS_BUDGET_MS ?? 20_000),
  pauseMs: Number(process.env.DUPLICATE_PAUSE_MS ?? 25),
  maxRunning: Number(process.env.DUPLICATE_MAX_RUNNING ?? 2),
  flushDeadlineMs: Number(process.env.DUPLICATE_FLUSH_DEADLINE_MS ?? 5_000),
});
/** A body above this is copied as it is (no clean / re-link scan on this thread); counted `uncleaned`. */
const UNCLEANED_OVER = 1_000_000;
let cfg = defaults();
/** Tests: override limits (null = back to the environment's). */
export function configureDuplicate(over: Partial<DuplicateConfig> | null): void {
  cfg = { ...defaults(), ...(over ?? {}) };
}

// ── journal ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS page_duplicates (
    vault_id      TEXT NOT NULL,
    actor         TEXT NOT NULL,
    request_id    TEXT NOT NULL,
    source_id     TEXT NOT NULL,
    with_subpages INTEGER NOT NULL,
    to_path       TEXT NOT NULL,
    copies        TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (vault_id, actor, request_id)
  );
`);
const JOURNAL_DAYS = 14;
/** One copy the journal knows: its id, the revision it was created at, and whether its links are final. */
interface CopyEntry {
  id: string;
  stamp: string | null;
  linked: boolean;
  /** Does the copy reference uploaded files that are not its own yet? Decided when it is
   *  written, from the body in hand; absent = unknown (a copy adopted by its op id). */
  files?: boolean;
}
interface Job { source_id: string; with_subpages: number; to_path: string; copies: Record<string, CopyEntry>; status: string }
function getJob(vaultId: string, actor: string, requestId: string): Job | null {
  const row = db.prepare("SELECT source_id, with_subpages, to_path, copies, status FROM page_duplicates WHERE vault_id = ? AND actor = ? AND request_id = ?").get(vaultId, actor, requestId) as
    | { source_id: string; with_subpages: number; to_path: string; copies: string; status: string }
    | undefined;
  if (!row) return null;
  let copies: Record<string, CopyEntry> = {};
  try { copies = JSON.parse(row.copies) as Record<string, CopyEntry>; } catch { /* unreadable: start over, adoption is by op id */ }
  return { ...row, copies };
}
function putJob(vaultId: string, actor: string, requestId: string, job: Job): void {
  db.prepare(
    "INSERT INTO page_duplicates (vault_id, actor, request_id, source_id, with_subpages, to_path, copies, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(vault_id, actor, request_id) DO UPDATE SET copies = excluded.copies, status = excluded.status",
  ).run(vaultId, actor, requestId, job.source_id, job.with_subpages, job.to_path, JSON.stringify(job.copies), job.status, Date.now());
}
function dropJob(vaultId: string, actor: string, requestId: string): void {
  db.prepare("DELETE FROM page_duplicates WHERE vault_id = ? AND actor = ? AND request_id = ?").run(vaultId, actor, requestId);
}
export function resetDuplicateForTests(): void {
  db.exec("DELETE FROM page_duplicates");
  byAccount.clear();
  running = 0;
  configureDuplicate(null);
}

// ── helpers (same permission math as routes/api.ts and pages.ts) ────────────

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NOT_FOUND = { error: "not_found" } as const;
const CLIENT_OP = "prism_client_op";
const TEMPLATE_PROPS_KEY = "prism_template_props";

type User = Actor & { kind: "user" };
const isAdmin = (a: Actor) => roleAtLeast(a.role, "admin");
const capsFor = (a: User, r: NoteRef): Set<Cap> => effectiveCaps(a.grants, r, roleFloor(a.role), a.email);
const refOf = (n: Pick<Note, "id" | "tags" | "metadata"> & { path?: string | null }): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  path: n.path ?? null,
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
});
const entryFor = (c: Context, a: Actor): VaultEntry => (isAdmin(a) ? resolveVaultEntry(c.req.header("x-prism-vault")) : resolveVaultEntry(a.vaultId));
/** `canAddTag` of routes/api.ts: create or organize in that tag itself. */
const canAddTag = (a: User, t: string): boolean => {
  const slice = capsFor(a, { id: "<retag>", tags: [t] });
  return slice.has("create") || slice.has("organize");
};
/** `tagGoverned` of routes/api.ts: a grant names the tag, or a public site is published from it. */
const tagGoverned = (vaultId: string, t: string): boolean => grantsForResource("tag", t, vaultId).length > 0 || publishedTag(vaultId, t);
const isPrivate = (n: { metadata?: Record<string, unknown> | null }): boolean => n.metadata?.prism_visibility === "private";
const creatorOf = (n: { metadata?: Record<string, unknown> | null }): string => (typeof n.metadata?.prism_creator === "string" ? n.metadata.prism_creator.toLowerCase() : "");
/** Keys an ingester or the identity layer matches notes by that the shared ingest-key list does not name. */
const NEVER_COPIED: ReadonlySet<string> = new Set(["archiveOf", "uid", "mailbox", "transcriptNoteId", "emails", "channels", "participantIds", "matrixRoomIds"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sourceTagsOf = (n: { metadata?: Record<string, unknown> | null }): string[] | null => {
  if (n.metadata?.prism_type !== "database") return null;
  const tags = (n.metadata?.prism_database as { source?: { tags?: unknown } } | undefined)?.source?.tags;
  return Array.isArray(tags) && tags.length > 0 && tags.every((t) => typeof t === "string" && t) ? (tags as string[]) : null;
};
const failReason = (e: unknown): string =>
  e instanceof VaultConflictError ? "path_conflict" : e instanceof VaultError ? (e.status === 400 || e.status === 413 || e.status === 422 ? "vault_rejected" : `vault_${e.status}`) : "vault_unreachable";

/** The copy's tags: the source's, minus what this caller may not put on a note. */
function copyTags(actor: User, vaultId: string, source: string[] | null | undefined): { tags: string[]; dropped: number } {
  const all = [...new Set((source ?? []).map(canonicalTag).filter((t) => t && t !== TRASH_TAG))];
  if (isAdmin(actor)) return { tags: all, dropped: 0 };
  const tags = all.filter((t) => protectionReason({ tags: [t] }) === null && !(tagGoverned(vaultId, t) && !canAddTag(actor, t)));
  return { tags, dropped: all.length - tags.length };
}

/** May this (non-admin) caller create a note with `tags` at `path`? — the member `POST /notes` rule,
 *  its exemption included: a workspace member's own page template, one segment below Templates/. */
async function mayCreate(actor: User, path: string, tags: string[]): Promise<boolean> {
  if (capsFor(actor, { id: "<new>", tags }).has("create") || (await createCapsAt(actor, path, tags)).has("create")) return true;
  const parts = path.split("/");
  return roleAtLeast(actor.role, "member") && tags.length === 1 && tags[0] === TEMPLATE_TAG && parts.length === 2 && parts[0] === "Templates";
}

/**
 * Pages open in the live editor hold typing the vault has not seen: store them first.
 * 🔒 Only `editable` ones — someone with only `view` never forces a store. Bounded (25
 * documents, `flushDeadlineMs`). `incomplete` = some open page was NOT stored (not the
 * caller's to store, past the bounds, or its store did not land): its copy is made from
 * what the vault holds, and the response says so.
 */
async function flushLive(entry: VaultEntry, ids: string[], editable: string[]): Promise<{ flushed: boolean; incomplete: boolean }> {
  const none = { flushed: false, incomplete: false };
  if (!ids.length) return none;
  try {
    const collab = await import("../collab");
    if (!collab.hocuspocus.documents.size) return none;
    const live = ids.filter((x) => collab.isDocLive(entry.id, x));
    if (!live.length) return none;
    const may = new Set(editable);
    const until = Date.now() + cfg.flushDeadlineMs;
    let stored = 0;
    for (const id of live.filter((x) => may.has(x)).slice(0, 25)) {
      const ms = until - Date.now();
      if (ms <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); timer.unref?.(); });
      const ok = await Promise.race([collab.flushLiveDoc(entry.id, id).then(() => true, () => false), late]);
      clearTimeout(timer);
      if (ok && !isCollabUnsaved(id, entry.id)) stored++;
    }
    return { flushed: stored > 0, incomplete: stored < live.length };
  } catch {
    return none; // collab unavailable: nothing is open
  }
}

/** The copy's metadata, key by key. */
function copyMetadata(actor: User, vaultId: string, source: Note, tags: string[], opts: { title?: string; keepOrder: boolean; op: string; forcePrivate?: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keep = (k: string, v: unknown) => templateKeepsKey(k, v) && !ingestKeyChanged(k, v, undefined) && !NEVER_COPIED.has(k);
  for (const [k, v] of Object.entries(source.metadata ?? {})) if (keep(k, v)) out[k] = v;
  if (PAGE_STYLE_KEY in out) {
    const style = parsePageStyle(out[PAGE_STYLE_KEY]);
    if (style) out[PAGE_STYLE_KEY] = style;
    else delete out[PAGE_STYLE_KEY];
  }
  const title = opts.title ?? source.metadata?.title;
  if (typeof title === "string" && title.trim()) out.title = title;
  const order = source.metadata?.[ORDER_KEY];
  if (opts.keepOrder && typeof order === "number" && Number.isFinite(order)) out[ORDER_KEY] = order;
  // A duplicated TEMPLATE keeps what it re-applies — as tags, under the tag rules.
  if (tags.includes(TEMPLATE_TAG)) {
    const remembered = copyTags(actor, vaultId, templateTagsOf(source.metadata)).tags;
    if (remembered.length) out[TEMPLATE_TAGS_KEY] = remembered;
  }
  const props = source.metadata?.[TEMPLATE_PROPS_KEY];
  if (isPlain(props)) out[TEMPLATE_PROPS_KEY] = Object.fromEntries(Object.entries(props).filter(([k, v]) => keep(k, v)));
  // 🔒 Private stays private — to the person duplicating. A non-admin's template is
  // always private (the member create rule).
  // `forcePrivate`: the source (or a page above it) had its OWN sharing, which the copy cannot carry.
  if (isPrivate(source) || opts.forcePrivate || (!isAdmin(actor) && tags.includes(TEMPLATE_TAG))) out.prism_visibility = "private";
  out.prism_creator = actor.email;
  out[CLIENT_OP] = opts.op;
  Object.assign(out, writerStamp(actor.email, "edit"));
  return out;
}

/** Accounts with a duplicate running now (one each), and how many hold a server-wide slot. */
const byAccount = new Set<string>();
let running = 0;
const opFor = (requestId: string, sourceId: string): string => `${requestId}:${createHash("sha256").update(`${requestId}\u0000${sourceId}`).digest("hex").slice(0, 16)}`;
/** Give the event loop a turn (between page bodies: nothing here may hold it for long). */
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
/** A lean row's body size: the vault's `byteSize` (0.7.x `NoteIndex`), else a body the listing carried anyway, else unknown. */
function sizeOf(n: Note): number | null {
  const b = (n as unknown as { byteSize?: unknown }).byteSize;
  if (typeof b === "number" && Number.isFinite(b) && b >= 0) return b;
  return typeof n.content === "string" ? Buffer.byteLength(n.content, "utf8") : null;
}
/** A note an ingester or the identity layer matches by its METADATA, wherever it is filed
 *  (a transcript moved out of the inbox, a mirrored task): `source` is an ingester's, or an
 *  ingest key is set. The importer's own stamp is not one — imported pages are people's pages. */
function ingestMarked(n: { metadata?: Record<string, unknown> | null }): boolean {
  const m = n.metadata;
  if (!m) return false;
  const source = m.source;
  if (typeof source === "string" && INGEST_SOURCES.has(source.trim().toLowerCase())) return true;
  // "Set" = an id-like value: a non-empty string, a non-zero number, a non-empty list or
  // object. `false`, `0` and "" on a key a person happens to use are not an ingester's mark.
  const set = (v: unknown): boolean =>
    typeof v === "string" ? v.trim() !== "" : typeof v === "number" ? Number.isFinite(v) && v !== 0 : Array.isArray(v) ? v.length > 0 : !!v && typeof v === "object" ? Object.keys(v).length > 0 : false;
  for (const k of INGEST_KEYS) if (k !== "prism_import" && set(m[k])) return true;
  return false;
}
/** Ids left OUT of a public site of this vault (`excluded_note_ids`, tag and folder sites alike). */
function excludedFromSites(vaultId: string): Set<string> {
  const out = new Set<string>();
  for (const pub of listPublications()) if ((pub.vault_id ?? "primary") === vaultId) for (const x of excludedNoteIds(pub)) out.add(x);
  return out;
}
const LEAN_KEYS = [...TREE_META_KEYS, "prism_database", "source", ...INGEST_KEYS];

export interface DuplicateApiOptions {
  /** Called after any successful write (the gateway drops its cached owner reads). */
  onWrite?: () => void;
}

export function createDuplicateApi(opts: DuplicateApiOptions = {}) {
  const r = new Hono();

  r.post("/notes/:id/duplicate", bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
    const via = requestVia(c);
    if (via === "mcp" || via === "local-token") return c.json({ error: "forbidden", detail: "agents cannot duplicate pages" }, 403);
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: "unauthorized" }, 401);
    const csrf = csrfRefusal(c, via);
    if (csrf) return csrf;
    const retry = consumeRateLimit(`duplicate:u:${actor.email.toLowerCase()}`, cfg.perMinute, 60_000);
    if (retry !== null) { c.header("Retry-After", String(retry)); return c.json({ error: "rate_limited", reason: "You’re duplicating pages very quickly. Try again in a moment.", retryAfter: retry }, 429); }
    const id = c.req.param("id");
    if (!id || !NOTE_ID.test(id)) return c.json(NOT_FOUND, 404);
    let body: Record<string, unknown>;
    try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_request" }, 400); }
    if (!isPlain(body) || Object.keys(body).some((k) => k !== "requestId" && k !== "withSubpages" && k !== "confirmShared")) return c.json({ error: "invalid_request" }, 400);
    const { requestId } = body;
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return c.json({ error: "invalid_request", reason: "requestId is required." }, 400);
    if ((body.withSubpages !== undefined && typeof body.withSubpages !== "boolean") || (body.confirmShared !== undefined && typeof body.confirmShared !== "boolean")) return c.json({ error: "invalid_request" }, 400);
    const withSubpages = body.withSubpages !== false;

    const admin = isAdmin(actor);
    const entry = entryFor(c, actor);
    const vc = vaultClient(entry.id, { timeoutMs: 15_000 });
    let root: Note;
    try {
      root = await vc.getNote(id);
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) return c.json(NOT_FOUND, 404);
      return c.json({ error: "vault_unreachable" }, 502);
    }
    if (root.id !== id) return c.json(NOT_FOUND, 404);
    if (!admin) await warmPageAnchors(actor.grants);
    const who = actor.email.toLowerCase();
    type Ref = Pick<Note, "id" | "tags" | "metadata"> & { path?: string | null };
    // 🔒 Someone ELSE's private page is never copied — for any role, root or sub-page. An
    // admin can read it, but a copy would re-own it (creator = the duplicator), and with
    // that hand it to whatever that admin's exports and sync configs may carry.
    const canView = (n: Ref) => (isPrivate(n) && creatorOf(n) !== who ? false : admin || capsFor(actor, refOf(n)).has("view"));
    const canEdit = (n: Ref) => canView(n) && (admin || capsFor(actor, refOf(n)).has("edit"));
    /** System notes and everything an integration owns — by place, tag or metadata — for EVERY role. */
    const neverCopied = (n: Ref) => !!systemNoteReason(n) || !!protectionReason(n) || ingestMarked(n);
    /** The refusal for a root that may not be duplicated, or null. */
    const rootRefusal = (n: Note): Response | null => {
      if (n.id !== id || !canView(n) || isTrashed(n)) return c.json(NOT_FOUND, 404);
      if (systemNoteReason(n)) return c.json({ error: "protected", reason: "This is a system note, so it can’t be duplicated." }, 403);
      // A second person/mail/meeting/thread/transcript note pollutes identity matching and the classify skills.
      if (protectionReason(n) || ingestMarked(n)) return c.json({ error: "protected", reason: "This page is kept in sync by an integration, so it can’t be duplicated." }, 403);
      // A note with no location has no "beside": the client copies that one page itself
      // (`no_path` is the code it keys on) — so every never-duplicated rule is decided
      // ABOVE this line, and a page left out of a public site is refused outright: the
      // client's own copy could not be told to stay off that site.
      if (!n.path) {
        if (excludedFromSites(entry.id).has(n.id)) return c.json({ error: "protected", reason: "This page is left out of a public site, so it can’t be duplicated from here." }, 403);
        return c.json({ error: "no_path", reason: "This page has no location to copy beside." }, 400);
      }
      return null;
    };
    const refused = rootRefusal(root);
    if (refused) return refused;

    // One duplicate per account, a few server-wide: each is hundreds of vault calls.
    if (byAccount.has(who) || running >= cfg.maxRunning) {
      c.header("Retry-After", "5");
      return c.json({ error: "busy", reason: byAccount.has(who) ? "Another duplicate of yours is still running." : "The server is busy copying other pages. Try again in a moment.", retryAfter: 5 }, 409);
    }
    byAccount.add(who);
    running++;
    let slotHeld = true;
    /** The server-wide slot covers the vault-heavy part; the files phase runs without it. */
    const releaseSlot = () => { if (slotHeld) { slotHeld = false; running--; } };
    try {
      // The root open in the live editor holds typing the vault has not seen: stored first
      // (only for someone who may edit it), then read AGAIN and judged again as a whole —
      // a page made private or trashed in that window is treated as what it is now.
      let liveIncomplete = false;
      const rootLive = await flushLive(entry, [root.id], canEdit(root) ? [root.id] : []);
      liveIncomplete ||= rootLive.incomplete;
      if (rootLive.flushed) {
        try {
          root = await vc.getNote(id);
        } catch (e) {
          if (e instanceof VaultError && e.status === 404) return c.json(NOT_FOUND, 404);
          return c.json({ error: "vault_unreachable" }, 502);
        }
        const now = rootRefusal(root);
        if (now) return now;
      }
      const from = root.path!;

      let job = getJob(entry.id, who, requestId);
      if (job && (job.source_id !== root.id || !!job.with_subpages !== withSubpages)) return c.json({ error: "request_mismatch", reason: "That requestId was used for another duplicate." }, 422);

      // ── dry count FIRST, from the tree projection (memory): nothing is listed or read past the limit ──
      let tree: Awaited<ReturnType<typeof ensureTree>>;
      try { tree = await ensureTree(entry); } catch { return c.json({ error: "vault_unreachable" }, 502); }
      if (withSubpages) {
        const under = tree.rows().filter((row) => isUnder(row.path, from));
        const visible = under.filter((row) => !row.trashedAt && !row.tags.includes(TRASH_TAG) && canView({ id: row.id, tags: row.tags, path: row.path, metadata: { prism_creator: row.creator ?? undefined, prism_visibility: row.visibility === "private" ? "private" : undefined } })).length;
        if (visible + 1 > cfg.maxNotes) return c.json({ error: "too_large", reason: `That’s ${visible + 1} pages — more than can be duplicated at once (${cfg.maxNotes}).`, notes: visible + 1, limit: cfg.maxNotes }, 413);
        // Everything under the page, visible or not, bounds the listing below (no count is given).
        if (under.length > cfg.maxNotes * 4) return c.json({ error: "too_large", reason: "This page has too many pages inside to duplicate at once.", limit: cfg.maxNotes }, 413);
      }

      // ── the subtree: what is copied, what is only counted ──────────────────
      let lean: Note[] = [];
      if (withSubpages) {
        try {
          lean = (await vc.listNotes({ pathPrefix: from, includeMetadata: LEAN_KEYS })).filter((n) => isUnder(n.path, from));
        } catch {
          return c.json({ error: "vault_unreachable" }, 502);
        }
      }
      lean.sort((a, b) => (a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : 0));
      // Database pages in the subtree (the root too): their rows are found by tag, not copied.
      const databases: Array<{ path: string; tags: string[] }> = [];
      for (const n of [root, ...lean]) {
        const tags = sourceTagsOf(n);
        if (tags && n.path) databases.push({ path: n.path, tags });
      }
      const isRow = (n: Note): boolean => databases.some((d) => isUnder(n.path, d.path) && d.tags.every((t) => (n.tags ?? []).includes(t)));
      let skipped = 0;
      let rows = 0;
      // `skipped` counts only pages the caller CAN see but that are not copied (system,
      // integration-owned, not creatable there, or under a page that was not copied). A
      // page they cannot view is not counted: the number of hidden pages is not theirs to learn.
      const eligible = (n: Note): "copy" | "skip" | "row" | "gone" => {
        if (isTrashed(n) || !n.path || !isUnder(n.path, from)) return "gone";
        if (!canView(n)) return "gone";
        if (neverCopied(n)) return "skip";
        return isRow(n) ? "row" : "copy";
      };

      // ── the destination ────────────────────────────────────────────────────
      const parent = parentOf(from);
      const leaf = leafName(from);
      const ext = fileExtension(leaf).toLowerCase() === ".md" ? "" : fileExtension(leaf);
      let target: string;
      let name: string;
      if (job) {
        target = job.to_path;
        name = withoutExtension(leafName(target));
      } else {
        const taken = tree.rows().map((row) => (row.path ? pathKey(row.path) : ""));
        const free = (p: string) => { const k = pathKey(p); return !taken.some((t) => t === k || t.startsWith(`${k}/`)); };
        const base = `${withoutExtension(leaf)} (copy)`;
        name = base;
        const at = (n: string) => (parent ? `${parent}/` : "") + n + ext;
        for (let i = 2; !free(at(name)) && i < 1000; i++) name = `${base} ${i}`;
        target = at(name);
      }
      if (normalizePagePath(target) !== target) return c.json({ error: "bad_request", reason: "This page’s name can’t be copied." }, 400);
      const rootTags = copyTags(actor, entry.id, root.tags);
      const rootCopyId = job?.copies[root.id]?.id;
      if (!admin) {
        if (!(await mayCreate(actor, target, rootTags.tags))) return c.json({ error: "forbidden", reason: "You can’t add pages here." }, 403);
        const placed = await placementRefusal(entry, target, { actor, tags: rootTags.tags, timeoutMs: 15_000, ...(rootCopyId ? { exceptId: rootCopyId } : {}) });
        if ("status" in placed) return c.json(placed.body, placed.status);
      } else {
        // An admin skips the placement rules, never the vault's own: the path as the vault
        // would look it up (case-insensitive, either Unicode form) must be free.
        try {
          const holder = await noteAtPath(entry, target, { timeoutMs: 15_000 });
          if (holder === "ambiguous" || (holder && holder.id !== rootCopyId)) return c.json(pathUnavailable(target), 409);
        } catch {
          return c.json({ error: "vault_unreachable" }, 502);
        }
      }

      // ── the plan: root first, then by path. A page under one that is NOT copied is not
      //    copied either (it would be an orphan under a path with no page). ─────
      interface Item { id: string; from: string; path: string; tags: string[]; dropped: number; isRoot: boolean; op: string; isPrivate: boolean; forcePrivate?: boolean; size: number | null }
      const plan: Item[] = [{ id: root.id, from, path: target, tags: rootTags.tags, dropped: rootTags.dropped, isRoot: true, op: opFor(requestId, root.id), isPrivate: isPrivate(root), size: Buffer.byteLength(root.content ?? "", "utf8") }];
      const blocked: string[] = [];
      const orphaned = (p: string) => blocked.some((b) => isUnder(p, b));
      for (const n of lean) {
        const what = eligible(n);
        if (what === "gone") { if (n.path) blocked.push(n.path); continue; }
        if (what === "row" && !orphaned(n.path!)) { rows++; blocked.push(n.path!); continue; }
        const path = target + n.path!.slice(from.length);
        const t = copyTags(actor, entry.id, n.tags);
        if (what !== "copy" || orphaned(n.path!) || normalizePagePath(path) !== path || (!admin && (isProtectedPath(path) || !!exportedLocation(entry.id, path) || !(await mayCreate(actor, path, t.tags))))) {
          skipped++;
          blocked.push(n.path!);
          continue;
        }
        plan.push({ id: n.id, from: n.path!, path, tags: t.tags, dropped: t.dropped, isRoot: false, op: opFor(requestId, n.id), isPrivate: isPrivate(n), size: sizeOf(n) });
      }
      if (plan.length > cfg.maxNotes) return c.json({ error: "too_large", reason: `That’s ${plan.length} pages — more than can be duplicated at once (${cfg.maxNotes}).`, notes: plan.length, limit: cfg.maxNotes }, 413);

      // ── bytes, before any write — from the listing's sizes; bodies are NOT held. A vault
      //    whose rows carry no size is measured one body at a time (read, count, let go). ──
      let bytes = 0;
      for (const item of plan) {
        if (item.size === null) {
          try {
            item.size = Buffer.byteLength((await vc.getNote(item.id)).content ?? "", "utf8");
          } catch (e) {
            if (!(e instanceof VaultError && e.status === 404)) return c.json({ error: "vault_unreachable" }, 502);
            item.size = 0;
          }
        }
        bytes += item.size;
        if (bytes > cfg.maxBytes) return c.json({ error: "too_large", reason: "These pages are too large to duplicate at once.", bytes, limit: cfg.maxBytes }, 413);
      }

      // ── audience ───────────────────────────────────────────────────────────
      const privateKept = plan.filter((p) => p.isPrivate).length;
      // 🔒 Fail CLOSED: if the tree cannot say whether the destination is shared, it is.
      let shared = true;
      try { shared = !!(await sharedAncestor(entry, target)); } catch { shared = true; }
      let sharingKept = 0;
      const keepPrivate = (item: Item) => { if (!item.forcePrivate) { item.forcePrivate = true; if (!item.isPrivate) sharingKept++; } };
      // 🔒 A page grant is anchored on a note ID and the NEAREST one wins — it can give a
      // person LESS than they inherit from above. The copy has no such grant, so under a
      // shared destination it would hand that person the ancestor's wider access. Every
      // copy whose source — or a page above it, up to the duplicated root — carries a page
      // grant is therefore created PRIVATE to the duplicator (who may share it again).
      if (shared) {
        const anchors = [root, ...lean].filter((n) => !!n.path && grantsForResource("page", n.id, entry.id).length > 0).map((n) => n.path!);
        for (const item of plan) if (anchors.some((a) => a === item.from || isUnder(item.from, a))) keepPrivate(item);
      }
      // 🔒 A page EXCLUDED from a public site is excluded by its id; its copy has a new id,
      // the same published tag and the same folder — it would be published. Whatever the
      // destination: the copy of an excluded page is private to the duplicator.
      const excluded = excludedFromSites(entry.id);
      if (excluded.size) for (const item of plan) if (excluded.has(item.id)) keepPrivate(item);
      const audience = { sharedPage: shared, private: privateKept + sharingKept };
      if (shared && audience.private > 0 && body.confirmShared !== true) {
        return c.json({ error: "confirm_shared", reason: sharingKept ? `This copy lands inside a page that is shared with other people. ${audience.private === 1 ? "One page" : `${audience.private} pages`} in it will be private to you (private pages, pages that had their own sharing, and pages left out of a public site); the rest is shared like the original.` : "This copy lands inside a page that is shared with other people. The private pages in it stay private to you; the rest is shared like the original.", audience }, 409);
      }

      // ── what already exists of this request (a retry adopts it) ────────────
      let existing: Note[];
      try {
        existing = (await vc.listNotes({ pathPrefix: target, includeMetadata: [...TREE_META_KEYS, CLIENT_OP] })).filter((n) => !!n.path && (pathKey(n.path) === pathKey(target) || isUnder(pathKey(n.path), pathKey(target))));
      } catch {
        return c.json({ error: "vault_unreachable" }, 502);
      }
      const present = new Map(existing.map((n) => [n.id, n]));
      // 🔒 Adopted by op id only when it is THIS account's live note: an op id is ordinary
      // metadata, and a note somebody else put at that path is simply a taken path.
      const mine = (n: Note): boolean => !isTrashed(n) && creatorOf(n) === who;
      const byOp = new Map(existing.filter((n) => typeof n.metadata?.[CLIENT_OP] === "string" && mine(n)).map((n) => [n.metadata![CLIENT_OP] as string, n]));
      const firstRun = !job;
      // "Finish" after "Undo": the copy is in the Trash — never adopted, never continued.
      const undone = rootCopyId ? present.get(rootCopyId) : undefined;
      if (undone && isTrashed(undone)) return c.json({ error: "undone", reason: "This copy was moved to Trash. Restore it from the Trash, or duplicate the page again." }, 409);
      job ??= { source_id: root.id, with_subpages: withSubpages ? 1 : 0, to_path: target, copies: {}, status: "running" };
      // A journaled copy that is no longer where it was made: moved or renamed → it is DONE
      // (never made again); gone → nothing is re-created silently, the person decides.
      const movedAway = { reason: "This copy was moved, renamed or deleted before it was finished. Duplicate the page again if you still need a copy.", error: "moved_or_deleted" } as const;
      let rootMoved = false;
      for (const [src, copy] of Object.entries(job.copies)) {
        if (present.has(copy.id)) continue;
        try {
          const there = await vc.getNote(copy.id);
          if (there.id !== copy.id) return c.json(movedAway, 409);
        } catch (e) {
          if (e instanceof VaultError && e.status === 404) return c.json(movedAway, 409);
          return c.json({ error: "vault_unreachable" }, 502);
        }
        copy.linked = true;
        if (src === root.id) rootMoved = true;
      }
      for (const item of plan) {
        const held = byOp.get(item.op);
        if (held && !job.copies[item.id]) job.copies[item.id] = { id: held.id, stamp: held.updatedAt ?? held.createdAt ?? null, linked: false };
      }
      // The root copy lives elsewhere now: what is left would be created under a path with no page.
      if (rootMoved && plan.some((p) => !job!.copies[p.id])) return c.json(movedAway, 409);
      job.status = "running";
      putJob(entry.id, who, requestId, job);
      db.prepare("DELETE FROM page_duplicates WHERE created_at < ?").run(Date.now() - JOURNAL_DAYS * 86_400_000);
      /** Paths under the target that some OTHER note answers to (case-insensitively, like the vault's lookup). */
      const ours = new Set(Object.values(job.copies).map((x) => x.id));
      const heldBy = new Map(existing.filter((n) => !ours.has(n.id)).map((n) => [pathKey(n.path!), n.id]));

      // Sub-pages open in the live editor: stored first (the caller's to store only), each is read fresh below.
      const leanById = new Map(lean.map((n) => [n.id, n]));
      const subIds = plan.filter((p) => !p.isRoot && !job!.copies[p.id]).map((p) => p.id);
      liveIncomplete ||= (await flushLive(entry, subIds, subIds.filter((x) => canEdit(leanById.get(x)!)))).incomplete;

      // ── links: ids of copies (known as they are made), paths (known now) ───
      const inPlan = new Set(plan.map((p) => p.id));
      const newPath = new Map(plan.map((p) => [pathKey(p.from), p.path]));
      const seeds = new Map<string, string>();
      let uncleaned = 0;
      const tooBig = (source: Note) => Buffer.byteLength(source.content ?? "", "utf8") > UNCLEANED_OVER;
      /** The copy's body; `pending` = it names a page of this copy that does not exist yet. */
      const bodyOf = (item: Item, source: Note): { content: string; pending: boolean; touched: boolean } => {
        let pending = false;
        let touched = false;
        let n = 0;
        const seed = seeds.get(item.id) ?? randomBytes(6).toString("hex");
        seeds.set(item.id, seed);
        const content = copyBodyOf(
          { content: source.content ?? "", path: source.path, metadata: source.metadata, tags: source.tags },
          {
            uid: () => seed + (n++).toString(36).padStart(4, "0"),
            pageId: (sourceId) => {
              if (!inPlan.has(sourceId)) return null;
              const copy = job!.copies[sourceId];
              if (copy) { touched = true; return copy.id; }
              pending = true;
              return null;
            },
            path: (wanted) => newPath.get(pathKey(wanted)) ?? null,
          },
        );
        return { content, pending, touched };
      };

      // ── pass 1: create, in path order. Each source is read just before its copy is
      //    written and let go afterwards: one body in memory at a time. ───────
      let createdNow = 0;
      let failed: { reason: string } | null = null;
      let failure: unknown = null;
      const relink = new Set<string>();
      const left = new Set<string>(); // planned, then found not copyable on the fresh read
      const passStarted = Date.now();
      const gone = c.req.raw.signal;
      for (const item of plan) {
        const known = job.copies[item.id];
        if (known) {
          if (!known.linked) relink.add(item.id);
          continue;
        }
        // Bounded: past the budget, or once the client is gone, the request stops here —
        // what exists is journaled and the same requestId continues ("Finish").
        if (gone?.aborted) { failed = { reason: "client_gone" }; break; }
        if (createdNow > 0 && Date.now() - passStarted > cfg.passBudgetMs) { failed = { reason: "time_budget" }; break; }
        if (createdNow > 0 && cfg.pauseMs > 0) await sleep(cfg.pauseMs);
        if (orphaned(item.from)) { left.add(item.id); inPlan.delete(item.id); skipped++; blocked.push(item.from); continue; }
        let source: Note = root;
        let tags = item.tags;
        if (!item.isRoot) {
          try {
            source = await vc.getNote(item.id);
          } catch (e) {
            if (e instanceof VaultError && e.status === 404) { left.add(item.id); inPlan.delete(item.id); blocked.push(item.from); continue; }
            failed = { reason: failReason(e) };
            failure = e;
            break;
          }
          // Judged again on the fresh note: it may have been moved, trashed, made private or filed by an integration meanwhile.
          const what = source.id === item.id && source.path === item.from ? eligible(source) : "gone";
          const t = copyTags(actor, entry.id, source.tags);
          if (what !== "copy" || (!admin && !(await mayCreate(actor, item.path, t.tags)))) {
            if (what !== "gone") skipped++;
            left.add(item.id);
            inPlan.delete(item.id);
            blocked.push(item.from);
            continue;
          }
          tags = t.tags;
          item.dropped = t.dropped;
        }
        if (heldBy.has(pathKey(item.path))) { failed = { reason: "path_conflict" }; failure = new VaultConflictError(409, null, "path taken"); break; }
        await yieldLoop();
        // A very large body is copied as it is: scanning megabytes on this thread is not worth a clean copy.
        const big = tooBig(source);
        if (big) uncleaned++;
        const { content, pending } = big ? { content: source.content || " ", pending: false } : bodyOf(item, source);
        const metadata = copyMetadata(actor, entry.id, source, tags, { ...(item.isRoot ? { title: name } : {}), keepOrder: !item.isRoot, op: item.op, forcePrivate: item.forcePrivate });
        let created: Note | null = null;
        try {
          created = await vc.createNote({ content, path: item.path, tags, metadata, ifExists: "error" });
        } catch (e) {
          // No answer / a server error: the create may have landed. Adopt it only if the
          // note at that path carries THIS request's op id and is this account's; never anything else.
          if (!(e instanceof VaultConflictError)) {
            try {
              const at = await vc.getNote(item.path);
              if (at.path === item.path && at.metadata?.[CLIENT_OP] === item.op && mine(at)) created = at;
            } catch { /* still unknown: reported as failed, a retry looks again */ }
          }
          if (!created) { failed = { reason: failReason(e) }; failure = e; break; }
        }
        createdNow++;
        job.copies[item.id] = { id: created.id, stamp: created.updatedAt ?? created.createdAt ?? null, linked: !pending, files: content.includes("/api/attachments/") || JSON.stringify(metadata).includes("/api/attachments/") };
        if (pending) relink.add(item.id);
        putJob(entry.id, who, requestId, job);
        treeUpsertNote(entry, created);
      }
      if (createdNow) opts.onWrite?.();
      const copies = plan.filter((p) => !left.has(p.id));
      const droppedTags = copies.reduce((sum, p) => sum + p.dropped, 0);
      const copyRoot = job.copies[root.id];
      const made = copies.filter((p) => job!.copies[p.id]).length;
      const audit = (status: "ok" | "failed", error: string | null) =>
        recordAction({ actorEmail: actor.email, via, origin: "human", action: "pages.duplicate", vaultId: entry.id, target: { sourceId: root.id, copyId: copyRoot?.id ?? null, pages: made, planned: copies.length, skipped, rows, droppedTags, privateKept, sharingKept, uncleaned }, idempotencyKey: requestId, status, error });

      if (failed && !copyRoot) {
        // Nothing exists: forget the journal so a later try may pick another name.
        if (firstRun) dropJob(entry.id, who, requestId);
        audit("failed", failed.reason);
        if (failure instanceof VaultConflictError) return c.json({ error: "path_conflict", reason: "That location isn’t available. Try again." }, 409);
        if (failure instanceof VaultError && (failure.status === 400 || failure.status === 413 || failure.status === 422)) return c.json({ error: "vault_rejected", status: failure.status }, failure.status);
        return c.json({ error: "vault_unreachable" }, 502);
      }

      // ── pass 2: links to copies that did not exist yet when their page was written ──
      let unlinked = 0;
      let relinked = 0;
      if (!failed) {
        // A body write around a live document would be folded over what is being typed
        // (the rule for every body writer): a copy that is open keeps its links as they are.
        let liveState: ((vaultId: string, noteId: string) => boolean) | null = null;
        if (relink.size) {
          try { liveState = (await import("../collab")).hasLiveState; } catch { liveState = null; }
        }
        for (const item of copies) {
          if (!relink.has(item.id)) continue;
          const copy = job.copies[item.id]!;
          if (liveState?.(entry.id, copy.id)) { unlinked++; copy.linked = true; continue; }
          let source: Note = root;
          if (!item.isRoot) {
            try {
              source = await vc.getNote(item.id);
            } catch (e) {
              if (e instanceof VaultError && e.status === 404) { copy.linked = true; continue; }
              failed = { reason: failReason(e) };
              break;
            }
          }
          await yieldLoop();
          const { content, touched } = tooBig(source) ? { content: "", touched: false } : bodyOf(item, source);
          if (touched && copy.stamp) {
            try {
              const saved = await vc.updateNote(copy.id, { content, ifUpdatedAt: copy.stamp });
              copy.stamp = saved.updatedAt ?? copy.stamp;
              treeUpsertNote(entry, saved);
              relinked++;
            } catch (e) {
              // The copy was edited since it was made: its links are left as they are.
              if (e instanceof VaultConflictError) unlinked++;
              else { failed = { reason: failReason(e) }; break; }
            }
          }
          copy.linked = true;
        }
        putJob(entry.id, who, requestId, job);
        if (relinked) opts.onWrite?.();
      }

      if (failed) {
        job.status = "partial";
        putJob(entry.id, who, requestId, job);
        audit("failed", failed.reason);
        return c.json(
          { error: "partial_duplicate", reason: "Some pages were copied and some were not. Finish the copy, or undo it.", requestId, id: copyRoot!.id, path: target, title: name, created: made, remaining: copies.length - made, failed, skipped, rows, droppedTags, privateKept, sharingKept, uncleaned, liveIncomplete, audience },
          207,
        );
      }

      // ── files: each copy gets its own, within this request's budget. The vault-heavy
      //    part is over: the server-wide slot is free for the next duplicate. ──
      releaseSlot();
      const files = { copied: 0, failed: 0 };
      const filesPending: string[] = [];
      const started = Date.now();
      let filesStopped = false;
      for (const item of copies) {
        const copy = job.copies[item.id]!;
        // Known since the copy was written (the body was in hand): no file → nothing to read.
        if (copy.files === false) continue;
        // Past the budget (or the rate limit): handed to the client WITHOUT another read.
        if (filesStopped || Date.now() - started > cfg.filesBudgetMs) { filesPending.push(copy.id); continue; }
        let fresh: Note;
        try {
          fresh = await vc.getNote(copy.id);
        } catch {
          filesPending.push(copy.id); // unreadable now: never silently dropped
          continue;
        }
        if (!(fresh.content ?? "").includes("/api/attachments/") && !JSON.stringify(fresh.metadata ?? {}).includes("/api/attachments/")) { copy.files = false; continue; }
        // 🔒 The same gate as `POST /notes/:id/attachments/copy`: its caps on the copy and its
        // rate bucket — a duplicate is not a way around either.
        const gate = attachmentCopyGate(actor, fresh);
        if (gate !== "ok") { filesPending.push(copy.id); if (gate === "limited") filesStopped = true; continue; }
        try {
          const out = await copyNoteAttachments(entry, actor, fresh);
          if ("error" in out) { filesPending.push(copy.id); continue; }
          files.copied += out.copied;
          files.failed += out.failed;
          if (out.more) filesPending.push(copy.id);
          else copy.files = false; // done: a replay of this request spends nothing on it again
        } catch {
          filesPending.push(copy.id);
        }
      }
      if (files.copied) opts.onWrite?.();

      job.status = "done";
      putJob(entry.id, who, requestId, job);
      audit("ok", null);
      return c.json({ ok: true, id: copyRoot!.id, path: target, title: name, created: made, skipped, rows, droppedTags, privateKept, sharingKept, uncleaned, liveIncomplete, unlinked, files, filesPending, audience });
    } finally {
      releaseSlot();
      byAccount.delete(who);
    }
  });

  return r;
}
