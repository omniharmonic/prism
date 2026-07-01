/**
 * Parachute-to-Parachute federation (Horizon C) — the GATED in-process
 * invariants. Live two-hub convergence needs a second hub+vault (deferred, see
 * docs/federation.md); these assert the primitives that gate and route it:
 *
 *   - peer-conn tokens: Ed25519-signed, round-trip, reject tamper/expiry/junk;
 *   - resolveLevel's federation branch: a paired peer with a space grant on the
 *     doc's space resolves to that level; an unpaired peer, a wrong-space token,
 *     or a missing grant resolves to null; and with FEDERATION off the branch is
 *     inert (never consulted);
 *   - federationTarget: maps a space_note_key → the local note id + pinned kind;
 *   - effectiveLevel space matching + the durable outbox + the suggestions inbox.
 *
 * The "peer" here is THIS server's own keypair (self-signed) — the same trick
 * verify-federation.ts uses to exercise the verify path without a real second
 * hub. Operates entirely on the fake vault + in-memory db.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";

// Federation is gated behind config.federationEnabled; force it on for this
// process so the resolveLevel/federationTarget branches are reachable. (Only
// affects this test process — the default stays off.)
(config as { federationEnabled: boolean }).federationEnabled = true;

import { serverKeyPair, fingerprint, isValidPeerPublicKey, generateKeyPairB64url } from "../src/auth/peer";
import { signPeerConnToken, verifyPeerConnToken } from "../src/auth/peer-conn";
import { resolveLevel, federationTarget } from "../src/collab";
import { effectiveLevel } from "../src/permissions";
import { acl } from "../src/routes/acl";
import { federation } from "../src/routes/federation";
import {
  addGrant, createSpace, upsertPeer, removePeer, upsertFederatedNote,
  queueOutbox, outboxForPeer, clearOutboxItem,
  createSuggestion, listSuggestions, getSuggestion,
  storePairing,
} from "../src/db";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";
import { createHash } from "node:crypto";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

/** Read a JSON response body with a caller-supplied shape (json() is `unknown`). */
async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ── peer-conn tokens ─────────────────────────────────────────────────────────
test("peer-conn token round-trips and embeds this server's pubkey", () => {
  const tok = signPeerConnToken("space-1");
  const claims = verifyPeerConnToken(tok);
  assert.ok(claims, "valid token verifies");
  assert.equal(claims!.spaceId, "space-1");
  assert.equal(claims!.pubkey, serverKeyPair().publicKeyB64url);
});

test("peer-conn token rejects tampering, expiry, and junk", () => {
  const tok = signPeerConnToken("space-1");
  // tamper the signed body (flip the first body char) → signature fails.
  const tampered = (tok[0] === "a" ? "b" : "a") + tok.slice(1);
  assert.equal(verifyPeerConnToken(tampered), null);
  // already-expired (negative ttl).
  assert.equal(verifyPeerConnToken(signPeerConnToken("space-1", -1000)), null);
  // structurally invalid.
  assert.equal(verifyPeerConnToken("garbage"), null);
  assert.equal(verifyPeerConnToken(""), null);
  assert.equal(verifyPeerConnToken("no-dot-payload"), null);
});

// ── resolveLevel federation branch ───────────────────────────────────────────
const KEY = "space-note-key-1";
const SPACE = "space-1";
function federatedFixture(level: "view" | "suggest" | "edit" = "edit") {
  fv.put({ id: "local-1", tags: ["shared"], content: "# Shared" });
  createSpace({ id: SPACE, title: "S", scope_include_tags: '["shared"]', scope_exclude_tags: null, path_prefix: null, created_by: "owner@test.local" });
  upsertFederatedNote({ space_note_key: KEY, space_id: SPACE, local_id: "local-1", kind: "document", peer_synced_at: null, source_updated_at: null });
  const peer = serverKeyPair().publicKeyB64url;
  upsertPeer({ pubkey: peer, paired_at: Date.now() });
  addGrant({ subject_type: "peer", subject: peer, resource_type: "space", resource: SPACE, level, created_by: "test" });
  return peer;
}

