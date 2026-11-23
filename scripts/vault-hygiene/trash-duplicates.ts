/**
 * Migration (c): move notes tagged `duplicate` to Prism's Trash — ONLY those
 * whose canonical twin is identified. Nothing is guessed: a duplicate with no
 * identifiable twin (or more than one) is listed for Benjamin to decide.
 *
 * A twin is identified when either
 *   1. the note points at it (`duplicate_of`, `duplicateOf`, `canonical`,
 *      `canonical_id`, `merged_into`, `mergedInto`, `superseded_by`; an id, a
 *      path or a `[[path]]`) and that note exists, is live and is not itself
 *      tagged `duplicate`; or
 *   2. exactly one OTHER live, non-duplicate note shares its recording id
 *      (`source_id` / `transcript_id` / `recording_id`) — the Fireflies inbox case.
 * A duplicate with sub-pages is skipped (Prism's trash takes the whole group).
 *
 * Trashing goes through the Prism Server (`POST /api/notes/:id/trash` with the
 * note's fresh `if_updated_at`) so it lands in the Trash ledger and stays
 * restorable from the Trash view; `undo.ts` restores via `/api/trash/:id/restore`.
 *
 * Dry run (default) needs only the vault read token. --apply --backup-confirmed
 * also needs --prism-url and PRISM_OWNER_TOKEN (an owner device token).
 *
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/trash-duplicates.ts \
 *     --vault-url http://127.0.0.1:1940 --production [--path-prefix vault/_inbox/transcripts/fireflies/]
 */
