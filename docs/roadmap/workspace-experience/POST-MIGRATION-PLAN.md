# Prism collaborative workspace: final redesign plan

**Status: approved by the user on 2026-10-01; implementation in progress. See [current release](CURRENT-RELEASE.md), [frontend requirement/acceptance reconciliation](FRONTEND-ACCEPTANCE.md), and [historical implementation evidence](IMPLEMENTATION.md).**

Prepared 2026-10-01 against `29d18b3a712072494f46105fcc514de88c7e0603`, with the host verification fix at `55de6007b946398a47f9f805242ff8b3d9ef9ad3` incorporated and retested. This is the authoritative successor to the original F00–F11 plan in this directory. It incorporates the user's expanded product brief and the actual server/client migration, including the parity A, B, and C merges. See the [audit](ARCHITECTURE-AUDIT.md), [additive contracts](DOMAIN-CONTRACTS.md), [brand direction](BRAND.md), and [release gates](RELEASE-GATES.md).

## The product we are building

Prism becomes one calm workspace for documents, people, conversations, and connected knowledge. Open a document, work with another person or an agent, inspect the context behind a suggestion, accept a change, and resume on another device. An email, Telegram conversation, meeting transcript, task, and canvas card should lead back to the same canonical notes and relationships.

The app should feel as deliberate as Notion, while preserving Prism's ownership model: content and relationships in the Parachute vault, collaboration and automation mediated by the Prism server, and a shared interface across web/PWA and the thin desktop client. This is an incremental redesign of a working system, not a replacement editor, vault, or ingestion stack.

The highest-priority user journeys are:

1. Write alongside the agent in a document, drawing on accessible vault context and reviewing edits in place.
2. Read and reply to a conversation with unmistakable speaker identity, complete rendering, and trustworthy send states.
3. Open a person and see their related conversations, meetings, notes, and tasks without accidental identity conflation.
4. Move fluidly among document, calendar, search, board, graph, and canvas while editing the same underlying knowledge.
5. Invite collaborators, govern a shared vault, and publish selected knowledge with understandable access controls.

## What changes from the previous plan

| Previously expected foundation | Current implementation | Consequence for this plan |
| --- | --- | --- |
| Durable agent sessions and event replay | Delivered through AgentClient, sessions, and the shared conversation reducer | Improve document binding, context, drafts, and presentation; do not rebuild chat transport |
| Agent edits compatible with human collaboration | Prism MCP already uses the live Y.Doc and human suggestion marks | Extend this exact path with suggestion identity and safer tool policies |
| Native client/server split | `apps/client` bundles the native web build and authenticates with a device token | Target the shared web interface; keep `apps/desktop` building as the rollback host |
| Desktop-only integrations moving server-side | Calendar actions, sync services, skill controls, model routing, wikilink jobs, media/map proxies now have server paths | Validate parity and improve discoverability; remove the old plan's assumption that these ports still need to be built |
| Better navigation data flow | Tree projection and permission-filtered invalidation exist | Preserve their resource savings; avoid fetching every note to populate a sidebar |
| Person/thread and transcript connections | Present but incomplete and sometimes ambiguous | Repair confidence, provenance, recovery, and presentation instead of introducing another ingestion pipeline |

The migration documents report live actions enabled in production. That is a handoff statement, not a production verification performed in this audit. A merge error initially prevented `verify:host` from parsing; the migration agent fixed it in `55de600`, and all 18 host checks now pass. The final migration commit and runtime configuration still must be reconciled in R00.

## Interface direction

**One shell, one document header, one contextual panel.** Use a compact left rail for Search, Notes, Inbox, Calendar, Tasks, Canvas, and Graph, followed by pinned/recent items and the current vault. Let users reorder or hide specialist destinations. Keep settings and integration administration out of the writing toolbar. Preserve deep links and browser back behavior.

The document header carries its title/breadcrumb, saved or offline state, collaborators, Share, and an overflow menu. Properties and tags become a compact, expandable row rather than stacked full-width bars. The editor has a comfortable reading width, consistent typography, a quiet block menu, and a selection toolbar. Rich formatting, embeds, tables, wikilinks, code, and specialized renderers remain available.

