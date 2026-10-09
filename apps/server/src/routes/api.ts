/**
 * The permission gateway. Every route resolves the actor, then either serves
 * the owner the full vault or a non-owner ONLY what their grants allow — never
 * the vault token, never a note they lack at least "view" on. The vault proxy
 * (which holds the token) is reached only after authorization passes here.
 *
 * Non-owner reads are bounded two ways: list/search start from the actor's
 * granted tags (+ per-note grants), then a final capability filter is the
 * authoritative guard (so a tag query can never leak a note the permission math
 * rejects). Writes check the CAPS the actor holds on the specific note — for a
 * grant that carries no explicit caps those are exactly its level's expansion,
 * so the pre-caps behavior is unchanged (see permissions.ts).
 */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { resolveVaultEntry, grantsForResource, isCollabUnsaved, deleteCollabSetAsideForNote, hasCollabSetAside } from "../db";
import type { VaultEntry } from "../config";
import { vault, vaultClient, VaultError, VaultConflictError, type Note } from "../parachute";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { effectiveLevel, effectiveCaps, governedReview, grantedTags, resolvePageAnchor, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import { compress } from "hono/compress";
import { openEventStream } from "../events";
import { ensureTree, renderTree, etagMatches, treeUpsertNote, treeRemoveNote, treeAfterOwnerWrite, treeLockState, treeLockLookup, warmPageAnchors } from "../tree";
import { canvasApi } from "./canvas";
import { threadsApi } from "./threads";
import { peopleApi } from "./people";
import { humanCollabApi } from "./human-collab";
import { tellPagesChanged, writesTitle } from "../page-notice";
import { transcriptsApi } from "./transcripts";
import { databasesApi } from "./databases";
import { sharingApi } from "./sharing";
import { consumeRateLimit, rateLimitClientKey } from "../middleware/ratelimit";
import { settleKeyForUser, takeUnsavedSettle } from "../unsaved-settle";
import { redactVersionForViewer, stripWriterMeta, changeValue, creatorNameFor, CHANGE_KEY, WRITER_META_KEYS, createCapsAt, forViewer } from "../sharing";
import { writerNames, WRITER_AT_KEY } from "../writer-stamp";
import { attachmentsApi } from "./attachments";
import { blocksApi } from "./blocks";
import { createDuplicateApi } from "./duplicate";
import { ingestKeyChanged } from "../ingest-keys";
import { searchApi } from "./search";
import { stampJsonBody, stampMetadata, stripIdentity } from "../writer-stamp";
import { graphNeighborhood } from "../graph";
import { buildWikilinkIndex, resolveWikilink, noteLinkTitle } from "@prism/core/wikilinks";
import { isTrashed, isLocked, isOwnerOnlyMeta, protectionReason, systemNoteReason, TRASH_TAG, TRASH_META, LOCK_KEY, ORDER_KEY, PAGE_STYLE_KEY, normalizePagePath } from "@prism/core/pages";
import { createPagesApi, placementRefusal, pathUnavailable, publishedTag } from "../pages";
import { notificationsRoutes, restMentionHook, restAssignmentHook } from "./notifications";
import { canonicalTag, canonicalTags, canonicalTagsStrict } from "../tags";
import { exportApi } from "./export";
import { createImportApi } from "./import";

export const api = new Hono();

// Bind deferred writes to the original authenticated actor even if another tab
// changes the session cookie between the client's identity check and this call.
// This narrows authorization; it never substitutes for the regular grant checks.
api.use("*", async (c, next) => {
  const expected = c.req.header("x-prism-write-actor");
  if (expected && c.req.method !== "OPTIONS") {
    const actor = resolveActor(c);
    const cap = c.req.header("authorization")?.match(/^Capability (.+)$/i)?.[1];
    const actual = actor.kind === "user" ? `user:${actor.email}`
      : actor.kind === "link" && cap ? `capability:${createHash("sha256").update(cap).digest("hex")}` : null;
    if (expected !== actual) return c.json({ error: "write_actor_changed" }, 409);
  }
  // Page-subtree grants resolve their anchor through the tree projection (NP-CO-09).
  await warmPageAnchors(resolveActor(c).grants);
  await next();
});

/** Add the change KIND to a body the writer stamp was just applied to (history: "Agent revision"). */
function stampChange(metadata: Record<string, unknown> | undefined, kind: "edit" | "agent"): Record<string, unknown> | undefined {
  const at = metadata?.[WRITER_AT_KEY];
  return metadata && typeof at === "string" ? { ...metadata, [CHANGE_KEY]: changeValue(kind, at) } : metadata;
}
function stampChangeJson(text: string, kind: "edit" | "agent"): string {
  if (!text.includes(WRITER_AT_KEY)) return text;
  try {
    const b = JSON.parse(text) as { metadata?: Record<string, unknown> };
    if (!b || typeof b !== "object" || Array.isArray(b) || !b.metadata || typeof b.metadata[WRITER_AT_KEY] !== "string") return text;
    // Only when stampJsonBody stamped THIS request (it re-serialises; an unstamped body passes through byte-for-byte).
    b.metadata = stampChange(b.metadata, kind);
    return JSON.stringify(b);
  } catch {
    return text;
  }
}
const ref = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
  path: n.path ?? null,
});

/** The grant subject of an actor (for the private-note creator check). */
const actorSubject = (a: Actor): string | null =>
  a.kind === "user" ? a.email : a.kind === "link" ? a.capabilityId : null;

/**
 * The actor's capabilities on a note (P1). Same inputs as `effectiveLevel` — for
 * a grant that carries no explicit caps it is exactly that level's expansion, so
 * routing a check through caps never changes the answer for existing grants.
 */
const capsFor = (actor: Actor, note: NoteRef): Set<Cap> =>
  effectiveCaps(actor.grants, note, roleFloor(actor.role), actorSubject(actor));

/** `_review: "governance"` beside `_caps` (wave 3): the caller's suggest/create
 *  standing on this note comes from a governance role, so the client offers the
 *  propose-for-review draft. Absent for a plain "can suggest" share — that person
 *  gets the live suggest-only editor. A hint, never a guard. */
const reviewStamp = (actor: Actor, note: NoteRef): { _review?: "governance" } =>
  governedReview(actor.grants, note, roleFloor(actor.role), actorSubject(actor)) ? { _review: "governance" } : {};

/**
 * Transparent proxy to the vault for the OWNER only. Forwards the exact path,
 * query, method, and body with the server-held token, so the owner's web app
 * works identically to the direct client — minus the token, which never leaves
 * this process. Non-owners never reach this (they hit the allowlisted routes
 * below, or the final 403 catch-all).
 */
async function proxyToVault(c: Context) {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/api/, "");
  // Phase-1 multi-vault: the owner may bind a request to a specific vault via the
  // `X-Prism-Vault` header (an id from the registry). No header → the primary
  // entry → byte-for-byte the previous single-vault behavior. Only the owner
  // passthrough is vault-aware; non-owner routes stay on the primary (Phase 2).
  const entry = resolveVaultEntry(c.req.header("x-prism-vault"));
  const target = `${entry.url}/vault/${entry.vault}/api${path}${url.search}`;
  const method = c.req.method;
  const headers: Record<string, string> = { Authorization: `Bearer ${entry.token}` };
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    init.body = await c.req.text();
    // Writer stamp (`prism_last_writer`, ../writer-stamp.ts) on single-note creates/edits.
    if ((method === "POST" && path === "/notes") || (method === "PATCH" && /^\/notes\/[^/]+$/.test(path))) init.body = stampChangeJson(stampJsonBody(init.body as string, resolveActor(c)), requestVia(c) === "mcp" ? "agent" : "edit");
    // Any write may change what a cached read would return.
    dropReadCache();
    // NP-PG-09: a locked page refuses CONTENT edits for everyone, the owner and admins
    // included, until it is unlocked (it used to pass here with a log line). Every way
    // the passthrough can change a page's body is covered: PATCH/PUT with content,
    // a version RESTORE, and a create that overwrites (`if_exists: replace|update`,
    // single or batch). Metadata, tags and path stay writable, and unlocking has its
    // own route (POST /notes/:id/meta). Refused before anything reaches the vault.
    // FAIL CLOSED: when the lock cannot be read the write is refused as retryable.
    const refusal = await ownerLockRefusal(entry, method, path, init.body as string);
    if (refusal === "locked") return c.json({ error: "locked", reason: "This page is locked. Unlock it to edit." }, 423);
    if (refusal === "too_large") return c.json({ error: "batch_too_large", reason: `A batch may overwrite at most ${MAX_OVERWRITE_ITEMS} existing notes. Send it in smaller parts.` }, 413);
    if (refusal === "unknown") {
      c.header("Retry-After", "2");
      return c.json({ error: "lock_unknown", reason: "Couldn’t check whether this page is locked. Nothing was changed — try again." }, 503);
    }
  }
  // DELETE /notes/<id or PATH alias>: set-aside rows are keyed by note ID, so an alias is
  // resolved BEFORE the note is gone (only when this vault holds any such row at all).
  const deleting: string[] = [];
  const deleteOf = method === "DELETE" ? path.match(/^\/notes\/([^/?]+)$/)?.[1] : undefined;
  if (deleteOf) {
    try {
      const asked = decodeURIComponent(deleteOf);
      deleting.push(asked);
      if (hasCollabSetAside(entry.id)) {
        const id = (await vaultClient(entry.id, { timeoutMs: 5000 }).getNote(asked)).id;
        if (id !== asked) deleting.push(id);
      }
    } catch {
      /* a malformed escape, or a note that cannot be read: the delete itself answers */
    }
  }
  const t0 = Date.now();
  let res: ProxiedResponse;
  try {
    // Only a single-note read may ask for a fresh answer: lists keep their protection
    // against N copies of an expensive vault call.
    const fresh = method === "GET" && /^\/notes\/[^/]+$/.test(path) && /\bno-(cache|store)\b/i.test(c.req.header("cache-control") ?? "");
    res = method === "GET" ? await coalescedGet(target, init, fresh) : await forward(target, init);
    // A 401 here is the VAULT refusing the SERVER's token — it says nothing about the caller,
    // who was authenticated before this function ran. Vault 0.7.9 has been seen to refuse a
    // valid token once in a while (2026-10-08: 1 request in 40, then none in 300). The refusal
    // happens before the vault acts, so the same request is sent once more; it is never
    // forwarded as a 401, which every client reads as "you are signed out" (the iOS app then
    // started a new sign-in and minted another device each time).
    if (res.status === 401) {
      await new Promise((r) => setTimeout(r, 150));
      res = await forward(target, init);
      if (res.status === 401) {
        console.warn(`[gateway] vault refused the server's token twice on ${method} ${path}`);
        return c.json({ error: "vault_auth", reason: "The server could not reach its vault. Try again in a moment." }, 502);
      }
    }
  } catch (e) {
    console.warn(`[gateway] vault ${method} ${path} failed: ${(e as Error).message}`);
    return c.json({ error: "vault_unreachable" }, 502);
  }
  // Keep the WP7.1 tree projection current for the owner's own writes (the vault
  // subscribe socket covers everyone else's; this makes the writer's next read exact).
  if (method !== "GET" && method !== "HEAD" && res.status >= 200 && res.status < 300) {
    void treeAfterOwnerWrite(entry, method, path, res.body).catch(() => {});
    // A stored title written through the passthrough is the page's name: open live documents look again.
    const titled = method === "PATCH" ? path.match(/^\/notes\/([^/?]+)$/)?.[1] : undefined;
    if (titled && writesTitle(init.body)) { try { void tellPagesChanged(entry.id, [decodeURIComponent(titled)]); } catch { /* malformed escape */ } }
    // A note deleted for good takes the page text set aside from its live document with it.
    for (const id of deleting) deleteCollabSetAsideForNote(entry.id, id);
  }
  if (process.env.PRISM_VAULT_TRACE === "1") {
    console.log(`[trace] proxy ${method} ${path}${url.search} → ${res.status} ${res.body.length}B ${Date.now() - t0}ms ua=${(c.req.header("user-agent") ?? "").slice(0, 40)}`);
  }
  return new Response(res.body, { status: res.status, headers: { "Content-Type": res.contentType } });
}