test("a paired peer with a space grant resolves to that level", async () => {
  federatedFixture("edit");
  const level = await resolveLevel(KEY, signPeerConnToken(SPACE), null);
  assert.equal(level, "edit");
});

test("wrong space in the token → null (token scope must match the doc's space)", async () => {
  federatedFixture("edit");
  const level = await resolveLevel(KEY, signPeerConnToken("some-other-space"), null);
  assert.equal(level, null);
});

test("an unpaired peer → null even with a valid signature", async () => {
  federatedFixture("edit");
  removePeer(serverKeyPair().publicKeyB64url); // un-pair
  const level = await resolveLevel(KEY, signPeerConnToken(SPACE), null);
  assert.equal(level, null);
});

test("a paired peer with NO space grant → null", async () => {
  fv.put({ id: "local-1", tags: ["shared"], content: "# Shared" });
  createSpace({ id: SPACE, title: "S", scope_include_tags: null, scope_exclude_tags: null, path_prefix: null, created_by: "o" });
  upsertFederatedNote({ space_note_key: KEY, space_id: SPACE, local_id: "local-1", kind: "document", peer_synced_at: null, source_updated_at: null });
  upsertPeer({ pubkey: serverKeyPair().publicKeyB64url, paired_at: Date.now() }); // paired, but ungranted
  const level = await resolveLevel(KEY, signPeerConnToken(SPACE), null);
  assert.equal(level, null);
});

test("with FEDERATION disabled the branch is inert (the key is not a real note → null)", async () => {
  federatedFixture("edit");
  (config as { federationEnabled: boolean }).federationEnabled = false;
  try {
    // federation off → getFederatedByKey never consulted; falls through to the
    // normal path, which getNote(KEY)s the vault (404) and finds no grants.
    const level = await resolveLevel(KEY, signPeerConnToken(SPACE), null);
    assert.equal(level, null, "must NOT resolve via the federation branch when gated off");
  } finally {
    (config as { federationEnabled: boolean }).federationEnabled = true;
  }
});

// ── federationTarget (document routing) ──────────────────────────────────────
test("federationTarget maps a known key to the local id + pinned kind; unknown passes through", () => {
  upsertFederatedNote({ space_note_key: KEY, space_id: SPACE, local_id: "local-1", kind: "spreadsheet", peer_synced_at: null, source_updated_at: null });
  assert.deepEqual(federationTarget(KEY), { noteId: "local-1", vaultId: "primary", kind: "spreadsheet" });
  // an ordinary (non-federated) document name decodes to the primary vault + bare id.
  assert.deepEqual(federationTarget("just-a-note-id"), { noteId: "just-a-note-id", vaultId: "primary" });
  // a vault-prefixed document name decodes to that vault + the bare note id.
  assert.deepEqual(federationTarget("teamA::42"), { noteId: "42", vaultId: "teamA" });
});

// ── effectiveLevel space matching (permissions) ──────────────────────────────
test("a space grant matches a note only via its spaceIds", () => {
  const grants = [{ id: "g", subject_type: "peer", subject: "pk", resource_type: "space", resource: SPACE, level: "edit", created_at: 0 } as const];
  assert.equal(effectiveLevel(grants as never, { id: "n", tags: [], spaceIds: [SPACE] }, null), "edit");
  assert.equal(effectiveLevel(grants as never, { id: "n", tags: [], spaceIds: ["other"] }, null), null);
  assert.equal(effectiveLevel(grants as never, { id: "n", tags: [] }, null), null, "no spaceIds → no match");
});