The right panel switches among **Agent, Details, and Activity**. Agent conversations name their working document and expose attached context. Each session has a persistent permission selector: **Read-only**, **Suggested edits only**, or **Read/write**. The agent is a collaborator whose access you control, not a permanently suggestion-only assistant. A source preview does not silently change that working document. Activity combines understandable human edits, agent suggestions, comments, and governed proposals while preserving their different approval rules. Separate screen layouts reuse the same conversation components rather than maintaining two incompatible chats.

On mobile, use one primary surface at a time. Document/Agent switches preserve selection, drafts, and scroll positions; context previews and properties use sheets or full-screen routes. Compact bottom navigation provides Notes, Inbox, Search, and More, with the agent available from the active document. Do not shrink a three-column desktop interface onto a phone. The keyboard, safe areas, installed PWA behavior, and reconnect flow are part of the design.

Inbox resembles a capable messaging app: sender avatar and name, channel/account identity, timestamps and date separators, readable multi-line content, restrained bubbles, stable history loading, and a composer whose contents remain until a send succeeds. Email retains subject, recipients, quoted content, and explicit Reply/Reply all semantics. Canonical person links are navigable, with uncertain matches clearly reviewable.

Use the [nineteen existing mockups](MOCKUPS.md) as visual references, not as exact runtime contracts. R02 adds missing screen boards for People, Calendar/transcript review, Boards, Canvas, Graph, Sharing/governance, Publishing, Integrations, and the corrected prism brand. Each board includes desktop and mobile behavior, empty/loading/error states, and permission-limited states before its implementation slice begins.

## Architectural rules for implementation

- Keep Parachute as the content/relationship source of truth. Derived indexes and event projections must be rebuildable and scoped; do not add a parallel knowledge database.
- Use existing injected clients: VaultClient, AgentClient, CollabDocument/Sharing, LiveActionsClient, HostServices, Account, Push, and InvalidationSource. Shared components must not import native commands or server credentials.
- Extend the current Yjs/Tiptap collaboration path. Never apply an agent's whole stale document over live human edits or introduce a second suggestion truth outside the collaborative document.
- Treat workspace, vault, actor, document, and publication scopes as explicit data. Route changes must not retarget queued writes, running agent turns, or drafts.
- Distinguish permission from availability. An unavailable server feature gets an honest unavailable/reconnect state; it must not fall through to the legacy desktop runtime.
- Reuse domain services behind HTTP, MCP, and jobs. UI decomposition follows vertical work, avoiding a large speculative framework rewrite.
- Introduce contracts and migrations additively, with compatibility readers and reversible rollouts. Do not mass-rewrite historical conversations or silently merge people.

## Ordered implementation packages

Every package includes its own regression coverage and a focused commit (or several coherent commits). Completion means its acceptance evidence exists, not merely that its screen looks finished. Dependencies below are prerequisites, not permission to omit later packages.

### R00 — Final migration handoff and trustworthy baseline

**Depends on:** user approval and the other agent's explicit final migration handoff.

1. Pin the completed migration SHA and deployment/build identifiers. Compare it with this audit and revise only findings changed by later commits. Reconcile `desktop-parity.md`, actual commands/routes, and feature flags.
2. Retain the host verification fix from `55de600` and rerun the script if later handoff changes affect it. Include verification scripts in a suitable typecheck/parse gate so normal app typechecking cannot mask a similar merge error again.
3. Create an isolated checkout/build directory; do not build over a live deployment's `apps/web/dist`. Inventory current production web, server, PWA cache, and installed `apps/client` versions, plus the rollback desktop host.
4. Establish fixture-only browser tests with an explicit test database/vault and disabled external workers. Replace reliance on Playwright's current live-server/environment defaults with separate, opt-in production tests.
5. Capture current desktop/mobile screenshots and reproduce reported header bars, tag display, message rendering, and agent access issues. Record known defects separately from regressions. Inventory every renderer, integration, publication template, setting, and native extra in the feature ledger.

