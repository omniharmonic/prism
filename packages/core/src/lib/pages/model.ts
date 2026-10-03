/**
 * Pages model — the ONE definition of how Prism organises pages on top of a
 * path-based vault, shared by the web/desktop UI and the Prism Server
 * (`@prism/core/pages`). Pure: no React, no fetch.
 *
 * NESTING. A vault path is the hierarchy. A page note at `X` owns every note at
 * `X/…` — the sidebar shows the page itself as the folder node, "Add a page
 * inside" creates `X/<title>`, and moving `X` moves its whole subtree. A path
 * prefix with no page note (`Projects/` with only `Projects/Plan`) is still a
 * plain folder, so every existing vault keeps rendering exactly as before.
 *
 * TRASH. Soft delete that survives inside the vault model: the note keeps its
 * id, path, content, tags and links, gains the {@link TRASH_TAG} tag and
 * `prism_trashed_*` metadata, and is hidden from the tree, lists, search and
 * shortcuts. Restore removes both. "Delete permanently" is the real vault delete
 * (whose history tombstone the vault still keeps). The tag is namespaced so it
 * can never collide with a user's own `trashed` tag.
 *
 * PROTECTION. Ingest-owned locations and system notes (mail, chat threads,
 * calendar meetings, ClickUp mirrors, agent dispatches/sessions/alerts, person
 * notes, governance, skills) are never moved or trashed from the page UI: their
 * writers find them by path or tag and would re-create, duplicate or orphan them.
 */

export const TRASH_TAG = "prism-trashed";
export const TRASH_META = {
  at: "prism_trashed_at",
  by: "prism_trashed_by",
  /** The id of the page whose trashing took this note with it (itself for the root). */
  root: "prism_trashed_root",
  path: "prism_trashed_path",
} as const;
/** Metadata flag: the page is read-only for everyone until unlocked. */
export const LOCK_KEY = "prism_locked";
/** Metadata: fractional sibling order in the sidebar (lower first). */
export const ORDER_KEY = "prism_order";
/** Notes carrying this tag are offered by "New page from template". */
export const TEMPLATE_TAG = "template";
/** Days a trashed page waits before the (opt-in) purge worker deletes it. */
export const TRASH_RETENTION_DAYS = 30;

/** Ingest-owned path roots (literal; every ingester writes the `vault/` form in every vault). */
export const PROTECTED_PATH_PREFIXES = [
  "vault/messages",
  "vault/meetings",
  "vault/tasks/clickup",
  "vault/agent",
  "vault/_inbox",
  "vault/people",
] as const;
/** Tags whose notes are system-owned. `governance-*` is matched as a prefix. */
export const PROTECTED_TAGS = [
  "message-thread",
  "message-archive",
  "person",
  "agent-skill",
  "agent-dispatch",
  "agent-session",
  "alert",
] as const;

export interface PageLike {
  id?: string;
  path?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export const isTrashed = (n: { tags?: string[] | null } | null | undefined): boolean =>
  !!n?.tags?.includes(TRASH_TAG);

export const isLocked = (n: { metadata?: Record<string, unknown> | null } | null | undefined): boolean =>
  n?.metadata?.[LOCK_KEY] === true;

/** Drop trashed notes from any list (owner passthrough clients, desktop, fallbacks). */
export function withoutTrashed<T extends { tags?: string[] | null }>(list: T[]): T[] {
  return list.some(isTrashed) ? list.filter((n) => !isTrashed(n)) : list;
}

/** True when `path` is, or lies under, an ingest-owned root. */
export function isProtectedPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const p = path.toLowerCase();
  return PROTECTED_PATH_PREFIXES.some((root) => p === root || p.startsWith(`${root}/`));
}

/**
 * TRUE system notes: what the agent runner executes or records (`agent-*`, anything
 * under `vault/agent`), alerts, and every `governance-*` record. Unlike the wider
 * `protectionReason` set below (which also covers INGEST notes — meetings, ClickUp
 * tasks, people, message threads, the inbox — that collaborators legitimately edit
 * in place), these are read-only for every non-owner whatever their grants: a skill
 * note runs with the vault token, a governance note carries authority.
 */