/** Does this note-write body change the page's BODY (`content`, or the vault's `append` / `prepend`)? */
export function writesContent(raw: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return false; // not JSON: the vault refuses it
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return b.content !== undefined || b.append !== undefined || b.prepend !== undefined;
}

type LockAnswer = "locked" | "unlocked" | "missing" | "unknown";

/** Lock state of the note an owner/admin write names (by id or by PATH). The tree
 *  projection answers when it knows the row; otherwise the note is read. Only a
 *  definite answer counts: a read that FAILS is "unknown", never "unlocked". */
async function ownerLockState(entry: VaultEntry, idOrPath: string): Promise<LockAnswer> {
  const known = treeLockState(entry, idOrPath);
  if (known !== null) return known ? "locked" : "unlocked";
  try {
    return isLocked(await vaultClient(entry.id, { timeoutMs: 5000 }).getNote(idOrPath)) ? "locked" : "unlocked";
  } catch (e) {
    return e instanceof VaultError && e.status === 404 ? "missing" : "unknown";
  }
}

const decoded = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

/** How many body-overwriting items one `POST /notes` batch may carry. Above it the
 *  batch is REFUSED — never partly checked (item 501 must not skip the lock). */
export const MAX_OVERWRITE_ITEMS = 500;

/** The notes a `POST /notes` body could OVERWRITE the body of: items (single, or the
 *  `notes: [...]` batch) with `if_exists: replace|update` that carry content.
 *  `count` = how many such items there are (every one, no truncation). */
function overwriteTargets(raw: string): { targets: string[]; count: number } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { targets: [], count: 0 };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { targets: [], count: 0 };
  const b = body as Record<string, unknown>;
  const items = Array.isArray(b.notes) ? b.notes : [b];
  const out = new Set<string>();
  let count = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.if_exists !== "replace" && it.if_exists !== "update") continue;
    if (it.content === undefined && it.append === undefined && it.prepend === undefined) continue;
    count++;
    for (const key of [it.id, it.path]) if (typeof key === "string" && key) out.add(key);
  }
  return { targets: [...out], count };
}

/** Would this owner/admin write change the BODY of a locked page? (`null` = no.) */
async function ownerLockRefusal(entry: VaultEntry, method: string, path: string, raw: string): Promise<"locked" | "unknown" | "too_large" | null> {
  const targets: string[] = [];
  const note = path.match(/^\/notes\/([^/?]+)$/)?.[1];
  const restore = path.match(/^\/notes\/([^/?]+)\/restore$/)?.[1];
  if (note && (method === "PATCH" || method === "PUT") && writesContent(raw)) targets.push(decoded(note) ?? "");
  else if (restore && method === "POST") targets.push(decoded(restore) ?? "");
  else if (path === "/notes" && method === "POST") {
    const over = overwriteTargets(raw);
    if (over.count > MAX_OVERWRITE_ITEMS) return "too_large";
    targets.push(...over.targets);
  }
  // The tree projection answers for every row it knows (ids AND paths, one pass); only
  // what it cannot answer is read from the vault, a few at a time.
  const lookup = treeLockLookup(entry);
  const unresolved: string[] = [];
  for (const target of targets) {
    if (!target) continue;
    const known = lookup(target);
    if (known === true) return "locked";
    if (known === null) unresolved.push(target);
  }
  let unknown = false;
  for (let i = 0; i < unresolved.length; i += 4) {
    const states = await Promise.all(unresolved.slice(i, i + 4).map((t) => ownerLockState(entry, t)));
    if (states.includes("locked")) return "locked";
    if (states.includes("unknown")) unknown = true;
  }
  return unknown ? "unknown" : null;
}

interface ProxiedResponse {
  status: number;
  body: string;
  contentType: string;
}

async function forward(target: string, init: RequestInit): Promise<ProxiedResponse> {
  const resp = await fetch(target, init);
  return {
    status: resp.status,
    body: await resp.text(),
    contentType: resp.headers.get("content-type") ?? "application/json",
  };
}

/**
 * Owner-read coalescing. The vault is single-threaded, and on vault ≥0.7.9 a
 * full-vault list (the tree: ~14k notes, ~16 MB, with per-note schema validation)
 * costs seconds of its time. Every tab, device and retry asking for the same
 * thing at once used to queue N copies of that work — and a swapping 16 GB host
 * turned the queue into minute-long stalls. So identical in-flight GETs share one
 * vault call, and a 200 is reused for a few seconds. Any write through the
 * gateway clears the cache, so the owner always reads their own writes; writes
 * made elsewhere (desktop, agents) show up within the TTL.
 */
const inflight = new Map<string, Promise<ProxiedResponse>>();
const readCache = new Map<string, { expires: number; res: ProxiedResponse }>();
const READ_TTL_MS = Number(process.env.GATEWAY_READ_TTL_MS ?? 5000);

/**
 * Write generation (H3). Bumped by every write that clears the cache. A read that
 * STARTED before a write must not store its (pre-write) body after the clear, and
 * a read issued after the write must not join it — so a clear also forgets the
 * in-flight reads (their own callers still get their answers).
 */
let writeGeneration = 0;
function dropReadCache(): void {
  writeGeneration++;
  readCache.clear();
  inflight.clear();
}

/** `fresh`: the caller asked for the current state (`Cache-Control: no-cache|no-store`
 *  on a single-note read — a client re-reading because it was TOLD the note changed).
 *  Never answered from the reuse window or a read already in flight; its answer
 *  replaces the cached one. */
async function coalescedGet(target: string, init: RequestInit, fresh = false): Promise<ProxiedResponse> {
  if (!fresh) {
    const hit = readCache.get(target);
    if (hit && hit.expires > Date.now()) return hit.res;
    const pending = inflight.get(target);
    if (pending) return pending;
  }
  const generation = writeGeneration;
  const p = (async () => {
    let res: ProxiedResponse;
    try {
      res = await forward(target, init);
    } catch {
      // A reused keep-alive socket can be reset by the vault; a GET is idempotent,
      // so retry once on a fresh request before giving up.
      res = await forward(target, init);
    }
    if (res.status === 200 && READ_TTL_MS > 0 && generation === writeGeneration) readCache.set(target, { expires: Date.now() + READ_TTL_MS, res });
    if (readCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of readCache) if (v.expires <= now) readCache.delete(k);
    }
    return res;
  })();
  if (!fresh) inflight.set(target, p);
  try {
    return await p;
  } finally {
    if (inflight.get(target) === p) inflight.delete(target);
  }
}

/**
 * GET /api/tree: the lean file-tree projection (WP7.1; see ../tree.ts). Registered
 * BEFORE the owner short-circuit so owners and non-owners both get it, from memory,
 * without a full-vault list. Owners get everything; everyone else is filtered through
 * the SAME `view`-cap math as every other read (`capsFor`), so a path or tag of a
 * note they cannot view is never emitted. `ETag`/`If-None-Match` gives 304.
 */
