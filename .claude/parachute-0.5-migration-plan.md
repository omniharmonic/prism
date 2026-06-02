# Parachute 0.2.4 → 0.5.1 Migration Plan (Prism)

> Status: **EXECUTED 2026-06-01** (server + Prism code migrated; data verified intact at 9044/815/10296). Pending: live GUI smoke test via `npm run tauri dev`; optional follow-ups in §6/§7.
> Decisions locked: **Auth = Hub-issued JWT** · **Concurrency = proper `if_updated_at`** (editor) + `force` fallback (sole-writer sync).
> Primary directive: **lose none of the data.** ✅ Verified — count unchanged, integrity ok, two backups taken.
>
> **Runtime artifacts created during execution:**
> - Backups: `~/.parachute-prism-migration-backup-20260601-183428/` (db+config, online), `~/.parachute-prism-COLD-backup-20260601-183724/` (full 590MB tree). Restore = stop daemon, `bun add -g @openparachute/vault@0.2.4`, replace `~/.parachute` from cold backup, `git checkout main`.
> - Versions now: vault **0.5.1**, hub **0.6.2**. Data at `~/.parachute/vault/data/default/vault.db`.
> - Hub admin user `benjamin` (password given to user once; rotate via `parachute auth set-password`). Operator token at `~/.parachute/operator.token` (admin, ~90d).
> - Prism's vault JWT: `vault:default:write`, exp **2027-06-02**. Stored in `prism-config.json` `parachute_api_key` and `.mcp.json`. Re-mint: `parachute auth mint-token --scope vault:default:write --expires-in 31536000`.
> - Branch: `migrate/parachute-0.5` (uncommitted — review before commit).

---

## 1. Executive summary

Prism currently talks to `@openparachute/vault@0.2.4`. Latest stable is **0.5.1**
(0.6.0-rc.1 in flight). This spans a `v9 → v18` schema jump and three API
generations. The upgrade guide names our exact situation: *"If you came up on
vault 0.2.4-era (standalone, no hub) you were 100% on `pvt_*` — those bearers
stop working at 0.5.0."*

**Good news that lowers the risk:**
1. The vault's **data + filesystem migration is automatic, idempotent, and
   target-wins on conflict** (runs once on first post-upgrade boot). Our 58 MB
   `vault.db` and all tag schemas migrate in place.
2. Prism's Rust `ParachuteClient` is **already written for the consolidated
   "v2" `/api/...` surface** (PATCH-based tags/links, search-as-query,
   stats via `?include_stats`). A prior v1→v2 pass already happened. So the
   remaining code delta is smaller than feared.

**Three hard breaks require action:**
- **Auth:** `pvt_*` token is dead → install hub, mint a `vault:default:write` JWT.
- **URL prefix:** `/api/...` → `/vault/default/api/...`; `/mcp` → `/vault/default/mcp`.
- **Mandatory PATCH concurrency:** every update now needs `if_updated_at` or `force:true`.

---

## 2. Current state vs. target state

| Dimension | Current (0.2.4) | Target (0.5.1) |
|---|---|---|
| Package | `@openparachute/vault@0.2.4` | `@openparachute/vault@0.5.1` + `@openparachute/hub` |
| CLI binary | `parachute` | `parachute-vault` (+ `parachute` = hub dispatcher) |
| Data file | `~/.parachute/vaults/default/vault.db` (58 MB) | `~/.parachute/vault/data/default/vault.db` (auto-moved) |
| Vault config | `~/.parachute/config.yaml` | `~/.parachute/vault/config.yaml` (auto-moved) |
| Per-vault yaml | `~/.parachute/vaults/default/vault.yaml` | `~/.parachute/vault/data/default/vault.yaml` |
| REST base | `http://localhost:1940/api` | `http://localhost:1940/vault/default/api` |
| MCP endpoint | `http://127.0.0.1:1940/mcp` | `http://127.0.0.1:1940/vault/default/mcp` |
| Auth token | `pvt_9oat…` (sha256 in yaml) — **DEAD at 0.5.0** | Hub JWT (RS256), `aud=vault.default`, scope `vault:default:write`, ≤365d TTL |
| Token issuer | vault itself | hub on `127.0.0.1:1939` |
| `/health` | root, unauth | root, unauth (**unchanged**) |
| `/vaults`, `/vaults/list` | n/a | cross-vault, unscoped (unchanged surface) |

---

## 3. The comparative API diff (what changed, what it touches)

