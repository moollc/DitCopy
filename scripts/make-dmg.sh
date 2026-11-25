#!/bin/bash
# Makes a disk image with DitCopy.app and a shortcut to Applications, for dragging.
#   scripts/make-dmg.sh <path to DitCopy.app> <output.dmg>
set -euo pipefail
APP="${1:?path to DitCopy.app}"
OUT="${2:?output .dmg path}"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/DitCopy.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -volname "DitCopy" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "Made $OUT ($(du -h "$OUT" | cut -f1))"
