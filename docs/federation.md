# Parachute-to-Parachute Federation

Federation lets two independently-owned Prism hubs collaborate on a shared set of notes —
peer-to-peer, with no central server. It is built on the same type-aware Hocuspocus
collab layer, extended with cryptographic peer trust and content-independent note
identity.

**This whole horizon is gated.** Nothing federation-related runs unless the server is
started with `FEDERATION_ENABLED=true`. The `federation-manager.ts` module (which loads
the `@hocuspocus/provider` client) is imported **lazily**, so the default, non-federation
deployment never even pulls it in. The owner-side management endpoints (`/acl/peers*`,
`/acl/spaces*`) work regardless, but they only mutate the local ACL/identity store — no
live bridge comes up unless the flag is on.

> **Honesty note.** The trust, identity, and in-process invariants are built and tested
> (14/14 invariant tests at P2). **Live two-hub convergence is not yet exercised** — see
> *Deferred gaps* at the bottom. Don't deploy this expecting turnkey cross-hub sync today.

Source of truth: `apps/server/src/routes/federation.ts` (peer-facing),
`apps/server/src/routes/acl.ts` (owner management), and
`apps/server/src/federation-manager.ts` (the live bridge, with the gaps documented in its
header).

---

## Trust: Ed25519 pairing

Each hub has a stable **Ed25519 identity** (`auth/peer.ts`, `serverKeyPair()`). Pairing is
a one-time, owner-driven handshake that exchanges and records public keys.

1. **Owner A creates a pairing code** (owner-only):

   ```bash
   curl -X POST https://hub-a.example.com/acl/peers/pair \
     -H 'Content-Type: application/json' --cookie '<owner-session>' \
     -d '{"label":"Hub B"}'
   ```

   The response returns the raw **code** (shown once — hand it to the peer out-of-band),
   plus A's `serverPublicKey` and `fingerprint`. Only the code's sha256 hash is stored;
   it is single-use with a 7-day TTL (the invite pattern).

2. **Hub B redeems the code** against A's peer-facing endpoint (this is hub-to-hub, not a
   browser call):

   ```bash
   curl -X POST https://hub-a.example.com/api/federation/pair \
     -H 'Content-Type: application/json' \
     -d '{"code":"<the-code>","pubkey":"<hub-b-ed25519-pubkey>","label":"Hub B"}'
   ```

   A validates the pubkey, consumes the code, stores B as a peer, and returns A's identity
   so the handshake is mutual. `GET /api/federation/identity` exposes a hub's public
   identity for human fingerprint verification.

Owner management of peers: `GET /acl/peers` (list), `GET /acl/peers/identity` (own
identity), `DELETE /acl/peers/:pubkey` (unpair — also drops that peer's grants).

Everything that follows is authorized by the peer's **Ed25519 pubkey** (grants with
`subject_type=peer`); the pairing code only gatekeeps registration.

---

## Spaces and `space_note_key` identity

A **space** is an owner-managed collection of notes that gets shared with peers. Spaces
decouple "which notes" from "who can sync them."

- **Create / list / delete:** `POST /acl/spaces`, `GET /acl/spaces`,
  `DELETE /acl/spaces/:id`. A space carries optional tag-scope hints (`includeTags`,
  `excludeTags`, `pathPrefix`).
- **Add a note:** `POST /acl/spaces/:id/notes` with `{ noteId }`. This mints a
  **`space_note_key`** — a random, content-independent id that *both hubs share* for that
  note — and **pins the collab kind** (document/code/spreadsheet/canvas) at join time. The
  pinned kind is a corruption guard: an inbound peer update can never reseed the note as
  the wrong shape.
- **Grant a peer:** `POST /acl/spaces/:id/peers` with `{ pubkey, level }` (revoke with
  `DELETE /acl/spaces/:id/peers/:pubkey`). The grant is `subject_type=peer`,
  `resource_type=space`. `effectiveLevel` extends to space membership via
  `NoteRef.spaceIds`, so a peer's access to a federated note flows from its space grant.

The `space_note_key` is the linchpin of the **one-doc model** (see
`federation-manager.ts`): each hub serves a single Y.Doc under `documentName ==
space_note_key`, and the manager binds a `HocuspocusProvider` (a client) from that exact
doc to the peer hub's `/collab`, also named `space_note_key`. Because both sides bind the
same doc id, local edits flow out and peer edits land in and persist to the local vault
via one path — no double-write, no echo loop (Yjs updates are idempotent and the sync
protocol exchanges state vectors).

---

## Suggest-mode: the durable inbox

Federation honors the same permission levels as collab (`view < comment < suggest < edit
< own`). A peer (or collaborator) granted **suggest** level doesn't edit directly; their
proposed change is recorded as a **durable suggestion** that survives a server restart, in
the `pending_suggestions` table. The owner reviews it:

```bash
curl https://hub-a.example.com/acl/suggestions?status=pending --cookie '<owner-session>'
curl -X POST .../acl/suggestions/:id/accept --cookie '<owner-session>'
curl -X POST .../acl/suggestions/:id/reject --cookie '<owner-session>'
curl -X DELETE .../acl/suggestions/:id --cookie '<owner-session>'
```

Accept/reject is a status transition; applying an accepted suggestion to the live doc is
handled by the collab/federation layer when that note next loads (gated path).

---

## Deferred gaps (need a second live hub + vault)

These are documented honestly in the `federation-manager.ts` header and flagged for live
two-hub validation. The in-process invariants (tokens, peer-auth, kind-pinning, space
grants, outbox replay) are tested; what's **not** yet wired end-to-end:

1. **Peer-URL registry.** The `peers` table has no URL column. `syncSpaces()` takes the
   peer→collab-WS-URL mapping from the **caller**; `start()` alone binds nothing live. A
   follow-up adds `peers.collab_url` (or a separate registry) so the manager can
   self-discover peer endpoints.
2. **Client routing by `space_note_key`.** For the one-doc model to hold, a hub's own
   browser/desktop clients must open a federated note under its `space_note_key` (so they
   share the very doc the bridge binds), not under the bare local id. The in-app swap
   (`Canvas.tsx` `COLLAB_TYPES`) and web `CollabDoc` don't yet route federated notes to
   their `space_note_key` — until they do, local editing still works via `local_id` but is
   **not** live-bridged.
3. **Two-hub convergence.** Real bidirectional A⇄B convergence, reconnect/outbox replay,
   and conflict behavior can only be validated against a second running hub + vault. The
   durable offline outbox is implemented and unit-covered; live convergence is the next
   milestone.

Until those land, treat federation as **plumbing complete, transport pending**: pair,
build spaces, grant peers, and stage suggestions — but expect to drive the live bridge
manually (`syncSpaces([{ pubkey, url }])`) and validate against a second hub before
relying on cross-hub sync.
