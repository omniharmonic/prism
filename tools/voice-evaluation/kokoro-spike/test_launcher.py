import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

LAUNCHER = Path(__file__).parent.parent / 'kokoro-worker' / 'launch-kokoro.sh'

class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        shutil.copy(LAUNCHER, self.root / 'launch-kokoro.sh')
        (self.root / 'asset-tools').mkdir()
        (self.root / 'bin').mkdir()
        self.binary = self.root / 'bin' / 'KokoroWorker'
        self.binary.write_text('#!/bin/bash\n/bin/cat\n')
        self.binary.chmod(0o700)
        self.verifier = self.root / 'asset-tools' / 'download.py'
        self.verifier.write_text("import sys\nassert sys.stdin.read() == ''\nassert sys.argv[1:] == ['--cache', " + repr(str(self.root / 'cache')) + "]\nprint('verification metadata')\n")
    def tearDown(self):
        self.temp.cleanup()
    def run_launcher(self, cache=None):
        return subprocess.run([str(self.root / 'launch-kokoro.sh')], input=b'{"id":"test","text":"synthetic"}\n', capture_output=True, cwd='/', env={'OMNI_TTS_EVALUATION_CACHE': cache or str(self.root / 'cache')})
    def test_verifier_preserves_protocol_stdin_and_stdout(self):
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'{"id":"test","text":"synthetic"}\n')
        self.assertEqual(result.stderr, b'verification metadata\n')
    def test_verification_failure_never_executes_worker(self):
        self.verifier.write_text('raise SystemExit(9)\n')
        result = self.run_launcher()
        self.assertEqual(result.returncode, 9)
        self.assertEqual(result.stdout, b'')
    def test_relative_cache_rejected(self):
        result = self.run_launcher('relative')
        self.assertEqual(result.returncode, 64)
        self.assertEqual(result.stdout, b'')

if __name__ == '__main__':
    unittest.main()
