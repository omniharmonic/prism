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
const { resolveLevel } = await import("../src/collab");
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

// Authenticate as owner via the local Bearer path (no proxy headers in an
// in-process request → isLocalRequest true → collabToken Bearer = owner).
const ownerHdr = { authorization: `Bearer ${config.collabToken}` };

function seedFederated(SPACE: string, KEY: string) {
  createSpace({
    id: SPACE, title: "S", scope_include_tags: '["shared"]',
    scope_exclude_tags: null, path_prefix: null, created_by: "owner@test.local",
  });
  upsertFederatedNote({
    space_note_key: KEY, space_id: SPACE, local_id: "note-x",
    kind: "document", peer_synced_at: null, source_updated_at: null,
  });
}

test("GET /api/federated/:id → 200 mapping for a federated note (authed)", async () => {
  seedFederated("space-1", "space-note-key-1");
  const res = await federated.request("/note-x", { headers: ownerHdr });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { spaceNoteKey: "space-note-key-1", spaceId: "space-1", kind: "document" });
});

test("GET /api/federated/:id → 204 for a non-federated note (authed)", async () => {
  const res = await federated.request("/not-federated", { headers: ownerHdr });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});

test("GET /api/federated/:id → 204 for an ANON caller (no enumeration oracle, L3)", async () => {
  seedFederated("space-2", "space-note-key-2");
  const res = await federated.request("/note-x"); // no auth header → anon
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});

// C1 regression: with GAP 2, THIS hub's own client opens a federated note under
// its space_note_key. resolveLevel must authorize that (via the local id), not
// demand a peer-conn token and Forbid the owner out of their own federated note.
test("C1: owner opening a federated note by space_note_key authorizes (not null)", async () => {
  seedFederated("space-c1", "snk-c1");
  // Owner via the local Bearer path (collab token), connecting under the SNK.
  const level = await resolveLevel("snk-c1", config.collabToken, null, true);
  assert.equal(level, "own");
});

// And a non-peer, non-owner token under a SNK falls through to normal auth (anon
// → null), NOT a silent peer authorization.
test("C1: a bare/unknown token under a space_note_key does not over-authorize", async () => {
  seedFederated("space-c1b", "snk-c1b");
  const level = await resolveLevel("snk-c1b", "", null, false);
  assert.equal(level, null);
});
