#!/bin/bash
# Makes a Debian package (works on Ubuntu, Debian, Mint) from a packaged copy.
#   scripts/make-deb.sh <packaged copy dir> <version> <output.deb>
set -euo pipefail
BUNDLE="${1:?packaged copy folder}"
VERSION="${2:?version}"
OUT="${3:?output .deb path}"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/opt" "$STAGE/usr/bin" "$STAGE/usr/share/applications" "$STAGE/usr/share/icons/hicolor/256x256/apps" "$STAGE/DEBIAN"
cp -R "$BUNDLE" "$STAGE/opt/ditcopy"
cat > "$STAGE/usr/bin/ditcopy" <<'LAUNCH'
#!/bin/sh
# ditcopy [start|stop|status|open]   with no argument it starts DitCopy and opens the page
cd /opt/ditcopy || exit 1
[ $# -eq 0 ] && set -- start
exec ./runtime/node ditcopy.js "$@"
LAUNCH
chmod 755 "$STAGE/usr/bin/ditcopy"
cp "$BUNDLE/icon.png" "$STAGE/usr/share/icons/hicolor/256x256/apps/ditcopy.png"
cat > "$STAGE/usr/share/applications/ditcopy.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=DitCopy
Comment=Multi destination copy with hash verify
Exec=/usr/bin/ditcopy start
Icon=ditcopy
Terminal=false
Categories=AudioVideo;Utility;
DESKTOP
cat > "$STAGE/DEBIAN/control" <<CONTROL
Package: ditcopy
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Depends: libc6 (>= 2.35)
Maintainer: moollc <135183296+moollc@users.noreply.github.com>
Homepage: https://github.com/moollc/DitCopy
Description: Multi destination copy with hash verify for DITs
 Copies camera cards to several drives at once and checks every byte.
 The page opens in your browser. Node and the copy engine are included.
CONTROL
find "$STAGE/opt/ditcopy" -type d -exec chmod 755 {} +
find "$STAGE/opt/ditcopy" -type f -exec chmod a+r {} +
dpkg-deb --root-owner-group --build "$STAGE" "$OUT" >/dev/null
echo "Made $OUT ($(du -h "$OUT" | cut -f1))"