**Acceptance:** isolated server and client seam tests pass; the host verification failure is resolved; actual runtime capabilities are recorded; every existing feature has a test or a named manual verification path. **Rollback:** documentation/harness changes only; no production migration is needed for this package.

### R01 — Safe offline work, scoped drafts, and capability states

**Depends on:** R00. **Primary code:** `apps/web/src/offline/outbox.ts`, REST/transport/config providers, shared agent/composer draft state.

1. Introduce versioned outbox records bound to server, workspace, vault, actor/access audience, operation identity, and original precondition. Reapply the correct context headers only after verifying the current actor still has access.
2. Quarantine old unscoped records for recovery instead of guessing their destination. Remove automatic `force:true` conflict retries. Preserve 404/410 drafts with recovery options instead of deleting them as if saved.
3. Represent queued, sending, conflict, unknown outcome, and permission-revoked states. Add idempotency/reconciliation for create and other repeat-sensitive operations; map temporary IDs before dependent writes replay.
4. Persist document, message, and agent drafts under their actual scope. Resume a selected session only when it belongs to that scope. Distinguish CRDT offline updates from REST mutations; do not replay the same edit through both systems.
5. Replace unavailable AgentClient-to-Tauri fallback with explicit availability/permission/reconnect states. Compose capability information from delivered services, keeping server-owner, vault role, and note capability distinctions visible to callers.

**Acceptance:** changing vault/account/server while offline cannot redirect writes; concurrent edits lead to reviewable conflicts; lost responses do not duplicate creations; drafts survive reload and session changes without appearing for another actor. **Rollback:** retain versioned records; turn off replay while keeping recovery/export accessible.

### R02 — Prism brand, tokens, and shared controls

**Depends on:** R00; rollout also requires R01 for affected draft surfaces. **Primary code:** shared styles/components and public/native asset directories.

1. Produce the precise many-beams-in → prism → one-ray-out identity described in [BRAND.md](BRAND.md), including compact and monochrome variants. Review it at real icon sizes before replacing assets.
2. Define reusable neutral surfaces, text hierarchy, restrained spectrum accents, spacing, radii, focus rings, typography, elevation, and motion tokens for light/dark themes. Keep user/publication theme overrides separate.
3. Consolidate buttons, icon buttons, menus, fields, badges, popovers, sheets, toasts, empty states, and status indicators. Use actual accessible semantics and keyboard behavior, not only shared CSS.
4. Add the missing screen mockups listed above and refresh earlier boards where shipped architecture changes their behavior. Choose one coherent design vocabulary across the entire set.

**Acceptance:** recognizable logo at 16–32 px; accessible contrast/focus and reduced motion; complete asset inventory; no clipped controls at narrow widths or 200% zoom. **Rollback:** asset/token changes can revert independently of data contracts.

### R03 — Workspace shell and document editing

**Depends on:** R01–R02. **Primary code:** shared App/layout, ContextPanel, renderer registry, CollabEditor and editor extensions.

1. Implement the navigation, header, panel, and mobile layouts above. Give each panel one scroll owner and one predictable close/back action. Preserve deep links, selection, and navigation history.
2. Extract a small editor adapter for selection text/ranges, document revision, focus, and insertion actions across supported renderers. A renderer without a capability exposes that limit rather than pretending to support rich-text suggestions.
3. Refine Tiptap typography, block/selection menus, title editing, tags/properties, tables, embeds, attachments, comments, and save states. Keep existing data serialization and Yjs binding intact.
4. Add graceful density controls and resizable desktop panels. Persist layout preferences separately from document metadata. Provide keyboard access and discoverable touch equivalents.
5. Audit every renderer against the new shell: rich text, Markdown/source, code, sheet, canvas, message/email, calendar/meeting, task board, graph/map, network/governance, and existing specialized types discovered in R00.

**Acceptance:** the document+agent journey works at phone/tablet/desktop widths; formatting round-trips; navigation does not reset drafts; no duplicate sticky bars or nested scrolling traps. **Rollback:** gate the shell while retaining the same renderer/data interfaces.

