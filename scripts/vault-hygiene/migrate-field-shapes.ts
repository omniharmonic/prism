/**
 * Migration (f): the stored shapes `vault-lint` still reports after (a) and (b) —
 * corrected ONLY where the corrected value says exactly what the stored one did.
 *
 *   recording_id / spec.version   a number            → the same digits as text
 *   meeting|transcript.source     "" (or blanks)      → removed (says nothing)
 *   a list field                  "" (or blanks)      → removed
 *                                 one value as text   → a one-item list
 *                                 "a, b" / "a; b"     → split, but only when every part is a
 *                                                       [[wikilink]] or a slug (or the field is
 *                                                       `keywords`); else kept whole, one item
 *                                 blank items         → dropped (an all-blank list is removed)
 *
 * Left alone on purpose: any other type in a list field, decimal `confidence` values
 * (a label would be a guess), letter case, and every note owned by an ingester.
 *
 * Dry run (default): counts per tag.field and rule + up to 10 note ids/paths. Only the
 * listed metadata keys are read — never a body, never a value in the output.
 * --apply --backup-confirmed: per note, a FRESH read, then ONE compare-and-set PATCH
 * (`if_updated_at`, never force). Every write logs the replaced values to the undo log;
 * `undo.ts` puts them back.
 *
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/migrate-field-shapes.ts \
 *     --vault-url http://127.0.0.1:1940 --production [--only meeting] [--limit 50]
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

/** tag → fields the schema declares as lists (apps/server/src/vault-shapes.ts, minus the ingest-owned message-thread). */
export const LIST_FIELDS: Record<string, string[]> = {
  person: ["organizations", "projects", "aliases"],
  organization: ["people", "projects", "aliases"],
  project: ["collaborators", "aliases", "keywords"],
  concept: ["aliases", "related", "sectors", "scales"],
  briefing: ["projects", "people"],
  meeting: ["projects", "attendees", "concepts", "organizations"],
  transcript: ["projects", "attendees"],
  research: ["projects"],
  "decision-record": ["participants"],
  "grant-application": ["collaborators"],
};
export const SOURCE_TAGS = ["meeting", "transcript"];
/** Tags listed for `recording_id` (the field is text wherever it appears). */
export const RECORDING_TAGS = ["meeting", "transcript"];
/** A comma in these is always a separator: the values are single words or short phrases by definition. */
const ALWAYS_SPLIT = new Set(["keywords"]);

const SCRIPT = "field-shapes";

export type Rule = "number-to-text" | "blank-removed" | "text-to-list" | "split-to-list" | "blank-items-dropped";

export interface Fix {
  tag: string;
  field: string;
  rule: Rule;
  /** The replacement; `null` removes the key (merge-patch). */
  to: unknown;
}

const isBlank = (v: unknown): boolean => typeof v === "string" && v.trim() === "";
const isSlug = (s: string): boolean => /^[a-z0-9][a-z0-9._-]*$/.test(s);
const isWikilink = (s: string): boolean => s.startsWith("[[") && s.endsWith("]]") && s.indexOf("[[", 2) < 0 && s.indexOf("]]") === s.length - 2;

/** Split on `,` / `;` outside `[[…]]`; parts trimmed, blanks dropped. One linear pass. */
export function splitOutsideLinks(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("[[", i)) (depth++, i++);
    else if (s.startsWith("]]", i)) ((depth = Math.max(0, depth - 1)), i++);
    else if (depth === 0 && (s[i] === "," || s[i] === ";")) (parts.push(s.slice(start, i)), (start = i + 1));
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The corrected value of a LIST field, or undefined when it is fine or cannot be corrected without a guess. */
export function listFix(field: string, v: unknown): { rule: Rule; to: unknown } | undefined {
  if (typeof v === "string") {
    const text = v.trim();
    if (!text) return { rule: "blank-removed", to: null };
    const parts = splitOutsideLinks(text);
    if (parts.length > 1 && (ALWAYS_SPLIT.has(field) || parts.every((p) => isWikilink(p) || isSlug(p)))) return { rule: "split-to-list", to: parts };
    return { rule: "text-to-list", to: [text] };
  }
  if (Array.isArray(v) && v.some(isBlank)) {
    const kept = v.filter((x) => !isBlank(x));
    return { rule: "blank-items-dropped", to: kept.length ? kept : null };
  }
  return undefined;
}

