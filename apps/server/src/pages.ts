/**
 * Pages API — nested-page moves, the Trash, and synced per-user preferences.
 * The model (nesting by path, soft-delete tag, protected locations, preference
 * schema) lives in `@prism/core/pages` so the UI and the server agree on it.
 *
 * Mounted inside the gateway (`routes/api.ts`) BEFORE the owner short-circuit,
 * like `/tree`: owners and non-owners reach these handlers, and every check below
 * uses the same `effectiveCaps` math as the rest of the gateway.
 *
 *   POST   /api/notes/:id/move     move a page AND its descendants (one CAS PATCH each)
 *   POST   /api/notes/:id/trash    soft-delete a page and its descendants
 *   GET    /api/trash              trashed pages the caller can see
 *   POST   /api/trash/:id/restore  undo a trash (the page + what it took with it)
 *   DELETE /api/trash/:id          delete permanently (real vault delete)
 *   GET    /api/me/preferences     favorites / recents / sidebar, filtered to what is viewable NOW
 *   PUT    /api/me/preferences     replace them (revision CAS, bounded, schema-sanitized)
 *
 * PERMISSIONS (non-admins; owner/admin may do all of it):
 *   move    → `organize` on EVERY moved note (the gateway's existing rule for a path
 *             change — an editor without organize cannot move a note there either)
 *   trash / restore / delete permanently → the gateway's delete rule on EVERY note in
 *             the group: creator with `edit`, or the `delete` cap
 *   preferences → any signed-in user (capability links and anon have none)
 *
 * WIKILINKS. Prism never rewrites note bodies on a move. The vault (≥ 0.7.9,
 * vault#708) cascades a rename itself: inbound `[[…]]` brackets that RESOLVED to the
 * moved note (full path, basename, alias/anchor/embed forms) are rewritten in the
 * same transaction; brackets inside code fences and brackets that resolved through
 * the H1-title fallback are left alone (the latter still resolve by title).
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { db, resolveVaultEntry, getVaultRegistry, listPublications, listVaultMirrors, grantsForResource, listGrantsForVault, deleteCollabSetAsideForNote, type Grant } from "./db";
import { recordAction } from "./actions/store";
import { listGitHubConfigs } from "./worker/sync-store";
import { pathInPrefix } from "./paths";
import { resolveActor, type Actor } from "./auth/actor";
import { effectiveCaps, levelRank, type Cap, type NoteRef } from "./permissions";
import { roleAtLeast, roleFloor } from "./roles";
import { vaultClient, VaultError, VaultConflictError, type Note } from "./parachute";
import { ensureTree, treeUpsertNote, treeRemoveNote, rowRef, TREE_META_KEYS, type TreeRow } from "./tree";
import type { VaultEntry } from "./config";
import { purgeAttachmentsForNote } from "./attachments";
import {
  TRASH_TAG,
  TRASH_META,
  TRASH_RETENTION_DAYS,
  LOCK_KEY,
  ORDER_KEY,
  PAGE_STYLE_KEY,
  parsePageStyle,
  pageStyleOf,
  isLocked,
  PREFERENCE_LIMITS,
  EMPTY_PREFERENCES,
  isTrashed,
  isProtectedPath,
  isUnder,
  movedPath,
  normalizePagePath,
  pageTitle,
  parentOf,
  planSubtreeMove,
  protectionReason,
  systemNoteReason,
  sanitizePreferences,
  type PagePreferences,
  type PlannedMove,
} from "@prism/core/pages";

/** At most this many notes move or trash in one request (a whole-vault drag is refused). */
const MAX_GROUP = Number(process.env.PAGES_MAX_GROUP ?? 500);

// ── permission helpers (same math as routes/api.ts) ─────────────────────────

const subjectOf = (a: Actor): string | null => (a.kind === "user" ? a.email : a.kind === "link" ? a.capabilityId : null);
const capsOf = (a: Actor, r: NoteRef): Set<Cap> => effectiveCaps(a.grants, r, roleFloor(a.role), subjectOf(a));
const isAdmin = (a: Actor): boolean => roleAtLeast(a.role, "admin");
const noteRef = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
  path: n.path ?? null,
});
const canView = (a: Actor, r: NoteRef): boolean => isAdmin(a) || capsOf(a, r).has("view");
const canOrganize = (a: Actor, r: NoteRef): boolean => isAdmin(a) || capsOf(a, r).has("organize");
/** The gateway's DELETE rule (routes/api.ts): your own note with edit, or the delete cap. */
const canDelete = (a: Actor, r: NoteRef): boolean => {
  if (isAdmin(a)) return true;
  const caps = capsOf(a, r);
  const subject = subjectOf(a);
  return caps.has("delete") || (!!subject && r.creator === subject && caps.has("edit"));
};

/** Admins pick the vault per request (`X-Prism-Vault`); everyone else is bound to theirs. */
const entryFor = (c: Context, a: Actor): VaultEntry =>
  isAdmin(a) ? resolveVaultEntry(c.req.header("x-prism-vault")) : resolveVaultEntry(a.vaultId);

function vaultErr(c: Context, e: unknown) {
  if (e instanceof VaultConflictError) return c.json({ error: "conflict" }, 409);
  if (e instanceof VaultError) {
    if (e.status === 404) return c.json({ error: "not_found" }, 404);
    if (e.status === 400 || e.status === 413 || e.status === 422) return c.json({ error: "vault_rejected", status: e.status }, e.status);
    return c.json({ error: "vault_error", status: e.status }, 502);
  }
  return c.json({ error: "vault_unreachable" }, 502);
}

const failReason = (e: unknown): string =>
  e instanceof VaultConflictError ? "conflict" : e instanceof VaultError ? (e.status === 404 ? "not_found" : `vault_${e.status}`) : "vault_unreachable";

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return {};
  }
}

// One structural operation per SUBTREE at a time: two concurrent operations on
// overlapping subtrees (a move racing a trash of a child) would plan against each
// other's half-done state. Disjoint subtrees in the same vault run in parallel.
const busy = new Map<string, Set<string>>();
const overlaps = (a: string, b: string) => a === b || isUnder(a, b) || isUnder(b, a);
async function exclusive<T>(vaultId: string, paths: string[], fn: () => Promise<T>): Promise<T | "busy"> {
  const held = busy.get(vaultId) ?? new Set<string>();
  const want = paths.map((p) => p.toLowerCase());
  if ([...held].some((h) => want.some((w) => overlaps(h, w)))) return "busy";
  for (const w of want) held.add(w);
  busy.set(vaultId, held);
  try {
    return await fn();
  } finally {
    for (const w of want) held.delete(w);
  }
}

const toMs = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);

/**
 * A metadata/tag/path-only write to a note someone has open in the live editor:
 * tell the collab reconciler the new vault version carries no content change, so it
 * does not fold the (content-stale) vault copy back over unsaved typing.
 */
async function reconcileLive(entry: VaultEntry, id: string, prev: string | null | undefined, next: string | null | undefined) {
  try {
    const collab = await import("./collab");
    if (!collab.isDocLive(entry.id, id)) return;
    const p = toMs(prev);
    const n = toMs(next);
    if (Number.isFinite(p) && Number.isFinite(n)) collab.markReconciled(collab.docNameFor(entry.id, id), p, n);
  } catch {
    /* collab unavailable (tests, offline) — nothing to reconcile */
  }
}

/**
 * One CAS write that touches only path/metadata/tags. A stale `updatedAt` from the
 * projection (the socket can lag) is retried ONCE against a fresh read, and only if
 * the note is still where the plan expected it — a content edit in between is fine
 * (we never send content), a concurrent move is not.
 */