export const SYSTEM_NOTE_TAGS = ["agent-skill", "agent-dispatch", "agent-session", "alert"] as const;
export const SYSTEM_NOTE_PATH_PREFIX = "vault/agent";
export function systemNoteReason(n: PageLike): string | null {
  const tags = n.tags ?? [];
  if (tags.some((t) => t.startsWith("governance-"))) return "Governance records can only change through governance.";
  const p = (n.path ?? "").toLowerCase();
  if (tags.some((t) => (SYSTEM_NOTE_TAGS as readonly string[]).includes(t)) || p === SYSTEM_NOTE_PATH_PREFIX || p.startsWith(`${SYSTEM_NOTE_PATH_PREFIX}/`)) {
    return "This is a system note, so it can’t be changed here.";
  }
  return null;
}

/**
 * Why this note may not be MOVED or TRASHED (or have its path / system tags changed)
 * from the page UI, or null — the PLACEMENT notion: system notes AND ingest-owned
 * ones. It says nothing about editing the note in place; that is `systemNoteReason`.
 */
export function protectionReason(n: PageLike): string | null {
  if (isProtectedPath(n.path)) return "This page is kept in sync by an integration, so it can’t be moved or deleted here.";
  const tags = n.tags ?? [];
  if (tags.some((t) => t.startsWith("governance-"))) return "Governance records can only change through governance.";
  if (tags.some((t) => (PROTECTED_TAGS as readonly string[]).includes(t))) return "This is a system note, so it can’t be moved or deleted here.";
  return null;
}

/**
 * A clean vault path, or null: no empty / `.` / `..` segments, no leading slash, no
 * control chars. Canonical the way the vault will STORE it, so every check runs on
 * the real destination: the vault's `normalizePath` strips a trailing `.md`
 * (case-insensitive) — `vault/agent.md` IS `vault/agent` — so it is stripped here
 * first (repeatedly: what is sent must not be stripped again); and the result is
 * Unicode-NFC, so one spelling of a name is what gets compared and stored.
 */
export function normalizePagePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().normalize("NFC");
  while (/\.md$/i.test(value)) value = value.replace(/\.md$/i, "");
  if (!value || value.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part.trim() || part === "." || part === ".." || part !== part.trim())) return null;
  return parts.join("/");
}

export const leafName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** `path` lies strictly under `ancestor`. */
export const isUnder = (path: string | null | undefined, ancestor: string): boolean =>
  !!path && path.length > ancestor.length && path.startsWith(`${ancestor}/`);
/** A page's display title: its path leaf without a file extension. */
export const pageTitle = (path: string | null | undefined): string =>
  (path ? leafName(path).replace(/\.[a-z0-9]{1,8}$/i, "") : "") || "Untitled";

/**
 * Where a page lands when moved under `parent` ("" = top level). Top level keeps
 * the page's own `vault/` convention (the personal vault prefixes every path; a
 * commons vault does not), mirroring the sidebar's folder moves.
 */
export function movedPath(currentPath: string, parent: string): string {
  const leaf = leafName(currentPath);
  if (parent) return `${parent}/${leaf}`;
  return (currentPath.startsWith("vault/") ? "vault/" : "") + leaf;
}

export interface MoveRow {
  id: string;
  path: string | null;
  updatedAt?: string | null;
}
export interface PlannedMove {
  id: string;
  from: string;
  to: string;
  updatedAt: string | null;
}

/**
 * Every path write a subtree move needs: notes under `fromRoot/` re-rooted at
 * `toRoot/`, shallowest first. The root page itself is included when `rootId`
 * still sits at `fromRoot`. Pure; the caller checks permissions and conflicts.
 */
export function planSubtreeMove(rows: Iterable<MoveRow>, fromRoot: string, toRoot: string, rootId?: string): PlannedMove[] {
  const out: PlannedMove[] = [];
  for (const r of rows) {
    if (!r.path) continue;
    if (r.id === rootId && r.path === fromRoot) out.push({ id: r.id, from: r.path, to: toRoot, updatedAt: r.updatedAt ?? null });
    else if (isUnder(r.path, fromRoot)) out.push({ id: r.id, from: r.path, to: toRoot + r.path.slice(fromRoot.length), updatedAt: r.updatedAt ?? null });
  }
  return out.sort((a, b) => a.from.split("/").length - b.from.split("/").length || a.from.localeCompare(b.from));
}

