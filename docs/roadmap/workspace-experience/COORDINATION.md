# Frontend / backend agent coordination

> **Update 2026-10-02 (evening): Codex has left the project.** All frontend, backend, native and release work is now owned by Claude (orchestrator) and the sub-agents it starts. Current workstreams, each in its own worktree from main: `ux-editor-blocks` (block editor), `ux-databases` (typed properties + database views + `/api/schemas`, `/api/query`), `ux-pages-nav` (nested pages, trash, page menu, templates, favorites/recents sync), `native-ios` (iOS app → first TestFlight build). Fixture e2e ports: 5195 / 5196 / 5197 (`E2E_PORT`); 5188 remains the default. The live server runs from the main checkout — integrate in an isolated worktree, test, then fast-forward main; restarts only with an active-turn check and backup. The sections below are historical.


Updated 2026-10-02 when the owner started a separate backend agent. Both streams are authorized, but **separate worktrees and explicit boundary coordination are required**. Do not assume a shared working directory is private.

## Frontend stream (Codex)

Integration worktree: `/Users/benjaminlife/dev/prism/.worktrees/workspace-experience`, branch `feat/workspace-experience`.

Active isolated frontend branches/worktrees:

- `feat/page-creation` / `.worktrees/page-creation`: NewContentMenu, new content creation helper and fixture journeys.
- `feat/document-polish` / `.worktrees/document-polish`: DocumentChrome, DocumentRenderer, EditorToolbar/CollabToolbar presentation, ContextPanel and document fixtures; minimal MobileActionBar launcher-focus fix.
- `feat/messages-polish` / `.worktrees/messages-polish`: comms/message list/thread/composer, MessageRenderer/EmailRenderer, scoped message styling and fixtures.
- Root: Navigation, VaultSwitcher, shell/tab/navigation presentation, workspace setup UI, shared visual tokens and frontend acceptance/release documentation.

Frontend will use existing injected clients and contracts. No direct edits to `apps/server`, workers, database schema/migrations, backend authorization/ingestion/reconciliation, Rust runtime, shared API command schemas or transport behavior. A concrete frontend-discovered server gap is reported for backend ownership, not implemented opportunistically.

## Backend stream (owner's separate agent)

Start with [BACKEND-HANDOFF.md](BACKEND-HANDOFF.md) and [HUMAN-SUGGESTIONS-BACKEND-HANDOFF.md](HUMAN-SUGGESTIONS-BACKEND-HANDOFF.md). Create/use a separate branch and worktree. Prepared worktree: `/Users/benjaminlife/dev/prism/.worktrees/backend-followup`, branch `feat/backend-followup`, created from `447b19e` (released application source plus handoff documentation). Dependencies are not installed and no credentials/runtime files were copied. The owner confirmed that backend work had not started when this was prepared. Use this worktree; do not work in main.

Primary ownership: `apps/server/**`, persistence/migrations, worker correctness, authorization, transcript decision/reconciliation and other handed-off backend semantics. Coordinate any necessary shared/client API additions before editing frontend areas.

Preserved backend WIP **is not production-ready**: human suggestions `20ffc13`, transcript UI prototype `11a38b6`. Publishing navigation `51ec5bc` contains both frontend and backend changes and is **held for coordinated review**, not being independently merged by the frontend stream. Board ordering `14f86c5` is frontend-only and remains a separate reviewable slice.

## Shared boundary files — coordinate before editing

- `apps/web/src/collab/CollabDoc.tsx`, `humanCommands.ts`, `access.ts`, related providers/transports and `apps/server/src/app.ts`.
- `packages/core/src/data/*`, package exports and API/collab command types.
- `packages/core/src/components/renderers/CollabEditor.tsx`: frontend may adjust formatting presentation only; backend needs command/composer prop wiring. Do not broadly rewrite this component from both branches. Prefer separate wrapper/helper files; exchange exact hunks/contracts before merging.
- `CommentsSidebar.tsx`: backend command callback integration is incomplete on the WIP branch; frontend must not refactor its command behavior concurrently.
- Shared manifests/dependency lockfiles: no opportunistic dependency updates from either stream.

Frontend document polish can flow through shared PageHeader without modifying backend-owned CollabDoc. If safe rename/permission behavior requires a host change, record it and coordinate instead of claiming it is fixed on every host.

## Backend start instruction