### R04 — Canonical people and reliable message records

**Depends on:** R00–R01. Can begin before shell polish completes. **Primary code:** `worker/people.ts`, Matrix/Proton workers, rollover, message read adapters.

1. Replace first-match identity resolution with typed external identities and explicit ambiguity outcomes. Prefer verified email/platform IDs; use names only as suggestions. Preserve aliases and manual decisions with provenance.
2. Preserve Telegram-via-Matrix identities and bridge mappings, filtering self/bot identities without erasing real participants. Inspect the deployed Proton people-link flag rather than assuming it is enabled.
3. Add an additive structured message projection for newly ingested events: stable source event ID, sender reference, source timestamp/offset, body/format, attachments, reply/edit/redaction information where available. Keep raw source and portable historical content.
4. Provide paginated thread summaries and archive-aware timelines. Adapt old text records without dropping continuation lines or inventing missing identity/timezone certainty. Do not download all message bodies to render the inbox.
5. Add a previewable, resumable people/link repair job. Uncertain records enter a review queue; corrections retain history. Provide a canonical person detail view with conversations, meetings, related notes, and tasks.

**Acceptance:** two people sharing a display name stay distinct; renamed senders remain linked; email backfill is deliberate; legacy multi-line messages render fully; archived history paginates with stable keys and no duplicates. **Rollback:** structured projection can rebuild; original notes remain readable; reviewed identity decisions are retained.

### R05 — Inbox, message threads, and email

**Depends on:** R02–R04. **Primary code:** MessageRenderer, MessageThread, MessageComposer, VaultMessagesDashboard and email views.

1. Build the readable list/thread/detail layout, with consistent channel/account labels and person identity. Separate date boundaries and long gaps; never group solely by sender name.
2. Normalize content rendering for text, safe rich text, attachments, links, code, quoted email, and malformed source fallback. Resolve tag/header clipping and overlapping bars with shared layout constraints.
3. Preserve the user's reading position while loading older messages. Follow new messages only near the bottom; otherwise show a new-message affordance. Virtualize long threads only with tested height/anchor behavior.
4. Make composer submission await a result. Preserve drafts/attachments until acknowledgement; distinguish pending, accepted, failed, and unknown outcome. Reconcile outbound events with later ingestion using stable IDs instead of appending a permanent duplicate.
5. Use delivered LiveActionsClient for sends. Show recipient, account, Reply/Reply all, and attachment context. Apply triage/tag mutations with conflict-aware updates and consistent refresh.

**Acceptance:** the user's reported speaker/tag/bar/rendering issues have reproducible passing cases; reconnect/retry produces one confirmed send; mobile keyboard and history loading preserve position; unknown delivery is never labeled delivered. **Rollback:** retain read adapters and drafts while reverting presentation independently.

### R06 — Document conversations with vault context

**Depends on:** R01–R03, accessible retrieval from R09 as it lands. **Primary code:** AgentChat, useAgentConversation, agent-sessions, sessions routes and context services.

1. Bind each conversation explicitly to its working document and actor/vault scope. Separate session selection, messages, context, composer, and status views without replacing the existing event reducer.
2. Add context controls for the current document, selected passage, related notes, chosen files, and accessible vault search. Include a versioned snapshot of unsaved text when appropriate; display what was attached, what the agent actually read, and any truncation separately.
3. Support streaming, cancel acknowledgement, retry/resume, budget limits, and a durable follow-up queue. A queued instruction is visibly queued and can be edited/removed before execution; it does not masquerade as a concurrent turn.
4. Open citations in an inspectable source preview; preserve the original document/session when navigating references. Sanitize rendering and respect permission changes on reconnect.
5. Add a persistent per-session permission selector for Read-only, Suggested edits only, and Read/write. Users can change it whenever needed; available powers remain bounded by their effective vault/document access and governance. R07 supplies server enforcement and safe mode changes during active work. Existing owner-only hosted sessions remain owner-only until a separately tested actor-bound execution path exists; guest collaboration does not implicitly enable hosted agent execution.