/** A fractional order key strictly between two neighbours (either may be absent). */
export function orderBetween(before?: number | null, after?: number | null): number {
  const a = typeof before === "number" && Number.isFinite(before) ? before : null;
  const b = typeof after === "number" && Number.isFinite(after) ? after : null;
  if (a === null && b === null) return 1000;
  if (a === null) return b! - 1000;
  if (b === null) return a + 1000;
  return a + (b - a) / 2;
}

/** A note's sidebar order key, if it has one. */
export const orderOf = (n: { metadata?: Record<string, unknown> | null }): number | null => {
  const v = n.metadata?.[ORDER_KEY];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

// ── preferences (GET/PUT /api/me/preferences) ───────────────────────────────

export const PREFERENCE_LIMITS = { favorites: 100, recents: 50, sections: 24, bytes: 64 * 1024 } as const;
/** Sidebar sections the user may reorder or collapse. */
export const SIDEBAR_SECTIONS = ["favorites", "recent", "pages", "tools"] as const;

export interface PagePreferences {
  version: 1;
  /** Note ids, most recently starred first. */
  favorites: string[];
  /** Note ids, most recently opened first. */
  recents: string[];
  sidebar: { order: string[]; collapsed: string[] };
}

export const EMPTY_PREFERENCES: PagePreferences = { version: 1, favorites: [], recents: [], sidebar: { order: [], collapsed: [] } };

const validId = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= 256 && !/[\u0000-\u001f\u007f]/.test(x);

function idList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(validId))].slice(0, limit);
}

/** Coerce anything into a bounded, schema-valid preferences document. Never throws. */
export function sanitizePreferences(raw: unknown): PagePreferences {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const sidebar = o.sidebar && typeof o.sidebar === "object" && !Array.isArray(o.sidebar) ? (o.sidebar as Record<string, unknown>) : {};
  const sections = (v: unknown) =>
    idList(v, PREFERENCE_LIMITS.sections).filter((s) => (SIDEBAR_SECTIONS as readonly string[]).includes(s));
  return {
    version: 1,
    favorites: idList(o.favorites, PREFERENCE_LIMITS.favorites),
    recents: idList(o.recents, PREFERENCE_LIMITS.recents),
    sidebar: { order: sections(sidebar.order), collapsed: sections(sidebar.collapsed) },
  };
}

/**
 * Reorder `list` so `id` sits at position `index` of the VISIBLE subsequence
 * (`visible` defaults to the whole list). Ids not in `visible` are not shown to
 * the user, so they are never chosen as a drop target; each stays attached
 * behind the visible id that preceded it. Returns the same array when nothing moves.
 */
export function moveWithin(list: string[], id: string, index: number, visible?: string[]): string[] {
  const shown = (visible ?? list).filter((x) => list.includes(x));
  const from = shown.indexOf(id);
  if (from < 0) return list;
  const to = Math.max(0, Math.min(shown.length - 1, Math.trunc(index)));
  if (to === from) return list;
  // Group every hidden id with the visible id before it (leading hidden ids stay first).
  const lead: string[] = [];
  const groups = new Map<string, string[]>();
  let current: string | null = null;
  for (const x of list) {
    if (shown.includes(x)) { current = x; groups.set(x, [x]); }
    else if (current === null) lead.push(x);
    else groups.get(current)!.push(x);
  }
  const order = shown.filter((x) => x !== id);
  order.splice(to, 0, id);
  return [...lead, ...order.flatMap((x) => groups.get(x)!)];
}

/** Pure edits the client applies (and re-applies after a revision conflict). */
export const preferenceOps = {
  toggleFavorite(p: PagePreferences, id: string): PagePreferences {
    const has = p.favorites.includes(id);
    return { ...p, favorites: has ? p.favorites.filter((x) => x !== id) : [id, ...p.favorites].slice(0, PREFERENCE_LIMITS.favorites) };
  },
  /** Move a favorite to `index` among the favorites the caller can see (`visible`, in shown order).
   *  Favorites hidden from the caller right now keep their place relative to the one before them. */
  moveFavorite(p: PagePreferences, id: string, index: number, visible?: string[]): PagePreferences {
    const next = moveWithin(p.favorites, id, index, visible);
    return next === p.favorites ? p : { ...p, favorites: next };
  },
  pushRecent(p: PagePreferences, id: string): PagePreferences {
    if (p.recents[0] === id) return p;
    return { ...p, recents: [id, ...p.recents.filter((x) => x !== id)].slice(0, PREFERENCE_LIMITS.recents) };
  },
  merge(p: PagePreferences, local: { favorites: string[]; recents: string[] }): PagePreferences {
    return sanitizePreferences({
      ...p,
      favorites: [...p.favorites, ...local.favorites.filter((id) => !p.favorites.includes(id))],
      recents: [...p.recents, ...local.recents.filter((id) => !p.recents.includes(id))],
    });
  },
  setCollapsed(p: PagePreferences, section: string, collapsed: boolean): PagePreferences {
    const rest = p.sidebar.collapsed.filter((s) => s !== section);
    return sanitizePreferences({ ...p, sidebar: { ...p.sidebar, collapsed: collapsed ? [...rest, section] : rest } });
  },
};

