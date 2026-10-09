#!/bin/bash
# Turn the PNGs the tests write into the committed gallery: smaller JPEGs under
# qa/screenshots/omni/ (same folders, same names). Uses `sips`, which macOS ships.
#
#   Scripts/gallery.sh <folder of PNGs> [<gallery folder>]
#
# e.g. after `OMNI_UITEST_SHOTS=/tmp/shots Scripts/uitest.sh all`:  Scripts/gallery.sh /tmp/shots
# Long edge: iPhone 1300 px, iPad 1300 px, Mac 1500 px. Quality 62.
set -euo pipefail
SRC="${1:?usage: Scripts/gallery.sh <folder of PNGs> [<gallery folder>]}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${2:-$(cd "$HERE/../.." && pwd)/qa/screenshots/omni}"
SRC="$(cd "$SRC" && pwd)"
n=0
while IFS= read -r -d '' png; do
  rel="${png#"$SRC"/}"
  case "$rel" in mac/*) edge=1500 ;; *) edge=1300 ;; esac
  dest="$OUT/${rel%.png}.jpg"
  mkdir -p "$(dirname "$dest")"
  sips -s format jpeg -s formatOptions 62 -Z "$edge" "$png" --out "$dest" >/dev/null
  n=$((n + 1))
done < <(find "$SRC" -name '*.png' -print0)
echo "gallery: $n pictures → ${OUT} ($(du -sh "$OUT" | cut -f1))"
