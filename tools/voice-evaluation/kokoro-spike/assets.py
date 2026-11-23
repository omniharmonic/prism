"""Pinned Kokoro cache preparation; network access is always explicit."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import urllib.request

DEFAULT_BUDGET = 750_000_000


def safe_target(root, relative):
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or any(p in ('', '.', '..') for p in relative.split('/')) or '\\' in relative:
        raise ValueError('Unsafe asset path: ' + relative)
    target = root.joinpath(*path.parts)
    # Reject symlinks even if they currently resolve inside the cache.
    for item in (root, target, *[p for p in target.parents if p != root and root in p.parents]):
        if item.is_symlink():
            raise ValueError('Symlink in asset path: ' + str(item))
    return target


def load_manifest(path):
    entries = json.loads(Path(path).read_text())
    seen = set()
    for entry in entries:
        safe_target(Path('/manifest-validation'), entry['local'])
        safe_target(Path('/manifest-validation'), entry['remote'])
        if entry['local'] in seen:
            raise ValueError('Duplicate asset path')
        seen.add(entry['local'])
        if not re.fullmatch(r'[0-9a-f]{40}', entry['revision']) or type(entry['size']) is not int or entry['size'] < 0:
            raise ValueError('Invalid asset pin')
        key = 'sha256' if entry.get('sha256') else 'gitBlob'
        if not re.fullmatch(r'[0-9a-f]{64}' if key == 'sha256' else r'[0-9a-f]{40}', entry.get(key, '')):
            raise ValueError('Missing or invalid asset checksum')
    return entries


def matches(path, entry):
    if not path.is_file() or path.stat().st_size != entry['size']:
        return False
    digest = hashlib.sha256() if entry.get('sha256') else hashlib.sha1()
    if not entry.get('sha256'):
        digest.update(b'blob ' + str(entry['size']).encode() + b'\0')
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest() == entry.get('sha256', entry.get('gitBlob'))


def atomic_bytes(target, data):
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    os.replace(temp, target)


def prepare(root, manifest, index, *, download=False, budget=DEFAULT_BUDGET):
    root = Path(root).absolute()
    entries = load_manifest(manifest)
    missing = [e for e in entries if not matches(safe_target(root, e['local']), e)]
    if missing and not download:
        raise RuntimeError('Missing or invalid pinned assets: ' + ', '.join(e['local'] for e in missing))
    if budget < 0 or sum(e['size'] + 1 for e in missing) > budget:
        raise RuntimeError('Download budget exceeded before network access')
    transferred = 0
    for entry in missing:
        target = safe_target(root, entry['local'])
        target.parent.mkdir(parents=True, exist_ok=True)
        url = 'https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/' + entry['revision'] + '/' + entry['remote']
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
            temp = Path(stream.name)
            try:
                with urllib.request.urlopen(url, timeout=120) as response:
                    if response.geturl().split(':', 1)[0] != 'https':
                        raise RuntimeError('Non-HTTPS asset redirect')
                    remaining = entry['size'] + 1
                    while remaining:
                        chunk = response.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        stream.write(chunk)
                        remaining -= len(chunk)
                        transferred += len(chunk)
                stream.flush()
                os.fsync(stream.fileno())
                if not matches(temp, entry):
                    raise RuntimeError('Pinned checksum mismatch: ' + entry['remote'])
                safe_target(root, entry['local'])
                os.replace(temp, target)
            finally:
                temp.unlink(missing_ok=True)
    # This local index prevents FluidAudio directory-listing network requests.
    base = 'Models/kokoro-82m-coreml/ANE-v3/6c0750dd02ef9d981fb82f147d784a3f171755ee/en/base-index-v3.json'
    atomic_bytes(safe_target(root, base), Path(index).read_bytes())
    receipt = dict(transferredBytes=transferred, knownBytes=sum(e['size'] for e in entries), budgetBytes=budget, files=len(entries), allPinnedChecksumsVerified=True)
    atomic_bytes(safe_target(root, 'download-receipt.json'), json.dumps(receipt, indent=2).encode())
    return receipt