### 3.1 BREAKING — must fix before Prism works

| # | Change | Prism impact | Files |
|---|---|---|---|
| B1 | **URL prefix** `/api` → `/vault/{name}/api`; `/mcp` → `/vault/{name}/mcp`. No unscoped fallback. | All REST + MCP calls 404 until fixed | `clients/parachute.rs` (base_url build, `health()`), `lib.rs:61` (mcp_url), `.mcp.json`, DispatchManager wiring |
| B2 | **`pvt_*` tokens rejected** (401 everywhere). | Every authed call 401s | hub install + mint; `config.rs` token value; `.mcp.json` token |
| B3 | **PATCH requires `if_updated_at` or `force:true`** else 428. Pure append/prepend exempt; tags/links **not** exempt. | All `update_note`, `add_tags`, `remove_tags`, `create_link`, `delete_link` fail | `models/note.rs` (`UpdateNoteParams`), `clients/parachute.rs` (5 methods), ~13 `update_note` call sites, `vault.rs` IPC command, frontend `updateNote` to thread `updatedAt` |

### 3.2 Behavioral / shape changes — fix or verify

| # | Change | Prism impact | Action |
|---|---|---|---|
| S1 | Graph neighborhood params now bracket-style: `near[note_id]=`, `near[depth]=`, `near[relationship]=` (was flat `near=`/`depth=`). Depth default 2, cap 5. | `get_graph()` near/depth path wrong | Fix `parachute.rs:304` to bracket keys. Low real impact (Prism mostly fetches full graph + client BFS). |
| S2 | `VaultStats` reshaped: `{totalNotes, tagCount, topTags, notesByMonth, earliestNote, latestNote}`. No `linkCount`. | `link_count` always 0 | Works as-is (`#[serde(default)]`). Optionally adopt richer fields. |
| S3 | `DELETE /notes/{id}` returns `{deleted:true, id}` body (was empty). | `delete_note` ignores body → fine | Verify no `.json::<()>()`. None — OK. |
| S4 | List default `limit=50`, `sort=asc`. Prism always sends `limit` + `sort=desc`. | None | Verify; Prism is explicit. |
| S5 | `search=` returns full `Note[]`, default `limit=50`. Prism passes own limit + `include_content`. | None | OK. |
| S6 | Metadata on PATCH is **shallow-merged** with existing (not replaced). | Sync sends full metadata each time → equivalent. Field deletion needs explicit handling. | Note; no change needed now. |
| S7 | Empty notes are **valid again** (vault#324 reversed the rejection). | Prism's `create_note` empty-guard (commit 15679a9) still fine as a Prism-side hygiene choice. | Keep guard; revisit empty-note-leak memory note. |
| S8 | Batch create cap = **500** notes/request (413 over). | Notion/import batching | Verify batch chunk ≤500. |
| S9 | `Note` adds `validation_status`; `NoteIndex` uses `byteSize`/`preview`. | serde ignores unknown; camelCase already handles | OK. |
| S10 | MCP `tools/list` hides tools the token can't run; `vault:default:write` sees all 9. | Agent needs write scope | Mint write (not read) JWT. |

### 3.3 New capabilities we *could* adopt later (non-blocking)

- `if_missing:"create"` upsert on PATCH — collapse sync query-then-create into one call.
- `append`/`prepend` (SQL-atomic, concurrency-exempt) — ideal for message-thread appends; avoids read-modify-write entirely.
- `content_edit:{old_text,new_text}` — surgical edits for the editor.
- Cursor pagination (`?cursor=`) — for incremental "since last checked" sync loops.
- `POST /api/tags/{name}/rename` + `/api/tags/merge` — schema maintenance.
- Attachments + storage upload, auto-transcribe — relevant to transcript_sync later.
- `extension:` field — non-markdown notes (csv/json/yaml).

---

## 4. Data-safety protocol (the non-negotiable part)

1. **Confirm the existing backup** is real and restorable before touching anything:
   - Verify the backed-up `vault.db` opens: `sqlite3 <backup> "PRAGMA integrity_check; SELECT count(*) FROM notes;"`
   - Record the note count + tag count as a **golden baseline** to compare post-migration.
2. **Take a fresh cold backup** immediately before upgrade (daemon stopped):
   - `cp -a ~/.parachute ~/.parachute.bak-0.2.4-$(date +%Y%m%d)`
   - Also `parachute-vault export` is NOT available on 0.2.4; rely on the file copy.
3. **The migration is idempotent + target-wins** — re-running boot never corrupts. EXDEV (cross-mount) is the only documented failure; `~/.parachute` is single-volume here, so not a concern.
4. **v17 drops `note_schemas`/`schema_mappings`** — harmless for direct 0.2.4 upgraders (never shipped to npm). If the boot log warns about dropped rows, capture the warning (it names what to recreate as `tags.fields`).
5. **Golden-baseline comparison after boot:** note count, tag count, and a spot-check of 5 known notes must match pre-migration.

---

## 5. Migration phases

### Phase 0 — Pre-flight (read-only, reversible)
- [ ] Verify backup integrity + record golden baseline (note/tag counts).
- [ ] Fresh cold copy `~/.parachute` → `~/.parachute.bak-…`.
- [ ] Snapshot current `.mcp.json` and `prism-config.json`.
- [ ] Note current daemon launch mechanism (launchd label) for clean stop.
- [ ] Create a git branch in Prism: `migrate/parachute-0.5`.

### Phase 1 — Server upgrade (data migration)
- [ ] Stop the daemon: `parachute daemon stop` (or `pkill -f parachute` / `launchctl bootout`).
- [ ] Install hub: `bun add -g @openparachute/hub` then `parachute init` (sets up hub on :1939, writes `~/.parachute/operator.token`).
- [ ] Upgrade vault: `bun add -g @openparachute/vault@0.5.1` (or `npm i -g`).
- [ ] Start vault: `parachute-vault serve` (or `parachute start vault`).
- [ ] **Watch boot log** for `v10 → v18` schema steps + filesystem moves. Capture output.
- [ ] **Verify data:** `parachute-vault status`; hit `GET /health` (should list `vaults`); confirm `~/.parachute/vault/data/default/vault.db` exists and matches golden baseline counts.
- [ ] Confirm tag schemas survived (query `/vault/default/api/tags?include_schema=true` once we have a token).

### Phase 2 — Auth (mint hub JWT)
- [ ] Mint a long-lived write JWT:
      `parachute auth mint-token --scope vault:default:write --expires-in 31536000` (1 year, the max).
- [ ] Record the JWT + its `expires_at`. (Admin is NOT mintable via mint-token; write inherits read and covers every Prism route — Prism never hits admin-only `/.parachute/config`.)
- [ ] Smoke-test the JWT against the new URL:
      `curl -s -H "Authorization: Bearer <JWT>" http://127.0.0.1:1940/vault/default/api/notes?limit=1`

### Phase 3 — Prism backend code changes
**3a. Vault-scoped base URL** (`clients/parachute.rs`, `commands/config.rs`, `lib.rs`)
- [ ] Add `parachute_vault: String` to `AppConfig` (default `"default"`).
- [ ] `ParachuteClient::new(base_url, vault, api_key)`: build `{root}/vault/{vault}/api`; **store `server_root` separately** so `health()` hits root `/health` correctly (current `trim_end_matches("/api")` would now yield `/vault/default/health` — bug to fix).
- [ ] `lib.rs:61`: `mcp_url = format!("{}/vault/{}/mcp", parachute_url, vault)`.
- [ ] Thread `vault` into `DispatchManager::new` (verify it builds its own client/URL).

**3b. Token swap**
- [ ] Put the hub JWT in `prism-config.json` `parachute_api_key` (Settings UI write path already exists). No code change to `authed()` — still `Bearer`.

**3c. Mandatory concurrency — proper `if_updated_at`** (`models/note.rs`, `clients/parachute.rs`, all callers)
- [ ] Add to `UpdateNoteParams`: `if_updated_at: Option<String>` and `force: Option<bool>` (snake_case, `skip_serializing_if = "Option::is_none"`).
- [ ] Content/metadata writes (`update_note`): callers pass the `updatedAt` they last read.
      - Sync services already fetch/search the note first → `updatedAt` in hand. Thread it.
      - `vault_update_note` IPC command: add `ifUpdatedAt` param; frontend `updateNote` passes `note.updatedAt` (it has the loaded note).
      - On `409 conflict`: re-fetch, reconcile, retry (or surface to user for editor).
- [ ] Structural mutations (`add_tags`/`remove_tags`/`create_link`/`delete_link`): these are set-semantic and low-conflict and don't carry an `updatedAt` in hand → send `force:true`. (Documented exemption is only for pure append/prepend, so we can't omit; `force` is correct here.)
- [ ] Map REST `428` and `409 conflict` to typed `PrismError` variants so the UI can react.

