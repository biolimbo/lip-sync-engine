#!/bin/bash
set -e

echo "🔨 Building WASM module..."

# Create build directory if it doesn't exist
mkdir -p build

# Create output directory
mkdir -p dist/wasm

# Configure with Emscripten
cd build
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release
emmake make -j$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
cd ..

echo "✅ WASM build complete!"
echo "   Output: dist/wasm/lip-sync-engine.js, .wasm, .data"
