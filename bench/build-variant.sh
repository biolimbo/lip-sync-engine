#!/bin/bash
# Build WASM + TS from the working tree and copy dist/ into a variants dir.
# Usage: bench/build-variant.sh <name> [variants_dir]
set -e
name=$1
out=${2:-../lsb-variants}
source ~/.local/share/emsdk/emsdk_env.sh >/dev/null 2>&1 || true
mkdir -p build dist/wasm
(cd build && emcmake cmake .. -DCMAKE_BUILD_TYPE=Release >/dev/null && emmake make -j6 2>&1 | grep -E "error|Error" || true)
npx tsup >/dev/null 2>&1
rm -rf "$out/$name" && mkdir -p "$out/$name" && cp -r dist/* "$out/$name/"
ls -la "$out/$name/wasm"
