/**
 * Migration (b): repoint wikilinks to a project FOLDER (`[[vault/projects/<slug>]]`,
 * which resolves to nothing) at the project's note (`vault/projects/<slug>/PROJECT`).
 *
 * A slug is repointed only when exactly ONE note answers for it:
 *   1. a note at `vault/projects/<slug>/PROJECT` (path match, case-insensitive), else
 *   2. the only note tagged `project` under `vault/projects/<slug>/`.
 * Zero or several candidates → the slug is LISTED, never guessed. A slug whose
 * folder path is itself a note is not broken and is left alone. Alias and heading
 * parts survive (`[[vault/projects/x|X]]` → `[[vault/projects/x/PROJECT|X]]`).
 *
 * Reads bodies (that is where the links are) but never prints them: the dry run
 * shows counts, slug → target, and up to 10 note ids/paths.
 * --apply --backup-confirmed: fresh read → rewrite → ONE compare-and-set PATCH per
 * note (content and the changed metadata keys). The undo log keeps the replaced
 * body + values (it therefore holds note text: it is written 0600; keep it with the backup).
 * Ingest-owned notes (email, message threads) are never touched.
 *
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/migrate-project-folder-links.ts \
 *     --vault-url http://127.0.0.1:1940 --production [--tag meeting]… [--path-prefix vault/projects/]…
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
  type VaultNote,
} from "./lib";

const SCRIPT = "project-folder-links";
export const DEFAULT_TAGS = ["meeting", "transcript", "task", "person", "project", "organization", "spec", "briefing", "report", "agent-insight"];
export const DEFAULT_PREFIXES = ["vault/projects/", "vault/tasks/"];
const PROJECTS = "vault/projects/";

export type Resolution = { kind: "target"; path: string } | { kind: "exists" } | { kind: "unresolved"; reason: string };

/** slug (lower-case) → what a folder link to it should become. */
export function buildResolver(projectTree: VaultNote[]): (slug: string) => Resolution {
  const byPath = new Map<string, VaultNote>();
  for (const n of projectTree) if (n.path && isLive(n)) byPath.set(n.path.toLowerCase(), n);
  return (slug: string): Resolution => {
    const s = slug.toLowerCase();
    if (byPath.has(`${PROJECTS}${s}`)) return { kind: "exists" };
    const project = byPath.get(`${PROJECTS}${s}/project`);
    if (project?.path) return { kind: "target", path: project.path };
    const tagged = [...byPath.values()].filter((n) => n.path!.toLowerCase().startsWith(`${PROJECTS}${s}/`) && (n.tags ?? []).includes("project"));
    if (tagged.length === 1) return { kind: "target", path: tagged[0]!.path! };
    return { kind: "unresolved", reason: tagged.length ? `${tagged.length} project notes in the folder` : "no project note in the folder" };
  };
}

export interface Hit {
  slug: string;
  resolution: Resolution;
}

/**
 * Rewrite folder wikilinks in one string. A single linear scan (no regex over
 * note text): `[[` … `]]` on one line, target = text before `|` or `#`.
 */
export function rewriteText(text: string, resolve: (slug: string) => Resolution, hits: Hit[]): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("[[", i);
    if (open === -1) break;
    const close = text.indexOf("]]", open + 2);
    if (close === -1) break;
    const inner = text.slice(open + 2, close);
    if (inner.includes("\n") || inner.includes("[[")) {
      out += text.slice(i, open + 2);
      i = open + 2;
      continue;
    }
    let cut = inner.length;
    for (const ch of ["|", "#"]) {
      const k = inner.indexOf(ch);
      if (k !== -1 && k < cut) cut = k;
    }
    const target = inner.slice(0, cut).trim().replace(/\/+$/, "").replace(/\.md$/i, "");
    const slug = folderSlug(target);
    out += text.slice(i, open);
    if (slug !== null) {
      const resolution = resolve(slug);
      hits.push({ slug, resolution });
      out += resolution.kind === "target" ? `[[${resolution.path}${inner.slice(cut)}]]` : `[[${inner}]]`;
    } else out += `[[${inner}]]`;
    i = close + 2;
  }
  return out + text.slice(i);
}

/** `vault/projects/<slug>` exactly (one segment after projects/), else null. */
function folderSlug(target: string): string | null {
  if (target.slice(0, PROJECTS.length).toLowerCase() !== PROJECTS) return null;
  const rest = target.slice(PROJECTS.length);
  if (!rest || rest.includes("/")) return null;
  return rest;
}

export interface Rewrite {
  content?: string;
  metadata: Record<string, unknown>;
  before: { content?: string; metadata: Record<string, unknown> };
  hits: Hit[];
}

