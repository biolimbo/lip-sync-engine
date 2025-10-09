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
// L Blocks UI for 2-3 seconds
const result = await analyze(pcm16);
// UI is frozen during analysis
```

### Solution: Web Workers

Workers run analysis in a separate thread, keeping UI responsive:

```typescript
//  Non-blocking, UI stays responsive
const pool = WorkerPool.getInstance();
await pool.init();
const result = await pool.analyze(pcm16);
// UI remains interactive during analysis
```

### Benefits

| Feature | Main Thread | Web Workers |
|---------|-------------|-------------|
| **UI Responsiveness** | L Freezes |  Responsive |
| **Parallel Processing** | L Sequential |  Parallel |
| **Decoder Reuse** |  Yes |  Yes |
| **Performance (5 chunks)** | ~10-15s | ~2-3s |

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

// Analyze all chunks simultaneously
const results = await pool.analyzeChunks(chunks, {
  dialogText: "Full dialog text for all chunks"
});

console.log(` Processed ${results.length} chunks`);
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

### Single Audio File (5 seconds)

```typescript
// Main Thread: ~2-3s (UI frozen)
const mainThreadResult = await analyze(pcm16);

// Worker: ~2-3s (UI responsive)
const workerResult = await pool.analyze(pcm16);
```

**Winner:** Workers (UI stays responsive)

### Multiple Audio Files (5 files)

```typescript
// Main Thread: ~10-15s sequential
for (const audio of audioFiles) {
  await analyze(audio);
}

// Workers: ~2-3s parallel
const chunks = audioFiles;
await pool.analyzeChunks(chunks);
```

**Winner:** Workers (5x faster with parallelism)

### Performance Table

| Scenario | Main Thread | Workers | Speedup |
|----------|-------------|---------|---------|
| 1 file (5s) | 2-3s (blocked) | 2-3s (non-blocked) | UI responsive |
| 5 files (5s each) | 10-15s | 2-3s | **~5x faster** |
| 10 files (5s each) | 20-30s | 3-5s | **~6-8x faster** |

---

## Framework Integration

### React

```typescript
import { WorkerPool } from 'lip-sync-engine';
import { useState, useEffect } from 'react';

function App() {
  const [pool] = useState(() => WorkerPool.getInstance());
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Initialize on mount
    pool.init().catch(console.error);

    // Cleanup on unmount
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
      {loading && <p>Analyzing (UI stays responsive)...</p>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
```

### Vue

```vue
<script setup lang="ts">
import { WorkerPool } from 'lip-sync-engine';
import { ref, onMounted, onUnmounted } from 'vue';

const pool = WorkerPool.getInstance();
const result = ref(null);
const loading = ref(false);

onMounted(async () => {
  await pool.init();
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
  import { WorkerPool } from 'lip-sync-engine';
  import { onMount, onDestroy } from 'svelte';

  const pool = WorkerPool.getInstance();
  let result = null;
  let loading = false;

  onMount(async () => {
    await pool.init();
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
//  Good: Initialize once, reuse
const pool = WorkerPool.getInstance();
await pool.init();

// Multiple analyses use same pool
await pool.analyze(audio1);
await pool.analyze(audio2);

// L Bad: Don't create multiple pools
const pool1 = WorkerPool.getInstance();
const pool2 = WorkerPool.getInstance(); // Returns same instance
```

### 2. Set Appropriate Worker Count

```typescript
//  Good: Use hardware concurrency
const pool = WorkerPool.getInstance(); // Auto-detects CPU cores

//  Good: Limit workers on low-end devices
const maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 4);
const pool = WorkerPool.getInstance(maxWorkers);

// L Bad: Too many workers waste memory
const pool = WorkerPool.getInstance(100); // Excessive
```

### 3. Clean Up Resources

```typescript
//  Good: Destroy when done
useEffect(() => {
  const pool = WorkerPool.getInstance();
  pool.init();

  return () => {
    pool.destroy(); // Cleanup
  };
}, []);

// L Bad: Memory leak
const pool = WorkerPool.getInstance();
pool.init();
// Never destroyed
```

### 4. Handle Errors

```typescript
//  Good: Error handling
try {
  const result = await pool.analyze(pcm16);
} catch (error) {
  console.error('Analysis failed:', error);
  // Show user-friendly error message
}

// L Bad: Unhandled errors crash app
const result = await pool.analyze(pcm16); // May throw
```

### 5. Monitor Pool Statistics

```typescript
// Check pool health
const stats = pool.getStats();

if (stats.queuedJobs > 10) {
  console.warn('Pool is overloaded, consider increasing maxWorkers');
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
1.  Using `analyzeChunks()` for parallel processing?
2.  Sufficient worker count (check `getStats()`)?
3.  Chunks small enough to distribute?
4.  Dialog text provided for decoder reuse optimization?

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

  // High-end device: use all cores
  return cores;
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
