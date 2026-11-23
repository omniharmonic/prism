// The person-name repair (src/people-name-repair.ts): metadata.name only, never title / body; CAS;
// verified; intent logged before the write; undo only while unchanged. Fake vault.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { vaultClient } from "../src/parachute";
import { applyNameRepair, surveyNames, undoNameRepair, type NameRepairLog } from "../src/people-name-repair";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => { resetDb(); fv = installFakeVault(); });
afterEach(() => fv.restore());
const noSleep = async () => {};

test("repair: only notes with no name, from the heading, into metadata.name; undo restores", async () => {
  fv.put({ id: "p_html", path: "vault/people/x1", tags: ["person"], content: "<h1>Josie Siegel</h1><h2>Context</h2><p>Met at…</p>", metadata: { type: "person", title: "CEO" } });
  fv.put({ id: "p_ok", path: "vault/people/ann", tags: ["person"], content: "# Ann Lee", metadata: { type: "person", name: "Ann Lee" } });
  fv.put({ id: "p_path", path: "vault/people/jsiegel", tags: ["person"], content: "notes only", metadata: { type: "person" } });
  // The vault derives displayTitle from the first line: prose must never become a name (re-review N1).
  fv.put({ id: "p_prose", path: "vault/people/x9", tags: ["person"], content: "Met at ETHDenver, works on Gitcoin grants", metadata: { type: "person" }, displayTitle: "Met at ETHDenver, works on Gitcoin grants" } as never);
  fv.put({ id: "p_dead", path: "vault/people/old", tags: ["person"], content: "# Old Name", metadata: { type: "person", merged_into: "p_ok" } });
  fv.put({ id: "p_bot", path: "vault/people/bot", tags: ["person", "bot"], content: "# Some Bot", metadata: { type: "bot" } });
  const vault = vaultClient("primary");
  const s = await surveyNames(vault);
  assert.deepEqual(s.todo.map((t) => [t.note.id, t.name]), [["p_html", "Josie Siegel"]], "no tombstone, no non-human, no path-only name");
  const bodyBefore = fv.notes.get("p_html")!.content;
  const saves: string[] = [];
  const log: NameRepairLog = { batchId: "nr_test", vaultId: "primary", at: "", entries: [] };
  const out = await applyNameRepair(vault, s.todo, log, { save: (l) => saves.push(JSON.stringify(l)), paceMs: 0, sleep: noSleep });
  assert.deepEqual(out, { written: 1, changed: 0, shape: 0, unverified: 0, failed: 0 });
  const n = fv.notes.get("p_html")!;
  assert.equal(n.metadata!.name, "Josie Siegel");
  assert.equal(n.metadata!.title, "CEO", "the job title is untouched");
  assert.equal(n.content, bodyBefore, "never a body write");
  assert.ok(JSON.parse(saves[0]!).entries[0].state === "intent", "the intent is logged before the write");
  const patch = fv.calls.find((c) => c.method === "PATCH" && c.path.endsWith("/notes/p_html"))!;
  assert.deepEqual(Object.keys(patch.body as object).sort(), ["if_updated_at", "metadata"]);
  // Re-running finds nothing to do.
  assert.equal((await surveyNames(vault)).todo.length, 0);
  // Undo.
  const u = await undoNameRepair(vault, log, { paceMs: 0, sleep: noSleep });
  assert.equal(u.restored, 1);
  assert.equal(fv.notes.get("p_html")!.metadata!.name ?? null, null);
  assert.equal(fv.notes.get("p_html")!.metadata!.title, "CEO");
});

test("repair never overwrites a name added meanwhile; undo leaves an edited name", async () => {
  fv.put({ id: "p1", path: "vault/people/a", tags: ["person"], content: "# Ann Lee", metadata: { type: "person" } });
  const vault = vaultClient("primary");
  const s = await surveyNames(vault);
  fv.put({ ...fv.notes.get("p1")!, metadata: { type: "person", name: "Annie" }, updatedAt: "2026-12-01T00:00:00.000Z" });
  const log: NameRepairLog = { batchId: "nr_t2", vaultId: "primary", at: "", entries: [] };
  assert.equal((await applyNameRepair(vault, s.todo, log, { save: () => {}, paceMs: 0, sleep: noSleep })).changed, 1);
  assert.equal(fv.notes.get("p1")!.metadata!.name, "Annie");
  fv.put({ id: "p2", path: "vault/people/b", tags: ["person"], content: "# Bo Diaz", metadata: { type: "person" } });
  const log2: NameRepairLog = { batchId: "nr_t3", vaultId: "primary", at: "", entries: [] };
  await applyNameRepair(vault, (await surveyNames(vault)).todo, log2, { save: () => {}, paceMs: 0, sleep: noSleep });
  fv.put({ ...fv.notes.get("p2")!, metadata: { type: "person", name: "Bo D." }, updatedAt: "2026-12-02T00:00:00.000Z" });
  const u = await undoNameRepair(vault, log2, { paceMs: 0, sleep: noSleep });
  assert.equal(u.changed, 1);
  assert.equal(fv.notes.get("p2")!.metadata!.name, "Bo D.");
});
