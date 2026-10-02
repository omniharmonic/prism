# Current release and remaining work

Snapshot: **2026-10-02, frontend redesign integration**. This concise status supersedes the older deployment summary and package table at the top of IMPLEMENTATION.md; historical checkpoints remain evidence of their named versions. The [approved full plan](POST-MIGRATION-PLAN.md) is still in progress.

## Normal use and release state

**Normal vault use can continue while this work proceeds.** The last recorded production health check found the server and vault ready and all eight enabled workers healthy. Automated browser tests use isolated fixtures; production mutations use guarded private synthetic records or temporary protected sites. No maintenance freeze is required for the remaining roadmap. A native app replacement briefly requires closing that app after checking for unsaved work; server restarts must avoid active agent turns.

| Artifact | State at this checkpoint |
| --- | --- |
| Production server/web | Web `86461c9`; running server retains compatible `6445136` behavior. Main source includes the equivalent escaped-NUL cleanup; no server restart was needed for this frontend release. |
| Verified frontend release | `86461c9` on `feat/workspace-experience`; combined builds and 218 browser journeys passed. |
| Unreleased aesthetic revision | Active `feat/workspace-experience` worktree; see [frontend acceptance matrix](FRONTEND-ACCEPTANCE.md) for source/evidence. Latest web/native bundle checkpoint `58b68ac` passed builds and packaged startup checks; subsequent mobile/thread changes await the final combined rebuild. No artifact in this row is installed in production. |
| Installed desktop | `86461c9`, locally signed and installed in Applications. Saved sign-in, private editing, browser/native live collaboration, document-bound read-only agent, boards, canvas and private preview exercised. |

The previously deployed frontend release passed all 218 Chromium journeys, application/e2e typechecks, web/macOS builds, six packaged Chromium/WebKit startup checks, and host/agent/event/media verifiers. The overflow slice additionally passed 30 focused Chromium/WebKit journeys. The server baseline passed 1,440 tests; the equivalent source separator cleanup passed 44 focused publishing tests. These counts do not replace the actual production evidence below.

## Implemented, with evidence

| Surface | Delivered behavior and verification boundary |
| --- | --- |
| Workspace and documents | Shared responsive shell, Agent/Details/Activity panel, prism branding, scoped tabs/shortcuts/drafts, document recovery and stable editor across resizing. Private production edit/reload, code/spreadsheet and responsive journeys recorded. |
| Agent beside a document | Pinned working document, source previews, captured passages/files, durable follow-ups and per-session Read-only / Suggested edits only / Read/write. Server tool policies and downgrade barriers tested; actual native suggested and direct edits were verified on an earlier release. |
| Conversations and people | Clear sender identity, multiline rendering, saved/live history, retained reply drafts, canonical person profiles and exact-identity conflict handling. One controlled private Matrix send was verified end to end. |
| Connected knowledge | Scoped semantic search/index maintenance, wikilinks, exact calendar/transcript navigation, focused graph, canvas note picker and durable relationship assertions. Named private web journeys and earlier native journeys recorded. |
| Tasks and sharing | Configurable boards, property/date filters, manual per-view ordering, phone list mode; People/Links/Publish/Sync controls and live access revocation. Private production journeys preserve underlying note data. |
| Publishing | Scoped content preview, private exclusions, password recovery, appearance drafts/history, wiki/docs/landing layouts and private reader preview. Production save, 390px preview, publish, restore-as-draft and native preview passed with password/private-note boundaries preserved; the temporary site was removed. |

Evidence: [implementation log](IMPLEMENTATION-LOG.md), [historical implementation checkpoints](IMPLEMENTATION.md), and [production release checkpoints](RELEASE-CHECKPOINTS.md). Earlier native success does not certify later uninstalled changes.

## Release gates still open

1. The current frontend release checks and named desktop journeys passed. Physical mobile/device tests, less-used native extras, and broader integration/concurrent-review journeys remain distinct unfinished acceptance work; do not generalize the passed slice to every capability.
2. **Human “Can suggest” is not a server-enforced restriction on direct edits.** Current guidance says to grant it only to trusted collaborators. Client tracking is distinct from the enforced agent session policies; restricted guest collaboration remains an open authorization gate.
3. Complete real mobile-device keyboard/IME/PWA coverage, remaining native extras, and multi-person/reviewer concurrency evidence. Fixture/WebKit tests cannot substitute for those environments.

## Remaining scope from the broader plan

Structured message edits/redactions/archives and identity repair; transcript ambiguity review/manual overrides and multi-recording reconciliation; large-inventory paging/performance; canvas claim cleanup and board drag ordering; effective-access/governance previews and guest onboarding; custom publication navigation; consolidated integration controls and controlled provider journeys remain unfinished. These are follow-on implementation or evidence requirements, not proof that ordinary document editing is unavailable.

Continue these in isolated, reviewable slices while the user uses Prism. The current release must not be described as full R00–R16 completion or verified Notion parity. Update the artifact table and open gates after final acceptance, retaining the precise distinction between automated tests, production web, and installed desktop evidence.


## Current isolated frontend checkpoint

The integrated redesign now includes title-first page creation, calmer workspace/document/agent/message layouts, email’s docked agent, context links/properties/history, task/calendar/canvas/graph presentation, publishing studio, Connections, governance sections, specialist preservation, labeled phone navigation, auto-growing composition, and saved thread/graph positions. Detailed source commits, screenshots and limitations are in FRONTEND-ACCEPTANCE; these are not yet new production claims. Search-to-agent context and dedicated conversation summaries are now integrated with browser evidence. Active UI work is publishing navigation/compact preview and the whole-screen audit’s inbox discoverability/canonical-people corrections. Confirmed task extraction remains a backend contract dependency.

At `58b68ac`, web build, native web build, native/client static verifiers, six packaged Chromium/WebKit startup/recovery checks, agent15/host19 checks and events/media verifiers passed. Current mobile/thread integration subsequently passed50 combined browser journeys. Normal production health still returned `{ok:true,vault:true}`. A final build and installed/production acceptance are required after all UI slices and the reviewed backend release dependency are integrated.

The new transcript provider requires its reviewed server endpoint; human command helpers remain inactive pending authoritative audience identity and pre-sync cache protection. Existing agent session permission modes remain available. The separate backend owner and root release owner coordinate through main’s COORDINATION.md.

Latest root regression: all64 fixture files at `373d1fd` produced1,046 passes,2 native-mode-only skips and4 failures. `a5e7d32` fixes the real Safari Share-focus defect and reconciles outdated/unsupported test assumptions;36 focused two-engine checks pass. D01/C07 integrated in `6fc479a`/`64dc31c`, with explicit fresh-note handoff in `9d93b3a`. No production or installed artifact changed. Backend combined branch was found at `a98c9af` with active uncommitted follow-up work; it is not treated as a release-ready handoff.
