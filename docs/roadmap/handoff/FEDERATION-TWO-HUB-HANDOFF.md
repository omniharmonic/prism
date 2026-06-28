# Federation Two-Hub Handoff — Stand up a second hub and verify hub-to-hub CRDT convergence

**Target doc:** `docs/roadmap/handoff/FEDERATION-TWO-HUB-HANDOFF.md`
**Goal:** Bring up a second Parachute vault+hub and a second Prism Server, pair them, share a space, and prove a live edit on hub A converges into hub B's vault (and back). This requires building three pieces of glue first, then running an end-to-end procedure.
**Audience:** A local Claude Code agent with a live environment (Parachute vault + hub, the desktop app, a browser). The authoring agent had none of these.

---

## ✅ STATUS (2026-06-28) — LIVE TWO-HUB CONVERGENCE PASSED (12 PASS / 0 FAIL / 2 SKIP)

The harness was run live against two real stacks on one box: Hub A = the running
prism-server (:8787, default vault), Hub B = an isolated `fed-b` vault + a second
Prism Server (:8788), both with `FEDERATION_ENABLED=true` and stable
`PEER_SIGNING_KEY`s. Result:

- **AC-1/2** two independent stacks, distinct fingerprints (`3a:c7…` vs `d9:e7…`), bidirectional pairing ✓
- **AC-3/4** space + `space_note_key` mint, B-side mirror, peer edit grants both ways ✓
- **AC-6** clients route by `space_note_key` (GAP 2) — `/api/federated/:id` returns the key on both, 204 for non-federated ✓
- **AC-7 A→B** and **AC-8 B→A** — a live `/collab` edit converged into the FAR hub's vault within 15s, both directions ✓
- **AC-9** offline outbox flush — edited A while B was down, restarted B, the edit **replayed to B on reconnect** ✓
- **AC-11** revocation stops sync — after `DELETE /acl/spaces/:id/peers/:pubkey`, an A edit did NOT reach B ✓
- **AC-5** binding live (implied by AC-7); **AC-10/AC-12** skipped (covered by `verify-federation.ts` 14/14 + `test/federation.test.ts`).

