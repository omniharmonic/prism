# Security Review — Roadmap Branch (Publishing + Federation + Onboarding)

Adversarial review of the new attack surface before merge. **Verdict: no critical
or high-severity issues.** Confirmed sound: anon cannot fetch out-of-publication
notes; the `/api/p/:slug/graph` never leaks out-of-set nodes/edges/titles; the
vault token is never exposed on public paths; the password unlock cookie is
per-slug, HMAC-signed, expiry- and timing-safe; all `/acl/*` endpoints are
owner-gated; Ed25519 verification is correct and never throws; unpaired/ungranted
keys cannot authenticate via federation; federation is byte-for-byte inert when
`FEDERATION_ENABLED` is off; no space over-match; mount order is safe; the DB
layer is fully parameterized (no injection).

## Fixes applied from the review

- **`publicationActor` now filters to `anyone` grants only** (`routes/publish.ts`).
  The synthetic anonymous actor can no longer inherit a specific user's higher
  (edit/own) grant that happens to sit on the published tag. Read-only routes only
  needed `view`, but this removes a latent escalation footgun.
- **Rate limit on `/api/federation/pair`** (`app.ts`). The endpoint is
  anon-reachable; the 144-bit single-use code already makes guessing infeasible,
  this adds defense-in-depth against pairing spam / code-guessing.

## Accepted / documented (not blocking merge)

- **suggest-level connections are writable at the CRDT layer (suggest ≈ edit).**
  This is the *existing* in-document suggestion design: a `suggest` connection
  writes suggestion marks into the live Y.Doc (that IS how tracked changes are
  stored), so the server cannot make it fully read-only without breaking the
  feature. A raw Yjs client at `suggest` level could write non-suggestion content
  to an *already-shared* note (cannot reach other notes). The **federation** peer
  path inherits this, but federation is gated off and its live transport is
  deferred, so there is no active new surface. Hardening to route below-`edit`
  peer writes into the durable `pending_suggestions` store is the natural next
  step when the live two-hub transport is wired.
- **404-vs-403 note-existence oracle on `/api/p/:slug/notes/:id`.** An anon can
  distinguish "note doesn't exist" (404) from "exists but out-of-publication"
  (403). No content leaks (the membership + `effectiveLevel` gate holds). This
  matches the existing main gateway's behavior (`/api/notes/:id` for anon), so it
  is consistent rather than a regression.
- **Peer-connection token is a short-TTL (5 min) bearer credential** with no
  challenge/nonce — replayable within its window if captured off the wire.
  Mitigated by TLS, the short TTL, and the gated-off default; mirrors the
  capability-link bearer model. A connection nonce is an optional future
  hardening.
- **`isLocalRequest` deployment invariant.** The owner-token escalation paths
  (`actor.ts`, `collab.ts`) depend on the public entrypoint stamping
  `x-forwarded-for`/`x-real-ip`/`cf-connecting-ip`. Never expose the raw server
  port without such a proxy. (Pre-existing; already documented in CLAUDE.md.)
