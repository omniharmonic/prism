# Backend handoff — frontend-first reset

Updated 2026-10-02 after the owner clarified the priority: deliver the approved frontend aesthetic and stop letting backend expansion delay it. This is a handoff for a separate backend agent, not a claim that the full roadmap is complete.

## Start here

Read `POST-MIGRATION-PLAN.md`, `DOMAIN-CONTRACTS.md`, `CURRENT-RELEASE.md` and the newest `RELEASE-CHECKPOINTS.md` entries in this directory. Architecture migration reference: `docs/roadmap/architecture-v2/`. The user wants a clean Notion-like workspace with human and agent collaborators; agent sessions must retain **Read-only, Suggested edits only, and Read/write** choices.

Main checkout: `/Users/benjaminlife/dev/prism`. Frontend integration worktree: `.worktrees/workspace-experience`, branch `feat/workspace-experience`. Create a separate backend worktree; do not modify either of those working trees or another agent's WIP. Coordinate changes to public types, providers and route contracts before editing frontend-owned files.

At this handoff, production web and the installed Prism Client use **86461c9**. Running server behavior remains **6445136**; the later separator cleanup is equivalent and did not require a restart. Normal use is available. Previous successful counts (218 browser journeys, 1,440 server tests) certify those named releases, not new WIP.

## Ownership boundary

Frontend agent owns navigation, creation, document/companion layout, message presentation, workspace setup UX, tokens, responsive polish and visual acceptance against `MOCKUPS.md`. Use current transport contracts. Do not require a new backend feature before improving these screens.

Backend agent owns the unfinished server capabilities below. Preserve existing public contracts or make additive, capability-gated changes. No speculative migrations, new workspace ontology, editor schema replacement or bulk note rewrites as part of this handoff. Publish reviewable commits and exact verification evidence for integration; coordinate one server release, avoiding active agent turns, with an online database backup and rollback assets. Never rebuild/reinstall the desktop app on every backend commit.

## 1. Human suggestion enforcement — highest correctness priority

Isolated branch **feat/human-suggestions**, worktree `.worktrees/human-suggestions`, WIP commit **20ffc13**. Read `HUMAN-SUGGESTIONS-BACKEND-HANDOFF.md` from that branch before using any code. It contains server command/auth/revision/receipt scaffolding and partial frontend controls. **Not release-ready: web typecheck fails at unfinished comment callback props; behavioral acceptance is absent. Do not cherry-pick the WIP wholesale into production.**

Current released limitation: a human `Can suggest` grant is not a server-enforced restriction on raw Yjs updates. Sharing UI explicitly says to grant it only to trusted collaborators. Agent session policies are separate and already enforced; do not regress them or claim the human gap affects those policies.

Target: raw collaboration updates require edit authority. Suggest actors retain live reading/presence and submit bounded structured replacement/insertion/deletion commands against an exact live range/quote and document revision. Server derives actor identity, verifies fresh grants and document access immediately before the synchronous mutation, rejects stale state with 409, and records idempotency receipts atomically. Comments/replies/resolution also need constrained commands. Preserve draft after conflicts and support explicit retry. Unsupported non-prose suggestion semantics must remain read-only with an explanation.

Required acceptance: direct raw updates, deletion sets, hidden roots and pending structs cannot mutate as suggest-only; guest capability/user actor attribution is authoritative; revocation/downgrade races fail closed; edit users still collaborate normally; lost acknowledgements do not duplicate changes. **Prove receipts survive real persistence and document reload/external reseed**, not merely an in-memory test. Use a durable server receipt if the current document persistence drops the receipt root. Remove the trust warning only when these gates pass.

## 2. Calendar/transcript review and reconciliation

Backend not yet implemented. Relevant files: `apps/server/src/worker/transcript-match.ts`, `worker/calendar.ts`, `routes/calendar.ts`, `parachute.ts`, `auth/actor.ts`, and `test/transcript-match.test.ts`. Use `routes/canvas.ts` for authenticated vault-identity/access patterns.

Existing matching is deliberately conservative: explicit calendar event ID wins, conflicting ID rejects; dates/times/participants/title contribute evidence; insufficient margin or ambiguous reverse matching does not auto-link. Preserve recurrence/timezone handling and cancelled-event exclusions.

Current gaps: worker chiefly handles one transcript per event; repair only covers certain calendar-created singular backlinks; writes lack consistent CAS; deletion protection checks singular metadata. Add multiple-recording support, manual link/unlink/move with reasons, and repair of both directions after partial failures. Never delete a transcript to unlink it.

Use a **server-owned durable decision journal**, scoped to vault registry identity and actor. Do not treat editable note metadata as authority to modify another note. Preserve an explicit manual unlink so the worker cannot immediately relink it. Serialize automatic/manual decisions per transcript, recheck overrides inside that critical section, CAS each affected note, preserve unrelated metadata/content/tags, and reauthorize repair. Reused request ID with different body must fail. An incomplete write reports pending honestly; retry the identical request ID reconciles and eventually returns applied.

