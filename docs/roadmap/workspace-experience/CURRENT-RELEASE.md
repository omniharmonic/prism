# Current release and remaining work

Snapshot: **2026-10-02, deployed redesign `cb3178a`; acceptance continuing**. This status supersedes older current-state summaries; historical checkpoints remain evidence of their named versions. The [approved full plan](POST-MIGRATION-PLAN.md) remains in progress. This is not a claim of full Notion parity.

## Normal use and release state

**Normal vault use can continue.** The last recorded production health check found the server and vault ready and all eight enabled workers healthy. Current development checks use isolated fixtures and test databases; production checks use guarded private records. Remaining roadmap work does not require a maintenance freeze. A native replacement requires checking for unsaved work and briefly closing the app; a server restart must avoid active agent turns.

| Artifact | Current state |
| --- | --- |
| Production web | **`252657b` application source**, `index-BeF6y7Xx.js`, deployed through merge `cb3178a`. Authenticated PWA activated the new asset set. |
| Production server | **`cb3178a`**, including reviewed backend `98287de` and D06 adapter. Explicit `COLLAB_SUGGEST_ENFORCED=false`; optional linking/graph flags remain off. Local/public health and eight enabled workers pass. |
| Installed desktop | Final **`252657b`** build, locally signed and installed in Applications. Startup reached saved sign-in; changed-signature Keychain approval and actual updated workspace checks remain pending. Prior `86461c9` evidence is historical. |
| Rollback | Integrity-checked online DB, previous web, server settings and installed app in ignored `apps/server/data/workspace-experience/releases/5224aab`. Zero active turns before the single server restart. Preserve subsequent user writes on rollback. |

The earlier `86461c9` release passed 218 Chromium journeys and its named native/production checks. Current verification is recorded below and in [release checkpoints](RELEASE-CHECKPOINTS.md); earlier native success does not certify the new installed app.

## Integrated redesign against the acceptance matrix

| Matrix scope | Implemented candidate behavior / evidence |
| --- | --- |
| A01–A08, B01–B04 | Compact five-beams-to-one prism mark; clearer navigation and device preferences; title-first contextual creation; open-document overflow/reorder; quieter document properties/formatting/outline; width-aware companion with session, source, activity and permission controls. The compact companion retains its editor/session/draft through reflow, and its composer resizes with wrapped text. [Matrix](FRONTEND-ACCEPTANCE.md), [companion evidence](COMPANION-DENSITY-VERIFICATION.md). |
| C01–C07, C09–C10 | Desktop inbox master/detail and phone back flow, clearer sender/recipient identity, quiet email and docked draft agent, read-only summaries, retained reading positions and auto-growing composition. Classified inboxes expose a conversation initially; People filters actual merged/nonhuman records and includes recipient-linked email. [Visual audit](FRONTEND-VISUAL-AUDIT.md), [identity evidence](MESSAGES-PEOPLE-IDENTITY-EVIDENCE.md). Confirmed task extraction is still missing. |
| D01–D04 | Search has separate open/attach actions and fresh, unsent agent-context handoff without replacing session/drafts. Calendar/transcript review includes explicit retry/recovery; graph has readable map/list and device-local saved views; canvas and boards have polished surfaces, board drag ordering and phone list behavior. See the named evidence in the matrix. Large-inventory performance and physical-device acceptance are separate. |
| D05, D07–D09 | Name-first workspace setup, clearer invitations with partial-success recovery, focused governance, Connections grouped by account/processing/operations, and specialist-renderer preservation. Existing authority and unavailable-state boundaries remain explicit. This does not add absent provider jobs or certify every specialist engine feature. |
| D06 | Publishing studio, section/page navigation ordering, reader fallback, compact chrome and phone Settings/Preview switching preserve drafts and mounted preview. Server validation and eligible-note projection are now integrated; this is no longer an unimplemented backend dependency. [Navigation](PUBLICATION-NAVIGATION-VERIFICATION.md), [compact studio](PUBLISHING-COMPACT-VERIFICATION.md), [server contract](D06-PUBLICATION-CONTRACT-EVIDENCE.md). Historical isolated-branch deployment warnings in those notes are superseded by this integration status, not by a production claim. |
| B05 | Focused suggestion review and canonical standalone entry are integrated. Independent human-command helpers exist, but the restricted-human command/lifecycle flow is **not activated**. Agent Read-only / Suggested edits only / Read/write modes remain available and distinct. |

## Current verification boundary

- Root reports **1,684/1,684 combined server tests passed** in 48 seconds after the reviewed backend and publishing contract integration. The reserved D06 slice independently passed 47 publishing/multi-vault checks and server typecheck. These use test data; neither count establishes production acceptance.
- The all-files frontend run at `373d1fd` yielded 1,046 passes, two native-mode-only skips and four failures. The real Safari Share-focus issue and obsolete/unsupported fixture assumptions were corrected; 36 affected sharing/review/wikilink checks then passed. Later source slices have targeted two-engine evidence, not a claimed second complete fixture pass.
- Publishing compact/navigation suites passed 45 cases per engine; the final spacing/capture follow-up passed eight per engine. Companion/composer resize checks passed 28 across both engines. Actual fictional screenshots were inspected against the approved boards.
- Final application source `252657b` passed all application/e2e typechecks, web/Mac builds, native/client static verifiers, six packaged Chromium/WebKit startup checks and agent/host/event/media verifiers. The final combined publishing/companion/collaboration batch passed **124 Chromium/WebKit journeys**. Production web confirmed contextual creation UI, saved private document edits, responsive draft preservation, sender groups, unsent context attachment, publishing save/preview/publish/restore and privacy boundaries. Actual updated WKWebView acceptance remains pending.

## Open release and roadmap gates

1. The reviewed transcript and publishing contracts are deployed with their frontend consumers. Complete updated installed-app acceptance after Keychain approval. A real agent turn failed with “OAuth session expired and could not be refreshed”; the user has been asked to renew the Claude CLI login before retry. Its local auth-status alone is not proof of a working generation. Native publication preview and transcript write/recovery still require named live evidence.
2. **Keep `COLLAB_SUGGEST_ENFORCED=false` for the initial combined rollout.** The new server defaults enforcement on, while the frontend human-command replacement remains inactive. Human “Can suggest” still requires the trusted-collaborator disclosure. Authoritative actor/audience identity, compatible expected-actor binding, native bearer/capability alignment and pre-sync retired-cache protection remain activation gates. Basic failed-comment-store → unload → identical retry recovery is already implemented; it is not a missing-backend request. Preserved replies may need honest unanchored recovery presentation.
3. **C07 confirmed task extraction/creation remains a contract gap.** Draft replies and summaries do not satisfy it. Ordinary page/task quick-add and boards remain available.
4. Real phone keyboard/IME/dictation/PWA, actual browser 200% zoom, remaining native extras, broader controlled provider journeys and concurrent multi-reviewer evidence remain unfinished. Reflow screenshots and fixture test counts cannot close these gates.
5. The broader plan still includes complete structured message/archive reconciliation, large-inventory performance, effective-access/governance previews, restricted guest onboarding and additional integration mapping/job semantics. Distinguish remaining frontend work from backend delivery and production acceptance; do not re-list integrated navigation, transcript routes or board ordering as unimplemented.

Continue remaining work in isolated, reviewable slices while the owner uses Prism. [FRONTEND-ACCEPTANCE.md](FRONTEND-ACCEPTANCE.md) retains original requirements and current slice evidence; the release owner records actual deployment and rollback IDs in [RELEASE-CHECKPOINTS.md](RELEASE-CHECKPOINTS.md).