/** Bounded, permission-filtered graph response. No note bodies or hidden totals. */
// Human collaboration commands (suggest-only enforcement): registered before the
// owner/admin passthrough below, which would otherwise proxy the path to the vault.
api.route("/collab", humanCollabApi);
api.route("/people", peopleApi);
api.route("/threads", threadsApi);
api.use("/canvas/*", async (c, next) => {
  await next();
  // Projection writes bypass the transparent owner proxy. Never reuse a
  // pre-projection note/link response after a confirmed reconciliation.
  dropReadCache();
});
api.route("/canvas", canvasApi);
api.use("/transcripts/*", async (c, next) => {
  await next();
  // Link decisions write notes outside the owner proxy: drop cached owner reads.
  if (c.req.method !== "GET") dropReadCache();
});
api.route("/transcripts", transcriptsApi);
// Pages (nested-page move, Trash, synced preferences): before the owner passthrough,
// like /tree — these are Prism routes, not vault routes. Writes drop cached owner reads.
api.route("/", createPagesApi({ onWrite: () => dropReadCache() }));
api.route("/", createDuplicateApi({ onWrite: () => dropReadCache() })); // POST /notes/:id/duplicate (a page WITH its sub-pages, NP-PG-18) — before the owner short-circuit
// Sharing reads (shared-with-me, comment index, page activity, move access preview).
api.route("/", sharingApi);
// Typed properties + database views (schemas, lean query, property writes).
// Their writes bypass the owner proxy: drop cached owner reads afterwards.
api.use("/properties/*", async (c, next) => { await next(); dropReadCache(); });
api.use("/schemas/*", async (c, next) => { await next(); if (c.req.method !== "GET") dropReadCache(); });
api.use("/databases/*", async (c, next) => { await next(); if (c.req.method !== "GET") dropReadCache(); });
api.route("/", databasesApi);
// Attachments (upload/serve via vault storage) + link previews; before the owner passthrough.
api.route("/", attachmentsApi);
// "Move to" appends to a page outside the owner proxy: the target's cached owner read
// (and any read in flight across the append) must not be served afterwards — the open
// target page re-reads on the event and has to see the appended blocks.
api.use("/notes/:id/blocks/*", async (c, next) => { await next(); dropReadCache(); });
api.route("/", blocksApi); // POST /notes/:id/blocks/append ("Move to" a page, through the live doc when open; wave 4A)
api.route("/", searchApi); // GET /search (all actors; filters + match offsets, wave 2E) — before the owner short-circuit
// Notifications inbox, reminders, access requests (wave 2A): before the owner passthrough.
api.route("/", notificationsRoutes);
// Import / export (wave 3A): Prism routes, before the owner passthrough. An import
// writes notes outside the owner proxy: drop cached owner reads as it goes.
api.route("/", exportApi);
api.route("/", createImportApi({ onWrite: () => dropReadCache() }));

api.get("/graph/neighborhood", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({error:"unauthorized"},401);
  if (resolveVaultEntry(actor.vaultId).id !== actor.vaultId) return c.json({error:"vault_unavailable"},409);
  const center = c.req.query("center") ?? "";
  const depth = Number(c.req.query("depth") ?? 1);
  const limit = Number(c.req.query("limit") ?? 150);
  if (!center || center.length > 2048 || !Number.isInteger(depth) || depth < 1 || depth > 5 || !Number.isInteger(limit) || limit < 1 || limit > 500) return c.json({error:"bad_request"},400);
  try {
    const notes = await vaultClient(actor.vaultId).listNotes({includeLinks:true,includeMetadata:["title","name","type","prism_creator","prism_visibility"]});
    if (notes.length >= 50_000) return c.json({error:"incomplete_inventory"},503);
    const live = notes.filter(note => !isTrashed(note)); // trashed pages leave the graph
    const allowed = roleAtLeast(actor.role,"admin") ? live : live.filter(note => capsFor(actor,ref(note)).has("view"));
    const graph = graphNeighborhood(allowed,center,depth,limit);
    c.header("Cache-Control","private, no-store");
    return graph ? c.json(graph) : c.json({error:"not_found"},404);
  } catch { return c.json({error:"graph_unavailable"},503); }
});

api.get("/wikilinks/resolve", async (c) => {
  const target = (c.req.query("target") ?? "").trim();
  if (!target || target.length > 2048) return c.json({error:"bad_request"},400);
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({error:"unauthorized"},401);
  if (resolveVaultEntry(actor.vaultId).id !== actor.vaultId) return c.json({error:"vault_unavailable"},409);
  try {
    const all = await vaultClient(actor.vaultId).listNotes({includeMetadata:["title","aliases","alias","type","prism_creator","prism_visibility"]});
    if (all.length >= 50_000) return c.json({error:"incomplete_inventory"},503);
    // Permission filtering precedes resolution and candidate counts. No hidden
    // title or alias can influence the choices returned to a guest.
    const live = all.filter(note => !isTrashed(note)); // a trashed page is not a link target
    const allowed = roleAtLeast(actor.role,"admin") ? live : live.filter(note=>capsFor(actor,ref(note)).has("view"));
    const result = resolveWikilink(target,buildWikilinkIndex(allowed));
    const notes = result.kind === "match" ? [result.note] : result.kind === "ambiguous" ? result.notes : [];
    c.header("Cache-Control","private, no-store");
    return c.json({kind:result.kind,candidates:notes.map(note=>({id:note.id,path:note.path,title:noteLinkTitle(note)}))});
  } catch { return c.json({error:"vault_unreachable"},502); }
});

api.get("/tree", compress(), async (c) => {
  const actor = resolveActor(c);
  const owner = roleAtLeast(actor.role, "admin");
  const entry = owner ? resolveVaultEntry(c.req.header("x-prism-vault")) : resolveVaultEntry(actor.vaultId);
  let tree;
  try {
    tree = await ensureTree(entry);
  } catch (e) {
    console.warn(`[gateway] tree build failed: ${(e as Error).message}`);
    return c.json({ error: "vault_unreachable" }, 502);
  }
  // Admins get the unfiltered tree (every path, as before) — but a private note they cannot
  // VIEW keeps its title/aliases to its creator, exactly as an export does.
  const mayView = (r: NoteRef) => capsFor(actor, r).has("view");
  const { body, etag } = renderTree(tree, owner ? undefined : mayView, owner ? { viewer: actorSubject(actor) ?? "", canView: mayView } : undefined);
  const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie, Authorization, X-Prism-Vault" };
  if (etagMatches(c.req.header("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
});

/**
 * GET /api/events: SSE invalidation channel (WP7.2; see ../events.ts). Ids only,
 * filtered per connection through the same `view`-cap math as `/tree`. Fed by the
 * tree projection's single vault subscribe socket + gateway write-through. No
 * compress() (would buffer the stream). Anon → 401.
 */
api.get("/events", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const owner = roleAtLeast(actor.role, "admin");
  const entry = owner ? resolveVaultEntry(c.req.header("x-prism-vault")) : resolveVaultEntry(actor.vaultId);
  return openEventStream(c, {
    entry,
    principal: actor.kind === "user" ? `u:${actor.email}` : `l:${actor.capabilityId}`,
    // Ids only. Trashed notes stay on the channel for viewers (they see them in the
    // Trash), so a restore or a permanent delete still reaches them.
    canView: owner ? () => true : (r) => capsFor(actor, r).has("view"),
  });
});

/**
 * REST half of the editor-schema handshake (C1; the socket half is in collab.ts).
 * A content write from an editor built before the current document schema would
 * have parsed the stored HTML through a schema that drops callouts, toggles,
 * columns and colours — and saving it deletes them. Current clients send
 * `X-Prism-Editor-Schema: <COLLAB_SCHEMA_VERSION>` through serverFetch. A
 * content PATCH/PUT without it (or older) is refused with 409
 * `editor_update_required` ONLY when the stored note already holds content the
 * old schema cannot represent, so metadata writes, untouched notes and plain
 * Markdown notes keep working for any caller. Tables and images are NOT markers:
 * the old plain editor already supported them (only the old live editor, which
 * the socket gate refuses, dropped them). In-process MCP dispatches (agents,
 * which write Markdown/HTML through the gateway without a header) and server
 * workers (which call the vault directly) are unaffected. Runs BEFORE the owner
 * short-circuit, so it covers the owner passthrough too.
 */
export const EDITOR_SCHEMA_HEADER = "x-prism-editor-schema";
// v2 (callout/toggle/columns/colours), v3 (mention), v4 (attachment/embed/bookmark/toc/database blocks, image align/caption),
// v5 (child-page rows, toggle headings, column widths, table cell colours — 4–5 columns are caught by the columns marker).
const MARKER_TYPES = new Set(["callout", "toggle", "columns", "column", "mention", "attachment", "embed", "bookmark", "toc", "child-page"]);
const MARKER_ATTRS = ["data-prism-database", "data-block-color", "data-text-color", "data-align", "data-caption", "data-heading-level", "data-col-width", "data-cell-color"];
const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
/** After an attribute NAME at `i`: the value following `=` (whitespace and either quote style tolerated), or null when no `=`. */
function attrValueAt(s: string, i: number): string | null {
  while (i < s.length && isWs(s.charCodeAt(i))) i++;
  if (s[i] !== "=") return null;
  i++;
  while (i < s.length && isWs(s.charCodeAt(i))) i++;
  const q = s[i];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, i + 1);
    return end === -1 ? s.slice(i + 1, i + 65) : s.slice(i + 1, Math.min(end, i + 65));
  }
  let end = i;
  while (end < s.length && end < i + 64 && !isWs(s.charCodeAt(end)) && s[end] !== ">") end++;
  return s.slice(i, end);
}
/**
 * Does the stored body hold content an older editor schema cannot represent?
 * A linear scan (indexOf per marker, no regex over the body) that reads HTML the
 * way a parser does: attribute names in any case, single or double quotes or
 * none, whitespace around `=` — an exact-string test let `data-type = 'callout'`
 * through and a stale editor then deleted the block.
 */
