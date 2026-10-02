# Frontend / backend agent coordination

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
