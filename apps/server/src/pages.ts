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
import { db, resolveVaultEntry, getVaultRegistry } from "./db";
import { resolveActor, type Actor } from "./auth/actor";
import { effectiveCaps, type Cap, type NoteRef } from "./permissions";
import { roleAtLeast, roleFloor } from "./roles";
import { vaultClient, VaultError, VaultConflictError, type Note } from "./parachute";
import { ensureTree, treeUpsertNote, treeRemoveNote, rowRef, type TreeRow } from "./tree";
import type { VaultEntry } from "./config";
import {
  TRASH_TAG,
  TRASH_META,
  TRASH_RETENTION_DAYS,
  PREFERENCE_LIMITS,
  EMPTY_PREFERENCES,
  isTrashed,
  isProtectedPath,
  isUnder,
  movedPath,
  normalizePagePath,
  pageTitle,
  planSubtreeMove,
  protectionReason,
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

// One structural operation per vault at a time: two concurrent subtree moves (or a
// move racing a trash of the same pages) would plan against each other's half-done state.
const busy = new Set<string>();
async function exclusive<T>(vaultId: string, fn: () => Promise<T>): Promise<T | "busy"> {
  if (busy.has(vaultId)) return "busy";
  busy.add(vaultId);
  try {
    return await fn();
  } finally {
    busy.delete(vaultId);
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

/** The page and every note trashed together with it (or under it, for a fresh trash). */
function groupRows(rows: TreeRow[], root: Note, mode: "trash" | "trashed"): TreeRow[] {
  if (mode === "trashed") return rows.filter((r) => r.id !== root.id && r.tags.includes(TRASH_TAG) && r.trashedRoot === root.id);
  return root.path ? rows.filter((r) => r.id !== root.id && isUnder(r.path, root.path!) && !r.tags.includes(TRASH_TAG)) : [];
}

/** Refusal for a group the actor can't act on: count only, never ids of notes they can't see. */
function checkGroup(a: Actor, root: Note, rows: TreeRow[], allowed: (a: Actor, r: NoteRef) => boolean) {
  const rootReason = protectionReason(root);
  if (rootReason) return { status: 403 as const, body: { error: "protected", reason: rootReason } };
  const protectedRows = rows.filter((r) => protectionReason(r));
  if (protectedRows.length) {
    return { status: 403 as const, body: { error: "protected", reason: "Some pages inside are kept in sync by an integration or the system.", count: protectedRows.length } };
  }
  const blocked = [noteRef(root), ...rows.map(rowRef)].filter((r) => !allowed(a, r)).length;
  if (blocked) return { status: 403 as const, body: { error: "forbidden", reason: "You can’t change every page in this group.", blocked } };
  if (rows.length + 1 > MAX_GROUP) return { status: 413 as const, body: { error: "too_many", limit: MAX_GROUP } };
  return null;
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
    const entry = entryFor(c, actor);
    let root: Note;
    try {
      root = await vaultClient(entry.id).getNote(c.req.param("id"));
    } catch (e) {
      return vaultErr(c, e);
    }
    if (!canView(actor, noteRef(root))) return c.json({ error: "forbidden" }, 403);
    if (!root.path) return c.json({ error: "bad_request", reason: "This page has no location to move." }, 400);

    let target: string | null = null;
    if (body.newPath !== undefined) target = normalizePagePath(body.newPath);
    else if (body.newParentPath !== undefined) {
      const parent = body.newParentPath === "" ? "" : normalizePagePath(body.newParentPath);
      target = parent === null ? null : movedPath(root.path, parent);
    }
    if (!target) return c.json({ error: "bad_request", reason: "A valid newPath or newParentPath is required." }, 400);
    // Resume a partial move: the root already sits at the target; finish the
    // descendants still under the original location.
    const fromPath = body.fromPath !== undefined ? normalizePagePath(body.fromPath) : null;
    const resuming = root.path === target && !!fromPath && fromPath !== target;
    const from = resuming ? fromPath! : root.path;
    if (from === target) return c.json({ error: "no_change" }, 400);
    if (isUnder(target, from)) return c.json({ error: "into_own_subtree", reason: "A page can’t move inside itself." }, 400);
    if (isProtectedPath(target)) return c.json({ error: "protected", reason: "That location is kept in sync by an integration." }, 403);
    if (!resuming && typeof body.if_updated_at !== "string") return c.json({ error: "precondition_required", reason: "if_updated_at is required" }, 428);

    let rows: TreeRow[];
    try {
      rows = (await ensureTree(entry)).rows();
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    const others = rows.filter((x) => x.id !== root.id);
    const plan = planSubtreeMove([{ id: root.id, path: root.path, updatedAt: root.updatedAt }, ...others], from, target, root.id);
    const byId = new Map(rows.map((x) => [x.id, x]));
    const descendants = plan.filter((m) => m.id !== root.id).map((m) => byId.get(m.id)!).filter(Boolean);
    const refusal = checkGroup(actor, root, descendants, canOrganize);
    if (refusal) return c.json(refusal.body, refusal.status);
    // Every destination must be free (case-insensitively, like the vault's path index).
    const moving = new Set(plan.map((m) => m.id));
    const occupied = new Set(rows.filter((x) => x.path && !moving.has(x.id)).map((x) => x.path!.toLowerCase()));
    const clash = plan.find((m) => occupied.has(m.to.toLowerCase()));
    if (clash) return c.json({ error: "path_conflict", path: clash.to, reason: `A page already exists at ${clash.to}.` }, 409);

    const outcome = await exclusive(entry.id, async () => {
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
    if (outcome === "busy") return c.json({ error: "busy", reason: "Another page move is in progress. Try again in a moment." }, 409);
    if (outcome.moved.length) wrote();
    if (!outcome.failed) return c.json({ ok: true, path: target, moved: outcome.moved, wikilinks: "vault_cascade" });
    if (!outcome.moved.length && !resuming) {
      // Nothing changed: report the root's own failure plainly (stale page → reload and retry).
      return outcome.failed.reason === "conflict"
        ? c.json({ error: "conflict", reason: "This page changed since you opened it. Reload and try again." }, 409)
        : vaultErr(c, outcome.error);
    }
    return c.json(
      {
        error: "partial_move",
        reason: "Some pages moved and some did not. Retry to finish the move.",
        moved: outcome.moved,
        failed: outcome.failed,
        remaining: plan.length - outcome.moved.length,
        resume: { fromPath: from, newPath: target },
      },
      207,
    );
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
    if (!canView(actor, noteRef(root))) return c.json({ error: "forbidden" }, 403);
    if (isTrashed(root)) return c.json({ ok: true, rootId: root.id, trashed: [], already: true });
    let rows: TreeRow[];
    try {
      rows = (await ensureTree(entry)).rows();
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    const group = groupRows(rows, root, "trash");
    const refusal = checkGroup(actor, root, group, canDelete);
    if (refusal) return c.json(refusal.body, refusal.status);
    const at = new Date().toISOString();
    const by = actor.email;
    const outcome = await exclusive(entry.id, async () => {
      const done: string[] = [];
      const items = [{ id: root.id, path: root.path, stamp: (typeof body.if_updated_at === "string" ? body.if_updated_at : root.updatedAt) as string | null }, ...group.map((g) => ({ id: g.id, path: g.path, stamp: g.updatedAt }))];
      for (const it of items) {
        try {
          await casWrite(entry, it.id, it.path, it.stamp, {
            metadata: { [TRASH_META.at]: at, [TRASH_META.by]: by, [TRASH_META.root]: root.id, [TRASH_META.path]: it.path },
            tags: { add: [TRASH_TAG] },
          });
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
    c.header("Cache-Control", "private, no-store");
    return c.json({ items, total: items.length, retentionDays: retentionDays(), autoPurge: purgeEnabled() });
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
    if (!canView(actor, noteRef(root))) return c.json({ error: "forbidden" }, 403);
    if (!isTrashed(root)) return c.json({ ok: true, restored: [], already: true });
    let rows: TreeRow[];
    try {
      rows = (await ensureTree(entry)).rows();
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    const group = groupRows(rows, root, "trashed");
    const blocked = [noteRef(root), ...group.map(rowRef)].filter((x) => !canDelete(actor, x)).length;
    if (blocked) return c.json({ error: "forbidden", reason: "You can’t restore every page in this group.", blocked }, 403);
    const clear = { [TRASH_META.at]: null, [TRASH_META.by]: null, [TRASH_META.root]: null, [TRASH_META.path]: null };
    const outcome = await exclusive(entry.id, async () => {
      const done: string[] = [];
      for (const it of [{ id: root.id, path: root.path, stamp: root.updatedAt }, ...group.map((g) => ({ id: g.id, path: g.path, stamp: g.updatedAt }))]) {
        try {
          await casWrite(entry, it.id, it.path, it.stamp, { metadata: clear, tags: { remove: [TRASH_TAG] } });
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
    if (!canView(actor, noteRef(root))) return c.json({ error: "forbidden" }, 403);
    // Two deliberate steps: only something already in the Trash can be deleted for good.
    if (!isTrashed(root)) return c.json({ error: "not_in_trash", reason: "Move the page to Trash first." }, 409);
    let rows: TreeRow[];
    try {
      rows = (await ensureTree(entry)).rows();
    } catch {
      return c.json({ error: "vault_unreachable" }, 502);
    }
    const group = groupRows(rows, root, "trashed");
    const blocked = [noteRef(root), ...group.map(rowRef)].filter((x) => !canDelete(actor, x)).length;
    if (blocked) return c.json({ error: "forbidden", reason: "You can’t delete every page in this group.", blocked }, 403);
    const outcome = await exclusive(entry.id, async () => {
      const done: string[] = [];
      // Deepest first, so a failure never leaves a child without its page.
      const order = [...group].sort((a, b) => (b.path ?? "").split("/").length - (a.path ?? "").split("/").length).map((g) => g.id);
      for (const id of [...order, root.id]) {
        try {
          await vaultClient(entry.id).deleteNote(id);
          treeRemoveNote(entry, id);
          done.push(id);
        } catch (e) {
          if (e instanceof VaultError && e.status === 404) {
            treeRemoveNote(entry, id);
            done.push(id);
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

  r.put("/me/preferences", async (c) => {
    const actor = resolveActor(c);
    if (actor.kind !== "user") return c.json({ error: "unauthorized" }, 401);
    const text = await c.req.text();
    if (text.length > PREFERENCE_LIMITS.bytes) return c.json({ error: "too_large", limit: PREFERENCE_LIMITS.bytes }, 413);
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
    const next = sanitizePreferences(body.preferences);
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
  db.exec("DELETE FROM page_preferences;");
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
  for (const entry of getVaultRegistry()) {
    if (budget <= 0) break;
    let notes: Note[];
    try {
      notes = await vaultClient(entry.id).listNotes({ tags: [TRASH_TAG], includeMetadata: [TRASH_META.at] });
    } catch (e) {
      console.warn(`[trash] vault=${entry.id} list failed: ${(e as Error).message}`);
      continue;
    }
    for (const n of notes) {
      if (budget <= 0) break;
      const at = Date.parse(String(n.metadata?.[TRASH_META.at] ?? ""));
      if (!isTrashed(n) || !Number.isFinite(at) || at > cutoff) {
        out.skipped++;
        continue;
      }
      budget--;
      try {
        await vaultClient(entry.id).deleteNote(n.id);
        treeRemoveNote(entry, n.id);
        out.purged++;
      } catch {
        out.failed++;
      }
    }
  }
  if (out.purged || out.failed) console.log(`[trash] purge: ${out.purged} deleted, ${out.failed} failed (older than ${retentionDays()} days)`);
  return out;
}
