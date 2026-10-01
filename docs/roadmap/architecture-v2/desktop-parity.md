# Desktop → Prism Client parity audit (WP4.3)

Status as of branch `arch/wp4.3` (2026-10-01). Goal of WP4.3: the Mac mini and the laptop
run **Prism Client** (`apps/client`, device token, server-only) instead of the legacy
`apps/desktop` `Prism.app`, with no client process holding a vault token and nothing the
user relies on lost.

**Method.** Every command registered in `apps/desktop/src-tauri/src/lib.rs`
`invoke_handler` (102) was traced to its UI callers in `packages/core/src` and
`apps/desktop/src` (direct `invoke("…")` plus the wrapper clients `lib/parachute/client.ts`,
`lib/matrix/client.ts`, `lib/sync/client.ts`, `lib/agent/client.ts`), then to what the
same UI does in the web/native build (`apps/web/src/tauri-shim/core.ts`, the
`VaultClient` / `CollabSharing` / `AgentClient` / `LiveActionsClient` seams), and to the
server route that backs it. Separately, every `isDesktop` / `useIsWeb()` gate in the
shared UI was reviewed (bottom table).

## Classes

| Class | Meaning | Count |
|---|---|---|
| **A** | Already works in the web/client build through the server | 42 |
| **B** | A server route existed but the client seam wasn't wired: **wired in WP4.3** | 8 |
| **C → ported** | Desktop-only, no server equivalent: **ported in WP4.3** | 4 |
| **C → gap** | Desktop-only, no server equivalent: **documented gap** (decision below) | 16 |
| **C → local-only** | Local model routing (LM Studio / Ollama on the laptop): not ported by design | 6 |
| **C → dropped** | Desktop-only maintenance command, not carried over | 1 |
| **N/A** | Desktop shell config / onboarding; meaningless on a thin client | 11 |
| **Dead** | Registered but never invoked by any UI | 14 |
| | **Total** | **102** |

The new seam for B/C-ported items is **`HostServices`** (`packages/core/src/lib/host/services.ts`,
provider `HostServicesProvider` / `useHostServices`, web impl `apps/web/src/host/HttpHostServices.ts`,
provided to the **server owner only**) plus pure VaultClient operations in
`packages/core/src/lib/host/vaultOps.ts`. The desktop provides no HostServices and keeps its
Tauri commands, so its behaviour is unchanged.

## Command table

### A: already works through the server (42)

| Feature | Desktop commands | Client path |
|---|---|---|
| Notes CRUD, tags, links, search, stats, vault info, paths, graph | `vault_list_notes` `vault_get_note` `vault_create_note` `vault_update_note` `vault_delete_note` `vault_batch_delete` `vault_search` `vault_get_tags` `vault_add_tags` `vault_remove_tags` `vault_get_stats` `vault_get_info` `vault_update_description` `vault_get_paths` `vault_get_links` `vault_create_link` `vault_delete_link` `vault_get_graph` | shim → `rest.ts` → gateway `/api/*` (owner passthrough / per-note grants) |
| File tree | `vault_list_tree` | `GET /api/tree` projection (WP7.1) |
| Version history | `vault_list_note_versions` `vault_get_note_version` `vault_restore_note_version` | `HttpVaultClient` → `/api/notes/:id/versions`, `/restore` |
| Semantic search | `vault_semantic_search` | `/api/search/semantic` (primary vault only; full-text fallback) |
| Markdown ⇄ HTML | `markdown_to_html` `html_to_markdown` | local JS in the shim (marked / turndown) |
| Status bar / ingest health | `check_services` `get_service_status` | benign shim answers; real ingest health is Network → Server "Ingest health" (`/acl/workers`) |
| Inbox: read a thread | `matrix_get_messages` | the thread's vault note (server Matrix ingest, ≤60 s behind live) |
| Inbox: send in a thread | `matrix_send_message` | live actions `POST /api/actions/matrix/send` (**needs `ACTIONS_MATRIX_ENABLED`**) |
| Email reply / compose / archive / mark read | `gmail_send` | live actions `/api/actions/email/*` via Proton Bridge (**needs `ACTIONS_EMAIL_ENABLED`**); Gmail is retired |
| Calendar: create event, RSVP | `calendar_create_event` | live actions `/api/actions/calendar/*` (**needs `ACTIONS_CALENDAR_ENABLED`**) |
| Agent chat (panel + tab) | `agent_chat` | durable server agent sessions `/api/agent/sessions*` (WP3.x) |
| Agent activity: skills + run history | `agent_get_skills` `agent_get_dispatches` | read from the vault (`agent-skill`, `agent-dispatch` notes) |
| Live collaboration | `get_collab_config` | collab provider token = the device token (`collabToken()`) |
| Sharing / ACL / integrations UI | `acl_request` `api_request` | direct `/acl/*`, `/api/integrations/*` with the device token |
| Vault switcher | `vault_list` `vault_set_active` `vault_create` `vault_link` `vault_remove` | web `CollabSharing` → `/acl/vaults*` + `X-Prism-Vault` |

### B: server route existed, seam not wired → wired in WP4.3 (8)

