# Implementation log

## Durable canvas relationships (R10)

Authored arrows now reconcile through a server route bound to the current canvas scene, with fresh edit checks on the canvas and both endpoints. A SQLite ledger retains one assertion per vault/canvas/arrow, plus pending source reconciliation and confirmation receipts. It reads the active collaborative scene when loaded and the saved scene otherwise; mismatched client scenes do not execute. Vault identity changes clear stale assertion ownership.

Vault links are projected with source revision guards. Multiple arrows/canvases can assert the same edge. Existing manual edges remain unowned; any unobserved source revision forfeits deletion ownership conservatively. Thus an unrelated external source edit can cause an orphaned canonical link to be retained after its final arrow is removed. The UI explains retained links; it never silently assumes permission to delete a possibly manual relation. A future explicit owner review can clean these up. Interrupted jobs retry from durable scene/assertion state, with uncertain writes preserving rather than stealing ownership. Canvas deletion does not automatically garbage-collect its claims; that needs a separately reviewed cleanup flow.

The shared renderer shows pending/confirmed/failure states, retries scene races, and supports a selected arrow's relationship/decorative mode without removing the drawing. Fresh note cards use regular sans-serif text and clean outlines. Both modern clients and the legacy desktop bridge call the same assertion service. Offline work retains the drawing; relation projection waits for server access. Limits are explicit: 250 bound arrows per scene and bounded affected-note reads. Large-vault indexing, raw Yjs suggest-only enforcement, and the other R00–R16 gates remain open.

## Workspace continuity

The shared shell now persists a versioned, audience-specific navigation record containing at most 20 document IDs, the active ID and panel choice. No titles, bodies, credentials or unsaved editor contents enter that record. Modern web and thin desktop use the same path. Legacy hosts without a confirmed audience and capability-link sessions do not restore private tabs. Local pending drafts remain in their existing scoped outbox/Yjs stores.

Reopening reads each document through the fresh-access path, bypassing the offline read cache; a locally created outbox draft remains available in its original scope. Denied/unavailable documents remain hidden with Retry/Dismiss controls. Late reads cannot cross a vault/account change, and deliberate navigation or a deep link wins over background restoration. Phone startup preserves the document rather than reopening an agent drawer over it. The navigation snapshot is a last-writer-wins preference across windows; it is not a backup of editor content. Existing global Favorites/Recent settings still need audience-scoped migration and are not copied into this record.

All 156 browser journeys pass, including 10 restoration cases and the focused-canvas no-transition regression. Core, web, server, legacy desktop and e2e typechecks pass. Native build and actual release acceptance are tracked separately in RELEASE-CHECKPOINTS.md.

## Live web/desktop thread reader (R05)

The old latest-message path invoked a legacy Tauri Matrix command, which the web/thin client does not implement. The shared renderer now uses an optional VaultClient live-thread seam, backed by `/api/threads/:id/live`, with legacy Tauri fallback only on the older host. The route reads the primary connector as the server owner, confirms joined membership and current session/thread binding, rate-limits reads and uses a 15-second upstream read timeout. A grant to a saved transcript never grants connector access. Secondary vaults cannot supply credentials or redirect the source.

Live pages retain provider event IDs, deduplicate overlapping pages by ID, and identify You only by the verified account ID (never display-name similarity). The live window is bounded at 20 pages, with a visible limit; saved text has a separate incremental 100-message window. Source failures remain explicit instead of showing saved text beneath a live label. Sender-name collisions expose sender IDs, day separators clarify chronology, and safe clickable web URLs preserve literal source markup without loading remote images. Explicit read-only rendering disables status changes, connector reads and sends.

All 1,430 server tests and 159 browser journeys pass; the final 15 message journeys pass after the URL-boundary correction. Application and e2e typechecks pass. This is not the durable structured ingest/archive projection: old notes remain portable text, historical archives and edits/reactions still need their planned source projection and reconciliation. Media URLs are identified but not fetched by this slice. Bridged self-puppets are not guessed from display names. Production/private-room and installed-client acceptance are recorded separately.

