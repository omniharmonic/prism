/**
 * Federation MIRROR flow (Layer A, no live vault/WS) — the peer→pending→accept
 * path that replaces the two-hub harness's manual B-side SQLite insert.
 *
 * Two surfaces under test:
 *   • POST /api/federation/mirror — peer-conn-token-authed; a PAIRED peer pushes a
 *     space manifest; it lands as a PENDING request (never written to the vault).
 *   • /acl/federation/mirrors[/:id/accept|reject] — owner-only review: accept
 *     materializes the local space + peer grant + a placeholder note per shared
 *     key + the federated_notes mapping (idempotent); reject just marks it.
 *
 * Federation stays at the .env.test default of OFF — neither /mirror nor /acl is
 * flag-gated (only `kickFederationSync` no-ops when off), so the full flow runs.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { federation } from "../src/routes/federation";
import { acl } from "../src/routes/acl";
import { generateKeyPairB64url } from "../src/auth/peer";
import {
  upsertPeer,
  getSpace,
  grantsForResource,
  getFederatedByKey,
  upsertFederatedNote,
  listMirrorRequests,
  getFederationEnabled,
  type Grant,
} from "../src/db";
import {
  installFakeVault,
  resetDb,
  makeSession,
  sessionCookie,
  type FakeVault,
} from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";
const ownerReq = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cookie", sessionCookie(makeSession(OWNER)));
  return acl.request(path, { ...init, headers });
};

/**
 * Forge a peer-conn token signed by an ARBITRARY private key — the same wire
 * form as src/auth/peer-conn.ts (`${base64url(JSON claims)}.${sig}`), but the
 * signer is the peer's own key, exactly as `scripts/verify-two-hub.ts`'s
 * `mkPeerConnToken` does. The receiving route verifies the signature against the
 * embedded pubkey, so this proves "I hold THIS pubkey and want spaceId".
 */
function mkPeerConnToken(privB64url: string, pubB64url: string, spaceId: string, ttlMs = 5 * 60_000): string {
  const claims = { pubkey: pubB64url, spaceId, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const priv = crypto.createPrivateKey({ key: Buffer.from(privB64url, "base64url"), format: "der", type: "pkcs8" });
  const sig = crypto.sign(null, Buffer.from(body, "utf8"), priv).toString("base64url");
  return `${body}.${sig}`;
}

/** A paired peer + a valid peer-conn token for (its pubkey, spaceId). */
function pairedPeer(spaceId: string): { pubkey: string; priv: string; token: string } {
  const { privateKeyB64url: priv, publicKeyB64url: pubkey } = generateKeyPairB64url();
  upsertPeer({ pubkey, label: "peer", paired_at: Date.now() });
  return { pubkey, priv, token: mkPeerConnToken(priv, pubkey, spaceId) };
}

const mirror = (token: string | null, body: unknown) => {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return federation.request("/mirror", { method: "POST", headers, body: JSON.stringify(body) });
};

// ── 1. authn/authz on POST /api/federation/mirror ────────────────────────────
test("POST /mirror with NO token → 401", async () => {
  const res = await mirror(null, { spaceId: "sp1", notes: [{ spaceNoteKey: "k1", kind: "document" }] });
  assert.equal(res.status, 401);
});

test("POST /mirror with a token whose pubkey is NOT a paired peer → 403", async () => {
  // Valid signature, but the peer was never paired (no upsertPeer / paired_at).
  const { privateKeyB64url: priv, publicKeyB64url: pubkey } = generateKeyPairB64url();
  const token = mkPeerConnToken(priv, pubkey, "sp1");
  const res = await mirror(token, { spaceId: "sp1", notes: [{ spaceNoteKey: "k1", kind: "document" }] });
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: string }).error, "unknown_peer");
});

