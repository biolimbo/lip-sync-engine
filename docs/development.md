# Development Guide

Guide for developing and testing LipSync.js locally.

## Prerequisites

- Node.js 18+ and npm
- Emscripten SDK (for building WASM)
- CMake

## Initial Setup

```bash
# Clone the repository
git clone <repository-url>
cd lip-sync-js

# Install dependencies
npm install

# Build the project
npm run build
```

## Development Workflow

### 1. Building the Package

```bash
# Build everything (WASM + TypeScript)
npm run build

# Or build separately:
npm run build:wasm    # Build WASM only
npm run build:ts      # Build TypeScript only
```

### 2. Using npm link for Local Development

The best way to develop and test changes is using `npm link`:

#### Step 1: Link the Package

From the project root:

```bash
# Build the package first
npm run build

# Create a global symlink
npm link
```

#### Step 2: Link in Your Test Project

In your test project or example:

```bash
# Link to the local package
npm link lip-sync-js
```

#### Step 3: Development Loop

```bash
# 1. Make changes to the source
vim src/ts/LipSync.ts

# 2. Rebuild
npm run build

# 3. Test in your linked project
cd ../my-test-project
npm run dev  # Changes are immediately available
```

### 3. Working with Examples

The examples are already configured to use the local package via `"file:../.."`

```bash
# From project root
npm run build

# Run React example
cd examples/react
npm install
npm run dev  # Opens on http://localhost:3000

# Run Vue example
cd examples/vue
npm install
npm run dev  # Opens on http://localhost:3001

# Run Svelte example
cd examples/svelte
npm install
npm run dev  # Opens on http://localhost:3002
```

### 4. Testing Changes

After making changes:

```bash
# 1. Rebuild the package
npm run build

# 2. Examples will automatically pick up changes
# Just refresh your browser (or restart dev server if needed)
```

## Project Structure

```
lip-sync-js/
├── src/
│   ├── cpp/           # C++ source (WASM)
│   └── ts/            # TypeScript wrapper
├── dist/              # Built package
│   ├── wasm/         # WASM artifacts
│   ├── index.js      # CJS bundle
│   ├── index.mjs     # ESM bundle
│   └── index.d.ts    # TypeScript definitions
├── examples/          # Framework examples
├── docs/              # Documentation
└── scripts/           # Build scripts
```

## Build Scripts

### Build WASM (`npm run build:wasm`)

1. Runs CMake with Emscripten
2. Compiles C++ to WebAssembly
3. Outputs to `dist/wasm/`
4. Renames files from `lipsync-wasm.*` to `lip-sync.*`

### Build TypeScript (`npm run build:ts`)

1. Runs tsup bundler
2. Creates CJS, ESM, and type definitions
3. Outputs to `dist/`

## Common Development Tasks

### Adding a New Feature

1. **Add TypeScript API**:
   ```typescript
   // src/ts/LipSync.ts
   async newFeature() {
     // Implementation
   }
   ```

2. **Update Types**:
   ```typescript
   // src/ts/types.ts
   export interface NewFeatureOptions {
     // ...
   }
   ```

3. **Export**:
   ```typescript
   // src/ts/index.ts
   export { newFeature } from './LipSync';
   ```

4. **Build and Test**:
   ```bash
   npm run build
   cd examples/react
   npm run dev
   ```

### Debugging

#### TypeScript Debugging

```typescript
// Add console logs
console.log('Debug:', value);

// Use browser DevTools
// Source maps are included in development builds
```

#### WASM Debugging

```bash
# Build with debug symbols
cd build
emcmake cmake .. -DCMAKE_BUILD_TYPE=Debug
emmake make

# Check WASM output
wasm-objdump -x dist/wasm/lip-sync.wasm
```

## Testing Workflow

### Manual Testing

1. Build the package
2. Link to an example
3. Test in browser DevTools

```bash
npm run build
cd examples/react
npm link lip-sync-js
npm run dev
```

### Testing Different Scenarios

```typescript
// Test with dialog text
await analyze(pcm16, { dialogText: "Hello world" });

// Test without dialog text
await analyze(pcm16);

// Test different sample rates
await analyze(pcm16, { sampleRate: 44100 });
```

## Publishing Workflow

### Pre-publish Checklist

- [ ] All tests passing
- [ ] Documentation updated
- [ ] CHANGELOG updated
- [ ] Version bumped in package.json

### Publishing Steps

```bash
# 1. Build everything
npm run build

# 2. Test the build
npm pack
npm install ./lip-sync-js-1.0.0.tgz

# 3. Create git tag
git tag v1.0.0
git push origin v1.0.0

# 4. GitHub Actions will automatically publish to NPM
```

## Troubleshooting

### Issue: Changes not reflecting

**Solution**: Rebuild and clear node_modules cache

```bash
npm run build
cd examples/react
rm -rf node_modules/.vite
npm run dev
```

### Issue: WASM not loading

**Solution**: Check file paths and ensure files are served

```bash
# Verify files exist
ls dist/wasm/

# Check if served correctly (should see WASM files)
curl http://localhost:3000/dist/wasm/lip-sync.wasm
```

### Issue: TypeScript errors in examples

**Solution**: Rebuild TypeScript definitions

```bash
npm run build:ts
cd examples/react
rm -rf node_modules/lip-sync-js
npm install
```

## Tips

1. **Fast Iteration**: Use `npm run build:ts` if only changing TypeScript (skips slow WASM build)

2. **Multiple Examples**: Run multiple examples simultaneously to test across frameworks

3. **Browser DevTools**: Use React/Vue DevTools extensions for debugging

4. **Hot Reload**: Changes to examples' source code hot reload, but package changes need rebuild

5. **Clean Builds**: If something feels off, do a clean build:
   ```bash
   rm -rf dist build node_modules
   npm install
   npm run build
   ```

## Getting Help

- Check [API Reference](./api-reference.md)
- See [Examples](../examples/)
- Open an issue on GitHub
