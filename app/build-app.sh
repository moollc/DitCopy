#!/bin/bash
# Builds DitCopy.app next to this script. The app finds the repo through the DitCopyRoot key.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
APP="DitCopy.app"
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
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>DitCopy</string>
<key>CFBundleIdentifier</key><string>io.github.moollc.ditcopy</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundleExecutable</key><string>DitCopy</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>DitCopyRoot</key><string>$ROOT</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null
echo "Built $(pwd)/$APP"