async function casWrite(
  entry: VaultEntry,
  id: string,
  expectPath: string | null,
  ifUpdatedAt: string | null | undefined,
  patch: { path?: string; metadata?: Record<string, unknown>; tags?: { add?: string[]; remove?: string[] } },
  strict = false,
): Promise<Note> {
  const vc = vaultClient(entry.id);
  let stamp = ifUpdatedAt ?? null;
  if (!stamp) {
    const fresh = await vc.getNote(id);
    if (expectPath !== null && fresh.path !== expectPath) throw new VaultConflictError(409, null, "moved meanwhile");
    stamp = fresh.updatedAt ?? fresh.createdAt;
  }
  let updated: Note;
  try {
    updated = await vc.updateNote(id, { ...patch, ifUpdatedAt: stamp });
  } catch (e) {
    if (strict || !(e instanceof VaultConflictError)) throw e;
    const fresh = await vc.getNote(id);
    if (expectPath !== null && fresh.path !== expectPath) throw e;
    stamp = fresh.updatedAt ?? fresh.createdAt;
    updated = await vc.updateNote(id, { ...patch, ifUpdatedAt: stamp });
  }
  treeUpsertNote(entry, updated);
  await reconcileLive(entry, id, stamp, updated.updatedAt);
  return updated;
}

/** Anything with the permission-relevant note fields (a vault Note or a tree row). */
type RowLike = { id: string; path: string | null; tags: string[] | null; updatedAt?: string | null; metadata?: Record<string, unknown> | null; creator?: string | null; visibility?: "workspace" | "private" };
const refOf = (r: RowLike): NoteRef =>
  "creator" in r && r.creator !== undefined
    ? rowRef(r as TreeRow)
    : { id: r.id, tags: r.tags ?? [], creator: (r.metadata?.prism_creator as string | undefined) ?? null, visibility: r.metadata?.prism_visibility === "private" ? "private" : "workspace", path: r.path ?? null };

/**
 * The notes under `path` read FRESH from the vault (one lean `path_prefix` listing),
 * never the cached tree projection: a move or trash must see every descendant that
 * exists now (review M5). Filtered to strict descendants (the vault's prefix is a
 * string prefix — `A` would also match `AB/x`).
 */
async function freshSubtree(entry: VaultEntry, path: string): Promise<Note[]> {
  const notes = await vaultClient(entry.id).listNotes({ pathPrefix: path, includeMetadata: [...TREE_META_KEYS] });
  return notes.filter((n) => isUnder(n.path, path));
}

/**
 * Refusal for a group the actor can't act on. Non-admins get no counts and no ids
 * of notes they can't see (no existence/size oracle); admins get the counts.
 */
function checkGroup(a: Actor, root: Note, rows: RowLike[], allowed: (a: Actor, r: NoteRef) => boolean) {
  const rootReason = protectionReason(root);
  if (rootReason) return { status: 403 as const, body: { error: "protected", reason: rootReason } };
  const admin = isAdmin(a);
  const protectedRows = rows.filter((r) => protectionReason(r));
  if (protectedRows.length) {
    return { status: 403 as const, body: { error: "protected", reason: "Some pages inside are kept in sync by an integration or the system.", ...(admin ? { count: protectedRows.length } : {}) } };
  }
  const blocked = [noteRef(root), ...rows.map(refOf)].filter((r) => !allowed(a, r)).length;
  if (blocked) return { status: 403 as const, body: { error: "forbidden", reason: "You can’t change every page in this group." } };
  if (rows.length + 1 > MAX_GROUP) return { status: 413 as const, body: { error: "too_many", limit: MAX_GROUP } };
  return null;
}

/** The page-inherited level (rank; -1 = none) a set of page grants gives a note, nearest anchor winning. */
function pageRank(grants: Grant[], noteId: string, notePath: string | null, anchorPath: (id: string) => string | null): number {
  let depth = -1;
  let rank = -1;
  for (const g of grants) {
    let d = -1;
    if (g.resource === noteId) d = Number.MAX_SAFE_INTEGER;
    else {
      const ap = anchorPath(g.resource);
      if (ap && notePath && notePath.startsWith(`${ap}/`)) d = ap.length;
    }
    if (d < 0) continue;
    if (d > depth) {
      depth = d;
      rank = levelRank(g.level);
    } else if (d === depth) rank = Math.max(rank, levelRank(g.level));
  }
  return rank;
}

/**
 * What a move would do to page shares (see the move route), and whether the
 * actor may do it:
 *  - `blocked`  it newly EXPOSES notes to a page share — existing notes under a
 *               moved page that carries page grants, or the moved notes under a
 *               destination ancestor's share (others', or the mover's own when it
 *               would GROW the mover's caps on a note) — without `share` on them;
 *  - `lowers`   it would LOWER another person's page-inherited access on a note
 *               that still inherits afterwards (a nearer shared page wins) — an
 *               administrator's decision, never a mover's;
 *  - `trashed`  the destination lies under a page that is in the Trash.
 */
async function shareExposure(
  entry: VaultEntry,
  actor: Actor,
  plan: PlannedMove[],
  from: string,
  target: string,
  atTarget: Note[],
  group: Note[],
): Promise<{ blocked: boolean; lowers: boolean; trashed: boolean; count: number }> {
  const moving = new Set(plan.map((m) => m.id));
  const me = actor.kind === "user" ? actor.email : "";
  const mayShare = (r: NoteRef) => isAdmin(actor) || capsOf(actor, r).has("share");
  let count = 0;
  let blocked = false;
  // (a) anchors inside the moved group, landing over existing notes.
  const landedOn: Note[] = [];
  for (const m of plan) {
    if (!grantsForResource("page", m.id, entry.id).length) continue;
    for (const n of atTarget) {
      if (moving.has(n.id) || !n.path || isTrashed(n) || !isUnder(n.path, m.to)) continue;
      landedOn.push(n);
      count++;
      if (!mayShare(noteRef(n))) blocked = true;
    }
  }
  // (b) the destination's ancestors (live OR trashed) that do not already cover the group.
  const tree = await ensureTree(entry);
  const byPath = new Map<string, TreeRow>();
  const byId = new Map<string, TreeRow>();
  for (const r of tree.rows()) {
    byId.set(r.id, r);
    if (r.path) byPath.set(r.path, r);
  }
  const isTrashedRow = (r: TreeRow) => !!r.trashedAt || r.tags.includes(TRASH_TAG);
  const ancestors = (p: string): TreeRow[] => {
    const out: TreeRow[] = [];
    let q = p;
    while (q.includes("/")) {
      q = q.slice(0, q.lastIndexOf("/"));
      const row = byPath.get(q);
      if (row && !moving.has(row.id)) out.push(row);
    }
    return out;
  };
  const destAncestors = ancestors(target);
  const trashed = destAncestors.some(isTrashedRow);
  const before = new Set(ancestors(from).map((r) => r.id));
  const fresh = destAncestors.filter((r) => !before.has(r.id) && grantsForResource("page", r.id, entry.id).length > 0);
  const newPath = new Map(plan.map((m) => [m.id, m.to]));
  if (fresh.length) {
    const others = fresh.some((r) => grantsForResource("page", r.id, entry.id).some((g) => !(g.subject_type === "user" && g.subject === me)));
    for (const n of group) {
      const ref = noteRef(n);
      // The mover's own share at the destination must not GROW their caps on a note they cannot share.
      const now = capsOf(actor, ref);
      const then = capsOf(actor, { ...ref, path: newPath.get(n.id) ?? ref.path });
      const grows = [...then].some((cap) => !now.has(cap));
      if (!others && !grows) continue;
      count++;
      if (!isAdmin(actor) && !now.has("share")) blocked = true;
    }
  }
  // (c) would anyone ELSE keep page-inherited access to a note, but at a lower level?
  let lowers = false;
  const bySubject = new Map<string, Grant[]>();
  for (const g of listGrantsForVault(entry.id)) {
    if (g.resource_type !== "page") continue;
    const key = `${g.subject_type}:${g.subject}`;
    if (g.subject_type === "user" && g.subject === me) continue;
    const list = bySubject.get(key);
    if (list) list.push(g);
    else bySubject.set(key, [g]);
  }
  if (bySubject.size) {
    const pathNow = (id: string) => {
      const r = byId.get(id);
      return r && !isTrashedRow(r) ? r.path : null;
    };
    const pathThen = (id: string) => newPath.get(id) ?? pathNow(id);
    const affected: Array<{ id: string; now: string | null; then: string | null }> = [
      ...group.map((n) => ({ id: n.id, now: n.path ?? null, then: newPath.get(n.id) ?? n.path ?? null })),
      ...landedOn.map((n) => ({ id: n.id, now: n.path ?? null, then: n.path ?? null })),
    ];
    outer: for (const grants of bySubject.values()) {
      for (const a of affected) {
        const was = pageRank(grants, a.id, a.now, pathNow);
        const willBe = pageRank(grants, a.id, a.then, pathThen);
        if (willBe >= 0 && willBe < was) {
          lowers = true;
          break outer;
        }
      }
    }
  }
  return { blocked, lowers, trashed, count };
}