/** Compute the rewrite of one note (content + top-level string / string[] metadata). */
export function rewriteNote(note: VaultNote, resolve: (slug: string) => Resolution): Rewrite {
  const hits: Hit[] = [];
  const res: Rewrite = { metadata: {}, before: { metadata: {} }, hits };
  if (typeof note.content === "string") {
    const next = rewriteText(note.content, resolve, hits);
    if (next !== note.content) {
      res.content = next;
      res.before.content = note.content;
    }
  }
  for (const [key, value] of Object.entries(note.metadata ?? {})) {
    if (key.startsWith("prism_")) continue;
    if (typeof value === "string") {
      const next = rewriteText(value, resolve, hits);
      if (next !== value) {
        res.metadata[key] = next;
        res.before.metadata[key] = value;
      }
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      const next = (value as string[]).map((v) => rewriteText(v, resolve, hits));
      if (next.some((v, k) => v !== value[k])) {
        res.metadata[key] = next;
        res.before.metadata[key] = value;
      }
    }
  }
  return res;
}

const changed = (r: Rewrite): boolean => r.content !== undefined || Object.keys(r.metadata).length > 0;

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "tag", "path-prefix", "limit", "rate", "undo-log"]);
  for (const f of args.flags) if (!["apply", "backup-confirmed", "production"].includes(f)) throw new UsageError(`unknown flag --${f}`);
  const url = guardTarget(args.get("vault-url"), args.has("production"));
  const apply = writeMode(args);
  const limit = args.get("limit") ? Number(args.get("limit")) : Infinity;
  if (!(limit > 0)) throw new UsageError("--limit must be a positive number");
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));

  const resolve = buildResolver(await vault.listNotes({ pathPrefix: PROJECTS, includeMetadata: ["prism_trashed_at"] }));
  const tags = args.all("tag").length ? args.all("tag") : DEFAULT_TAGS;
  const prefixes = args.all("path-prefix").length ? args.all("path-prefix") : DEFAULT_PREFIXES;
  const sources = new Map<string, VaultNote>();
  for (const tag of tags) for (const n of await vault.listNotes({ tag, includeContent: true })) sources.set(n.id, n);
  for (const pathPrefix of prefixes) for (const n of await vault.listNotes({ pathPrefix, includeContent: true })) sources.set(n.id, n);

  const plans: { note: VaultNote; rewrite: Rewrite }[] = [];
  const unresolved = new Map<string, { count: number; reason: string }>();
  const targets = new Map<string, { path: string; count: number }>();
  for (const note of sources.values()) {
    if (!isLive(note) || (note.tags ?? []).some((t) => INGEST_OWNED_TAGS.includes(t))) continue;
    const rewrite = rewriteNote(note, resolve);
    for (const h of rewrite.hits) {
      if (h.resolution.kind === "target") {
        const t = targets.get(h.slug) ?? { path: h.resolution.path, count: 0 };
        t.count++;
        targets.set(h.slug, t);
      } else if (h.resolution.kind === "unresolved") {
        const u = unresolved.get(h.slug) ?? { count: 0, reason: h.resolution.reason };
        u.count++;
        unresolved.set(h.slug, u);
      }
    }
    if (changed(rewrite)) plans.push({ note, rewrite });
  }
  ctx.log(`${apply ? "APPLY" : "DRY RUN"} — scanned ${sources.size} note(s); ${plans.length} carry folder links that resolve to exactly one project note`);
  for (const [slug, t] of [...targets].sort()) ctx.log(`  vault/projects/${slug} → ${t.path}  (${t.count} link(s))`);
  if (unresolved.size) {
    ctx.log(`  NOT repointed (listed for review, never guessed):`);
    for (const [slug, u] of [...unresolved].sort()) ctx.log(`    vault/projects/${slug}: ${u.count} link(s) — ${u.reason}`);
  }
  for (const p of sample(plans)) ctx.log(`  e.g. ${ref(p.note)}`);
  if (!apply) return 0;

  const log = new UndoLog(ctx, undoLogPath(args, ctx, SCRIPT));
  const throttle = new Throttle(ctx, rateOf(args));
  let written = 0;
  let conflicts = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of plans.slice(0, limit)) {
    await throttle.wait();
    try {
      const fresh = await vault.getNote(p.note.id);
      if (!fresh || !isLive(fresh) || !fresh.updatedAt) {
        skipped++;
        continue;
      }
      const r = rewriteNote(fresh, resolve);
      if (!changed(r)) {
        skipped++;
        continue;
      }
      const body: { content?: string; metadata?: Record<string, unknown> } = {};
      if (r.content !== undefined) body.content = r.content;
      if (Object.keys(r.metadata).length) body.metadata = r.metadata;
      const after = await vault.patch(fresh.id, body, fresh.updatedAt);
      log.append({ kind: "vault-patch", script: SCRIPT, at: ctx.now().toISOString(), id: fresh.id, path: fresh.path ?? null, afterUpdatedAt: after.updatedAt ?? "", before: r.before });
      written++;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) conflicts++;
      else {
        failed++;
        ctx.log(`  failed ${p.note.id}: ${scrub(e instanceof Error ? e.message : String(e))}`);
      }
    }
  }
  ctx.log(`done: ${written} written, ${conflicts} conflict(s) (changed meanwhile — re-run), ${skipped} unchanged, ${failed} failed. Undo log: ${log.path}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli(main);