Work in `/Users/benjaminlife/dev/prism/.worktrees/backend-followup` on `feat/backend-followup`. First read this coordination file from the main checkout, then BACKEND-HANDOFF.md, HUMAN-SUGGESTIONS-BACKEND-HANDOFF.md, DOMAIN-CONTRACTS.md and the relevant R07/R12 requirements. Start with a focused plan for closing human suggest-only enforcement, including persisted idempotency receipts and raw-Yjs rejection tests. Inspect commit20ffc13 as incomplete reference, not a ready-to-merge implementation. Reserve backend test servers outside frontend ports5188/5191–5193 (e.g.5194); do not load production env files or start workers.

Send the owner a short boundary note listing any client files/types you need before changing those shared files. Keep server/domain work in your worktree; make focused tested commits. Provide commits and acceptance evidence for root to integrate. Do not advance main, deploy/restart Prism Server, rebuild/reinstall Prism Client, or use live provider sends as part of isolated development without coordinating release ownership. Read the current main COORDINATION.md before integrating, as frontend ownership evolves.

## Integration and release

1. Use separate branches, explicit file-path commits and per-worktree test ports. No builds over main live web assets.
2. Report source commit, changed contract/files, actual tests and remaining limitations. A cherry-pick is reviewed for overlap; never resolve conflict by replacing the other stream's whole file.
3. Keep frontend visual/behavior acceptance separate from backend contract acceptance. Preserve truthful unsupported states until backend capability is available.
4. Frontend deploys no server restart/migration. Coordinate backend releases separately with live health/active-turn check, online backup and rollback. Batch native builds/installs to avoid repeated owner Keychain prompts.
5. Before advancing main, inspect its current branch/status/recent commits. If the backend agent has advanced it, integrate in an isolated worktree first; do not force-push/reset/overwrite their work.

The owner can use the currently deployed app while isolated work proceeds. No maintenance freeze is needed.


## Active frontend integration update · October 2, 14:20 Denver

Backend work is now present in the prepared worktree. Frontend remains isolated on `feat/workspace-experience`; main application source is still the deployed release. Root owns the combined release. No server changes or restarts are part of the current frontend pass.

- Frontend integrated a **presentation-only CollabEditor** import of DocumentOutline plus a conditional read-only outline wrapper immediately before SuggestionReview (`701288c`). No command props/effects changed.
- A06 selection discovery is in progress: preserve the original CollabEditor comment callback; broaden the existing selection bubble to include a shared Ask/formatting component, with existing read-only/comment/suggest gates. The proposed hunk does not add command props, change comment transport or modify CollabDoc. Root will report the tested source commit before merge. `documentSnapshots`, `chatStore` and an AgentChat consumer get **frontend-only unsent snapshot handoff**, not a new API or automatic turn.
- Backend may own the shared collab command schema/package export now in its worktree. Frontend does not modify those manifests or command contracts.
- Frontend still cannot safely fix collaborative title rename: CollabDoc returns void after optimistic path update and swallows the REST failure, so shared title UI cannot retain the failed draft reliably on that host. Backend host owner should await the mutation, surface failure, and only advance confirmed path/title. Plain DocumentRenderer already awaits and reports failure.
- New contract requests: [email envelope/Reply-all authority](backend-boundary-requests/email-compose-envelope.md) and [atomic agent draft policy precondition](backend-boundary-requests/agent-draft-policy-precondition.md). The frontend supports explicit To/Cc and a read-only draft workflow under the existing contracts; these notes explain remaining limits, not permission to merge incomplete semantics.

Current frontend file ownership additionally reserves WorkspacesPanel/WorkspacePanel/MembersPanel presentation and invitation result handling; API signatures/authority unchanged. Root owns Shell, TabBar and common creation integration. AgentChat presentation and selection consumer work are coordinated in disjoint hunks.


## Frontend reply to backend handoff · October 2

Read `backend-to-frontend.md` at backend commit `80295ad`. A verbatim copy is now in main so the owner's shared path resolves. Backend remains owner of the source handoff; future updates should be reconciled from its combined branch.

### Decisions and requests

1. **Opaque actor identity:** please add `GET /api/collab/:id/commands/me` returning `{ actorId: string }`, under the same authenticated/link-token/vault/note access resolution as POST. The UI needs it before the first mutation to decide whether Delete is offered. Do not expose email or accept a client actor field. No need to change durable replay bodies merely for this. A denied/unknown identity keeps Delete unavailable; the server remains authoritative.
2. **Suggestion overlap:** keep the conservative refusal when a caret touches a pending suggestion. Frontend will preserve draft text and explain that the passage already has a pending suggestion; user can select an unambiguous position. Do not weaken enforcement for presentation convenience.
3. **Comment failure/unload edge:** please resolve the documented unanchored-thread case before declaring the command workflow release-ready. The retry must either complete one anchored durable thread or explicitly recover without leaving orphan data. This is backend receipt/save recovery ownership, not a UI workaround. Keep the regression test for failure→unload→identical retry.
4. **Combined branch/review:** frontend will not integrate the suggestions branch until independent review is complete and you provide the combined tested server tip. Backend should resolve the transcript/suggestion server-test overlap. No force replacing shared files.

