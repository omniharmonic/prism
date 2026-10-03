/**
 * Sharing, review and activity reads (wave 2D) — mounted inside the gateway
 * BEFORE the owner short-circuit (like /tree), so owners and non-owners reach the
 * same handlers and every check is the gateway's `effectiveCaps(...).has("view")`.
 *
 *   GET /api/shared-with-me                 pages/notes/tags shared with the caller (NP-SB-09, NP-CO-14)
 *   GET /api/comments                       comment threads across viewable pages (all-comments view; ?note= ?unresolved=1 ?mine=1 ?limit=)
 *   GET /api/notes/:id/activity             one page's comments + shares (+ who), for the Updates feed (NP-CO-15)
 *   GET /api/notes/:id/access-preview?parent=<path>   how a move would change inherited access (NP-CO-09 warning)
 *
 * All are reads: no CSRF surface. Each is rate-limited per actor (they decode
 * Y.Doc snapshots or walk the tree). Nothing here names a note the caller can't
 * view, counts them, or reveals an email the caller could not already see.
 */
import { Hono, type Context } from "hono";
import * as Y from "yjs";
import { resolveActor, type Actor } from "../auth/actor";
import { db, getDocState, getVaultRegistry, grantsForResource, type Grant } from "../db";
import { effectiveCaps, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import { ensureTree, rowRef, type TreeRow } from "../tree";
import { vaultClient, VaultError, type Note } from "../parachute";
import { consumeRateLimit } from "../middleware/ratelimit";
import { ancestorPages, creatorNameFor, displayNameOnly, inheritedPeople, personView, versionWriter, viewableAncestors } from "../sharing";
import { TRASH_TAG } from "@prism/core/pages";
import type { VaultEntry } from "../config";
import { WRITER_KEY, writerIdFor, writerNames } from "../writer-stamp";

export const sharingApi = new Hono();

const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const READS_PER_MINUTE = Number(process.env.SHARING_READS_PER_MINUTE ?? 60);

const subjectOf = (a: Actor): string | null => (a.kind === "user" ? a.email : a.kind === "link" ? a.capabilityId : null);
const capsOf = (a: Actor, r: NoteRef): Set<Cap> => effectiveCaps(a.grants, r, roleFloor(a.role), subjectOf(a));
const isAdmin = (a: Actor): boolean => roleAtLeast(a.role, "admin");
const canView = (a: Actor, r: NoteRef): boolean => isAdmin(a) || capsOf(a, r).has("view");
const live = (r: TreeRow): boolean => !r.trashedAt && !r.tags.includes(TRASH_TAG);
const noteRef = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
  path: n.path ?? null,
});
const titleOf = (path: string | null, id: string): string => (path ? path.slice(path.lastIndexOf("/") + 1) : id);

function entryOf(a: Actor): VaultEntry | null {
  return getVaultRegistry().find((v) => v.id === a.vaultId) ?? null;
}

/** Per-actor read budget; null = go ahead. */
function limited(c: Context, a: Actor, name: string): Response | null {
  const key = `sharing:${name}:${a.vaultId}:${subjectOf(a) ?? "anon"}`;
  const wait = consumeRateLimit(key, READS_PER_MINUTE, 60_000);
  if (wait === null) return null;
  c.header("Retry-After", String(wait));
  return c.json({ error: "rate_limited", retryAfter: wait }, 429);
}

/** Read a note by its real id for an actor; null when absent, aliased, trashed or not viewable. */
async function viewableNote(a: Actor, id: string): Promise<Note | null> {
  if (!NOTE_ID.test(id)) return null;
  try {
    const n = await vaultClient(a.vaultId).getNote(id);
    if (n.id !== id || (n.tags ?? []).includes(TRASH_TAG)) return null;
    return canView(a, noteRef(n)) ? n : null;
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return null;
    throw e;
  }
}

/** May this actor manage (and therefore see) the people with access to `n`? */
const canManageAccess = (a: Actor, n: Note): boolean => a.kind === "user" && (isAdmin(a) || capsOf(a, noteRef(n)).has("share"));

