import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import assets


class AssetsTests(unittest.TestCase):
    def test_unsafe_paths_and_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in ('../escape', '/escape', 'a/../escape', 'a//b', 'a\\b'):
                with self.assertRaises(ValueError):
                    assets.safe_target(root, path)
            (root / 'link').symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                assets.safe_target(root, 'link/model')

    def test_hashes_stream_and_detect_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'model'
            target.write_bytes(b'valid')
            for pin in ({'sha256': hashlib.sha256(b'valid').hexdigest()}, {'gitBlob': hashlib.sha1(b'blob 5\0valid').hexdigest()}):
                self.assertTrue(assets.matches(target, dict(size=5, **pin)))
                target.write_bytes(b'wrong')
                self.assertFalse(assets.matches(target, dict(size=5, **pin)))
                target.write_bytes(b'valid')

    def test_default_is_offline_and_budget_preflight_is_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps([dict(local='model', remote='model', revision='a'*40, size=5, sha256=hashlib.sha256(b'valid').hexdigest())]))
            with patch('urllib.request.urlopen') as network:
                with self.assertRaises(RuntimeError):
                    assets.prepare(root / 'cache', manifest, root / 'index')
                with self.assertRaises(RuntimeError):
                    assets.prepare(root / 'cache', manifest, root / 'index', download=True, budget=4)
                network.assert_not_called()

if __name__ == '__main__':
    unittest.main()
