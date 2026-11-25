#!/bin/bash
# macOS: double click, or run in a terminal. The launcher is ditcopy.js, shared with Linux and Windows.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")" || exit 1
# A downloaded copy carries its own Node in runtime/. A source checkout uses the Node you installed.
NODE=node; [ -x "./runtime/node" ] && NODE="./runtime/node"
command -v "$NODE" >/dev/null || { echo "Node.js is required: https://nodejs.org"; exit 1; }
exec "$NODE" ditcopy.js stop "$@"
