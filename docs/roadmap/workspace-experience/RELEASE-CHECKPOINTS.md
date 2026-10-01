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

Deployed web/server after the 1,364-test server checkpoint, 75 browser checks, six focused collaborative-storage checks (including the subsequently added quota failure), web/e2e typechecks, web build and six native bundle checks. Local/public health both returned 200. Only `prism-server` restarted, with no queued/running agent turns. Current Prism database snapshot passed integrity validation; old web and DB artifacts are under `/private/tmp/prism-release-before-d026fbf`. Prior Applications copy retained in `/private/tmp/prism-client-before-d026fbf`; the new locally signed app passes strict signature verification and is installed. Its Keychain prompt is pending user approval, so post-update native acceptance remains open.

Signed-in production PWA: the existing tab installed the waiting worker without swapping its running assets. The visible Reload action activated the new worker; reopening the document agent panel restored the exact unsent synthetic draft with one composer and Read-only mode. Cleared that draft afterward. The new scoped collaborative database exists alongside the untouched legacy database, and a new `PRISM_SCOPED_WEB_OK` document edit persisted to the vault. Offline cold reload displays Reconnect to your workspace, not Sign in, and displays no private document text. Restoring networking reopens the authenticated workspace without credentials. Offline cold-start editing, legacy unscoped draft recovery UI and physical-phone acceptance are still open.