### Frontend commitments (not yet verified)

- Prove revision parity using an actual CollabEditor with its client extensions, comments, rich blocks and suggestions; compare against the server/shared-schema projection of the same Y fragment. Also prove caret/range capture in non-editable editor on Chromium/WebKit and installed client. Do not assume fixture helper parity proves this.
- Read provider scope on each authentication/reconnect; with enforced readonly suggest sockets, use bounded commands instead of raw body/comment edits. Preserve legacy tracked typing while enforcement is off. Scope-specific command transport retains capability token even when signed in, matches vault binding, displays `message`, branches on `error`, and handles middleware 429 without assuming message exists.
- Frontend owns CollabDoc/CollabEditor/CommentsSidebar/access/transport integration after the current A06 selection presentation checkpoint. Existing A06 edits keep command behavior unchanged. Notify backend when access table/test assertion is changed; it belongs in the same combined release.
- Transcript UI will preserve identical request bytes/ID on pending/unknown outcomes, drop superseded pending requests, distinguish stale/vault-unavailable/actor-change/access loss, honor rate-limit retry timing, and handle absent start times without local-time date shifts. Only real note IDs are submitted.
- Keep the trusted-collaborator warning until enforcement is actually live. Stage server with enforcement off, ship/verify command-capable client, then enable enforcement in a separately checked server restart. Coordinate the online backup, rollback and live traffic checks at that time. No server restart is authorized merely by this handoff acknowledgement.

The frontend aesthetic work continues independently; these integration gates do not replace the accepted frontend screen matrix.


## Frontend acknowledgement of review update · October 2, c2bb328

The owner forwarded the revised handoff; main now mirrors the backend-owned document at c2bb328. Backend re-review remains pending, so no server integration or rollout has occurred. The shared file is a mirror, not a second independently edited contract.

- Frontend command planning now includes single-paragraph fully markable selections, no suggested line breaks, inline-code/break/embed refusal, 4,000-character comment/reply limits and the new quota/size codes. It will not silently split a user's suggestion into multiple writes.
- Only confirmed 200 response IDs are authoritative after a retry. An uncertain resolve/delete followed by409 triggers refreshed thread state. Readonly raw typing remains closed and provider authorization scope is reread after each authentication.
- **Actual editor audit completed:** frontend docs commit `f8234c0` on `feat/document-polish` records4 passing Chromium/WebKit × desktop/390px cases, rich editor JSON/hash parity with shared-schema Y-fragment projection, and explicit readonly insertion positions. Native pointer collapse is inconsistent; the composer will offer before/after captured range (and explicit empty-document positions), not rely on stale native caret selection. Production seeded empty paragraphs match; an unseeded synthetic Y fragment does not. Installed-app proof remains outstanding.
- Our prior GET actor identity request and orphan-comment recovery request remain open until acknowledged in the reviewed backend contract. Conservative suggestion overlap refusal is accepted.
- People profile UI uses only actual related-record category/path/relationship fields; it does not invent message snippets, channel labels or dates. Graph identity/linking backend work can continue independently.
- Current frontend owns GraphExplorer (root), PeopleWorkspace (`feat/people-polish`), canvas presentation/cards (`feat/document-polish`), and transcript/calendar UI/transport (`feat/transcript-calendar`). Transcript provider exports in core/index and web/main are frontend-owned; server routes and shared command schemas remain backend-owned.

Root's combined selection/conversation browser run passed88 checks. This is isolated frontend evidence, not a production or full-roadmap completion claim.


## Frontend acknowledgment of second-review handoff · October 2

Main now mirrors backend handoff `0839820`. Human enforcement is ready for **integration review**, with the last fixes not independently re-reviewed; this is not deployment approval or proof of the combined branch. Please deliver the combined tested transcript/suggestion branch as agreed. Keep the first rollout at `COLLAB_SUGGEST_ENFORCED=false`. No frontend production or native update has been made in this batch.

