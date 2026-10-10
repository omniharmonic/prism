#!/usr/bin/env bash
# Named runbook: docs/runbook/prism-runtime-media-cache.md. Dry-run by default.
set -euo pipefail
exec python3 - "$@" <<'PY'
import datetime
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

args = sys.argv[1:]
apply = bool(args and args[0] == '--apply')
if apply:
    args = args[1:]
if len(args) != 1:
    sys.exit('usage: ignore-runtime-media-cache.sh [--apply] <Prism checkout>')

def refuse(message):
    sys.exit('REFUSED: ' + message)

requested = Path(args[0]).absolute()
if requested.is_symlink():
    refuse('checkout must not be a symlink')
root = requested.resolve()

def git(*arguments):
    return subprocess.check_output(['git', '-C', str(root), *arguments])

if Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve() != root:
    refuse('pass the repository root')
cache = root / 'apps/server/media-cache'
for directory in [root / 'apps', root / 'apps/server', cache]:
    if directory.is_symlink() or not directory.is_dir():
        refuse('cache and its parent directories must be real directories')
if git('ls-files', '-z', '--', 'apps/server/media-cache'):
    refuse('cache contains tracked files')
# -z preserves unusual filenames; rename records and tracked modifications are refused.
for record in git('status', '--porcelain=v1', '-z', '--untracked-files=all').split(b'\0'):
    if not record:
        continue
    if record[:3] != b'?? ' or not record[3:].startswith(b'apps/server/media-cache/'):
        refuse('checkout changes are not exclusively untracked media cache files')
name_pattern = re.compile(r'[0-9a-f]{64}\.(?:bin|json)(?:\.tmp-[0-9a-f]{12})?')
count = 0
for entry in cache.iterdir():
    if entry.is_symlink() or not entry.is_file() or not name_pattern.fullmatch(entry.name):
        refuse('cache contains a symlink, directory, or unexpected filename')
    count += 1
# Already ignored by the new tracked rule or a previous housekeeping run: nothing to change.
ignored = subprocess.run(['git', '-C', str(root), 'check-ignore', '-q', '--', 'apps/server/media-cache/runtime-probe.bin'])
if ignored.returncode == 0:
    print('Already ignored; no changes. Cache files preserved:', count)
    sys.exit(0)
if ignored.returncode != 1:
    refuse('could not inspect ignore rules')
exclude_raw = Path(git('rev-parse', '--git-path', 'info/exclude').decode().strip())
exclude = exclude_raw if exclude_raw.is_absolute() else root / exclude_raw
if exclude.is_symlink():
    refuse('Git exclude file must not be a symlink')
exclude = exclude.resolve()
backup_base = Path(os.environ.get('PRISM_CACHE_BACKUP_ROOT', str(Path.home() / 'release-artifacts/runtime-cache-housekeeping'))).absolute()
if backup_base.resolve().is_relative_to(root):
    refuse('backup directory must be outside the checkout')
print('Cache files preserved:', count)
print('Git exclude:', exclude)
print('Backup location:', backup_base)
if not apply:
    print('DRY RUN: would back up Git exclude and append /apps/server/media-cache/.')
    sys.exit(0)
# Back up before changing ignore metadata; never open or alter cache file contents.
backup_base.mkdir(parents=True, exist_ok=True, mode=0o700)
backup = Path(tempfile.mkdtemp(prefix=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-'), dir=backup_base))
original = exclude.read_bytes() if exclude.exists() else b''
if exclude.exists():
    shutil.copy2(exclude, backup / 'info-exclude.before')
    os.chmod(backup / 'info-exclude.before', 0o600)
else:
    (backup / 'info-exclude.was-absent').touch(mode=0o600)
(backup / 'checkout.txt').write_text(str(root) + '\n')
os.chmod(backup / 'checkout.txt', 0o600)
exclude.parent.mkdir(parents=True, exist_ok=True)
updated = original + (b'\n' if original and not original.endswith(b'\n') else b'') + b'\n# Runtime cache; docs/runbook/prism-runtime-media-cache.md\n/apps/server/media-cache/\n'
fd, temporary = tempfile.mkstemp(prefix='.exclude-', dir=exclude.parent)
try:
    with os.fdopen(fd, 'wb') as output:
        output.write(updated)
    os.chmod(temporary, exclude.stat().st_mode & 0o777 if exclude.exists() else 0o600)
    os.replace(temporary, exclude)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
if git('status', '--porcelain=v1', '-z', '--untracked-files=all'):
    refuse('checkout is still dirty; inspect it before deployment; backup: ' + str(backup))
print('Applied local ignore; checkout clean. Backup:', backup)
PY
