/**
 * Migration: copy the values of the fields `tag-schemas.json` renamed on 2026-10-20 into their
 * new names, so the notes read the way the new declarations describe them.
 *
 * Why the renames (docs/vault-schema-change.md, launch plan "Clean-VM run"): vault 0.7.9 keeps ONE
 * type and one `indexed` flag per field NAME across all tags and refuses a schema PUT that
 * disagrees, and the canonical file disagreed with itself 13 times on type:
 *
 *   - `confidence`  number on the 11 bioregional tags  → `confidence_score`
 *                   (it stays the high|medium|low label on person/project/organization/concept,
 *                   which the personal vault's data uses — qa/vault-health.md)
 *   - `species`     array on ecological-entity          → `constituent_species`
 *                   (it stays the string wikilink on herbal-use, which seed-demo-commons writes)
 *   - `published`   boolean on governance-revision      → `is_published`
 *                   (it stays the date on writing, which the personal vault's data uses; the
 *                   governance service writes the new key and still mirrors the old one for a
 *                   rollback to an older build, and reads `is_published` first)
 *
 * What it does: one lean listing per tag (only the two keys of that rename); a note qualifies
 * when it holds the OLD key with a value of the declared type and no NEW key. Skipped and
 * counted: a value of another type (left for a person), a NEW key that already holds something
 * else (`conflict`), and a note that also carries a tag on which the old name keeps its meaning
 * (`shared` — e.g. a note tagged both `species` and `person`: its `confidence` is a label).
 *
 * Dry run (default): counts per rename + up to 10 note ids/paths. No bodies are read.
 * --apply --backup-confirmed: per note a FRESH read, then ONE compare-and-set PATCH
 * (`if_updated_at`, never force) that sets the new key to the old value — byte for byte, never
 * converted. The old key is kept (a copy). `--remove-old` also removes it, except on
 * governance revisions: an older Prism build (after `prism update` rolls back) reads only the
 * old key there, and the signed governance projection covers the value, not the key, so keeping
 * it costs nothing. Every write logs what it replaced to the undo log; `undo.ts` puts it back.
 *
 * Governance notes: the value is copied unchanged, so the note's `gov_sig` still verifies
 * (governance-integrity.ts projects the value under its logical name) and the anti-replay
 * ledger is untouched.
 *
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/migrate-field-renames.ts \
 *     --vault-url http://127.0.0.1:1940 [--vault default] [--only confidence_score] [--limit 50] \
 *     [--apply --backup-confirmed] [--remove-old] [--production]
 */
