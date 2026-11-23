/**
 * Migration (a): remove the empty-string placeholders importers wrote where a
 * LIST belongs (`organizations: ""`, `projects: ""`, …). An empty string carries
 * no information and fails the `array` schema on every such note.
 *
 * Dry run (default): counts per tag.field + up to 10 note ids/paths. No bodies
 * are read at all — only the listed metadata keys.
 * --apply --backup-confirmed: per note, a FRESH read, then ONE compare-and-set
 * PATCH (`if_updated_at`, never force) that removes the keys (`null` in a
 * merge-patch) — or writes `[]` with `--mode empty-list`. Every write logs the
 * replaced values to the undo log; `undo.ts` puts them back.
 * `--include-scalars` also removes `""` from the non-list fields listed below
 * (`writing.published`, the `confidence` labels).
 *
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/migrate-empty-lists.ts \
 *     --vault-url http://127.0.0.1:1940 --production [--only person] [--limit 50]
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

/** tag → list fields that must not hold "" (from qa/vault-health.md §2). */
export const LIST_FIELDS: Record<string, string[]> = {
  person: ["organizations", "aliases", "projects"],
  project: ["aliases", "collaborators"],
  organization: ["aliases", "people", "projects"],
  briefing: ["projects", "people"],
  meeting: ["projects"],
  concept: ["aliases", "related"],
};
/** Non-list fields where "" is also a placeholder (only with --include-scalars; always removed). */
export const SCALAR_FIELDS: Record<string, string[]> = {
  writing: ["published"],
  person: ["confidence"],
  project: ["confidence"],
  organization: ["confidence"],
  concept: ["confidence"],
};

const SCRIPT = "empty-lists";

export interface Found {
  note: VaultNote;
  fields: { tag: string; field: string; list: boolean }[];
}

/** Which configured fields of THIS note hold exactly "". */
export function emptyFieldsOf(note: VaultNote, includeScalars: boolean, only: string[] = []): Found["fields"] {
  const out: Found["fields"] = [];
  const seen = new Set<string>();
  const tags = note.tags ?? [];
  if (tags.some((t) => INGEST_OWNED_TAGS.includes(t))) return out;
  for (const tag of tags) {
    if (only.length && !only.includes(tag)) continue;
    const groups: [string[], boolean][] = [[LIST_FIELDS[tag] ?? [], true]];
    if (includeScalars) groups.push([SCALAR_FIELDS[tag] ?? [], false]);
    for (const [fields, list] of groups)
      for (const field of fields) {
        if (seen.has(field)) continue;
        if (Object.hasOwn(note.metadata ?? {}, field) && note.metadata![field] === "") {
          seen.add(field);
          out.push({ tag, field, list });
        }
      }
  }
  return out;
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "only", "limit", "rate", "mode", "undo-log"]);
  for (const f of args.flags) if (!["apply", "backup-confirmed", "production", "include-scalars"].includes(f)) throw new UsageError(`unknown flag --${f}`);
  const url = guardTarget(args.get("vault-url"), args.has("production"));
  const apply = writeMode(args);
  const mode = args.get("mode") ?? "remove";
  if (mode !== "remove" && mode !== "empty-list") throw new UsageError("--mode is remove or empty-list");
  const limit = args.get("limit") ? Number(args.get("limit")) : Infinity;
  if (!(limit > 0)) throw new UsageError("--limit must be a positive number");
  const includeScalars = args.has("include-scalars");
  const only = args.all("only");
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));

  // One lean listing per tag: only the keys we look at.
  const tags = [...new Set([...Object.keys(LIST_FIELDS), ...(includeScalars ? Object.keys(SCALAR_FIELDS) : [])])].filter((t) => !only.length || only.includes(t));
  const notes = new Map<string, VaultNote>();
  for (const tag of tags) {
    const keys = [...(LIST_FIELDS[tag] ?? []), ...(includeScalars ? SCALAR_FIELDS[tag] ?? [] : [])];
    for (const n of await vault.listNotes({ tag, includeMetadata: keys })) {
      const prev = notes.get(n.id);
      // A note listed under two tags: merge the key subsets we asked for.
      notes.set(n.id, prev ? { ...n, metadata: { ...(prev.metadata ?? {}), ...(n.metadata ?? {}) } } : n);
    }
  }
  const found: Found[] = [];
  for (const note of notes.values()) {
    if (!isLive(note)) continue;
    const fields = emptyFieldsOf(note, includeScalars, only);
    if (fields.length) found.push({ note, fields });
  }
  const perField = new Map<string, number>();
  for (const f of found) for (const x of f.fields) perField.set(`${x.tag}.${x.field}`, (perField.get(`${x.tag}.${x.field}`) ?? 0) + 1);
  ctx.log(`${apply ? "APPLY" : "DRY RUN"} — ${found.length} note(s) hold "" placeholders (mode: ${mode})`);
  for (const [k, n] of [...perField].sort()) ctx.log(`  ${k}: ${n}`);
  for (const f of sample(found)) ctx.log(`  e.g. ${ref(f.note)} [${f.fields.map((x) => x.field).join(", ")}]`);
  if (!apply) return 0;

  const log = new UndoLog(ctx, undoLogPath(args, ctx, SCRIPT));
  const throttle = new Throttle(ctx, rateOf(args));
  let written = 0;
  let conflicts = 0;
  let skipped = 0;
  let failed = 0;
  for (const f of found.slice(0, limit)) {
    await throttle.wait();
    try {
      const fresh = await vault.getNote(f.note.id);
      if (!fresh || !isLive(fresh) || !fresh.updatedAt) {
        skipped++;
        continue;
      }
      const now = emptyFieldsOf(fresh, includeScalars, only);
      if (!now.length) {
        skipped++;
        continue;
      }
      const patch: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const x of now) {
        before[x.field] = "";
        patch[x.field] = x.list && mode === "empty-list" ? [] : null;
      }
      const after = await vault.patch(fresh.id, { metadata: patch }, fresh.updatedAt);
      log.append({ kind: "vault-patch", script: SCRIPT, at: ctx.now().toISOString(), id: fresh.id, path: fresh.path ?? null, afterUpdatedAt: after.updatedAt ?? "", before: { metadata: before } });
      written++;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) conflicts++;
      else {
        failed++;
        ctx.log(`  failed ${f.note.id}: ${scrub(e instanceof Error ? e.message : String(e))}`);
      }
    }
  }
  ctx.log(`done: ${written} written, ${conflicts} conflict(s) (changed meanwhile — re-run), ${skipped} already clean, ${failed} failed. Undo log: ${log.path}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli(main);