**3d. Graph neighborhood params** (`clients/parachute.rs:get_graph`)
- [ ] Switch `near`/`depth` flat params to `near[note_id]`, `near[depth]`.

**3e. Adopt low-risk wins (optional, recommend for message/email sync)**
- [ ] Consider `append` for message-thread growth (eliminates read-modify-write + concurrency entirely).
- [ ] Consider `if_missing:"create"` to simplify find-or-create sync paths.

### Phase 4 — MCP / agent surface
- [ ] Update `.mcp.json`: URL → `http://127.0.0.1:1940/vault/default/mcp`, `Authorization: Bearer <JWT>`.
- [ ] `mcp_client.rs`: protocol version `2025-03-26` — verify still accepted by 0.5.1 streaming transport; bump if the server rejects the handshake.
- [ ] Confirm Claude Code subprocesses spawned by Prism (in project root) pick up the new `.mcp.json` and see all 9 tools (write scope).
- [ ] (Security) consider not committing the JWT — use env interpolation if supported, or gitignore. The current `pvt_` is already committed; rotate it out of history later.

### Phase 5 — Verification matrix
Run against the live 0.5.1 server with the new build:
- [ ] `vault_get_stats` / `vault_get_info` — counts match golden baseline.
- [ ] `vault_list_tree` — full tree renders (13k+ entries).
- [ ] `vault_get_note` — content loads.
- [ ] `vault_create_note` — new note appears; round-trips.
- [ ] `vault_update_note` with correct `ifUpdatedAt` — succeeds; with stale → 409 handled.
- [ ] `vault_add_tags` / `vault_remove_tags` — succeed (force path).
- [ ] `vault_create_link` / `vault_delete_link` / `vault_get_links` — graph edges update.
- [ ] `vault_get_graph` — full graph + neighborhood.
- [ ] `vault_search` — FTS returns results.
- [ ] Each background service one full cycle: message_sync, calendar_sync, email_sync, transcript_sync, notion_db sync — no 401/404/428 in logs.
- [ ] Agent dispatch (`claude -p` via DispatchManager) can read+write the vault over MCP.
- [ ] Editor autosave round-trip via TipTap.

