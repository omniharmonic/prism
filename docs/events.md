# Invalidation channel (`GET /api/events`) — WP7.2

Replaces 5–30 s client polling with a server-pushed "something changed" signal.

## Wire format

SSE. `event: ready` once, then default-`message` events with JSON data, `: ping` every 25 s.

```
data: {"type":"note","id":"<note id>","op":"upsert"}
data: {"type":"note","id":"<note id>","op":"remove"}
data: {"type":"resync"}
```

Never content, path, tags or metadata. No `Last-Event-ID`: events are invalidations, a reconnect makes the client
refetch (`resync`).

## Source

One vault subscribe WebSocket per vault, owned by `src/tree.ts`. `subscribeTreeChanges(entry, listener)` hangs
listeners off it (no second socket). Emitted on: socket `upsert`/`remove` frames, gateway write-through
(owner passthrough, non-owner create/patch/restore/delete), and snapshot replace / rebuild / projection reset
(`resync`). Both the write-through and the socket echo of the same write emit; the client batches them.

## Who sees what (leak-proofing)

Each connection filters every change through the gateway's `capsFor(actor, row).has("view")`:

| change | emitted when |
|---|---|
| upsert | viewable in the row's NEW state **or** its previous state |
| remove | viewable in its previous state |
| resync | always (carries no data) |

An id of a note you can't view is itself information (existence + activity), so a note that was never viewable
produces no frame. A note that just became hidden is emitted because the client may hold it (it refetches, gets
403/404, drops it) — that reveals nothing it didn't already know. The private-note rule rides in `rowRef`
(creator/visibility), as in `/api/tree`.

- Owner/admin: everything in the vault picked by `X-Prism-Vault`. Non-owners: the actor's vault.
- Capability links: allowed, view-scoped identically. Anon: 401.
- Grants are resolved when the stream opens; streams are recycled every `EVENTS_MAX_AGE_MS` (15 min) and the client
  resyncs on reconnect, so revoked grants/sessions stop applying within that bound.

## Limits (env)

`EVENTS_MAX_PER_USER` 8, `EVENTS_MAX_TOTAL` 200 (→ 429 `too_many_streams`), `EVENTS_BUFFER` 200 per connection
(overflow drops the queue and sends one `resync`), `EVENTS_PING_MS` 25000, `EVENTS_MAX_AGE_MS` 900000.

## Client

`@prism/core`: `lib/events/invalidation.ts` (pure mapper, 500 ms batching), `data/InvalidationContext.tsx`
(`InvalidationSourceProvider`, app-wide `InvalidationSubscriber`), `lib/events/channelStatus.ts` (`useLivePollMs`).
Web shell: `apps/web/src/events/httpInvalidationSource.ts` via `streamServerSSE`. Desktop has no gateway and no source.

Polling intervals now use `useLivePollMs(ms)`: the original `ms` while the channel is down (desktop, old server,
reconnecting), `>= 5 min` while it is live. Changed: `Inbox` 10 s, `MessagesDashboard` 10 s,
`VaultMessagesDashboard` 30/30/60 s, `AgentActivity` skills 30 s / dispatches 20 s (5 s desktop; unchanged there),
session list 20 s → 60 s live (sessions are not vault notes, so events don't cover them), `StatusBar` + service status 30 s.

## Measuring (overseer; do NOT point at prod)

1. Start a sandbox server (not :8787) against a sandbox vault copy with `PRISM_VAULT_TRACE=1`, logging to a file.
2. Baseline: `node --import tsx apps/server/scripts/measure-idle-clients.ts --base http://127.0.0.1:<port> --token <pd_ token> --clients 3 --mode poll --seconds 300`.
   **Count real vault calls, not `[trace]` lines**: a `[trace] proxy` line is logged for every gateway request even when
   the 5 s read cache answers it without touching the vault (≈0 ms lines). Put a tiny counting HTTP proxy between the
   sandbox server and the sandbox vault (point `PARACHUTE_URL` at it) and count forwarded requests per window.
3. Restart the counter, run the same with `--mode events`, count again. Acceptance: >= 80 % fewer vault calls with 3 idle clients.
   (Real browsers: open 3 tabs with the WP7.2 build vs. the previous build, leave idle 5 min.)

**Result (2026-10-01, sandbox copy of the 14k-note default vault, vault 0.7.9):** poll 50 vault calls / 300 s →
events 5 (only the one-time lists at connect) + 1 subscribe socket = **−90 %** (−88 % counting the socket). Vault
write → client `upsert` frame 10–27 ms. Synchronized simulated clients share the 5 s cache 3:1, so real drifting
clients poll the vault more and the real-world reduction is larger. Note: the first events connection triggers the
tree's full subscribe snapshot (~14k rows), so lists issued in the same second take ~3 s once.

Owner reads are coalesced (5 s), so compare the vault-side `[trace]` counts, not client-side request counts.