/**
 * Restoring a page brings its page shares back to life over whatever now lives
 * under its path. Live notes that are NOT part of the restored group would join
 * those shares (review H-A): that needs `share` on each of them.
 */
async function restoreExposure(entry: VaultEntry, actor: Actor, restored: Note[]): Promise<{ blocked: boolean; count: number }> {
  const ids = new Set(restored.map((n) => n.id));
  const anchors = restored.filter((n) => n.path && grantsForResource("page", n.id, entry.id).length > 0);
  if (!anchors.length) return { blocked: false, count: 0 };
  let live: Note[];
  const prefixes = anchors.map((a) => a.path!).sort((a, b) => a.length - b.length);
  const outer = prefixes.filter((p, i) => !prefixes.slice(0, i).some((q) => p.startsWith(`${q}/`)));
  live = [];
  for (const p of outer) {
    // FRESH from the vault (never the cached tree): what exists under the path right now.
    for (const n of await vaultClient(entry.id).listNotes({ pathPrefix: p, includeMetadata: [...TREE_META_KEYS] })) live.push(n);
  }
  let count = 0;
  let blocked = false;
  const seen = new Set<string>();
  for (const n of live) {
    if (ids.has(n.id) || seen.has(n.id) || isTrashed(n) || !n.path || !anchors.some((a) => isUnder(n.path, a.path!))) continue;
    seen.add(n.id);
    count++;
    if (!isAdmin(actor) && !capsOf(actor, noteRef(n)).has("share")) blocked = true;
  }
  return { blocked, count };
}

/**
 * Why `path` is an EXPORTED location (a folder publication, a GitHub folder sync,
 * a vault-mirror source) in this vault, or null. Moving a page there publishes or
 * exports it, so only the owner/admin may (review H2).
 */
export function exportedLocation(vaultId: string, path: string): string | null {
  for (const p of listPublications()) {
    if (p.resource_type === "path" && (p.vault_id ?? "primary") === vaultId && pathInPrefix(path, p.resource)) return "That folder is published publicly.";
  }
  for (const g of listGitHubConfigs(vaultId)) {
    const prefix = g.vaultPath.replace(/\/+$/, "");
    if (prefix && pathInPrefix(path, prefix)) return "That folder is synced to GitHub.";
  }
  for (const m of listVaultMirrors()) {
    if (m.src_vault === vaultId && pathInPrefix(path, m.src_prefix)) return "That folder is mirrored to another vault.";
  }
  return null;
}

/** A tag with a public site on it: tagging a note with it publishes the note. */
export function publishedTag(vaultId: string, tag: string): boolean {
  return listPublications().some((p) => p.resource_type === "tag" && (p.vault_id ?? "primary") === vaultId && p.resource === tag);
}

/** One answer for "that path is taken" and "that path is under a trashed page": the
 *  caller's own path, no word about what is there or whether they could see it. */
export const pathUnavailable = (path: string) => ({ error: "path_conflict" as const, path, reason: "That location isn’t available. Choose another place." });

export type PlacementRefusal = { status: 400 | 403 | 404 | 409 | 502; body: Record<string, unknown> };

/** How the vault LOOKS UP a path (NOCASE) plus Unicode form: the key two paths collide on. */
export const pathKey = (p: string): string => p.normalize("NFC").toLowerCase();

/**
 * The note that answers to `path` in the vault's own lookup. The unique index on
 * `path` is BINARY but `getNoteByPath` is `COLLATE NOCASE`, so `projects/plan` can be
 * created beside `Projects/Plan` — a shadow that later reads as `AmbiguousPathError`.
 * Looked up in both Unicode forms (the vault does not normalise). "ambiguous" = the
 * vault already holds two notes on that key.
 */
async function noteAtPath(entry: VaultEntry, path: string): Promise<Note | "ambiguous" | null> {
  const vc = vaultClient(entry.id);
  for (const form of new Set([path.normalize("NFC"), path.normalize("NFD")])) {
    try {
      const n = await vc.getNote(form);
      // getNote also resolves ids and unique titles: only a PATH match counts.
      if (n.path && pathKey(n.path) === pathKey(path)) return n;
    } catch (e) {
      if (e instanceof VaultConflictError) return "ambiguous";
      if (!(e instanceof VaultError && e.status === 404)) throw e;
    }
  }
  return null;
}

/**
 * Where a NON-ADMIN may place a note by naming a path — the gateway's create
 * (`POST /notes`), its path PATCH and a governed new entry. The move route's
 * destination rules: a clean page path (`normalizePagePath`: `.md` stripped, NFC),
 * not a location an integration owns (`isProtectedPath`), not an exported folder
 * (`exportedLocation`), not under a trashed page, not a path some note already
 * answers to case-insensitively (`noteAtPath`; `exceptId` = the note being renamed),
 * and — with `actor` — the destination-parent rule (`destinationParentRefusal`).
 * Refusals name no note; a trashed ancestor and a held path answer identically.
 */
export async function placementRefusal(
  entry: VaultEntry,
  raw: unknown,
  opts: { actor?: Actor; tags?: string[]; exceptId?: string } = {},
): Promise<{ path: string } | PlacementRefusal> {
  const path = normalizePagePath(raw);
  if (!path) return { status: 400, body: { error: "invalid_request", reason: "path is not a valid page location." } };
  if (isProtectedPath(path)) return { status: 403, body: { error: "protected", reason: "That location is kept in sync by an integration." } };
  const why = exportedLocation(entry.id, path);
  if (why) return { status: 403, body: { error: "forbidden", reason: `${why} Only the workspace owner can add pages there.` } };
  try {
    if (parentOf(path)) {
      const trashed = await vaultClient(entry.id).listNotes({ tags: [TRASH_TAG], includeMetadata: [...TREE_META_KEYS] });
      const key = pathKey(path);
      if (trashed.some((n) => !!n.path && isUnder(key, pathKey(n.path)))) return { status: 409, body: pathUnavailable(path) };
    }
    if (opts.actor) {
      const refused = await destinationParentRefusal(opts.actor, entry, path, { tags: opts.tags });
      if (refused) return refused;
    }
    const holder = await noteAtPath(entry, path);
    if (holder === "ambiguous" || (holder && holder.id !== opts.exceptId)) return { status: 409, body: pathUnavailable(path) };
  } catch {
    return { status: 502, body: { error: "vault_unreachable" } };
  }
  return { path };
}

/** The tags a database page draws its rows from (`metadata.prism_database.source.tags`), or null. */
function databaseSourceTags(page: Note): string[] | null {
  if (page.metadata?.prism_type !== "database") return null;
  const tags = (page.metadata?.prism_database as { source?: { tags?: unknown } } | undefined)?.source?.tags;
  return Array.isArray(tags) && tags.length > 0 && tags.every((t) => typeof t === "string" && t) ? (tags as string[]) : null;
}

/**
 * THE one hook for "may this actor place a page at `target`?" — the destination's
 * parent PAGE decides: a non-admin needs `create` or `organize` on it. Null = allowed.
 *  - a MOVE (`requirePage: true`, review H2) also needs that page to exist: the top
 *    level and plain folders are the owner's, and an unviewable page looks the same;
 *  - a CREATE / path PATCH (`requirePage: false`) is free where there is no page note
 *    (a plain folder, the top level — the New menu, imports, "Open as database");
 *    inside a page the actor cannot view it answers 404, inside one they can view
 *    but not add to, 403;
 *  - a DATABASE page is also an allowed parent for a ROW (`tags` given): the new note
 *    carries every one of the database's source tags and the actor holds `create` in
 *    each of them — view on the page is then enough ("+ New", duplicate, templates).
 * The parent is found the way the vault finds it (case-insensitive, either Unicode
 * form); two pages on one key is refused.
 * PAGE SHARES (wave 2D): standing in the place itself also counts — `createCapsAt`
 * (apps/server/src/sharing.ts) is the caps a new note at `target` gets from a page
 * share on ANY ancestor (nearest wins), vault grants and the role floor, and is empty
 * under a trashed page. And a CREATE into a plain folder that lies under a page
 * somebody shares is no longer free: the new note would be shared with those people,
 * so the creator needs `create` there (404 when they cannot see the shared page —
 * the same answer as a missing place — else 403).
 */