// ── 2. happy path + validation on POST /api/federation/mirror ─────────────────
test("a paired peer can POST /mirror → 200 pending", async () => {
  const spaceId = "space-mirror-1";
  const { token } = pairedPeer(spaceId);
  const res = await mirror(token, {
    spaceId,
    spaceTitle: "Shared",
    notes: [{ spaceNoteKey: "k1", kind: "document" }],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; requestId: string; status: string; noteCount: number };
  assert.equal(body.ok, true);
  assert.equal(body.status, "pending");
  assert.equal(body.noteCount, 1);
  assert.ok(body.requestId);
});

test("POST /mirror with body.spaceId ≠ the token's spaceId → 400 space_mismatch", async () => {
  const { token } = pairedPeer("token-space");
  const res = await mirror(token, { spaceId: "other-space", notes: [{ spaceNoteKey: "k1", kind: "document" }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "space_mismatch");
});

test("POST /mirror with empty / invalid notes → 400 no_valid_notes", async () => {
  const spaceId = "space-empty";
  const { token } = pairedPeer(spaceId);
  // empty list
  assert.equal((await mirror(token, { spaceId, notes: [] })).status, 400);
  // a note with an unknown kind is filtered out, leaving nothing valid
  const res = await mirror(token, { spaceId, notes: [{ spaceNoteKey: "k1", kind: "bogus" }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "no_valid_notes");
});

// ── 3. idempotency per (peer, space) ─────────────────────────────────────────
test("a second POST /mirror for the same (peer, space) updates the SAME pending request", async () => {
  const spaceId = "space-idem";
  const { token } = pairedPeer(spaceId);
  const first = (await (await mirror(token, { spaceId, notes: [{ spaceNoteKey: "k1", kind: "document" }] })).json()) as { requestId: string };
  const second = (await (await mirror(token, { spaceId, notes: [{ spaceNoteKey: "k1", kind: "document" }, { spaceNoteKey: "k2", kind: "code" }] })).json()) as { requestId: string; noteCount: number };

  assert.equal(first.requestId, second.requestId, "same pending row is refreshed, not duplicated");
  assert.equal(second.noteCount, 2, "manifest was refreshed");
  assert.equal(listMirrorRequests().length, 1);
});

// ── 4. owner accept / reject (/acl/federation/mirrors) ───────────────────────
test("owner can accept a mirror request → space + peer grant + mapped note", async () => {
  const spaceId = "space-accept";
  const { pubkey, token } = pairedPeer(spaceId);
  const posted = (await (await mirror(token, {
    spaceId,
    spaceTitle: "AcceptMe",
    notes: [{ spaceNoteKey: "snk-1", kind: "document", title: "Doc" }],
  })).json()) as { requestId: string };

  const res = await ownerReq(`/federation/mirrors/${posted.requestId}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level: "edit" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; spaceId: string; level: string; mapped: Array<{ spaceNoteKey: string; localId: string; kind: string }> };
  assert.equal(body.ok, true);
  assert.equal(body.spaceId, spaceId);
  assert.equal(body.level, "edit");

  // The local space exists, with the same id as the peer's.
  assert.ok(getSpace(spaceId), "local space created");

  // A peer grant exists on it at the accepted level.
  const grants = grantsForResource("space", spaceId);
  const peerGrant = grants.find((g: Grant) => g.subject_type === "peer" && g.subject === pubkey);
  assert.ok(peerGrant, "peer grant created on the space");
  assert.equal(peerGrant!.level, "edit");

  // The shared key maps to a created local note pinned to the manifest kind.
  const fed = getFederatedByKey("snk-1");
  assert.ok(fed, "federated_notes mapping created");
  assert.equal(fed!.kind, "document");
  assert.equal(fed!.local_id, body.mapped[0]!.localId);
  assert.ok(fed!.local_id);
});

test("accepting an already-mapped key is idempotent (reuses the local id, no dup note)", async () => {
  const spaceId = "space-accept-twice";
  const { token } = pairedPeer(spaceId);
  const first = (await (await mirror(token, { spaceId, notes: [{ spaceNoteKey: "snk-x", kind: "document" }] })).json()) as { requestId: string };
  const r1 = (await (await ownerReq(`/federation/mirrors/${first.requestId}/accept`, { method: "POST", body: JSON.stringify({}) })).json()) as { mapped: Array<{ localId: string }> };
  const localId1 = r1.mapped[0]!.localId;
  const createCallsAfterFirst = fv.calls.filter((c) => c.method === "POST" && c.path.endsWith("/notes")).length;

  // A fresh pending request for the SAME key (first one is now accepted) → accept
  // must REUSE the existing federated mapping, not create a second placeholder note.
  const second = (await (await mirror(token, { spaceId, notes: [{ spaceNoteKey: "snk-x", kind: "document" }] })).json()) as { requestId: string };
  const r2 = (await (await ownerReq(`/federation/mirrors/${second.requestId}/accept`, { method: "POST", body: JSON.stringify({}) })).json()) as { mapped: Array<{ localId: string }> };
  const createCallsAfterSecond = fv.calls.filter((c) => c.method === "POST" && c.path.endsWith("/notes")).length;

  assert.equal(r2.mapped[0]!.localId, localId1, "reuses the existing local id");
  assert.equal(createCallsAfterSecond, createCallsAfterFirst, "no second vault note created");
  assert.equal(getFederatedByKey("snk-x")!.local_id, localId1);
});

// ── 3. GET /acl/spaces serializes peers + sync status (the Federate-panel readback) ──
test("GET /acl/spaces returns granted peers, noteCount, and lastSyncedAt", async () => {
  const spaceId = "space-view";
  const { pubkey, token } = pairedPeer(spaceId);
  const posted = (await (await mirror(token, {
    spaceId,
    spaceTitle: "Viewable",
    notes: [{ spaceNoteKey: "view-k1", kind: "document", title: "Doc" }],
  })).json()) as { requestId: string };
  await ownerReq(`/federation/mirrors/${posted.requestId}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level: "suggest" }),
  });

  type SpaceView = {
    id: string;
    peers: Array<{ pubkey: string; fingerprint: string; label: string | null; level: string }>;
    noteCount: number;
    lastSyncedAt: number | null;
  };
  const list1 = (await (await ownerReq("/spaces")).json()) as SpaceView[];
  const sv = list1.find((s) => s.id === spaceId);
  assert.ok(sv, "space present in /acl/spaces");
  assert.equal(sv!.noteCount, 1, "one federated note mapped");
  assert.equal(sv!.peers.length, 1, "one granted peer");
  assert.equal(sv!.peers[0]!.pubkey, pubkey);
  assert.equal(sv!.peers[0]!.level, "suggest");
  assert.ok(sv!.peers[0]!.fingerprint, "peer fingerprint surfaced");
  assert.equal(sv!.lastSyncedAt, null, "never synced → null");

  // Once a note records a peer pull, lastSyncedAt reflects the newest clock.
  const fed = getFederatedByKey("view-k1")!;
  const syncedAt = Date.now();
  upsertFederatedNote({ ...fed, peer_synced_at: syncedAt });
  const list2 = (await (await ownerReq("/spaces")).json()) as SpaceView[];
  const sv2 = list2.find((s) => s.id === spaceId)!;
  assert.equal(sv2.lastSyncedAt, syncedAt, "lastSyncedAt = newest peer_synced_at");
});

// ── 4. runtime federation toggle (owner-only, persisted) ─────────────────────
test("POST /acl/federation/enabled toggles the runtime flag; owner-only; status reflects it", async () => {
  // .env.test default is OFF.
  assert.equal(getFederationEnabled(), false);
  assert.equal((await (await ownerReq("/federation/status")).json() as { enabled: boolean }).enabled, false);

  // A non-owner (no session cookie) is denied by the /acl gate and changes nothing.
  const anon = await acl.request("/federation/enabled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(anon.status, 403);
  assert.equal(getFederationEnabled(), false);

  // Owner enables → persisted + status flips.
  const on = await ownerReq("/federation/enabled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(on.status, 200);
  assert.equal((await on.json() as { enabled: boolean }).enabled, true);
  assert.equal(getFederationEnabled(), true);
  assert.equal((await (await ownerReq("/federation/status")).json() as { enabled: boolean }).enabled, true);

  // Missing/!boolean body → 400 (flag unchanged).
  const bad = await ownerReq("/federation/enabled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
  assert.equal(getFederationEnabled(), true);

  // Owner disables again.
  const off = await ownerReq("/federation/enabled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await off.json() as { enabled: boolean }).enabled, false);
  assert.equal(getFederationEnabled(), false);
});

test("owner can reject a mirror request → marked rejected, no space materialized", async () => {
  const spaceId = "space-reject";
  const { token } = pairedPeer(spaceId);
  const posted = (await (await mirror(token, { spaceId, notes: [{ spaceNoteKey: "snk-r", kind: "document" }] })).json()) as { requestId: string };

  const res = await ownerReq(`/federation/mirrors/${posted.requestId}/reject`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { status: string }).status, "rejected");

  assert.equal(listMirrorRequests("rejected").length, 1);
  assert.equal(listMirrorRequests("pending").length, 0);
  assert.equal(getSpace(spaceId), null, "reject does not create the space");
});

test("GET /acl/federation/mirrors lists pending requests (owner-only)", async () => {
  const spaceId = "space-list";
  const { pubkey, token } = pairedPeer(spaceId);
  await mirror(token, { spaceId, spaceTitle: "Listed", notes: [{ spaceNoteKey: "snk-l", kind: "document" }] });

  // anon is rejected (owner-only surface)
  assert.equal((await acl.request("/federation/mirrors")).status, 403);

  const res = await ownerReq("/federation/mirrors?status=pending");
  assert.equal(res.status, 200);
  const list = (await res.json()) as Array<{ peer: string; spaceId: string; spaceTitle: string; status: string; notes: unknown[] }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.peer, pubkey);
  assert.equal(list[0]!.spaceId, spaceId);
  assert.equal(list[0]!.status, "pending");
  assert.equal(list[0]!.notes.length, 1);
});