// ── templates ───────────────────────────────────────────────────────────────

/** Metadata a template copy must never inherit (identity, access, system state). */
const TEMPLATE_DROP = /^(prism_(creator|visibility|trashed_.*|locked|order|merged.*)|gov_.*|title|template.*|calendarEventId|matrixRoomId|source_id|threadId|messageId)$/;

/** The create payload for a new page copied from a template note. */
export function templateCopy(
  template: { content: string; metadata?: Record<string, unknown> | null; tags?: string[] | null },
  title: string,
  folder: string,
): { content: string; path: string; metadata: Record<string, unknown>; tags: string[] } {
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template.metadata ?? {})) if (!TEMPLATE_DROP.test(k)) metadata[k] = v;
  metadata.title = title;
  const tags = (template.tags ?? []).filter((t) => t !== TEMPLATE_TAG && t !== TRASH_TAG);
  return { content: template.content || " ", path: (folder ? `${folder}/` : "") + title, metadata, tags };
}

/** The payload for "Duplicate": a copy beside the original with a free "(copy)" name. */
export function duplicateCopy(
  note: { content: string; path: string | null; metadata?: Record<string, unknown> | null; tags?: string[] | null },
  takenPaths: Iterable<string | null>,
): { content: string; path: string; metadata: Record<string, unknown>; tags: string[] } {
  const taken = new Set([...takenPaths].filter((p): p is string => !!p).map((p) => p.toLowerCase()));
  const parent = note.path ? parentOf(note.path) : "";
  const base = `${pageTitle(note.path)} (copy)`;
  let name = base;
  for (let i = 2; taken.has(((parent ? `${parent}/` : "") + name).toLowerCase()); i++) name = `${base} ${i}`;
  const copy = templateCopy({ content: note.content, metadata: note.metadata, tags: note.tags }, name, parent);
  // A duplicate keeps the original's tags (a template copy drops `template`; keep it for a duplicated template).
  copy.tags = (note.tags ?? []).filter((t) => t !== TRASH_TAG);
  return copy;
}

/** Does a page's body or metadata reference an uploaded file (`/api/attachments/<id>`)? */
export function referencesAttachments(note: { content?: string | null; metadata?: Record<string, unknown> | null }): boolean {
  return (note.content ?? "").includes("/api/attachments/") || JSON.stringify(note.metadata ?? {}).includes("/api/attachments/");
}

/** What to tell the person after a copy's files were (not) copied; "" when all is well.
 *  `more` still true when the client stopped = files left pointing at the original. */
export function copyFilesNotice(result: { failed: number; errors?: number; more: boolean } | null): string {
  if (!result) return "Its files could not be copied.";
  if (result.more || (result.errors ?? 0) > 0 || result.failed > 0) return "Some files were not copied.";
  return "";
}

// ── wire types (server ⇄ clients) ───────────────────────────────────────────

export interface MoveRequest {
  /** Parent location ("" = top level). Ignored when `newPath` is given. */
  newParentPath?: string;
  newPath?: string;
  /** The page's `updatedAt` the user saw (required unless resuming). */
  ifUpdatedAt?: string;
  /** Resume a journaled partial move (with the page's current `ifUpdatedAt`). */
  moveId?: string;
}
export interface MoveResult {
  ok: boolean;
  path: string;
  moved: Array<{ id: string; from: string; to: string }>;
  /** Present when only part of the subtree moved; call again with `resume` to finish. */
  partial?: { failed: { id: string; from: string; to: string; reason: string }; resume: { moveId: string; newPath: string }; remaining: number };
}
export interface TrashItem {
  id: string;
  path: string | null;
  title: string;
  trashedAt: string | null;
  trashedBy: string | null;
  /** Sub-pages that went to the Trash with this page. */
  descendants: number;
  canRestore: boolean;
  canDelete: boolean;
}
export interface TrashListing {
  items: TrashItem[];
  total: number;
  retentionDays: number;
  autoPurge: boolean;
}
export interface PreferencesSnapshot {
  preferences: PagePreferences;
  revision: number;
  items: Record<string, { path: string | null; title: string; tags: string[]; type?: string; prismType?: string }>;
}

