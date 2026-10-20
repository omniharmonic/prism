#!/usr/bin/env python3
"""Named Mini rollout helper: dry run by default, nonsensitive TTS paths only.
Does not restart services or read Keychain. deploy.sh retains environment rendering.
"""
import argparse
import datetime
import os
import re
import shutil
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--server-dir", type=Path, required=True)
parser.add_argument("--hermes-root", type=Path)
parser.add_argument("--python", type=Path)
parser.add_argument("--kokoro-executable", type=Path)
parser.add_argument("--kokoro-cache", type=Path)
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
values = {}
if bool(args.hermes_root) != bool(args.python) or bool(args.kokoro_executable) != bool(args.kokoro_cache):
    parser.error("supply both paths for each selected provider")
if args.hermes_root:
    values.update(OMNI_TTS_HERMES_ROOT=str(args.hermes_root), OMNI_TTS_PYTHON=str(args.python))
if args.kokoro_executable:
    values.update(OMNI_TTS_KOKORO_EXECUTABLE=str(args.kokoro_executable), OMNI_TTS_KOKORO_CACHE=str(args.kokoro_cache))
if not values:
    parser.error("select Hermes or Kokoro configuration")
for path in [args.server_dir, *map(Path, values.values())]:
    if not path.is_absolute() or not path.exists() or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)):
        parser.error("existing absolute paths with no dotenv metacharacters required")
if args.hermes_root and (not (args.hermes_root / "tools/tts_tool.py").is_file() or not args.python.is_file()):
    parser.error("installed Hermes generator and Python required")
if args.kokoro_executable and (not args.kokoro_executable.is_file() or not os.access(args.kokoro_executable, os.X_OK) or not args.kokoro_cache.is_dir()):
    parser.error("executable Kokoro worker and cache directory required")
target = args.server_dir / (".env.tmpl" if (args.server_dir / ".env.tmpl").exists() else ".env")
if target.is_symlink() or not target.is_file():
    parser.error("regular existing environment/template file required")
lines = target.read_text().splitlines(keepends=True)
for key in values:
    matches = [line for line in lines if re.match(r"^(?:export\s+)?" + key + r"\s*=", line)]
    if len(matches) > 1:
        parser.error("duplicate TTS setting; resolve through rollout review")
print("target=" + str(target))
for key, value in values.items():
    print(key + "=" + value)
if not args.apply:
    print("dry_run=true; no files changed; no restart")
    raise SystemExit(0)
backup = args.server_dir / ("omni-tts-config-backups/" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ"))
backup.mkdir(parents=True, mode=0o700)
os.chmod(backup.parent, 0o700)
for name in (".env", ".env.tmpl"):
    source = args.server_dir / name
    if source.is_symlink():
        parser.error("symlink environment refused")
    if source.exists():
        shutil.copyfile(source, backup / name)
        os.chmod(backup / name, 0o600)
updated = []
seen = set()
for line in lines:
    replaced = False
    for key, value in values.items():
        if re.match(r"^(?:export\s+)?" + key + r"\s*=", line):
            updated.append(key + "=" + value + "\n")
            seen.add(key)
            replaced = True
            break
    if not replaced:
        updated.append(line)
if updated and not updated[-1].endswith("\n"):
    updated[-1] += "\n"
for key, value in values.items():
    if key not in seen:
        updated.append(key + "=" + value + "\n")
fd, temporary = tempfile.mkstemp(prefix=".omni-tts-env-", dir=args.server_dir)
try:
    with os.fdopen(fd, "w") as output:
        output.write("".join(updated))
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print("backup=" + str(backup))
print("applied=true; no restart; deploy.sh renders template when present")
