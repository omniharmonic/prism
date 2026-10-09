/**
 * Replay an undo log written by a vault-hygiene migration, newest write first.
 *
 *  - `vault-patch` records: the note must still be at the revision our write
 *    produced (`afterUpdatedAt`); then ONE compare-and-set PATCH puts back the
 *    replaced body/values. A note edited since is reported and left alone.
 *  - `prism-trash` records: restored through Prism (`POST /api/trash/:id/restore`).
 *  - `vault-links` records (the sub-page link backfill): the links that write ADDED
 *    are removed with ONE links-only compare-and-set PATCH against the note's CURRENT
 *    revision. Unlike a body restore this does not need the note to be unedited — it
 *    touches no text and no value, only the links the log names — and a link that is
 *    already gone is not an error.
 *
 * Dry run by default (prints what it would restore). `--apply` writes.
 *
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/undo.ts --log <file.jsonl> \
 *     --vault-url http://127.0.0.1:1940 --production [--prism-url …] [--apply]
 */
import { pathToFileURL } from "node:url";
import { guardTarget, HttpError, parseArgs, rateOf, readToken, readUndoLog, runCli, scrub, Throttle, UsageError, VaultApi, type Ctx, type UndoRecord } from "./lib";

export async function main(argv: string[], ctx: Ctx, records?: UndoRecord[]): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "prism-url", "log", "rate"]);
  for (const f of args.flags) if (!["apply", "production"].includes(f)) throw new UsageError(`unknown flag --${f}`);
  const production = args.has("production");
  const url = guardTarget(args.get("vault-url"), production);
  const apply = args.has("apply");
  const logPath = args.get("log");
  if (!records && !logPath) throw new UsageError("--log <undo log> is required");
  const recs = [...(records ?? readUndoLog(logPath!))].reverse();
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));
  const needsPrism = recs.some((r) => r.kind === "prism-trash");
  const prismUrl = needsPrism && apply ? guardTarget(args.get("prism-url"), production, "--prism-url") : null;
  const ownerToken = ctx.env.PRISM_OWNER_TOKEN?.trim();
  if (needsPrism && apply && !ownerToken) throw new UsageError("restoring trashed notes needs PRISM_OWNER_TOKEN");

  ctx.log(`${apply ? "UNDO" : "DRY RUN (undo)"} — ${recs.length} record(s)`);
  const throttle = new Throttle(ctx, rateOf(args));
  let restored = 0;
  let stale = 0;
  let failed = 0;
  for (const r of recs) {
    try {
      if (r.kind === "prism-trash") {
        if (!apply) {
          ctx.log(`  would restore from Trash ${r.id} ${r.path ?? ""}`);
          continue;
        }
        await throttle.wait();
        const res = await ctx.fetch(`${prismUrl!.origin}/api/trash/${encodeURIComponent(r.id)}/restore`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
          body: "{}",
        });
        if (!res.ok) throw new HttpError(res.status, `restore ${r.id}: ${res.status}`);
        restored++;
        continue;
      }
      if (r.kind === "vault-links") {
        const note = await vault.getNote(r.id, { includeLinks: true });
        if (!note || !note.updatedAt) {
          stale++;
          ctx.log(`  skip ${r.id} ${r.path ?? ""}: note no longer exists`);
          continue;
        }
        // Only links still present are removed (targets compare by id; the log holds ids).
        const present = r.added.filter((l) => (note.links ?? []).some((x) => x.sourceId === note.id && x.targetId === l.target && x.relationship === l.relationship));
        if (!present.length) {
          stale++;
          ctx.log(`  skip ${r.id} ${r.path ?? ""}: the link(s) are already gone`);
          continue;
        }
        if (!apply) {
          ctx.log(`  would remove ${present.length} link(s) from ${r.id} ${r.path ?? ""}`);
          continue;
        }
        await throttle.wait();
        await vault.patchLinks(r.id, { remove: present }, note.updatedAt);
        restored++;
        continue;
      }
      const note = await vault.getNote(r.id);
      if (!note || note.updatedAt !== r.afterUpdatedAt) {
        stale++;
        ctx.log(`  skip ${r.id} ${r.path ?? ""}: ${note ? "edited since the migration — restore by hand from the log" : "note no longer exists"}`);
        continue;
      }
      if (!apply) {
        ctx.log(`  would restore ${r.id} ${r.path ?? ""} (${[r.before.content !== undefined ? "body" : "", ...Object.keys(r.before.metadata ?? {})].filter(Boolean).join(", ")})`);
        continue;
      }
      await throttle.wait();
      await vault.patch(r.id, { ...(r.before.content !== undefined ? { content: r.before.content } : {}), ...(r.before.metadata ? { metadata: r.before.metadata } : {}) }, note.updatedAt!);
      restored++;
    } catch (e) {
      failed++;
      ctx.log(`  failed ${r.id}: ${scrub(e instanceof Error ? e.message : String(e))}`);
    }
  }
  ctx.log(`done: ${restored} restored, ${stale} skipped (edited since / gone), ${failed} failed`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli((argv, ctx) => main(argv, ctx));
