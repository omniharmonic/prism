/**
 * Sharing helpers (wave 2D): who can see a page, where their access comes from,
 * and how people are named in the share UI. Pure functions over the grant rows
 * and the in-memory tree projection; the routes (routes/acl.ts,
 * routes/sharing.ts) do the authorization.
 *
 * NAMING POLICY (NP-CO-05). A share list names its grantees with their display
 * name and avatar. It is served ONLY to callers who may manage that note's access
 * (the owner/admins, or a holder of the `share` cap on it) — exactly the people
 * the list already revealed grantee EMAILS to before this change (an email is
 * needed to change or remove a grant). So names/avatars add no new audience.
 * Everywhere else (presence, comments, "shared by", history) people are named by
 * display name only, never by an email that sharing did not already reveal.
 */
import { getUser, grantsForResource, type Grant } from "./db";
import type { VaultEntry } from "./config";
import { ensureTree, type TreeRow } from "./tree";
import { expandLevel, type Cap, type Level } from "./permissions";
import { WRITER_KEY, WRITER_AT_KEY, resolveWriter, stripIdentity, writerIdFor, writerNames } from "./writer-stamp";
import { TRASH_TAG } from "@prism/core/pages";

export interface PersonView {
  email: string;
  name: string | null;
  /** A small `data:image/…` URL, or null. */
  avatar: string | null;
}

/** Display fields for an account (no lookup leaks beyond the email the caller passed). */
export function personView(email: string): PersonView {
  const u = getUser(email);
  const avatar = typeof u?.avatar === "string" && u.avatar.startsWith("data:image/") && u.avatar.length <= 200_000 ? u.avatar : null;
  return { email, name: u?.name?.trim() || null, avatar };
}

/** A name safe to show to someone who must NOT learn the email (falls back to "Someone"). */
export function displayNameOnly(email: string | null | undefined): string {
  if (!email) return "Someone";
  if (email === "link") return "Guest (link)";
  const u = getUser(email);
  return u?.name?.trim() || "Someone";
}

const live = (r: TreeRow): boolean => !r.trashedAt && !r.tags.includes(TRASH_TAG);
const leaf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Path → live row index for one vault, cached per projection version (rebuilt only when the tree changed). */
const pathIndexCache = new Map<string, { version: number; byPath: Map<string, TreeRow> }>();
async function pathIndex(entry: VaultEntry): Promise<Map<string, TreeRow>> {
  const tree = await ensureTree(entry);
  const hit = pathIndexCache.get(entry.id);
  if (hit && hit.version === tree.version) return hit.byPath;
  const byPath = new Map<string, TreeRow>();
  for (const r of tree.rows()) if (r.path && live(r)) byPath.set(r.path, r);
  pathIndexCache.set(entry.id, { version: tree.version, byPath });
  return byPath;
}

export interface AncestorPage {
  id: string;
  path: string;
  title: string;
}

/** The existing (live) ancestor pages of `path`, NEAREST FIRST. */
export async function ancestorPages(entry: VaultEntry, path: string | null | undefined): Promise<AncestorPage[]> {
  if (!path || !path.includes("/")) return [];
  const byPath = await pathIndex(entry);
  const out: AncestorPage[] = [];
  let p = path;
  while (p.includes("/")) {
    p = p.slice(0, p.lastIndexOf("/"));
    const row = byPath.get(p);
    if (row) out.push({ id: row.id, path: p, title: leaf(p) });
  }
  return out;
}

export interface InheritedPerson extends PersonView {
  level: Level;
  caps: Cap[];
  customPermissions: boolean;
  from: AncestorPage;
}

/**
 * People whose access to the page at `path` is INHERITED from a shared ancestor
 * page (a `page` grant on it), resolved like `effectiveCaps` does: per person, the
 * nearest ancestor that carries a page grant for them. People with a page grant
 * on the note ITSELF are excluded (their own grant is the nearest anchor; it is
 * listed with the page's people).
 */
export async function inheritedPeople(entry: VaultEntry, noteId: string, path: string | null | undefined, ancestors?: AncestorPage[]): Promise<InheritedPerson[]> {
  const chain = ancestors ?? (await ancestorPages(entry, path));
  const own = new Set(grantsForResource("page", noteId, entry.id).filter((g) => g.subject_type === "user").map((g) => g.subject));
  const seen = new Set<string>(own);
  const out: InheritedPerson[] = [];
  for (const a of chain) {
    for (const g of grantsForResource("page", a.id, entry.id)) {
      if (g.subject_type !== "user" || seen.has(g.subject)) continue;
      seen.add(g.subject);
      out.push({ ...personView(g.subject), level: g.level, caps: [...grantCapsList(g)], customPermissions: !!g.caps?.length, from: a });
    }
  }
  return out;
}

export const grantCapsList = (g: Grant): Cap[] => [...(g.caps?.length ? g.caps : expandLevel(g.level))];

/** The live descendants of `path` (strict), for anti-escalation and move previews. */
export async function descendantRows(entry: VaultEntry, path: string): Promise<TreeRow[]> {
  const tree = await ensureTree(entry);
  return tree.rows().filter((r) => live(r) && !!r.path && r.path.startsWith(`${path}/`));
}

