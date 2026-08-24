#!/usr/bin/env bash
# Build the Peckboard project-planner plugin to a WASM module via the Extism
# js-pdk. esbuild bundles the page + src/index.ts -> dist/index.js, then
# extism-js compiles it to dist/plugin.wasm.
#
# Output: dist/plugin.wasm
#
# Requires `extism-js` on PATH and Node/npm.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install
fi

npm run build

WASM="dist/plugin.wasm"
echo "Built: $WASM"
ls -lh "$WASM"