export async function destinationParentRefusal(actor: Actor, entry: VaultEntry, target: string, opts: { requirePage?: boolean; tags?: string[] } = {}): Promise<PlacementRefusal | null> {
  if (isAdmin(actor)) return null;
  const parent = parentOf(target);
  let found: Note | "ambiguous" | null = null;
  if (parent && parent !== "vault") {
    try {
      found = await noteAtPath(entry, parent);
    } catch {
      found = "ambiguous"; // unreadable: never assume "no page there"
    }
  }
  if (found === "ambiguous") return { status: 409, body: pathUnavailable(target) };
  let parentPage: Note | null = found;
  if (parentPage && !canView(actor, noteRef(parentPage))) {
    if (!opts.requirePage) return { status: 404, body: { error: "not_found" } };
    parentPage = null; // for a move: indistinguishable from "no page there"
  }
  // Standing at the place itself, tags aside (a tag grant is not standing in a page).
  const { createCapsAt } = await import("./sharing");
  const here = await createCapsAt(actor, target, []);
  if (!parentPage) {
    if (opts.requirePage) return { status: 403, body: { error: "forbidden", reason: "Only the workspace owner can add pages at the top level or into a plain folder." } };
    // A plain folder / the top level: free, unless it lies under a shared page.
    const shared = await sharedAncestor(entry, target);
    if (!shared || here.has("create") || here.has("organize")) return null;
    if (!canView(actor, { id: shared.id, tags: shared.tags, path: shared.path, creator: shared.creator ?? null, visibility: shared.visibility === "private" ? "private" : "workspace" })) return { status: 404, body: { error: "not_found" } };
    return { status: 403, body: { error: "forbidden", reason: "You can’t add pages inside that page." } };
  }
  const refusal: PlacementRefusal = { status: 403, body: { error: "forbidden", reason: "You can’t add pages inside that page." } };
  if (isTrashed(parentPage)) return refusal;
  const caps = capsOf(actor, noteRef(parentPage));
  if (caps.has("create") || caps.has("organize") || here.has("create") || here.has("organize")) return null;
  const source = opts.tags ? databaseSourceTags(parentPage) : null;
  if (source && source.every((t) => opts.tags!.includes(t) && capsOf(actor, { id: "<new>", tags: [t] }).has("create"))) {
    // …unless the database sits under (or is) a page somebody shares: the row would be
    // shared with those people, so the shared-page rule applies — `create` there (L2).
    const shared = (await sharedAncestor(entry, target)) ?? (grantsForResource("page", parentPage.id, entry.id).length ? parentPage : null);
    return shared ? refusal : null;
  }
  return refusal;
}

/** The nearest LIVE ancestor page of `target` that carries a page share (anyone's), or null. */
export async function sharedAncestor(entry: VaultEntry, target: string): Promise<TreeRow | null> {
  const tree = await ensureTree(entry);
  const byPath = new Map<string, TreeRow>();
  for (const r of tree.rows()) if (r.path) byPath.set(pathKey(r.path), r);
  let p = pathKey(target);
  while (p.includes("/")) {
    p = p.slice(0, p.lastIndexOf("/"));
    const row = byPath.get(p);
    if (row && !row.trashedAt && !row.tags.includes(TRASH_TAG) && grantsForResource("page", row.id, entry.id).length > 0) return row;
  }
  return null;
}

/** Live docs that LINK INTO the moved notes: store them before the path writes (review M2). */
async function flushLinkersLive(entry: VaultEntry, ids: string[]): Promise<void> {
  let collab: typeof import("./collab");
  try {
    collab = await import("./collab");
  } catch {
    return;
  }
  if (!collab.hocuspocus.documents.size) return;
  const moving = new Set(ids);
  const sources = new Set<string>();
  for (const id of ids.slice(0, MAX_GROUP)) {
    try {
      const n = await vaultClient(entry.id).getNote(id, { includeLinks: true });
      for (const l of n.links ?? []) if (l.targetId === id && !moving.has(l.sourceId)) sources.add(l.sourceId);
    } catch {
      /* unreadable: nothing to flush for it */
    }
  }
  for (const src of sources) if (collab.isDocLive(entry.id, src)) await collab.flushLiveDoc(entry.id, src);
}

export interface PagesApiOptions {
  /** Called after any successful write (the gateway drops its cached owner reads). */
  onWrite?: () => void;
}

