/**
 * POST /api/notes/:id/duplicate — "Duplicate" with sub-pages (NP-PG-18).
 *
 *   body  {requestId, withSubpages?=true, confirmShared?}
 *   200   {ok, id, path, title, created, skipped, rows, droppedTags, privateKept,
 *          unlinked, files:{copied, failed}, filesPending:[copyId…], audience}
 *   207   {error:"partial_duplicate", id, path, created, remaining, failed:{reason}, …}
 *         — call again with the SAME requestId to finish, or trash `id` to undo
 *   413   {error:"too_large", notes|bytes, limit}  — counted BEFORE anything is written
 *   409   {error:"confirm_shared", audience}       — see AUDIENCE
 *
 * The copy lands BESIDE the source ("<Title> (copy)", made unique) and every
 * descendant by path is re-created under it with the same relative path and order.
 *
 * WHO. A signed-in person (session / device token). Links and anon → 401; the
 * Prism MCP and the loopback owner token → 403. CSRF guard, per-account rate limit,
 * strict note id (an alias that resolves to another id is a 404).
 *
 * SOURCE. The caller must VIEW the page (unviewable = missing = trashed → 404).
 * System notes are never duplicated (403, everyone — a copied skill note would be a
 * second scheduled skill, a copied governance record is unsigned); ingest-owned
 * notes (`protectionReason`) only by an admin, as before this route existed.
 * A DESCENDANT is copied only when it is live, viewable, not a system / (non-admin)
 * ingest note, and — for a non-admin — a page they could create at its new path.
 * Everything else is left out and only COUNTED (`skipped`): no name, no id.
 * Rows of a database page inside the subtree (descendants carrying every source tag
 * of that database) are not copied (`rows`): the copy shows the same rows by tag.
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
 * (`templateKeepsKey` + the ingest-key rule): never identity, lock, trash, writer
 * stamps or ingest keys. Creator = the duplicator. A PRIVATE page's copy is private
 * to the duplicator. Sub-pages keep their `prism_order`; the root does not.
 *
 * AUDIENCE. The copy sits beside its source, so whoever a page share or tag reaches
 * there could already read the source — except private pages, which stay private.
 * When the destination lies under a shared page AND the subtree holds private pages,
 * the caller confirms first (`confirmShared: true`), like an import under a share.
 *
 * NOT TRANSACTIONAL. Copies are written in path order (root first). A failure
 * midway answers 207; the journal (`page_duplicates`) and each copy's
 * `metadata.prism_client_op` make a retry with the same `requestId` ADOPT what
 * exists instead of creating it twice. Trashing the root copy undoes all of it.
 *
 * FILES. Each copy gets its own attachments through `copyNoteAttachments` (the one
 * implementation behind `POST /notes/:id/attachments/copy`), within a time budget;
 * copies it did not finish are listed in `filesPending` and the client continues
 * with that route per page.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, randomBytes } from "node:crypto";
import { db, resolveVaultEntry, grantsForResource } from "../db";
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
import { ingestKeyChanged } from "../ingest-keys";
import { createCapsAt, writerStamp } from "../sharing";
import { placementRefusal, exportedLocation, publishedTag, sharedAncestor, pathKey } from "../pages";
import { copyNoteAttachments } from "./attachments";
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
}
const defaults = (): DuplicateConfig => ({
  maxNotes: Number(process.env.DUPLICATE_MAX_NOTES ?? 500),
  maxBytes: Number(process.env.DUPLICATE_MAX_BYTES ?? 50 * 1024 * 1024),
  perMinute: Number(process.env.DUPLICATE_PER_MINUTE ?? 20),
  filesBudgetMs: Number(process.env.DUPLICATE_FILES_BUDGET_MS ?? 15_000),
});
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
interface CopyEntry { id: string; stamp: string | null; linked: boolean }
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
  inFlight.clear();
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

/** Pages open in the live editor hold typing the vault has not seen: store them first (best-effort, bounded). */
async function flushLive(entry: VaultEntry, ids: string[]): Promise<boolean> {
  let flushed = false;
  try {
    const collab = await import("../collab");
    if (!collab.hocuspocus.documents.size) return false;
    for (const id of ids.filter((x) => collab.isDocLive(entry.id, x)).slice(0, 25)) {
      await collab.flushLiveDoc(entry.id, id);
      flushed = true;
    }
  } catch {
    /* collab unavailable, or a store that did not land: the copy is made from what the vault holds */
  }
  return flushed;
}