// ── durable outbox ───────────────────────────────────────────────────────────
test("outbox queues, reads back in order, and clears per item", () => {
  const peer = "peer-pk";
  queueOutbox(KEY, peer, new Uint8Array([1, 2, 3]));
  queueOutbox(KEY, peer, new Uint8Array([4, 5]));
  const items = outboxForPeer(peer);
  assert.equal(items.length, 2);
  assert.deepEqual([...items[0]!.update_blob], [1, 2, 3]);
  assert.deepEqual([...items[1]!.update_blob], [4, 5]);
  clearOutboxItem(items[0]!.id);
  assert.equal(outboxForPeer(peer).length, 1);
});

// ── peer key helpers ─────────────────────────────────────────────────────────
test("peer key helpers validate Ed25519 pubkeys and produce stable fingerprints", () => {
  const { publicKeyB64url } = generateKeyPairB64url();
  assert.ok(isValidPeerPublicKey(publicKeyB64url));
  assert.ok(!isValidPeerPublicKey("not-a-key"));
  assert.ok(!isValidPeerPublicKey(""));
  // fingerprint is deterministic and formatted as colon-separated hex pairs.
  assert.equal(fingerprint(publicKeyB64url), fingerprint(publicKeyB64url));
  assert.match(fingerprint(publicKeyB64url), /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
});

// ── pairing endpoint (federation.ts) ─────────────────────────────────────────
test("pairing: valid code pairs the peer; reuse and bad inputs are rejected", async () => {
  const { publicKeyB64url: peerPub } = generateKeyPairB64url();
  const code = "pair-code-123";
  storePairing(createHash("sha256").update(code).digest("hex"), "laptop", "owner@test.local", 10 * 60_000);

  const ok = await federation.request("/pair", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, pubkey: peerPub }),
  });
  assert.equal(ok.status, 200);
  const body = await readJson(ok);
  assert.equal(body.ok, true);
  assert.equal(body.serverPublicKey, serverKeyPair().publicKeyB64url);

  // single-use: the same code can't pair again.
  const reuse = await federation.request("/pair", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, pubkey: peerPub }),
  });
  assert.equal(reuse.status, 403);

  // a bad pubkey is rejected up front (400), before consuming a code.
  const badKey = await federation.request("/pair", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "whatever", pubkey: "not-a-key" }),
  });
  assert.equal(badKey.status, 400);
});

test("federation identity endpoint returns this server's pubkey + fingerprint", async () => {
  const res = await federation.request("/identity");
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.publicKey, serverKeyPair().publicKeyB64url);
  assert.equal(body.fingerprint, fingerprint(serverKeyPair().publicKeyB64url));
});

// ── suggestions inbox (durable; owner-only) ──────────────────────────────────
const OWNER = "owner@test.local";
const ownerReq = (path: string, init?: RequestInit) =>
  acl.request(path, { ...init, headers: { ...(init?.headers ?? {}), cookie: sessionCookie(makeSession(OWNER)) } });

test("a suggestion is durable and the owner can accept/reject it", async () => {
  const s = createSuggestion({ id: "sug-1", space_note_key: KEY, note_id: "local-1", author: "peer", author_kind: "peer", summary: "tweak", payload: "{}" });
  assert.equal(s.status, "pending");
  // it persists in the db independently of any live connection (survives restart).
  assert.equal(getSuggestion("sug-1")!.status, "pending");

  // owner inbox lists it.
  const list = await readJson(await ownerReq("/suggestions"));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "sug-1");

  // non-owner cannot reach the inbox.
  assert.equal((await acl.request("/suggestions")).status, 403);

  // accept transitions status (durably).
  const acc = await ownerReq("/suggestions/sug-1/accept", { method: "POST" });
  assert.equal(acc.status, 200);
  assert.equal(getSuggestion("sug-1")!.status, "accepted");
  assert.equal(listSuggestions("accepted").length, 1);
  assert.equal(listSuggestions("pending").length, 0);

  // accepting an unknown id → 404.
  assert.equal((await ownerReq("/suggestions/nope/accept", { method: "POST" })).status, 404);
});
