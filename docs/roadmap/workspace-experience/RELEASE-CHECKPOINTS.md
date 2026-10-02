# Incremental release checkpoints

This is a staged implementation of the approved plan, not a declaration that R00–R16 are complete. See IMPLEMENTATION.md for remaining work.

## Workspace foundation — 2026-10-01

Prepared revision: `fcee176` plus this release record. Previous production source: `c923f9f` (main). Preserve its backup-retention maintenance change when merging.

Preflight evidence:

- 1,354 server checks, 63 isolated browser journeys, focused follow-up Inbox/gateway checks, application typechecks, and production web build passed.
- Installed desktop at `d58f257` completed actual private authentication, document/collaboration, draft restoration and agent reply checks. New server capabilities still await production verification.
- No queued/running production agent turns at preflight.
- Verified online SQLite snapshots of every vault, hub and Prism database: `/Users/benjaminlife/parachute-backups/20261001T205430Z-workspace-experience-baseline`. Restricted directory; contains credentials. Retention disabled for this backup invocation and its baseline label is pinned.
- Old web artifact: `/private/tmp/prism-release-before-workspace/web-dist`.
- Imported the new database module against a separate copy of the Prism snapshot. Additive policy/request/context columns appeared and SQLite integrity remained `ok`.

Rollout sequence:

1. Stop only PM2's `prism-server`; leave hub, vault, tunnel and bridge services alone.
2. Merge the tested implementation into main with a merge commit; install locked dependencies. Retain the feature branch for continued work.
3. Stage the built web artifact with old hashed assets retained for existing open tabs, then replace the served directory.
4. Enable `AGENT_PRISM_PROFILES=true` in the private server environment, preserving all other settings.
5. Restart `prism-server`; verify local/public health, new capability advertisement, existing private fixture reads, and installed-client reconnection.
6. Test session permissions, supplied saved context and retries using owner-private synthetic notes/conversations. Verify deployed browser behavior and service-worker update separately.

Rollback if startup or integrity fails: stop `prism-server`, revert the release merge (preserving unrelated source history), restore the saved web artifact and previous `.env`, then start the old release. The new schema is additive; prefer retaining current data and disabling the profile flag to restoring a database snapshot. Database restoration is a last resort requiring explicit accounting for any writes since the backup. Do not overwrite newer user data merely to roll back UI code.

Deployed as merge `511696b`. Locked dependency installation passed. PM2 restarted only `prism-server`; both local and public `/health` returned 200 with vault healthy. Existing maintenance commit retained. Old hashed assets remain available to existing tabs, and the prior served directory is also retained at `/private/tmp/prism-release-before-workspace/served-web-dist`.

Production checks after restart:

- Installed `d58f257` client reconnected and restored its private conversation. Its actual native selector changed Read-only → Suggested edits only → Read/write → Read-only. Independent server readback confirmed the final `prism-ro` profile and policy version 4.
- Native source picker found and attached only the private synthetic note. A real read-only turn used its supplied saved text and returned `PRISM_SAVED_CONTEXT_OK`; receipt recorded one source, 202 characters, no truncation. No tools or edits requested.
- Explicitly retried that completed native request with its original request ID and payload. Server returned the same turn; turn count and cost remained unchanged.
- Deployed sign-in and private guest-link document pages rendered in isolated Chromium. At 390×844 the document had no horizontal page overflow. A browser-entered `PRISM_RELEASE_WEB_OK` marker arrived live in the installed native editor and survived browser reload. Browser closed and the short-lived capability was revoked afterward.
- Automated WCAG A/AA checks: sign-in had zero violations/incomplete checks; the guest document had zero violations and two nodes needing manual contrast review. No browser page errors observed. Synthetic screenshot: `/tmp/prism-release-mobile.png`.

Follow-up actual native tool checks also passed: suggest-only `prism_suggest_edit` produced one paired tracked replacement with actor/turn/suggestion IDs. It appeared in the installed editor; rejecting the only pending test suggestion restored the original text and persisted. Read/write `prism_get_note`/`prism_update_note` then directly changed one unique synthetic marker, visible natively and in independent API readback. The session was returned to Read-only. No original user document was edited.

These checks do not establish authenticated web-owner session behavior, PWA update/offline behavior, active-turn downgrade draining or forbidden tool attempts in production, concurrent reviewer decisions, or the unfinished plan packages. PWA registration is mounted in the signed-in workspace; the guest/sign-in browser checks do not register a worker. Keep those gates open.

