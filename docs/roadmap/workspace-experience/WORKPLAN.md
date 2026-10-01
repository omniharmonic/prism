# Workspace experience implementation workplan

> **Historical design reference (2026-09-30, pre-migration `c191b52`).** The [post-migration plan](POST-MIGRATION-PLAN.md), [current contracts](DOMAIN-CONTRACTS.md), and [release gates](RELEASE-GATES.md) supersede runtime assumptions, sequencing, and authority statements below. Retain applicable interaction details. Each agent session now supports **Read-only, Suggested edits only, and Read/write**; earlier Ask/Suggest examples are not a restriction. Concept logos are placeholders pending [BRAND.md](BRAND.md).

Status: **not started**. Execute after the architecture v2 agent completes and hands off its agreed work. This is a downstream plan, not a parallel implementation branch or a request to edit its files now.

Read [DESIGN.md](DESIGN.md), [MESSAGES.md](MESSAGES.md), [CONTRACTS.md](CONTRACTS.md), and [VALIDATION.md](VALIDATION.md) before implementation. Upstream references use the work package IDs in [architecture v2 WORKPLAN.md](../architecture-v2/WORKPLAN.md).

## Execution rules

1. Begin from the upstream integration result that the owner identifies as complete. Record its commit and actual acceptance evidence. Do not assume the reviewed `c191b52` snapshot is the implementation base.
2. Reconcile every package with shipped APIs and UI before coding. Delete duplicate work; preserve useful upstream implementations. Do not reintroduce Tauri-only dependencies into shared features.
3. Keep changes in small reviewable commits, each with its relevant behavior tests and a buildable app. Implement shared UI in `packages/core`; use delivered `apps/web` transport/native adapters and `apps/server` domain services.
4. Use the architecture v2 sandbox rules. No test may silently fall back to the live vault/server or production `.env`. No production writes, restarts, credential changes, or ingest cutovers are part of this planning task.
5. Every feature has capability gating, loading/empty/error behavior, keyboard/touch support, and rollback defined in the same package. Accessibility and permission enforcement are not postponed to F10.
6. Preserve existing public/share routes and renderer behavior. Reuse provider/collab services; no wholesale editor, state-management, transport, CSS framework, or component-library replacement.
7. Assign one implementation owner per active file area. If later delegated work is authorized, follow the upstream worktree/review practice; this document itself does not start agents or prescribe additional concurrency.
8. New server behavior gets route/domain tests and actor/vault coverage. UI-only spacing changes need visual verification, not implementation-mirroring unit tests. Test meaningful user behavior.
9. Every completion report records files, screenshots, tests actually run, known gaps, feature flags, and rollout/revert steps. Update status only after evidence exists.

## Package index and dependencies

| ID | Scope | Local dependency | Required upstream baseline | Size |
| --- | --- | --- | --- | --- |
| F00 | Handoff, reproduction, fixture harness | None | Completion report and chosen integration commit | M |
| F01 | Shared visual and accessible primitives | F00 | Shared client build from WP2.2/WP4 | M |
| F02 | Navigation, routes, responsive shell | F01 | WP3.2 session routes, WP7.1 tree | M |
| F03 | Document surface and editor adapter | F01 | WP6.3 collab services, existing history | M–L |
| F04 | Document conversations and context | F02, F03 | WP3.1–3.4, WP6.1–6.2, WP2.2 | L |
| F05 | Agent proposal review and acceptance | F04 | WP6.3–6.4, resolved comment/suggest policy | L |
| F06 | Message read model and archive correctness | F00 | WP1.2, WP1.5, WP7.1–7.2, rollover | L |
| F07 | Message list/thread presentation | F01, F06 | Shared message reads from F06 | M–L |
| F08 | Reply reliability and richer source events | F06, F07 | WP1.5 sends, single server ingest owner | L |
| F09 | Search, properties, connected context | F02, F04, F06 | WP6.2–6.4 search/capabilities, WP7 | M |
| F10 | Cross-device quality and performance | F05, F08, F09 | WP2.2, WP3.3, available WP4–5 shells | M |
| F11 | Regression review and staged rollout | F10 | Upstream deployment/recovery process | M |

Sizes are relative implementation/review effort, not calendar commitments. F06 can begin immediately after F00 so message correctness progresses before later visual packages. F03 and F06 may be scheduled independently if file ownership and authorized staffing allow it. Gate all mutation UI on the final server contract, regardless of visual readiness.

