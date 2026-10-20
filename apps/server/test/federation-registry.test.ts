/**
 * Federation registry invariants (Layer A, no live vault/WS) — locks in the
 * GAP 1 (peer collab_url capture) and GAP 2 (gated /api/federated route) work.
 *
 * This file deliberately does NOT force `config.federationEnabled` on (it stays
 * at the .env.test default of OFF), so it can assert the GATED-OFF behaviour of
 * the /api/federated route. The enabled path lives in its own process in
 * test/federated-route.test.ts (env set before import). Pure db + in-process
 * Hono request tests on the fake vault; no FederationManager bindings spun up.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { config } from "../src/config";
import { federated } from "../src/routes/federated";
import { federation } from "../src/routes/federation";
import {
  upsertPeer,
  getPeer,
  listPeers,
  setPeerCollabUrl,
  storePairing,
} from "../src/db";
import { serverKeyPair, generateKeyPairB64url } from "../src/auth/peer";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

// Sanity: this process runs with federation OFF (the .env.test default).
test("federation is gated off in this process (no FEDERATION_ENABLED)", () => {
  assert.equal(config.federationEnabled, false);
});

// ── GAP 2: /api/federated route, gated off ───────────────────────────────────
test("GET /api/federated/:id → 204 with empty body when federation is disabled", async () => {
  const res = await federated.request("/anything-at-all");
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});

// ── GAP 1: peers.collab_url registry round-trip ──────────────────────────────
test("upsertPeer stores collab_url; a later urless upsert preserves it (COALESCE)", () => {
  const pubkey = "peer-pk-1";
  upsertPeer({ pubkey, collab_url: "ws://b/collab", paired_at: 1234 });
  assert.equal(getPeer(pubkey)!.collab_url, "ws://b/collab");

  // a second upsert WITHOUT collab_url must not wipe the stored url.
  upsertPeer({ pubkey, label: "x" });
  const after = getPeer(pubkey)!;
  assert.equal(after.collab_url, "ws://b/collab", "COALESCE preserves the existing url");
  assert.equal(after.label, "x", "other fields still update");
});

test("setPeerCollabUrl updates and clears the url; listPeers includes collab_url", () => {
  const pubkey = "peer-pk-2";
  upsertPeer({ pubkey, collab_url: "ws://b/collab", paired_at: 1 });

  setPeerCollabUrl(pubkey, "ws://c/collab");
  assert.equal(getPeer(pubkey)!.collab_url, "ws://c/collab");

  setPeerCollabUrl(pubkey, null);
  assert.equal(getPeer(pubkey)!.collab_url, null);

  // listPeers surfaces the column.
  const listed = listPeers();
  assert.equal(listed.length, 1);
  assert.ok("collab_url" in listed[0]!, "listPeers rows carry collab_url");
  assert.equal(listed[0]!.collab_url, null);
});

// ── GAP 1: pairing captures the advertised collab_url ────────────────────────
test("POST /api/federation/pair captures a valid ws:// collabUrl on the peer", async () => {
  const { publicKeyB64url: peerPub } = generateKeyPairB64url();
  const code = "pair-code-with-url";
  storePairing(createHash("sha256").update(code).digest("hex"), "laptop", "owner@test.local", 10 * 60_000);

  const res = await federation.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, pubkey: peerPub, collabUrl: "ws://localhost:8788/collab" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; serverPublicKey: string };
  assert.equal(body.ok, true);
  assert.equal(body.serverPublicKey, serverKeyPair().publicKeyB64url);

  assert.equal(getPeer(peerPub)!.collab_url, "ws://localhost:8788/collab");
});

test("POST /api/federation/pair ignores a non-ws collabUrl (stored null)", async () => {
  const { publicKeyB64url: peerPub } = generateKeyPairB64url();
  const code = "pair-code-bad-url";
  storePairing(createHash("sha256").update(code).digest("hex"), "laptop", "owner@test.local", 10 * 60_000);

  const res = await federation.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, pubkey: peerPub, collabUrl: "http://evil" }),
  });
  assert.equal(res.status, 200);
  assert.equal(getPeer(peerPub)!.collab_url, null, "a non-ws url is ignored");
});
