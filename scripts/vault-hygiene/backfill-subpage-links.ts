/**
 * Migration (g): backfill the parent → sub-page link for sub-page rows that existed
 * before the server wrote it.
 *
 * A sub-page row is stored in the PARENT's body as
 *   <div data-type="child-page" data-page-id="<note id>"></div>
 * Since PR #31 the Prism Server adds a `mentions` link from the parent to the sub-page
 * whenever such a row is ADDED (`linkChips` in apps/server/src/notifications.ts), which
 * is what puts the parent among the sub-page's backlinks and in the graph. Rows saved
 * before that have no link. This script adds exactly that link, and nothing else.
 *
 * For each live note whose body holds sub-page rows, a row is LINKED only when
 *   - its `data-page-id` is the id of a live note (not missing, not in the Trash),
 *   - it is not the parent itself, and
 *   - the parent has no `mentions` link to that note yet.
 * Rows that name a missing / trashed note are counted and left alone.
 *
 * Reads bodies (that is where the rows are) but never prints them: the dry run shows
 * counts and up to 10 note ids/paths.
 * --apply --backup-confirmed: fresh read (with links) → recompute → ONE links-only
 * compare-and-set PATCH per parent (`if_updated_at`, never `force`; no `content`, no
 * `metadata`). The undo log names the links added; `undo.ts` removes exactly those.
 * Ingest-owned notes (email, message threads) are never touched.
 *
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/backfill-subpage-links.ts \
 *     --vault-url http://127.0.0.1:1940 --production [--all] [--tag project]… [--path-prefix vault/projects/]… [--limit N]
 *
 * Without --all / --tag / --path-prefix only notes that have a live note under their own
 * path are read (one at a time) — a full-body listing of the vault is opt-in.
 */
import { pathToFileURL } from "node:url";
import {
  guardTarget,
  HttpError,
  INGEST_OWNED_TAGS,
  isLive,
  parseArgs,
  rateOf,
  readToken,
  ref,
  runCli,
  sample,
  scrub,
  Throttle,
  UndoLog,
  undoLogPath,
  UsageError,
  VaultApi,
  writeMode,
  type Ctx,
  type LinkInput,
  type VaultNote,
} from "./lib";

const SCRIPT = "subpage-links";
/** The relationship the server writes for a sub-page row (and for every mention chip). */
export const RELATIONSHIP = "mentions";
const MARKER = 'data-type="child-page"';
/** A note id as the server accepts it in a row (`MENTION_ID` in @prism/core/mentions). */
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Rows read per body — the server's own cap (`MAX_CHILD_PAGES`). */
const MAX_ROWS = 200;

/** The value of attribute `name` in one opening tag's text; null when absent. One linear scan. */
function attr(tag: string, name: string): string | null {
  let i = 0;
  while (i < tag.length) {
    const at = tag.indexOf(name, i);
    if (at === -1) return null;
    i = at + name.length;
    // A whole attribute name: preceded by whitespace, followed by `=`.
    const before = at === 0 ? " " : tag[at - 1]!;
    if (!/\s/.test(before) || tag[i] !== "=") continue;
    const q = tag[i + 1];
    if (q !== '"' && q !== "'") return null;
    const end = tag.indexOf(q, i + 2);
    return end === -1 ? null : tag.slice(i + 2, end);
  }
  return null;
}

/**
 * The page ids of the sub-page rows in a stored body, in document order, without
 * repeats. PURE and linear: a scan of `<div …>` opening tags (no regex over note text),
 * strict ids only — the same reading as the server's `extractChildPageIds`.
 */