## F00 Handoff and reproducible baseline

**Outcome:** a trusted starting point and explicit ledger of preserved behaviors, user-reported defects, and upstream capabilities.

**Inspect:** architecture v2 completion reports; delivered AgentClient/types and session routes; WP6.3 proposal/collab service; `apps/web` transport and offline code; `apps/client` if present; current message ingest/routes; shared layout, editor, and message components.

**Steps**

1. Record upstream commit, migration/schema versions, enabled capabilities, implemented/deferred work packages, test reports, and known limitations. Confirm the actual owner-only agent and admin-only messaging policies.
2. Map every contract in CONTRACTS.md to an existing type/service/endpoint or a documented gap. Resolve the comment-only policy from WP0.2 and distinguish ordinary suggestions from governance proposals.
3. Build a feature ledger: all renderers, tab operations, shortcuts, settings, favorites/recents, multi-vault, sharing, public wiki, governance, import, sync state, agent views, offline behavior, and native extras. Record their current entry points and route aliases.
4. Reproduce the user's sender-identity, top-bar/tagging, and message-rendering problems with synthetic fixtures. Capture desktop and phone screenshots, scroll positions, source format, and expected outcome. Preserve a raw transcript comparison for parser defects.
5. Inventory plain/collaborative editor schemas and round-trip formats. Record whether tables, images, links, suggestions, comments, code blocks, and task lists survive each supported path.
6. Create or extend an isolated frontend fixture harness serving synthetic routes/events. Configure Playwright with explicit sandbox origins and no production `.env` imports. Default tests must be runnable without a real vault, CLI agent, credentials, or paid model calls.
7. Add baseline behavior scenarios for session navigation, interrupted stream replay, message send failure, archive rollover, editor concurrency, and permission restrictions. Capture current failures rather than claiming they are already fixed.
8. Measure initial requests, response sizes, interaction latency, DOM size for a long thread, and idle vault traffic. Store the test environment and fixture sizes alongside results.

**Accept:** the baseline ledger identifies every upstream dependency and every user-reported message category; fixtures reproduce key bugs; automated test endpoints cannot resolve to production defaults; existing checks pass or pre-existing failures are recorded with owners.

**Rollback:** docs/fixture-only package; no product behavior flag. Do not delete previously working tests to make the baseline green.

## F01 Shared visual and interaction primitives

**Outcome:** consistent quiet controls that support the later views without changing data behavior.

**Likely files:** `packages/core/src/styles/{tokens,glass,typography,collab}.css`, `components/ui/*`, shared icon/menu/header primitives. Exact files depend on upstream changes.

**Steps**

1. Audit existing tokens and hard-coded colors/sizes. Introduce or reconcile semantic surface, text, border, focus, danger, and pending-state tokens; retain existing theme/font preferences.
2. Define reusable button/icon-button, menu, status chip, field, page header, empty/error state, source preview, and responsive sheet behavior. Reuse existing components where they are sound.
3. Fix focus trapping/restoration and accessible names for overlays. Add an explicit close action, Escape/Back behavior, reduced-motion handling, and click-outside rules that do not consume an editor's intended action.
4. Refine BottomSheet so vertical reading and scroll do not become unintended drag-to-dismiss. Establish one stacking-order scale for menus, editor bubbles, sheets, and toasts.
5. Keep document text readable and interface chrome quieter in both themes. Replace unreadable 9–10 px important labels and low-contrast states where encountered.
6. Add a synthetic visual gallery/fixture surface for key states and widths. Do not expose a developer component playground in the production navigation.

**Accept:** primitives work by keyboard and touch, focus is visible/restored, screen-reader names are meaningful, 200% text zoom does not hide primary actions, and light/dark screenshot review passes.

**Rollback:** reversible style/component commits; preserve public props or adapt callers together. No data migration.

## F02 Navigation and responsive workspace shell

**Outcome:** documents and conversations are easy to reach while all specialist functionality remains available.

**Likely files:** `Shell`, `Navigation`, `TabBar`, `ContextPanel`, `MobileActionBar`, `VaultSwitcher`, `CommandBar`, `StatusBar`, navigation/UI stores, delivered route adapters.

**Steps**