/** What history shows for one stored state: who produced it, by kind. */
export interface VersionWriter {
  kind: "person" | "guest" | "agent" | "suggestion" | "accepted-suggestion" | "unknown";
  /** Display name — only for signed-in viewers; null when unknown. */
  name: string | null;
  /** The viewer produced it. */
  self: boolean;
}

/** Server-owned attribution keys: never accepted from, never served to, a non-owner. */
export const CHANGE_KEY = "prism_last_change";
export const WRITER_META_KEYS = [WRITER_KEY, WRITER_AT_KEY, CHANGE_KEY] as const;
export type ChangeKind = "edit" | "suggestion" | "agent" | "accepted-suggestion";

/**
 * The KIND of the stamped write, stored as `<kind>@<prism_last_write_at>`. Binding
 * it to the stamp's own time means a later stamp by a path that does not record a
 * kind (property writes, imports) never inherits a stale "agent"/"suggestion".
 */
export const changeValue = (kind: ChangeKind, at: string): string => `${kind}@${at}`;
export function changeKindOf(metadata: Record<string, unknown> | null | undefined): ChangeKind | null {
  const v = metadata?.[CHANGE_KEY];
  const at = metadata?.[WRITER_AT_KEY];
  if (typeof v !== "string" || typeof at !== "string") return null;
  const i = v.indexOf("@");
  if (i < 0 || v.slice(i + 1) !== at) return null;
  const k = v.slice(0, i);
  return k === "edit" || k === "suggestion" || k === "agent" || k === "accepted-suggestion" ? k : null;
}

/** A complete server stamp for `email` ("link" for a capability guest) and a change kind. */
export function writerStamp(writer: string, kind: ChangeKind): Record<string, string> {
  const at = new Date().toISOString();
  return { [WRITER_KEY]: writer === "link" ? "link" : writerIdFor(writer), [WRITER_AT_KEY]: at, [CHANGE_KEY]: changeValue(kind, at) };
}

/** `metadata` without the attribution keys (same object when none present). */
export function stripWriterMeta<T extends Record<string, unknown> | null | undefined>(metadata: T): T {
  if (!metadata || typeof metadata !== "object" || !WRITER_META_KEYS.some((k) => k in metadata)) return metadata;
  const out: Record<string, unknown> = { ...metadata };
  for (const k of WRITER_META_KEYS) delete out[k];
  return out as T;
}

/**
 * Derive the writer of a stored state from its writer stamp (writer-stamp.ts: an
 * OPAQUE subject id, never an email) and, when the vault reports it, the write
 * channel (`via: "mcp"` = an agent). Names are resolved only for a signed-in
 * `viewer`; `names` = `writerNames()` for the request. `updatedAt` (the CURRENT
 * note only) lets a stale stamp — something else wrote later — read as unknown.
 */
export function versionWriter(
  metadata: Record<string, unknown> | null | undefined,
  via: unknown,
  viewer: string | null,
  names?: Map<string, string>,
  updatedAt?: string | null,
): VersionWriter {
  const stamp = typeof metadata?.[WRITER_KEY] === "string" ? (metadata[WRITER_KEY] as string) : null;
  if (!stamp) return via === "mcp" ? { kind: "agent", name: null, self: false } : { kind: "unknown", name: null, self: false };
  const map = names ?? writerNames();
  if (updatedAt !== undefined && resolveWriter(metadata, updatedAt, map) === null && stamp !== "link") {
    // Stale (written again without a stamp) or an unknown account.
    const at = Date.parse(String(metadata?.[WRITER_AT_KEY] ?? ""));
    const up = Date.parse(updatedAt ?? "");
    if (Number.isFinite(at) && Number.isFinite(up) && up - at > 10_000) return { kind: "unknown", name: null, self: false };
  }
  const self = !!viewer && stamp !== "link" && stamp === writerIdFor(viewer);
  // writerNames() falls back to the EMAIL for an account without a display name;
  // history never shows an email to another viewer, so that reads as unnamed.
  const named = map.get(stamp) ?? null;
  const name = !viewer ? null : stamp === "link" ? "Guest (link)" : named && (self || !named.includes("@")) ? named : null;
  const change = changeKindOf(metadata);
  if (change === "agent") return { kind: "agent", name, self };
  if (change === "accepted-suggestion") return { kind: "accepted-suggestion", name, self };
  if (change === "suggestion") return { kind: "suggestion", name, self };
  if (stamp === "link") return { kind: "guest", name, self: false };
  return { kind: "person", name, self };
}

/** A version row as a non-owner may see it: no vault provenance, no identity or attribution keys. */
export function redactVersionForViewer<T extends { actor?: unknown; via?: unknown; metadata?: Record<string, unknown> | null }>(
  row: T,
  viewer: string | null,
  names?: Map<string, string>,
): Omit<T, "actor" | "via"> & { writer: VersionWriter } {
  const { actor: _a, via, ...rest } = row;
  const writer = versionWriter(row.metadata ?? null, via, viewer, names);
  let metadata = row.metadata;
  if (metadata) {
    const m: Record<string, unknown> = { ...stripWriterMeta(metadata) };
    delete m.prism_trashed_by;
    // A link guest gets no identity keys at all (writer-stamp.ts stripIdentity).
    metadata = viewer ? m : stripIdentity(m);
  }
  return { ...(rest as Omit<T, "actor" | "via">), ...(metadata !== undefined ? { metadata } : {}), writer } as Omit<T, "actor" | "via"> & { writer: VersionWriter };
}