| Feature | Desktop commands | Server route | WP4.3 wiring |
|---|---|---|---|
| Calendar: pull the viewed range from Google | `calendar_sync_range` | `POST /api/calendar/sync?from&to` (WP1.3) | `HostServices.calendarSyncRange`, called by `CalendarDashboard` on range change (owner) |
| Note sync to Google Docs / Notion: push, pull | `sync_trigger` `sync_pull` | `POST /api/sync/note/:id/push\|pull` (Phase 3) | `HostServices.notePush/notePull`; the Sync panel (`MetadataPanel` `SyncSection`) and "Sync to Notion" command |
| Note sync config | `sync_status` `sync_add_config` `sync_remove_config` | (vault metadata `metadata.sync[]`) | `vaultOps.syncStatusFromNote / addSyncConfig / removeSyncConfig` through `VaultClient` |
| New message (global composer) | `matrix_get_rooms` | `/api/notes?tag=message-thread` + `/api/actions/matrix/send` | `roomsFromThreadNotes` (`lib/matrix/vaultRooms.ts`) + live actions in `ComposeMessage` |
| "Run this skill now" | `agent_dispatch` | the server skill scheduler (WP1.1, `SKILLS_ENABLED`) | `vaultOps.queueSkillRun` clears the skill note's `lastRun` → the server runs it on its next 60 s tick with the skill's own routing (a daily skill still waits for its hour). Custom tasks already go to agent chat |

Server change for B: a successful push now stamps `last_synced` on the `metadata.sync[]` entry
(what `sync_status` reads, desktop parity).

### C → ported in WP4.3 (4)

| Feature | Desktop command | Port |
|---|---|---|
| Notion page picker | `notion_list_pages` | **new** `GET /api/sync/notion/pages?q=` (admin, read-only, stored `notion` credential; `NotionClient.searchPages` + pure `parseNotionSearch`, never echoes the upstream body) → `HostServices.notionPages` |
| Inline AI edit (⌘J) | `agent_edit` | `HostServices.agentText(buildEditPrompt(...))` = `POST /api/agent/dispatch` with **`profile: "vault-ro"`** (new: a client may only NARROW a one-shot dispatch to the read-only vault tools; anything else is 400) + poll `GET /api/agent/dispatches/:id`; cancelled on timeout/abort. Server owner only (unchanged D3 gate) |
| Transform note → presentation / email draft | `agent_transform` | same read-only dispatch with `buildTransformPrompt`; the client creates the new note through `VaultClient` |
| Resolve wikilinks in this note | `resolve_wikilinks` | `vaultOps.resolveWikilinks` (same extraction + matching as the Rust command, `references` links) through `VaultClient`, so it runs under the user's grants |

Security notes: no new credential path, no new write path for the agent (the inline agent can
only read), the new route is read-only and admin-gated like the rest of `/api/sync`, and nothing
here acts outward as the owner (calendar edits and sends stay behind WP1.5 live actions).

### C → documented gaps (16): decisions for the user

| Feature | Desktop commands | Why not ported now | Recommendation |
|---|---|---|---|
| Calendar: edit / delete an event | `calendar_update_event` `calendar_delete_event` | They mutate Google Calendar AS the owner; a port must meet the WP1.5 standard (owner-only, flag, CSRF, idempotency, audit). Live actions only have `create` + `rsvp` | Edit/delete in Google Calendar for now; if wanted, add `calendar/update` + `calendar/delete` to `routes/actions.ts` as a follow-up WP |
| GitHub folder sync (setup modal, auto-push on save) | `github_check_auth` `github_sync_init` `github_sync_push` `github_sync_push_file` `github_sync_status` `github_sync_remove` | Configs live in desktop state; the desktop's "auto-sync on save" pushed after every save. The server has stateless `POST /api/sync/github/push\|pull` (folder) but no stored configs, no scheduler and no UI | **Check the desktop's GitHub sync configs before archiving.** If any auto-sync config matters, port it as a server worker (configs in SQLite, periodic push); otherwise accept the gap |
| Notion database sync | `notion_db_list` `notion_db_schema` `notion_db_sync_init` `notion_db_sync` `notion_db_sync_status` `notion_db_sync_remove` | No server port (`worker/notion.ts` is the per-page adapter only); WP1.4 found no `auto_sync` config in use | Accept the gap (manual feature). Per-note Notion sync works |
| Cancel a running skill dispatch | `agent_cancel_dispatch` | Scheduler runs are server-internal; session turns can be cancelled (Stop) | Accept; server runs are wall-clocked (30 min) |
| Skill config card (enable, interval, model, builder) | `agent_update_skill` | Desktop-only UI | Edit the skill note's metadata in the note's Properties panel (it is the source of truth for the server scheduler) |

### C → local-only (6), dropped (1)