// ── GET /shared-with-me ──────────────────────────────────────────────────────

interface SharedItem {
  id: string;
  title: string;
  path: string | null;
  /** "page" = the page and its sub-pages; "note" = this note only. */
  scope: "page" | "note";
  level: string;
  sharedAt: number;
  sharedBy: { name: string };
  type?: string;
  prismType?: string;
}

sharingApi.get("/shared-with-me", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const a = resolveActor(c);
  if (a.kind !== "user") return c.json({ error: "unauthorized" }, 401);
  const stop = limited(c, a, "shared");
  if (stop) return stop;
  const entry = entryOf(a);
  if (!entry) return c.json({ items: [], tags: [] });
  let rows: Map<string, TreeRow>;
  try {
    const tree = await ensureTree(entry);
    rows = new Map(tree.rows().map((r) => [r.id, r]));
  } catch {
    return c.json({ error: "vault_unavailable" }, 502);
  }
  const mine = a.grants.filter((g) => g.subject_type === "user" && g.subject === a.email && (g.vault_id ?? "primary") === a.vaultId);
  const items: SharedItem[] = [];
  const seen = new Set<string>();
  for (const g of mine) {
    if (g.resource_type !== "page" && g.resource_type !== "note") continue;
    const r = rows.get(g.resource);
    if (!r || !live(r) || seen.has(r.id) || !canView(a, rowRef(r))) continue;
    seen.add(r.id);
    const item: SharedItem = {
      id: r.id,
      title: titleOf(r.path, r.id),
      path: r.path,
      scope: g.resource_type === "page" ? "page" : "note",
      level: g.level,
      sharedAt: g.created_at,
      sharedBy: { name: g.created_by && !g.created_by.startsWith("governance:") ? displayNameOnly(g.created_by) : "Someone" },
    };
    if (r.type) item.type = r.type;
    if (r.prismType) item.prismType = r.prismType;
    items.push(item);
  }
  // Top level only: a page shared inside another shared PAGE shows under it.
  const pagePaths = items.filter((i) => i.scope === "page" && i.path).map((i) => i.path!);
  const top = items.filter((i) => !i.path || !pagePaths.some((p) => i.path!.startsWith(`${p}/`)));
  top.sort((x, y) => y.sharedAt - x.sharedAt || x.title.localeCompare(y.title));
  const tags = mine
    .filter((g) => g.resource_type === "tag")
    .map((g) => ({ tag: g.resource, level: g.level, sharedAt: g.created_at }))
    .sort((x, y) => x.tag.localeCompare(y.tag));
  return c.json({ items: top.slice(0, 500), tags: tags.slice(0, 200) });
});

// ── comment threads ──────────────────────────────────────────────────────────

interface CommentOut {
  author: string;
  text: string;
  createdAt: number;
  agent: boolean;
  mine: boolean;
}
interface ThreadOut {
  noteId: string;
  noteTitle: string;
  threadId: string;
  quote: string;
  resolved: boolean;
  lastActivity: number;
  comments: CommentOut[];
}

/** The caller's comment identity as the document records it (see human-collab documentActorId). */
async function myActorIds(a: Actor): Promise<{ ids: Set<string>; names: Set<string> }> {
  const { documentActorId } = await import("../human-collab");
  const ids = new Set<string>();
  const names = new Set<string>();
  if (a.kind === "user") {
    ids.add(documentActorId(`user:${a.email}`));
    const n = personView(a.email).name;
    if (n) names.add(n);
    names.add(a.email);
  } else if (a.kind === "link") ids.add(documentActorId(`capability:${a.capabilityId}`));
  return { ids, names };
}