**Acceptance:** a draft-aware conversation survives reload/device resume; source previews never retarget a running turn; follow-ups execute once; denied context does not leak snippets; unavailable configurations have useful recovery states. **Rollback:** preserve durable session/event schema and compatibility rendering for old turns.

### R07 — Live human and agent editing with trustworthy review

**Depends on:** R03, R06, and R12's effective-permission rules. **Primary code:** MCP tool-collab, collab-ops, suggestions, suggestionMarks, CollabEditor and governance review services.

1. Extend existing Yjs suggestion marks with stable suggestion/turn/author identity while continuing to read legacy marks. Use the live document and anchors/version checks, not a second proposal document or stale REST body replacement.
2. Implement all three per-session execution policies: Read-only, Suggested edits only, and Read/write. Reuse guarded Prism reads and live collaborative writes for Read/write; add a genuinely constrained suggest-only policy. Current `prism-rw` can update/restore directly and must not be relabeled suggest-only. Persist the chosen mode, record its version on each turn, and enforce the allowed tools server-side. Document permission modes do not independently grant outward sends, integration administration, or governance votes.
3. Make mode changes explicit during active work: serialize policy changes with tool dispatch, stop/revoke old mutation authority before confirming a downgrade, and label any cancellation still pending. Escalation takes effect only at a clear turn boundary after rechecking permissions; it never silently expands an already-running turn. A user may stop and restart work under the new mode. Preserve completed edits and attribute them normally.
4. Render agent presence, affected passages, suggested insertions/deletions, discussion, and per-change/batch review. Make stale, ambiguous, overlapping, and already-reviewed changes explicit; re-anchor or request regeneration rather than replacing the first repeated text match.
5. Apply accept/reject through current permission/governance rules. Tracked edits, anchored comments, and governed proposals remain different objects with clear transitions. An agent cannot approve its own governed change through an implicit shortcut.
6. Test all three modes, concurrent human edits, two reviewers, reconnect, mode changes during tool calls, cancellation mid-suggestion, document deletion, and revision changes. Preserve the existing three-way merge behavior for direct MCP writes in Read/write mode.

**Acceptance:** each session independently retains its selected permission across reload/device resume; two humans plus an agent can work on one document without losing edits; direct edits work in Read/write; other modes cannot bypass their restrictions through an alternate tool; downgrades/revocations block subsequent forbidden operations; review operations are idempotent and provenance remains clear. Comment-only anchored collaboration stays unavailable unless a separately designed server-enforced comment channel is implemented. **Rollback:** additive mark attributes remain readable; preserve recorded session modes and never silently broaden access when reverting the new policy/UI.

### R08 — Calendar, transcripts, and meeting context

**Depends on:** R04 and R03. **Primary code:** calendar and transcript workers, calendar live actions, meeting renderers.

1. Retain calendar create/update/delete, recurring scope, notification choice, and soft cancellation from parity A. Put these controls in a clear event details experience.
2. Preserve provider event/occurrence identity, actual start/end times and timezone, participant identifiers, and meeting links where providers supply them. Keep date-only legacy records supported.
3. Rank transcript candidates using exact IDs first, then time/participants/title evidence; require a confidence margin for automatic linking. Show an ambiguity review interface and allow manual link/unlink with a reason.
4. Reconcile both sides of event↔transcript links after partial failures. Support multiple recordings per occurrence, recurring meetings, cancellation, and durable manual overrides while maintaining legacy singular fields during migration.
5. Present transcript, summary, participants, decisions, tasks, and agent discussion from the event and person views. Linking must never trigger source transcript deletion.

**Acceptance:** similarly named meetings on the same day do not cross-link; interrupted reconciliation repairs itself; recurring scope remains correct; event navigation reaches the correct conversation records. **Rollback:** keep link evidence and manual decisions, pause automated matching independently.

### R09 — Semantic search, wikilinks, properties, and context

