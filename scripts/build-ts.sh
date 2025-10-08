#!/bin/bash
set -e

echo "🔨 Building TypeScript..."

# Run tsup
npx tsup

echo "✅ TypeScript build complete!"
echo "   Output: dist/index.js, index.mjs, index.d.ts"