import { pathToFileURL } from "node:url";
import {
  guardTarget,
  HttpError,
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

const SCRIPT = "trash-duplicates";
export const POINTER_KEYS = ["duplicate_of", "duplicateOf", "canonical", "canonical_id", "merged_into", "mergedInto", "superseded_by"];
export const RECORDING_KEYS = ["source_id", "transcript_id", "recording_id"];
const DUP = "duplicate";

export interface Decision {
  note: VaultNote;
  canonical?: VaultNote;
  how?: string;
  why?: string;
}

const unwrap = (v: string): string => {
  const s = v.trim();
  return s.startsWith("[[") && s.endsWith("]]") ? s.slice(2, -2).split("|")[0]!.trim() : s;
};

const recordingIds = (n: VaultNote): string[] =>
  RECORDING_KEYS.map((k) => n.metadata?.[k])
    .filter((v): v is string | number => (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && v !== 0))
    .map((v) => String(v).trim());

export async function decide(vault: VaultApi, dups: VaultNote[], twinPool: VaultNote[]): Promise<Decision[]> {
  const byRecording = new Map<string, VaultNote[]>();
  for (const n of twinPool) {
    if (!isLive(n) || (n.tags ?? []).includes(DUP)) continue;
    for (const id of recordingIds(n)) byRecording.set(id, [...(byRecording.get(id) ?? []), n]);
  }
  const out: Decision[] = [];
  for (const note of dups) {
    if (!isLive(note)) continue;
    let decided = false;
    for (const key of POINTER_KEYS) {
      const raw = note.metadata?.[key];
      if (typeof raw !== "string" || !raw.trim()) continue;
      const target = await vault.getNote(unwrap(raw));
      if (target && target.id !== note.id && isLive(target) && !(target.tags ?? []).includes(DUP)) {
        out.push({ note, canonical: target, how: `metadata.${key}` });
      } else out.push({ note, why: `metadata.${key} points at a note that is missing, trashed or itself a duplicate` });
      decided = true;
      break;
    }
    if (decided) continue;
    const ids = recordingIds(note);
    const twins = [...new Set(ids.flatMap((id) => byRecording.get(id) ?? []))].filter((t) => t.id !== note.id);
    if (twins.length === 1) out.push({ note, canonical: twins[0], how: "same recording id" });
    else out.push({ note, why: twins.length ? `${twins.length} notes share its recording id` : "no pointer and no note with the same recording id" });
  }
  return out;
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "prism-url", "path-prefix", "limit", "rate", "undo-log"]);
  for (const f of args.flags) if (!["apply", "backup-confirmed", "production"].includes(f)) throw new UsageError(`unknown flag --${f}`);
  const production = args.has("production");
  const url = guardTarget(args.get("vault-url"), production);
  const apply = writeMode(args);
  const prismUrl = apply ? guardTarget(args.get("prism-url"), production, "--prism-url") : null;
  const ownerToken = ctx.env.PRISM_OWNER_TOKEN?.trim();
  if (apply && !ownerToken) throw new UsageError("--apply needs PRISM_OWNER_TOKEN (the Prism owner's device token)");
  const limit = args.get("limit") ? Number(args.get("limit")) : Infinity;
  if (!(limit > 0)) throw new UsageError("--limit must be a positive number");
  const prefix = args.get("path-prefix");
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));

  const lean = [...POINTER_KEYS, ...RECORDING_KEYS, "prism_trashed_at"];
  const dups = (await vault.listNotes({ tag: DUP, includeMetadata: lean })).filter((n) => !prefix || (n.path ?? "").startsWith(prefix));
  const pool = [...(await vault.listNotes({ tag: "transcript", includeMetadata: lean })), ...(await vault.listNotes({ tag: "meeting", includeMetadata: lean }))];
  const decisions = await decide(vault, dups, pool);
  const ok = decisions.filter((d) => d.canonical);
  const open = decisions.filter((d) => !d.canonical);
  ctx.log(`${apply ? "APPLY" : "DRY RUN"} — ${decisions.length} live note(s) tagged duplicate${prefix ? ` under ${prefix}` : ""}: ${ok.length} with an identified twin, ${open.length} left for review`);
  for (const d of sample(ok, 20)) ctx.log(`  trash ${ref(d.note)}  (twin ${ref(d.canonical!)} via ${d.how})`);
  for (const d of sample(open, 20)) ctx.log(`  REVIEW ${ref(d.note)} — ${d.why}`);
  if (!apply) return 0;

  const log = new UndoLog(ctx, undoLogPath(args, ctx, SCRIPT));
  const throttle = new Throttle(ctx, rateOf(args));
  let trashed = 0;
  let skipped = 0;
  let failed = 0;
  for (const d of ok.slice(0, limit)) {
    await throttle.wait();
    try {
      const fresh = await vault.getNote(d.note.id);
      if (!fresh || !isLive(fresh) || !fresh.updatedAt || !(fresh.tags ?? []).includes(DUP)) {
        skipped++;
        continue;
      }
      if (fresh.path) {
        const subpages = (await vault.listNotes({ pathPrefix: `${fresh.path}/`, includeMetadata: ["prism_trashed_at"] })).filter(isLive);
        if (subpages.length) {
          skipped++;
          ctx.log(`  skip ${ref(fresh)}: it has ${subpages.length} sub-page(s)`);
          continue;
        }
      }
      const res = await ctx.fetch(`${prismUrl!.origin}/api/notes/${encodeURIComponent(fresh.id)}/trash`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ if_updated_at: fresh.updatedAt }),
      });
      if (!res.ok) throw new HttpError(res.status, `trash ${fresh.id}: ${res.status} ${scrub((await res.text().catch(() => "")).slice(0, 200))}`);
      log.append({ kind: "prism-trash", script: SCRIPT, at: ctx.now().toISOString(), id: fresh.id, path: fresh.path ?? null, canonicalId: d.canonical!.id });
      trashed++;
    } catch (e) {
      failed++;
      ctx.log(`  failed ${d.note.id}: ${scrub(e instanceof Error ? e.message : String(e))}`);
    }
  }
  ctx.log(`done: ${trashed} moved to Trash, ${skipped} skipped, ${failed} failed (a 409 = changed meanwhile; re-run). Undo log: ${log.path}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli(main);
