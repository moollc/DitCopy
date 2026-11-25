#!/bin/bash
# Builds DitCopy.app.
#   ./build-app.sh                        a developer build next to this script, it finds this folder through the DitCopyRoot key
#   ./build-app.sh --bundle <dir> [--out <folder>]
#                                         a self contained app that carries the packaged copy <dir> (see scripts/package.js)
#                                         inside itself, with no path to this machine, for downloading
set -euo pipefail
# Paths given as options are relative to where the script was run from, so they are read before changing folder.
BUNDLE=""
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE="$(cd "$2" && pwd)"; shift 2 ;;
    --out) mkdir -p "$2"; OUT="$(cd "$2" && pwd)"; shift 2 ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
done
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
[[ -n "$OUT" ]] || OUT="$(pwd)"
APP="$OUT/DitCopy.app"
rm -rf "$APP" 2>/dev/null || true
VERSION="0.1"
if [[ -n "$BUNDLE" ]]; then VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$BUNDLE/bundle.json" | head -1)"; fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp icon.icns "$APP/Contents/Resources/icon.icns"
# Some Command Line Tools installs ship a stale second copy of the SwiftBridging module map, which
# breaks every Swift build. This overlay hides it for this build only; nothing under /Library changes.
TMP="$(mktemp -d)"
: > "$TMP/empty.modulemap"
MM="$(xcode-select -p)/usr/include/swift/module.modulemap"
printf '{"version":0,"case-sensitive":"false","roots":[{"name":"%s","type":"file","external-contents":"%s"}]}' "$MM" "$TMP/empty.modulemap" > "$TMP/ov.yaml"
OVERLAY=()
if [[ -f "$MM" ]] && cmp -s "$MM" "$(dirname "$MM")/bridging.modulemap" 2>/dev/null || grep -q "module SwiftBridging" "$MM" 2>/dev/null; then
  OVERLAY=(-vfsoverlay "$TMP/ov.yaml" -Xcc -ivfsoverlay -Xcc "$TMP/ov.yaml")
fi
swiftc -O ${OVERLAY[@]+"${OVERLAY[@]}"} -o "$APP/Contents/MacOS/DitCopy" main.swift -framework Cocoa -framework WebKit -framework UserNotifications
ROOT_KEY="<key>DitCopyRoot</key><string>$ROOT</string>"
if [[ -n "$BUNDLE" ]]; then
  ROOT_KEY=""
  mkdir -p "$APP/Contents/Resources"
  cp -R "$BUNDLE" "$APP/Contents/Resources/ditcopy"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>DitCopy</string>
<key>CFBundleIdentifier</key><string>io.github.moollc.ditcopy</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundleExecutable</key><string>DitCopy</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
$ROOT_KEY
</dict></plist>
PLIST
# Ad hoc signature: it keeps the app launchable but macOS still asks first time (right click, Open) until it is notarized.
codesign --force --deep --sign - "$APP" >/dev/null
echo "Built $APP"
