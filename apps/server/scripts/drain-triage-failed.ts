/**
 * Drain the `triage-failed` backlog so the hourly classifier gets another pass
 * at notes it once failed on.
 *
 * `triage-failed` is the classifier's dead-letter tag (structured_skill.rs) — it
 * hard-excludes tagged notes from every later candidate set. Until the companion
 * fix (adding `triage-failed` to TRIAGE_TAGS in worker/matrix.ts, so new messages
 * clear it) there was no path back out: a thread that failed once was skipped
 * forever, even as it kept collecting messages.
 *
 * That fix only helps threads that receive NEW messages. This script clears the
 * notes already parked in the queue — most of which failed transiently, while the
 * local model host was down, rather than because their content is unclassifiable.
 *
 * PACING. Removing the tag makes a note a candidate on the classifier's next
 * hourly run, and that run is sequential local-model inference on a 16GB host.
 * `--limit` exists so a large backlog can be spread over several hourly runs
 * rather than landing in one; see the capacity note in CLAUDE.md.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *   node --env-file=.env --import tsx scripts/drain-triage-failed.ts [--apply] [--limit N]
 */
import { vault } from "../src/parachute";

const TAG = "triage-failed";
const APPLY = process.argv.includes("--apply");

/** `--limit N`, or every parked note when unset. */
function limitArg(): number {
  const i = process.argv.indexOf("--limit");
  if (i === -1) return Infinity;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit needs a positive integer, got ${String(process.argv[i + 1])}`);
  }
  return n;
}

/** Group by the metadata the failures actually vary along, so the report shows
 *  whether a drain is clearing one broken platform or a broad transient outage. */
function tally(notes: { metadata?: Record<string, unknown> | null }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const platform = (n.metadata?.platform as string) ?? (n.metadata?.mailbox ? "email" : "unknown");
    counts.set(platform, (counts.get(platform) ?? 0) + 1);
  }
  return counts;
}

async function main() {
  const limit = limitArg();
  const parked = await vault.listNotes({ tags: [TAG] });

  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${parked.length} note(s) tagged ${TAG}`);
  if (parked.length === 0) {
    console.log("nothing to drain");
    return;
  }

  for (const [platform, count] of [...tally(parked)].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${platform.padEnd(12)} ${count}`);
  }

  // Oldest first: a note that has been parked longest has waited through the most
  // classifier runs, so it earns the first slot when --limit spreads the drain.
  const ordered = [...parked].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  const batch = ordered.slice(0, limit === Infinity ? ordered.length : limit);
  const deferred = ordered.length - batch.length;

  console.log(`\ndraining ${batch.length}${deferred > 0 ? ` (${deferred} deferred by --limit)` : ""}\n`);

  let cleared = 0;
  const failures: string[] = [];
  for (const n of batch) {
    if (!APPLY) {
      console.log(`   would clear  ${String(n.updatedAt).slice(0, 16)}  ${n.path ?? n.id}`);
      continue;
    }
    try {
      await vault.removeTags(n.id, [TAG]);
      cleared++;
    } catch (e) {
      // Keep going: one unwritable note must not strand the rest of the backlog.
      failures.push(`${n.path ?? n.id}: ${(e as Error).message}`);
    }
  }

  if (!APPLY) {
    console.log(`\n(dry run — re-run with --apply to write)`);
    return;
  }

  console.log(`✓ cleared ${TAG} from ${cleared} note(s)`);
  if (failures.length) {
    console.log(`\n${failures.length} note(s) could not be updated:`);
    for (const f of failures) console.log(`   ${f}`);
  }
  console.log(
    `\nThey become classifier candidates on its next hourly run.` +
      (deferred > 0 ? ` Re-run to drain the remaining ${deferred}.` : ""),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