- New socket real-ID restriction, text hygiene/bounds, actor growth limit, both 429 forms, and review-race recovery are recorded for client integration. We will audit actual socket entry points and exercise the combined client before enforcement.
- GET actor identity (`/commands/me`) and orphan-comment recovery requests above are still open in the handoff. Please explicitly answer them in the reviewed contract; the current document still lists the orphan edge as not fixed.
- The frontend now owns the bounded A05 CollabDoc rename fix under the boundary agreed above: await existing scoped REST/outbox acceptance, retain failed title drafts, prevent duplicate submission, distinguish locally queued from synced. No server or command transport edits. Real collaborative-host Chromium/WebKit checks are running.
- Calendar/transcript UI source `1c9ddca` is integrated and all70 combined browser journeys pass. Its provider replaces the old transcript-link presentation, so the new transcript endpoint must be live before this client ships. A404 cannot safely mean unsupported because the contract also uses404 for access loss.
- Backend git tracks `BACKEND-TO-FRONTEND.md` uppercase while main tracks `backend-to-frontend.md` lowercase on a case-insensitive filesystem. During the eventual merge preserve a single canonical lowercase main file and the newest backend content; do not create two case variants.

Frontend parallel ownership remains disjoint: root CollabDoc/title and release integration; publishing agent now EmailRenderer/AgentReplyDraft presentation; context agent LinksPanel and proposed Metadata/History polish; connections agent ServerPanel. Backend source remains untouched by these slices.


## Command-client integration questions · October 2, frontend audit

Frontend B05 integration is now assigned in an isolated worktree; no server enforcement changes. The latest contract needs three explicit answers before durable command receipts can be scoped correctly:

1. Our requested `GET /api/collab/:id/commands/me` should return authoritative opaque actor identity **and the resolved workspace/vault identifiers** for the command audience, under the exact POST credential/access resolution. Existing `captureWriteContext()` treats any presented link as a capability actor and invents default/primary scope when link headers are absent, so it cannot distinguish signed-in-account vs guest transitions on the same link. The command client will not reuse that approximation for receipt identity. Please specify the response and request header rules, especially a link bound to a non-primary vault.
2. Native socket `collabToken(capability)` currently presents only the capability, whereas HTTP commands must retain native bearer/cookie identity and pass the link in `?t=`. Please document the intended actor/grant interaction for this case; the frontend will not improvise a new socket token protocol. Command HTTP will avoid Authorization:Capability overriding the device bearer.
3. Please acknowledge orphan-comment failure/unload recovery status and supply the combined tested transcript/suggestion tip when available. The handoff still lists that edge as not fixed. The initial release must retain enforcement=false and the trusted-collaborator warning until the complete client/server journey is proven.

Socket entry audit: normal Canvas/Search/CommandBar and wikilink navigation already use returned note.id. The standalone `/collab/:suffix` accepted an arbitrary path/title; frontend is adding fresh authorized canonical-ID resolution before opening its socket, plus the missing query provider for the current rich editor. Real-ID/alias browser checks pass; capability-link checks are running. No backend auth or socket protocol changes are included.


## Frontend dependency checkpoint · October 2, 16:00 Denver

Frontend commit `327572e` imports `packages/core/src/lib/collab/commands.ts` and its one package export **verbatim from backend0839820**. This is the shared dependency for isolated client helper tests, not a server merge, backend modification, or independent security review. Backend remains owner of that contract.

The standalone collaborative route now resolves an authorized canonical note ID before opening a socket (`e46f2d4`); eight Chromium/WebKit actual-entry journeys pass, including path aliases, capability query/header propagation and denied-resolution retry. The three command identity/recovery questions above remain open.

Client lifecycle inspection found that Hocuspocus starts synchronization immediately after sending authentication, before its authenticated-scope callback. The client must therefore gate cache generation/reconnect **before synchronization**, not merely in that callback, to prevent retired offline edits from an old tab replaying after a permission downgrade. The frontend agent is testing independent helpers before wiring this change; enforcement remains off and the trusted-collaborator warning stays. No server restart or deployment has occurred.


### Command actor precondition and publishing follow-up

The independent client helpers now have fixture proof for exact-byte receipts and native Bearer plus capability query transport, with no production caller activated. A remaining contract issue: identity preflight alone cannot bind a POST atomically to that actor if the browser cookie/account changes between the two requests. Please specify a server-checked expected-actor/audience precondition (or an equivalent existing guarantee) before we describe pending receipt identity as fully enforced. Frontend can suppress observed scope changes; it cannot make a preflight check atomic. This supplements the `/commands/me` request above and does not authorize a client-chosen actor.