**Depends on:** R01, R03. **Primary code:** rag/store/service/routes, useVaultSearch, wikilink extensions/resolver/job, property/backlink views.

1. Migrate the embedding index to explicit vault/model/chunker scope before enabling semantic search outside the primary vault. Keep the current primary-only guard until isolation tests pass.
2. Make one permission-aware retrieval service support app search and agent sources. Preserve hybrid ranking, disclose fallback to keyword search, show source type/date/match context, and expose index health without requiring users to understand embedding internals.
3. Keep indexing bounded and resumable, handle changes/deletions/model transitions, and filter before disclosing snippets or counts. Benchmark recall and latency before choosing an ANN extension; avoid adding infrastructure merely for appearance.
4. Unify interactive and batch wikilink resolution: exact path/ID, aliases, then unambiguous title. Reuse the delivered dry-run/progress/cancel job. Protect manually authored links when refreshing derived references.
5. Polish wikilink creation, rename behavior, accessible inline rendering, backlinks, related context, and compact properties. Preserve portable text and rich formatting across round-trips.

**Acceptance:** same note IDs across vaults cannot contaminate results; deleted/revoked content disappears; degraded search is labeled; ambiguous links require choice; copy/paste and screen readers do not expose broken hidden-markup behavior. **Rollback:** retain the old primary index until verified migration; disable new scoped readers without widening access.

### R10 — Canvas relationships and readable graph exploration

**Depends on:** R03, R09, and permission rules in R12. **Primary code:** canvas-cards, CanvasRenderer, CollabCanvas, GraphPanel/Fullscreen, authorized relationship services.

1. Keep Excalidraw and existing note cards. Improve drop/search-to-add, card previews, open-note actions, touch use, and relation labeling. Distinguish an authored relationship arrow from a decorative drawing or derived overlay.
2. Replace process-local fire-and-forget link tracking with durable assertion identity and reconciliation. Only show synced after confirmation; retry failures visibly. Removing one arrow must not delete another canvas's assertion or a manually created relationship.
3. Add a bounded, permission-filtered neighborhood API and scoped relation mutations where required. Non-owner/capability users currently lack generic graph/link gateway access; explicitly authorize both endpoints rather than bypassing the gateway.
4. Offer a readable focused 2D graph with labels, edge types/directions, filters, paths, expand-neighborhood, and saved exploration state. Preserve optional 3D. Disclose truncation and loading boundaries.
5. Provide a keyboard/list alternative, reduced motion, touch navigation, and WebGL failure recovery. Reuse the same relation semantics in canvas, backlinks, and graph.

**Acceptance:** an authored canvas edge survives reload and appears in actual vault metadata and graph; retry does not duplicate it; removing one contributor preserves others; inaccessible neighbors are absent; large graphs do not require every note body. **Rollback:** pause reconciliation while retaining assertion evidence; old canvases still open.

### R11 — Configurable task boards and composable views

**Depends on:** R03, R09. **Primary code:** TaskBoardRenderer, BoardWidget, dashboard filter engine, widget registry/useWidgetData.

1. Define a versioned board/view configuration on the board note: source filter/scope, grouping property, columns/order, card properties, sorting/manual rank, and display preferences.
2. Reuse existing dashboard/filter/schema capabilities instead of a second task store. Tasks remain notes linked to projects, people, and meetings; create/edit works through typed property updates.
3. Support custom statuses and an explicit ungrouped bucket. Preserve unknown statuses rather than silently treating them as To Do. Persist ordering and resolve concurrent moves.
4. Add keyboard and menu-based movement, touch-friendly cards, quick add, filters, and list view. Make drag feedback reflect confirmed or pending writes.

**Acceptance:** two boards can show different views of the same tasks; custom columns survive reload; mobile/non-drag input works; moving a card does not erase unrelated metadata. **Rollback:** old boards get a compatible default configuration; task content remains unchanged.

### R12 — Guest collaboration and composable governance

**Depends on:** R00–R03; supplies authorization rules to R07/R10 before they ship. **Primary code:** ShareDialog, account/collab clients, governance services and existing policy/proposal UI.