export function createPagesApi(opts: PagesApiOptions = {}) {
  const r = new Hono();
  const wrote = () => opts.onWrite?.();

  // ── move ──────────────────────────────────────────────────────────────────
  r.post("/notes/:id/move", async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: actor.kind === "anon" ? "unauthorized" : "forbidden" }, actor.kind === "anon" ? 401 : 403);
    const body = await readBody(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const admin = isAdmin(actor);
    const entry = entryFor(c, actor);
    const vc = vaultClient(entry.id);
    let root: Note;
    try {
      root = await vc.getNote(c.req.param("id"));
    } catch (e) {
      return vaultErr(c, e);
    }
    if (!canView(actor, noteRef(root))) return c.json({ error: "not_found" }, 404);
    if (!root.path) return c.json({ error: "bad_request", reason: "This page has no location to move." }, 400);
    if (isTrashed(root)) return c.json({ error: "in_trash", reason: "Restore this page from the Trash before moving it." }, 409);
    if (body.fromPath !== undefined) return c.json({ error: "bad_request", reason: "Resume a move with its moveId." }, 400);

    // Resume (review M5/LOW): bound to a journaled partial move of THIS page, by the
    // same account (or an admin), CAS against the page as it stands after its own move.
    let from: string;
    let target: string;
    let journalId: string;
    const resumeId = typeof body.moveId === "string" ? body.moveId : null;
    if (resumeId) {
      const j = getMove(resumeId);
      if (!j || j.vault_id !== entry.id || j.root_id !== root.id || (!admin && j.created_by !== actor.email)) return c.json({ error: "not_found" }, 404);
      if (j.status !== "partial") return c.json({ error: "conflict", reason: "That move is not waiting to be finished." }, 409);
      if (root.path !== j.to_path || body.if_updated_at !== root.updatedAt) return c.json({ error: "conflict", reason: "This page changed since the move stopped. Reload and try again." }, 409);
      from = j.from_path;
      target = j.to_path;
      journalId = j.id;
    } else {
      let t: string | null = null;
      if (body.newPath !== undefined) t = normalizePagePath(body.newPath);
      else if (body.newParentPath !== undefined) {
        const parent = body.newParentPath === "" ? "" : normalizePagePath(body.newParentPath);
        t = parent === null ? null : movedPath(root.path, parent);
      }
      if (!t) return c.json({ error: "bad_request", reason: "A valid newPath or newParentPath is required." }, 400);
      if (t === root.path) return c.json({ error: "no_change" }, 400);
      if (typeof body.if_updated_at !== "string") return c.json({ error: "precondition_required", reason: "if_updated_at is required" }, 428);
      from = root.path;
      target = t;
      journalId = randomUUID();
    }
    if (isUnder(target, from)) return c.json({ error: "into_own_subtree", reason: "A page can’t move inside itself." }, 400);
    if (isProtectedPath(target)) return c.json({ error: "protected", reason: "That location is kept in sync by an integration." }, 403);

    // Plan from FRESH vault listings (review M5): the subtree being moved, and what
    // already lives at the destination.
    let below: Note[];
    let atTarget: Note[];
    try {
      [below, atTarget] = await Promise.all([freshSubtree(entry, from), vc.listNotes({ pathPrefix: target, includeMetadata: [...TREE_META_KEYS] })]);
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    const plan = planSubtreeMove(
      [{ id: root.id, path: resumeId ? null : root.path, updatedAt: root.updatedAt }, ...below.map((n) => ({ id: n.id, path: n.path, updatedAt: n.updatedAt }))],
      from,
      target,
      root.id,
    );
    const descendants = below.filter((n) => plan.some((m) => m.id === n.id));
    const refusal = checkGroup(actor, root, descendants, canOrganize);
    if (refusal) return c.json(refusal.body, refusal.status);

    // DESTINATION (review H2). Exported folders are owner/admin only; otherwise a
    // non-admin needs create/organize on the destination's parent PAGE (admin when
    // the destination has no parent page, e.g. top level or a plain folder).
    if (!admin) {
      for (const m of plan) {
        const why = exportedLocation(entry.id, m.to);
        if (why) return c.json({ error: "forbidden", reason: `${why} Only the workspace owner can move pages there.` }, 403);
      }
      const refused = await destinationParentRefusal(actor, entry, target, { requirePage: true });
      if (refused) return c.json(refused.body, refused.status);
    }

    // Every destination must be free (case-insensitively, like the vault's path index).
    const moving = new Set(plan.map((m) => m.id));
    const holders = new Map(atTarget.filter((n) => n.path && !moving.has(n.id)).map((n) => [n.path!.toLowerCase(), n]));
    const clash = plan.find((m) => holders.has(m.to.toLowerCase()));
    if (clash) {
      const holder = holders.get(clash.to.toLowerCase())!;
      // No existence oracle: a note the caller can't see is a generic conflict.
      if (!canView(actor, noteRef(holder))) return c.json({ error: "conflict", reason: "That location isn’t available. Choose another place." }, 409);
      return c.json(
        isTrashed(holder)
          ? { error: "path_conflict", path: clash.to, reason: `A page in the Trash is still using ${pageTitle(clash.to)} there. Restore or delete it first.` }
          : { error: "path_conflict", path: clash.to, reason: `A page already exists at ${clash.to}.` },
        409,
      );
    }

    // PAGE-SHARE EXPOSURE (security review C1/H1). Page grants follow the page and
    // match by its CURRENT path, so a move can share notes nobody chose to share:
    //  (a) a moved page that carries page grants lands over EXISTING notes (not in the
    //      moved group) — they would join its share;
    //  (b) the moved group lands under a page shared with OTHER people that does not
    //      already cover it — it would join that share.
    // Either needs `share` on every note that becomes exposed (admins bypass, audited).
    // The refusal names no note and gives no count.
    const exposure = await shareExposure(entry, actor, plan, from, target, atTarget, [root, ...descendants]);
    if (!admin) {
      if (exposure.trashed) return c.json({ error: "forbidden", reason: "That location is inside a page that is in the Trash." }, 403);
      if (exposure.blocked) return c.json({ error: "forbidden", reason: "Moving here would share pages with people who don’t have them now. You need permission to share these pages." }, 403);
      if (exposure.lowers) return c.json({ error: "forbidden", reason: "Moving here would reduce access someone already has to these pages. Ask an administrator." }, 403);
    } else if (exposure.blocked || exposure.lowers || exposure.count) {
      recordAction({ actorEmail: actor.email, via: "session", origin: "human", action: "pages.move-share-bypass", vaultId: entry.id, target: { rootId: root.id, exposed: exposure.count, lowers: exposure.lowers }, idempotencyKey: null, status: "ok", error: null });
    }

    const outcome = await exclusive(entry.id, [from, target], async () => {
      // A live doc linking into the subtree is stored first, so the vault's
      // link-rewrite cascade folds into the editor cleanly (review M2).
      await flushLinkersLive(entry, plan.map((m) => m.id));
      recordMove({ id: journalId, vault_id: entry.id, root_id: root.id, from_path: from, to_path: target, status: "running", moved: 0, remaining: plan.length, created_by: actor.email });
      const moved: Array<{ id: string; from: string; to: string }> = [];
      for (const m of plan) {
        const isRoot = m.id === root.id;
        try {
          await casWrite(entry, m.id, m.from, isRoot ? (body.if_updated_at as string) : m.updatedAt, { path: m.to }, isRoot);
          moved.push({ id: m.id, from: m.from, to: m.to });
        } catch (e) {
          return { moved, failed: { ...pick(m), reason: failReason(e) }, error: e };
        }
      }
      return { moved, failed: null, error: null };
    });
    if (outcome === "busy") return c.json({ error: "busy", reason: "Another change to these pages is in progress. Try again in a moment." }, 409);
    if (outcome.moved.length) wrote();
    if (!outcome.failed) {
      finishMove(journalId, "done", outcome.moved.length, 0);
      return c.json({ ok: true, path: target, moved: outcome.moved, wikilinks: "vault_cascade" });
    }
    if (!outcome.moved.length && !resumeId) {
      finishMove(journalId, "failed", 0, plan.length);
      // Nothing changed: report the root's own failure plainly (stale page → reload and retry).
      return outcome.failed.reason === "conflict"
        ? c.json({ error: "conflict", reason: "This page changed since you opened it. Reload and try again." }, 409)
        : vaultErr(c, outcome.error);
    }
    finishMove(journalId, "partial", outcome.moved.length, plan.length - outcome.moved.length);
    return c.json(
      {
        error: "partial_move",
        reason: "Some pages moved and some did not. Retry to finish the move.",
        moveId: journalId,
        moved: outcome.moved,
        failed: outcome.failed,
        remaining: plan.length - outcome.moved.length,
        resume: { moveId: journalId, newPath: target },
      },
      207,
    );
  });

  /** Recent page moves (partial ones can be finished from here); own moves only for non-admins. */
  r.get("/moves", (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: "unauthorized" }, 401);
    const entry = entryFor(c, actor);
    const rows = db
      .prepare(`SELECT id, root_id, from_path, to_path, status, moved, remaining, created_by, created_at, updated_at FROM page_moves WHERE vault_id = ? ${isAdmin(actor) ? "" : "AND created_by = ?"} ORDER BY updated_at DESC LIMIT 20`)
      .all(...(isAdmin(actor) ? [entry.id] : [entry.id, actor.email])) as Array<Record<string, unknown>>;
    c.header("Cache-Control", "private, no-store");
    return c.json({ moves: rows.map((m) => ({ id: m.id, rootId: m.root_id, from: m.from_path, to: m.to_path, status: m.status, moved: m.moved, remaining: m.remaining, updatedAt: m.updated_at })) });
  });

  // ── page metadata (lock, sidebar order) ───────────────────────────────────
  // Metadata-only page writes, CAS + reconcile-live (review M3). Lock toggling needs
  // `organize` (owner/admin always); order needs `organize` too.
  r.post("/notes/:id/meta", async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: actor.kind === "anon" ? "unauthorized" : "forbidden" }, actor.kind === "anon" ? 401 : 403);
    const body = await readBody(c);
    const set = body?.set && typeof body.set === "object" && !Array.isArray(body.set) ? (body.set as Record<string, unknown>) : null;
    const keys = set ? Object.keys(set) : [];
    if (!set || !keys.length || keys.some((k) => k !== LOCK_KEY && k !== ORDER_KEY && k !== PAGE_STYLE_KEY)) return c.json({ error: "bad_request", reason: `set ${LOCK_KEY}, ${ORDER_KEY} and/or ${PAGE_STYLE_KEY}` }, 400);
    if (LOCK_KEY in set && typeof set[LOCK_KEY] !== "boolean") return c.json({ error: "bad_request" }, 400);
    if (ORDER_KEY in set && (typeof set[ORDER_KEY] !== "number" || !Number.isFinite(set[ORDER_KEY] as number))) return c.json({ error: "bad_request" }, 400);
    // Per-page style (wave 2E, NP-PG-08): presentation only, needs `edit`; stored normalised.
    let stylePatch: { small?: boolean; full?: boolean } | null = null;
    if (PAGE_STYLE_KEY in set) {
      const style = parsePageStyle(set[PAGE_STYLE_KEY]);
      if (!style) return c.json({ error: "bad_request", reason: `${PAGE_STYLE_KEY} is {small?: boolean, full?: boolean}` }, 400);
      stylePatch = style;
    }
    const needsOrganize = LOCK_KEY in set || ORDER_KEY in set;
    const entry = entryFor(c, actor);
    let note: Note;
    try {
      note = await vaultClient(entry.id).getNote(c.req.param("id"));
    } catch (e) {
      return vaultErr(c, e);
    }
    if (!canView(actor, noteRef(note))) return c.json({ error: "not_found" }, 404);
    // System notes (integration-owned, agent, governance) are not page-managed by non-owners.
    if (!isAdmin(actor) && systemNoteReason(note)) return c.json({ error: "protected", reason: systemNoteReason(note) }, 403);
    if (needsOrganize && !canOrganize(actor, noteRef(note))) return c.json({ error: "forbidden", reason: "Changing this needs organize access to the page." }, 403);
    // Each key is checked on its own: style + lock/order in one request needs edit AND organize.
    if (stylePatch && !(isAdmin(actor) || capsOf(actor, noteRef(note)).has("edit"))) return c.json({ error: "forbidden", reason: "Changing the page style needs edit access." }, 403);
    if (stylePatch) {
      const current = pageStyleOf(note);
      set[PAGE_STYLE_KEY] = { small: stylePatch.small ?? current.small === true, full: stylePatch.full ?? current.full === true };
    }
    if (PAGE_STYLE_KEY in set && isLocked(note)) return c.json({ error: "locked", reason: "This page is locked." }, 423);
    if (typeof body!.if_updated_at !== "string") return c.json({ error: "precondition_required" }, 428);
    try {
      const updated = await casWrite(entry, note.id, null, body!.if_updated_at as string, { metadata: set }, true);
      wrote();
      if (LOCK_KEY in set) {
        const collab = await import("./collab").catch(() => null);
        collab?.setNoteLocked(entry.id, note.id, set[LOCK_KEY] === true);
      }
      return c.json({ ok: true, id: updated.id, updatedAt: updated.updatedAt, metadata: { [LOCK_KEY]: updated.metadata?.[LOCK_KEY] ?? null, [ORDER_KEY]: updated.metadata?.[ORDER_KEY] ?? null, [PAGE_STYLE_KEY]: updated.metadata?.[PAGE_STYLE_KEY] ?? null } });
    } catch (e) {
      return vaultErr(c, e);
    }
  });


  // ── trash ─────────────────────────────────────────────────────────────────
  r.post("/notes/:id/trash", async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: actor.kind === "anon" ? "unauthorized" : "forbidden" }, actor.kind === "anon" ? 401 : 403);
    const body = (await readBody(c)) ?? {};
    const entry = entryFor(c, actor);
    let root: Note;
    try {
      root = await vaultClient(entry.id).getNote(c.req.param("id"));
    } catch (e) {
      return vaultErr(c, e);
    }
    if (!canView(actor, noteRef(root))) return c.json({ error: "not_found" }, 404);
    if (isTrashed(root)) return c.json({ ok: true, rootId: root.id, trashed: [], already: true });
    let group: Note[];
    try {
      group = root.path ? (await freshSubtree(entry, root.path)).filter((n) => !isTrashed(n)) : [];
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    const refusal = checkGroup(actor, root, group, canDelete);
    if (refusal) return c.json(refusal.body, refusal.status);
    const at = new Date().toISOString();
    const by = actor.email;
    const outcome = await exclusive(entry.id, [root.path ?? root.id], async () => {
      const done: string[] = [];
      const items = [{ id: root.id, path: root.path, stamp: (typeof body.if_updated_at === "string" ? body.if_updated_at : root.updatedAt) as string | null }, ...group.map((g) => ({ id: g.id, path: g.path, stamp: g.updatedAt }))];
      for (const it of items) {
        try {
          await casWrite(entry, it.id, it.path, it.stamp, {
            metadata: { [TRASH_META.at]: at, [TRASH_META.by]: by, [TRASH_META.root]: root.id, [TRASH_META.path]: it.path },
            tags: { add: [TRASH_TAG] },
          });
          // The ledger is the ONLY thing the purge worker trusts (review M1).
          ledgerPut(entry.id, it.id, root.id, at, by);
          done.push(it.id);
        } catch (e) {
          return { done, failed: { id: it.id, reason: failReason(e) } };
        }
      }
      return { done, failed: null };
    });
    if (outcome === "busy") return c.json({ error: "busy", reason: "Another page change is in progress. Try again in a moment." }, 409);
    if (outcome.done.length) wrote();
    if (!outcome.failed) return c.json({ ok: true, rootId: root.id, trashed: outcome.done });
    if (!outcome.done.length) return c.json({ error: outcome.failed.reason === "conflict" ? "conflict" : "trash_failed", failed: outcome.failed }, outcome.failed.reason === "conflict" ? 409 : 502);
    return c.json({ error: "partial_trash", reason: "Some pages moved to Trash and some did not. Retry to finish.", rootId: root.id, trashed: outcome.done, failed: outcome.failed }, 207);
  });

  r.get("/trash", async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: actor.kind === "anon" ? "unauthorized" : "forbidden" }, actor.kind === "anon" ? 401 : 403);
    const entry = entryFor(c, actor);
    let rows: TreeRow[];
    try {
      rows = (await ensureTree(entry)).rows();
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 200);
    const admin = isAdmin(actor);
    const visible = rows.filter((x) => x.tags.includes(TRASH_TAG) && canView(actor, rowRef(x)));
    const ids = new Set(visible.map((x) => x.id));
    const childCount = new Map<string, number>();
    for (const x of visible) if (x.trashedRoot && x.trashedRoot !== x.id && ids.has(x.trashedRoot)) childCount.set(x.trashedRoot, (childCount.get(x.trashedRoot) ?? 0) + 1);
    // Top-level entries: a trashed page, or a page whose group root the caller can't see.
    const items = visible
      .filter((x) => !x.trashedRoot || x.trashedRoot === x.id || !ids.has(x.trashedRoot))
      .filter((x) => !q || (x.path ?? "").toLowerCase().includes(q))
      .sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? "") || a.id.localeCompare(b.id))
      .slice(0, 500)
      .map((x) => ({
        id: x.id,
        path: x.path,
        title: pageTitle(x.path),
        trashedAt: x.trashedAt ?? null,
        // Who trashed it: an email, so only for admins or when it was you.
        trashedBy: admin || x.trashedBy === actor.email ? x.trashedBy ?? null : null,
        descendants: childCount.get(x.id) ?? 0,
        canRestore: canDelete(actor, rowRef(x)),
        canDelete: canDelete(actor, rowRef(x)),
      }));
    // Gardener view (admins): tagged as trashed but not trashed through Prism — hidden
    // everywhere, never auto-purged; restore or delete them deliberately.
    const tracked = new Set(trashLedger(entry.id).map((l) => l.note_id));
    const untracked = admin ? visible.filter((x) => !tracked.has(x.id)).slice(0, 200).map((x) => ({ id: x.id, path: x.path, title: pageTitle(x.path) })) : undefined;
    c.header("Cache-Control", "private, no-store");
    return c.json({ items, total: items.length, retentionDays: retentionDays(), autoPurge: purgeEnabled(), ...(untracked ? { untracked } : {}) });
  });

  r.post("/trash/:id/restore", async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: actor.kind === "anon" ? "unauthorized" : "forbidden" }, actor.kind === "anon" ? 401 : 403);
    const entry = entryFor(c, actor);
    let root: Note;
    try {
      root = await vaultClient(entry.id).getNote(c.req.param("id"));
    } catch (e) {
      return vaultErr(c, e);
    }
    if (!canView(actor, noteRef(root))) return c.json({ error: "not_found" }, 404);
    if (!isTrashed(root)) return c.json({ ok: true, restored: [], already: true });
    let group: Note[];
    try {
      group = await trashedGroup(entry, root);
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    if ([noteRef(root), ...group.map(noteRef)].some((x) => !canDelete(actor, x))) return c.json({ error: "forbidden", reason: "You can’t restore every page in this group." }, 403);
    // Review H-A: restored page shares must not swallow notes that appeared under the path meanwhile.
    let exposure: { blocked: boolean; count: number };
    try {
      exposure = await restoreExposure(entry, actor, [root, ...group]);
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    if (exposure.blocked) return c.json({ error: "forbidden", reason: "Other pages now live where this page was. Restoring it would share them; ask an administrator, or move them first." }, 403);
    if (exposure.count && isAdmin(actor)) {
      recordAction({ actorEmail: actor.email, via: "session", origin: "human", action: "pages.restore-share-bypass", vaultId: entry.id, target: { rootId: root.id, exposed: exposure.count }, idempotencyKey: null, status: "ok", error: null });
    }
    const clear = { [TRASH_META.at]: null, [TRASH_META.by]: null, [TRASH_META.root]: null, [TRASH_META.path]: null };
    const outcome = await exclusive(entry.id, [root.path ?? root.id], async () => {
      const done: string[] = [];
      for (const it of [{ id: root.id, path: root.path, stamp: root.updatedAt }, ...group.map((g) => ({ id: g.id, path: g.path, stamp: g.updatedAt }))]) {
        try {
          await casWrite(entry, it.id, it.path, it.stamp, { metadata: clear, tags: { remove: [TRASH_TAG] } });
          ledgerDelete(entry.id, it.id);
          done.push(it.id);
        } catch (e) {
          return { done, failed: { id: it.id, reason: failReason(e) } };
        }
      }
      return { done, failed: null };
    });
    if (outcome === "busy") return c.json({ error: "busy" }, 409);
    if (outcome.done.length) wrote();
    if (!outcome.failed) return c.json({ ok: true, restored: outcome.done, path: root.path });
    return c.json({ error: "partial_restore", restored: outcome.done, failed: outcome.failed }, outcome.done.length ? 207 : 502);
  });

  r.delete("/trash/:id", async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: actor.kind === "anon" ? "unauthorized" : "forbidden" }, actor.kind === "anon" ? 401 : 403);
    const entry = entryFor(c, actor);
    let root: Note;
    try {
      root = await vaultClient(entry.id).getNote(c.req.param("id"));
    } catch (e) {
      return vaultErr(c, e);
    }
    if (!canView(actor, noteRef(root))) return c.json({ error: "not_found" }, 404);
    // Two deliberate steps: only something already in the Trash can be deleted for good.
    if (!isTrashed(root)) return c.json({ error: "not_in_trash", reason: "Move the page to Trash first." }, 409);
    let group: Note[];
    try {
      group = await trashedGroup(entry, root);
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    if ([noteRef(root), ...group.map(noteRef)].some((x) => !canDelete(actor, x))) return c.json({ error: "forbidden", reason: "You can’t delete every page in this group." }, 403);
    const outcome = await exclusive(entry.id, [root.path ?? root.id], async () => {
      const done: string[] = [];
      // Deepest first, so a failure never leaves a child without its page.
      const order = [...group].sort((a, b) => (b.path ?? "").split("/").length - (a.path ?? "").split("/").length).map((g) => g.id);
      for (const id of [...order, root.id]) {
        try {
          await vaultClient(entry.id).deleteNote(id);
          treeRemoveNote(entry, id);
          ledgerDelete(entry.id, id);
          deleteCollabSetAsideForNote(entry.id, id); // page text set aside from its live document goes with the page
          done.push(id);
          // Attachments go ONLY after their page is really gone (a failed delete must leave the
          // page restorable WITH its media). Per note; a purge that cannot finish records
          // orphans for the owner sweep and is never a user-visible failure.
          await purgeAttachmentsForNote(entry.id, id, { noteGone: true }).catch(() => {});
        } catch (e) {
          if (e instanceof VaultError && e.status === 404) {
            treeRemoveNote(entry, id);
            ledgerDelete(entry.id, id);
            done.push(id);
            await purgeAttachmentsForNote(entry.id, id, { noteGone: true }).catch(() => {});
            continue;
          }
          return { done, failed: { id, reason: failReason(e) } };
        }
      }
      return { done, failed: null };
    });
    if (outcome === "busy") return c.json({ error: "busy" }, 409);
    if (outcome.done.length) wrote();
    if (!outcome.failed) return c.json({ ok: true, deleted: outcome.done });
    return c.json({ error: "partial_delete", deleted: outcome.done, failed: outcome.failed }, outcome.done.length ? 207 : 502);
  });

  // ── preferences ───────────────────────────────────────────────────────────
  r.get("/me/preferences", async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: "unauthorized" }, 401);
    const entry = entryFor(c, actor);
    const stored = readPreferences(actor.email, entry.id);
    return servePreferences(c, actor, entry, stored.preferences, stored.revision);
  });

  // Byte cap enforced while the body streams, before anything is parsed (review M4).
  r.put("/me/preferences", bodyLimit({ maxSize: PREFERENCE_LIMITS.bytes, onError: (c) => c.json({ error: "too_large", limit: PREFERENCE_LIMITS.bytes }, 413) }), async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: "unauthorized" }, 401);
    const text = await c.req.text();
    let body: { preferences?: unknown; ifRevision?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!body || typeof body !== "object" || !body.preferences || typeof body.preferences !== "object") {
      return c.json({ error: "bad_request", reason: "preferences object required" }, 400);
    }
    if (body.ifRevision !== undefined && !Number.isSafeInteger(body.ifRevision)) return c.json({ error: "bad_request", reason: "ifRevision must be an integer" }, 400);
    const entry = entryFor(c, actor);
    // The caller only ever saw the ids they can view NOW; ids stored earlier that are
    // hidden from them right now (access removed, page trashed) are kept, not erased
    // by this PUT (review M4) — appended after the caller's own order.
    let visibleNow: (id: string) => boolean;
    try {
      visibleNow = await viewableIds(actor, entry);
    } catch {
      return c.json({ error: "vault_unreachable" }, 503);
    }
    const stored = readPreferences(actor.email, entry.id).preferences;
    const sent = sanitizePreferences(body.preferences);
    const keep = (mine: string[], before: string[]) => [...mine, ...before.filter((id) => !visibleNow(id) && !mine.includes(id))];
    const next = sanitizePreferences({ ...sent, favorites: keep(sent.favorites, stored.favorites), recents: keep(sent.recents, stored.recents) });
    const result = writePreferences(actor.email, entry.id, next, body.ifRevision as number | undefined);
    if (!result.ok) return c.json({ error: "conflict", revision: result.revision }, 409);
    return servePreferences(c, actor, entry, next, result.revision);
  });

  return r;
}

