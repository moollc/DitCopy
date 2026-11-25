#!/bin/sh
# Linux: run in a terminal. The launcher is ditcopy.js, shared with macOS and Windows.
PATH="$HOME/.cargo/bin:$PATH"; export PATH
cd "$(dirname "$0")" || exit 1
# A downloaded copy carries its own Node in runtime/. A source checkout uses the Node you installed.
NODE=node; [ -x "./runtime/node" ] && NODE="./runtime/node"
command -v "$NODE" >/dev/null 2>&1 || { echo "Node.js is required: https://nodejs.org"; exit 1; }
exec "$NODE" ditcopy.js start "$@"
