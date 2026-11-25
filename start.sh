#!/bin/sh
# Linux: run in a terminal. The launcher is ditcopy.js, shared with macOS and Windows.
PATH="$HOME/.cargo/bin:$PATH"; export PATH
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is required: https://nodejs.org"; exit 1; }
exec node ditcopy.js start "$@"
