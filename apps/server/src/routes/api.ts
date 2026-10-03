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
import { resolveVaultEntry } from "../db";
import { vault, vaultClient, VaultError, VaultConflictError, type Note } from "../parachute";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { effectiveLevel, effectiveCaps, grantedTags, resolvePageAnchor, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import { compress } from "hono/compress";
import { openEventStream } from "../events";
import { ensureTree, renderTree, etagMatches, treeUpsertNote, treeRemoveNote, treeAfterOwnerWrite, treeRowLocked, warmPageAnchors } from "../tree";
import { canvasApi } from "./canvas";
import { threadsApi } from "./threads";
import { peopleApi } from "./people";
import { humanCollabApi } from "./human-collab";
import { transcriptsApi } from "./transcripts";
import { databasesApi } from "./databases";
import { sharingApi } from "./sharing";
import { consumeRateLimit } from "../middleware/ratelimit";
import { redactVersionForViewer, stripWriterMeta, changeValue, CHANGE_KEY, WRITER_META_KEYS } from "../sharing";
import { writerNames, WRITER_AT_KEY } from "../writer-stamp";
import { stampJsonBody, stampMetadata, stripIdentity } from "../writer-stamp";
import { graphNeighborhood } from "../graph";
import { buildWikilinkIndex, resolveWikilink, noteLinkTitle } from "@prism/core/wikilinks";
import { isTrashed, isLocked, isOwnerOnlyMeta, TRASH_TAG, TRASH_META, LOCK_KEY, ORDER_KEY } from "@prism/core/pages";
import { createPagesApi } from "../pages";
import { notificationsRoutes, restMentionHook } from "./notifications";

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
/** What a non-owner receives: no attribution keys (review M3); a link gets no identity keys at all. */
const forViewer = <T extends { metadata?: Record<string, unknown> | null }>(actor: Actor, note: T): T =>
  ({ ...note, metadata: actor.kind === "link" ? stripIdentity(stripWriterMeta(note.metadata)) : stripWriterMeta(note.metadata) });

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
    readCache.clear();
    // Owner/admin bypass of a page lock is allowed but audited (one line, no content).
    const lockedId = method === "PATCH" ? path.match(/^\/notes\/([^/?]+)$/)?.[1] : undefined;
    if (lockedId && treeRowLocked(entry, decodeURIComponent(lockedId)) && /"content"\s*:/.test(init.body as string)) {
      console.warn(`[pages] lock bypass: ${resolveActor(c).kind === "user" ? (resolveActor(c) as { email: string }).email : "?"} edited locked note ${decodeURIComponent(lockedId)} (vault ${entry.id})`);
    }
  }
  const t0 = Date.now();
  let res: ProxiedResponse;
  try {
    res = method === "GET" ? await coalescedGet(target, init) : await forward(target, init);
  } catch (e) {
    console.warn(`[gateway] vault ${method} ${path} failed: ${(e as Error).message}`);
    return c.json({ error: "vault_unreachable" }, 502);
  }
  // Keep the WP7.1 tree projection current for the owner's own writes (the vault
  // subscribe socket covers everyone else's; this makes the writer's next read exact).
  if (method !== "GET" && method !== "HEAD" && res.status >= 200 && res.status < 300) {
    void treeAfterOwnerWrite(entry, method, path, res.body).catch(() => {});
  }
  if (process.env.PRISM_VAULT_TRACE === "1") {
    console.log(`[trace] proxy ${method} ${path}${url.search} → ${res.status} ${res.body.length}B ${Date.now() - t0}ms ua=${(c.req.header("user-agent") ?? "").slice(0, 40)}`);
  }
  return new Response(res.body, { status: res.status, headers: { "Content-Type": res.contentType } });
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

