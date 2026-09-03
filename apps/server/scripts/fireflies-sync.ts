/**
 * Manual runner for the Fireflies ingest + cleanup loop (the same code the worker
 * runs on its schedule). Use it to drain a backlog, or to DRY RUN and see exactly
 * what a real pass would delete before authorizing it.
 *
 *   # dry run — ingests new transcripts, deletes NOTHING, prints the delete plan
 *   FIREFLIES_API_KEY=… node --env-file=.env --import tsx scripts/fireflies-sync.ts
 *
 *   # real run — same, but issues deleteTranscript for confirmed+owned transcripts
 *   FIREFLIES_API_KEY=… FIREFLIES_DELETE_ENABLED=true \
 *     node --env-file=.env --import tsx scripts/fireflies-sync.ts
 *
 * Deletion still requires, per transcript: a vault note that proves the verbatim
 * body was copied (isIngestConfirmed) AND that the meeting is owned by this API
 * key. Everything else is left on Fireflies.
 */
import { vaultClient } from "../src/parachute";
import {
  FirefliesClient,
  ingestAndCleanupFireflies,
  type FirefliesBudget,
  type FirefliesVault,
} from "../src/worker/fireflies";

const key = process.env.FIREFLIES_API_KEY ?? "";
if (!key) {
  console.error("FIREFLIES_API_KEY is required");
  process.exit(1);
}
const deleteEnabled = process.env.FIREFLIES_DELETE_ENABLED === "true";
const cap = Number(process.env.FIREFLIES_DAILY_BUDGET ?? 400);

let spent = 0;
const budget: FirefliesBudget = {
  remaining: () => cap - spent,
  spend: (n) => {
    spent += n;
  },
};

const client = new FirefliesClient(key);
const vault = vaultClient() as unknown as FirefliesVault;

console.log(`\nFireflies sync — ${deleteEnabled ? "\x1b[31mLIVE (will delete)\x1b[0m" : "DRY RUN (deletes nothing)"}\n`);

const res = await ingestAndCleanupFireflies(client, vault, {
  budget,
  deleteEnabled,
  recoverEmptySources: process.env.FIREFLIES_RECOVER_EMPTY === "true",
  maxRecoveriesPerRun: Number(process.env.FIREFLIES_MAX_RECOVERIES_PER_RUN ?? 3),
  quotaMinutesCap: Number(process.env.FIREFLIES_QUOTA_MINUTES_CAP ?? 400),
  listLimit: Number(process.env.FIREFLIES_LIST_LIMIT ?? 50),
  maxNewPerRun: Number(process.env.FIREFLIES_MAX_NEW_PER_RUN ?? 25),
  maxDeletePerRun: Number(process.env.FIREFLIES_MAX_DELETE_PER_RUN ?? 9),
  throttleMs: Number(process.env.FIREFLIES_THROTTLE_MS ?? 1500),
  onEvent: (e) => {
    switch (e.kind) {
      case "ingested":
        return console.log(`  + ingested     ${e.id}  "${e.title}"`);
      case "deleted":
        return console.log(`  \x1b[31m- DELETED\x1b[0m      ${e.id}  "${e.title}"`);
      case "would-delete":
        return console.log(`  ~ would delete ${e.id}  "${e.title}"`);
      case "unverified":
        return console.log(`  ! keeping      ${e.id}  "${e.title}"  (${e.reason})`);
      case "not-owner":
        return console.log(`  x not yours    ${e.id}  "${e.title}"  (owner: ${e.owner})`);
      case "false-delete":
        return console.log(`  ⚠ FALSE DELETE ${e.id}  "${e.title}"  → relabeled blocked`);
      case "recovered":
        return console.log(`  ↻ RECOVERED    ${e.id}  "${e.title}"  (empty; audio re-submitted for transcription)`);
      case "quota-warning":
        return console.log(`  \x1b[33m⚠ QUOTA ${e.minutesConsumed.toFixed(0)}/${e.cap} min — Fireflies stops transcribing at the cap\x1b[0m`);
      case "undeletable":
        return console.log(`  x undeletable  ${e.id}  "${e.title}"  (${e.reason})`);
    }
  },
});

console.log(
  `\nresult: ${res.created} ingested, ${res.deleted} deleted, ${res.recovered} recovered, ${res.wouldDelete} would-delete, ` +
    `${res.notOwner} not-yours, ${res.unverified} unverified, ${res.falseDeletes} false-deletes, ${res.skipped} skipped`,
);
console.log(`Fireflies API calls spent: ${spent}/${cap}\n`);