Publishing navigation remains an original D06/R13 requirement. Held commit `51ec5bc` contains both frontend and server changes, with known overlaps in publication presentation/routes and a private-preview frame change. Please review/integrate its **backend contract and boundary filtering** in your combined backend stream, or identify a separate safe checkpoint. Root will reconcile the UI against the newer publishing studio rather than cherry-picking the whole mixed commit over your work. Keep current access/password/exclusion behavior and private navigation filtering. This is already listed in BACKEND-HANDOFF, not a new publishing engine request.


## Frontend integration checkpoint · October 2, 16:25 Denver

The aesthetic branch is now through `ad2a07e`: focused governance sections, scoped document history, email/agent dock, publishing studio, Connections, specialist renderer preservation, saved graph views, labeled mobile navigation, auto-growing composition and scoped thread reading positions are integrated with focused browser evidence. Search→unsent agent context and dedicated read-only summaries are the final active frontend slices. Current main application source and production remain unchanged; GET `/health` returned `{ok:true,vault:true}` at this checkpoint.

At frontend `58b68ac`, web and native web bundles built successfully; native static checks, six packaged startup/recovery checks, and host/agent/event/media verifiers passed. Later mobile/thread commits require the final combined rebuild. These checks do not certify the installed Mac app or production rollout. The UI batch will not be installed repeatedly while testing.

Release dependency reminder: the integrated transcript UI requires the reviewed transcript endpoint before deployment. Please provide the agreed combined tested transcript/suggestion tip and explicit answers to the command identity/native principal/orphan recovery questions when ready. Frontend has not merged or restarted your server. Human command helper tests are isolated and inactive in production; enforcement remains off until its full integration is proven.


## Frontend review of combined backend preparation · October 2

Found `feat/backend-combined` at `a98c9af`, with transcript and identity branches merged. The handoff still describes the branches as uncombined; frontend treats this as preparation until the backend owner reports combined tests and the pending contract answers. No server merge or restart has occurred.

- Read `BACKEND-STATUS-GRAPH.md` at `f1538ca`. Frontend will align the Messages person filter with the actual server `isTombstone` / `isNonHumanPerson` predicates. The suggested snippet near line399 still excludes any `merged_into` pointer, contradicting the third-pass rule that an unmarked pointer-only person remains live. Please update that snippet; frontend will preserve pointer-only people. No backfill, merge, or ingest flag is activated by this UI change.
- D01 search-to-unsent-context and C07 separate read-only summaries now have Chromium/WebKit evidence and are awaiting root integration. C07 task creation remains open: existing TaskBoard metadata/schema is reusable; the missing seam is confirmed per-item identity/recovery for task creation, not a missing task domain. Generic `createNote` can return a newly generated offline ID after an uncertain request, so it cannot yet establish this extraction flow's durable per-item result.
- D06 publishing navigation UI reconciliation is proceeding in an isolated frontend worktree against the exact held `51ec5bc` contract. It will not ship until compatible server validation/projection is acknowledged and included in the same release. No runtime support is inferred from ordinary presentation support, and no probing write will be used. Please include the held backend navigation validation, authorized manifest projection (public and private preview), and unknown-version behavior in your backend stream, preserving current access/password/exclusion rules. No new endpoint is requested.

Root full frontend regression is running against `373d1fd`; the only failure found so far is an older review-list assertion that predates the intentionally single-change review navigator. Source remains frozen during that run.


## Combined handoff acknowledged · October 2, backend412db96

Main's canonical lowercase handoff now mirrors backend `412db96`. The combined branch and reported1,673 server tests/root typecheck are acknowledged; no further initial-combination request is open. Root will merge this pinned snapshot into the isolated candidate for integration checks. No production deploy has occurred. Please send the final short graph-agent review result/fix tip when available.

The basic failed-comment store→unload→identical retry recovery is implemented (`34fe68a`/`67abdd7`, `human-collab.test.ts:1270`). The earlier open request to implement that case is closed. Preserving other participants' replies after anchor loss is a documented recovery boundary, not an automatic new blocker.

Messages frontend `53571f5` now filters the exact server tombstone/nonhuman markers, retains bare-pointer humans and includes `email-to` without duplicate threads. Initial classified inbox disclosure is fixed in `90ae371`. The combined inbox/context/message run passed100 Chromium/WebKit journeys. No backfill or identity-merge job was run. Backend retains live cleanup ownership as the updated handoff states.

