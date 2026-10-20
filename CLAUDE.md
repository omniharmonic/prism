# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

Prism is a workspace for documents, messages, tasks, calendar and knowledge over a
[Parachute](https://github.com/ParachuteComputer) vault. One React UI core
(`packages/core`) ships in three shells: the web PWA (`apps/web`), the thin native
**Prism Client** for macOS and iOS (`apps/client`, Tauri 2), and the legacy desktop
(`apps/desktop`, rollback only). Clients never hold a vault token: the **Prism
Server** (`apps/server`, Hono + SQLite) is the single trust boundary.

## Rules that apply to every change

- **Verify before saying done:** `npm run check` (both type checks + static guards),
  the server suite with `cd apps/server && npm test` — never raw `node --test`
  without `--env-file=.env.test` — and the fixture Playwright specs you touch
  (`apps/web/e2e-fixtures`, `E2E_PORT=<n>`, WebKit with `--project=webkit`).
- **No test asserts on the wall clock.** Use `test/probe.ts` and injected clocks.
- **The server never parses note content on the main thread** — use `convert/service.ts`.
- **Every `/api` call in `apps/web` goes through `serverFetch`.** New server routes stay
  under `/api/*` or join the service-worker denylist (`npm run check:sw`).
- **No `window.prompt`/`confirm`/`alert`** in shipped UI (`check:dialogs`); text to the
  clipboard only through `lib/clipboard.ts` (`check:clipboard`).
- **Any editor schema change bumps `COLLAB_SCHEMA_VERSION`.**
- **Never `git stash`** (the stash is shared by every worktree of the clone).
- **Restart the server after a server change** — it does not hot-reload.
- Licence: PolyForm Shield 1.0.0 (`LICENSE.md`, `NOTICE.md`). Prism contains no
  Parachute (AGPL) code; keep it that way — talk to Parachute over HTTP or its CLIs.

## Where things are

- **The full engineering reference** (architecture, security gateway, collab,
  conversion, databases, native shells, ingest, agents, governance), imported below:
  [`docs/engineering/reference.md`](docs/engineering/reference.md).
- Launch work: [`docs/distribution/LAUNCH-PLAN.md`](docs/distribution/LAUNCH-PLAN.md) (private repo only).
- Setup: `docs/onboarding.md` and the `prism-setup*` skills in `.claude/skills/`.

@docs/engineering/reference.md
@docs/runbook/owner-production.md