## Suggestion review interface — `35dec05`

Web and Applications client updated after 66 browser regressions, typechecks, web/macOS builds and six native startup checks passed. Server implementation unchanged. Previous artifacts: `/private/tmp/prism-release-before-review/web-dist` and `/private/tmp/prism-client-before-35dec05/Prism Client.app`.

After the user approved the macOS Keychain prompt, the actual installed app reopened its workspace. Its expanded review list showed the synthetic suggestion's author and replacement text. Individual Accept resolved the whole replacement; an open deployed browser received the review live and retained clean accepted text after reload. Phone-width browser screenshot: `/tmp/prism-review-production-mobile.png`; no horizontal overflow or page errors. Browser closed and capability revoked. No original user document edited. Further implementation continues in the isolated feature checkout.

## Calendar and collaborative storage — `d026fbf`

Deployed web/server after the 1,364-test server checkpoint, 75 browser checks, six focused collaborative-storage checks (including the subsequently added quota failure), web/e2e typechecks, web build and six native bundle checks. Local/public health both returned 200. Only `prism-server` restarted, with no queued/running agent turns. Current Prism database snapshot passed integrity validation; old web and DB artifacts are under `/private/tmp/prism-release-before-d026fbf`. Prior Applications copy retained in `/private/tmp/prism-client-before-d026fbf`; the new locally signed app passes strict signature verification and is installed. The user approved its Keychain prompt; post-update checks below passed.

Signed-in production PWA: the existing tab installed the waiting worker without swapping its running assets. The visible Reload action activated the new worker; reopening the document agent panel restored the exact unsent synthetic draft with one composer and Read-only mode. Cleared that draft afterward. The new scoped collaborative database exists alongside the untouched legacy database, and a new `PRISM_SCOPED_WEB_OK` document edit persisted to the vault. Offline cold reload displays Reconnect to your workspace, not Sign in, and displays no private document text. Restoring networking reopens the authenticated workspace without credentials. Offline cold-start editing, legacy unscoped draft recovery UI and physical-phone acceptance are still open.

Installed-client follow-up: native Accessibility confirmed authenticated startup and Live editing on the existing private fixture. A guarded native keyboard edit added `PRISM_SCOPED_NATIVE_OK`; independent production API readback and the signed-in browser confirmed it. Reloading the native webview and reopening the fixture retained the marker. Calendar navigation in the native app and the deployed phone-width browser opened the exact linked synthetic transcript; web Meeting Notes opened the exact meeting. Synthetic mobile screenshot: `/tmp/prism-calendar-production-mobile.png`. These checks cover this release slice, not all R00–R16 requirements.

## Scoped search, calendar layout and settings — `0f87adf`

Released after 83 isolated browser journeys, 1,369 server tests, application/e2e typechecks, production web/macOS builds and six native Chromium/WebKit startup checks passed. Main fast-forwarded to the tested revision; no dependencies changed. Only Prism Server restarted, with no queued/running agent turns. Backups: `/private/tmp/prism-release-before-0f87adf` (verified database and old web artifacts) and `/private/tmp/prism-client-before-0f87adf` (previous Applications app). Existing hashed assets remain available to old tabs.

Live additive migration retained all 128,437 legacy passages; the new index held 128,438 after concurrent normal maintenance, with SQLite integrity `ok`. Owner status returned the expected vault/chunker and 14,058 indexed notes. Owner semantic search returned the private synthetic document; no production secondary-vault fixtures were created. Local/public health returned 200. For rollback, keep current data and run the preceding code against its retained legacy table; that table stops receiving new index updates, so the old maintenance sweep must catch up. Do not restore the DB snapshot over newer writes.

The signed-in PWA activated the waiting worker through its visible Reload action. Desktop and 390px command search displayed ranked results, selected the fixture through Enter and opened its persisted native marker. Phone Settings opened from command search with Appearance selected, no overflow, and working Escape; screenshot `/tmp/prism-settings-production-mobile.png` reviewed. The locally signed installed native app reopened authenticated, opened/closed the new Settings dialog and used native keyboard input in command search to open the same exact fixture. Screen capture remains unavailable; native evidence uses Accessibility. Remaining R00–R16 gates are still open.