const pick = (m: PlannedMove) => ({ id: m.id, from: m.from, to: m.to });

// ── preferences store ───────────────────────────────────────────────────────
// One row per (user, vault). Created here so the module is self-contained.
db.exec(`
  CREATE TABLE IF NOT EXISTS page_preferences (
    email TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    data TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (email, vault_id)
  );
`);

// Trash ledger (review M1): one row per note trashed THROUGH the trash route. The
// purge worker deletes only ledger rows whose note still carries the same trash
// stamp; a note tagged trashed any other way is hidden, never auto-deleted.
db.exec(`
  CREATE TABLE IF NOT EXISTS page_trash_ledger (
    vault_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    trashed_at TEXT NOT NULL,
    trashed_by TEXT NOT NULL,
    PRIMARY KEY (vault_id, note_id)
  );
`);
// Move journal (review M5): a partial subtree move is resumable (by id + CAS) and visible.
db.exec(`
  CREATE TABLE IF NOT EXISTS page_moves (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    status TEXT NOT NULL,
    moved INTEGER NOT NULL DEFAULT 0,
    remaining INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export interface TrashLedgerRow { vault_id: string; note_id: string; root_id: string; trashed_at: string; trashed_by: string }
export function trashLedger(vaultId?: string): TrashLedgerRow[] {
  return (vaultId
    ? db.prepare("SELECT * FROM page_trash_ledger WHERE vault_id = ? ORDER BY trashed_at, note_id").all(vaultId)
    : db.prepare("SELECT * FROM page_trash_ledger ORDER BY trashed_at, note_id").all()) as TrashLedgerRow[];
}
function ledgerPut(vaultId: string, noteId: string, rootId: string, at: string, by: string): void {
  db.prepare("INSERT OR REPLACE INTO page_trash_ledger (vault_id, note_id, root_id, trashed_at, trashed_by) VALUES (?, ?, ?, ?, ?)").run(vaultId, noteId, rootId, at, by);
}
function ledgerDelete(vaultId: string, noteId: string): void {
  db.prepare("DELETE FROM page_trash_ledger WHERE vault_id = ? AND note_id = ?").run(vaultId, noteId);
}

interface MoveRow { id: string; vault_id: string; root_id: string; from_path: string; to_path: string; status: string; moved: number; remaining: number; created_by: string }
function getMove(id: string): MoveRow | null {
  return (db.prepare("SELECT * FROM page_moves WHERE id = ?").get(id) as MoveRow | undefined) ?? null;
}
function recordMove(m: MoveRow): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO page_moves (id, vault_id, root_id, from_path, to_path, status, moved, remaining, created_by, created_at, updated_at)
     VALUES (@id, @vault_id, @root_id, @from_path, @to_path, @status, @moved, @remaining, @created_by, @now, @now)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  ).run({ ...m, now });
}
function finishMove(id: string, status: "done" | "partial" | "failed", moved: number, remaining: number): void {
  db.prepare("UPDATE page_moves SET status = ?, moved = moved + ?, remaining = ?, updated_at = ? WHERE id = ?").run(status, moved, remaining, Date.now(), id);
}

/** The notes trashed together with `root` (fresh: one lean listing of trashed notes + the ledger). */
async function trashedGroup(entry: VaultEntry, root: Note): Promise<Note[]> {
  const trashed = await vaultClient(entry.id).listNotes({ tags: [TRASH_TAG], includeMetadata: [...TREE_META_KEYS] });
  const ledger = new Set(trashLedger(entry.id).filter((l) => l.root_id === root.id).map((l) => l.note_id));
  return trashed.filter((n) => n.id !== root.id && isTrashed(n) && (n.metadata?.[TRASH_META.root] === root.id || ledger.has(n.id)));
}

/** Which ids the actor can view right now (exists, not trashed, view cap) — from the tree. */
async function viewableIds(actor: Actor, entry: VaultEntry): Promise<(id: string) => boolean> {
  const byId = new Map((await ensureTree(entry)).rows().map((x) => [x.id, x]));
  return (id) => {
    const row = byId.get(id);
    return !!row && !row.tags.includes(TRASH_TAG) && canView(actor, rowRef(row));
  };
}

function readPreferences(email: string, vaultId: string): { preferences: PagePreferences; revision: number } {
  const row = db.prepare("SELECT data, revision FROM page_preferences WHERE email = ? AND vault_id = ?").get(email.toLowerCase(), vaultId) as { data: string; revision: number } | undefined;
  if (!row) return { preferences: EMPTY_PREFERENCES, revision: 0 };
  try {
    return { preferences: sanitizePreferences(JSON.parse(row.data)), revision: row.revision };
  } catch {
    return { preferences: EMPTY_PREFERENCES, revision: row.revision };
  }
}

function writePreferences(email: string, vaultId: string, prefs: PagePreferences, ifRevision?: number): { ok: boolean; revision: number } {
  const key = email.toLowerCase();
  return db.transaction(() => {
    const cur = db.prepare("SELECT revision FROM page_preferences WHERE email = ? AND vault_id = ?").get(key, vaultId) as { revision: number } | undefined;
    const revision = cur?.revision ?? 0;
    if (ifRevision !== undefined && ifRevision !== revision) return { ok: false, revision };
    db.prepare(
      `INSERT INTO page_preferences (email, vault_id, data, revision, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email, vault_id) DO UPDATE SET data = excluded.data, revision = excluded.revision, updated_at = excluded.updated_at`,
    ).run(key, vaultId, JSON.stringify(prefs), revision + 1, Date.now());
    return { ok: true, revision: revision + 1 };
  })();
}

/** Serve preferences filtered to notes the caller can view RIGHT NOW (never a hidden, trashed or deleted id). */
async function servePreferences(c: Context, actor: Actor, entry: VaultEntry, prefs: PagePreferences, revision: number) {
  let rows: TreeRow[];
  try {
    rows = (await ensureTree(entry)).rows();
  } catch {
    return c.json({ error: "vault_unreachable" }, 503);
  }
  const byId = new Map(rows.map((x) => [x.id, x]));
  const ok = (id: string) => {
    const row = byId.get(id);
    return !!row && !row.tags.includes(TRASH_TAG) && canView(actor, rowRef(row));
  };
  const favorites = prefs.favorites.filter(ok);
  const recents = prefs.recents.filter(ok);
  const items: Record<string, { path: string | null; title: string; tags: string[]; type?: string; prismType?: string }> = {};
  for (const id of new Set([...favorites, ...recents])) {
    const row = byId.get(id)!;
    items[id] = { path: row.path, title: pageTitle(row.path), tags: row.tags, ...(row.type ? { type: row.type } : {}), ...(row.prismType ? { prismType: row.prismType } : {}) };
  }
  c.header("Cache-Control", "private, no-store");
  return c.json({ preferences: { ...prefs, favorites, recents }, revision, items });
}

/** Test seam: wipe stored preferences. */
export function resetPagesForTests(): void {
  db.exec("DELETE FROM page_preferences; DELETE FROM page_trash_ledger; DELETE FROM page_moves;");
  busy.clear();
}

// ── auto-purge (opt-in worker) ──────────────────────────────────────────────

export const purgeEnabled = (): boolean => process.env.TRASH_PURGE_ENABLED === "true";
export const retentionDays = (): number => {
  const n = Number(process.env.TRASH_RETENTION_DAYS ?? TRASH_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? n : TRASH_RETENTION_DAYS;
};

/**
 * Delete pages that have sat in the Trash longer than the retention window, in
 * every registered vault. OFF unless `TRASH_PURGE_ENABLED=true`. Bounded per pass
 * (`TRASH_PURGE_MAX_PER_PASS`, 200). A note without a parseable trashed-at stamp is
 * never purged. The vault keeps its own delete tombstone (note history), so even a
 * purge leaves the owner a vault-level restore.
 */
export async function runTrashPurgeOnce(now = Date.now()): Promise<{ purged: number; failed: number; skipped: number }> {
  const out = { purged: 0, failed: 0, skipped: 0 };
  if (!purgeEnabled()) return out;
  const cutoff = now - retentionDays() * 86_400_000;
  let budget = Number(process.env.TRASH_PURGE_MAX_PER_PASS ?? 200);
  // ONLY ledger entries (review M1): a note tagged trashed outside the trash route is
  // hidden but never auto-deleted. Each candidate is re-read and must still carry the
  // SAME trash stamp, must not be protected, and must still be tagged.
  for (const row of trashLedger()) {
    if (budget <= 0) break;
    const at = Date.parse(row.trashed_at);
    if (!Number.isFinite(at) || at > cutoff) {
      out.skipped++;
      continue;
    }
    const registered = getVaultRegistry().some((e) => e.id === row.vault_id);
    if (!registered) {
      out.skipped++;
      continue;
    }
    const entry = resolveVaultEntry(row.vault_id);
    let note: Note;
    try {
      note = await vaultClient(entry.id).getNote(row.note_id);
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) ledgerDelete(row.vault_id, row.note_id);
      else out.failed++;
      continue;
    }
    if (note.id !== row.note_id || !isTrashed(note) || note.metadata?.[TRASH_META.at] !== row.trashed_at || protectionReason(note)) {
      // Restored by hand, re-trashed differently, or a protected note: never purge on this row.
      if (!isTrashed(note)) ledgerDelete(row.vault_id, row.note_id);
      out.skipped++;
      continue;
    }
    budget--;
    try {
      await vaultClient(entry.id).deleteNote(note.id);
      treeRemoveNote(entry, note.id);
      ledgerDelete(row.vault_id, row.note_id);
      deleteCollabSetAsideForNote(entry.id, note.id); // (see DELETE /trash/:id)
      out.purged++;
      // After the delete succeeded, never before (see DELETE /trash/:id).
      await purgeAttachmentsForNote(entry.id, note.id, { noteGone: true }).catch(() => {});
    } catch {
      out.failed++;
    }
  }
  if (out.purged || out.failed) console.log(`[trash] purge: ${out.purged} deleted, ${out.failed} failed (older than ${retentionDays()} days)`);
  return out;
}
