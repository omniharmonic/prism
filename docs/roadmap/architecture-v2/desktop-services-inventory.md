# Desktop services inventory (WP1.4)

Status as of WP1.4 on branch `arch/wp1.4`. Goal: the desktop is a pure client
(`ingest_mode: "client"`), the Prism Server does all ingest. "Server owns" means a
worker exists on the server; the cutover flag is what the overseer flips.

## Background services (`ServiceManager`, `apps/desktop/src-tauri/src/services/`)

| Desktop service | Interval | Server owner | Server flag | Desktop opt-out | Status |
|---|---|---|---|---|---|
| `message-sync` (Matrix) | 60 s | `worker/matrix.ts` (+ rollover, reconcile) | on by default | `disable_message_sync` | SERVER-OWNED (cut over); desktop copy is dead weight in client mode |
| `email-sync` (Gmail/gog) | 3 min | `worker/gmail.ts` or `worker/proton.ts` | `GMAIL_SYNC_ENABLED` / `PROTON_SYNC_ENABLED` | `disable_email_sync` | Server worker built; follows the overseer's cutover (`/acl/workers` `email` must be kind=server) |
| `calendar-sync` (gog) | 5 min | `worker/calendar.ts` | `CALENDAR_SYNC_ENABLED` (+ `CALENDAR_SHADOW`, `CALENDAR_DELETE_MODE`) | `disable_calendar_sync` | Server worker built; cutover pending (shadow, then flip). Deletes notes: never `delete` mode without the owner |
| `transcript-sync` Fathom | 10 min | `worker/fathom.ts` | `FATHOM_INTERVAL_MS` | `disable_fathom_sync` | SERVER-OWNED |
| `transcript-sync` Fireflies | 4 slots/day | `worker/fireflies.ts` | `FIREFLIES_DELETE_ENABLED` | `disable_fireflies_sync` | SERVER-OWNED (server also deletes from Fireflies; desktop must stay off) |
| `transcript-sync` Meetily | 10 min | none (local SQLite on the laptop) | n/a | `disable_meetily_sync` (now inert) | **RETIRED in WP1.4** (loop, SQLite reader, auto-discovery and the `discover_meetily_path` command removed) |
| `skill-scheduler` | 60 s | `worker/skills.ts` | `SKILLS_ENABLED` | `disable_skill_scheduler` | Server worker built (WP1.1); cutover per the CLAUDE.md runbook |
| `embedding-index` | 5 min | scheduler index sweep | `INDEX_INTERVAL_MS` | `disable_embedding_index` | SERVER-OWNED (server also sweeps); desktop copy redundant |
| `notion-task-sync` | 5 min, per-config 1 h | `worker/notion.ts` is the per-page adapter only | n/a | `disable_notion_task_sync` (now inert) | **RETIRED in WP1.4**: idle loop removed (no `auto_sync` config in use). Manual `notion_db_*` commands remain |

In client mode (`ingest_mode: "client"`) none of the services above start and the
scheduler does not start (`plan_services` returns every entry `start=false` with a
"client mode" reason; pinned by `services::tests::client_mode_*`).

## Other scheduled / ingest-ish desktop code

| Item | Where | Status |
|---|---|---|
| `calendar_sync_range` (Calendar view navigation) | `commands/service_cmds.rs` | **Delegates to the server** (`POST /api/calendar/sync?from&to`, WP1.3) through the narrow `api_request` proxy whenever the server owns calendar (client mode or `disable_calendar_sync`). In plain host mode it still runs locally. The server returns 409 `calendar_sync_disabled` until `CALENDAR_SYNC_ENABLED`/`CALENDAR_SHADOW` is on; the Calendar view only logs that and keeps reading vault notes |
| `index_messages` command / `messageIndexApi.indexMessages` | `commands/message_index.rs` | **RETIRED** (never called from the UI; the server ingests Matrix and embeds) |
| `person_linker` | `services/person_linker.rs` | Library for the host-mode services; server has `worker/people.ts`. Inert in client mode; the legacy desktop is kept building (rollback) so it is not deleted |
| Sync adapters: Google Docs, Notion page, GitHub, Notion DB | `sync/`, `commands/sync_cmds.rs`, `notion_db_cmds.rs`, `github_cmds.rs` | USER-INVOKED (not scheduled). Server also has `worker/github.ts`, `googledocs.ts`, `notion.ts`. Still desktop-callable; not host-mode-only background work |
| Agent dispatch / `claude -p` | `services/agent_dispatch.rs`, `commands/agent.rs` | USER-INVOKED. Server agent sessions (WP3.x) are the replacement; desktop keeps its path until WP4 |
| Google/gog live actions (send, RSVP, create event) | `commands/google.rs` | USER-INVOKED desktop-only; server replacement is WP1.5 |
| Matrix live send/read | `commands/matrix.rs` | USER-INVOKED desktop-only; server replacement is WP1.5 |
| Vault-token holders on the desktop | `parachute_api_key`, `collab_token` | **WP4.3:** the desktop is retired; the switch-over runbook (docs/client-app.md) backs up the config, blanks both keys and revokes the old token; `scripts/check-client-no-vault-token.sh` verifies. Feature parity: `desktop-parity.md` |

## UI changes for client mode

* Settings -> Ingest mode: in Client mode the per-service switches show "Runs on the Prism Server" and a "Server" badge instead of On/Off (still disabled).
* Settings -> Data Sources: transcript intro says ingest runs on the server in Client mode. Meetily field removed.
* Status bar already reports "Client mode" when every service is disabled.

## `desktop /api` proxy allowlist (`api_request`)

Exactly two surfaces (`commands/config.rs` `api_request_allowed`):

1. `/integrations` and `/integrations/...` (any method, no query).
2. `POST /calendar/sync?from=YYYY-MM-DD&to=YYYY-MM-DD` (fixed query shape, digits only).

Same defences as before: raw-path char allowlist (letters, digits, `-`, `_`, `/`), parse
with the same `url` crate reqwest uses and require the resulting path/query to equal the
input (tab/newline stripping, `%2e`, dot segments, `\`, `#` all fail).

## Meetily, existing data

Existing Meetily notes (`vault/_inbox/transcripts/meetily/*`, tags `transcript` + `meetily`,
`source: meetily`) stay in the vault and keep working with the transcript linker's
output; nothing reads or writes them any more. `meetily_db_path` and
`disable_meetily_sync` remain in `AppConfig` (`serde(default)`) so old config files
load and round-trip, but have no effect. If a Meetily replacement is wanted later it should
be a server worker (the data is on the laptop, so it would need an upload path first).