/** Threads of one document, from the live doc when loaded, else its persisted snapshot. Never loads a doc. */
async function threadsOf(vaultId: string, noteId: string): Promise<Array<{ id: string; quote: string; resolved: boolean; items: Array<Record<string, unknown>> }>> {
  const { liveDocument, docNameFor } = await import("../collab");
  const live = liveDocument(docNameFor(vaultId, noteId));
  let doc = live;
  let scratch: Y.Doc | null = null;
  if (!doc) {
    const snap = getDocState(noteId, vaultId);
    if (!snap) return [];
    scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, snap.state);
    } catch {
      scratch.destroy();
      return [];
    }
    doc = scratch;
  }
  const out: Array<{ id: string; quote: string; resolved: boolean; items: Array<Record<string, unknown>> }> = [];
  try {
    if (!doc.share.has("comments")) return out;
    doc.getMap<Y.Map<unknown>>("comments").forEach((t) => {
      const items = ((t.get("comments") as Y.Array<Record<string, unknown>> | undefined)?.toArray() ?? []).filter((x) => x && typeof x === "object");
      out.push({ id: String(t.get("id") ?? ""), quote: String(t.get("quote") ?? "").slice(0, 300), resolved: !!t.get("resolved"), items });
    });
  } finally {
    scratch?.destroy();
  }
  return out;
}

function shapeThreads(noteId: string, noteTitle: string, raw: Awaited<ReturnType<typeof threadsOf>>, me: { ids: Set<string>; names: Set<string> }, opts: { unresolved: boolean; mine: boolean }): ThreadOut[] {
  const out: ThreadOut[] = [];
  for (const t of raw) {
    if (opts.unresolved && t.resolved) continue;
    const comments: CommentOut[] = t.items.slice(0, 200).map((x) => {
      const actorId = typeof x.actorId === "string" ? x.actorId : null;
      const author = typeof x.author === "string" ? x.author.slice(0, 80) : "Someone";
      return {
        author,
        text: typeof x.text === "string" ? x.text.slice(0, 4000) : "",
        createdAt: typeof x.createdAt === "number" ? x.createdAt : 0,
        agent: x.agent === true,
        mine: actorId ? me.ids.has(actorId) : x.agent !== true && me.names.has(author),
      };
    });
    if (!comments.length) continue;
    if (opts.mine && !comments.some((c) => c.mine)) continue;
    out.push({ noteId, noteTitle, threadId: t.id, quote: t.quote, resolved: t.resolved, lastActivity: Math.max(...comments.map((c) => c.createdAt)), comments });
  }
  return out;
}

const listDocNames = db.prepare("SELECT name FROM collab_docs WHERE vault_id = ? ORDER BY updated_at DESC LIMIT ?");
const MAX_DOCS_SCANNED = Number(process.env.COMMENTS_MAX_DOCS ?? 400);

sharingApi.get("/comments", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const a = resolveActor(c);
  if (a.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const stop = limited(c, a, "comments");
  if (stop) return stop;
  const unresolved = c.req.query("unresolved") === "1";
  const mineOnly = c.req.query("mine") === "1";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const me = await myActorIds(a);
  const noteId = c.req.query("note");
  try {
    if (noteId !== undefined) {
      const n = await viewableNote(a, noteId);
      if (!n) return c.json({ error: "not_found" }, 404);
      const threads = shapeThreads(n.id, titleOf(n.path ?? null, n.id), await threadsOf(a.vaultId, n.id), me, { unresolved, mine: mineOnly });
      threads.sort((x, y) => y.lastActivity - x.lastActivity);
      return c.json({ threads: threads.slice(0, limit) });
    }
    const entry = entryOf(a);
    if (!entry) return c.json({ threads: [] });
    const tree = await ensureTree(entry);
    const rows = new Map(tree.rows().map((r) => [r.id, r]));
    const names = (listDocNames.all(a.vaultId, MAX_DOCS_SCANNED) as Array<{ name: string }>).map((r) => r.name);
    const all: ThreadOut[] = [];
    for (const name of names) {
      const r = rows.get(name);
      if (!r || !live(r) || !canView(a, rowRef(r))) continue;
      all.push(...shapeThreads(r.id, titleOf(r.path, r.id), await threadsOf(a.vaultId, r.id), me, { unresolved, mine: mineOnly }));
    }
    all.sort((x, y) => y.lastActivity - x.lastActivity);
    return c.json({ threads: all.slice(0, limit) });
  } catch {
    return c.json({ error: "vault_unavailable" }, 502);
  }
});

// ── GET /notes/:id/activity ──────────────────────────────────────────────────