export function needsEditorUpdate(storedContent: string | null | undefined): boolean {
  const raw = storedContent ?? "";
  if (raw.indexOf("<") === -1) return false;
  const s = raw.toLowerCase();
  for (let i = s.indexOf("data-type"); i !== -1; i = s.indexOf("data-type", i + 9)) {
    const v = attrValueAt(s, i + 9);
    if (v !== null && MARKER_TYPES.has(v.trim())) return true;
  }
  for (const name of MARKER_ATTRS) {
    for (let i = s.indexOf(name); i !== -1; i = s.indexOf(name, i + name.length)) {
      if (attrValueAt(s, i + name.length) !== null) return true;
    }
  }
  for (let i = s.indexOf("<details"); i !== -1; i = s.indexOf("<details", i + 8)) {
    const c = s.charCodeAt(i + 8);
    if (Number.isNaN(c) || isWs(c) || c === 62 /* > */ || c === 47 /* / */) return true;
  }
  return false;
}
api.use("/notes/:id", async (c, next) => {
  const method = c.req.method;
  if (method !== "PATCH" && method !== "PUT") return next();
  if (requestVia(c) === "mcp") return next();
  const sent = c.req.header(EDITOR_SCHEMA_HEADER);
  if (sent && /^\d{1,6}$/.test(sent) && Number(sent) >= COLLAB_SCHEMA_VERSION) return next();
  let body: unknown;
  try { body = JSON.parse(await c.req.text()); } catch { return next(); }
  if (!body || typeof body !== "object" || typeof (body as { content?: unknown }).content !== "string") return next();
  const actor = resolveActor(c);
  if (actor.kind === "anon") return next(); // the route answers 401/403
  let storedNote: Note;
  try { storedNote = await vaultClient(actor.vaultId).getNote(c.req.param("id")); } catch { return next(); }
  // Never answer for a note the caller cannot view: the 409 would reveal that it
  // exists and what blocks it holds. The route answers 404 for them (review M3).
  if (!roleAtLeast(actor.role, "admin") && !capsFor(actor, ref(storedNote)).has("view")) return next();
  if (!needsEditorUpdate(storedNote.content ?? "")) return next();
  return c.json({ error: "editor_update_required", message: "Prism was updated. Reload or update the app to keep editing." }, 409);
});

// A note whose LIVE document state has not reached the vault yet (a store that
// could not render or write — `collab_unsaved`): the vault's body is stale, so a
// REST write of the body (PATCH/PUT with `content`, or a version restore) would
// pass its version check against content nobody is looking at. Such a note is
// first given the chance to be written (load + store); if its state is still
// ahead, the write is refused — `409 conflict {live, retry}` — for EVERY caller
// (owner passthrough and in-process MCP included). A note that cannot be opened
// live at all (unconvertible) is exempt: REST is the only way to fix it.
//
// Settling LOADS the document and STORES it (a conversion, a vault write). Only
// someone who could make the body write may set that off: `edit` on the note,
// not locked, not a system note (admins as the gateway treats them) — a viewer's
// PATCH gets the route's own 403 with nothing loaded (review M1) — and at most
// `UNSAVED_SETTLES_PER_MINUTE` per actor; past that the answer is the 409
// without another attempt.
//
// A page whose changes can NEVER be written as they are (a permanent row) is not
// "still being saved": it answers `409 unsaved_permanent {retry:false}` (M2).
const UNSAVED_CONFLICT = { error: "conflict", live: true, retry: true, detail: "This page has changes that are still being saved from the live editor. Open the page, or try again in a moment." } as const;
async function unsavedRefusal(c: Context, id: string): Promise<Response | null> {
  const actor = resolveActor(c);
  if (actor.kind === "anon" || !id) return null; // the route answers 401/403/404
  const vaultId = roleAtLeast(actor.role, "admin") ? resolveVaultEntry(c.req.header("x-prism-vault")).id : actor.vaultId;
  if (!isCollabUnsaved(id, vaultId)) return null; // one indexed lookup; rows are keyed by note id
  // Never an oracle, and never work on behalf of someone who could not make this
  // write anyway: without `edit` on an unlocked, non-system note the route's own
  // answer (404 / 403 / 423) stands and NOTHING is loaded or stored.
  if (!roleAtLeast(actor.role, "admin")) {
    try {
      const note = await vaultClient(vaultId).getNote(id);
      if (!capsFor(actor, ref(note)).has("edit") || isLocked(note) || isTrashed(note) || systemNoteReason(note)) return null;
    } catch {
      return null;
    }
  }
  const collab = await import("../collab"); // lazily: collab ⇄ routes import cycle
  // One bucket per account, shared with the Prism MCP tools (unsaved-settle.ts).
  const wait = takeUnsavedSettle(actor.kind === "user" ? settleKeyForUser(actor.email) : `c:${rateLimitClientKey(c)}`);
  if (wait !== null) {
    // No further load + store for this actor right now: the snapshot is still ahead as far as anyone knows.
    c.header("Retry-After", String(wait));
    const permanent = collab.unsavedPermanentReason(vaultId, id);
    return permanent ? c.json(collab.unsavedPermanentBody(permanent), 409) : c.json(UNSAVED_CONFLICT, 409);
  }
  const settled = await collab.settleUnsaved(vaultId, id);
  if (settled === "permanent") return c.json(collab.unsavedPermanentBody(collab.unsavedPermanentReason(vaultId, id)), 409);
  return settled === "pending" ? c.json(UNSAVED_CONFLICT, 409) : null;
}
api.use("/notes/:id", async (c, next) => {
  const method = c.req.method;
  if (method !== "PATCH" && method !== "PUT") return next();
  let body: unknown;
  try { body = JSON.parse(await c.req.text()); } catch { return next(); }
  if (!body || typeof body !== "object" || typeof (body as { content?: unknown }).content !== "string") return next();
  return (await unsavedRefusal(c, c.req.param("id"))) ?? next();
});
api.use("/notes/:id/restore", async (c, next) => (c.req.method === "POST" ? ((await unsavedRefusal(c, c.req.param("id"))) ?? next()) : next()));

// Wave 2A: a successful content write carrying @-mention chips → notifications +
// mention backlinks (both the owner passthrough and the member route; never
// changes the response). After the schema gate, before the owner short-circuit.
api.use("/notes", restMentionHook);
api.use("/notes/:id", restMentionHook);
// NP-CO-16: a metadata write that adds someone to a person property → "assigned
// you" (owner passthrough, member route and MCP dispatch; creates never notify).
api.use("/notes/:id", restAssignmentHook);

// Owner short-circuit: full vault access, token-free. Registered before the
// authorized routes so the owner bypasses per-note filtering entirely.
api.use("*", async (c, next) => {
  if (roleAtLeast(resolveActor(c).role, "admin")) return proxyToVault(c);
  await next();
});

/** The vault's `error_type` from a VaultError message (`<METHOD> <path>: <status> <json body>`). */
function vaultReason(message: string): string | undefined {
  const json = message.slice(message.indexOf("{"));
  try {
    const body = JSON.parse(json) as { error_type?: string; error?: string };
    return body.error_type ?? body.error;
  } catch {
    return undefined;
  }
}

/** The vault's 409 for a path that is already held (as opposed to a stale `if_updated_at`). */
function isPathConflict(body: unknown): boolean {
  const b = (body && typeof body === "object" ? body : {}) as { error_type?: unknown; error?: unknown };
  return b.error_type === "path_conflict" || b.error === "path_conflict";
}

function vaultErr(c: Context, e: unknown) {
  // Optimistic-concurrency conflict: pass the vault's status + current state
  // through so the client can rebase, instead of collapsing it to a 502. (Checked
  // before VaultError since VaultConflictError extends it.)
  if (e instanceof VaultConflictError) {
    return c.json({ error: "conflict", status: e.status, current: e.body }, e.status === 428 ? 428 : 409);
  }
  if (e instanceof VaultError) {
    if (e.status === 404) return c.json({ error: "not_found" }, 404);
    // The vault's request-shaped refusals (bad input, payload/history too large,
    // schema validation) are the client's to fix — pass them through. 401/403 stay
    // a 502: they describe the SERVER's token, not the caller.
    if (e.status === 400 || e.status === 413 || e.status === 422) {
      return c.json({ error: "vault_rejected", status: e.status, reason: vaultReason(e.message) }, e.status);
    }
    return c.json({ error: "vault_error", status: e.status }, 502);
  }
  return c.json({ error: "server_error" }, 500);
}

/**
 * Filter a note list to what the actor may VIEW and stamp each survivor with the
 * caps it was filtered by (`_caps`) — the same annotation `GET /notes/:id`
 * returns. Free: the view filter has to compute the cap set for every note
 * anyway, so the list path carries it instead of throwing it away.
 *
 * NON-OWNERS ONLY, and SIGNED-IN ones only. The owner/admin short-circuit
 * returns the vault's raw response through `proxyToVault` and never reaches this
 * function, so an owner (and every desktop client, which talks to the vault
 * directly) sees byte-for-byte what it saw before. Capability links are excluded
 * too: the affordance the annotation drives is "propose this for review", which
 * needs a session (the governance surface 401s an anonymous link), so telling a
 * link-holder about their caps could only offer them a button that cannot work.
 */
const annotated = (actor: Actor): boolean => actor.kind === "user";

function annotate(actor: Actor, notes: Note[]): Array<Note & { _caps?: Cap[] }> {
  const stamp = annotated(actor);
  const out: Array<Note & { _caps?: Cap[] }> = [];
  for (const n of notes) {
    // Trashed pages are hidden from every list and search (GET /api/trash lists them).
    if (isTrashed(n)) continue;
    const caps = capsFor(actor, ref(n));
    // Capability links never learn who created/edited a note (writer-stamp.ts).
    // Attribution keys never reach a non-owner (review M3); a link gets no identity keys at all.
    if (caps.has("view")) out.push(stamp ? { ...forViewer(actor, n), _caps: [...caps], ...reviewStamp(actor, ref(n)) } : forViewer(actor, n));
  }
  return out;
}

/**
 * Notes a non-owner may see: union of (notes under each granted tag) and
 * (individually granted notes), then filtered to "holds the `view` cap".
 * Per-tag queries (not a single multi-tag query) avoid AND/OR ambiguity in the
 * vault's tag filter.
 */
