#!/bin/bash
# macOS: double click, or run in a terminal. The launcher is ditcopy.js, shared with Linux and Windows.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")" || exit 1
# A downloaded copy carries its own Node in runtime/. A source checkout uses the Node you installed.
NODE=node; [ -x "./runtime/node" ] && NODE="./runtime/node"
fail() { echo; echo "$1"; echo; [ -t 0 ] && read -r -p "Press Enter to close this window" _; exit 1; }
command -v "$NODE" >/dev/null || fail "This is the developer version, and it needs Node.js. To use DitCopy without installing anything, download the app for your Mac: https://github.com/moollc/DitCopy/releases/latest"
"$NODE" ditcopy.js stop "$@"
code=$?
[ $code -ne 0 ] && fail "DitCopy could not stop. The message above says why. To use DitCopy without installing anything, download the app: https://github.com/moollc/DitCopy/releases/latest"
exit 0
