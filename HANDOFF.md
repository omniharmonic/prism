# HANDOFF — Lane B: Single-Server Vault-to-Vault Folder Sync

Everything parked here needs Benjamin's hands or judgment. Branch: `feat/single-server-folder-sync` (draft PR open). Nothing on this branch has touched a live vault — all testing was on throwaway `_mirror_*` scratch vaults, torn down after each run.

## ✅ 1. DONE (2026-07-13): SFR folder → Front Range Commons is LIVE

Completed with Benjamin's go-ahead: PR #16 merged to main, pm2 `prism-server` restarted (post-deploy checks matched the pre-deploy baseline exactly; DB backed up first to `apps/server/backups/prism-server-pre-mirror-20260713.db`). Mirror `7917d05b` runs every ~5 min:

- `primary:vault/projects/spirit-of-the-front-range` → `front-range-commons:projects/spirit-of-the-front-range`, `delete_mode: archive`
- Initial sync: **76 notes, full folder structure** (meetings/60, docs/5, outputs/4, …); the 4 pre-existing Commons notes untouched
- Proven live: idempotent steady state (76 skipped, 0 writes), create-propagation and verified delete→archive (with a throwaway note, fully cleaned up afterward)
- The worker-log 401s ("revocation list unavailable") visible in `pm2 logs` are STALE lines from Jul 12 (error-log mtime predates the deploy); the same queries return 200 live

Remaining owner knob: share the Commons material with the collaborator (tag or vault membership) so they see the folder tree.

<details><summary>Original go-live instructions (kept for reference)</summary>

1. **Restart `pm2 prism-server` after deploying** (the known gotcha: tsx compiles at start, no hot reload — a stale server has no `/acl/mirrors` routes).
2. Confirm the Front Range Commons vault's registry id: `GET /api/vaults` (as owner) or check the Vaults panel.
3. Create the mirror (owner session), e.g.:
   ```bash
   curl -X POST https://<your-origin>/acl/mirrors \
     -H 'content-type: application/json' -b '<owner session cookie>' \
     -d '{"srcVault":"primary","srcPrefix":"<SFR folder path prefix>","destVault":"<commons-vault-id>","destPrefix":"<prefix in commons>"}'
   ```
   Default `delete_mode` is `archive` (a deleted source note moves under `<destPrefix>/_archive/`, nothing destroyed) — recommend keeping that. The worker picks it up within ~60s and re-converges every 5 min; `POST /acl/mirrors/:id/sync` runs it immediately and returns the summary.
4. **First-run sanity check**: point `destPrefix` at a fresh/dedicated folder in the Commons vault, run the on-demand sync, and eyeball the result before granting collaborators. Every run's summary lands on the mirror row (`GET /acl/mirrors` → `last_result`).
5. The collaborator sees folders once their grants cover the mirrored notes — share the Commons material by **tag or vault membership** (see item 3 below for the folder-grant gap).

</details>

## ⏸ 2. GitHub account mismatch

The lane brief mandates `gh auth switch --user clawmniharmonic`, but that account has never been logged in on this machine (only `omniharmonic` — valid — and `omniharmonic-agent` — expired token). Per the logged decision in `RUN-LOG.md`, the branch/PR were pushed as `omniharmonic`, which is Benjamin's own account and satisfies the attribution rule. If agent ops should run under `clawmniharmonic` going forward: `gh auth login` for it on this machine.

## ⏸ 3. Decide: path-prefix grants (share "this folder" directly)

Root-cause finding: a collaborator "sees notes but not folders" because grants can only scope to note/tag/space/vault — folders are client-side derivations of `note.path`, so a sparse grant set can't materialize the tree. The mirror solves it for the Commons-vault topology; the *direct* fix is small and additive (~3 touches, documented in `docs/single-server-folder-sync.md` §"Collaborator folder visibility"): allow `resource_type='path'` grants, add `path` to `NoteRef` + populate it in the gateway's `ref()`, add a `pathInPrefix` branch to `effectiveLevel`, extend `visibleNotes` to pull `listNotes({pathPrefix})` per path grant. Deliberately NOT built in this lane — it widens the security-critical grant surface, which deserves its own review.

## Deferred (non-blocking, noted in the design doc)

- **No UI affordance yet** — mirrors are managed via `/acl/mirrors` (API). A "Mirror this folder…" panel under Network is a natural follow-up.
- **Empty folders can't sync** — folders exist only as note paths; a folder with no notes is invisible to every layer, not just the mirror.
- **One-way only (source wins)** — an edit made directly to a mirrored copy survives only until the source next changes. Two-way needs CRDT-level work (sketch in the design doc).
- **Scratch-vault residue** — the verify harness removes its vaults in a `finally`, but a hard kill mid-run could leave `_mirror_a_*`/`_mirror_b_*` vaults behind; `parachute-vault list` + `parachute-vault remove <name> --yes` cleans up.
