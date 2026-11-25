#!/bin/bash
# macOS: double click, or run in a terminal. The launcher is ditcopy.js, shared with Linux and Windows.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Node.js is required: https://nodejs.org"; exit 1; }
exec node ditcopy.js stop "$@"