const PAGE_GRANT_LISTINGS = Number(process.env.PAGE_GRANT_LISTINGS ?? 25);
const PAGE_GRANT_LIST_PER_MINUTE = Number(process.env.PAGE_GRANT_LIST_PER_MINUTE ?? 30);

async function visibleNotes(actor: Actor, includeContent: boolean, sharedPagesOffset = 0): Promise<{ notes: Note[]; next: number | null }> {
  const vc = vaultClient(actor.vaultId); // read from the actor's OWN vault, not the primary
  // A `vault` grant matches every note (see effectiveCaps), so tag-bounded
  // enumeration would return an empty list for its holder — a global governance
  // role compiles to exactly this shape (P2). If any vault grant confers `view`,
  // enumerate the whole vault; the per-note capability filter below remains the
  // authoritative guard either way.
  const vaultWide = actor.grants.some(
    (g) => g.resource_type === "vault" && (g.caps ? g.caps.includes("view") : true),
  );
  if (vaultWide) {
    const all = await vc.listNotes({ includeContent });
    return { notes: annotate(actor, all), next: null };
  }
  const collected = new Map<string, Note>();
  for (const tag of grantedTags(actor.grants)) {
    for (const n of await vc.listNotes({ tags: [tag], includeContent })) {
      collected.set(n.id, n);
    }
  }
  // Page-subtree grants (NP-CO-09): the anchor page plus everything under its
  // current path (one lean path_prefix listing each). Membership is still decided
  // by the caps filter in annotate(); this only bounds what is fetched.
  // Bounded AND paged (review L-3): the outermost shared pages (a page inside an
  // already-listed page adds nothing) in a stable path order, PAGE_GRANT_LISTINGS
  // per request from `sharedPagesOffset`; `next` tells the caller there are more.
  const anchorOf = new Map<string, string>(); // path → anchor note id
  for (const g of actor.grants) {
    if (g.resource_type !== "page") continue;
    const a = resolvePageAnchor(g.vault_id ?? actor.vaultId, g.resource);
    if (a && !a.trashed && a.path) anchorOf.set(a.path, g.resource);
    else if (!a) anchorOf.set(`\u0000${g.resource}`, g.resource); // unresolved: the page itself only
  }
  const paths = [...anchorOf.keys()].sort();
  const outermost = paths.filter((path) => path.startsWith("\u0000") || !paths.some((q) => !q.startsWith("\u0000") && path.startsWith(`${q}/`)));
  const window = outermost.slice(sharedPagesOffset, sharedPagesOffset + PAGE_GRANT_LISTINGS);
  const next = sharedPagesOffset + PAGE_GRANT_LISTINGS < outermost.length ? sharedPagesOffset + PAGE_GRANT_LISTINGS : null;
  for (const path of window) {
    if (!path.startsWith("\u0000")) {
      try {
        for (const n of await vc.listNotes({ pathPrefix: `${path}/`, includeContent })) collected.set(n.id, n);
      } catch {
        /* listing failed — the anchor itself is still fetched below */
      }
    }
    const id = anchorOf.get(path)!;
    if (collected.has(id)) continue;
    try {
      collected.set(id, await vc.getNote(id));
    } catch {
      /* the shared page may have been deleted — skip */
    }
  }
  // Per-note grants ride on the first page only.
  if (sharedPagesOffset === 0) {
    for (const g of actor.grants.filter((x) => x.resource_type === "note")) {
      if (collected.has(g.resource)) continue;
      try {
        collected.set(g.resource, await vc.getNote(g.resource));
      } catch {
        /* granted note may have been deleted — skip */
      }
    }
  }
  return { notes: annotate(actor, [...collected.values()]), next };
}

api.get("/health", async (c) => c.json({ vault: await vault.health() }));

api.get("/notes", async (c) => {
  const actor = resolveActor(c);
  const includeContent = c.req.query("include_content") === "true";
  if (roleAtLeast(actor.role, "admin")) {
    const limit = Number(c.req.query("limit") ?? 50000);
    return c.json(await vault.listNotes({ includeContent, limit }));
  }
  const limit = Number(c.req.query("limit") ?? 50000);
  const offset = Number(c.req.query("offset") ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50000 || !Number.isSafeInteger(offset) || offset < 0) {
    return c.json({ error: "bad_request", detail: "limit must be 1–50000 and offset must be a nonnegative integer" }, 400);
  }
  // A page share is enumerated with one vault listing per shared page: budget it per caller.
  if (actor.grants.some((g) => g.resource_type === "page")) {
    const wait = consumeRateLimit(`notes-page-list:${actor.vaultId}:${actorSubject(actor) ?? "anon"}`, PAGE_GRANT_LIST_PER_MINUTE, 60_000);
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate_limited", retryAfter: wait }, 429);
    }
  }
  // Filter permission-visible rows BEFORE paging: hidden notes must neither
  // consume page positions nor cause unrelated note types to enter an Inbox.
  const tags = c.req.queries("tag") ?? [];
  const sharedPagesOffset = Number(c.req.query("shared_pages_offset") ?? 0);
  if (!Number.isSafeInteger(sharedPagesOffset) || sharedPagesOffset < 0 || sharedPagesOffset > 100_000) return c.json({ error: "bad_request", detail: "shared_pages_offset must be a nonnegative integer" }, 400);
  const listing = await visibleNotes(actor, includeContent, sharedPagesOffset);
  let notes = listing.notes;
  // More shared pages than one request expands: say so, and where to continue (review L-3).
  if (listing.next !== null) {
    c.header("X-Prism-Truncated", "shared-pages");
    c.header("X-Prism-Shared-Pages-Next", String(listing.next));
  }
  if (tags.length) notes = notes.filter((note) => tags.every((tag) => note.tags?.includes(tag)));
  const sort = c.req.query("sort");
  if (sort === "asc" || sort === "desc") {
    const direction = sort === "asc" ? 1 : -1;
    const byUpdated = c.req.query("order_by") === "updated_at";
    const timestamp = (note: Note) => byUpdated ? note.updatedAt ?? note.createdAt : note.createdAt;
    notes.sort((a, b) => direction * (timestamp(a).localeCompare(timestamp(b)) || a.id.localeCompare(b.id)));
  }
  return c.json(notes.slice(offset, offset + limit));
});

api.get("/notes/:id", async (c) => {
  const actor = resolveActor(c);
  let note: Note;
  try {
    note = await vaultClient(actor.vaultId).getNote(c.req.param("id"));
  } catch (e) {
    return vaultErr(c, e);
  }
  const level = effectiveLevel(actor.grants, ref(note), roleFloor(actor.role), actorSubject(actor));
  const caps = capsFor(actor, ref(note));
  // Read gate on the `view` CAP: for a level-only grant this is exactly
  // atLeast(level, "view"); a caps grant that omits `view` (e.g. ["create"])
  // correctly reads nothing even though its ladder projection floors at "view".
  // 404, not 403: "exists but not yours" would let anyone probe paths and titles.
  if (!caps.has("view")) return notFound(c);
  // `_caps` (P4) travels beside `_level` so a client can render the RIGHT
  // affordance instead of discovering a 403 by attempting a write: an actor with
  // `suggest` but not `edit` gets "propose this change for review" rather than a
  // silently failing autosave. Non-owner responses only — the owner's requests
  // are proxied verbatim, so no owner and no desktop client ever sees this field.
  // Who trashed a page is an email: never shown to non-owners.
  if (note.metadata && TRASH_META.by in note.metadata) {
    const { [TRASH_META.by]: _by, ...rest } = note.metadata;
    note = { ...note, metadata: rest };
  }
  note = forViewer(actor, note);
  return c.json(annotated(actor) ? { ...note, _level: level, _caps: [...caps], ...reviewStamp(actor, ref(note)) } : { ...note, _level: level });
});

/**
 * NON-OWNER WRITES ARE BUILT FROM ALLOWLISTS — never forward a request body.
 *
 * The vault's `POST /notes` honours far more than a single note: `notes: [...]`
 * (batch), per-item `if_exists: "replace" | "update"` (overwrite whatever holds the
 * path), `id`, `links`, `created_at`, `extension`. Checking the top-level fields and
 * then spreading the body handed all of that to anyone with `create` on one tag:
 * overwrite or retag any note in the vault, forge creator/visibility/lock/trash
 * keys, choose ids. So every non-owner write names the fields it sends, one by one,
 * and a create refuses any key it does not know (strict schema). Owners/admins never
 * reach these handlers (passthrough) and keep the vault's full dialect, batch included.
 */
const CREATE_KEYS = new Set(["content", "path", "tags", "metadata"]);
/**
 * Metadata an INTEGRATION or the system finds, dedupes or schedules a note by. A
 * non-owner never sets, changes or clears one through create / PATCH (dropped
 * silently, so an autosave restating the current value still works): a forged
 * `calendarEventId` or `source_id` would make the ingest adopt — or stop updating —
 * the wrong note; `merged_into` turns a person into a tombstone; the skill keys are
 * what the scheduler reads. Deliberately NOT here (generic names people use as
 * ordinary properties, inert without the protected path/tag): `source`, `account`,
 * `mailbox`, `uid`, `provider`, `model`, `structured`; and the people identity fields
 * (`email`, `channels`, …), which an editor may change through the identity route.
 */
const isPlainObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const invalid = (c: Context, reason: string) => c.json({ error: "invalid_request", reason }, 400);
/** The system-owned tags (`protectionReason`): a non-owner never puts a note INTO one. */
const systemTags = (tags: string[]): string[] => tags.filter((t) => protectionReason({ tags: [t] }) !== null);