| Feature | Commands | Decision |
|---|---|---|
| Local model routing for interactive skills (LM Studio / Ollama) | `ollama_status` `ollama_list_models` `set_skill_model` `get_skill_models` `local_ai_list_models` `test_local_ai` | Local by nature (a model server next to the app). Interactive AI (chat, inline edit, transform) now runs on the **server agent** (Claude); background skills keep local-model routing **on the server** (skill-note `provider`/`model`, `SKILLS_LOCAL_MODEL`). Not ported |
| Resolve all wikilinks (vault-wide) | `resolve_all_wikilinks` | Scans every note's content: a host maintenance job, not a client feature. Hidden outside the desktop; the per-note command was ported |

### N/A (11) and Dead (14)

- **N/A, desktop shell config + onboarding wizard:** `get_config_status` `set_anthropic_key`
  `test_parachute` `validate_config` `test_matrix` `test_notion` `check_claude_cli`
  `check_google_cli` `get_full_config` `update_config` `google_check_auth`. In the client,
  integration credentials are stored on the server (Network → Server, `docs/credentials.md`);
  the client has no vault token to configure. The shim answers `get_full_config` with `{}` and
  refuses `update_config` (asserted by `verify-client.mjs` §7).
- **Dead (no UI caller):** `embedding_reindex` `matrix_get_room_members` `matrix_mark_read`
  `matrix_search_messages` `gmail_list_threads` `gmail_get_thread` `gmail_archive` `gmail_label`
  `calendar_list_events` `sync_resolve_conflict` `agent_generate` `create_collab_share_link`
  `editor_set_content` `editor_replace_selection`.

## Gated UI paths (`isDesktop` / `useIsWeb()`)

| Where | Desktop-only behaviour | Client after WP4.3 |
|---|---|---|
| `CalendarDashboard` range sync | `calendar_sync_range` | **wired** (HostServices, owner) |
| `CalendarDashboard` event Edit / Delete buttons | Tauri | gap (see above); hidden |
| `CalendarDashboard` create + RSVP | Tauri | live actions when the flag is on |
| `MetadataPanel` Sync section | Google Docs / Notion / GitHub adapters | **wired** for Google Docs + Notion (owner); GitHub hidden; non-owners see a notice |
| `CommandBar` Sync to Notion, transforms, resolve wikilinks | Tauri | **wired** (owner; resolve-wikilinks for any signed-in user, under grants); vault-wide resolve hidden |
| `DocumentRenderer` ⌘J inline prompt | Tauri `agent_edit` | **wired** (owner); the shortcut is inert for others |
| `AgentActivity` Run skill | Tauri dispatch | **wired** as "queue on the server" (owner, enabled skills) |
| `AgentActivity` skill config / builder, Ollama list | Tauri | gap / local-only |
| `ComposeMessage` (New message) | Tauri Matrix client | **wired** (vault rooms + live Matrix) |
| `Settings` Services / Data Sources / Ingest mode / Local AI | desktop config file | N/A: notices now point at Network → Server, never at the desktop |
| `GitHubSyncModal`, `NotionDbSyncModal` | Tauri | gap (notices updated) |
| `Onboarding` wizard | Tauri | N/A (`skipOnboarding` in the web shell) |
| `ProjectTree` batch-delete progress | Rust event `vault:batch-delete-progress` | works; no per-item progress bar |

## Client-shell gaps that are not command parity

- **External images and the Map basemap: CLOSED (Client parity C).** The client CSP still allows
  only the server, so the server proxies them: external `<img>` in any note surface →
  `GET /api/media/proxy?u=` (SSRF-guarded, raster only, SVG refused) shown as `blob:` URLs; the
  OpenFreeMap basemap → `GET /api/map/style/:id` + `/api/map/ofm/*` (host- and path-allowlisted)
  via a `prismmap://` MapLibre protocol. Signed-in users only. The PWA and the legacy desktop
  still load them directly. Residual: custom basemap style URLs, `<picture><source>` / CSS
  background images, and website-note iframes stay blocked in the client. Details:
  `docs/client-app.md` "External images and the basemap".
- **Live actions are OFF on the server** (`ACTIONS_{EMAIL,CALENDAR,MATRIX}_ENABLED`). Until the
  owner turns them on, the client cannot send email, send Matrix messages or create/RSVP
  events; the desktop did these directly. Turning them on is step 3 of the switch-over runbook.
- The client renders a sent Matrix message once the server ingest picks it up (≤60 s), not
  instantly from a live Matrix fetch.

## Verification

- Server: `npm test` (`agent-routes.test.ts`: `vault-ro` narrows `--allowedTools`, default
  unchanged, other profiles 400 and never spawn; `sync-routes.test.ts`: the Notion picker is
  admin-only and 400s before any network when unconfigured; `notion-sync.test.ts`:
  `searchPages` request shape + `parseNotionSearch`).
- Web: `npm run verify:host -w @prism/web` (13 checks: the HTTP seam's paths/bodies/polling/
  cancel/error mapping, the vault ops, `roomsFromThreadNotes`, the prompts).
- Client: `node apps/client/scripts/verify-client.mjs` §6–7 (no token-shaped literal in the
  bundle, no vault-token key/env/scope in the shell, no credential field in
  `client-settings.json`, the shim refuses the desktop config commands).
- Host: `scripts/check-client-no-vault-token.sh` (read-only) on each client Mac.