export function childPageIds(html: string | null | undefined): string[] {
  const out: string[] = [];
  if (!html || html.indexOf(MARKER) === -1) return out;
  let i = 0;
  while (out.length < MAX_ROWS) {
    const at = html.indexOf("<div", i);
    if (at === -1) break;
    const end = html.indexOf(">", at);
    if (end === -1) break;
    i = end + 1;
    const tag = html.slice(at + 4, end);
    if (tag.length > 2000 || tag.indexOf("child-page") === -1) continue;
    if (attr(tag, "data-type") !== "child-page") continue;
    const id = attr(tag, "data-page-id");
    if (!id || !NOTE_ID.test(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export interface Plan {
  /** Sub-page ids to link (live, not the parent, not linked yet). */
  add: string[];
  /** Rows whose link already exists. */
  linked: number;
  /** Rows naming a note that is missing, in the Trash, or the parent itself. */
  dangling: number;
  rows: number;
}

/**
 * What one parent needs. `liveIds` = ids of every live note in the vault; `note.links`
 * must be the parent's hydrated links (a note read without links plans nothing).
 */
export function planNote(note: VaultNote, liveIds: ReadonlySet<string>): Plan {
  const ids = childPageIds(note.content);
  const plan: Plan = { add: [], linked: 0, dangling: 0, rows: ids.length };
  if (!ids.length || !Array.isArray(note.links)) return plan;
  const has = new Set<string>();
  for (const l of note.links) if (l.sourceId === note.id && l.relationship === RELATIONSHIP) has.add(l.targetId);
  for (const id of ids) {
    if (id === note.id || !liveIds.has(id)) plan.dangling++;
    else if (has.has(id)) plan.linked++;
    else plan.add.push(id);
  }
  return plan;
}

const eligible = (n: VaultNote): boolean => isLive(n) && !(n.tags ?? []).some((t) => INGEST_OWNED_TAGS.includes(t));

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "tag", "path-prefix", "limit", "rate", "undo-log"]);
  for (const f of args.flags) if (!["apply", "backup-confirmed", "production", "all"].includes(f)) throw new UsageError(`unknown flag --${f}`);
  const url = guardTarget(args.get("vault-url"), args.has("production"));
  const apply = writeMode(args);
  const limit = args.get("limit") ? Number(args.get("limit")) : Infinity;
  if (!(limit > 0)) throw new UsageError("--limit must be a positive number");
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));

  // Every live note id (lean: no bodies) — what a row's page id must be to be linked.
  const liveIds = new Set<string>();
  const lean = (await vault.listNotes({ includeMetadata: ["prism_trashed_at"] })).filter(isLive);
  for (const n of lean) liveIds.add(n.id);

  // The parents to read: the whole vault, or only the tags / folders named.
  const sources = new Map<string, VaultNote>();
  const scoped = args.all("tag").length + args.all("path-prefix").length > 0;
  if (!scoped && args.has("all")) for (const n of await vault.listNotes({ includeContent: true, includeLinks: true })) sources.set(n.id, n);
  else if (!scoped) {
    // Default: never one listing of every body (heavy on a production host). A sub-page is
    // created UNDER its parent's path, so only notes with a live note beneath their path can
    // hold rows worth linking; those are read one at a time. A parent whose sub-pages were all
    // moved away is missed — `--all` (or --tag / --path-prefix) reads further.
    const stem = (path: string) => path.replace(/\.md$/i, "");
    const dirs = new Set<string>();
    for (const n of lean) {
      const parts = (n.path ?? "").split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    for (const n of lean) {
      if (!n.path || !dirs.has(stem(n.path))) continue;
      const full = await vault.getNote(n.id, { includeLinks: true });
      if (full) sources.set(full.id, full);
    }
  }
  for (const tag of args.all("tag")) for (const n of await vault.listNotes({ tag, includeContent: true, includeLinks: true })) sources.set(n.id, n);
  for (const pathPrefix of args.all("path-prefix")) for (const n of await vault.listNotes({ pathPrefix, includeContent: true, includeLinks: true })) sources.set(n.id, n);

  const plans: { note: VaultNote; plan: Plan }[] = [];
  let parents = 0;
  let rows = 0;
  let linked = 0;
  let dangling = 0;
  let unread = 0;
  for (const note of sources.values()) {
    if (!eligible(note)) continue;
    if (childPageIds(note.content).length && !Array.isArray(note.links)) unread++; // a vault that did not return links: nothing is assumed missing
    const plan = planNote(note, liveIds);
    if (!plan.rows) continue;
    parents++;
    rows += plan.rows;
    linked += plan.linked;
    dangling += plan.dangling;
    if (plan.add.length) plans.push({ note, plan });
  }
  const missing = plans.reduce((n, p) => n + p.plan.add.length, 0);
  ctx.log(`${apply ? "APPLY" : "DRY RUN"} — scanned ${sources.size} note(s); ${parents} hold sub-page rows (${rows} row(s))`);
  ctx.log(`  ${linked} row(s) already linked; ${missing} link(s) to add on ${plans.length} note(s); ${dangling} row(s) name a missing or trashed page (left alone)`);
  if (unread) ctx.log(`  ${unread} note(s) came back without their links — not planned (is the vault older than include_links?)`);
  for (const p of sample(plans)) ctx.log(`  e.g. ${ref(p.note)} (+${p.plan.add.length})`);
  if (!apply) return 0;

  const log = new UndoLog(ctx, undoLogPath(args, ctx, SCRIPT));
  const throttle = new Throttle(ctx, rateOf(args));
  let written = 0;
  let links = 0;
  let conflicts = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of plans.slice(0, limit)) {
    await throttle.wait();
    try {
      const fresh = await vault.getNote(p.note.id, { includeLinks: true });
      if (!fresh || !eligible(fresh) || !fresh.updatedAt) {
        skipped++;
        continue;
      }
      // Recomputed on the fresh copy: a row removed meanwhile, or a link the server added, is not written.
      const add = planNote(fresh, liveIds).add;
      if (!add.length) {
        skipped++;
        continue;
      }
      const added: LinkInput[] = add.map((target) => ({ target, relationship: RELATIONSHIP }));
      const after = await vault.patchLinks(fresh.id, { add: added }, fresh.updatedAt);
      log.append({ kind: "vault-links", script: SCRIPT, at: ctx.now().toISOString(), id: fresh.id, path: fresh.path ?? null, afterUpdatedAt: after.updatedAt ?? "", added });
      written++;
      links += added.length;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) conflicts++;
      else {
        failed++;
        ctx.log(`  failed ${p.note.id}: ${scrub(e instanceof Error ? e.message : String(e))}`);
      }
    }
  }
  ctx.log(`done: ${links} link(s) added on ${written} note(s), ${conflicts} conflict(s) (changed meanwhile — re-run), ${skipped} unchanged, ${failed} failed. Undo log: ${log.path}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli(main);
