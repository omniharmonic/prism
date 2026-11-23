// Keeps comms_conversations.status in step with the thread note's tags between projections.
//
// Tags change outside the Matrix ingest: the classifier adds importance tags, the status control
// sets/clears them, and ingest strips them when a new message arrives (worker/matrix.ts
// TRIAGE_TAGS). None of that reaches the comms bus, so the projection alone would go stale. The
// vault's tree projection (tree.ts) already sees every note change with its tags — this listens to
// it, so a tag change costs no vault read. A `resync` (reconnect, buffer overflow) carries no tags:
// one lean listing of the thread notes settles it.
import { resolveVaultEntry } from "../db";
import { config } from "../config";
import { vaultClient, type Note } from "../parachute";
import { subscribeTreeChanges, type TreeChange } from "../tree";
import { setStatusForNote } from "./store";
import { commsStatus } from "./triage";

const THREAD_TAG = "message-thread";

/** Apply one tree change; `listThreadNotes` settles a resync. Returns the conversations changed. */
export async function applyTreeChange(change: TreeChange, listThreadNotes: () => Promise<Pick<Note, "id" | "tags">[]>): Promise<number> {
  if (change.kind === "remove") return 0;
  if (change.kind === "resync") {
    let n = 0;
    for (const note of await listThreadNotes()) n += setStatusForNote(note.id, commsStatus(note.tags));
    return n;
  }
  if (!change.row.tags.includes(THREAD_TAG) || change.row.trashedAt) return 0;
  if (change.prev && change.prev.tags.length === change.row.tags.length && change.prev.tags.every((t, i) => t === change.row.tags[i])) return 0;
  return setStatusForNote(change.row.id, commsStatus(change.row.tags));
}

/** One lean vault listing settles every thread's status (needs no Matrix: a failed or skipped rebuild
 *  must not leave the migration default `unclassified` in place). */
export function syncAllStatuses(listThreadNotes: () => Promise<Pick<Note, "id" | "tags">[]>): Promise<number> {
  return applyTreeChange({ kind: "resync" }, listThreadNotes);
}

let unsubscribe: (() => void) | null = null;
let starting = false;

/** Startup hook (with COMMS_ENABLED): background, never throws; retries the subscription. */
export function startCommsStatusSync(): void {
  if (unsubscribe || starting) return;
  starting = true;
  const entry = resolveVaultEntry(undefined);
  const vault = vaultClient(entry.id, { timeoutMs: config.matrixVaultTimeoutMs > 0 ? config.matrixVaultTimeoutMs : 30_000 });
  const list = () => vault.listNotes({ tags: [THREAD_TAG], includeContent: false });
  let queue: Promise<unknown> = Promise.resolve();
  const guard = (p: Promise<unknown>) => p.catch((e) => console.warn(`[comms] status sync failed: ${e instanceof Error ? e.name : "error"}`));
  // Backfill now (after a deploy every row reads "unclassified"), independent of the Matrix rebuild.
  queue = guard(syncAllStatuses(list));
  void subscribeTreeChanges(entry, (c) => {
    // Serialized: a resync listing must not interleave with later single changes.
    queue = guard(queue.then(() => applyTreeChange(c, list)));
  })
    .then((off) => { unsubscribe = off; })
    .catch((e) => {
      console.warn(`[comms] status sync unavailable: ${String(e).slice(0, 200)} — retrying in 60 s`);
      const t = setTimeout(startCommsStatusSync, 60_000);
      t.unref?.();
    })
    .finally(() => { starting = false; });
}

export function stopCommsStatusSync(): void {
  unsubscribe?.();
  unsubscribe = null;
}
