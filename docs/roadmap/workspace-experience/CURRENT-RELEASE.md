# Current release and remaining work

Snapshot: **2026-10-02, resumed release verification**. This concise status supersedes the older deployment summary and package table at the top of IMPLEMENTATION.md; historical checkpoints remain evidence of their named versions. The [approved full plan](POST-MIGRATION-PLAN.md) is still in progress.

## Normal use and release state

**Normal vault use can continue while this work proceeds.** The last recorded production health check found the server and vault ready and all eight enabled workers healthy. Automated browser tests use isolated fixtures; production mutations use guarded private synthetic records or temporary protected sites. No maintenance freeze is required for the remaining roadmap. A native app replacement briefly requires closing that app after checking for unsaved work; server restarts must avoid active agent turns.

| Artifact | State at this checkpoint |
| --- | --- |
| Production server/web | `6445136`, including the site studio; production health and PWA activation recorded in [release checkpoints](RELEASE-CHECKPOINTS.md#site-studio-deployed-user-requested-pause--2026-10-02) |
| Release candidate | `86461c9` on `feat/workspace-experience`, in `.worktrees/workspace-experience`; combined builds and verification ongoing |
| Candidate follow-ups | Long-title reader/phone-preview wrapping (`b09a6d0`), responsive settings and available-panel handling (`0102059`), honest human suggestion-permission guidance (`86461c9`) |
| Installed desktop | Last recorded installed build `0495e07`; current installation and real desktop verification ongoing. Browser authentication and computer-use access have been restored. |

The last deployed baseline passed 209 Chromium journeys, 1,440 server tests, ten focused WebKit publishing journeys, web/macOS builds and six packaged startup checks. These counts apply to that baseline, not an uncompleted candidate run. The suggestion disclosure separately passed all ten sharing browser journeys.

## Implemented, with evidence

| Surface | Delivered behavior and verification boundary |
| --- | --- |
| Workspace and documents | Shared responsive shell, Agent/Details/Activity panel, prism branding, scoped tabs/shortcuts/drafts, document recovery and stable editor across resizing. Private production edit/reload, code/spreadsheet and responsive journeys recorded. |
| Agent beside a document | Pinned working document, source previews, captured passages/files, durable follow-ups and per-session Read-only / Suggested edits only / Read/write. Server tool policies and downgrade barriers tested; actual native suggested and direct edits were verified on an earlier release. |
| Conversations and people | Clear sender identity, multiline rendering, saved/live history, retained reply drafts, canonical person profiles and exact-identity conflict handling. One controlled private Matrix send was verified end to end. |
| Connected knowledge | Scoped semantic search/index maintenance, wikilinks, exact calendar/transcript navigation, focused graph, canvas note picker and durable relationship assertions. Named private web journeys and earlier native journeys recorded. |
| Tasks and sharing | Configurable boards, property/date filters, manual per-view ordering, phone list mode; People/Links/Publish/Sync controls and live access revocation. Private production journeys preserve underlying note data. |
| Publishing | Scoped content preview, private exclusions, password recovery, appearance drafts/history, wiki/docs/landing layouts and private reader preview. Production draft save/preview passed; full publish/restore acceptance remains below. |

Evidence: [implementation log](IMPLEMENTATION-LOG.md), [historical implementation checkpoints](IMPLEMENTATION.md), and [production release checkpoints](RELEASE-CHECKPOINTS.md). Earlier native success does not certify later uninstalled changes.

## Release gates still open

1. Complete combined candidate checks, production publish/restore, and the actual installed desktop batch. Recheck the observed 390px long-title overflow after deploying its fix.
2. **Human “Can suggest” is not a server-enforced restriction on direct edits.** Current guidance says to grant it only to trusted collaborators. Client tracking is distinct from the enforced agent session policies; restricted guest collaboration remains an open authorization gate.
3. Complete real mobile-device keyboard/IME/PWA coverage, remaining native extras, and multi-person/reviewer concurrency evidence. Fixture/WebKit tests cannot substitute for those environments.

## Remaining scope from the broader plan

Structured message edits/redactions/archives and identity repair; transcript ambiguity review/manual overrides and multi-recording reconciliation; large-inventory paging/performance; canvas claim cleanup and board drag ordering; effective-access/governance previews and guest onboarding; custom publication navigation; consolidated integration controls and controlled provider journeys remain unfinished. These are follow-on implementation or evidence requirements, not proof that ordinary document editing is unavailable.

Continue these in isolated, reviewable slices while the user uses Prism. The current release must not be described as full R00–R16 completion or verified Notion parity. Update the artifact table and open gates after final acceptance, retaining the precise distinction between automated tests, production web, and installed desktop evidence.