/**
 * TRUE SYSTEM NOTES — `systemNoteReason`: `agent-skill` / `agent-dispatch` /
 * `agent-session` / `alert`, anything under `vault/agent`, every `governance-*`
 * record. A non-owner may READ one their grants reach, but never write it through
 * the general routes — PATCH, restore, delete, properties, attachments, the collab
 * socket and commands — whatever their grants say: a skill note is run with the
 * vault token, a governance note carries authority (it changes only through the
 * governance service). INGEST notes (meetings, ClickUp tasks, people, threads, the
 * inbox) are NOT in this set: they stay editable per the caller's grants and are
 * protected only from move / trash / path and system-tag changes (`protectionReason`).
 */
const systemNoteRefusal = (c: Context, note: Note) => {
  const why = systemNoteReason(note);
  return why ? c.json({ error: "protected", reason: why }, 403) : null;
};
/** One answer for "no such note" and "a note you cannot view" (no existence oracle). */
const notFound = (c: Context) => c.json({ error: "not_found" }, 404);

/**
 * May the actor put a note into tag `t` — the PATCH `add_tags` anti-escalation rule,
 * shared with create: they hold `create` or `organize` in that tag itself (via a tag
 * or vault grant, evaluated against a synthetic ref carrying just that tag).
 */
const canAddTag = (actor: Actor, t: string): boolean => {
  const slice = capsFor(actor, { id: "<retag>", tags: [t] });
  return slice.has("create") || slice.has("organize");
};
/** A tag somebody's access hangs on: any grant (person, link, anyone, governance role) names it. */
const tagGoverned = (vaultId: string, t: string): boolean => grantsForResource("tag", t, vaultId).length > 0 || publishedTag(vaultId, t);

/** `metadata.prism_template_tags`: the tags a page TEMPLATE re-applies to every page made
 *  from it — so, for a non-owner, it is a list of TAGS and follows the tag rules. */
const TEMPLATE_TAGS_META = "prism_template_tags";
const MAX_TEMPLATE_TAGS = 20;
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 🔒 Review round 3 (blocker). A non-owner's value for `prism_template_tags` is checked
 * EXACTLY like tags they add: an array of ≤ 20 tag names, canonical, no system tag, and
 * each one either ungoverned (no grant names it, nothing is published from it) or one
 * they could add themselves (`canAddTag`). Otherwise a member could make an owner's
 * "Use template" drop a page into a published tag or another group's shared folder.
 * Restating the stored value (an editor round-trips metadata) and clearing it pass.
 */
function templateTagsCheck(actor: Actor, vaultKey: string, value: unknown, current: unknown): { tags: string[] | null } | { status: 400 | 403; reason: string } {
  if (value === null) return { tags: null };
  if (current !== undefined && sameJson(value, current)) return { tags: current as string[] };
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_TAGS || value.some((t) => typeof t !== "string")) return { status: 400, reason: "prism_template_tags must be a list of at most 20 tag names." };
  const tags = [...new Set((value as string[]).map(canonicalTag))];
  if (tags.some((t) => t.length === 0 || t.length > 200)) return { status: 400, reason: "prism_template_tags must be a list of at most 20 tag names." };
  if (tags.includes(TRASH_TAG) || tags.includes("template") || systemTags(tags).length) return { status: 403, reason: "A template cannot apply a system tag." };
  if (tags.some((t) => tagGoverned(vaultKey, t) && !canAddTag(actor, t))) return { status: 403, reason: "A template can only apply tags you can create or organize in." };
  return { tags };
}

/** Where every page template is saved (`@prism/core/pages` TEMPLATES_FOLDER): exactly one segment below it. */
const isTemplateSlot = (path: string | null): boolean => {
  if (!path) return false;
  const parts = path.split("/");
  return parts.length === 2 && parts[0] === "Templates" && parts[1]!.length > 0;
};

api.post("/notes", async (c) => {
  const actor = resolveActor(c);
  // Owners/admins are short-circuited to the passthrough upstream; this handler
  // runs for members/guests/links. A signed-in MEMBER may create — but only
  // inside a tag/folder they can already EDIT, so a create can't smuggle a note
  // into an area they lack access to. Guests/links/anon cannot create.
  const body: unknown = await c.req.json().catch(() => null);
  const raw = isPlainObject(body) ? body : {};
  // CANONICAL tags first (`../tags.ts`): the vault stores `#agent-skill` as
  // `agent-skill`, so every check below — and what is sent — uses the stored form.
  // A tag that canonicalises to nothing is a 400, not a silent drop.
  const stringTags = canonicalTagsStrict(raw.tags);
  const subject = actorSubject(actor);
  // (For the cap check a malformed entry is simply ignored; it is refused 400 below.)
  const slice: NoteRef = { id: "<new>", tags: stringTags ?? (Array.isArray(raw.tags) ? canonicalTags(raw.tags.filter((t): t is string => typeof t === "string")) : []) };
  // The `create` CAP on the target tag slice. `edit` expands to include create,
  // so every pre-caps edit grant still creates exactly as before; a caps grant can
  // now say "may add notes here" WITHOUT conferring edit on what is already there.
  // …or, for a page-share holder, `create` AT THE PLACE: a page grant on an ancestor
  // of the requested path (`createCapsAt`; empty under a trashed page). The placement
  // rules below (`placementRefusal` → `destinationParentRefusal`) still decide where.
  let canCreate = actor.kind === "user" && capsFor(actor, slice).has("create");
  if (!canCreate && actor.kind === "user" && typeof raw.path === "string") {
    const at = normalizePagePath(raw.path);
    if (at) canCreate = (await createCapsAt(actor, at, slice.tags)).has("create");
  }
  // A workspace MEMBER (never a guest or a link) may always save a page TEMPLATE of their
  // own: a note whose ONLY tag is `template`, one segment below Templates/. It is forced
  // private to them below, so it is in nobody else's view and needs no tag grant.
  const ownTemplate =
    actor.kind === "user" && roleAtLeast(actor.role, "member") && slice.tags.length === 1 && slice.tags[0] === "template" &&
    typeof raw.path === "string" && isTemplateSlot(normalizePagePath(raw.path));
  if (!canCreate && !ownTemplate) {
    return c.json({ error: "forbidden", reason: "create requires the create capability on the target tag/folder" }, 403);
  }
  // Strict schema: one note, four fields. Refusals name keys' roles, never values.
  if (!isPlainObject(body)) return invalid(c, "The body must be one note object.");
  if (Object.keys(body).some((k) => !CREATE_KEYS.has(k))) return invalid(c, "Only content, path, tags and metadata can be set when creating a note.");
  if (body.content !== undefined && typeof body.content !== "string") return invalid(c, "content must be text.");
  if (body.tags !== undefined && (!stringTags || stringTags.length > 100)) return invalid(c, "tags must be a list of tag names.");
  if (body.metadata !== undefined && body.metadata !== null && !isPlainObject(body.metadata)) return invalid(c, "metadata must be an object.");
  if (body.path !== undefined && body.path !== null && typeof body.path !== "string") return invalid(c, "path is not a valid page location.");

  // TAGS. The trash tag is never set here; a system-owned tag (agent skills run with
  // the vault token, governance records carry authority, …) is never entered by a
  // non-owner; and a PUBLISHED tag puts the note on a public site, so it needs create
  // standing in that tag itself — not merely in another tag on the same note.
  const tags = [...new Set((stringTags ?? []).filter((t) => t !== TRASH_TAG))];
  if (systemTags(tags).length) return c.json({ error: "protected", reason: "Notes with a system tag are created by Prism, not by hand." }, 403);
  // EVERY tag, not just one: the `create` cap above may come from any tag on the note,
  // so each OTHER tag must be one the actor could add with PATCH `add_tags`
  // (`canAddTag`) — or a plain organisational tag nobody's access hangs on (no grant
  // names it, nothing is published from it). Otherwise `create` in one folder would
  // drop notes into every other shared folder and onto public sites.
  const vaultKey = resolveVaultEntry(actor.vaultId).id;
  // (`template` on a member's own private template is exempt: see `ownTemplate` above.)
  const outside = tags.filter((t) => !(ownTemplate && !canCreate && t === "template") && tagGoverned(vaultKey, t) && !canAddTag(actor, t));
  if (outside.length) return c.json({ error: "forbidden", reason: "You can only add tags you can create or organize in." }, 403);

  // PATH: the pages API's destination rules — protected / exported / under the Trash —
  // and, when the destination sits inside somebody's PAGE, `create` or `organize` on
  // that page. A plain folder or the top level needs no more than the tag rules above.
  let path: string | undefined;
  if (typeof body.path === "string") {
    const placed = await placementRefusal(resolveVaultEntry(actor.vaultId), body.path, { actor, tags });
    if ("status" in placed) return c.json(placed.body, placed.status);
    path = placed.path;
  }

  // Stamp the creator (private-to-creator + audit). A member can't forge it — we
  // overwrite any client-supplied prism_creator with the authenticated subject.
  // Owner-only keys (creator/visibility/trash state, lock) and the trash tag are never
  // accepted from a non-owner create (review H3/M1).
  // Narrowing is safe: a non-owner may create a note as private (e.g. a private task).
  const metadata = Object.fromEntries(Object.entries((body.metadata as Record<string, unknown> | null | undefined) ?? {}).filter(([k, v]) => (k === "prism_visibility" ? v === "private" : !isOwnerOnlyMeta(k) && k !== LOCK_KEY && k !== ORDER_KEY && k !== PAGE_STYLE_KEY && !ingestKeyChanged(k, v, undefined) && !(WRITER_META_KEYS as readonly string[]).includes(k))));
  if (subject) metadata.prism_creator = subject;
  // The tags a template re-applies are tags: same rule as `tags` above.
  if (TEMPLATE_TAGS_META in metadata) {
    const checked = templateTagsCheck(actor, vaultKey, metadata[TEMPLATE_TAGS_META], undefined);
    if ("status" in checked) return c.json({ error: checked.status === 400 ? "invalid_request" : "forbidden", reason: checked.reason }, checked.status);
    if (checked.tags?.length) metadata[TEMPLATE_TAGS_META] = checked.tags;
    else delete metadata[TEMPLATE_TAGS_META];
  }
  // 🔒 A non-owner's TEMPLATE is always private to its creator, whatever the client sent:
  // sharing a template is the owner's deliberate act (the gallery's toggle).
  if (tags.includes("template")) metadata.prism_visibility = "private";
  // The writer stamp is server-owned: client values were dropped above, ours is applied here.
  Object.assign(metadata, stampChange(stampMetadata(undefined, actor), requestVia(c) === "mcp" ? "agent" : "edit"));
  try {
    // `ifExists: "error"` is the vault's default; said out loud so a non-owner create
    // can never become an overwrite if that default moves.
    const created = await vaultClient(actor.vaultId).createNote({
      content: (body.content as string | undefined) ?? "",
      ...(path !== undefined ? { path } : {}),
      tags,
      metadata,
      ifExists: "error",
    });
    treeUpsertNote(resolveVaultEntry(actor.vaultId), created);
    return c.json(forViewer(actor, created));
  } catch (e) {
    // A taken path: one generic answer, whether or not the caller could view what is
    // there (the vault's own body names the holder's path and is never passed on).
    if (e instanceof VaultConflictError && e.status === 409) return c.json(pathUnavailable(path ?? ""), 409);
    return vaultErr(c, e);
  }
});

