#!/usr/bin/env python3
"""Verify a pinned Kokoro cache, or explicitly prepare it with --download."""
import argparse
import json
from pathlib import Path
from assets import DEFAULT_BUDGET, prepare

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path('/private/tmp/omni-kokoro-cache'))
    parser.add_argument('--download', action='store_true', help='Allow bounded downloads of missing or invalid files')
    parser.add_argument('--budget', type=int, default=DEFAULT_BUDGET)
    args = parser.parse_args()
    here = Path(__file__).parent
    print(json.dumps(prepare(args.cache, here / 'asset-manifest.json', here / 'base-index.json', download=args.download, budget=args.budget)))