Publication navigation frontend is ready in `c17d357` with evidence `a294b3f` (`feat/publishing-navigation-ui`). This reuses the exact held51ec5bc shared schema. Please integrate the held **server-only validation and public/private-preview projection**, plus its exact shared-helper dependency, into your branch or explicitly transfer those four server files/test to root. They are not present in412db96. Existing presentation support cannot accept these navigation writes. Root is finishing a separate compact studio/phone-preview layout; it does not change this contract.

Command identity remains a later enforcement activation gate, not a reason to hold the aesthetic release when explicitly `COLLAB_SUGGEST_ENFORCED=false`. Existing `X-Prism-Write-Actor` is a partial precondition we can reuse: please return a compatible authoritative write binding plus actor/resolved audience from `/commands/me`, and align query-token/native principal resolution, rather than inventing another protocol unnecessarily. Frontend independent helpers remain inactive; the trusted-collaborator disclosure remains.


### Publishing integration ownership refinement

To finish the already-implemented D06 UI without adding another backend workstream, root is reserving the existing held51ec5bc **four-file publishing adapter** now: `apps/server/src/publication-presentation.ts`, `apps/server/src/routes/acl.ts`, `apps/server/src/routes/publish.ts`, `apps/server/test/publish.test.ts`. None differs in the current combined backend WIP (which is config/identity/MCP review). This supersedes the request above for you to independently port these same hunks: please leave these four files to root and continue your graph/command work. Root will port only the held validation/projection and tests in an isolated worktree, retain the exact shared helper, and report the resulting tested commit here. There is no new route, authority or background-job behavior. The shared web/native release will include both sides together, preserving password/private exclusions. No production change is part of this reservation.


## Combined release candidate · October 2, final frontend integration

Backend `98287de` is now merged into the isolated frontend branch at `9c84b6c`. Root independently ran the full combined server suite: **1,684 passed, zero failures/skips**, including the reserved D06 publishing adapter (`7c7c2b4`, original `dee27c6`). The four reserved publishing files are complete; please do not port the held adapter again. Its evidence is `D06-PUBLICATION-CONTRACT-EVIDENCE.md`. Main application source and production have not changed at this checkpoint.

The final client candidate includes custom publication navigation with public/private-preview filtering, compact phone preview, fresh search-to-unsent-agent-context, separate read-only conversation summaries, compact agent controls, resize-aware composition, canonical people filtering and classified-inbox disclosure. Final combined web/native builds and production/installed-app acceptance follow. Browser authentication and Mac accessibility are available.

The release will explicitly retain `COLLAB_SUGGEST_ENFORCED=false`; command helpers remain inactive, with the trusted-collaborator disclosure. Optional graph agent/ingest/linking flags remain off. No identity backfill, live cleanup, agent skill installation or broadened tool grants are part of this frontend rollout. The backend owner retains those live cleanup responsibilities. Authoritative command binding/native principal agreement and confirmed per-item task extraction recovery remain named follow-ups, not aesthetic-release prerequisites.


## Frontend batch deployed · October 2, `cb3178a`

Main now contains the combined candidate (`252657b` final application source, `5224aab` documentation tip, release merge `cb3178a`). Web artifact `index-BeF6y7Xx.js` is active in the authenticated production browser. Server restarted once with explicitly `COLLAB_SUGGEST_ENFORCED=false`; eight enabled workers and local/public health pass. Optional graph/ingest linking flags remain unchanged/off. Backup `apps/server/data/workspace-experience/releases/5224aab` includes integrity-checked online DB, prior web, settings and installed app; zero active turns preceded restart.

Final checks: 1,684 server tests, all application/e2e typechecks, 124 affected Chromium/WebKit journeys, web/Mac builds, six packaged native startup checks, native/client static checks and agent/host/event/media verifiers passed. The signed Mac app is installed but actual updated workspace acceptance is waiting on its changed-signature Keychain prompt. Production web has verified the new creation dialog/location inference, document edit and independent saved readback, phone layout, preserved message draft across responsive layout, sender groups and summary entry. Publishing verification is underway against a temporary password-protected synthetic site with zero eligible pages; private source notes remain unchanged.

A real read-only agent turn found an existing runtime account issue: Claude returned “OAuth session expired and could not be refreshed.” The configured executable resolves to the normal local Claude CLI; its auth-status reports the expected subscription login but the actual generation failed. The user has been asked to renew Claude login, then root will retry the guarded turn. Do not mark agent production acceptance passed from auth-status alone. No account credential or environment allowlist workaround was introduced.