sharingApi.get("/notes/:id/activity", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const a = resolveActor(c);
  if (a.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const stop = limited(c, a, "activity");
  if (stop) return stop;
  try {
    const n = await viewableNote(a, c.req.param("id"));
    if (!n) return c.json({ error: "not_found" }, 404);
    const me = await myActorIds(a);
    const comments = shapeThreads(n.id, titleOf(n.path ?? null, n.id), await threadsOf(a.vaultId, n.id), me, { unresolved: false, mine: false });
    // Shares name people — only for callers who may already see this page's access list.
    const manage = canManageAccess(a, n);
    const shares: Array<{ name: string | null; avatar: string | null; email?: string; level: string; at: number; by: string; scope: "page" | "note"; inheritedFrom?: { id: string; title: string } }> = [];
    if (manage) {
      for (const type of ["page", "note"] as const) {
        for (const g of grantsForResource(type, n.id, a.vaultId)) {
          if (g.subject_type !== "user") continue;
          const p = personView(g.subject);
          shares.push({ name: p.name, avatar: p.avatar, email: g.subject, level: g.level, at: g.created_at, by: displayNameOnly(g.created_by), scope: type });
        }
      }
      const entry = entryOf(a);
      if (entry && n.metadata?.prism_visibility !== "private") {
        // Only ancestors the caller can view; emails for administrators only (review L-4).
        const ancestors = isAdmin(a) ? await ancestorPages(entry, n.path) : await viewableAncestors(entry, n.path, (r) => canView(a, r));
        for (const p of await inheritedPeople(entry, n.id, n.path, ancestors)) {
          const g = grantsForResource("page", p.from.id, a.vaultId).find((x) => x.subject_type === "user" && x.subject === p.email);
          shares.push({ name: isAdmin(a) ? p.name : (creatorNameFor(p.email) ?? "Someone"), avatar: p.avatar, ...(isAdmin(a) && p.email ? { email: p.email } : {}), level: p.level, at: g?.created_at ?? 0, by: displayNameOnly(g?.created_by), scope: "page", inheritedFrom: { id: p.from.id, title: p.from.title } });
        }
      }
      shares.sort((x, y) => y.at - x.at);
    }
    const viewer = a.kind === "user" ? a.email : null;
    // Names behind the opaque writer stamps of THIS page (current + its versions),
    // for signed-in viewers only — the owner passthrough serves raw stamps, and
    // the client resolves them with this map (never the whole account list).
    let writers: Record<string, string> | undefined;
    let myWriterId: string | undefined;
    const names = viewer ? writerNames(isAdmin(a)) : undefined;
    if (viewer && names) {
      myWriterId = writerIdFor(viewer);
      writers = {};
      const stamps = new Set<string>();
      const add = (m: Record<string, unknown> | null | undefined) => {
        const v = m?.[WRITER_KEY];
        if (typeof v === "string") stamps.add(v);
      };
      add(n.metadata);
      try {
        for (const v of (await vaultClient(a.vaultId).listVersions(n.id, 100, 0)).versions) add(v.metadata);
      } catch {
        /* history unavailable: the current stamp is still named */
      }
      for (const id of stamps) {
        const name = names.get(id);
        if (name) writers[id] = name;
      }
    }
    return c.json({
      comments,
      shares,
      sharesVisible: manage,
      lastEditor: versionWriter(n.metadata ?? null, null, viewer, names, n.updatedAt ?? null),
      createdAt: n.createdAt ?? null,
      updatedAt: n.updatedAt ?? null,
      ...(writers ? { writers, me: myWriterId } : {}),
    });
  } catch {
    return c.json({ error: "vault_unavailable" }, 502);
  }
});

// ── GET /notes/:id/access-preview?parent=<path> ─────────────────────────────

/**
 * How moving this page (with its sub-pages) under `parent` would change the
 * access people INHERIT from shared ancestor pages. Shares anchored inside the
 * moved group travel with it and never change; per-note and tag grants never
 * change. The move itself is `POST /api/notes/:id/move` (pages.ts) — this only
 * powers the "people will lose/gain access" warning before it.
 * Names are returned only to callers who may manage this page's access.
 */