1. Introduce a shared navigation descriptor for real notes, message conversations, tag views, agent sessions, and virtual tools. Centralize title/icon/identity resolution and virtual-tab detection now duplicated in several components.
2. Move workspace/vault selection into the navigation header. Reuse the final upstream switch behavior and correctly clear or rebind view state; do not bypass its auth/cache lifecycle.
3. Group Search, Messages, Favorites, recent work, and document/project navigation. Place specialist tools in a collapsible section with optional pins and explicit old-to-new entry-point mapping.
4. Retain tabs, reorder, close, back/forward, and keyboard shortcuts. Add overflow and an Open documents menu so a crowded bar does not consume document actions.
5. Separate agent view state from inspector visibility. A panel toggle must never own session data or terminate a task. Source peeks preserve the working-document binding.
6. Make responsive layout depend on available content width as well as mobile detection. At narrower desktop/tablet widths, collapse navigation or use a sheet before squeezing both document and conversation to unusable columns.
7. Implement the labeled mobile navigation and compact header in DESIGN.md. Preserve New and tab switching access. Suppress competing bottom navigation while reply/review/composer actions occupy the same region.
8. Preserve existing URLs and add aliases for new note/session/message navigation through the delivered router. Back restores scroll/filter state, and notification deep links open the proper vault/session.

**Accept:** every feature-ledger entry remains reachable; navigating references cannot retarget a running agent; mobile has no competing bottom bars; tabs and long titles fit; public routes and capability links are unchanged.

**Rollback:** client presentation flag returning to upstream shell; retain compatible persisted preference formats and route aliases. Session/data state survives toggling.

## F03 Document workbench and editor adapter

**Outcome:** the user sees one coherent editing experience regardless of the persistence/editor path.

**Likely files:** `DocumentChrome`, `DocumentRenderer`, `CollabEditor`, `EditorToolbar`, `CollabToolbar`, `SlashMenu`, `InlinePrompt`, `Canvas`, web/native collab hosts, `editor/*`.

**Steps**

1. Extract a shared editor adapter exposing document identity/kind, current snapshot, selected text/anchor, focus/scroll restoration, supported actions, and proposal preview. Keep content mutations in the appropriate domain/collab service.
2. Remove the dependence on global one-slot `pendingEdit`/`ghostText` for new agent flows. Use operation/proposal IDs scoped to document/session. Keep compatibility consumers only while their callers are migrated.
3. Unify page title, properties disclosure, save/sync/read-only states, and document width/font controls. Clarify saved locally versus synchronized remotely.
4. Add the selection Ask agent/Comment surface and connect existing inline shortcuts/slash commands to the same session flow used by PanelChat.
5. Add an optional outline and full-toolbar preference without changing existing content serialization. Preserve familiar shortcuts and document selection during toolbar actions.
6. Resolve schema differences found at F00 through additive, separately tested changes. Preserve unsupported nodes in a readable fallback until server/client schema compatibility is proven; never silently strip tables/images.
7. Verify the adapter across normal, live-collab, view, comment, suggest, and governed-proposal states. Capability restrictions must hold even when controls are invoked through shortcuts.

**Accept:** selected current text reaches the context flow; both editor paths support the same declared operations; formatting/content survive round trips; read-only and governed users cannot write through an agent shortcut; no whole-document reset occurs during proposal preview.

**Rollback:** disable new chrome/agent controls; keep existing canonical content and collaboration schema intact. Any additive schema change needs a compatibility rollout independent of the visual flag.

## F04 Document conversations and inspectable context

**Outcome:** a user can discuss a document using vault context and resume the conversation on another device.

**Likely files:** delivered AgentClient/HttpAgentClient; `PanelChat`, `AgentActivity`, shared agent state/hooks, source picker/preview; server session/context services and existing transcript mirror.

**Steps**

1. Reuse the shipped session/event store and client seam. Add document binding and last-accessible-session selection; allow explicit New conversation and session history.
2. Build one conversation controller for panel, mobile sheet, full Agent view, and inline selection entry. Store committed state by stable scoped IDs, not by component mount lifetime.
3. Persist local composer drafts immediately and add revisioned server draft sync for cross-device continuation. Keep draft conflicts recoverable and unsent drafts private.
4. Implement the context envelope and source picker from CONTRACTS.md: current draft/selection, explicit notes, active-vault retrieval, real source provenance, and excerpt/unavailable labels.
5. Wire Ask to the delivered read-only profile. Add Suggest only with the enforced proposal-only contract; hold direct edit behind the existing explicitly scoped power-user capability.
6. Render streamed rich text and concise tool activity, with Stop, reconnect, queued/admission, limit, interruption, and retry states. Keep follow-up drafting available during a run; expose the upstream queue or an honest unsent draft. Implement Stop and refine without racing two turns or silently changing an active turn's context. Reuse the fetch-SSE transport and event replay cursors.
7. Preserve context/session while previewing a citation. Show the working document visibly when another page is on screen. Never put assistant explanatory prose directly into document content.
8. Reconcile push/deep-link entry with auth, active vault, current note, and session. Mark source/session access loss explicitly and avoid exposing private transcripts via document sharing.