1. Present account invitations, scoped capability links, and anonymous publication access as distinct choices. Explain view/comment/suggest/edit/organize powers accurately, including current anchored-comment limitations.
2. Add effective-access previews for a person/note, expiration and revocation states, and understandable empty/no-grant experiences. Validate authorization on the server and in collaborative documents, not only by hiding controls.
3. Refine the existing plain-language policy builder with useful presets, an advanced composable editor, scope precedence explanations, and a preview of affected notes/members before changes.
4. Connect proposal, discussion, quorum/voting, review, and audit history with clear next actions. Preserve integrity signatures, author restrictions, role rules, and policy precedence.
5. Test guest onboarding and shared editing in separate browser profiles and the actual desktop client. Hosted agent access remains separately scoped as described in R06.

**Acceptance:** guests can do exactly what their grants permit; link revocation and role changes take effect during active sessions; governance cannot be bypassed through canvas, agent, property updates, or sync. **Rollback:** preserve policy/grant formats and old management routes while gating the new presentation.

### R13 — Customizable wiki publishing

**Depends on:** R02–R03, R09, R12. **Primary code:** PublishPanel, PublicationView, publication routes/template registry/theme validation.

1. Decompose the existing publishing panel into scope, appearance, navigation, preview, access, and publication status. Show what will actually be visible, including dynamic tag membership.
2. Add versioned presentation drafts and preview/publish/restore for site settings. Distinguish live note-content changes from publishing a new appearance revision.
3. Extend the template registry with wiki/documentation/landing layouts using the same scoped data contract. Configure home page, navigation sections/order, typography, content width, logo/cover, color tokens, and search/graph/map visibility.
4. Keep assets and theme options validated; avoid arbitrary scripts or secret-bearing embeds. Preserve password gates, private exclusions, publication-scoped wikilinks/backlinks, and revocation.

**Acceptance:** a user can create distinct sites without editing code; previews match published settings; broken/private links disclose no hidden titles; restoring appearance does not roll back vault content. **Rollback:** keep the existing wiki template and last valid settings revision.

### R14 — Integrations, sync, skills, and automation controls

**Depends on:** R00, R03, R12. **Primary code:** HostServices and delivered server sync/skill/routing services.

1. Build one integrations/settings experience that shows connection health, account identity, scope, direction, last successful run, next/active work, conflicts, and action history.
2. Expose GitHub folder, Notion database, per-note Docs/Notion, calendar, inbox, and transcript capabilities actually delivered at handoff. Preserve private-repository safeguards, explicit public export choices, bounded rate limits, audit records, and disabled-by-default imported auto-sync.
3. Make mappings, conflict strategy, preview/dry-run where supported, retry/cancel, and readback visible. Unsupported dry-run capabilities must be implemented or honestly omitted, not simulated with real exports.
4. Improve skill configuration, dependencies, execution history, stop controls, and model routing using parity A services. Keep local model one-shot routing distinct from Claude-based durable sessions.
5. Preserve one server-owned ingestion/sync authority. No browser timers or second local workers should duplicate upstream ingestion.

**Acceptance:** sync preserves unmapped fields and permissions; conflicts are actionable; repeated jobs are safe; secrets remain on the server; migration configs do not start exporting merely because the UI was redesigned. **Rollback:** UI changes do not replace stored credentials/configs; pause new scheduling before reverting workers.

### R15 — Mobile, PWA, native, and performance completion

**Depends on:** each changed surface; these checks also run throughout the earlier packages.

1. Exercise actual mobile Safari/PWA, desktop browsers, and the installed `apps/client` WKWebView. Test keyboard resizing, dictation/IME, safe areas, touch selection, drag alternatives, lock/unlock, back navigation, deep links, and reconnect.
2. Verify device login/logout, keychain token handling, multiwindow/native extras, capture/open behaviors, external links, media and maps through the delivered native proxies. Stored note HTML must keep original URLs, never temporary blob URLs.
3. Preserve PWA update/offline behavior and account isolation. Add a real service-worker test project; the current browser fixture configuration blocks service workers and cannot prove this.
4. Measure navigation, input responsiveness, long threads, large documents/canvases/graphs, and the architecture-v2 multi-client resource scenario. Preserve projection and invalidation savings; bound new queries, jobs, subscriptions, and caches.

