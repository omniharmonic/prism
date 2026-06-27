/**
 * Federation foundation invariants — the in-process companion to
 * verify-collab-share.ts. These assert the GATED federation primitives without a
 * second hub (live two-hub convergence is a separate milestone — see the gaps in
 * federation-manager.ts). Run:
 *
 *   cd apps/server && node --env-file=.env --import tsx scripts/verify-federation.ts
 *
 * Covers: peer-conn token round-trip (+ tamper/expiry), resolveLevel's federation
 * branch (paired peer + space grant → level; unpaired / wrong space → null),
 * kind-pinning via federationTarget, effectiveLevel space-grant matching, and the
 * durable outbox. Operates on throwaway `_test` rows and cleans them up.
 */
import { config } from "../src/config";
// Federation primitives are GATED behind config.federationEnabled. Force it on
// for this invariant check regardless of .env (it only affects this process).
(config as { federationEnabled: boolean }).federationEnabled = true;

import { randomUUID } from "node:crypto";
import { vault } from "../src/parachute";
import { serverKeyPair } from "../src/auth/peer";
import { signPeerConnToken, verifyPeerConnToken } from "../src/auth/peer-conn";
import { resolveLevel, federationTarget } from "../src/collab";
import { effectiveLevel } from "../src/permissions";
import {
  createSpace,
  deleteSpace,
  upsertPeer,
  removePeer,
  upsertGrant,
  removeGrantBySubjectResource,
  upsertFederatedNote,
  deleteFederatedNote,
  grantsForPeer,
  queueOutbox,
  outboxForPeer,
  clearOutboxItem,
  type Grant,
} from "../src/db";

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "✅" : "❌"} ${n}${extra ? ` — ${extra}` : ""}`);
  c ? pass++ : fail++;
};

const myPubkey = serverKeyPair().publicKeyB64url;
const spaceId = `space-test-${randomUUID()}`;
const otherSpaceId = `space-test-${randomUUID()}`;
const spaceNoteKey = randomUUID();
let noteId = "";

async function main() {
  console.log("=== 1. peer-conn token round-trip ===");
  {
    const token = signPeerConnToken(spaceId);
    const claims = verifyPeerConnToken(token);
    ok(
      "valid token verifies with my pubkey + space",
      !!claims && claims.pubkey === myPubkey && claims.spaceId === spaceId,
      claims ? `pubkey=${claims.pubkey.slice(0, 12)}… space=${claims.spaceId === spaceId}` : "null",
    );
    // Tamper the body (first char) → signature no longer matches → null.
    const tampered = (token[0] === "A" ? "B" : "A") + token.slice(1);
    ok("tampered body → null", verifyPeerConnToken(tampered) === null);
    // Already-expired token → null.
    ok("expired token → null", verifyPeerConnToken(signPeerConnToken(spaceId, -1000)) === null);
    ok("garbage → null", verifyPeerConnToken("not-a-token") === null);
  }

  console.log("\n=== 2. resolveLevel federation branch ===");
  {
    // Seed: a real note, a space, a self-paired peer (my own pubkey), a federated
    // note row keyed by space_note_key, and a peer→space grant at "edit".
    const note = await vault.createNote({ content: "# fed test\n\nbody", path: `_test/fed/${spaceNoteKey}.md` });
    noteId = note.id;
    createSpace({ id: spaceId, title: "test", scope_include_tags: "[]", scope_exclude_tags: "[]", path_prefix: null, created_by: "verify-fed" });
    upsertPeer({ pubkey: myPubkey, label: "self-test", paired_at: Date.now() });
    upsertFederatedNote({ space_note_key: spaceNoteKey, space_id: spaceId, local_id: noteId, kind: "document", peer_synced_at: null, source_updated_at: null });
    upsertGrant({ subject_type: "peer", subject: myPubkey, resource_type: "space", resource: spaceId, level: "edit", created_by: "verify-fed" });

    const granted = await resolveLevel(spaceNoteKey, signPeerConnToken(spaceId), null);
    ok("paired peer + space grant → granted level", granted === "edit", `got=${granted}`);

    // Wrong space in the token → spaceId mismatch → null.
    const wrongSpace = await resolveLevel(spaceNoteKey, signPeerConnToken(otherSpaceId), null);
    ok("wrong space in token → null", wrongSpace === null, `got=${wrongSpace}`);

    // Unpaired peer (clear paired_at) → null.
    upsertPeer({ pubkey: myPubkey, label: "self-test", paired_at: null });
    const unpaired = await resolveLevel(spaceNoteKey, signPeerConnToken(spaceId), null);
    ok("unpaired peer → null", unpaired === null, `got=${unpaired}`);
    upsertPeer({ pubkey: myPubkey, label: "self-test", paired_at: Date.now() }); // restore

    // No grant → null (remove the space grant, then restore).
    removeGrantBySubjectResource("peer", myPubkey, "space", spaceId);
    const noGrant = await resolveLevel(spaceNoteKey, signPeerConnToken(spaceId), null);
    ok("no space grant → null", noGrant === null, `got=${noGrant}`);
    upsertGrant({ subject_type: "peer", subject: myPubkey, resource_type: "space", resource: spaceId, level: "edit", created_by: "verify-fed" });
  }

  console.log("\n=== 3. kind-pinning via federationTarget ===");
  {
    const target = federationTarget(spaceNoteKey);
    ok("federated key → { noteId: local_id, kind: pinned }", target.noteId === noteId && target.kind === "document", `noteId=${target.noteId === noteId} kind=${target.kind}`);
    const plain = federationTarget(noteId);
    ok("non-federated id → { noteId: id, no kind }", plain.noteId === noteId && plain.kind === undefined, `kind=${plain.kind}`);
  }

  console.log("\n=== 4. effectiveLevel space-grant matching ===");
  {
    const grants: Grant[] = grantsForPeer(myPubkey);
    const withSpace = effectiveLevel(grants, { id: noteId, tags: [], spaceIds: [spaceId] }, false);
    ok("grant matches NoteRef carrying the spaceId", withSpace === "edit", `got=${withSpace}`);
    const withoutSpace = effectiveLevel(grants, { id: noteId, tags: [] }, false);
    ok("grant does NOT match NoteRef without the spaceId", withoutSpace === null, `got=${withoutSpace}`);
  }

  console.log("\n=== 5. durable outbox round-trip ===");
  {
    const peerKey = `peer-test-${randomUUID()}`;
    const blob = new Uint8Array([1, 2, 3, 4]);
    queueOutbox(spaceNoteKey, peerKey, blob);
    const items = outboxForPeer(peerKey);
    ok("queueOutbox → outboxForPeer returns it", items.length === 1 && items[0]?.update_blob.length === 4, `n=${items.length}`);
    for (const it of items) clearOutboxItem(it.id);
    ok("clearOutboxItem empties the buffer", outboxForPeer(peerKey).length === 0);
  }
}

main()
  .catch((e) => {
    console.error("ERROR:", e);
    fail++;
  })
  .finally(async () => {
    try {
      removeGrantBySubjectResource("peer", myPubkey, "space", spaceId);
      deleteFederatedNote(spaceNoteKey);
      removePeer(myPubkey);
      deleteSpace(spaceId);
      if (noteId) await vault.deleteNote(noteId);
    } catch {
      /* best-effort cleanup */
    }
    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail === 0 ? 0 : 1);
  });