### Phase 6 — Cleanup & follow-ups
- [ ] Update `CLAUDE.md` (MCP URL, auth model = hub JWT, data path).
- [ ] Update memory: `project_parachute_v2.md` → note 0.5.1 + hub JWT auth.
- [ ] Document JWT expiry (≤1yr) + the re-mint command; add a graceful 401 → "re-authenticate" UI path. Consider auto re-mint via `<hub>/api/auth/mint-token` + `operator.token` later.
- [ ] Revisit `project_parachute_empty_note_leak.md` — empty notes valid again in 0.5.x.
- [ ] Remove committed token from `.mcp.json` history if rotating.

---

## 6. Rollback plan
If the upgraded server misbehaves or data looks wrong:
1. Stop the 0.5.1 daemon.
2. `bun add -g @openparachute/vault@0.2.4` (reinstall old).
3. `rm -rf ~/.parachute && cp -a ~/.parachute.bak-0.2.4-… ~/.parachute`.
4. Restart old daemon; revert Prism to the pre-migration commit (the `migrate/parachute-0.5` branch is unmerged, so `git checkout main`).
5. Old `pvt_` token + old `.mcp.json` are restored with the backup.

Rollback is clean because: (a) the old DB copy is untouched, (b) Prism changes live on a branch, (c) the hub install is additive (uninstalling it doesn't touch vault data).

---

## 7. Open risks / things to watch
- **JWT expiry** (≤1yr): a long-running daemon will eventually 401. Need re-mint + graceful handling. Not a launch blocker but must be tracked.
- **Hub as new dependency**: a second service on :1939 must be running for token validation (revocation check, 60s cache, fail-open on outage / fail-closed on cold start). If hub is down at Prism cold start, auth may fail-closed.
- **`mcp_client.rs` protocol version**: unverified against 0.5.1 transport — test early.
- **DispatchManager client construction**: confirm it routes through the scoped URL (it takes `parachute_url` separately at `lib.rs:81`).
- **Metadata shallow-merge (S6)**: if any flow relied on metadata replacement to *clear* fields, it now won't. Audit during Phase 5.
- **Frontend `updatedAt` availability**: the editor/IPC must surface `updatedAt` to send `if_updated_at`; confirm `Note.updatedAt` is populated in the frontend type and not stripped by `enrich_note`.