Production verification then found the shared actions status client requested `/api/actions/`, while the mounted Hono route is `/api/actions`. The resulting 404 hid configured Matrix/email/calendar actions. The client now requests the canonical route; a new integration test uses the actual HTTP client against `createApp()` and also verifies non-owner denial. Seven focused server tests and 21 message/calendar browser journeys pass. This correction is client-only; no action flags or room allowlists are changed.

## Stable responsive document area

Shell now has one keyed document-area parent across desktop/mobile layouts. Sidebars, drawers, resize handles, status and mobile actions change around the existing Canvas, preserving the editor, live thread selection and focused scene. A focused canvas also watches ancestor child lists so newly mounted background navigation inherits inertness and is restored when focus mode closes.

Focused journeys verify the exact editor node and unsaved text survive 1280→390→1280 without an early save, followed by exactly one autosave; the exact live-message reader and selection survive both directions; and a focused Excalidraw instance remains mounted while mobile actions stay inert until close. This reduces duplicated layout code without changing host/client contracts. Remaining sidebar/context-pane remount behavior and physical keyboard/viewport testing are separate from the document-area guarantee.


### R03/R15 — specialized collaborative engines load on demand

The shared public editor exports now defer canvas, code and spreadsheet engines inside a local Suspense/error boundary. The parent keeps the Y.Doc, provider and scoped local persistence; loading does not restart the connection. Import failures offer an explicit Reload Prism action with a reminder to save other drafts, because browsers retain failed module imports and a fresh React lazy identity alone cannot recover them. Runtime render failures can retry in place. Pure language detection no longer imports CodeMirror language packs.

Delayed-load testing exposed a pre-existing code adapter error: EditorState was initialized empty although yCollab only observes subsequent changes. It now seeds from the current Y.Text, including changes arriving before the engine mounts.

All 168 browser journeys pass, including four new real-Hocuspocus journeys: prose requests no specialized engines; delayed code receives existing/remote text and saves/reloads a local edit; failed spreadsheet download recovers through explicit reload while retaining remote cells; deferred canvas retains its connection through focus mode. Existing canvas tests now use the deferred public export. Application and e2e typechecks pass. Production web build's workspace chunk shrank from 4,293,267 to 2,457,445 bytes (42.8%); gzip measured with the same Python method shrank from 1,337,022 to 725,116 bytes. This measures that chunk, not overall app transfer or perceived latency. Native build and actual production editor journeys remain pending at this checkpoint.


### R01/R02/R15 — account-scoped shortcuts and in-memory reads

Favorites and Recent now persist bounded ID lists under a confirmed server/workspace/vault/account scope. Labels are fresh access-checked projections, never stored titles. Standard per-note SSE invalidations recheck affected shortcuts; denied/unavailable entries hide their titles without destroying saved IDs and expose Retry. Phone navigation records recents even while its drawer is closed. Storage failure retains usable in-memory preferences with an honest unsaved notice. Legacy global shortcuts are preserved for the old local host; modern clients offer explicit recovery of currently accessible IDs and never display or automatically assign their old titles to a new account. Preference updates between windows use storage events and remain last-writer-wins; they are not shared server preferences or draft storage.

The account-switch test also exposed the module-global QueryClient retaining note bodies. App now creates a fresh query client and observers per confirmed audience; a mutation-observer regression test watches for any old body appearing after a second account opens a denied ID. Existing draft stores and server authorization are unchanged.

All 177 browser journeys and core/web/server/legacy/e2e typechecks pass; web release build passes. Nine shortcut journeys cover scoped reload, phone recents, vault/account separation, late access responses, older-record recovery, denial/retry, targeted access invalidation, quota failure and in-memory body isolation. Native build and actual production shortcut acceptance are pending at this checkpoint.

The preceding code-editor follow-up also keeps the same editor DOM, cursor and collaborative undo stack across 390/1280px, supplies explicit Yjs undo/redo shortcuts, and disables undo mutation handlers in view-only mode. Real-Hocuspocus resize/undo/redo/reload/live-downgrade checks pass.