## Search maintenance and unified wikilinks — `ec5ac4d`, with UI corrections at `f88c27b`

The `ec5ac4d` server/web release followed 1,382 server tests, 89 browser journeys, 19 host-seam checks, application/e2e typechecks, web/macOS builds and six exact native-bundle checks. A fresh SQLite backup passed integrity validation. Main was fast-forwarded, old hashed assets retained, and only Prism Server restarted with no active turns. Live health, index status, private-fixture semantic search and SQLite integrity passed; both new index-job tables exist. Backup: `/private/tmp/prism-release-before-ec5ac4d`. The new Search card showed the production count, meaning/keyword mode and automatic-maintenance status at 390px without overflow. Production pause/resume was not exercised against the full vault; recovery/isolation evidence remains the isolated job tests.

Two owner-private synthetic linked documents (duplicate titles, one alias) reject anonymous access. Browser-edited portable links persisted in the existing private test document. Production API resolution returned exactly the authorized fixtures; web alias and stable-ID links opened the exact target, and the ambiguous-title chooser opened the chosen second document. Phone screenshot `/tmp/prism-wikilinks-production-mobile.png` was reviewed. The installed `ec5ac4d` app reopened after user Keychain approval and followed the alias to the expected synthetic target.

Production verification uncovered two UI issues: a responsive breakpoint dismissed the chooser, and early Enter while search was loading could choose the agent fallback. The latter produced one synthetic read-only session (`acdd05a8-4311-4a66-8ba8-00a89a0a1228`), completed with no tool events and approximately $0.025 API-equivalent cost; it was reported to the user. Stable overlay keys and action-identity selection correct both behaviors. The follow-up `f88c27b` passed all 92 browser journeys, core/e2e typechecks, rebuilt web/macOS artifacts and six native-bundle checks. It changes no server implementation; web assets were swapped without a server restart. Backups: `/private/tmp/prism-release-before-f88c27b` and `/private/tmp/prism-client-before-f88c27b`.

The authenticated production PWA activated `f88c27b` through Reload. Enter during pending search kept the dialog open with no default agent action; after results arrived, Enter opened the exact fixture. Its ambiguous link picker survived desktop→390px resizing with both choices and no overflow. The newly installed, locally signed/strictly verified native app reopened authenticated. Native keyboard search selected the synthetic source after ranked results arrived; its chooser displayed both paths and choosing B opened `PRISM_LINK_TARGET_B_OK`. Native screen capture remains unavailable; assertions use Accessibility and guarded synthetic markers. All eight active server workers still report successful runs. Remaining R00–R16 work is not complete.


## Focused graph and canvas preview integrity — `414da73`

Released after 1,385 server tests, 98 full browser journeys, 19 host checks and application typechecks passed. The subsequent tooltip correction passed five focused graph journeys; this is not a claim that all 99 current browser tests ran together. Final web/macOS builds and six exact packaged native checks passed. Main fast-forwarded; only Prism Server restarted with no active turns. Local/public health and the private graph query passed. Backups: `/private/tmp/prism-release-before-d58c530` (verified SQLite snapshot and previous web) and `/private/tmp/prism-client-before-414da73` (previous Applications app). Keep the current database on rollback; no schema change was introduced.

The authenticated PWA activated `assets/index-COIlwnD9.js`. Added two synthetic relationships between the existing owner-private test documents using fresh version guards. Production query returned exactly three nodes/two edges, no body fields, and no truncation. List mode showed outgoing `supports` and `next`; filtering retained only the matching neighbor. Focusing target A showed the inverse incoming relationship; Open document loaded `PRISM_LINK_TARGET_A_OK`. Fullscreen at 390px fits without horizontal page overflow; Escape closes. Screenshot `/tmp/prism-graph-production-mobile.png` reviewed. This screenshot also revealed a generated body excerpt in an untitled document label; a tested server correction is queued for the next release. Focus restoration across desktop/mobile layout changes has not been established.

The installed locally signed app launches its startup boundary but currently waits at Checking your saved sign-in. Requested user approval of the macOS Keychain prompt; actual post-release native graph verification remains pending. Real production 3D, physical touch devices, durable authored-arrow ownership and canvas peer-reload tests remain open. The legacy preview fix is covered by the real Excalidraw isolated fixture, not by launching the retired app.