**Accept:** switch inspector tabs, documents, devices, and browser foreground/background without losing committed messages; source counts represent actual tool reads; unsaved selected text is correctly identified; duplicate event replay does not duplicate messages; Ask cannot mutate notes.

**Rollback:** return to upstream WP3.2 session UI; retain session IDs, turns, events, transcript mirrors, and compatible bindings. No second runtime or model-provider migration.

## F05 In-document proposal review

**Outcome:** agent edits are understandable, reversible where safe, and compatible with concurrent human editing.

**Likely files:** proposal service underlying WP6.3, browser route wrapper, editor adapter, shared review components, suggestion marks/comments where compatible, history integration.

**Steps**

1. Map upstream suggestions to proposal identity, scope, baseline/anchor, structured operations, provenance, and per-change status. Extend only missing semantics.
2. Add browser list/read/accept/dismiss wrappers over the same authorized service used by MCP. Define acceptance idempotency and crash recovery across proposal/content state.
3. Implement prose selection replacement and inserted-block proposals first. Preview localized additions/deletions without mutating the canonical document.
4. Add next/previous change, Accept, Dismiss, optional well-defined Accept all, and Back to conversation. Preserve document and conversation scroll/focus.
5. Apply through live Yjs or conditional non-live writes as appropriate. Check anchors against current content; return conflict instead of guessed positions or full-note replacement.
6. Distinguish pending suggestions, accepted edits, history snapshots, and governance proposals in UI and audit. A governed target uses the governance workflow rather than local Accept bypass.
7. Add safe revert or a reviewed inverse proposal for accepted changes. Preserve later human edits and comments. Unsupported renderers return a draft/reference rather than a misleading Apply action.

**Accept:** two clients concurrently edit the same paragraph; independent changes survive; overlapping/stale proposals conflict visibly; double acceptance inserts once; restarting during acceptance recovers consistently; viewer/comment/suggest/governed permissions hold through UI and API.

**Rollback:** disable proposal creation/review entry points while pending records remain inspectable through the compatible service. Never discard accepted edits or relax permissions to restore the old ghost-text behavior.

## F06 Message read model and archive support

**Outcome:** complete, correctly identified message data is available to the UI without fetching the entire vault.

**Likely files:** new or delivered message read service/routes, `worker/matrix-rollover` parser reuse, Matrix/Gmail adapters, VaultClient/message client seams, conversation summary projection, shared message types.

**Steps**

1. Establish opaque scoped conversation identity and normalized summary/message/page types. Inventory exact post-v2 Matrix and Gmail fields before choosing schema names.
2. Extract a loss-preserving legacy parser: multiline entries, unknown dates, UTC handling, sender ambiguity, header/pointer separation, and raw fallback. Reuse rollover semantics and fixture-test them on both sides of the boundary.
3. Add permission-filtered summary queries with search/filter/cursor support. Use lean projections and targeted person relationships; replace the fixed full-body list and whole-graph assumptions.
4. Implement bounded timeline pages across live notes and archives, with per-source authorization and revision-aware cursors. Handle archive-before-trim crash overlap using verified rollover metadata.
5. Resolve display identity from trustworthy account/sender/person mappings. Keep unknown direction explicit. Distinguish group titles, participant names, technical handles, and archived segments.
6. Normalize live source enrichment without replacing the entire historical list. Merge only with reliable identity or proven coverage; otherwise preserve the legacy representation and its limitations.
7. Expose source connectivity, coverage, capability, and partial-data states. Add targeted invalidations through WP7.2; document projected cache rebuilds and limits.

**Accept:** all parser body content is preserved; known UTC stamps display correctly; archives page without missing/duplicate proven entries; two same-text source messages survive; cross-vault/hidden-archive data stays inaccessible; list load never requires complete thread bodies or a full graph.

**Rollback:** route the UI to the existing vault transcript reader, retaining archives and new rebuildable projection data. No destructive rewrite of historic notes is needed for this package.

## F07 Message interface and top-bar corrections

