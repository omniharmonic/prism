// FIRST LINE — force federation ON before config is evaluated. config.ts
// snapshots process.env.FEDERATION_ENABLED at module load, so every src import
// MUST be dynamic (ESM hoists static `import`s above this assignment). node:test
// runs each file in its own process, so this only affects THIS file.
process.env.FEDERATION_ENABLED = "true";

/**
 * GAP 2: the /api/federated/:noteId route on the ENABLED path. Maps a local note
 * id → its cross-hub mapping ({ spaceNoteKey, spaceId, kind }). Federated ids
 * resolve to 200; everything else stays 204 (never note content). Pure db +
 * in-process Hono request on the fake vault — no FederationManager / WS.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Dynamic so the FEDERATION_ENABLED assignment above wins the config snapshot.
const { config } = await import("../src/config");
const { federated } = await import("../src/routes/federated");
const { createSpace, upsertFederatedNote } = await import("../src/db");
const { installFakeVault, resetDb } = await import("./helpers");
type FakeVault = import("./helpers").FakeVault;

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

test("federation is enabled in this process", () => {
  assert.equal(config.federationEnabled, true);
});

test("GET /api/federated/:id → 200 mapping for a federated note", async () => {
  const SPACE = "space-1";
  const KEY = "space-note-key-1";
  createSpace({
    id: SPACE, title: "S", scope_include_tags: '["shared"]',
    scope_exclude_tags: null, path_prefix: null, created_by: "owner@test.local",
  });
  upsertFederatedNote({
    space_note_key: KEY, space_id: SPACE, local_id: "note-x",
    kind: "document", peer_synced_at: null, source_updated_at: null,
  });

  const res = await federated.request("/note-x");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { spaceNoteKey: KEY, spaceId: SPACE, kind: "document" });
});

test("GET /api/federated/:id → 204 for a non-federated note (even when enabled)", async () => {
  const res = await federated.request("/not-federated");
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});
