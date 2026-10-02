# Implementation log

## Durable canvas relationships (R10)

Authored arrows now reconcile through a server route bound to the current canvas scene, with fresh edit checks on the canvas and both endpoints. A SQLite ledger retains one assertion per vault/canvas/arrow, plus pending source reconciliation and confirmation receipts. It reads the active collaborative scene when loaded and the saved scene otherwise; mismatched client scenes do not execute. Vault identity changes clear stale assertion ownership.

Vault links are projected with source revision guards. Multiple arrows/canvases can assert the same edge. Existing manual edges remain unowned; any unobserved source revision forfeits deletion ownership conservatively. Thus an unrelated external source edit can cause an orphaned canonical link to be retained after its final arrow is removed. The UI explains retained links; it never silently assumes permission to delete a possibly manual relation. A future explicit owner review can clean these up. Interrupted jobs retry from durable scene/assertion state, with uncertain writes preserving rather than stealing ownership. Canvas deletion does not automatically garbage-collect its claims; that needs a separately reviewed cleanup flow.

The shared renderer shows pending/confirmed/failure states, retries scene races, and supports a selected arrow's relationship/decorative mode without removing the drawing. Fresh note cards use regular sans-serif text and clean outlines. Both modern clients and the legacy desktop bridge call the same assertion service. Offline work retains the drawing; relation projection waits for server access. Limits are explicit: 250 bound arrows per scene and bounded affected-note reads. Large-vault indexing, raw Yjs suggest-only enforcement, and the other R00–R16 gates remain open.

## Workspace continuity

The shared shell now persists a versioned, audience-specific navigation record containing at most 20 document IDs, the active ID and panel choice. No titles, bodies, credentials or unsaved editor contents enter that record. Modern web and thin desktop use the same path. Legacy hosts without a confirmed audience and capability-link sessions do not restore private tabs. Local pending drafts remain in their existing scoped outbox/Yjs stores.

Reopening reads each document through the fresh-access path, bypassing the offline read cache; a locally created outbox draft remains available in its original scope. Denied/unavailable documents remain hidden with Retry/Dismiss controls. Late reads cannot cross a vault/account change, and deliberate navigation or a deep link wins over background restoration. Phone startup preserves the document rather than reopening an agent drawer over it. The navigation snapshot is a last-writer-wins preference across windows; it is not a backup of editor content. Existing global Favorites/Recent settings still need audience-scoped migration and are not copied into this record.

All 156 browser journeys pass, including 10 restoration cases and the focused-canvas no-transition regression. Core, web, server, legacy desktop and e2e typechecks pass. Native build and actual release acceptance are tracked separately in RELEASE-CHECKPOINTS.md.