**Outcome:** readable, familiar conversations that keep the user's place and clearly identify every supported sender.

**Likely files:** `VaultMessagesDashboard`, `MessagesDashboard`, `MessageRenderer`, `MessageThread`, `PlatformBadge`, `EmailRenderer`, relevant shell layout and styles.

**Steps**

1. Consolidate overlapping list/thread presentation around F06's normalized reads while preserving old entry points. Keep Matrix and email visual semantics where needed.
2. Build desktop master/detail and mobile list-to-thread layouts. Preserve filters, drafts, selection, and list position during navigation.
3. Render verified sender names/avatars, distinct unknown handles, “You” only when proven, participant details, day separators, exact timestamps, and sensible time-bounded grouping.
4. Implement safe message body rendering for plain/rich text, whitespace, links, long words, supported attachments, and explicit unsupported states. Add email quote/history disclosures without hiding the only available body.
5. Implement anchor-aware older-page loading and incoming-message behavior. Add Load older and New messages controls. Virtualize only if measurement requires it and anchor/accessibility tests pass.
6. Audit every top bar, filter row, sticky heading, scroll container, and menu portal. Give each panel one scroll owner and stable offsets. Fix the specific bar/tagging repros from F00.
7. Bind triage labels to authoritative state and show mutations as pending. Keep unrelated tags intact, refresh on incoming-message reclassification, and show unknown/social values correctly.
8. Build readable loading, empty, denied, offline-source, stale, and retry states. On mobile, protect the conversation from keyboard and floating-bar overlap.

**Accept:** the user-reported identity/tagging/rendering cases pass; no content is silently dropped; older-page loading and images do not move the anchor; identical names remain distinguishable; 320 px width and 200% text zoom keep primary controls usable.

**Rollback:** new message presentation flag; the normalized read contract remains compatible. Retain saved drafts and user list preferences.

## F08 Reliable replies and structured message enrichment

**Outcome:** replies have trustworthy destination/delivery behavior, and new source messages retain the identity needed for rich rendering.

**Likely files:** `MessageComposer`, `ComposeMessage`, email reply components, delivered WP1.5 live-action services, single Matrix/Gmail worker owner, message projection and event types.

**Steps**

1. Implement a shared asynchronous compose state machine with destination, account, draft revision, operation ID, and submitting/accepted/failed/unknown states. Preserve draft text on failure and avoid Enter submission during IME composition.
2. Extend delivered send endpoints with retry identity and delivery lookup where missing. Use source transaction IDs for Matrix; treat Gmail's ambiguous outcomes honestly rather than promising exactly-once send.
3. Gate compose on permissions, configuration, and a real destination. Show account/recipient/channel explicitly. Remove personal/hard-coded account defaults and first-match destination guessing.
4. Reconcile a pending outgoing message with the canonical event from response/ingest. Prevent stale thread switches and two-device retries from changing destination or duplicating known accepted operations.
5. Separate Mark handled from Send. Use a conditional/atomic triage action, with failures visible and unrelated tags preserved. Do not auto-send queued offline drafts.
6. Connect agent Draft reply/Summarize/Extract tasks to exact authorized message references through F04; draft replies enter the human composer and do not authorize external delivery.
7. Add versioned structured event chunks for new messages if absent upstream, as specified in MESSAGES.md. Preserve event/sender IDs, timestamps, relation/media metadata, and a compatibility transcript under the one server writer.
8. Test replay, restart, relation updates/redactions, and projection rebuilding before enabling structured writes. Backfill only provably recoverable source data; keep legacy limitations visible.

**Accept:** failed sends retain drafts; confirmed sends appear once; uncertain outcomes remain explicit; read-only users cannot send; sender identity resolves for new structured messages; repeated source bodies remain distinct; old archives and legacy readers still work.

**Rollback:** disable structured-write and new-compose flags independently. Retain additive event records, delivery audit/operation IDs, and compatible transcripts. Never restart legacy ingest or blindly resend uncertain operations.

## F09 Search and connected workspace details

**Outcome:** finding and adding context is consistent across the application.

**Likely files:** `CommandBar`, `SearchPanel`, `ProjectTree`, `MetadataPanel`, `LinksPanel`, shared search/context components, delivered semantic-search/message-query services.

**Steps**