/** The copy's metadata, key by key. */
function copyMetadata(actor: User, vaultId: string, source: Note, tags: string[], opts: { title?: string; keepOrder: boolean; op: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keep = (k: string, v: unknown) => templateKeepsKey(k, v) && !ingestKeyChanged(k, v, undefined);
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
  if (isPrivate(source) || (!isAdmin(actor) && tags.includes(TEMPLATE_TAG))) out.prism_visibility = "private";
  out.prism_creator = actor.email;
  out[CLIENT_OP] = opts.op;
  Object.assign(out, writerStamp(actor.email, "edit"));
  return out;
}

const inFlight = new Set<string>();
const opFor = (requestId: string, sourceId: string): string => `${requestId}:${createHash("sha256").update(`${requestId}\u0000${sourceId}`).digest("hex").slice(0, 16)}`;
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

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
    if (retry !== null) { c.header("Retry-After", String(retry)); return c.json({ error: "rate_limited", retryAfter: retry }, 429); }
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
    const canView = (n: Pick<Note, "id" | "tags" | "metadata"> & { path?: string | null }) => admin || capsFor(actor, refOf(n)).has("view");
    if (!canView(root) || isTrashed(root)) return c.json(NOT_FOUND, 404);
    if (!root.path) return c.json({ error: "bad_request", reason: "This page has no location to copy beside." }, 400);
    const system = systemNoteReason(root);
    if (system) return c.json({ error: "protected", reason: "This is a system note, so it can’t be duplicated." }, 403);
    if (!admin && protectionReason(root)) return c.json({ error: "protected", reason: "This page is kept in sync by an integration, so it can’t be duplicated here." }, 403);
    const from = root.path;

    const who = actor.email.toLowerCase();
    const flightKey = `${entry.id}\u0000${who}\u0000${requestId}`;
    if (inFlight.has(flightKey)) return c.json({ error: "busy", reason: "This duplicate is still running." }, 409);
    inFlight.add(flightKey);
    try {
      let job = getJob(entry.id, who, requestId);
      if (job && (job.source_id !== root.id || !!job.with_subpages !== withSubpages)) return c.json({ error: "request_mismatch", reason: "That requestId was used for another duplicate." }, 422);

      // ── the subtree: what is copied, what is only counted ──────────────────
      let lean: Note[] = [];
      if (withSubpages) {
        try {
          lean = (await vc.listNotes({ pathPrefix: from, includeMetadata: [...TREE_META_KEYS, "prism_database"] })).filter((n) => isUnder(n.path, from));
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
      const eligible = (n: Note): "copy" | "skip" | "row" | "gone" => {
        if (isTrashed(n) || !n.path || !isUnder(n.path, from)) return "gone";
        if (!canView(n)) return "skip";
        if (systemNoteReason(n) || (!admin && protectionReason(n))) return "skip";
        return isRow(n) ? "row" : "copy";
      };
      const candidates: Note[] = [];
      for (const n of lean) {
        const what = eligible(n);
        if (what === "copy") candidates.push(n);
        else if (what === "skip") skipped++;
        else if (what === "row") rows++;
      }
      // Dry count first: nothing is read in full, nothing written, past the limit.
      if (candidates.length + 1 > cfg.maxNotes) return c.json({ error: "too_large", reason: `That’s ${candidates.length + 1} pages — more than can be duplicated at once (${cfg.maxNotes}).`, notes: candidates.length + 1, limit: cfg.maxNotes }, 413);

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
        let tree;
        try { tree = await ensureTree(entry); } catch { return c.json({ error: "vault_unreachable" }, 502); }
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
      if (!admin) {
        if (!(await mayCreate(actor, target, rootTags.tags))) return c.json({ error: "forbidden", reason: "You can’t add pages here." }, 403);
        const placed = await placementRefusal(entry, target, { actor, tags: rootTags.tags, ...(job?.copies[root.id] ? { exceptId: job.copies[root.id]!.id } : {}) });
        if ("status" in placed) return c.json(placed.body, placed.status);
      }

      // ── read every source in full (bytes are counted before any write) ─────
      if (await flushLive(entry, [root.id, ...candidates.map((n) => n.id)])) {
        try {
          const fresh = await vc.getNote(root.id);
          // Only the BODY is taken from the re-read: every check above was made on `root`.
          if (fresh.id === root.id && fresh.path === root.path) root = { ...root, content: fresh.content, updatedAt: fresh.updatedAt };
        } catch { /* keep the copy read above */ }
      }
      const sources = new Map<string, Note>([[root.id, root]]);
      let bytes = Buffer.byteLength(root.content ?? "", "utf8");
      let unreadable = false;
      await pool(candidates, 4, async (n) => {
        if (unreadable || bytes > cfg.maxBytes) return;
        try {
          const full = await vc.getNote(n.id);
          // Judged again on the fresh note: it may have been moved, trashed or made private meanwhile.
          const what = full.id === n.id ? eligible(full) : "gone";
          if (what === "skip") skipped++;
          else if (what === "row") rows++;
          if (what !== "copy") return;
          bytes += Buffer.byteLength(full.content ?? "", "utf8");
          sources.set(full.id, full);
        } catch (e) {
          if (!(e instanceof VaultError && e.status === 404)) unreadable = true;
        }
      });
      if (bytes > cfg.maxBytes) return c.json({ error: "too_large", reason: "These pages are too large to duplicate at once.", bytes, limit: cfg.maxBytes }, 413);
      if (unreadable) return c.json({ error: "vault_unreachable" }, 502);

      // ── the plan: root first, then by path; each with its tags and place ───
      interface Item { source: Note; path: string; tags: string[]; isRoot: boolean; op: string }
      const plan: Item[] = [{ source: root, path: target, tags: rootTags.tags, isRoot: true, op: opFor(requestId, root.id) }];
      let droppedTags = rootTags.dropped;
      for (const candidate of candidates) {
        const source = sources.get(candidate.id);
        if (!source?.path) continue;
        const path = target + source.path.slice(from.length);
        const t = copyTags(actor, entry.id, source.tags);
        if (!admin && (normalizePagePath(path) !== path || isProtectedPath(path) || exportedLocation(entry.id, path) || !(await mayCreate(actor, path, t.tags)))) {
          skipped++;
          continue;
        }
        droppedTags += t.dropped;
        plan.push({ source, path, tags: t.tags, isRoot: false, op: opFor(requestId, source.id) });
      }
      const privateKept = plan.filter((p) => isPrivate(p.source)).length;
      let shared = false;
      try { shared = !!(await sharedAncestor(entry, target)); } catch { /* the tree is unavailable: treated as not shared, private pages stay private either way */ }
      const audience = { sharedPage: shared, private: privateKept };
      if (shared && privateKept > 0 && body.confirmShared !== true) {
        return c.json({ error: "confirm_shared", reason: "This copy lands inside a page that is shared with other people. The private pages in it stay private to you; the rest is shared like the original.", audience }, 409);
      }

      // ── what already exists of this request (a retry adopts it) ────────────
      let existing: Note[];
      try {
        existing = (await vc.listNotes({ pathPrefix: target, includeMetadata: [...TREE_META_KEYS, CLIENT_OP] })).filter((n) => n.path === target || isUnder(n.path, target));
      } catch {
        return c.json({ error: "vault_unreachable" }, 502);
      }
      const present = new Map(existing.map((n) => [n.id, n]));
      const byOp = new Map(existing.filter((n) => typeof n.metadata?.[CLIENT_OP] === "string").map((n) => [n.metadata![CLIENT_OP] as string, n]));
      const firstRun = !job;
      job ??= { source_id: root.id, with_subpages: withSubpages ? 1 : 0, to_path: target, copies: {}, status: "running" };
      for (const [src, copy] of Object.entries(job.copies)) if (!present.has(copy.id)) delete job.copies[src];
      for (const item of plan) {
        const mine = byOp.get(item.op);
        if (mine && !job.copies[item.source.id]) job.copies[item.source.id] = { id: mine.id, stamp: mine.updatedAt ?? mine.createdAt ?? null, linked: false };
      }
      job.status = "running";
      putJob(entry.id, who, requestId, job);
      db.prepare("DELETE FROM page_duplicates WHERE created_at < ?").run(Date.now() - JOURNAL_DAYS * 86_400_000);

      // ── links: ids of copies (known as they are made), paths (known now) ───
      const inPlan = new Set(plan.map((p) => p.source.id));
      const newPath = new Map(plan.map((p) => [pathKey(p.source.path!), p.path]));
      const seeds = new Map<string, string>();
      /** The copy's body; `pending` = it names a page of this copy that does not exist yet. */
      const bodyOf = (item: Item): { content: string; pending: boolean; touched: boolean } => {
        let pending = false;
        let touched = false;
        let n = 0;
        const seed = seeds.get(item.source.id) ?? randomBytes(6).toString("hex");
        seeds.set(item.source.id, seed);
        const content = copyBodyOf(
          { content: item.source.content ?? "", path: item.source.path, metadata: item.source.metadata, tags: item.source.tags },
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

      // ── pass 1: create, in path order ──────────────────────────────────────
      let createdNow = 0;
      let failed: { reason: string } | null = null;
      let failure: unknown = null;
      const relink = new Set<string>();
      for (const item of plan) {
        const known = job.copies[item.source.id];
        if (known) {
          if (!known.linked) relink.add(item.source.id);
          continue;
        }
        const { content, pending } = bodyOf(item);
        const metadata = copyMetadata(actor, entry.id, item.source, item.tags, { ...(item.isRoot ? { title: name } : {}), keepOrder: !item.isRoot, op: item.op });
        let created: Note | null = null;
        try {
          created = await vc.createNote({ content, path: item.path, tags: item.tags, metadata, ifExists: "error" });
        } catch (e) {
          // No answer / a server error: the create may have landed. Adopt it only if the
          // note at that path carries THIS request's op id; never anything else.
          if (!(e instanceof VaultConflictError)) {
            try {
              const at = await vc.getNote(item.path);
              if (at.path === item.path && at.metadata?.[CLIENT_OP] === item.op) created = at;
            } catch { /* still unknown: reported as failed, a retry looks again */ }
          }
          if (!created) { failed = { reason: failReason(e) }; failure = e; break; }
        }
        createdNow++;
        job.copies[item.source.id] = { id: created.id, stamp: created.updatedAt ?? created.createdAt ?? null, linked: !pending };
        if (pending) relink.add(item.source.id);
        putJob(entry.id, who, requestId, job);
        treeUpsertNote(entry, created);
      }
      if (createdNow) opts.onWrite?.();
      const copyRoot = job.copies[root.id];
      const made = plan.filter((p) => job!.copies[p.source.id]).length;
      const audit = (status: "ok" | "failed", error: string | null) =>
        recordAction({ actorEmail: actor.email, via, origin: "human", action: "pages.duplicate", vaultId: entry.id, target: { sourceId: root.id, copyId: copyRoot?.id ?? null, pages: made, planned: plan.length, skipped, rows, droppedTags, privateKept }, idempotencyKey: requestId, status, error });

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
      if (!failed) {
        for (const item of plan) {
          if (!relink.has(item.source.id)) continue;
          const copy = job.copies[item.source.id]!;
          const { content, touched } = bodyOf(item);
          if (touched && copy.stamp) {
            try {
              const saved = await vc.updateNote(copy.id, { content, ifUpdatedAt: copy.stamp });
              copy.stamp = saved.updatedAt ?? copy.stamp;
              treeUpsertNote(entry, saved);
            } catch (e) {
              // The copy was edited since it was made: its links are left as they are.
              if (e instanceof VaultConflictError) unlinked++;
              else { failed = { reason: failReason(e) }; break; }
            }
          }
          copy.linked = true;
        }
        putJob(entry.id, who, requestId, job);
      }

      if (failed) {
        job.status = "partial";
        putJob(entry.id, who, requestId, job);
        audit("failed", failed.reason);
        return c.json(
          { error: "partial_duplicate", reason: "Some pages were copied and some were not. Finish the copy, or undo it.", requestId, id: copyRoot!.id, path: target, title: name, created: made, remaining: plan.length - made, failed, skipped, rows, droppedTags, privateKept, audience },
          207,
        );
      }

      // ── files: each copy gets its own, within this request's budget ────────
      const files = { copied: 0, failed: 0 };
      const filesPending: string[] = [];
      const started = Date.now();
      for (const item of plan) {
        if (!(item.source.content ?? "").includes("/api/attachments/") && !JSON.stringify(item.source.metadata ?? {}).includes("/api/attachments/")) continue;
        const copy = job.copies[item.source.id]!;
        if (Date.now() - started > cfg.filesBudgetMs) { filesPending.push(copy.id); continue; }
        try {
          const fresh = await vc.getNote(copy.id);
          const out = await copyNoteAttachments(entry, actor, fresh);
          if ("error" in out) { filesPending.push(copy.id); continue; }
          files.copied += out.copied;
          files.failed += out.failed;
          if (out.more) filesPending.push(copy.id);
        } catch {
          filesPending.push(copy.id);
        }
      }
      if (files.copied) opts.onWrite?.();

      job.status = "done";
      putJob(entry.id, who, requestId, job);
      audit("ok", null);
      return c.json({ ok: true, id: copyRoot!.id, path: target, title: name, created: made, skipped, rows, droppedTags, privateKept, unlinked, files, filesPending, audience });
    } finally {
      inFlight.delete(flightKey);
    }
  });

  return r;
}