async function coalescedGet(target: string, init: RequestInit): Promise<ProxiedResponse> {
  const hit = readCache.get(target);
  if (hit && hit.expires > Date.now()) return hit.res;
  const pending = inflight.get(target);
  if (pending) return pending;
  const p = (async () => {
    let res: ProxiedResponse;
    try {
      res = await forward(target, init);
    } catch {
      // A reused keep-alive socket can be reset by the vault; a GET is idempotent,
      // so retry once on a fresh request before giving up.
      res = await forward(target, init);
    }
    if (res.status === 200 && READ_TTL_MS > 0) readCache.set(target, { expires: Date.now() + READ_TTL_MS, res });
    if (readCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of readCache) if (v.expires <= now) readCache.delete(k);
    }
    return res;
  })();
  inflight.set(target, p);
  try {
    return await p;
  } finally {
    inflight.delete(target);
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
  readCache.clear();
});
api.route("/canvas", canvasApi);
api.use("/transcripts/*", async (c, next) => {
  await next();
  // Link decisions write notes outside the owner proxy: drop cached owner reads.
  if (c.req.method !== "GET") readCache.clear();
});
api.route("/transcripts", transcriptsApi);
// Pages (nested-page move, Trash, synced preferences): before the owner passthrough,
// like /tree — these are Prism routes, not vault routes. Writes drop cached owner reads.
api.route("/", createPagesApi({ onWrite: () => readCache.clear() }));
// Sharing reads (shared-with-me, comment index, page activity, move access preview).
api.route("/", sharingApi);
// Typed properties + database views (schemas, lean query, property writes).
// Their writes bypass the owner proxy: drop cached owner reads afterwards.
api.use("/properties/*", async (c, next) => { await next(); readCache.clear(); });
api.use("/schemas/*", async (c, next) => { await next(); if (c.req.method !== "GET") readCache.clear(); });
api.use("/databases/*", async (c, next) => { await next(); if (c.req.method !== "GET") readCache.clear(); });
api.route("/", databasesApi);
// Notifications inbox, reminders, access requests (wave 2A): before the owner passthrough.
api.route("/", notificationsRoutes);

api.get("/graph/neighborhood", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({error:"unauthorized"},401);
  if (resolveVaultEntry(actor.vaultId).id !== actor.vaultId) return c.json({error:"vault_unavailable"},409);
  const center = c.req.query("center") ?? "";
  const depth = Number(c.req.query("depth") ?? 1);
  const limit = Number(c.req.query("limit") ?? 150);
  if (!center || center.length > 2048 || !Number.isInteger(depth) || depth < 1 || depth > 5 || !Number.isInteger(limit) || limit < 1 || limit > 500) return c.json({error:"bad_request"},400);
  try {
    const notes = await vaultClient(actor.vaultId).listNotes({includeLinks:true,includeMetadata:["title","type","prism_creator","prism_visibility"]});
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
  const { body, etag } = renderTree(tree, owner ? undefined : (r) => capsFor(actor, r).has("view"));
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
const SCHEMA_V2_MARKERS = /data-type="(?:callout|toggle|columns|column|mention)"|<details[\s>]|data-block-color=|data-text-color=/;
export function needsEditorUpdate(storedContent: string | null | undefined): boolean {
  return SCHEMA_V2_MARKERS.test(storedContent ?? "");
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
  let stored: string;
  try { stored = (await vaultClient(actor.vaultId).getNote(c.req.param("id"))).content ?? ""; } catch { return next(); }
  if (!needsEditorUpdate(stored)) return next();
  return c.json({ error: "editor_update_required", message: "Prism was updated. Reload or update the app to keep editing." }, 409);
});

// Wave 2A: a successful content write carrying @-mention chips → notifications +
// mention backlinks (both the owner passthrough and the member route; never
// changes the response). After the schema gate, before the owner short-circuit.
api.use("/notes", restMentionHook);
api.use("/notes/:id", restMentionHook);

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
    if (caps.has("view")) out.push(stamp ? { ...n, metadata: stripWriterMeta(n.metadata), _caps: [...caps] } : actor.kind === "link" ? { ...n, metadata: stripIdentity(n.metadata) } : { ...n, metadata: stripWriterMeta(n.metadata) });
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

async function visibleNotes(actor: Actor, includeContent: boolean): Promise<Note[]> {
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
    return annotate(actor, all);
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
  // Bounded: at most PAGE_GRANT_LISTINGS shared pages are expanded per request, the
  // outermost first (a page inside an already-listed page adds nothing).
  const anchors = actor.grants
    .filter((x) => x.resource_type === "page")
    .map((g) => resolvePageAnchor(g.vault_id ?? actor.vaultId, g.resource)?.path)
    .filter((p): p is string => !!p)
    .sort((a, b) => a.length - b.length);
  const listed: string[] = [];
  for (const path of anchors) {
    if (listed.some((p) => path.startsWith(`${p}/`))) continue;
    if (listed.length >= PAGE_GRANT_LISTINGS) break;
    listed.push(path);
    try {
      for (const n of await vc.listNotes({ pathPrefix: `${path}/`, includeContent })) collected.set(n.id, n);
    } catch {
      /* listing failed — the anchor itself is still fetched below */
    }
  }
  for (const g of actor.grants.filter((x) => x.resource_type === "note" || x.resource_type === "page")) {
    if (collected.has(g.resource)) continue;
    try {
      collected.set(g.resource, await vc.getNote(g.resource));
    } catch {
      /* granted note may have been deleted — skip */
    }
  }
  return annotate(actor, [...collected.values()]);
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
  let notes = await visibleNotes(actor, includeContent);
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
  if (!caps.has("view")) return c.json({ error: "forbidden" }, 403);
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
  return c.json(annotated(actor) ? { ...note, _level: level, _caps: [...caps] } : { ...note, _level: level });
});

