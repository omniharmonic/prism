#!/usr/bin/env bash
# Compile LockPolicy.swift with its tests for macOS and run them.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../src-tauri/plugins/prism-ios/ios/Sources/PrismIos/LockPolicy.swift"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -O "$src" "$here/main.swift" -o "$out/lock-policy-tests"
"$out/lock-policy-tests"
