/**
 * Replay an undo log written by a vault-hygiene migration, newest write first.
 *
 *  - `vault-patch` records: the note must still be at the revision our write
 *    produced (`afterUpdatedAt`); then ONE compare-and-set PATCH puts back the
 *    replaced body/values. A note edited since is reported and left alone.
 *  - `vault-create`: Trash an unedited created note through Prism; no hard delete.
 *  - `prism-trash` records: restored through Prism (`POST /api/trash/:id/restore`).
 *  - `vault-links` records (the sub-page link backfill): the links that write ADDED
 *    are removed with ONE links-only compare-and-set PATCH against the note's CURRENT
 *    revision. Unlike a body restore this does not need the note to be unedited — it
 *    touches no text and no value, only the links the log names — and a link that is
 *    already gone is not an error. Project repair may also restore removed links.
 *    Revision chains allow earlier writes in the same log to undo after our own
 *    restore changed updatedAt, while a later human edit blocks body/metadata undo.
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
  const needsPrism = recs.some((r) => r.kind === "prism-trash" || r.kind === "vault-create");
  const prismUrl = needsPrism && apply ? guardTarget(args.get("prism-url"), production, "--prism-url") : null;
  const ownerToken = ctx.env.PRISM_OWNER_TOKEN?.trim();
  if (needsPrism && apply && !ownerToken) throw new UsageError("restoring trashed notes needs PRISM_OWNER_TOKEN");

  ctx.log(`${apply ? "UNDO" : "DRY RUN (undo)"} — ${recs.length} record(s)`);
  const throttle = new Throttle(ctx, rateOf(args));
  // A successful restore changes updatedAt. Carry that revision through earlier
  // writes to the same note; never carry a revision over a later human edit.
  const revisions = new Map<string, string | null>();
  let restored = 0;
  let stale = 0;
  let failed = 0;
  for (const r of recs) {
    try {
      if (r.kind === "vault-create") {
        const note = await vault.getNote(r.id);
        if (!note || note.updatedAt !== (revisions.has(r.id) ? revisions.get(r.id) : r.afterUpdatedAt)) { stale++; ctx.log(`  skip created ${r.id}: edited since / gone`); continue; }
        const children = note.path ? (await vault.listNotes({ pathPrefix: `${note.path}/`, includeMetadata: ["prism_trashed_at"] })).filter(n => !n.tags?.includes("prism-trashed") && !n.metadata?.prism_trashed_at) : [];
        if (children.length) { stale++; ctx.log(`  skip created ${r.id}: descendants would be trashed`); continue; }
        if (!apply) { ctx.log(`  would trash created note ${r.id}`); continue; }
        await throttle.wait();
        const res = await ctx.fetch(`${prismUrl!.origin}/api/notes/${encodeURIComponent(r.id)}/trash`, {
          method: "POST", headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ if_updated_at: note.updatedAt, require_leaf: true }),
        });
        const result = await res.json().catch(() => null) as { ok?: boolean } | null;
        if (res.status !== 200 || result?.ok !== true) throw new HttpError(res.status, `trash created ${r.id}: incomplete/refused (${res.status})`);
        restored++; continue;
      }
      if (r.kind === "prism-trash") {
        if (!apply) {
          ctx.log(`  would restore from Trash ${r.id} ${r.path ?? ""}`);
          continue;
        }
        const beforeRestore = r.afterUpdatedAt ? await vault.getNote(r.id, { includeContent: false }) : null;
        const continuous = beforeRestore?.updatedAt === r.afterUpdatedAt && !!r.afterUpdatedAt;
        await throttle.wait();
        const res = await ctx.fetch(`${prismUrl!.origin}/api/trash/${encodeURIComponent(r.id)}/restore`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
          body: "{}",
        });
        if (!res.ok) throw new HttpError(res.status, `restore ${r.id}: ${res.status}`);
        const afterRestore = continuous ? await vault.getNote(r.id, { includeContent: false }) : null;
        revisions.set(r.id, afterRestore?.updatedAt ?? null);
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
        const missing = (r.removed ?? []).filter(l => !(note.links ?? []).some(x => x.sourceId === note.id && x.targetId === l.target && x.relationship === l.relationship));
        if (!present.length && !missing.length) {
          stale++;
          ctx.log(`  skip ${r.id} ${r.path ?? ""}: the link(s) are already gone`);
          continue;
        }
        if (!apply) {
          ctx.log(`  would remove ${present.length} link(s) from ${r.id} ${r.path ?? ""}`);
          continue;
        }
        await throttle.wait();
        const continuous = note.updatedAt === (revisions.has(r.id) ? revisions.get(r.id) : r.afterUpdatedAt);
        const after = await vault.patchLinks(r.id, { ...(present.length ? { remove: present } : {}), ...(missing.length ? { add: missing } : {}) }, note.updatedAt);
        revisions.set(r.id, continuous ? after.updatedAt ?? null : null);
        restored++;
        continue;
      }
      const note = await vault.getNote(r.id);
      if (!note || note.updatedAt !== (revisions.has(r.id) ? revisions.get(r.id) : r.afterUpdatedAt)) {
        stale++;
        ctx.log(`  skip ${r.id} ${r.path ?? ""}: ${note ? "edited since the migration — restore by hand from the log" : "note no longer exists"}`);
        continue;
      }
      if (!apply) {
        ctx.log(`  would restore ${r.id} ${r.path ?? ""} (${[r.before.content !== undefined ? "body" : "", ...Object.keys(r.before.metadata ?? {})].filter(Boolean).join(", ")})`);
        continue;
      }
      await throttle.wait();
      const after = await vault.patch(r.id, { ...(r.before.content !== undefined ? { content: r.before.content } : {}), ...(r.before.metadata ? { metadata: r.before.metadata } : {}) }, note.updatedAt!);
      revisions.set(r.id, after.updatedAt ?? null);
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