const asText = (v: unknown): string | undefined => (typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);

/** Every correction THIS note needs. Pure. */
export function fixesOf(note: VaultNote, only: string[] = []): Fix[] {
  const tags = note.tags ?? [];
  if (tags.some((t) => INGEST_OWNED_TAGS.includes(t))) return [];
  const md = note.metadata ?? {};
  const has = (k: string) => Object.hasOwn(md, k) && md[k] !== null && md[k] !== undefined;
  const out: Fix[] = [];
  const seen = new Set<string>();
  const add = (tag: string, field: string, f: { rule: Rule; to: unknown } | undefined) => {
    if (!f || seen.has(field)) return;
    seen.add(field);
    out.push({ tag, field, ...f });
  };
  for (const tag of tags) {
    if (only.length && !only.includes(tag)) continue;
    for (const field of LIST_FIELDS[tag] ?? []) if (has(field)) add(tag, field, listFix(field, md[field]));
    if (SOURCE_TAGS.includes(tag) && has("source") && isBlank(md.source)) add(tag, "source", { rule: "blank-removed", to: null });
    if (RECORDING_TAGS.includes(tag) && has("recording_id")) {
      const t = asText(md.recording_id);
      if (t !== undefined) add(tag, "recording_id", { rule: "number-to-text", to: t });
    }
    if (tag === "spec" && has("version")) {
      const t = asText(md.version);
      if (t !== undefined) add(tag, "version", { rule: "number-to-text", to: t });
    }
  }
  return out;
}

function keysFor(tag: string): string[] {
  return [...(LIST_FIELDS[tag] ?? []), ...(SOURCE_TAGS.includes(tag) ? ["source"] : []), ...(RECORDING_TAGS.includes(tag) ? ["recording_id"] : []), ...(tag === "spec" ? ["version"] : [])];
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "only", "limit", "rate", "undo-log"]);
  for (const f of args.flags) if (!["apply", "backup-confirmed", "production"].includes(f)) throw new UsageError(`unknown flag --${f}`);
  const url = guardTarget(args.get("vault-url"), args.has("production"));
  const apply = writeMode(args);
  const limit = args.get("limit") ? Number(args.get("limit")) : Infinity;
  if (!(limit > 0)) throw new UsageError("--limit must be a positive number");
  const only = args.all("only");
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));

  const tags = [...new Set([...Object.keys(LIST_FIELDS), ...SOURCE_TAGS, ...RECORDING_TAGS, "spec"])].filter((t) => !only.length || only.includes(t));
  const notes = new Map<string, VaultNote>();
  for (const tag of tags) {
    for (const n of await vault.listNotes({ tag, includeMetadata: keysFor(tag) })) {
      const prev = notes.get(n.id);
      notes.set(n.id, prev ? { ...n, metadata: { ...(prev.metadata ?? {}), ...(n.metadata ?? {}) } } : n);
    }
  }
  const found: { note: VaultNote; fixes: Fix[] }[] = [];
  for (const note of notes.values()) {
    if (!isLive(note)) continue;
    const fixes = fixesOf(note, only);
    if (fixes.length) found.push({ note, fixes });
  }
  const perRule = new Map<string, number>();
  for (const f of found) for (const x of f.fixes) perRule.set(`${x.tag}.${x.field}: ${x.rule}`, (perRule.get(`${x.tag}.${x.field}: ${x.rule}`) ?? 0) + 1);
  ctx.log(`${apply ? "APPLY" : "DRY RUN"} — ${found.length} note(s) hold a field whose shape can be corrected without changing what it says`);
  for (const [k, n] of [...perRule].sort()) ctx.log(`  ${k}: ${n}`);
  for (const f of sample(found)) ctx.log(`  e.g. ${ref(f.note)} [${f.fixes.map((x) => `${x.field}: ${x.rule}`).join(", ")}]`);
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
      const now = fixesOf(fresh, only);
      if (!now.length) {
        skipped++;
        continue;
      }
      const patch: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const x of now) {
        before[x.field] = fresh.metadata![x.field];
        patch[x.field] = x.to;
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