1. Share query/result formatting across palette, navigation search, source picker, and message search. Keep scoped result identity, useful snippets, and distinct Open/Add to context actions.
2. Use server search and pagination rather than scanning all note bodies in the browser. Handle lexical fallback or unavailable semantic search transparently.
3. Add source/message deep-link landing with a bounded context window and highlighted match. Preview denied/removed sources honestly.
4. Move a useful property summary into document chrome and simplify the full properties inspector. Split metadata fields/tag editing from integration setup and status.
5. Extract tree model/actions/dialogs from `ProjectTree` and property adapters from `MetadataPanel` as touched. Preserve drag/drop, rename/move, batch operations, and failure behavior; do not undertake unrelated refactors.
6. Show backlinks and related context with their basis stated. Preserve graph/map access as optional tools and all current schema/tag functionality.

**Accept:** the same note/result title and scope appear across surfaces; adding context does not unexpectedly navigate; message results land on the matching passage; unrelated metadata survives edits; no new full-vault client scan is introduced.

**Rollback:** keep old entry points and response compatibility; revert presentation/organization independently of search service corrections.

## F10 Mobile continuity and performance

**Outcome:** the same workflow remains usable with touch, keyboard, network loss, and long-running content.

**Steps**

1. Exercise actual iOS Safari/PWA keyboard, safe areas, orientation, background/foreground, navigation gestures, and notification entry. Add native-shell checks where upstream has delivered installable builds; a browser emulator is not proof of native behavior.
2. Restore session, selected working document, drafts, and useful scroll state across reload and device transitions. Do not synchronize every pixel scroll movement between devices.
3. Ensure offline document behavior follows the upstream collab/cache/outbox policy. Agent requests and external sends remain explicit online operations; unsent drafts survive locally.
4. Complete keyboard/screen-reader traversal, focus restoration, reduced-motion and contrast review for the implemented flows. Test denied/expired sessions and vault switches while a panel is open.
5. Profile rendering during agent token streams, message bursts, large trees, and long threads. Use narrow Zustand selectors and query subscriptions where traces show unnecessary work; cancel obsolete requests and clean up listeners.
6. Verify WP7's node-protection gains survive: targeted invalidation, bounded payloads, no per-row fetching, no background full-vault polling, and no all-history download to open a thread.
7. Complete shared loading/empty/error copy, genuine sync status, accessible notices, and focus-safe toast behavior. Make task completion visible without persistent animation or intrusive modal dialogs.

**Accept:** performance budgets and device checks in VALIDATION.md pass or explicitly documented exceptions are resolved before broad release; no source data crosses actor/vault caches; no draft loss under tested interruption scenarios.

**Rollback:** selectively disable expensive panels/previews or windowing implementations; never compensate by increasing node concurrency or changing model admission safeguards.

## F11 Release and regression gate

**Outcome:** incremental adoption with clear evidence and recoverable changes.

**Steps**

1. Run the complete relevant verification matrix on the isolated environment, including the protected existing renderer/share/governance/publish paths. Record actual results, not just commands.
2. Review all new contracts and schema migrations for old-client compatibility; perform projection rebuild and feature-flag rollback rehearsals on synthetic/sandbox data.
3. Capture final desktop/mobile light/dark screenshots and short task recordings using synthetic content. Ask the owner to review the concrete end-to-end workflows at this stage, following the existing deployment approval process.
4. Release additive backend compatibility first. Enable the new shell/agent/message experiences separately for the owner, then expand only after the corresponding acceptance scenarios pass in real use.
5. Watch render errors, parser fallback rate, proposal conflicts, reconnect gaps, send unknown/failure states, projection freshness, and payload/request counts. Do not log private prompts or messages to collect these metrics.
6. Update repository behavior docs and remove only proven-obsolete compatibility paths in a separate cleanup change. Retain redirects, data, operation IDs, and security boundaries during rollback.

**Accept:** both primary user stories pass, every preserved feature has regression evidence, known severe defects are closed, rollback is rehearsed, and deferred enhancements are clearly listed without being presented as shipped.

## First implementation session after handoff

Start F00. Read the final upstream report and inspect its APIs, run the safe baseline checks, reproduce the message sender/bar/body cases, and create the feature/contract ledger. The first product commits should be either an isolated F01 primitive correction or F06's tested legacy-parser/read-model repair. Do not begin by replacing PanelChat, rewriting the shell wholesale, or modifying the architecture v2 documents.

## Tracking

All F00–F11 packages are **not started** as of this document. On implementation, append commit, reviewer, verification evidence, flag state, and remaining issues for each package here. A completed mockup or typecheck alone does not complete a user workflow.