/** A refused pages request, with the server's machine code and human reason. */
export class PagesRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PagesRequestError";
  }
}

/**
 * Sidebar reorder: where `dragged` lands relative to `target` among one parent's
 * pages (in their displayed order). One write when every sibling already has an
 * order key; otherwise the siblings are renumbered once (up to `maxRenumber`), so
 * the result is exactly what the user saw — never "jumped above every unordered page".
 */
export function planReorder(
  siblings: Array<{ id: string; order: number | null }>,
  draggedId: string,
  targetId: string,
  zone: "before" | "after",
  maxRenumber = 100,
): Array<{ id: string; order: number }> {
  const list = siblings.filter((s) => s.id !== draggedId);
  const idx = list.findIndex((s) => s.id === targetId);
  if (idx < 0) return [];
  const at = zone === "before" ? idx : idx + 1;
  const prev = list[at - 1];
  const next = list[at];
  const allOrdered = list.every((s) => s.order !== null);
  if (allOrdered || list.length + 1 > maxRenumber) {
    return [{ id: draggedId, order: orderBetween(prev?.order ?? null, next?.order ?? null) }];
  }
  const final = [...list.slice(0, at), { id: draggedId, order: null as number | null }, ...list.slice(at)];
  return final.flatMap((s, i) => (s.id === draggedId || s.order !== (i + 1) * 1000 ? [{ id: s.id, order: (i + 1) * 1000 }] : []));
}

/** Displayed sibling order: pages with an order key first (ascending), then the rest by name. */
export function comparePages(a: { name: string; order: number | null }, b: { name: string; order: number | null }): number {
  if (a.order !== null && b.order !== null) return a.order - b.order || a.name.localeCompare(b.name);
  if (a.order !== null) return -1;
  if (b.order !== null) return 1;
  return a.name.localeCompare(b.name);
}

/**
 * Metadata keys only the owner/admin (or the server's own pages routes) may write:
 * who can see a note, who created it, and its Trash state. A non-owner metadata
 * write naming one is refused. `prism_locked` is separate: it needs `organize`
 * and a reviewed `if_updated_at` (see the gateway PATCH).
 */
export const OWNER_ONLY_META = ["prism_creator", "prism_visibility", TRASH_META.at, TRASH_META.by, TRASH_META.root, TRASH_META.path] as const;
export const isOwnerOnlyMeta = (key: string): boolean => (OWNER_ONLY_META as readonly string[]).includes(key) || key.startsWith("prism_trashed_");

// ── Per-page style (NP-PG-08, wave 2E) ──────────────────────────────────────
/** Metadata: per-page presentation, `{ small?: true, full?: true }`. The page
 *  font stays in `metadata.contentFont` (the existing per-document Sans/Serif/
 *  Mono). Written only through the pages meta endpoint (CAS, live-doc safe). */
export const PAGE_STYLE_KEY = "prism_page_style";
export interface PageStyle { small?: boolean; full?: boolean }

/** Strict: an object holding only boolean `small`/`full`; anything else → null.
 *  Returns just the keys given (a PATCH). The server merges it onto the stored
 *  style and writes BOTH keys as explicit booleans — the vault merges nested
 *  metadata, so turning a flag off must be stored as `false`. */
export function parsePageStyle(value: unknown): PageStyle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.some((k) => k !== "small" && k !== "full")) return null;
  if (keys.some((k) => typeof v[k] !== "boolean")) return null;
  const out: PageStyle = {};
  if (typeof v.small === "boolean") out.small = v.small;
  if (typeof v.full === "boolean") out.full = v.full;
  return out;
}

export function pageStyleOf(note: { metadata?: Record<string, unknown> | null } | null | undefined): PageStyle {
  return parsePageStyle(note?.metadata?.[PAGE_STYLE_KEY]) ?? {};
}