api.patch("/notes/:id", async (c) => {
  const actor = resolveActor(c);
  const id = c.req.param("id");
  const vc = vaultClient(actor.vaultId);
  let note: Note;
  try {
    note = await vc.getNote(id);
  } catch (e) {
    return vaultErr(c, e);
  }
  const noteRef = ref(note);
  const caps = capsFor(actor, noteRef);
  if (!caps.has("view")) return notFound(c);
  const system = systemNoteRefusal(c, note);
  if (system) return system;

  // Only these six fields are ever read, and each is sent to the vault by name
  // (never the body): `links`, `tags: {add, remove}`, `force`, `if_exists`, `append`,
  // `created_at` and anything else a client adds are ignored, as before — the owner
  // dialect's tag/link PATCHes (`rest.addTags`) stay a harmless no-op for a member.
  const parsed: unknown = await c.req.json().catch(() => null);
  if (!isPlainObject(parsed)) return invalid(c, "The body must be an object.");
  if (parsed.content !== undefined && typeof parsed.content !== "string") return invalid(c, "content must be text.");
  if (parsed.metadata !== undefined && !isPlainObject(parsed.metadata)) return invalid(c, "metadata must be an object.");
  if (parsed.path !== undefined && typeof parsed.path !== "string") return invalid(c, "path is not a valid page location.");
  if (parsed.if_updated_at !== undefined && parsed.if_updated_at !== null && typeof parsed.if_updated_at !== "string") return invalid(c, "if_updated_at must be the note's updatedAt.");
  const body = {
    content: parsed.content as string | undefined,
    metadata: parsed.metadata as Record<string, unknown> | undefined,
    path: parsed.path as string | undefined,
    add_tags: parsed.add_tags,
    remove_tags: parsed.remove_tags,
    if_updated_at: (parsed.if_updated_at ?? undefined) as string | undefined,
  };

  // Canonical (`../tags.ts`) before every check: `#agent-skill` is `agent-skill`.
  const strings = (x: unknown): string[] =>
    Array.isArray(x) ? [...new Set(x.filter((t): t is string => typeof t === "string").map(canonicalTag).filter((t) => t.length > 0))] : [];
  const addTags = strings(body.add_tags);
  const removeTags = strings(body.remove_tags);
  // H3/M1/LOCK: a non-owner never writes who-can-see / who-created / trash state, the
  // page lock or the sidebar order through this route, and never toggles the trash tag.
  // Ingest / system keys: a changed (or cleared) value is dropped, an unchanged one passes.
  // The writer stamp is server-owned (review M3): whatever a client sends for it is
  // dropped (never stored), and the server's own stamp is applied on the write below.
  if (body.metadata) {
    body.metadata = Object.fromEntries(Object.entries(body.metadata).filter(([k, v]) => !(WRITER_META_KEYS as readonly string[]).includes(k) && !ingestKeyChanged(k, v, note.metadata?.[k])));
  }
  const meta = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
  const subjectNow = actorSubject(actor);
  const forbiddenKey = (k: string): boolean => {
    // Narrowing only: the note's creator may make it private; never widen it, and
    // never (re)assign the creator — a no-op restatement of either is fine.
    if (k === "prism_visibility") return !(meta[k] === "private" && noteRef.creator === subjectNow) && meta[k] !== note.metadata?.[k];
    if (k === "prism_creator") return meta[k] !== note.metadata?.[k];
    // The page style has its own validated route (POST /notes/:id/meta).
    return isOwnerOnlyMeta(k) || k === LOCK_KEY || k === ORDER_KEY || k === PAGE_STYLE_KEY;
  };
  if (Object.keys(meta).some(forbiddenKey)) {
    return c.json({ error: "forbidden", reason: "That property can only be changed through its own control." }, 403);
  }
  // The tags a template re-applies are TAGS (review round 3): same rule as `add_tags`.
  if (body.metadata && TEMPLATE_TAGS_META in body.metadata) {
    const checked = templateTagsCheck(actor, resolveVaultEntry(actor.vaultId).id, body.metadata[TEMPLATE_TAGS_META], note.metadata?.[TEMPLATE_TAGS_META]);
    if ("status" in checked) return c.json({ error: checked.status === 400 ? "invalid_request" : "forbidden", reason: checked.reason }, checked.status);
    body.metadata[TEMPLATE_TAGS_META] = checked.tags;
  }
  if (addTags.includes(TRASH_TAG) || removeTags.includes(TRASH_TAG)) {
    return c.json({ error: "forbidden", reason: "Use Move to Trash / Restore." }, 403);
  }
  // A system-owned tag is never entered by a non-owner, whatever their organize scope
  // (an `agent-skill` note is run with the vault token; governance tags carry authority).
  // Nor removed: an ingest note keeps the tag its integration finds it by.
  if (systemTags(addTags).length || systemTags(removeTags).length) return c.json({ error: "protected", reason: "System tags are set by Prism, not by hand." }, 403);
  const wantsContent = body.content !== undefined || body.metadata !== undefined;
  if (wantsContent && isLocked(note) && caps.has("view")) return c.json({ error: "locked", reason: "This page is locked. Unlock it to edit." }, 423);
  const wantsTags = addTags.length > 0 || removeTags.length > 0;
  // A path CHANGE is a move: non-owners make it through POST /api/notes/:id/move
  // (pages.ts), which checks the destination, the whole subtree and page-share
  // exposure. A bare PATCH could rename a shared page over existing notes and so
  // share them (security review C1). Restating the current path stays a no-op.
  if (body.path !== undefined && body.path !== note.path) {
    if (caps.has("organize")) return c.json({ error: "move_required", reason: "Move pages with Move to… (POST /api/notes/:id/move)." }, 403);
    body.path = undefined; // an editor's stray path stays a silent no-op (pre-caps behaviour)
  }
  if (body.path !== undefined) body.path = undefined;
  const wantsPath = false;
  // `organize` is what unlocks a note's PATH (previously admin-only). Admins never
  // reach this handler — they short-circuit to the passthrough — but the role check
  // is kept so the rule reads as organize-OR-admin.
  const canPath = caps.has("organize") || roleAtLeast(actor.role, "admin");

  // CONTENT/METADATA need `edit` (what "edit level" has always meant). A request
  // that only REORGANIZES — tags, or a path the actor may set — does not; organize
  // alone suffices. A path change the actor may NOT make still falls through to the
  // edit check, so it stays silently dropped for an editor (pre-caps behavior) and
  // 403s for anyone weaker instead of echoing the note back. An empty body keeps
  // the old contract and is treated as a content write.
  const needsEdit = wantsContent || (!wantsTags && !(wantsPath && canPath));
  if (needsEdit && !caps.has("edit")) return c.json({ error: "forbidden" }, 403);

  // TAGS need `organize`. Retagging re-scopes a note, so it is a distinct power
  // from editing its body — an editor cannot move a note between folders.
  if (wantsTags && !caps.has("organize")) {
    return c.json({ error: "forbidden", reason: "changing tags requires the organize capability" }, 403);
  }

  // ── anti-escalation for `organize` ─────────────────────────────────────────
  // (a) ADDING a tag must not smuggle the note into a scope the actor has no
  //     standing in: each added tag must be one where they hold `create` or
  //     `organize` (via a tag or vault grant — evaluated against a synthetic ref
  //     carrying just that tag). Otherwise a lone organize grant on one folder
  //     could push notes into every other folder in the vault.
  // (b) REMOVING a tag may only name a tag the note actually carries, and must
  //     not drop the actor's OWN effective access below `view` — otherwise they
  //     orphan the note out of their own reach (an irreversible foot-gun, and a
  //     way to make a note invisible to everyone whose access came via that tag).
  if (addTags.length) {
    const forbidden = addTags.filter((t) => !canAddTag(actor, t));
    if (forbidden.length) {
      return c.json(
        { error: "forbidden", reason: `cannot add tags outside your scope: ${forbidden.join(", ")}`, tags: forbidden },
        403,
      );
    }
  }
  const current = new Set(note.tags ?? []);
  if (removeTags.length) {
    const missing = removeTags.filter((t) => !current.has(t));
    if (missing.length) {
      return c.json({ error: "bad_request", reason: `note does not carry: ${missing.join(", ")}`, tags: missing }, 400);
    }
    const after = new Set(current);
    for (const t of removeTags) after.delete(t);
    for (const t of addTags) after.add(t);
    const post = capsFor(actor, { ...noteRef, tags: [...after] });
    if (!post.has("view")) {
      return c.json(
        { error: "bad_request", reason: "removing those tags would drop your own access to this note" },
        400,
      );
    }
  }

  // A non-owner path change never reaches here (move_required above): the move route
  // applies main's `placementRefusal` + the subtree and page-share exposure rules.
  // Every write below names the note by the ID that was authorized above — `id` may
  // be a path/title alias the vault resolves, and it must not resolve twice.
  const noteId = note.id;
  try {
    // Non-owners may change content/metadata (with `edit`) and path/tags (with
    // `organize`). A path change without organize is dropped, not rejected —
    // the pre-caps behavior for an editor who sends one.
    const wantsWrite = wantsContent || (canPath && wantsPath) || (!wantsTags && !wantsPath);
    let updated = note;
    if (wantsWrite) {
      updated = await vc.updateNote(noteId, {
        content: body.content,
        // Only a content/metadata write is stamped (a path-only move is not an edit).
        metadata: wantsContent ? stampChange(stampMetadata(body.metadata, actor), requestVia(c) === "mcp" ? "agent" : "edit") : body.metadata,
        ifUpdatedAt: body.if_updated_at ?? note.updatedAt ?? undefined,
      });
    }
    if (wantsTags) {
      // Separate vault calls (the REST tag ops are add/remove deltas). Remove
      // first so an add wins on an overlapping name; re-read for the final shape.
      if (removeTags.length) await vc.removeTags(noteId, removeTags);
      if (addTags.length) await vc.addTags(noteId, addTags);
      updated = await vc.getNote(noteId);
    }
    treeUpsertNote(resolveVaultEntry(actor.vaultId), updated);
    if (writesTitle(body)) void tellPagesChanged(actor.vaultId, [updated.id]);
    // A write without content to a LIVE doc: keep the reconciler from folding the
    // content-stale vault copy over unsaved typing (review M3).
    if (body.content === undefined) void reconcileMetaWrite(actor.vaultId, noteId, note.updatedAt, updated.updatedAt);
    return c.json(forViewer(actor, updated));
  } catch (e) {
    return vaultErr(c, e);
  }
});

