#!/usr/bin/env python3
"""Copy the pinned existing SDK and add a temporary isolated-cache seam."""
import argparse
import pathlib
import shutil
import subprocess

PIN = '503b4bd1bbf7220882de39fe8ae6716aae4132da'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('checkout', type=pathlib.Path)
args = parser.parse_args()
actual = subprocess.check_output(['git', '-C', str(args.checkout), 'rev-parse', 'HEAD'], text=True).strip()
if actual != PIN:
    raise RuntimeError('SDK revision differs from the evaluated v0.17.7 pin')
target = pathlib.Path('/private/tmp/omni-kokoro-fluid-audio')
if target.exists():
    raise RuntimeError('Temporary SDK copy already exists; reuse only after verifying its revision and cache patch')
shutil.copytree(args.checkout, target, ignore=shutil.ignore_patterns('.git', '.build'))
source = target / 'Sources/FluidAudio/TTS/Shared/TtsCacheDirectory.swift'
text = source.read_text()
marker = '        let base: URL'
if text.count(marker) != 1:
    raise RuntimeError('SDK cache source no longer matches expected seam')
patch = '''        if let isolated = ProcessInfo.processInfo.environment["OMNI_TTS_EVALUATION_CACHE"] {
            let root = URL(fileURLWithPath: isolated, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            return root
        }
'''
source.chmod(source.stat().st_mode | 0o200)
source.write_text(text.replace(marker, patch + marker))
(target / 'omni-evaluation-source-revision.txt').write_text(PIN + '\n')
print('Prepared isolated SDK copy at ' + str(target))
