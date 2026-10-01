# Folder and database sync on the Prism Server

The legacy desktop app had two syncs that ran on the laptop: **GitHub folder sync**
(a vault folder mirrored into a repository) and **Notion database sync** (rows of a
Notion database ⇄ tagged vault notes). Both now run on the Prism Server, so the web app
and Prism Client have them too (Client parity B). Per-note sync to Google Docs / Notion
(`metadata.sync[]`, `POST /api/sync/note/:id/push|pull`) is unchanged and documented in
`docs/roadmap/architecture-v2/desktop-parity.md`.

Code: `apps/server/src/worker/github-dir.ts` (serialization + Git Data API push),
`worker/github-folder.ts` (configs, import, auto-sync), `worker/notion-db.ts` (adapter),
`worker/notion-db-service.ts` (configs, background pass), `worker/sync-store.ts` (tables,
locks, audit), routes in `routes/sync.ts`. UI: `GitHubSyncModal`, `NotionDbSyncModal`
(command bar → "Notion Database Sync…"), the GitHub row of the note Sync panel, all through
the `HostServices.githubSync` / `notionDbSync` seam (`packages/core/src/lib/host/`).

## Who can use it

Every route is under `/api/sync` (admin gate, like the other sync routes) and scoped to
the actor's active vault (`X-Prism-Vault`): a config of another vault is a 404. The client
seam is provided to the **server owner** only, so the modals show a notice to anyone else.
The import route is **server owner** only. Credentials are the vault's stored `github`
(`{token}`) and `notion` (`{apiKey}`) secrets from Network → Server → Sync integrations.
No route ever returns them.

## GitHub folder sync

### Design: the Git Data API, not a clone

The desktop cloned each repo and ran `git` / `gh`. The server does the same job over the
GitHub API with the stored token:

1. `GET git/ref/heads/<branch>` → commit → recursive tree (paths + blob SHAs).
2. Serialize every note under the folder and compute its **git blob SHA locally**. A file
   whose SHA matches the remote is unchanged, and nothing is downloaded.
3. `POST git/trees` (base tree + only the changed files, chunked) → `POST git/commits` →
   `PATCH git/refs` (fast-forward only; a race is recomputed once).

So one push is **one commit**, as with the desktop's `git commit && git push`, with no
working tree on disk, no `git` binary and no credential helper on the server. An empty
repository gets its first file through the Contents API (the Git Data API refuses empty
repos). A branch that doesn't exist is created from the default branch.

### Behaviour kept from the desktop

- Scope: notes whose path is under the folder on a segment boundary.
- Repo path: the vault path minus the folder, plus the file extension when the leaf has
  none (`md` and `.md` both accepted).
- File: YAML frontmatter (`title`, `tags`, `vault_path`, then every metadata key, sorted)
  and the body with `[[wikilinks]]` rewritten to relative links inside the synced set.
  The YAML follows serde_yaml's output so the repos the desktop wrote don't churn.
- Commit messages: `Prism sync: N file(s) updated`, single note `Update <file>`; author
  `Prism Sync <prism@local>`.
- Repo files nothing maps to are reported as `pulled` **candidates**, not imported. To
  import a repo, use the stateless `POST /api/sync/github/pull`.
- Files are never deleted from the repository.

### Deliberate changes

- **Real conflict detection.** `blob_map` remembers the blob Prism last wrote to each
  path. A remote file that differs from it was edited on GitHub: `local-wins` overwrites
  it, `remote-wins` keeps it and reports a conflict. The desktop compared against its own
  clone, so under remote-wins it never pushed a note again after its first local edit.
  Its UI also sent `remote_wins`, which the adapter never matched. Both spellings work now.
- **Path safety.** Every repo path passes `safeRepoPath`: no `..`, no absolute path, no
  `.git` segment, no control characters or backslashes, and length limits. Remotes must
  be `github.com/<owner>/<repo>`. Branch names follow git ref rules.
- **Caps.** `GITHUB_SYNC_MAX_FILE_BYTES` (5 MiB), `GITHUB_SYNC_MAX_BATCH_BYTES` (50 MiB),
  `GITHUB_SYNC_MAX_FILES` (5000) per commit. Over the cap, the rest go out on the next
  push. A repository whose tree is too large for one listing is refused.
