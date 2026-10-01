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

Deployment and post-release results will be recorded after they occur.