sharingApi.get("/notes/:id/access-preview", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const a = resolveActor(c);
  if (a.kind !== "user") return c.json({ error: "unauthorized" }, 401);
  const stop = limited(c, a, "preview");
  if (stop) return stop;
  const parent = (c.req.query("parent") ?? "").replace(/^\/+|\/+$/g, "");
  if (parent.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(parent) || parent.split("/").some((s) => s === "." || s === "..")) {
    return c.json({ error: "bad_request" }, 400);
  }
  try {
    const n = await viewableNote(a, c.req.param("id"));
    if (!n || !n.path) return c.json({ error: "not_found" }, 404);
    const entry = entryOf(a);
    if (!entry) return c.json({ error: "not_found" }, 404);
    // The destination must be a page the caller can SEE and add to (the move
    // route's own rule); anything else answers exactly like a missing page, so
    // this is never an oracle for hidden pages or their grantees (review M1).
    if (!isAdmin(a)) {
      if (!parent) return c.json({ error: "not_found" }, 404);
      const page = await vaultClient(a.vaultId).getNote(parent).catch(() => null);
      const caps = page && page.path === parent && !(page.tags ?? []).includes(TRASH_TAG) ? capsOf(a, noteRef(page)) : null;
      if (!caps || !caps.has("view") || !(caps.has("create") || caps.has("organize"))) return c.json({ error: "not_found" }, 404);
    }
    const leaf = n.path.slice(n.path.lastIndexOf("/") + 1);
    const newPath = parent ? `${parent}/${leaf}` : leaf;
    const before = await inheritedLevels(entry, n.id, n.path, undefined, a);
    const after = await inheritedLevels(entry, n.id, newPath, n.path, a);
    const people = new Set([...before.keys(), ...after.keys()]);
    const changes: Array<{ email: string | null; name: string | null; avatar: string | null; from: string | null; to: string | null }> = [];
    for (const email of people) {
      const from = before.get(email) ?? null;
      const to = after.get(email) ?? null;
      if (from === to) continue;
      const p = personView(email);
      // Names for access managers; the email itself only for administrators (review L-4).
      changes.push({ email: isAdmin(a) ? email : null, name: isAdmin(a) ? p.name : (creatorNameFor(email) ?? "Someone"), avatar: p.avatar, from, to });
    }
    const willChange = changes.length > 0;
    if (!canManageAccess(a, n)) return c.json({ willChange });
    return c.json({ willChange, losing: changes.filter((x) => !x.to).length, gaining: changes.filter((x) => !x.from).length, changes: changes.slice(0, 100) });
  } catch {
    return c.json({ error: "vault_unavailable" }, 502);
  }
});

/**
 * email → level each person inherits on a page at `path` from ancestor page
 * grants (nearest per person). `excludePrefix` drops ancestors that are inside
 * the moving group's old location (they are not ancestors after the move).
 */
async function inheritedLevels(entry: VaultEntry, noteId: string, path: string, excludePrefix?: string, viewer?: Actor): Promise<Map<string, string>> {
  const tree = await ensureTree(entry);
  const rows = new Map(tree.rows().map((r) => [r.id, r]));
  const chain = (await ancestorPages(entry, path))
    .filter((p) => !excludePrefix || (p.path !== excludePrefix && !p.path.startsWith(`${excludePrefix}/`)))
    // Only ancestors the caller can view count (a hidden page's shares are not theirs to learn).
    .filter((p) => !viewer || isAdmin(viewer) || (rows.has(p.id) && canView(viewer, rowRef(rows.get(p.id)!))));
  const out = new Map<string, string>();
  const own = new Set(grantsForResource("page", noteId, entry.id).filter((g) => g.subject_type === "user").map((g) => g.subject));
  for (const anc of chain) {
    for (const g of grantsForResource("page", anc.id, entry.id) as Grant[]) {
      if (g.subject_type !== "user" || own.has(g.subject) || out.has(g.subject)) continue;
      out.set(g.subject, g.level);
    }
  }
  return out;
}