Frontend prototype: isolated branch **feat/transcript-review-ui**, worktree `.worktrees/transcript-review-ui`, commit **11a38b6**. Eleven focused fixture journeys passed, but no typecheck, backend or live validation. Do not merge until API exists and integration passes. It preserves the old linked-list fallback without a provider.

Agreed additive contract (coordinate any change):

- `GET /api/transcripts/events/:meetingId?query=...`
- Result: `{ meeting: {id,eventId,title,updatedAt}, linked: [{id,title,start?,updatedAt,decisionRevision,canManage}], candidates: [{id,title,start?,updatedAt,decisionRevision,canManage,score,evidence:string[],linkedElsewhere}], limited:boolean, canManage:boolean }`.
- `POST /api/transcripts/events/:meetingId/decisions`
- Body: `{transcriptId, action:'link'|'unlink', reason, meetingUpdatedAt, transcriptUpdatedAt, expectedRevision, requestId}`.
- Response: `{status:'applied'|'pending', revision}`. Repeating an identical request must be an idempotent repair/retry path.

The web prototype uses existing audience-pinned `managementRequest('/api', ...)`, shared with native. Require signed-in actor, view-filter every returned title, require edit on both relevant notes for mutation, validate active vault/registry identity and latest actor/grants. Expose `canManage` honestly. Bound candidate enumeration/search (e.g. recent 200, query 50) and report truncation; do not disclose an inaccessible old meeting's title. Moving a transcript requires deliberate UI confirmation. Include legacy singular fields and typed links during reconciliation and event-retention checks.

Test exact/recurrent/timezone IDs, ambiguity, two recordings, manual overrides, stale versions, lost acknowledgement, partial repair, concurrent worker/manual operations, access revocation, private candidates and registry replacement.

## 3. Remaining roadmap backend work

Work in small independently tested slices, ranked by actual user impact:

- **Message correctness (R04):** structured provider edits/redactions/archives, canonical person links and identity repair. Preserve provider sender IDs, multiline bodies, reply references, attachment metadata and outgoing attribution. Do not guess identity from display name. Frontend polish must not wait for these additions.
- **Scale/search (R09):** inventory pagination/indexed projections, permission-filtered semantic search, batched wikilink aliases and bounded requests. Demonstrate large-vault performance with synthetic fixtures; do not make unverified global completeness claims.
- **Canvas (R10):** deleted claim cleanup/orphan review and offline concurrent relationship changes. Protect independently asserted edges; removing a canvas arrow must not delete a manually asserted relationship.
- **Access/governance (R12):** effective-access preview, onboarding/guest matrix, constrained suggestion gate above, review concurrency. Keep membership per vault distinct from workspace grouping and publication audiences.
- **Integrations (R14):** sync mappings and controlled Telegram/email/calendar/repository/Notion journeys. UI can use existing settings while contracts evolve. Do not send to other people. User authorized tests only in destinations confined to their own accounts/the bot; identify and prove destination membership before a send.

## Already isolated, ready for frontend review

- `feat/task-ordering`, commit **14f86c5**: per-board same-column ordering; 23 board fixture checks and web types passed. Cross-column preserves existing status CAS behavior. Not deployed at this handoff.
- `feat/publication-navigation`, commit **51ec5bc**: versioned optional publication sections/order, eligibility filtering at public/private-preview JSON boundaries and reader, WebKit private-preview interaction fix with restrictive frame CSP. 44 browser checks, 46 server publishing/ACL checks and workspace types passed. Not merged/deployed. Review sandbox/CSP and security checks before integrating.

Do not duplicate these slices or assume their branches are the production baseline.

## Environment and release discipline

Tests are fixture-only by default: `npm run test:e2e -w @prism/web`; backend `npm test -w @prism/server`; types `npm run typecheck`. Use a unique fixture port per concurrently running worktree. Dependencies and builds stay worktree-local. Do not edit source while that same worktree is undergoing build/test.

Production private test helpers and rollback artifacts live in main `apps/server/data/workspace-experience/` (ignored, sensitive). Do not print credentials or commit databases, profile state, environment files or private screenshots. Avoid re-running already completed external-send tests. A prior Matrix self-only send marker is `PRISM_LIVE_SELF_SEND_20261001`; do not send it again. Temporary publication tests have been cleaned up.

The owner browser uses named session `prism-owner` and a persistent profile under that private directory. Verify authentication from `/auth/me`, not the presence of hidden password inputs. Native CUA permission works; current installed saved sign-in works. Changed local signing may trigger Keychain approval; batch native releases to avoid repeatedly interrupting the owner.

Report exactly what was tested: fixture vs production, browser vs installed desktop, same owner vs different collaborators. Physical phone IME/PWA, broader provider journeys and multi-person concurrency remain separate gates. Do not describe an untested integration as complete or ordinary editing as unavailable while isolated work proceeds.