async function reconcileMetaWrite(vaultId: string, id: string, prev: string | null, next: string | null): Promise<void> {
  try {
    const collab = await import("../collab");
    if (!collab.isDocLive(vaultId, id) || !prev || !next) return;
    collab.markReconciled(collab.docNameFor(vaultId, id), Date.parse(prev), Date.parse(next));
  } catch {
    /* best effort */
  }
}

// ── version history (vault ≥ 0.7.9) ──────────────────────────────────────────
// Owners reach the vault's own routes through the passthrough. For everyone else:
// reading history needs `view` on the LIVE note (a deleted note's history is
// owner-only — the vault likewise hides it from scoped sessions), restoring needs
// `edit`. Vault attribution (`actor`/`via`) is stripped: every Prism write shares
// one token, so it names the server, not a person — and scoped vault sessions
// don't get it either.
const stripProvenance = <T extends { actor?: unknown; via?: unknown }>(row: T): Omit<T, "actor" | "via"> => {
  const { actor: _a, via: _v, ...rest } = row;
  return rest;
};

/**
 * Metadata a non-owner restore may not change. A restore rewrites metadata
 * WHOLESALE from the old version, so it is the one write that could bring back what
 * every other non-owner route refuses to set: who can see the note (creator /
 * visibility), its trash state and the page lock. (The sidebar order is left alone:
 * reverting it is harmless, and guarding it would refuse every restore after a reorder.)
 */
const restoreGuarded = (k: string): boolean => isOwnerOnlyMeta(k) || k === LOCK_KEY;

async function viewableNote(c: Context, need: Cap): Promise<{ note: Note } | Response> {
  const actor = resolveActor(c);
  let note: Note;
  try {
    note = await vaultClient(actor.vaultId).getNote(c.req.param("id")!);
  } catch (e) {
    return vaultErr(c, e);
  }
  const caps = capsFor(actor, ref(note));
  if (!caps.has("view")) return notFound(c);
  if (!caps.has(need)) return c.json({ error: "forbidden" }, 403);
  return { note };
}

api.get("/notes/:id/versions", async (c) => {
  const gate = await viewableNote(c, "view");
  if (gate instanceof Response) return gate;
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  try {
    const page = await vaultClient(resolveActor(c).vaultId).listVersions(gate.note.id, limit, offset);
    const viewer = resolveActor(c).kind === "user" ? (resolveActor(c) as { email: string }).email : null;
    const names = viewer ? writerNames() : undefined;
    return c.json({ versions: page.versions.map((v, i) => redactVersionForViewer(v, viewer, names, page.versions[i + 1] ?? null)), total: page.total });
  } catch (e) {
    return vaultErr(c, e);
  }
});

api.get("/notes/:id/versions/:ix", async (c) => {
  const gate = await viewableNote(c, "view");
  if (gate instanceof Response) return gate;
  const ix = Number(c.req.param("ix"));
  if (!Number.isInteger(ix) || ix < 0) return c.json({ error: "bad_request", reason: "invalid version" }, 400);
  try {
    const viewer = resolveActor(c).kind === "user" ? (resolveActor(c) as { email: string }).email : null;
    return c.json(redactVersionForViewer(await vaultClient(resolveActor(c).vaultId).getVersion(gate.note.id, ix), viewer));
  } catch (e) {
    return vaultErr(c, e);
  }
});

api.post("/notes/:id/restore", async (c) => {
  const gate = await viewableNote(c, "edit");
  if (gate instanceof Response) return gate;
  const system = systemNoteRefusal(c, gate.note);
  if (system) return system;
  if (isLocked(gate.note)) return c.json({ error: "locked", reason: "This page is locked. Unlock it to restore a version." }, 423);
  const body = await c.req.json<{ version_ix?: unknown; if_updated_at?: unknown }>().catch(() => ({}) as { version_ix?: unknown; if_updated_at?: unknown });
  const ix = body?.version_ix;
  if (typeof ix !== "number" || !Number.isInteger(ix) || ix < 0) {
    return c.json({ error: "bad_request", reason: "version_ix is required" }, 400);
  }
  const ifUpdatedAt = body.if_updated_at;
  if (typeof ifUpdatedAt !== "string" || !ifUpdatedAt) {
    return c.json({ error: "conflict", status: 428, current: gate.note }, 428);
  }
  const vc = vaultClient(resolveActor(c).vaultId);
  try {
    // Anti-escalation: restore rewrites metadata wholesale, so an old version could
    // re-share a note that was since made private, or reassign its creator.
    const version = await vc.getVersion(gate.note.id, ix);
    const keys = [...new Set([...Object.keys(version.metadata ?? {}), ...Object.keys(gate.note.metadata ?? {})])].filter(restoreGuarded);
    const changed = keys.filter(
      (k) => JSON.stringify(version.metadata?.[k] ?? null) !== JSON.stringify(gate.note.metadata?.[k] ?? null),
    );
    if (changed.length) {
      return c.json(
        { error: "forbidden", reason: `restoring this version would change who can see the note or its lock/trash state (${changed.join(", ")}) — ask an admin` },
        403,
      );
    }
    const restored = await vc.restoreVersion(gate.note.id, ix, ifUpdatedAt);
    treeUpsertNote(resolveVaultEntry(resolveActor(c).vaultId), restored);
    return c.json(forViewer(resolveActor(c), restored));
  } catch (e) {
    return vaultErr(c, e);
  }
});

api.delete("/notes/:id", async (c) => {
  const actor = resolveActor(c);
  // Admins/owners short-circuit to the passthrough (they can delete anything);
  // this handler runs for members/guests/links. A member may delete ONLY their
  // own note (prism_creator) and only with edit+ on it — never someone else's
  // note by default (that's an admin action). 2.4b.
  const vc = vaultClient(actor.vaultId);
  const id = c.req.param("id");
  let note;
  try {
    note = await vc.getNote(id);
  } catch (e) {
    return vaultErr(c, e);
  }
  const subject = actorSubject(actor);
  const noteRef = ref(note);
  const caps = capsFor(actor, noteRef);
  if (!caps.has("view")) return notFound(c);
  const system = systemNoteRefusal(c, note);
  if (system) return system;
  const isCreator = !!subject && noteRef.creator === subject;
  // Either path suffices: the pre-caps rule (your OWN note, with edit on it), or
  // the explicit `delete` cap — the composable way to say "may clean up this
  // folder" without also handing over ownership of it.
  if (!((isCreator && caps.has("edit")) || caps.has("delete"))) {
    return c.json(
      { error: "forbidden", reason: "delete requires being the note's creator with edit access, or the delete capability" },
      403,
    );
  }
  try {
    // By the id that was authorized — never the request's alias, resolved a second time.
    await vc.deleteNote(note.id);
  } catch (e) {
    return vaultErr(c, e);
  }
  treeRemoveNote(resolveVaultEntry(actor.vaultId), note.id);
  deleteCollabSetAsideForNote(actor.vaultId, note.id);
  return c.json({ ok: true });
});

// GET /search lives in ./search.ts (mounted above, before the owner short-circuit).

api.get("/tags", async (c) => {
  const actor = resolveActor(c);
  let tags: Array<{ tag: string; count: number }>;
  try {
    tags = await vaultClient(actor.vaultId).getTags();
  } catch (e) {
    return vaultErr(c, e);
  }
  if (roleAtLeast(actor.role, "admin")) return c.json(tags);
  const allowed = new Set(grantedTags(actor.grants));
  return c.json(tags.filter((t) => allowed.has(t.tag)));
});

// Non-owner catch-all: any /api path not authorized above is denied. (Owners
// never reach here — they short-circuit to proxyToVault in the middleware.)
api.all("/*", (c) => c.json({ error: "forbidden" }, 403));
