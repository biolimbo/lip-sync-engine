# Web Worker Usage Guide

Complete guide for using lip-sync-engine with Web Workers for non-blocking, parallel audio analysis.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Why Use Workers?](#why-use-workers)
3. [Basic Usage](#basic-usage)
4. [Chunked Processing](#chunked-processing)
5. [Performance Comparison](#performance-comparison)
6. [Framework Integration](#framework-integration)
7. [Best Practices](#best-practices)
8. [Troubleshooting](#troubleshooting)

---

## Quick Start

```typescript
import { WorkerPool } from 'lip-sync-engine';

// Initialize worker pool
const pool = WorkerPool.getInstance();
await pool.init();

// Analyze without blocking UI
const result = await pool.analyze(pcm16, {
  dialogText: "Hello world"
});

console.log(result.mouthCues);
```

---

## Why Use Workers?

### Problem: UI Blocking

Without workers, audio analysis runs on the main thread, freezing the UI:

```typescript
// Blocks the UI while the analysis runs
const result = await analyze(pcm16);
// UI is frozen during analysis
```

### Solution: Web Workers

Workers run analysis in a separate thread, keeping UI responsive:

```typescript
// Non-blocking, UI stays responsive
const pool = WorkerPool.getInstance();
await pool.init();
const result = await pool.analyze(pcm16);
// UI remains interactive during analysis
```

### Benefits

| Feature | Main Thread | Web Workers |
|---------|-------------|-------------|
| **UI Responsiveness** | Freezes | Responsive |
| **Parallel Processing** | Sequential | Parallel |
| **Decoder Reuse** | Yes | Yes |

---

## Basic Usage

### 1. Initialize Worker Pool

```typescript
import { WorkerPool } from 'lip-sync-engine';

const pool = WorkerPool.getInstance();

// Configure paths (optional, uses defaults)
await pool.init({
  wasmPath: '/dist/wasm/lip-sync-engine.wasm',
  dataPath: '/dist/wasm/lip-sync-engine.data',
  jsPath: '/dist/wasm/lip-sync-engine.js',
  workerScriptUrl: '/dist/worker.js'
});
```

### 2. Analyze Audio

```typescript
// Single audio analysis
const result = await pool.analyze(pcm16, {
  dialogText: "Hello world",
  sampleRate: 16000
});

// Use the results
result.mouthCues.forEach(cue => {
  console.log(`${cue.start}s - ${cue.end}s: ${cue.value}`);
});
```

### 3. Cleanup

```typescript
// When done, destroy the pool
pool.destroy();
```

---

## Chunked Processing

Process large audio files by splitting into chunks and analyzing in parallel.

### Split Audio into Chunks

```typescript
function splitAudioIntoChunks(
  audio: Int16Array,
  chunkDurationSeconds: number,
  sampleRate: number = 16000
): Int16Array[] {
  const chunkSize = chunkDurationSeconds * sampleRate;
  const chunks: Int16Array[] = [];

  for (let i = 0; i < audio.length; i += chunkSize) {
    const chunk = audio.slice(i, Math.min(i + chunkSize, audio.length));
    chunks.push(chunk);
  }

  return chunks;
}
```

### Process Chunks in Parallel

```typescript
// Split 30-second audio into 5-second chunks
const chunks = splitAudioIntoChunks(fullAudio, 5, 16000);
console.log(`Processing ${chunks.length} chunks in parallel...`);

// Start all workers (init() starts only one), then analyze the chunks in parallel
await pool.warmup();
const results = await pool.analyzeChunks(chunks, {
  dialogText: "Full dialog text for all chunks"
});

console.log(`Processed ${results.length} chunks`);
```

### Combine Results

```typescript
// Method 1: Flatten all mouth cues
const allCues = results.flatMap((result, index) => {
  const chunkOffset = index * 5; // 5 seconds per chunk
  return result.mouthCues.map(cue => ({
    ...cue,
    start: cue.start + chunkOffset,
    end: cue.end + chunkOffset
  }));
});

// Method 2: Process results individually
results.forEach((result, index) => {
  console.log(`Chunk ${index + 1}:`, result.mouthCues.length, 'cues');
});
```

---

## Performance Comparison

Once a worker's decoder is built, analysis costs about 0.2 to 0.4 s of CPU per second of audio (see `BENCHMARK.md`). The cost is the same on the main thread and in a worker; the difference is that workers keep the UI responsive. Batches run in parallel across the workers started by `warmup()`, limited by CPU cores.

---

## Framework Integration

### React

```typescript
import { WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';
import type { LipSyncEngineResult } from 'lip-sync-engine';
import { useState, useEffect, useRef } from 'react';

function App() {
  const poolRef = useRef<WorkerPool | null>(null);
  const [result, setResult] = useState<LipSyncEngineResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Get the pool inside the effect, so a remount after cleanup gets a fresh one
    const pool = WorkerPool.getInstance();
    poolRef.current = pool;

    pool.init().catch(error => {
      // destroy() in cleanup cancels a startup that is still running
      if (!(error instanceof WorkerPoolDestroyedError)) console.error(error);
    });

    // Cleanup on unmount
    return () => pool.destroy();
  }, []);

  const handleAnalyze = async (pcm16: Int16Array) => {
    if (!poolRef.current) return;
    setLoading(true);
    try {
      const result = await poolRef.current.analyze(pcm16, {
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
      {loading && <p>Analyzing (UI stays responsive)...</p>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
```

### Vue

```vue
<script setup lang="ts">
import { WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';
import type { LipSyncEngineResult } from 'lip-sync-engine';
import { ref, onMounted, onUnmounted } from 'vue';

const pool = WorkerPool.getInstance();
const result = ref<LipSyncEngineResult | null>(null);
const loading = ref(false);

onMounted(() => {
  // Unmounting during startup rejects init() with WorkerPoolDestroyedError
  pool.init().catch(error => {
    if (!(error instanceof WorkerPoolDestroyedError)) console.error(error);
  });
});

onUnmounted(() => {
  pool.destroy();
});

async function handleAnalyze(pcm16: Int16Array) {
  loading.value = true;
  try {
    result.value = await pool.analyze(pcm16, {
      dialogText: "Hello world"
    });
  } catch (error) {
    console.error('Analysis failed:', error);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div>
    <p v-if="loading">Analyzing (UI stays responsive)...</p>
    <pre v-if="result">{{ result }}</pre>
  </div>
</template>
```

### Svelte

```svelte
<script lang="ts">
  import { WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';
  import type { LipSyncEngineResult } from 'lip-sync-engine';
  import { onMount, onDestroy } from 'svelte';

  const pool = WorkerPool.getInstance();
  let result: LipSyncEngineResult | null = null;
  let loading = false;

  onMount(() => {
    // Unmounting during startup rejects init() with WorkerPoolDestroyedError
    pool.init().catch(error => {
      if (!(error instanceof WorkerPoolDestroyedError)) console.error(error);
    });
  });

  onDestroy(() => {
    pool.destroy();
  });

  async function handleAnalyze(pcm16: Int16Array) {
    loading = true;
    try {
      result = await pool.analyze(pcm16, {
        dialogText: "Hello world"
      });
    } catch (error) {
      console.error('Analysis failed:', error);
    } finally {
      loading = false;
    }
  }
</script>

{#if loading}
  <p>Analyzing (UI stays responsive)...</p>
{/if}

{#if result}
  <pre>{JSON.stringify(result, null, 2)}</pre>
{/if}
```

---

## Best Practices

### 1. Initialize Once

```typescript
// Good: Initialize once, reuse
const pool = WorkerPool.getInstance();
await pool.init();

// Multiple analyses use same pool
await pool.analyze(audio1);
await pool.analyze(audio2);

// Bad: Don't create multiple pools
const pool1 = WorkerPool.getInstance();
const pool2 = WorkerPool.getInstance(); // Returns same instance
```

### 2. Set Appropriate Worker Count

Each worker holds its own copy of the speech models (about 115 MB once warm). For streaming speech, one or two workers keep up with real time (see `BENCHMARK.md`); more workers mostly cost memory.

```typescript
// Good for streaming speech, especially on tablets and kiosks
const pool = WorkerPool.getInstance(2);

// Batch processing of many files on a desktop can use more
const pool = WorkerPool.getInstance(Math.min(navigator.hardwareConcurrency || 4, 4));
```

Keep the pool alive between utterances. Since 2.0.0 each worker builds its speech decoder once and reuses it; destroying the pool throws that work away.

### 3. Clean Up Resources

```typescript
// Good: Destroy when done
useEffect(() => {
  const pool = WorkerPool.getInstance();
  pool.init().catch(error => {
    if (!(error instanceof WorkerPoolDestroyedError)) console.error(error);
  });

  return () => {
    pool.destroy(); // Cleanup (only when the app is done with lip-sync for good)
  };
}, []);

// Bad: Memory leak
const pool = WorkerPool.getInstance();
pool.init();
// Never destroyed
```

### 4. Handle Errors

```typescript
// Good: Error handling
try {
  const result = await pool.analyze(pcm16);
} catch (error) {
  console.error('Analysis failed:', error);
  // Show user-friendly error message
}

// Bad: Unhandled errors crash app
const result = await pool.analyze(pcm16); // May throw
```

### 5. Monitor Pool Statistics

```typescript
// Check pool health
const stats = pool.getStats();

if (stats.queuedJobs > 10) {
  console.warn('Pool is overloaded: call warmup() if only one worker has started, or create the pool with a larger maxWorkers (set at the first getInstance() call)');
}

console.log(`Workers: ${stats.busyWorkers}/${stats.totalWorkers} busy`);
```

---

## Troubleshooting

### Worker Script Not Found

**Error:** `Failed to construct 'Worker': Script at 'file://...' cannot be accessed`

**Solution:** Serve files via HTTP server, not `file://` protocol

```bash
# Use a local server
npx serve .
# or
python -m http.server 8000
```

### CORS Issues

**Error:** `Cross-Origin Request Blocked`

**Solution:** Ensure all files (worker.js, WASM, data) are served from same origin

```typescript
// Configure paths to same origin
await pool.init({
  wasmPath: '/dist/wasm/lip-sync-engine.wasm', // Same origin
  dataPath: '/dist/wasm/lip-sync-engine.data',
  jsPath: '/dist/wasm/lip-sync-engine.js',
  workerScriptUrl: '/dist/worker.js' // Same origin
});
```

### Memory Issues

**Error:** `Out of memory`

**Solution:** Reduce worker count or chunk size

```typescript
// Reduce workers
const pool = WorkerPool.getInstance(2); // Instead of 8

// Smaller chunks
const chunks = splitAudioIntoChunks(audio, 3); // 3s instead of 5s
```

### Worker Initialization Fails

**Error:** `Worker initialization failed`

**Solution:** Check WASM paths and ensure files exist

```typescript
// Verify paths
await pool.init({
  wasmPath: '/dist/wasm/lip-sync-engine.wasm', // Check this exists
  dataPath: '/dist/wasm/lip-sync-engine.data',
  jsPath: '/dist/wasm/lip-sync-engine.js',
  workerScriptUrl: '/dist/worker.js'
});
```

### Slow Performance

**Issue:** Workers not faster than main thread

**Checklist:**
1. Using `analyzeChunks()` for parallel processing?
2. Sufficient worker count (check `getStats()`)?
3. Chunks small enough to distribute?
4. Pool kept alive between utterances (decoders are reused since 2.0.0)?
5. Called `warmup()` (`init()` starts only one worker)?

---

## Advanced Usage

### Custom Worker Count Based on Device

```typescript
function getOptimalWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (performance as any).memory?.jsHeapSizeLimit || 0;

  // Low memory device: fewer workers
  if (memory > 0 && memory < 1e9) { // <1GB
    return Math.min(cores, 2);
  }

  // Streaming speech needs only one or two workers; batch jobs can use a few more
  return Math.min(cores, 4);
}

const pool = WorkerPool.getInstance(getOptimalWorkerCount());
```

### Progress Tracking

```typescript
// Track progress for chunked processing
const chunks = splitAudioIntoChunks(audio, 5);
let completed = 0;

const promises = chunks.map(async (chunk, index) => {
  const result = await pool.analyze(chunk);
  completed++;
  console.log(`Progress: ${Math.round(completed / chunks.length * 100)}%`);
  return result;
});

const results = await Promise.all(promises);
```

### Graceful Degradation

```typescript
// Fallback to main thread if workers fail
async function analyzeWithFallback(pcm16: Int16Array) {
  try {
    const pool = WorkerPool.getInstance();
    await pool.init();
    return await pool.analyze(pcm16);
  } catch (error) {
    console.warn('Workers failed, falling back to main thread:', error);
    return await analyze(pcm16); // Main thread fallback
  }
}
```

---

## See Also

- [API Reference](./api-reference.md) - Complete API documentation
- [Getting Started](./getting-started.md) - Basic usage guide
- [Streaming Analysis](./streaming-analysis.md) - Real-time chunk processing

---

**Works with all bundlers** - Vite, Webpack, Rollup, esbuild, etc. No configuration needed, just call `pool.init()` and you're ready to go!