import { pathToFileURL } from "node:url";
import {
  guardTarget,
  HttpError,
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

export const BIOREGIONAL_TAGS = ["entity", "ecological-entity", "species", "place", "watershed", "event", "resource", "signal", "recipe", "flow", "herbal-use"] as const;

export interface Rename {
  /** The new field name (also the `--only` value). */
  to: string;
  from: string;
  tags: readonly string[];
  /** Tags on which `from` keeps its old meaning: a note carrying one is left alone. */
  keepOn: readonly string[];
  /** The value shape the old declaration had; anything else is skipped. */
  accepts(v: unknown): boolean;
  /** Whether `--remove-old` may remove the old key. */
  removable: boolean;
}

export const RENAMES: readonly Rename[] = [
  {
    to: "confidence_score",
    from: "confidence",
    tags: BIOREGIONAL_TAGS,
    keepOn: ["person", "project", "organization", "concept"],
    accepts: (v) => typeof v === "number" && Number.isFinite(v),
    removable: true,
  },
  {
    to: "constituent_species",
    from: "species",
    tags: ["ecological-entity"],
    keepOn: ["herbal-use"],
    accepts: (v) => Array.isArray(v),
    removable: true,
  },
  {
    to: "is_published",
    from: "published",
    tags: ["governance-revision"],
    keepOn: ["writing"],
    accepts: (v) => typeof v === "boolean" || v === "true" || v === "false",
    removable: false,
  },
];

const SCRIPT = "field-renames";

export type Verdict = "copy" | "done" | "conflict" | "wrong-type" | "shared" | "absent";

/** What this rename should do with THIS note (pure). */
export function verdictFor(r: Rename, note: VaultNote): Verdict {
  const md = note.metadata ?? {};
  if (!Object.hasOwn(md, r.from) || md[r.from] === null || md[r.from] === undefined) return "absent";
  if ((note.tags ?? []).some((t) => r.keepOn.includes(t))) return "shared";
  if (!r.accepts(md[r.from])) return "wrong-type";
  if (Object.hasOwn(md, r.to) && md[r.to] !== null && md[r.to] !== undefined) {
    return JSON.stringify(md[r.to]) === JSON.stringify(md[r.from]) ? "done" : "conflict";
  }
  return "copy";
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "only", "limit", "rate", "undo-log"]);
  for (const f of args.flags) if (!["apply", "backup-confirmed", "production", "remove-old"].includes(f)) throw new UsageError(`unknown flag --${f}`);
  const url = guardTarget(args.get("vault-url"), args.has("production"));
  const apply = writeMode(args);
  const removeOld = args.has("remove-old");
  const limit = args.get("limit") ? Number(args.get("limit")) : Infinity;
  if (!(limit > 0)) throw new UsageError("--limit must be a positive number");
  const only = args.all("only");
  for (const o of only) if (!RENAMES.some((r) => r.to === o)) throw new UsageError(`--only must be one of ${RENAMES.map((r) => r.to).join(", ")}`);
  const renames = RENAMES.filter((r) => !only.length || only.includes(r.to));
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));

  const work: Array<{ r: Rename; note: VaultNote }> = [];
  ctx.log(`${apply ? "APPLY" : "DRY RUN"} — field renames (${removeOld ? "copy, then remove the old key where allowed" : "copy; the old key is kept"})`);
  for (const r of renames) {
    const notes = new Map<string, VaultNote>();
    for (const tag of r.tags) for (const n of await vault.listNotes({ tag, includeMetadata: [r.from, r.to] })) notes.set(n.id, n);
    const counts: Record<Verdict, number> = { copy: 0, done: 0, conflict: 0, "wrong-type": 0, shared: 0, absent: 0 };
    const odd: VaultNote[] = [];
    const todo: VaultNote[] = [];
    for (const n of notes.values()) {
      const v = verdictFor(r, n);
      counts[v]++;
      if (v === "copy") todo.push(n);
      if (v === "conflict" || v === "wrong-type") odd.push(n);
    }
    ctx.log(`  ${r.from} → ${r.to} (${r.tags.join(", ")}): ${counts.copy} to copy, ${counts.done} already copied, ${counts.conflict} conflict(s), ${counts["wrong-type"]} of another type, ${counts.shared} shared with ${r.keepOn.join("/")}`);
    for (const n of sample(todo)) ctx.log(`    e.g. ${ref(n)}`);
    for (const n of sample(odd)) ctx.log(`    left for a person: ${ref(n)} (${verdictFor(r, n)})`);
    for (const n of todo) work.push({ r, note: n });
  }
  if (!apply) return 0;

  const log = new UndoLog(ctx, undoLogPath(args, ctx, SCRIPT));
  const throttle = new Throttle(ctx, rateOf(args));
  let written = 0;
  let conflicts = 0;
  let skipped = 0;
  let failed = 0;
  for (const { r, note } of work.slice(0, limit)) {
    await throttle.wait();
    try {
      const fresh = await vault.getNote(note.id, { includeContent: false });
      if (!fresh || !fresh.updatedAt || verdictFor(r, fresh) !== "copy") {
        skipped++;
        continue;
      }
      const value = fresh.metadata![r.from];
      const drop = removeOld && r.removable;
      const patch: Record<string, unknown> = { [r.to]: value, ...(drop ? { [r.from]: null } : {}) };
      // What the write replaced: the new key was absent (undo removes it); the old one held `value`.
      const before: Record<string, unknown> = { [r.to]: null, ...(drop ? { [r.from]: value } : {}) };
      const after = await vault.patch(fresh.id, { metadata: patch }, fresh.updatedAt);
      log.append({ kind: "vault-patch", script: SCRIPT, at: ctx.now().toISOString(), id: fresh.id, path: fresh.path ?? null, afterUpdatedAt: after.updatedAt ?? "", before: { metadata: before } });
      written++;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) conflicts++;
      else {
        failed++;
        ctx.log(`  failed ${note.id}: ${scrub(e instanceof Error ? e.message : String(e))}`);
      }
    }
  }
  ctx.log(`done: ${written} written, ${conflicts} conflict(s) (changed meanwhile — re-run), ${skipped} no longer need it, ${failed} failed. Undo log: ${log.path}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli(main);
