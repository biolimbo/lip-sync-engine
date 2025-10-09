# Using lip-sync-engine with Vite

Complete guide for integrating lip-sync-engine Web Workers in Vite projects.

## Quick Setup

Vite has excellent built-in Web Worker support. Minimal configuration required!

### 1. Install Package

```bash
npm install lip-sync-engine
```

### 2. Configure Vite

**`vite.config.ts`:**

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  // Worker configuration
  worker: {
    format: 'es', // ESM format for workers
  },

  // Optimize dependencies
  optimizeDeps: {
    exclude: ['lip-sync-engine'], // Don't pre-bundle WASM
  },

  // Serve WASM files
  assetsInclude: ['**/*.wasm', '**/*.data'],
});
```

### 3. Copy WASM Files to Public Directory

**Option A: Manual Copy**

```bash
# Copy WASM files to public directory
cp node_modules/lip-sync-engine/dist/wasm/* public/wasm/
cp node_modules/lip-sync-engine/dist/worker.js public/
```

**Option B: Build Script**

Add to `package.json`:

```json
{
  "scripts": {
    "postinstall": "mkdir -p public/wasm && cp node_modules/lip-sync-engine/dist/wasm/* public/wasm/ && cp node_modules/lip-sync-engine/dist/worker.js public/"
  }
}
```

**Option C: Vite Plugin (Recommended)**

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

function copyLipSyncEngineAssets() {
  return {
    name: 'copy-lip-sync-engine-assets',
    buildStart() {
      const publicDir = 'public';
      const wasmDir = join(publicDir, 'wasm');

      // Create directories
      mkdirSync(wasmDir, { recursive: true });

      // Copy WASM files
      const srcDir = 'node_modules/lip-sync-engine/dist';
      copyFileSync(
        join(srcDir, 'wasm/lip-sync-engine.wasm'),
        join(wasmDir, 'lip-sync-engine.wasm')
      );
      copyFileSync(
        join(srcDir, 'wasm/lip-sync-engine.data'),
        join(wasmDir, 'lip-sync-engine.data')
      );
      copyFileSync(
        join(srcDir, 'wasm/lip-sync-engine.js'),
        join(wasmDir, 'lip-sync-engine.js')
      );
      copyFileSync(
        join(srcDir, 'worker.js'),
        join(publicDir, 'worker.js')
      );
    },
  };
}

export default defineConfig({
  plugins: [copyLipSyncEngineAssets()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['lip-sync-engine'],
  },
});
```

---

## Usage in React + Vite

### Basic Example

```typescript
// src/App.tsx
import { WorkerPool } from 'lip-sync-engine';
import { useState, useEffect } from 'react';

function App() {
  const [pool] = useState(() => WorkerPool.getInstance());
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Initialize worker pool
    pool.init({
      wasmPath: '/wasm/lip-sync-engine.wasm',
      dataPath: '/wasm/lip-sync-engine.data',
      jsPath: '/wasm/lip-sync-engine.js',
      workerScriptUrl: '/worker.js'
    }).catch(console.error);

    // Cleanup
    return () => pool.destroy();
  }, [pool]);

  const handleAnalyze = async (pcm16: Int16Array) => {
    setLoading(true);
    try {
      const result = await pool.analyze(pcm16, {
        dialogText: "Hello world"
      });
      setResult(result);
    } catch (error) {
      console.error('Analysis failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Lip Sync Engine - Vite + React</h1>
      {loading && <p>Analyzing...</p>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}

export default App;
```

### Custom Hook

```typescript
// src/hooks/useLipSyncEngine.ts
import { WorkerPool } from 'lip-sync-engine';
import { useState, useEffect, useCallback } from 'react';
import type { LipSyncEngineResult, LipSyncEngineOptions } from 'lip-sync-engine';

export function useLipSyncEngine() {
  const [pool] = useState(() => WorkerPool.getInstance());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    pool.init({
      wasmPath: '/wasm/lip-sync-engine.wasm',
      dataPath: '/wasm/lip-sync-engine.data',
      jsPath: '/wasm/lip-sync-engine.js',
      workerScriptUrl: '/worker.js'
    }).catch(setError);

    return () => pool.destroy();
  }, [pool]);

  const analyze = useCallback(async (
    pcm16: Int16Array,
    options?: LipSyncEngineOptions
  ): Promise<LipSyncEngineResult | null> => {
    setLoading(true);
    setError(null);

    try {
      const result = await pool.analyze(pcm16, options);
      return result;
    } catch (err) {
      setError(err as Error);
      return null;
    } finally {
      setLoading(false);
    }
  }, [pool]);

  const stats = useCallback(() => pool.getStats(), [pool]);

  return {
    analyze,
    stats,
    loading,
    error,
  };
}
```

**Usage:**

```typescript
import { useLipSyncEngine } from './hooks/useLipSyncEngine';

function App() {
  const { analyze, loading, error } = useLipSyncEngine();

  const handleAnalyze = async (pcm16: Int16Array) => {
    const result = await analyze(pcm16, {
      dialogText: "Hello world"
    });
    console.log(result);
  };

  return (
    <div>
      {loading && <p>Processing...</p>}
      {error && <p>Error: {error.message}</p>}
    </div>
  );
}
```

---

## Usage in Vue + Vite

### Basic Example

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { WorkerPool } from 'lip-sync-engine';
import { ref, onMounted, onUnmounted } from 'vue';

const pool = WorkerPool.getInstance();
const result = ref(null);
const loading = ref(false);
const error = ref(null);

onMounted(async () => {
  try {
    await pool.init({
      wasmPath: '/wasm/lip-sync-engine.wasm',
      dataPath: '/wasm/lip-sync-engine.data',
      jsPath: '/wasm/lip-sync-engine.js',
      workerScriptUrl: '/worker.js'
    });
  } catch (err) {
    error.value = err.message;
  }
});

onUnmounted(() => {
  pool.destroy();
});

async function handleAnalyze(pcm16: Int16Array) {
  loading.value = true;
  error.value = null;

  try {
    result.value = await pool.analyze(pcm16, {
      dialogText: "Hello world"
    });
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div>
    <h1>Lip Sync Engine - Vite + Vue</h1>
    <p v-if="loading">Analyzing...</p>
    <p v-if="error">Error: {{ error }}</p>
    <pre v-if="result">{{ result }}</pre>
  </div>
</template>
```

### Composable

```typescript
// src/composables/useLipSyncEngine.ts
import { WorkerPool } from 'lip-sync-engine';
import { ref, onMounted, onUnmounted } from 'vue';
import type { LipSyncEngineResult, LipSyncEngineOptions } from 'lip-sync-engine';

export function useLipSyncEngine() {
  const pool = WorkerPool.getInstance();
  const loading = ref(false);
  const error = ref<Error | null>(null);

  onMounted(async () => {
    try {
      await pool.init({
        wasmPath: '/wasm/lip-sync-engine.wasm',
        dataPath: '/wasm/lip-sync-engine.data',
        jsPath: '/wasm/lip-sync-engine.js',
        workerScriptUrl: '/worker.js'
      });
    } catch (err) {
      error.value = err as Error;
    }
  });

  onUnmounted(() => {
    pool.destroy();
  });

  async function analyze(
    pcm16: Int16Array,
    options?: LipSyncEngineOptions
  ): Promise<LipSyncEngineResult | null> {
    loading.value = true;
    error.value = null;

    try {
      return await pool.analyze(pcm16, options);
    } catch (err) {
      error.value = err as Error;
      return null;
    } finally {
      loading.value = false;
    }
  }

  function stats() {
    return pool.getStats();
  }

  return {
    analyze,
    stats,
    loading,
    error,
  };
}
```

---

## Usage in Svelte + Vite

### Basic Example

```svelte
<!-- src/App.svelte -->
<script lang="ts">
  import { WorkerPool } from 'lip-sync-engine';
  import { onMount, onDestroy } from 'svelte';

  const pool = WorkerPool.getInstance();
  let result = null;
  let loading = false;
  let error = null;

  onMount(async () => {
    try {
      await pool.init({
        wasmPath: '/wasm/lip-sync-engine.wasm',
        dataPath: '/wasm/lip-sync-engine.data',
        jsPath: '/wasm/lip-sync-engine.js',
        workerScriptUrl: '/worker.js'
      });
    } catch (err) {
      error = err.message;
    }
  });

  onDestroy(() => {
    pool.destroy();
  });

  async function handleAnalyze(pcm16: Int16Array) {
    loading = true;
    error = null;

    try {
      result = await pool.analyze(pcm16, {
        dialogText: "Hello world"
      });
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<div>
  <h1>Lip Sync Engine - Vite + Svelte</h1>
  {#if loading}
    <p>Analyzing...</p>
  {/if}
  {#if error}
    <p>Error: {error}</p>
  {/if}
  {#if result}
    <pre>{JSON.stringify(result, null, 2)}</pre>
  {/if}
</div>
```

---

## Troubleshooting

### Worker Script Not Found

**Error:** `Failed to load worker script`

**Solution:** Ensure worker.js is in public directory and accessible at `/worker.js`

```bash
# Verify file exists
ls public/worker.js

# Check browser network tab for 404 errors
```

### WASM Files Not Loading

**Error:** `Failed to load WASM module`

**Solution:** Check file paths and ensure files are copied to public directory

```typescript
// Double-check paths match file locations
await pool.init({
  wasmPath: '/wasm/lip-sync-engine.wasm', // Must exist at public/wasm/lip-sync-engine.wasm
  dataPath: '/wasm/lip-sync-engine.data',
  jsPath: '/wasm/lip-sync-engine.js',
  workerScriptUrl: '/worker.js' // Must exist at public/worker.js
});
```

### Development vs Production

**Issue:** Works in dev, fails in production

**Solution:** Ensure files are included in build output

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    // Ensure WASM files are copied to dist
    rollupOptions: {
      external: ['*.wasm', '*.data'],
    },
  },
  // Make sure assetsInclude is set
  assetsInclude: ['**/*.wasm', '**/*.data'],
});
```

### Module Type Errors

**Error:** `Cannot use import statement outside a module`

**Solution:** Ensure worker format is 'es'

```typescript
export default defineConfig({
  worker: {
    format: 'es', // Not 'iife'
  },
});
```

---

## Production Deployment

### 1. Build

```bash
npm run build
```

### 2. Verify Output

Check `dist/` directory contains:
- `wasm/lip-sync-engine.wasm`
- `wasm/lip-sync-engine.data`
- `wasm/lip-sync-engine.js`
- `worker.js`

### 3. Server Configuration

Ensure proper MIME types for WASM files:

**Nginx:**
```nginx
types {
  application/wasm wasm;
}
```

**Apache (.htaccess):**
```apache
AddType application/wasm .wasm
```

### 4. CDN Considerations

If using a CDN, ensure all files are uploaded:
- Main app bundle
- WASM files
- Worker script

Update paths accordingly:

```typescript
await pool.init({
  wasmPath: 'https://cdn.example.com/wasm/lip-sync-engine.wasm',
  dataPath: 'https://cdn.example.com/wasm/lip-sync-engine.data',
  jsPath: 'https://cdn.example.com/wasm/lip-sync-engine.js',
  workerScriptUrl: 'https://cdn.example.com/worker.js'
});
```

---

## Next Steps

- [Worker Usage Guide](../worker-usage.md) - Complete worker documentation
- [API Reference](../api-reference.md) - Full API docs
- [Examples](../../examples/) - Complete working examples

---

**Need help?** [Open an issue](https://github.com/biolimbo/lip-sync-engine/issues)