- **push-file** refuses a note outside the folder. The desktop pushed it under its full
  vault path.
- `id_map` (note → repo path) is maintained; the desktop never filled it.

### Auto-sync

The desktop pushed after every save, and because of a bug it pushed to **every**
auto-sync config whatever the folder. The server listens to the tree projection's change
feed (`subscribeTreeChanges`, the vault's own subscribe socket, so there is no polling):

- An upsert whose path (old or new) is under an auto-sync folder marks that note dirty.
- After `GITHUB_AUTOSYNC_DEBOUNCE_MS` (30 s) of quiet, or `GITHUB_AUTOSYNC_MAX_WAIT_MS`
  (5 min) after the first change, the dirty notes go out as **one commit**.
- A projection `resync` (a socket reconnect or rebuild) can hide changes, so it schedules a
  full folder push. Unchanged files cost nothing.
- `commit_strategy: manual` never auto-pushes. `GITHUB_AUTOSYNC_ENABLED=false` turns the
  listener off for every config.

Every push of a config (manual, push-file, auto, init) runs under that config's lock, so
two pushes never interleave.

### Routes (`/api/sync/github`)

| Route | What it does |
|---|---|
| `GET /auth` | `{authenticated, configured, username, message}` for the stored token |
| `GET /configs` | the vault's configs (desktop `GitHubSyncInfo` + strategies, `lastResult`, `lastError`, `syncedCount`) |
| `POST /configs` `{vaultPath, remoteUrl, branch, commitStrategy, conflictStrategy, autoSync}` | checks the repo is pushable, creates the config, pushes the folder. A failed first push removes the config again |
| `POST /configs/:id/push` | push the whole folder → `{pushed, pulled, conflicts, errors, unchanged, commit}` |
| `POST /configs/:id/push-file` `{noteId}` | push one note |
| `PATCH /configs/:id` `{autoSync?, commitStrategy?, conflictStrategy?}` | e.g. re-enable an imported config |
| `DELETE /configs/:id` | remove the config (the repository is untouched) |
| `POST /import` (server owner) | import the desktop's `github-sync-configs.json` (below) |

## Notion database sync

Each database row ⇄ one note tagged `parachute_tag` under `path_prefix`. Properties map
to metadata through a property map (`notionProperty`, `notionType`, `parachuteField`,
`transform`, `valueMap`). Kept from `notion_db.rs`: the auto-discovered mappings, the
extract / transform / reverse-transform tables, `should_overwrite` (`notion-wins` /
`parachute-wins` / `newer-wins`; an unparseable timestamp falls back to overwriting), the
no-op skip before the strategy gate, pull-then-push for `bidirectional`, `notion_page_id` +
`title` in metadata, and new notes at `<prefix>/<slugify(title)>`.

Deliberate changes:
- Vault updates carry **`if_updated_at`**. A 409 counts as a conflict, never a blind write.
- The push **skips a page that already matches** the note, comparing in the vault's
  vocabulary, so a lossy reverse transform can't rename a Notion option on every run. It
  also honours the strategy: a page edited in Notion since the last sync is not
  overwritten under `notion-wins`, or under `newer-wins` when Notion is newer. The desktop
  re-PATCHed every page every run.
- "Since the last sync" means the time the run **started**. The desktop advanced
  `last_synced` inside the pull, so its push never saw anything as changed.
- The push filters by tag + path prefix on a segment boundary. The desktop passed the
  prefix as an exact path, so its push found nothing.
- `status` properties are supported in both directions.
- A created note whose path is taken gets a `-<page id>` suffix instead of failing.
- Notion requests are rate-limited to `NOTION_DB_RPS` (3/s) per token, and a 429 is
  retried after `Retry-After`.
- Inputs accept every spelling the old UIs used (`notion-to-prism`, `newer`,
  `metadata.status`, `(skip)`, `content`, transform `none` / `slug`, …).

Background: configs with `autoSync` run every `NOTION_DB_SYNC_INTERVAL_MS` (10 min)
**only when `NOTION_DB_SYNC_ENABLED=true`** (default off: it writes to the vault and to
Notion unattended). Manual sync is always available.

### Routes (`/api/sync/notion-db`)

`GET /databases`, `GET /databases/:id/schema` (`{properties, suggestedMappings}`),
`GET /configs`, `POST /configs` (no network; validated), `POST /configs/:id/sync` →
`{created, updated, deleted, conflicts, unchanged, errors}`, `PATCH /configs/:id`
`{autoSync?, conflictStrategy?, syncDirection?}`, `DELETE /configs/:id`.

## Audit

`sync_audit` (SQLite) gets one row per outbound write batch and per config change:
actor (email, `auto-sync` or `worker`), vault, kind, config, action (`init`, `push`,
`push-file`, `auto-push`, `sync`, `auto-sync`, `import`, `update`, `remove`), target
(`owner/repo@branch` or the database id), status (`ok`, `noop`, `failed`), counts, commit
SHA, and a scrubbed error. It never holds note content. Read it with
`GET /api/sync/audit?kind=github|notion-db&config=<id>&limit=N`.

## Env

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_AUTOSYNC_ENABLED` | on | `false` = no auto-sync for any config |
| `GITHUB_AUTOSYNC_DEBOUNCE_MS` / `GITHUB_AUTOSYNC_MAX_WAIT_MS` | 30000 / 300000 | auto-sync batching window |
| `GITHUB_SYNC_MAX_FILE_BYTES` / `_MAX_BATCH_BYTES` / `_MAX_FILES` / `_TREE_CHUNK` | 5 MiB / 50 MiB / 5000 / 300 | caps |
| `NOTION_DB_SYNC_ENABLED` | off | background pass for auto-sync Notion configs |
| `NOTION_DB_SYNC_INTERVAL_MS` | 600000 | background cadence |
| `NOTION_DB_RPS` | 3 | Notion requests per second per token |

## Runbook (overseer): import the desktop's GitHub configs

The desktop's five GitHub folder syncs have been dormant since 2026-07-10. Import them
with auto-sync **off**, push each one by hand once, then re-enable the ones that matter.

1. **Credential.** Store a GitHub token that can push to those repos in **Network →
   Server → Sync integrations → GitHub** for the target vault (fine-grained: Contents
   read/write on those repos). Check it with `GET /api/sync/github/auth` (it should return
   `authenticated: true` and the account).
2. **Read the desktop file** on the old laptop:
   `~/Library/Application Support/prism/github-sync-configs.json`. Glance at it: five
   entries, each with `vault_path`, `remote_url`, `branch`. `local_clone_path` is ignored.
3. **Import** as the server owner (session cookie or `pd_` device token), with the target
   vault in `X-Prism-Vault` (omit for the primary vault):
   ```bash
   curl -sS -X POST "$SERVER/api/sync/github/import" \
     -H "Authorization: Bearer $PD_TOKEN" -H "Content-Type: application/json" \
     --data-binary @github-sync-configs.json | jq
   ```
   Each entry comes back `created`, `exists` (already imported: the import is
   idempotent) or `invalid` with a reason. `desktopAutoSync` shows which ones were on.
   Imported configs keep their desktop id, `id_map` and `last_synced`. Auto-sync is off.
   Nothing is sent to GitHub.
4. **First push, one config at a time** (Prism → open the folder's "Sync to GitHub…" →
   **Push now**, or `POST /api/sync/github/configs/<id>/push`). Expect one commit holding
   every change since July. `blob_map` starts empty, so a file that differs on GitHub
   counts as a conflict once: `local-wins` (the desktop default) overwrites it,
   `remote-wins` keeps it and lists it under `conflicts`. The first commit may also carry
   small frontmatter formatting differences. Review the commit on GitHub. A later push with
   nothing changed must report `commit: null`.
5. **Re-enable auto-sync** for the ones that should follow edits: the checkbox in the
   folder's GitHub dialog, or `PATCH /api/sync/github/configs/<id> {"autoSync": true}`.
   Watch `GET /api/sync/audit?kind=github` for `auto-push` rows after an edit (about 30 s).
6. **Rollback:** `PATCH … {"autoSync": false}` or `DELETE /api/sync/github/configs/<id>`.
   Commits already pushed stay in the repo (`git revert` there if needed).

Never run the desktop's GitHub sync and the server's for the same folder at once (both
would commit). The desktop is retired; its `github-sync-configs.json` stays as a backup.