**Acceptance:** feature ledger passes across required surfaces with named evidence; media/CSP limitations have usable fallbacks; no hidden desktop-only dependencies remain on web workflows. **Rollback:** independently deployable web/server/native artifacts with compatible contracts and preserved local drafts.

### R16 — Production validation, rollout, and completion

**Depends on:** R00–R15 and all [release gates](RELEASE-GATES.md).

1. Release small tested slices behind reversible switches where behavior/schema changes warrant them. Commit each passing slice with focused evidence; use explicit paths so unrelated agent work is never swept into a commit.
2. Validate the release candidate in an isolated environment, then on production with private synthetic notes, test collaborators/publications, and controlled integrations. Record web/server/native build IDs and real-device evidence.
3. Exercise the complete journeys below, compare resource/error baselines, and test rollback compatibility. Outward sends require a known owner-controlled test destination; never use an arbitrary real contact as a test recipient.
4. Resolve failures and repeat affected tests. Do not declare completion from screenshots, typechecking, unit tests, or a web preview alone. If a device, account, or integration cannot be exercised, record the exact missing evidence and keep its release gate open.

**Completion:** production web/PWA and the actual new desktop app have verified functional coverage, the expanded feature ledger is green, and no unresolved regression or required workflow defect is being hidden under a cosmetic finish.

## Milestones and review checkpoints

| Milestone | Packages | Demonstrable outcome |
| --- | --- | --- |
| M0: safe foundation | R00–R01 | Final handoff verified; scoped offline work and drafts |
| M1: coherent workspace | R02–R03, start R04 | New prism identity, calm shared shell, mobile document flow |
| M2: collaborative core | R04–R07; R12 permission prerequisites | Reliable inbox/person identity and live document collaboration |
| M3: connected knowledge | R08–R11 | Meetings, semantic context, links, graph/canvas, configurable tasks |
| M4: shared workspace | R12–R14 | Guests, governance, customized publishing, integration controls |
| M5: verified release | R15–R16 | Real mobile/web/desktop production evidence and rollback |

R12's permission work starts before features that depend on it; it is not deferred until M4. R15 testing is continuous. Timing estimates follow R00's measured baseline, not the size of a mockup.

## Final end-to-end stories

- On mobile, open a document, attach a selected passage and vault source, send an agent request, switch away/reconnect, then accept a suggestion on desktop while another collaborator edits a different passage. Change that session to Read/write and verify a direct collaborative edit; change it to Read-only and verify mutations are denied, while another session retains its own mode.
- Ingest a Telegram bridge message and an email from the same verified person, see both on that person's note, read archived messages, and reply once to a controlled destination without losing the draft or duplicating the send.
- Open a recurring calendar occurrence, review an ambiguous transcript candidate, link it, create a related task, and return to the recording from both the event and person views.
- Find a semantic result in the selected vault, follow a wikilink, drop the note onto a canvas, author a relationship, and see that relationship in metadata/backlinks/graph after reconnect.
- Configure two task boards over the same task notes; move a card from a phone and observe the update in another browser without losing custom properties.
- Invite a guest, demonstrate allowed and denied edits, submit and approve a governed change, then publish a customized site whose private neighbors remain private.
- Run controlled sync and a skill, inspect progress/conflicts/history, stop work where supported, and confirm no second ingestion worker or accidental public export was introduced.

## Approval and execution boundary

Approval of this plan authorizes the described staged implementation, focused commits, isolated verification, and controlled production rollout/testing after the migration handoff. Routine reversible development steps do not need repeated confirmation. Additional access or a controlled external destination may still be needed for particular production checks.

The requested work is complete only when the feature and release evidence is complete. This document itself is the reviewable planning deliverable; it does not claim that the redesign or production validation has already happened.
