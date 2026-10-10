# Preserve the runtime media cache when deployment preflight refuses it

Prism's media proxy creates `media-cache/` beside the server database. With the usual
server working directory, this is `apps/server/media-cache/`. The cache is runtime
data: hashed `.bin` bodies and `.json` metadata, with temporary files during writes.
It can contain private media. Do not commit, print, delete, or move its contents.

The tracked `.gitignore` excludes this exact directory. An older Mini checkout can
still fail `deploy.sh`'s clean-checkout preflight before fetching that fix. This named
housekeeping procedure adds the same rule to Git's local `info/exclude`, preserving
all cache files and tracked source. It does not restart the server or deploy code.

Use a reviewed copy of `scripts/release/ignore-runtime-media-cache.sh` outside the
Mini checkout (for example, under `~/release-artifacts/`). Pass the real Prism
checkout root; the helper defaults to a read-only dry run:

```bash
bash "$HOME/release-artifacts/ignore-runtime-media-cache.sh" "$HOME/dev/prism"
bash "$HOME/release-artifacts/ignore-runtime-media-cache.sh" --apply "$HOME/dev/prism"
```

Use the actual checkout path reported by deployment preflight. Run apply only after
the dry run confirms the scope. The helper refuses tracked changes, tracked cache
files, unrelated untracked files, cache symlinks/subdirectories and unexpected
filenames. It accepts only SHA-256 `.bin`/`.json` names and their `.tmp-` suffixes.
It resolves `git rev-parse --git-path info/exclude`, including linked worktrees, and
backs up any existing exclude file under
`~/release-artifacts/runtime-cache-housekeeping/<timestamp>-<unique>/` before
appending the exact `/apps/server/media-cache/` rule. Cache bytes are never opened.
An already ignored cache is a no-op. `PRISM_CACHE_BACKUP_ROOT` can select another
backup directory outside the checkout; it is useful for isolated verification.

Confirm clean `git status`, then rerun the existing `deploy.sh` dry run and approved
apply for the tagged release. This runbook never bypasses the deployment preflight.
If apply reports remaining changes, inspect them and stop deployment.

To undo housekeeping, compare `info-exclude.before` with the current Git exclude
file and remove only the appended comment/rule, preserving subsequent local rules.
The absence marker means there was no exclude file before the operation. Restoring
an entire backup is appropriate only after verifying no later rules were added.
Removing the local rule may expose the runtime cache as untracked again on an old
checkout. Cache data is retained throughout.