Teardown removed all test data and the `fed-b` sandbox; Hub A was reverted to
`FEDERATION_ENABLED=false` (the live server's default), with its stable
`PEER_SIGNING_KEY` kept so re-enabling is a one-flag flip. The only remaining
follow-up is productionization: a `/api/federation/mirror` endpoint to replace the
harness's manual B-side SQLite insert, and AC-10 suggest-mode over a real client.

## STATUS (2026-06) — GAP 1 + GAP 2 DONE; GAP 3 harness + bring-up now exist

- **GAP 1 — peer collab-URL registry + auto-`syncSpaces`: DONE in-repo.** `peers.collab_url` exists (`db.ts`, with a migration), `/api/federation/pair` accepts a `collabUrl`, and there is an owner-only `POST /acl/peers/:pubkey/url` to set it after the fact. `FederationManager.syncSpaces()` self-discovers endpoints from `peers.collab_url` and is invoked **automatically** on startup (`collab.ts` `attachCollab`) and after every federation-relevant ACL mutation (`kickFederationSync` in `routes/acl.ts`). No manual `syncSpaces([...])` call is needed once a peer's `collab_url` is set.
- **GAP 2 — clients open federated notes by `space_note_key`: DONE in-repo.** `GET /api/federated/:noteId` (`routes/federated.ts`, mounted before the `/api` gateway) maps a local note id → `{ spaceNoteKey, spaceId, kind }` (204 when federation is off or the note isn't federated). Web `CollabDoc.tsx` and desktop `DesktopCollabDocument.tsx` resolve the doc name to that key before connecting.
- **GAP 3 — live two-hub convergence: harness + isolated bring-up now exist.**
  - `apps/server/scripts/verify-two-hub.ts` — the live A⇄B convergence harness (`node --import tsx scripts/verify-two-hub.ts`). Hub-agnostic: reads both stacks' `.env`/`.env.b`, talks to each gateway with the owner Bearer, signs peer-conn tokens locally from each `PEER_SIGNING_KEY`, and drives the live `/collab` as a Yjs client under the shared `space_note_key`. Maps to AC-1..AC-12 (AC-5 implied by AC-7; AC-9 is operator-gated via `TWO_HUB_AC9=1`; AC-10/AC-12 deferred to the in-process suites).
  - `apps/server/scripts/two-hub-up.sh` (+ `.env.b.example`) — idempotent, ISOLATED bring-up of Hub B (a **separate `fed-b` vault**, its own token, `prism-b.db`, port `8788`, generated secrets incl. a stable `PEER_SIGNING_KEY`). It does **not** touch the live default vault.
  - The remaining work is the **live run** against two running stacks, plus the productionization follow-ups (a `/api/federation/mirror` endpoint to replace the harness's B-side SQLite insert; AC-10 suggest-mode over a real client).

> The repo no longer has client-routing or auto-bind gaps. What's left is operational: stand up Hub B (`two-hub-up.sh`), then run `verify-two-hub.ts`.

---

## 0. TL;DR — what is real vs. what you must build

| Layer | Status | Notes |
|---|---|---|
| Ed25519 peer identity, signing, fingerprint | **BUILT** | `apps/server/src/auth/peer.ts`, `peer-conn.ts`. Tested. |
| Pairing handshake (mint code → redeem) | **BUILT** | `routes/acl.ts` `/peers/pair`, `routes/federation.ts` `/pair`. |
| One-doc transport bridge (`PeerBinding` ⇄ peer `/collab`) | **BUILT** | `federation-manager.ts`. Idempotent, kind-pinned, outbox-buffered. |
| Server-side collab auth for federated docs | **BUILT** | `collab.ts` `resolveLevel` federation branch (lines 383–405), `federationTarget` (124–130). |
| Space / federated-note / peer-grant ACL endpoints | **BUILT** | `routes/acl.ts` lines 344–478. |
| DB schema (peers, spaces, federated_notes, outbox, suggestions) | **BUILT** | `db.ts` lines 92–168. |
| In-process invariant tests | **BUILT** | `scripts/verify-federation.ts` (14), `test/federation.test.ts` (42). |
| **GAP 1 — peer collab-URL registry** | **MISSING / BUILD** | `peers` has no URL column; `syncSpaces(endpoints)` takes URLs from the caller and **nothing ever calls it**. |
| **GAP 2 — clients open federated notes by `space_note_key`** | **MISSING / BUILD** | Web `CollabDoc.tsx` (line 190) and desktop `DesktopCollabDocument.tsx` (line 91) both connect by `noteId`. Local edits never reach the bridge. |
| **GAP 3 — live two-hub convergence ever exercised** | **MISSING / BUILD** | No script starts a 2nd hub+vault and asserts A⇄B sync. |

> The transport is done. The **client routing is stubbed and is the blocking gap.** Without GAP 2, a hub's own browser opens a *different* Y.Doc than the one the bridge syncs — edits are persisted locally but never federated. Without GAP 1, `syncSpaces` is never invoked, so no `PeerBinding` is ever created.

All three gaps are stated verbatim in the `federation-manager.ts` header (lines 28–43) and in `docs/federation.md` lines 117–134 — they are honest, not surprises.

---

## 1. Topology

Two fully independent stacks. **Do not** share SQLite files, secrets, or ports.

```
        HUB A                                         HUB B
  ┌──────────────────────┐                      ┌──────────────────────┐
  │ Parachute vault+hub A │  vault REST/MCP      │ Parachute vault+hub B │
  │   hub :1939 / api :1940                      │   hub :2939 / api :2940
  └─────────▲────────────┘                      └─────────▲────────────┘
            │ PARACHUTE_TOKEN_A                            │ PARACHUTE_TOKEN_B
  ┌─────────┴────────────┐    pair (one-time     ┌─────────┴────────────┐
  │ Prism Server A        │◀── code, out-of-band) │ Prism Server B        │
  │  HTTP :8787           │    Ed25519 pubkeys     │  HTTP :8788           │
  │  WS  /collab          │◀═══ federated Y.Doc ══▶│  WS  /collab          │
  │  PEER_SIGNING_KEY_A   │   (HocuspocusProvider) │  PEER_SIGNING_KEY_B   │
  │  FEDERATION_ENABLED=1 │   name=space_note_key  │  FEDERATION_ENABLED=1 │
  └──────────────────────┘                        └──────────────────────┘
```

Per-hub distinct values: Parachute ports, `PARACHUTE_TOKEN`, `SESSION_SECRET`, `CAPABILITY_SECRET`, `COLLAB_TOKEN`, `OWNER_EMAIL`, `PEER_SIGNING_KEY`, HTTP port, SQLite db path.

The `space_note_key` (a UUID) is the **only** shared identifier — it is the Yjs `documentName` both hubs serve. Each hub maps it to its own `local_id` via `federationTarget` (`collab.ts:124`).

---

## 2. CONFIGURE — stand up the two stacks

### 2.1 Two Parachute vaults+hubs

Run a second Parachute hub+vault on a non-default port. Two clean options:

- Second install on shifted ports (hub `2939`, vault API `2940`), OR
- `docker compose` with two services on distinct published ports.

For each hub, mint a write token for its Prism Server:

```bash
# Hub A (default ports)
parachute auth mint-token --scope vault:default:write
# Hub B (point your parachute CLI / config at hub B's hub port, e.g. 2939)
parachute auth mint-token --scope vault:default:write
```

Record: `PARACHUTE_URL_A=http://localhost:1940`, `PARACHUTE_URL_B=http://localhost:2940`, and the two tokens.

**PASS:** `curl -s $PARACHUTE_URL_A/vault/default/api/... -H "Authorization: Bearer $TOK_A"` and the same against B both return note JSON, from two *different* note sets.

### 2.2 Generate two stable Ed25519 identities (PEER_SIGNING_KEY)

`PEER_SIGNING_KEY` must be a **PKCS8 DER private key, base64url**. The exact generator is `generateKeyPairB64url()` in `apps/server/src/auth/peer.ts` (lines 70–76); it returns `{ privateKeyB64url, publicKeyB64url }`. Use `privateKeyB64url` as the env value.

```bash
cd /home/user/prism/apps/server
node --import tsx -e 'import("./src/auth/peer.ts").then(m => console.log(JSON.stringify(m.generateKeyPairB64url(), null, 2)))'
# Run TWICE — once for A, once for B. Keep the two privateKeyB64url values.
```

If `PEER_SIGNING_KEY` is unset the server generates an **ephemeral** identity and warns (`peer.ts:50`) — pairing then breaks on restart. Always set it for this test.

### 2.3 Two `.env` files

`apps/server/.env` (Hub A) and `apps/server/.env.b` (Hub B). Required keys (see `config.ts`):

| Key | Hub A | Hub B |
|---|---|---|
| `PARACHUTE_URL` | `http://localhost:1940` | `http://localhost:2940` |
| `PARACHUTE_TOKEN` | token A | token B |
| `SESSION_SECRET` | unique A | unique B |
| `CAPABILITY_SECRET` | unique A | unique B |
| `COLLAB_TOKEN` | unique A | unique B |
| `OWNER_EMAIL` | `ownerA@example.com` | `ownerB@example.com` |
| `PEER_SIGNING_KEY` | privateKeyB64url A | privateKeyB64url B |
| `FEDERATION_ENABLED` | `true` | `true` |
| `PORT` | `8787` | `8788` |
| `DB_PATH` (if supported; else point each at a distinct dir) | `./prism-a.db` | `./prism-b.db` |

> `assertConfig()` fails fast on missing required secrets — if a server exits on boot, read its stderr; it names the missing key.

### 2.4 Start both servers

```bash
cd /home/user/prism/apps/server
node --env-file=.env   --import tsx src/index.ts   # Hub A → :8787
# second terminal:
node --env-file=.env.b --import tsx src/index.ts   # Hub B → :8788
```

**PASS:** `curl -s localhost:8787/auth/me` and `localhost:8788/auth/me` both respond; both logs show the collab WS attached and **no** "EPHEMERAL Ed25519 identity" warning. `curl -s localhost:8787/api/federation/identity` returns `{publicKey, fingerprint}` for A; same on :8788 for B, and `fingerprintA != fingerprintB`.

---

## 3. BUILD — the three glue pieces (do these BEFORE the live test)

### GAP 1 — peer collab-URL registry + auto-invoke `syncSpaces`

**Problem:** `peers` table has no URL column (`db.ts:95`). `federationManager.syncSpaces(endpoints)` (`federation-manager.ts:211`) needs `{pubkey, url}[]`, and **no code path calls it** — `attachCollab` only calls `federationManager.start()` (`collab.ts:609–616`), which binds nothing (`start()` just flips a flag, `federation-manager.ts:193–196`).

**Build plan:**

1. **Schema:** add `collab_url TEXT` to `peers` in `db.ts` (line ~95). Add a `setPeerCollabUrl(pubkey, url)` and have `getPeer`/`listPeers` include it.
2. **Capture the URL at pairing time.** The redeeming peer should advertise its `/collab` WS URL. In `routes/federation.ts` `/pair` (line 28) accept an optional `collabUrl` in the body and persist it via `upsertPeer`. In `routes/acl.ts` `/peers/pair` (line 350), the minting owner can't know the peer URL yet, so also expose a small `POST /acl/peers/:pubkey/url { collabUrl }` (owner-gated) to set it after redemption.
3. **Self-discover endpoints in `syncSpaces`.** Change `syncSpaces` to default-source URLs from `getPeer(g.subject).collab_url` when the caller passes none, instead of skipping (`federation-manager.ts:227–228`). Keep the `endpoints` param as an override for tests.
4. **Invoke it.** In `collab.ts:611` `.then(({ federationManager }) => { federationManager.start(); federationManager.syncSpaces(); … })`. Also call `federationManager.syncSpaces()` after any mutation of spaces/grants/federated-notes in `routes/acl.ts` (the `/spaces/:id/peers`, `/spaces/:id/notes`, and `DELETE` handlers, lines 433–478) so revocation tears bindings down (drives acceptance criterion "revocation stops sync").

**PASS:** After pairing + granting + adding a note, `federationManager.activeBindings()` (`federation-manager.ts:250`) returns a non-empty array containing `${space_note_key}::${peerPubkey}` **without** any manual `syncSpaces([...])` call. After `DELETE /acl/spaces/:id/peers/:pubkey`, it drops back to empty.

### GAP 2 — clients open federated notes by `space_note_key`

**Problem:** Web `CollabDoc.tsx:190` and desktop `DesktopCollabDocument.tsx:91` both pass `name: noteId` to `HocuspocusProvider`. For a federated note the bridge serves the doc under `space_note_key`, so the hub's own browser and the bridge open **different docs** — local edits are persisted to the vault but never federated. This is the blocking gap.

**Build plan:**

1. **Expose the mapping.** The cleanest path (avoids a per-open round-trip — see Open Questions) is to carry it on the note. Add the note's `space_note_key` to the data the client already has: either include it in the note payload the gateway returns, or add a lightweight `GET /api/federated/:noteId → { spaceNoteKey } | 204`. Mount it under `/api/*` so the PWA service-worker denylist already covers it (CLAUDE.md "Gotchas").
2. **Web:** in `apps/web/src/collab/CollabDoc.tsx`, before `new HocuspocusProvider` (line 188), resolve the doc name: `const docName = federatedKey ?? noteId;` and pass `name: docName`. Effects keyed on `[noteId, ydoc]` (line 202) should key on `[docName, ydoc]`.
3. **Desktop:** same change in `apps/desktop/src/data/DesktopCollabDocument.tsx` around line 89–91 (`name: noteId` → `name: docName`). The desktop in-app live-editor swap is driven by `Canvas.tsx` `COLLAB_TYPES`; the doc-name resolution belongs in `DesktopCollabDocument`, not the swap logic.
4. **Server already cooperates:** `resolveLevel` (`collab.ts:383`) and `federationTarget` (`collab.ts:124`) already detect a `space_note_key` documentName and map it to `local_id`. **No server change needed for routing** — only the client doc name.

**PASS:** Open a federated note in the hub-A browser. In devtools / network, the `/collab` WS message names the doc by the `space_note_key` UUID, **not** the numeric/local note id. A non-federated note still connects by `noteId` (no regression).

### GAP 3 — a live convergence harness

**Problem:** `verify-federation.ts` and `federation.test.ts` use a single self-signed identity (fake vault). Nothing drives two real hubs.

**Build plan:** write `apps/server/scripts/verify-two-hub.ts` (run with `node --import tsx`) that talks to the two already-running stacks over HTTP/WS:

- Mint a peer-conn token via `signPeerConnToken(spaceId)` (`auth/peer-conn.ts:36`) — but for a true end-to-end check prefer driving real browser editors (Playwright) so GAP 2 is exercised too.
- Open the same federated note on A and B, edit on A, poll B's vault (`GET .../api/notes/:id` on hub B) until content matches; then edit on B and poll A.
- Cover offline: kill hub B's process (or block its `/collab`), edit on A, restart B, assert B catches up via outbox replay (`PeerBinding.flush`, `federation-manager.ts:157`).

Keep `test/federation.test.ts` and `verify-federation.ts` green throughout (they must stay passing with federation **disabled** too — 42 + 14).

---

## 4. CONFIGURE — pair, share, and the live procedure

Do GAP 1 & 2 first (GAP 3 harness optional but recommended). Then, with both servers running and an owner session cookie for each (sign in via owner-only magic link — for dev with no `RESEND_API_KEY` the link is logged to the server console):

### 4.1 Pair A → B

```bash
# 1. Mint a one-time code on A (owner-gated). Returns A's pubkey + fingerprint.
curl -s -b A.cookies -X POST localhost:8787/acl/peers/pair \
  -H 'content-type: application/json' -d '{"label":"hub-B"}'
#   → { code, expiresInDays:7, serverPublicKey: <A_pub>, fingerprint: <A_fp> }

# 2. Fetch B's identity (for A to record B's pubkey).
curl -s localhost:8788/api/federation/identity   # → { publicKey: <B_pub>, fingerprint: <B_fp> }

# 3. Redeem the code ON HUB A's peer endpoint, presenting B's pubkey + B's collab URL.
#    (federation.ts /pair runs on the hub that MINTED the code; here that is A.)
curl -s -X POST localhost:8787/api/federation/pair \
  -H 'content-type: application/json' \
  -d '{"code":"<code>","pubkey":"<B_pub>","label":"hub-B","collabUrl":"ws://localhost:8788/collab"}'
#   → { ok:true, serverPublicKey:<A_pub>, fingerprint:<A_fp> }
```

> Note: `/api/federation/pair` registers the *caller's* peer on the hub that issued the code (`routes/federation.ts:28`, `upsertPeer`). So redeeming against **A** registers **B as a peer of A**. For bidirectional sync, repeat symmetrically: mint a code on B (`localhost:8788/acl/peers/pair`), redeem on B with A's pubkey + A's collab URL (`ws://localhost:8787/collab`). After GAP 1, supply `collabUrl` in the redeem body or set it via the new `POST /acl/peers/:pubkey/url`.

**PASS:** `curl -s -b A.cookies localhost:8787/acl/peers` lists B with B's fingerprint and `pairedAt` set; B's peer list shows A. Fingerprints match across the two hubs (operators can read them aloud — `fingerprint()` is deterministic, `peer.ts:122`).

### 4.2 Create a space and add a federated note (on A)

```bash
# Create the space (owner-gated). Tag/path scopes optional.
curl -s -b A.cookies -X POST localhost:8787/acl/spaces \
  -H 'content-type: application/json' -d '{"title":"TestFed"}'        # → { id: <SPACE>, ... }

# Pick/create a DOCUMENT note in hub A's vault; add it to the space.
# This mints space_note_key and PINS the collab kind (acl.ts:433–455).
curl -s -b A.cookies -X POST localhost:8787/acl/spaces/<SPACE>/notes \
  -H 'content-type: application/json' -d '{"noteId":"<A_LOCAL_NOTE_ID>"}'
#   → { space_note_key:<SNK>, space_id:<SPACE>, local_id:<A_LOCAL_NOTE_ID>, kind:"document", ... }

# Grant B edit on the space (acl.ts:458). B must already be a paired peer.
curl -s -b A.cookies -X POST localhost:8787/acl/spaces/<SPACE>/peers \
  -H 'content-type: application/json' -d '{"pubkey":"<B_pub>","level":"edit"}'
```

### 4.3 Mirror on B (Open Question — currently manual)

Hub B needs a `federated_notes` row with the **same** `<SNK>` mapped to B's own local note id, plus a space and a peer/space grant for A. There is **no mirror endpoint yet** (`/api/federation/mirror` is proposed, not built). For the test, either:

- Insert the B-side row directly into B's SQLite `federated_notes` (`space_note_key=<SNK>`, `local_id=<B_LOCAL_NOTE_ID>`, `kind="document"`, `space_id=<B_SPACE>`), and create the A-grant on B; or
- Build the mirror endpoint (recommended follow-up; see Open Questions).

> **One-doc seeding caveat** (`federation-manager.ts` & Open Questions): if both hubs load the note before the first sync, each seeds the Y.Doc from its *own* vault content under `<SNK>`. They converge on first peer update (Yjs is idempotent), but for a clean test start B's note **empty** (or identical to A) so the first convergence is unambiguous.

### 4.4 Bring up the bridge

After GAP 1, `syncSpaces()` runs automatically on startup and after the grant/note mutations above. If you have not yet wired auto-invoke, drive it manually in a tsx REPL against hub A:

```ts
import { federationManager } from "./src/federation-manager";
await federationManager.syncSpaces([{ pubkey: "<B_pub>", url: "ws://localhost:8788/collab" }]);
federationManager.activeBindings();   // → ["<SNK>::<B_pub>"]
```

**PASS:** `activeBindings()` on A contains `"<SNK>::<B_pub>"`; A's log shows no kind-mismatch skip (`federation-manager.ts:99`).

---

## 5. Verification procedure + acceptance criteria

Run after GAP 1 & 2 are built and §4 completed. Use the live browser editors (so GAP 2 is genuinely exercised), with `verify-two-hub.ts` polling vault state on the far hub.

| # | Test | Procedure | PASS criterion |
|---|---|---|---|
| AC-1 | Two independent stacks | `curl /auth/me` on :8787 and :8788; distinct vault data | Both up, distinct note sets, both `FEDERATION_ENABLED=true` |
| AC-2 | Identity exchange | `/api/federation/identity` on both; peer lists | `fingerprintA != fingerprintB`; each lists the other with `pairedAt` |
| AC-3 | Space + key mint | `POST /acl/spaces/:id/notes` on A; mirror on B | Same `<SNK>` registered on both, mapped to each hub's `local_id` |
| AC-4 | Peer grant ≥ edit | `POST /acl/spaces/:id/peers` | A's grant for B is `edit`; B's grant for A is `edit` |
| AC-5 | Binding live | `activeBindings()` on A | Contains `"<SNK>::<B_pub>"` (auto, post-GAP-1) |
| AC-6 | Client routes by key | Open the note in A's browser | `/collab` WS doc name == `<SNK>`, not `noteId` (GAP 2) |
| AC-7 | **A → B convergence** | Type in A's editor | Edit persists to A's vault (`storeDocumentState`) **and** appears in **B's vault** (`GET /api/notes/:id` on :8788) within seconds |
| AC-8 | **B → A convergence** | Type in B's editor | Lands in A's vault and updates A's open editor **without refresh** |
| AC-9 | **Offline outbox flush** | Disconnect B's `/collab` (kill B), edit on A, restart B | Edits queue to `federation_outbox`; on reconnect `PeerBinding.flush` replays; B converges; no duplication/conflict |
| AC-10 | **Suggest → inbox** | Grant B `suggest` (not edit); B proposes a change | Lands in `pending_suggestions` (not the live doc); **survives B restart**; A lists it via `GET /acl/suggestions` and can accept/reject (`acl.ts` /suggestions) |
| AC-11 | **Revocation stops sync** | `DELETE /acl/spaces/:id/peers/:pubkey` on A | `activeBindings()` drops `"<SNK>::<B_pub>"`; a subsequent A edit does **not** reach B |
| AC-12 | No regression | `node --import tsx scripts/verify-federation.ts`; `npm test` (federation suite) | 14/14 and 42/42 still green with federation disabled |

> **Kind-pinning sanity (corruption guard):** AC-7 must show the document persisted as HTML, not wrapped/garbled. If a binding silently does nothing, check A's log for the kind-mismatch warning (`federation-manager.ts:99`) — the pinned kind must equal the live `noteKind`.

---

## 6. Key files (exact refs)

| File | Role / lines |
|---|---|
| `apps/server/src/federation-manager.ts` | One-doc bridge; **all three gaps in header (28–43)**; `syncSpaces` 211; `PeerBinding.flush` 157; `activeBindings` 250 |
| `apps/server/src/collab.ts` | `federationTarget` 124–130; `resolveLevel` federation branch 383–405; `attachCollab` wiring 579–617 (start at 609) |
| `apps/server/src/auth/peer.ts` | `generateKeyPairB64url` 70–76; `fingerprint` 122; ephemeral-key warning 50 |
| `apps/server/src/auth/peer-conn.ts` | `signPeerConnToken` 36; `verifyPeerConnToken` 51 |
| `apps/server/src/routes/acl.ts` | `/peers/pair` 350; `/peers` 365; `/spaces` 405–429; `/spaces/:id/notes` 433–455; `/spaces/:id/peers` 458–478; `/suggestions` 332–342 |
| `apps/server/src/routes/federation.ts` | `/identity` 18; `/pair` 28–55 (`upsertPeer`) |
| `apps/server/src/db.ts` | schema 92–168 (peers 95, spaces 114, federated_notes 127, outbox 140, pending_suggestions 154) — **add `peers.collab_url` (GAP 1)** |
| `apps/server/src/config.ts` | `collabToken` 23, `peerSigningKey` 31, `federationEnabled` 34 |
| `apps/server/src/permissions.ts` | `NoteRef.spaceIds` / `effectiveLevel` space matching (27–56) |
| `apps/server/scripts/verify-federation.ts` | 14 in-process invariants (keep green) |
| `apps/server/test/federation.test.ts` | 42 primitive tests (keep green) |
| `apps/web/src/collab/CollabDoc.tsx` | `collabUrl` 24; `HocuspocusProvider name: noteId` 188–202 — **GAP 2** |
| `apps/desktop/src/data/DesktopCollabDocument.tsx` | `HocuspocusProvider name: noteId` 89–105 — **GAP 2** |
| `docs/federation.md` | user guide; gaps documented 117–134 |

---

## 7. Open questions to resolve while building

1. **`peers.collab_url` column vs. separate registry table?** Findings lean toward a column on `peers` (simplest); decide before GAP 1.
2. **GAP 2 — round-trip vs. note-carried key?** Prefer carrying `space_note_key` on the note payload to avoid a per-open server query.
3. **B-side mirror — endpoint vs. manual?** No `/api/federation/mirror` exists. Manual SQLite insert is fine for the first test; an endpoint is the productionization follow-up.
4. **Convergence scope.** First milestone: online A⇄B + offline outbox replay. Partition/restart storms and outbox overflow/expiry are a later pass.
5. **Double-seed race** (both hubs seed `<SNK>` from differing local content before first sync). Mitigate in the test by starting B's note empty; productionize with a deterministic seed-precedence rule later.
