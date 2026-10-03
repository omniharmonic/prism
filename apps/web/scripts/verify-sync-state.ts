/**
 * Round-4 review, L7: the "not saved" copy matches the reason, a transient
 * "not written yet" state never reads "Saved", and the badge is not announced as
 * "retry saving" when there is nothing to retry.
 * Run: npm run verify:sync -w @prism/web
 */
import assert from "node:assert/strict";
import * as sync from "../../../packages/core/src/lib/sync/syncState.ts";

const base = { online: true, inFlight: 0, dirty: {}, pending: 0, attention: 0, failures: {}, sources: {} as Record<string, sync.SyncSourceState> };
const status = (sources: Record<string, string>, failures: Record<string, sync.SyncFailure> = {}) => sync.deriveSyncStatus({ ...base, sources: sources as Record<string, sync.SyncSourceState>, failures });

// A page the server is still trying to write (vault down, converter busy): never "Saved".
const retrying = status({ "collab:a": "retrying" });
assert.notEqual(retrying.kind, "saved");
assert.notEqual(retrying.label, "Saved");
assert.match(retrying.label, /retrying/i);
assert.equal(status({}).label, "Saved");

// A page that cannot be saved as it is: failed, and the label makes no claim about WHY.
const unsaved = status({ "collab:a": "unsaved" });
assert.equal(unsaved.kind, "failed");
assert.doesNotMatch(unsaved.label, /too large|smaller/i, "the badge does not guess the reason");

// The explanation follows the server's reason: "smaller" only where a smaller page would be saved.
const explain = sync.unsavedExplanation;
assert.equal(typeof explain, "function");
for (const reason of ["too_large", "too_complex", "too_many_nodes", "vault 413"]) assert.match(explain(reason), /smaller/, reason);
for (const reason of ["vault 400", "vault 422", "gave_up"]) {
  assert.doesNotMatch(explain(reason), /until (it|the page) is smaller/, `${reason}: making the page smaller is not the cure`);
  assert.match(explain(reason), /workspace owner/, reason);
}
assert.match(explain("vault 422"), /refuses/);
assert.match(explain("gave_up"), /two weeks/);
for (const reason of ["too_large", "vault 400", "gave_up", null]) assert.match(explain(reason), /kept on the server/);
assert.match(explain("vault 503", false), /keeps trying/);

// The badge's accessible name promises "retry saving" only when pressing it retries.
const action = sync.syncBadgeAction;
assert.equal(action(unsaved), null, "nothing to retry for a page the server cannot store: not a button");
assert.equal(action(status({ "collab:a": "failed" })), null, "local saving unavailable: nothing to retry either");
assert.equal(action(status({}, { k: { message: "x", retry: () => {} } })), "retry");
assert.equal(action(status({}, { k: { message: "x" } })), null);
assert.equal(action(sync.deriveSyncStatus({ ...base, attention: 1 })), "review");
assert.equal(action(sync.deriveSyncStatus({ ...base, online: false, pending: 1 })), "review");
assert.equal(action(status({})), null);
assert.equal(action(retrying), null);
console.log("verify-sync-state: OK");
