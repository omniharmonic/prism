/**
 * Report (d): untagged notes, grouped by folder, with a SUGGESTED tag per group.
 * Report-only — there is no --apply. Tagging is a later, separately approved step.
 *
 * One lean listing (paths + tags, no bodies, no metadata values). Output: one
 * line per folder with the count, the suggestion and up to 3 sample paths.
 *
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/report-untagged.ts \
 *     --vault-url http://127.0.0.1:1940 --production [--depth 3] [--json]
 */
import { pathToFileURL } from "node:url";
import { guardTarget, isLive, parseArgs, readToken, runCli, UsageError, VaultApi, type Ctx, type VaultNote } from "./lib";

export interface Group {
  folder: string;
  count: number;
  suggestion: string;
  samples: string[];
}

/** Folder key: the first `depth` segments of the note's parent path. */
export function folderOf(path: string, depth: number): string {
  const parts = path.split("/").slice(0, -1);
  return parts.length ? parts.slice(0, depth).join("/") : "(top level)";
}

/** A tag suggestion from the folder alone — a starting point for review, never applied. */
export function suggest(folder: string): string {
  const f = folder.toLowerCase();
  if (f.startsWith("_templates")) return "leave untagged (templates)";
  if (f.startsWith("_test")) return "leave untagged (test fixtures)";
  const project = /^vault\/projects\/([^/]+)/.exec(f);
  if (project) {
    const kind = /\/research(\/|$)/.test(f) ? "research" : "document";
    return `${project[1]} + ${kind}`;
  }
  if (/(^|\/)_inbox\/transcripts/.test(f)) return "transcript";
  if (/(^|\/)_inbox\/documents/.test(f)) return "document";
  if (f.startsWith("vault/research")) return "research";
  if (f.startsWith("vault/people")) return "person";
  if (f.startsWith("vault/meetings")) return "meeting";
  if (/(^|\/)_staging|(^|\/)_inbox/.test(f)) return "review by hand (staging / inbox)";
  return "review by hand";
}

export function groupUntagged(notes: VaultNote[], depth: number): Group[] {
  const groups = new Map<string, Group>();
  for (const n of notes) {
    if (!isLive(n) || (n.tags ?? []).length > 0) continue;
    const folder = folderOf(n.path ?? "", depth);
    // The suggestion reads the note's whole parent folder (a `research/` below the
    // grouping depth still counts), so one folder may show two suggestion rows.
    const suggestion = suggest(folderOf(n.path ?? "", 99));
    const key = `${folder}\u0000${suggestion}`;
    const g = groups.get(key) ?? { folder, count: 0, suggestion, samples: [] };
    g.count++;
    if (g.samples.length < 3) g.samples.push(n.path ?? n.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "depth"]);
  for (const f of args.flags) if (!["production", "json"].includes(f)) throw new UsageError(`unknown flag --${f} (this report never writes)`);
  const url = guardTarget(args.get("vault-url"), args.has("production"));
  const depth = Number(args.get("depth") ?? 3);
  if (!Number.isInteger(depth) || depth < 1 || depth > 8) throw new UsageError("--depth is 1–8");
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));
  const groups = groupUntagged(await vault.listNotes({ includeMetadata: ["prism_trashed_at"] }), depth);
  if (args.has("json")) {
    ctx.log(JSON.stringify(groups, null, 2));
    return 0;
  }
  ctx.log(`REPORT — ${groups.reduce((s, g) => s + g.count, 0)} untagged note(s) in ${groups.length} folder(s). Nothing is written.`);
  for (const g of groups) ctx.log(`  ${String(g.count).padStart(4)}  ${g.folder}  → suggest: ${g.suggestion}   e.g. ${g.samples.join(", ")}`);
  ctx.log("People links (the email/thread/meeting orphans) are NOT handled here: run Prism's own job as a dry run — POST /api/admin/people/link {\"dryRun\":true}.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli(main);