api.post("/notes", async (c) => {
  const actor = resolveActor(c);
  // Owners/admins are short-circuited to the passthrough upstream; this handler
  // runs for members/guests/links. A signed-in MEMBER may create — but only
  // inside a tag/folder they can already EDIT, so a create can't smuggle a note
  // into an area they lack access to. Guests/links/anon cannot create.
  const body = await c.req.json<{
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }>();
  const subject = actorSubject(actor);
  const slice: NoteRef = { id: "<new>", tags: body.tags ?? [] };
  // The `create` CAP on the target tag slice. `edit` expands to include create,
  // so every pre-caps edit grant still creates exactly as before; a caps grant can
  // now say "may add notes here" WITHOUT conferring edit on what is already there.
  const canCreate = actor.kind === "user" && capsFor(actor, slice).has("create");
  if (!canCreate) {
    return c.json({ error: "forbidden", reason: "create requires the create capability on the target tag/folder" }, 403);
  }
  // Stamp the creator (private-to-creator + audit). A member can't forge it — we
  // overwrite any client-supplied prism_creator with the authenticated subject.
  // Owner-only keys (creator/visibility/trash state, lock) and the trash tag are never
  // accepted from a non-owner create (review H3/M1).
  // Narrowing is safe: a non-owner may create a note as private (e.g. a private task).
  const metadata = Object.fromEntries(Object.entries(body.metadata ?? {}).filter(([k, v]) => (k === "prism_visibility" ? v === "private" : !isOwnerOnlyMeta(k) && k !== LOCK_KEY && k !== ORDER_KEY && !(WRITER_META_KEYS as readonly string[]).includes(k))));
  if (subject) metadata.prism_creator = subject;
  // The writer stamp is server-owned: client values were dropped above, ours is applied here.
  Object.assign(metadata, stampChange(stampMetadata(undefined, actor), requestVia(c) === "mcp" ? "agent" : "edit"));
  body.tags = (body.tags ?? []).filter((t) => t !== TRASH_TAG);
  try {
    const created = await vaultClient(actor.vaultId).createNote({ ...body, metadata });
    treeUpsertNote(resolveVaultEntry(actor.vaultId), created);
    return c.json(forViewer(actor, created));
  } catch (e) {
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

  const body = await c.req.json<{
    content?: string;
    metadata?: Record<string, unknown>;
    path?: string;
    add_tags?: string[];
    remove_tags?: string[];
    if_updated_at?: string;
  }>();

  const strings = (x: unknown): string[] =>
    Array.isArray(x) ? [...new Set(x.filter((t): t is string => typeof t === "string" && t.length > 0))] : [];
  const addTags = strings(body.add_tags);
  const removeTags = strings(body.remove_tags);
  // H3/M1/LOCK: a non-owner never writes who-can-see / who-created / trash state, the
  // page lock or the sidebar order through this route, and never toggles the trash tag.
  // The writer stamp is server-owned (review M3): whatever a client sends for it is
  // dropped (never stored), and the server's own stamp is applied on the write below.
  if (body.metadata && typeof body.metadata === "object" && (WRITER_META_KEYS as readonly string[]).some((k) => k in body.metadata!)) {
    body.metadata = Object.fromEntries(Object.entries(body.metadata).filter(([k]) => !(WRITER_META_KEYS as readonly string[]).includes(k)));
  }
  const meta = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
  const subjectNow = actorSubject(actor);
  const forbiddenKey = (k: string): boolean => {
    // Narrowing only: the note's creator may make it private; never widen it, and
    // never (re)assign the creator — a no-op restatement of either is fine.
    if (k === "prism_visibility") return !(meta[k] === "private" && noteRef.creator === subjectNow) && meta[k] !== note.metadata?.[k];
    if (k === "prism_creator") return meta[k] !== note.metadata?.[k];
    return isOwnerOnlyMeta(k) || k === LOCK_KEY || k === ORDER_KEY;
  };
  if (Object.keys(meta).some(forbiddenKey)) {
    return c.json({ error: "forbidden", reason: "That property can only be changed through its own control." }, 403);
  }
  if (addTags.includes(TRASH_TAG) || removeTags.includes(TRASH_TAG)) {
    return c.json({ error: "forbidden", reason: "Use Move to Trash / Restore." }, 403);
  }
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
    const forbidden = addTags.filter((t) => {
      const slice = capsFor(actor, { id: "<retag>", tags: [t] });
      return !(slice.has("create") || slice.has("organize"));
    });
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

  try {
    // Non-owners may change content/metadata (with `edit`) and path/tags (with
    // `organize`). A path change without organize is dropped, not rejected —
    // the pre-caps behavior for an editor who sends one.
    const wantsWrite = wantsContent || (canPath && wantsPath) || (!wantsTags && !wantsPath);
    let updated = note;
    if (wantsWrite) {
      updated = await vc.updateNote(id, {
        content: body.content,
        // Only a content/metadata write is stamped (a path-only move is not an edit).
        metadata: wantsContent ? stampChange(stampMetadata(body.metadata, actor), requestVia(c) === "mcp" ? "agent" : "edit") : body.metadata,
        path: canPath ? body.path : undefined,
        ifUpdatedAt: body.if_updated_at ?? note.updatedAt ?? undefined,
      });
    }
    if (wantsTags) {
      // Separate vault calls (the REST tag ops are add/remove deltas). Remove
      // first so an add wins on an overlapping name; re-read for the final shape.
      if (removeTags.length) await vc.removeTags(id, removeTags);
      if (addTags.length) await vc.addTags(id, addTags);
      updated = await vc.getNote(id);
    }
    treeUpsertNote(resolveVaultEntry(actor.vaultId), updated);
    // A write without content to a LIVE doc: keep the reconciler from folding the
    // content-stale vault copy over unsaved typing (review M3).
    if (body.content === undefined) void reconcileMetaWrite(actor.vaultId, id, note.updatedAt, updated.updatedAt);
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

/** Metadata keys that decide WHO can see a note. A non-owner restore may not change them. */
const ACCESS_KEYS = ["prism_creator", "prism_visibility"] as const;

async function viewableNote(c: Context, need: Cap): Promise<{ note: Note } | Response> {
  const actor = resolveActor(c);
  let note: Note;
  try {
    note = await vaultClient(actor.vaultId).getNote(c.req.param("id")!);
  } catch (e) {
    return vaultErr(c, e);
  }
  if (!capsFor(actor, ref(note)).has(need)) return c.json({ error: "forbidden" }, 403);
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
    return c.json({ versions: page.versions.map((v) => redactVersionForViewer(v, viewer, names)), total: page.total });
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
  if (isLocked(gate.note)) return c.json({ error: "locked", reason: "This page is locked. Unlock it to restore a version." }, 423);
  const body = await c.req.json<{ version_ix?: number; if_updated_at?: string }>().catch(() => ({}) as { version_ix?: number; if_updated_at?: string });
  const ix = body.version_ix;
  if (typeof ix !== "number" || !Number.isInteger(ix) || ix < 0) {
    return c.json({ error: "bad_request", reason: "version_ix is required" }, 400);
  }
  if (!body.if_updated_at) {
    return c.json({ error: "conflict", status: 428, current: gate.note }, 428);
  }
  const vc = vaultClient(resolveActor(c).vaultId);
  try {
    // Anti-escalation: restore rewrites metadata wholesale, so an old version could
    // re-share a note that was since made private, or reassign its creator.
    const version = await vc.getVersion(gate.note.id, ix);
    const changed = ACCESS_KEYS.filter(
      (k) => (version.metadata?.[k] ?? null) !== (gate.note.metadata?.[k] ?? null),
    );
    if (changed.length) {
      return c.json(
        { error: "forbidden", reason: `restoring this version would change who can see the note (${changed.join(", ")}) — ask an admin` },
        403,
      );
    }
    const restored = await vc.restoreVersion(gate.note.id, ix, body.if_updated_at);
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
    await vc.deleteNote(id);
  } catch (e) {
    return vaultErr(c, e);
  }
  treeRemoveNote(resolveVaultEntry(actor.vaultId), id);
  return c.json({ ok: true });
});

api.get("/search", async (c) => {
  const actor = resolveActor(c);
  const q = c.req.query("q") ?? c.req.query("search") ?? "";
  const limit = Number(c.req.query("limit") ?? 50);
  let results: Note[];
  try {
    results = await vaultClient(actor.vaultId).search(q, [], limit);
  } catch (e) {
    return vaultErr(c, e);
  }
  if (roleAtLeast(actor.role, "admin")) return c.json(results);
  return c.json(annotate(actor, results));
});

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
