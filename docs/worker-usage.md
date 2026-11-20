# Web Worker Usage Guide

How to run lip-sync-engine analysis in Web Workers with `WorkerPool`, so the page stays responsive and independent jobs run in parallel. For every method and option, see the [API Reference](./api-reference.md#workerpool).

## Table of Contents

1. [Quick Start](#quick-start)
2. [Why Use Workers?](#why-use-workers)
3. [Pool Lifecycle and Sizing](#pool-lifecycle-and-sizing)
4. [Basic Usage](#basic-usage)
5. [Chunked Processing](#chunked-processing)
6. [Framework Integration](#framework-integration)
7. [Best Practices](#best-practices)
8. [Troubleshooting](#troubleshooting)
9. [Advanced Usage](#advanced-usage)
10. [See Also](#see-also)

---

## Quick Start

```typescript
import { WorkerPool, loadAudio } from 'lip-sync-engine';

// One pool for the whole session. Pass a worker count: the default is
// navigator.hardwareConcurrency (or 4), and each warm worker uses about 115 MB.
const pool = WorkerPool.getInstance(2);
await pool.init(); // starts one worker

const { pcm16 } = await loadAudio('/speech.wav'); // 16 kHz mono Int16Array
const result = await pool.analyze(pcm16, { dialogText: 'Hello world' });

console.log(result.mouthCues);
```

---

## Why Use Workers?

`analyze()` runs on the main thread, so the page cannot render or respond to input until it returns. `WorkerPool`, and `analyzeAsync()`, which uses it, run the same analysis in Web Workers: the page stays responsive, and independent jobs run in parallel, one per started worker, limited by the CPU cores. The analysis costs the same CPU either way: about 0.2 to 0.4 s per second of audio once a worker's speech decoder is built ([BENCHMARK.md](../BENCHMARK.md)).

---

## Pool Lifecycle and Sizing

### Keep the Pool for the Session

Create the pool once, when the app first needs lip sync, and reuse it for every utterance. Each worker builds its speech decoder (about 0.5 s of CPU) during `init()`/`warmup()` and keeps it, so a warm pool returns the first cues of a new utterance in about 0.1 s. Destroying and re-creating the pool per utterance pays the start-up cost again every time. Call `pool.destroy()` only when the app is done with lip sync for good, for example on app teardown.

- `init()` starts one worker.
- `warmup()` (after `init()` resolves) starts the rest, up to `maxWorkers`. The pool never adds workers on demand, so call `warmup()` before any parallel work (chunked jobs, or streams with more than one analysis at a time).
- A call to `init()` or `warmup()` while one is already running shares it and ignores new options. Once the pool has started, `init()` returns at once.

### Choose a Worker Count

`WorkerPool.getInstance(maxWorkers?, workerScriptUrl?)` defaults `maxWorkers` to `navigator.hardwareConcurrency || 4`. Always pass a small explicit count instead:

- **Streaming speech:** 1 or 2. A warm worker analyzes a 250 ms chunk in about 70 to 100 ms, so one or two workers keep up with real time. Two match the stream analyzer's default `maxConcurrent` of 2. Use 1 on very weak devices.
- **Chunked jobs (pre-recorded audio):** up to 4, and no more than the CPU cores.

More workers mostly cost memory, and they make a fresh pool slower to start because every worker builds its decoder at the same time (see [BENCHMARK.md](../BENCHMARK.md)).

To choose by device, combine the core count with `navigator.deviceMemory` (approximate device RAM in GB; not available in every browser):

```typescript
import { WorkerPool } from 'lip-sync-engine';

function workerCountForDevice(): number {
  const cores = navigator.hardwareConcurrency || 4;
  // deviceMemory is not in every browser (or in TypeScript's DOM types)
  const memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  if (memoryGb !== undefined && memoryGb <= 2) return 1; // low-memory device
  return Math.min(cores, 2); // use Math.min(cores, 4) for chunked jobs
}

const pool = WorkerPool.getInstance(workerCountForDevice());
```

### Memory

- A warm worker uses about **115 MB**.
- That includes its own copy of the **39 MB** model file. After the first worker downloads it, later workers normally read it from the browser's HTTP cache.
- With `shareAssets: true` (the default), the `.wasm` file is compiled once and the compiled module is shared with later workers.
- `pool.getMemoryStats()` reports the WebAssembly memory each worker has reserved (at least 128 MiB each), which can be more than it actually uses. Use it to watch for growth, not to measure total memory (see [`getMemoryStats()`](./api-reference.md#getmemorystats)).

To use less memory, see [Memory Issues](#memory-issues).

### One Pool per Page

`WorkerPool.getInstance()` returns a singleton. Its arguments apply only when it creates the pool, and later calls return the same pool, whatever they pass:

```typescript
import { WorkerPool } from 'lip-sync-engine';

const first = WorkerPool.getInstance(2);
const second = WorkerPool.getInstance(8); // same pool, still 2 workers
console.log(first === second); // true
```

Decide the worker count (and `workerScriptUrl`, if you self-host) in one place, before any other code calls `getInstance()`. That includes `analyzeAsync()`, which calls `getInstance()` without arguments. After `destroy()`, the next `getInstance()` call creates a new pool with new arguments.

---

## Basic Usage

### 1. Initialize the Worker Pool

```typescript
import { WorkerPool } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(2);

// With no paths, the worker script and WASM files load from
// https://unpkg.com/lip-sync-engine@<installed version>/dist/...
await pool.init();
```

To serve the files yourself, pass `wasmPath`, `dataPath`, `jsPath`, and `workerScriptUrl` to `init()`. See [Self-Hosting the WASM Files](./getting-started.md#self-hosting-the-wasm-files).

### 2. Analyze Audio

```typescript
import { WorkerPool, loadAudio } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(2);
await pool.init();

const { pcm16 } = await loadAudio('/speech.wav');
const result = await pool.analyze(pcm16, {
  dialogText: 'Hello world',
  sampleRate: 16000
});

result.mouthCues.forEach(cue => {
  console.log(`${cue.start}s to ${cue.end}s: ${cue.value}`);
});
```

`analyze()` copies your buffer before sending it to a worker, so your array stays usable.

### 3. Clean Up

```typescript
import type { WorkerPool } from 'lip-sync-engine';

declare const pool: WorkerPool; // the pool from the steps above

// Only when the app is done with lip sync (for example on app teardown)
pool.destroy();
```

Pending `init()`, `warmup()`, and analysis promises then reject with [`WorkerPoolDestroyedError`](./api-reference.md#workerpooldestroyederror).

---

## Chunked Processing

`analyzeChunks()` analyzes several buffers in parallel, one per started worker, and returns the results in input order.

Each chunk is analyzed on its own, without the audio around it, so recognition loses context at every chunk boundary. Quality drops for short chunks: on real speech, 250 ms chunks analyzed alone matched only about a third of the frames of a whole-utterance analysis, and 1000 ms chunks about two thirds ([BENCHMARK.md](../BENCHMARK.md)). Use chunks of several seconds, ideally split at pauses, or analyze the whole recording in one call. For audio that arrives over time, use the [stream analyzer](./streaming-analysis.md) with [context and lookahead](./streaming-analysis.md#context-and-lookahead) instead.

### Split Audio into Chunks

```typescript
function splitAudioIntoChunks(
  audio: Int16Array,
  chunkDurationSeconds: number,
  sampleRate: number = 16000
): Int16Array[] {
  const chunkSize = Math.round(chunkDurationSeconds * sampleRate);
  const chunks: Int16Array[] = [];

  for (let i = 0; i < audio.length; i += chunkSize) {
    chunks.push(audio.slice(i, Math.min(i + chunkSize, audio.length)));
  }

  return chunks;
}
```

### Process Chunks in Parallel

```typescript
import { WorkerPool, loadAudio } from 'lip-sync-engine';

// From Split Audio into Chunks above
declare function splitAudioIntoChunks(audio: Int16Array, chunkDurationSeconds: number, sampleRate?: number): Int16Array[];

const pool = WorkerPool.getInstance(4);
await pool.init();
await pool.warmup(); // init() starts only one worker; this starts the other three

const { pcm16 } = await loadAudio('/long-recording.wav');
const chunks = splitAudioIntoChunks(pcm16, 5, 16000); // 5-second chunks

const results = await pool.analyzeChunks(chunks, {
  dialogText: 'Full transcript of the recording'
});
console.log(`Analyzed ${results.length} chunks`);
```

The same `dialogText` applies to every chunk, so each chunk is recognized against the whole transcript, including words it does not contain. Giving each chunk its own text is possible with one `pool.analyze(chunk, { dialogText })` call per chunk, but it is slow: each worker keeps one decoder for the most recent dialog text and builds a new one (about 0.5 s of CPU) whenever the text changes, so per-chunk text rebuilds the decoder for every chunk. The decoders built at start-up have no dialog text, so even one shared text costs one decoder build per worker.

### Combine Results

Cue times in each result start at 0 at the start of its chunk. Add each chunk's start time, computed from the chunk lengths (the last chunk is usually shorter):

```typescript
import type { LipSyncEngineResult, MouthCue } from 'lip-sync-engine';

// From Process Chunks in Parallel above
declare const results: LipSyncEngineResult[];
declare const chunks: Int16Array[];

function combineCues(
  results: LipSyncEngineResult[],
  chunks: Int16Array[],
  sampleRate: number = 16000
): MouthCue[] {
  let offset = 0; // seconds
  return results.flatMap((result, index) => {
    const cues = result.mouthCues.map(cue => ({
      ...cue,
      start: cue.start + offset,
      end: cue.end + offset
    }));
    offset += chunks[index].length / sampleRate;
    return cues;
  });
}

const allCues = combineCues(results, chunks);
```

---

## Framework Integration

General framework setup is in [Getting Started](./getting-started.md#framework-integration). The snippets below show the pool-specific parts: the pool lives for the whole app, is created only in the browser (never during server-side rendering), and components wait until it is ready.

Create the pool in one shared module:

```typescript
// lipSyncPool.ts
import { WorkerPool } from 'lip-sync-engine';

let poolPromise: Promise<WorkerPool> | null = null;

/** The app's pool, created and started on first use. Call only in the browser. */
export function getPool(): Promise<WorkerPool> {
  if (!poolPromise) {
    const pool = WorkerPool.getInstance(2);
    // A failed start is kept: reload the page to retry
    poolPromise = pool.init().then(() => pool);
  }
  return poolPromise;
}

/** Call only when the app is done with lip sync (for example on app teardown) */
export function destroyPool(): void {
  poolPromise = null;
  WorkerPool.getInstance().destroy();
}
```

Components get the pool in a mount hook (which does not run during server-side rendering) and do not destroy it on unmount.

### React

```tsx
// LipSyncButton.tsx
import { useEffect, useState } from 'react';
import type { LipSyncEngineResult, WorkerPool } from 'lip-sync-engine';
import { getPool } from './lipSyncPool';

export function LipSyncButton({ audio, dialogText }: { audio: Int16Array; dialogText?: string }) {
  const [pool, setPool] = useState<WorkerPool | null>(null);
  const [result, setResult] = useState<LipSyncEngineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getPool().then(
      ready => { if (mounted) setPool(ready); },
      (startError: unknown) => {
        if (mounted) setError(startError instanceof Error ? startError.message : String(startError));
      }
    );
    // The pool is shared by the whole app, so unmounting does not destroy it
    return () => { mounted = false; };
  }, []);

  const handleAnalyze = async () => {
    if (!pool) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await pool.analyze(audio, { dialogText }));
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : String(analyzeError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={handleAnalyze} disabled={!pool || loading}>
        {pool ? 'Analyze' : 'Loading...'}
      </button>
      {loading && <p>Analyzing (the page stays responsive)...</p>}
      {error && <p>{error}</p>}
      {result && <p>{result.mouthCues.length} mouth cues</p>}
    </div>
  );
}
```

### Vue

```vue
<script setup lang="ts">
import { ref, shallowRef, onMounted } from 'vue';
import type { LipSyncEngineResult, WorkerPool } from 'lip-sync-engine';
import { getPool } from './lipSyncPool';

const props = defineProps<{ audio: Int16Array; dialogText?: string }>();

const pool = shallowRef<WorkerPool | null>(null);
const result = ref<LipSyncEngineResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// onMounted runs only in the browser, so server-side rendering never starts workers
onMounted(async () => {
  try {
    pool.value = await getPool();
  } catch (startError) {
    error.value = startError instanceof Error ? startError.message : String(startError);
  }
});

async function handleAnalyze() {
  if (!pool.value) return;
  loading.value = true;
  error.value = null;
  try {
    result.value = await pool.value.analyze(props.audio, { dialogText: props.dialogText });
  } catch (analyzeError) {
    error.value = analyzeError instanceof Error ? analyzeError.message : String(analyzeError);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div>
    <button :disabled="!pool || loading" @click="handleAnalyze">
      {{ pool ? 'Analyze' : 'Loading...' }}
    </button>
    <p v-if="loading">Analyzing (the page stays responsive)...</p>
    <p v-if="error">{{ error }}</p>
    <p v-if="result">{{ result.mouthCues.length }} mouth cues</p>
  </div>
</template>
```

### Svelte

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import type { LipSyncEngineResult, WorkerPool } from 'lip-sync-engine';
  import { getPool } from './lipSyncPool';

  export let audio: Int16Array;
  export let dialogText: string | undefined = undefined;

  let pool: WorkerPool | null = null;
  let result: LipSyncEngineResult | null = null;
  let loading = false;
  let error: string | null = null;

  // onMount runs only in the browser, so server-side rendering never starts workers
  onMount(() => {
    getPool().then(
      ready => { pool = ready; },
      (startError: unknown) => {
        error = startError instanceof Error ? startError.message : String(startError);
      }
    );
  });

  async function handleAnalyze() {
    if (!pool) return;
    loading = true;
    error = null;
    try {
      result = await pool.analyze(audio, { dialogText });
    } catch (analyzeError) {
      error = analyzeError instanceof Error ? analyzeError.message : String(analyzeError);
    } finally {
      loading = false;
    }
  }
</script>

<button on:click={handleAnalyze} disabled={!pool || loading}>
  {pool ? 'Analyze' : 'Loading...'}
</button>
{#if loading}
  <p>Analyzing (the page stays responsive)...</p>
{/if}
{#if error}
  <p>{error}</p>
{/if}
{#if result}
  <p>{result.mouthCues.length} mouth cues</p>
{/if}
```

---

## Best Practices

### 1. Keep One Pool for the Session

Create the pool once with an explicit worker count and keep it until the app is done with lip sync. See [Pool Lifecycle and Sizing](#pool-lifecycle-and-sizing).

```typescript
import { WorkerPool, loadAudio } from 'lip-sync-engine';

// Good: one pool, reused for every utterance
const pool = WorkerPool.getInstance(2);
await pool.init();

const first = await loadAudio('/utterance-1.wav');
const second = await loadAudio('/utterance-2.wav');
await pool.analyze(first.pcm16);
await pool.analyze(second.pcm16);

// Bad: destroying and re-creating the pool for every utterance.
// Each new pool starts its workers and rebuilds their decoders again.
async function analyzeOnce(pcm16: Int16Array) {
  const freshPool = WorkerPool.getInstance(2);
  await freshPool.init();
  const result = await freshPool.analyze(pcm16);
  freshPool.destroy();
  return result;
}
```

### 2. Handle Startup and Analysis Errors

`init()`, `warmup()`, and `analyze()` all return promises that can reject. Handle each one: a rejected promise without a handler is reported as an unhandled rejection, and the work it stood for is lost.

```typescript
import { WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(2);

// Bad: an unhandled rejection if the worker cannot load
pool.init();

// Good
try {
  await pool.init();
} catch (error) {
  if (!(error instanceof WorkerPoolDestroyedError)) {
    console.error('Lip sync is unavailable:', error); // show a message to the user
  }
}
```

See [Troubleshooting](#troubleshooting) for the errors the pool produces and how to recover.

### 3. Monitor Pool Statistics

```typescript
import type { WorkerPool } from 'lip-sync-engine';

function checkPool(pool: WorkerPool): void {
  const stats = pool.getStats();

  if (stats.queuedJobs > 10) {
    console.warn(
      'Jobs are waiting for a free worker: call warmup() if only one worker has started, ' +
      'or create the pool with a larger maxWorkers (set at the first getInstance() call)'
    );
  }

  console.log(`Workers: ${stats.busyWorkers}/${stats.totalWorkers} busy`);
}
```

For stream analyzers, watch the stream's own statistics instead (see [Streaming Analysis](./streaming-analysis.md#monitor-progress)).

---

## Troubleshooting

### Errors from the Pool

Every pool error message, and when it occurs, is listed under [WorkerPool Errors](./api-reference.md#workerpool-errors). To recover:

- [`WorkerPoolDestroyedError`](./api-reference.md#workerpooldestroyederror): expected during teardown. Ignore it with `error instanceof WorkerPoolDestroyedError`; the next `getInstance()` call creates a new pool.
- `WorkerPool not initialized. Call init() first.`: await `init()` before analyzing or calling `warmup()`.
- `Worker failed to load: ...` or `Worker initialization failed: ...`: fix the worker script URL, the WASM paths, or the CORS headers (see [CORS Issues](#cors-issues)), then call `init()` again. A failed pool startup is not cached.
- `Worker crashed: ...`: the other workers keep running. Call `warmup()` to start a replacement.
- `All WorkerPool workers failed. Call init() to restart the pool.`: call `init()` (and `warmup()`) again.

### Worker Script Not Found

**Error:** `Failed to construct 'Worker': Script at 'file://...' cannot be accessed`

Browsers do not start workers from local files on pages opened as `file://`. Serve the page over HTTP:

```bash
npx serve .
# or
python -m http.server 8000
```

### CORS Issues

**Error:** `Cross-Origin Request Blocked`, or `Worker failed to load` / `Worker initialization failed`

By default the worker script and the WASM files load from unpkg, which serves them with CORS headers. A cross-origin worker script is fetched and started from a `blob:` URL, so it does not need to be on your origin. If you host the files on another origin yourself (a CDN or a separate asset domain), that host must send CORS headers for the worker script and the `.wasm` and `.data` files. See [Self-Hosting the WASM Files](./getting-started.md#self-hosting-the-wasm-files).

### Memory Issues

**Error:** `Out of memory`, or the tab is reloaded by the browser

Each warm worker uses about 115 MB, so memory grows with the worker count, not with the chunk size. To use less:

- **Use fewer workers.** One or two are enough for streaming speech (see [Choose a Worker Count](#choose-a-worker-count)).
- **Build extra decoders only when needed.** With `prewarm: 'first'`, only the `init()` worker builds its decoder at start-up; workers started by `warmup()` build theirs on their first job, and jobs go to workers that already have one first.
- **Use the phonetic recognizer as a last resort.** `recognizer: 'phonetic'` used about 60 MB less memory per worker and about a third of the CPU, but only about 62% of frames matched the reference instead of 87% ([BENCHMARK.md](../BENCHMARK.md)). It also ignores `dialogText`.

```typescript
import { WorkerPool } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(1);
await pool.init({ prewarm: 'first' }); // add recognizer: 'phonetic' only if quality can drop
```

### Batch Jobs Slower Than Expected

**Checklist:**
1. Called `warmup()`? `init()` starts only one worker, so without `warmup()` the jobs run one at a time.
2. Is `maxWorkers` large enough? It is set by the first `getInstance()` call; check `pool.getStats().totalWorkers`.
3. Using `analyzeChunks()` (or several `analyze()` calls at once) rather than awaiting each chunk in turn?
4. Is the pool kept alive between jobs? A new pool builds every worker's decoder again.
5. Is the `dialogText` the same for every chunk? A new text makes the worker build a new decoder.
6. More workers than CPU cores add memory, not speed.

---

## Advanced Usage

### Progress Tracking

```typescript
import type { LipSyncEngineResult, WorkerPool } from 'lip-sync-engine';

async function analyzeWithProgress(
  pool: WorkerPool,
  chunks: Int16Array[],
  onProgress: (percent: number) => void
): Promise<LipSyncEngineResult[]> {
  let completed = 0;
  return Promise.all(chunks.map(async chunk => {
    const result = await pool.analyze(chunk);
    completed++;
    onProgress(Math.round((completed / chunks.length) * 100));
    return result;
  }));
}
```

### Graceful Degradation

If workers cannot start (for example under a Content Security Policy that blocks them), fall back to the main thread. The fallback blocks the UI while it runs.

```typescript
import { WorkerPool, WorkerPoolDestroyedError, analyze } from 'lip-sync-engine';
import type { LipSyncEngineResult } from 'lip-sync-engine';

async function analyzeWithFallback(pcm16: Int16Array): Promise<LipSyncEngineResult> {
  const pool = WorkerPool.getInstance(2);
  try {
    await pool.init();
  } catch (error) {
    if (error instanceof WorkerPoolDestroyedError) throw error;
    console.warn('Workers failed to start, analyzing on the main thread:', error);
    // Loads the WASM files from unpkg unless LipSyncEngine.init() was given other paths
    return analyze(pcm16);
  }
  return pool.analyze(pcm16);
}
```

---

## See Also

- [API Reference](./api-reference.md): every class, option, and error
- [Getting Started](./getting-started.md): installation, basic usage, and self-hosting
- [Streaming Analysis](./streaming-analysis.md): analyzing audio as it arrives
- [BENCHMARK.md](../BENCHMARK.md): speed, memory, and quality measurements
