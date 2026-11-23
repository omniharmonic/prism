/**
 * NP-DB-20 · `syncStoredTitle` (packages/core/src/lib/pages/storedTitle.ts): after a rename the
 * stored title says what was typed, and nothing else is ever touched —
 *  - a plain move changes no title;
 *  - a container-named page (`<folder>/PROJECT`) keeps its stored title through any move
 *    (its title is its own: the FILE names are compared, never the name a page is shown by);
 *  - the write is compare-and-set on the RAW value read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncStoredTitle } from "../../../packages/core/src/lib/pages/storedTitle";

type Call = { id: string; set: Record<string, unknown>; expect?: Record<string, unknown> };
function client(fail?: Error) {
  const calls: Call[] = [];
  return {
    calls,
    api: {
      updateProperties: async (id: string, set: Record<string, unknown>, expect?: Record<string, unknown>) => {
        calls.push({ id, set, expect });
        if (fail) throw fail;
        return {};
      },
    } as never,
  };
}
const note = (path: string, title?: unknown) => ({ id: "n1", path, content: "", metadata: title === undefined ? {} : { title }, updatedAt: "2026-01-01T00:00:00.000Z" }) as never;

test("a rename whose file name says the typed title removes a stored copy of the old name", async () => {
  const c = client();
  assert.equal(await syncStoredTitle(c.api, note("vault/db/Old name", "Old name"), "vault/db/New name", "New name"), "written");
  assert.deepEqual(c.calls, [{ id: "n1", set: { title: null }, expect: { title: "Old name" } }]);
});

test("a typed title the file name cannot hold is stored; one it already says is left alone", async () => {
  const c = client();
  assert.equal(await syncStoredTitle(c.api, note("vault/Plan"), "vault/Plan- Q4-2026", "Plan: Q4/2026"), "written");
  assert.deepEqual(c.calls, [{ id: "n1", set: { title: "Plan: Q4/2026" }, expect: { title: null } }]);
  const d = client();
  assert.equal(await syncStoredTitle(d.api, note("vault/Plan"), "vault/Road map", "Road map"), "unchanged");
  assert.deepEqual(d.calls, []);
});

test("a plain move (nothing typed) never touches a stored title", async () => {
  const c = client();
  assert.equal(await syncStoredTitle(c.api, note("vault/a/Page", "A title of its own"), "vault/b/Page"), "unchanged");
  // Even when the file name differs (nothing was typed, so there is no new name to store or to compare with).
  assert.equal(await syncStoredTitle(c.api, note("vault/a/Page", "A title of its own"), "vault/b/Page 2"), "unchanged");
  assert.deepEqual(c.calls, []);
});

test("a container-named page keeps its stored title through a move and a rename of the file", async () => {
  const c = client();
  // Moved under another folder: the name it is SHOWN by changes with the folder — its stored title must not be removed.
  assert.equal(await syncStoredTitle(c.api, note("vault/projects/food-chain/PROJECT", "Bioregional Food Chain"), "vault/archive/food-chain-2025/PROJECT"), "unchanged");
  assert.equal(await syncStoredTitle(c.api, note("vault/projects/food-chain/PROJECT", "Bioregional Food Chain"), "vault/projects/food-chain/Overview", "Overview"), "unchanged");
  assert.equal(await syncStoredTitle(c.api, note("vault/projects/food-chain/README.md"), "vault/elsewhere/README.md"), "unchanged");
  assert.deepEqual(c.calls, []);
});

test("a blank stored title is compared as it was read; someone else's newer title stands", async () => {
  const c = client();
  assert.equal(await syncStoredTitle(c.api, note("vault/Old", "  "), "vault/Road-map", "Road/map"), "written");
  assert.deepEqual(c.calls, [{ id: "n1", set: { title: "Road/map" }, expect: { title: "  " } }]);
  const conflict = Object.assign(new Error("changed"), { name: "PropertyConflictError" });
  assert.equal(await syncStoredTitle(client(conflict).api, note("vault/Old", "Old"), "vault/New", "New"), "unchanged");
  assert.equal(await syncStoredTitle(client(new Error("offline")).api, note("vault/Old", "Old"), "vault/New", "New"), "failed");
});

// Review of PR #42, finding 4: a definite refusal is not offered as a retry.
test("a refusal (403 / 404 / 423) is `refused`, not the retryable `failed`; a network failure stays `failed`", async () => {
  for (const status of [403, 404, 423]) {
    const no = Object.assign(new Error("no"), { name: "VaultRequestError", status });
    assert.equal(await syncStoredTitle(client(no).api, note("vault/ingest/Old", "Old"), "vault/ingest/New", "New"), "refused", String(status));
  }
  assert.equal(await syncStoredTitle(client(Object.assign(new Error("boom"), { status: 502 })).api, note("vault/Old", "Old"), "vault/New", "New"), "failed");
  assert.equal(await syncStoredTitle(client(new TypeError("Failed to fetch")).api, note("vault/Old", "Old"), "vault/New", "New"), "failed");
});
