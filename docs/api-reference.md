# API Reference

Classes, functions, and types exported by `lip-sync-engine`.

- [Default Asset URLs](#default-asset-urls)
- Core classes: [LipSyncEngine](#lipsyncengine), [WorkerPool](#workerpool), [WorkerPoolDestroyedError](#workerpooldestroyederror), [StreamAnalyzerController](#streamanalyzercontroller), [WasmLoader](#wasmloader)
- [Convenience Functions](#convenience-functions)
- [Audio Utilities](#audio-utilities)
- [Types](#types)
- [Mouth Shapes](#mouth-shapes)

For usage advice (dialog text, sample rate, error handling, cleanup), see [Best Practices](./getting-started.md#best-practices) in Getting Started.

Each example is a self-contained TypeScript module. `declare` lines stand in for values your app provides, such as `pcm16` (mono 16-bit PCM audio as an `Int16Array`).

## Default Asset URLs

Without path options, `LipSyncEngine` and `WorkerPool` load these files from unpkg. `<version>` is the installed package version.

| File | Option | Default URL |
|---|---|---|
| Compiled engine | `wasmPath` | `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.wasm` |
| Model file (about 39 MB) | `dataPath` | `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.data` |
| Engine loader | `jsPath` | `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.js` |
| Worker script (`WorkerPool` only) | `workerScriptUrl` | `https://unpkg.com/lip-sync-engine@<version>/dist/worker.js` |

To serve the files yourself, see [Self-Hosting the WASM Files](./getting-started.md#self-hosting-the-wasm-files). Files on another origin need CORS headers.

## Core Classes

### LipSyncEngine

Singleton that runs the engine on the main thread. `analyze()` blocks the main thread while it runs; `analyzeAsync()` hands the work to the shared [`WorkerPool`](#workerpool).

```typescript
import type { LipSyncEngineOptions, LipSyncEngineResult, WasmLoaderOptions } from 'lip-sync-engine';

declare class LipSyncEngine {
  private constructor();
  static getInstance(): LipSyncEngine;
  init(options?: WasmLoaderOptions): Promise<void>;
  analyze(pcm16: Int16Array, options?: LipSyncEngineOptions): Promise<LipSyncEngineResult>;
  analyzeAsync(pcm16: Int16Array, options?: LipSyncEngineOptions): Promise<LipSyncEngineResult>;
  destroy(): void;
}
```

#### `getInstance()`

Returns the singleton instance, creating it on the first call or after `destroy()`.

**Parameters:** none.

**Returns:** `LipSyncEngine`.

**Example:**
```typescript
import { LipSyncEngine } from 'lip-sync-engine';

const lipSyncEngine = LipSyncEngine.getInstance();
```

#### `init(options?)`

Loads the WASM module and starts the engine. Calling it is optional: `analyze()` calls it without options, which loads the default (CDN) paths. Call it yourself, before any `analyze()`, to load self-hosted files or to load the engine ahead of the first analysis.

The module loads once per page. Later calls, including calls on a new instance after `destroy()`, share that load and ignore their options, so the options of the first load win. A failed load is not kept: the next `init()` or `analyze()` loads again. `init(options)` loads with the options it is given. `init()` without options, and `analyze()`, load with the options of the last `init(options)` call that started a load, or with the default paths if there was none, so a self-hosted app that retries through `analyze()` does not switch to the CDN. [`destroy()`](#destroy) forgets those options. `analyzeAsync()` does not use this module or its options.

**Parameters:**
- `options?: WasmLoaderOptions`: file paths and preloaded assets (see [`WasmLoaderOptions`](#wasmloaderoptions)). Paths default to the [default asset URLs](#default-asset-urls).

**Returns:** `Promise<void>`.

**Throws:** the promise rejects if the engine cannot load:
- `Error('Failed to load WASM module from <jsPath>')` when the loader script cannot be fetched.
- `Error('Failed to load model data from <dataPath>: <reason>')` when the model file cannot be downloaded.
- `Error('LipSyncEngine initialization failed: <reason>')` when the engine cannot start.

After a rejection, fix the cause and call `init()` again; no page reload is needed.

**Example:**
```typescript
import { LipSyncEngine } from 'lip-sync-engine';

const lipSyncEngine = LipSyncEngine.getInstance();

// Self-hosted files. Call init() without options to load from the CDN.
await lipSyncEngine.init({
  wasmPath: '/lip-sync-engine/lip-sync-engine.wasm',
  dataPath: '/lip-sync-engine/lip-sync-engine.data',
  jsPath: '/lip-sync-engine/lip-sync-engine.js',
});
```

#### `analyze(pcm16, options?)`

Analyzes audio on the main thread and returns its mouth cues. Calls `init()` first if needed. The main thread is blocked while the analysis runs.

**Parameters:**
- `pcm16: Int16Array`: mono 16-bit PCM audio.
- `options?: LipSyncEngineOptions`: transcript, sample rate, and shape set (see [`LipSyncEngineOptions`](#lipsyncengineoptions)).

**Returns:** `Promise<LipSyncEngineResult>`, with `metadata` filled in (see [`LipSyncEngineResult`](#lipsyncengineresult)).

**Throws:** the promise rejects with:
- `TypeError('pcm16 must be an Int16Array')` when `pcm16` is not an `Int16Array`.
- `Error('pcm16 buffer is empty')` when `pcm16` has no samples.
- `Error('sampleRate must be positive')` when `sampleRate` is `0` or negative.
- `Error("Unknown extended shape '<letter>'. Use any of G, H, X.")` when `extendedShapes` contains a letter other than G, H, or X.
- The errors of [`init()`](#initoptions) when the engine cannot load.
- The engine's error message when the analysis itself fails, usually `Analysis error: <reason>` (for example for audio below 16 kHz).

**Example:**
```typescript
import { LipSyncEngine } from 'lip-sync-engine';

declare const pcm16: Int16Array;

const result = await LipSyncEngine.getInstance().analyze(pcm16, {
  dialogText: 'Hello world',
  sampleRate: 16000,
});
console.log(result.mouthCues);
```

#### `analyzeAsync(pcm16, options?)`

Analyzes audio in a Web Worker so the main thread stays responsive. Uses the shared [`WorkerPool`](#workerpool): calls `WorkerPool.getInstance()` without arguments and `init()` without options, then `pool.analyze()`. If the pool is not running yet, it starts with its defaults (CDN paths, `navigator.hardwareConcurrency || 4` workers allowed, one started). The pool keeps running afterwards.

Paths passed to `LipSyncEngine.init()` are not used. To self-host or choose the worker count, create and start the pool yourself before the first call: `WorkerPool.getInstance(maxWorkers, workerScriptUrl).init({ ...paths })`.

**Parameters:**
- `pcm16: Int16Array`: mono 16-bit PCM audio.
- `options?: LipSyncEngineOptions`: analysis options.

**Returns:** `Promise<LipSyncEngineResult>`. Use `mouthCues`; `metadata` is not set the same way as with `analyze()`.

**Throws:** the errors of [`WorkerPool.init()`](#initoptions-1) and [`WorkerPool.analyze()`](#analyzepcm16-options-1), listed under [WorkerPool Errors](#workerpool-errors).

**Example:**
```typescript
import { LipSyncEngine } from 'lip-sync-engine';

declare const pcm16: Int16Array;

const result = await LipSyncEngine.getInstance().analyzeAsync(pcm16, {
  dialogText: 'Hello world',
});
```

#### `destroy()`

Drops this instance and the options passed to `init()`; the next `getInstance()` returns a new one. The loaded WASM module stays cached and is reused by later instances. Call [`WasmLoader.reset()`](#reset) as well to let it be garbage-collected. Does not affect the `WorkerPool`.

**Parameters:** none.

**Returns:** `void`.

**Example:**
```typescript
import { LipSyncEngine } from 'lip-sync-engine';

LipSyncEngine.getInstance().destroy();
```

---

### WorkerPool

Singleton pool of Web Workers for non-blocking and parallel analysis. Each worker runs its own copy of the engine. A warm worker uses about 115 MB. For choosing a worker count and keeping the pool alive, see [Pool Lifecycle and Sizing](./worker-usage.md#pool-lifecycle-and-sizing).

```typescript
import type {
  LipSyncEngineOptions,
  LipSyncEngineResult,
  PrewarmMode,
  RecognizerKind,
  StreamAnalyzerController,
  StreamAnalyzerOptions,
} from 'lip-sync-engine';

interface WorkerPoolInitOptions {
  wasmPath?: string;
  dataPath?: string;
  jsPath?: string;
  workerScriptUrl?: string;
  prewarm?: PrewarmMode;
  shareAssets?: boolean;
  recognizer?: RecognizerKind;
}

interface WorkerPoolStats {
  totalWorkers: number;
  busyWorkers: number;
  idleWorkers: number;
  queuedJobs: number;
  maxWorkers: number;
}

declare class WorkerPool {
  private constructor();
  static getInstance(maxWorkers?: number, workerScriptUrl?: string): WorkerPool;
  init(options?: WorkerPoolInitOptions): Promise<void>;
  warmup(): Promise<void>;
  analyze(pcm16: Int16Array, options?: LipSyncEngineOptions): Promise<LipSyncEngineResult>;
  analyzeChunks(chunks: Int16Array[], options?: LipSyncEngineOptions): Promise<LipSyncEngineResult[]>;
  createStreamAnalyzer(options?: StreamAnalyzerOptions): StreamAnalyzerController;
  getStats(): WorkerPoolStats;
  getMemoryStats(): Promise<{ workers: number[]; totalBytes: number }>;
  destroy(): void;
}
```

`WorkerPoolInitOptions` and `WorkerPoolStats` are not exported; see [Type Names](#type-names).

#### `getInstance(maxWorkers?, workerScriptUrl?)`

Returns the singleton pool, creating it on the first call or after `destroy()`. The arguments apply only when the pool is created; later calls return the existing pool and ignore them. `analyzeAsync()` calls `getInstance()` without arguments, so call `getInstance()` with your arguments before the first `analyzeAsync()`.

**Parameters:**
- `maxWorkers?: number`: most workers the pool may run. Default `navigator.hardwareConcurrency || 4`. Values below 1 become 1. Pass a small explicit count: 1 or 2 for streaming, up to 4 for chunked analysis.
- `workerScriptUrl?: string`: worker script URL. Default: the CDN URL under [Default Asset URLs](#default-asset-urls). `init({ workerScriptUrl })` overrides it.

**Returns:** `WorkerPool`.

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(2, '/lip-sync-engine/worker.js');
```

#### `init(options?)`

Starts the pool with one worker. Must finish before `analyze()`, `analyzeChunks()`, `createStreamAnalyzer()`, or `warmup()`. Use `warmup()` to start the remaining workers. The promise rejects if the worker cannot load its script or the engine files; it does not stay pending.

Calls made while startup is in progress share that startup, and calls made after the pool has started resolve at once. Both ignore their options: the options of the call that started the pool apply. After a failed startup, or after every worker has failed, `init()` starts the pool again.

**Parameters:**
- `options?: WorkerPoolInitOptions`:
  - `wasmPath?: string`, `dataPath?: string`, `jsPath?: string`: engine file URLs. Default: the [default asset URLs](#default-asset-urls).
  - `workerScriptUrl?: string`: worker script URL. Default: the value given to `getInstance()`, or the CDN URL.
  - `prewarm?: PrewarmMode`: when each worker builds its speech decoder (acoustic model, dictionary, and language model; about 0.5 s of CPU per worker). Default `true`.
    - `true`: during `init()` and `warmup()`, so no analysis waits for it.
    - `'first'`: only the `init()` worker builds it during startup; workers started by `warmup()` build it on their first job. Jobs go to workers whose decoder is built first.
    - `false`: each worker builds it on its first job.
  - `shareAssets?: boolean`: compile the `.wasm` file once. The first worker sends its compiled module back, and later workers (including those of pools created later) reuse it. Default `true`. Each worker still loads its own copy of the model file, normally from the browser's HTTP cache after the first download.
  - `recognizer?: RecognizerKind`: speech recognizer for all workers. Default `'pocketsphinx'`. `'phonetic'` recognizes phones without words. It uses about a third of the CPU, about 60 MB less memory per worker, and returns the first chunk much sooner, but its mouth shapes are clearly worse: about 25 points lower agreement than the default recognizer in a separate benchmark run (agreement is the share of 10 ms frames whose shape matches a whole-utterance reference; see [BENCHMARK.md](../BENCHMARK.md#mouth-cue-quality)). It ignores `dialogText`. Use it only on devices that cannot keep up otherwise.

**Returns:** `Promise<void>`.

**Throws:** the promise rejects with `Worker failed to load: ...`, `Worker initialization failed: ...`, or [`WorkerPoolDestroyedError`](#workerpooldestroyederror); see [WorkerPool Errors](#workerpool-errors).

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(2);

// Self-hosted files. Call init() without options to load from the CDN.
await pool.init({
  wasmPath: '/lip-sync-engine/lip-sync-engine.wasm',
  dataPath: '/lip-sync-engine/lip-sync-engine.data',
  jsPath: '/lip-sync-engine/lip-sync-engine.js',
  workerScriptUrl: '/lip-sync-engine/worker.js',
});
```

Keep the pool alive between utterances. A worker keeps its speech decoder between calls, so only pool startup pays for building it; destroying and re-creating the pool for each utterance pays that cost every time.

#### `warmup()`

Starts workers until the pool has `maxWorkers`, counting workers that are running or starting. The pool never adds workers on its own, so call `warmup()` before parallel work (`analyzeChunks()`, or a windowed stream analyzer, whose `maxConcurrent` defaults to 2). Resolves at once when the pool is full.

Concurrent calls share one warmup. If one worker fails to start, the promise rejects at once; workers that started stay in the pool, and calling `warmup()` again starts only the missing ones.

**Parameters:** none.

**Returns:** `Promise<void>`.

**Throws:** the promise rejects with:
- `Error('WorkerPool not initialized. Call init() first.')` when `init()` has not finished.
- `Worker failed to load: ...`, `Worker initialization failed: ...`, or [`WorkerPoolDestroyedError`](#workerpooldestroyederror); see [WorkerPool Errors](#workerpool-errors).

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(4);
await pool.init();
await pool.warmup(); // all four workers are ready for parallel work
```

#### `analyze(pcm16, options?)`

Analyzes audio in a worker. When every worker is busy, the job waits in a queue; jobs go to workers whose decoder is built first. Your buffer is copied before it is sent, so it stays usable.

**Parameters:**
- `pcm16: Int16Array`: mono 16-bit PCM audio.
- `options?: LipSyncEngineOptions`: analysis options (see [`LipSyncEngineOptions`](#lipsyncengineoptions)).

**Returns:** `Promise<LipSyncEngineResult>`. Use `mouthCues`.

**Throws:** the promise rejects with:
- `Error('WorkerPool not initialized. Call init() first.')` when `init()` has not finished.
- The engine's error message when the analysis fails, for example `"Unknown extended shape '<letter>'. Use any of G, H, X."` for an invalid `extendedShapes` value.
- `Worker crashed: ...`, `All WorkerPool workers failed. Call init() to restart the pool.`, or [`WorkerPoolDestroyedError`](#workerpooldestroyederror); see [WorkerPool Errors](#workerpool-errors).

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

declare const pcm16: Int16Array;

const pool = WorkerPool.getInstance(2);
await pool.init();

const result = await pool.analyze(pcm16, {
  dialogText: 'Hello world',
  sampleRate: 16000,
});
console.log(result.mouthCues);
```

#### `analyzeChunks(chunks, options?)`

Analyzes each chunk as a separate job, in parallel across the workers that have started, and resolves when all are done. `init()` starts one worker; call `warmup()` first to start up to `maxWorkers`. The speed-up is limited by started workers and CPU cores.

Each chunk is analyzed on its own, with no audio from neighboring chunks, and its cue times start at 0. Add each chunk's start time to place its cues on a shared timeline. For streaming speech, use `createStreamAnalyzer()` with `contextMs` and `lookaheadMs` instead.

**Parameters:**
- `chunks: Int16Array[]`: audio chunks.
- `options?: LipSyncEngineOptions`: analysis options, applied to every chunk.

**Returns:** `Promise<LipSyncEngineResult[]>`, in the same order as `chunks`.

**Throws:** the promise rejects with `Error('WorkerPool not initialized. Call init() first.')` when `init()` has not finished, or with the first error of any chunk (the errors of [`analyze()`](#analyzepcm16-options-1)).

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

declare const fullAudio: Int16Array; // 16 kHz

const sampleRate = 16000;
const chunkSize = sampleRate * 5; // 5-second chunks
const chunks: Int16Array[] = [];
for (let i = 0; i < fullAudio.length; i += chunkSize) {
  chunks.push(fullAudio.slice(i, i + chunkSize));
}

const pool = WorkerPool.getInstance(4);
await pool.init();
await pool.warmup(); // start all workers for parallel work
const results = await pool.analyzeChunks(chunks, { sampleRate });

// Cue times are relative to each chunk, so add each chunk's start time
let offset = 0;
const allCues = results.flatMap((result, i) => {
  const cues = result.mouthCues.map(cue => ({ ...cue, start: cue.start + offset, end: cue.end + offset }));
  offset += chunks[i].length / sampleRate;
  return cues;
});
```

#### `createStreamAnalyzer(options?)`

Creates a [`StreamAnalyzerController`](#streamanalyzercontroller) that accepts audio chunks as they arrive (for example from a WebSocket, a text-to-speech stream, or an `AudioWorklet` microphone tap; see [Microphone](./streaming-analysis.md#microphone)) and returns each chunk's cues.

**Parameters:**
- `options?: StreamAnalyzerOptions`: `LipSyncEngineOptions` applied to every chunk, plus the windowing options in [`StreamAnalyzerOptions`](#streamanalyzeroptions).

**Returns:** `StreamAnalyzerController`.

**Throws:** `Error('WorkerPool not initialized. Call init() first.')`, synchronously, when `init()` has not finished.

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

declare const audioStream: AsyncIterable<Int16Array>; // 16 kHz chunks

const pool = WorkerPool.getInstance(2);
await pool.init();
await pool.warmup();

const stream = pool.createStreamAnalyzer({
  sampleRate: 16000,
  contextMs: 500,   // earlier audio analyzed with each chunk
  lookaheadMs: 500, // later audio, waited for only while playback allows
});

for await (const chunk of audioStream) {
  stream.addChunk(chunk); // returns at once
}

const results = await stream.finalize(); // all results, in order
```

See the [Streaming Analysis Guide](./streaming-analysis.md) for usage patterns.

#### `getStats()`

Returns a snapshot of the pool's workers and queue.

**Parameters:** none.

**Returns:** `WorkerPoolStats`:
- `totalWorkers: number`: workers currently in the pool. Workers still starting are not counted, and crashed workers are removed.
- `busyWorkers: number`: workers running a job.
- `idleWorkers: number`: workers in the pool that are not running a job.
- `queuedJobs: number`: jobs waiting for a free worker.
- `maxWorkers: number`: the pool's `maxWorkers`.

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

const stats = WorkerPool.getInstance().getStats();
console.log(`Workers: ${stats.busyWorkers}/${stats.totalWorkers} busy`);
console.log(`Queue: ${stats.queuedJobs} jobs waiting`);
```

#### `getMemoryStats()`

Asks each worker in the pool for the size of its WebAssembly memory. This is memory the worker has reserved for the engine: at least 128 MiB per worker, growing when the engine needs more and never shrinking. Reserved memory is not all in use, so this figure can be larger than a worker's actual memory use (about 115 MB for a warm worker; see [BENCHMARK.md](../BENCHMARK.md)). Use it to watch for growth over time, not to measure a worker's total memory.

**Parameters:** none.

**Returns:** `Promise<{ workers: number[]; totalBytes: number }>`:
- `workers`: WebAssembly memory of each worker currently in the pool, in bytes. Empty when the pool has no workers.
- `totalBytes`: sum of `workers`.

A worker answers between jobs, so the promise waits for the analyses running when it is called. A worker that stops before it answers (it crashes, or `destroy()` is called) counts as `0`.

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

const { workers, totalBytes } = await WorkerPool.getInstance().getMemoryStats();
console.log(`${workers.length} workers, ${(totalBytes / 1e6).toFixed(0)} MB of WebAssembly memory`);
```

#### `destroy()`

Terminates all workers, including workers that are still starting, and releases the pool's resources. The next `getInstance()` call creates a new pool, and its arguments apply again.

Pending `init()`, `warmup()`, and analysis promises reject with [`WorkerPoolDestroyedError`](#workerpooldestroyederror). In a stream analyzer with `contextMs` or `lookaheadMs`, chunks not yet sent to a worker reject with `Error('WorkerPool not initialized. Call init() first.')` instead.

**Parameters:** none.

**Returns:** `void`.

**Example:**
```typescript
import { WorkerPool } from 'lip-sync-engine';

// When the app no longer needs lip sync
WorkerPool.getInstance().destroy();
```

#### WorkerPool Errors

Errors other than `WorkerPoolDestroyedError` are plain `Error` objects. Match them by message:

| Message | Where and when |
|---|---|
| `WorkerPool not initialized. Call init() first.` | `warmup()`, `analyze()`, and `analyzeChunks()` reject, and `createStreamAnalyzer()` throws, when `init()` has not finished (also after `destroy()`, or after every worker has failed). |
| `Worker failed to load: <detail>` | `init()` or `warmup()`: a worker's script failed to load (for example a wrong `workerScriptUrl` or missing CORS headers), or the worker threw while starting. |
| `Worker initialization failed: <detail>` | `init()` or `warmup()`: a worker could not load the engine files or start the engine (for example a wrong `wasmPath`, `dataPath`, or `jsPath`, or missing CORS headers). When the model file fails to download, `<detail>` is `Failed to load model data from <dataPath>: <reason>`; when the pool cannot read the worker's reply, it is `could not read the worker's reply`. |
| `Worker crashed: <detail>` | The job a worker was running when it crashed. The pool removes that worker and does not replace it on its own; call `warmup()` to start a replacement, or `init()` if it was the last worker. |
| `All WorkerPool workers failed. Call init() to restart the pool.` | Queued jobs, once every worker has failed and none is starting. Call `init()` to start the pool again. |
| `WorkerPoolDestroyedError` | Pending promises when `destroy()` is called. See [WorkerPoolDestroyedError](#workerpooldestroyederror). |

An analysis that fails inside a worker rejects only its own job with the engine's error message; the worker stays in the pool.

---

### WorkerPoolDestroyedError

Error used to reject pending `init()`, `warmup()`, and analysis promises when `destroy()` is called. Its `name` is `'WorkerPoolDestroyedError'` and its `message` is `'WorkerPool destroyed'`. Ignore it when you destroy the pool during cleanup, for example when a component unmounts while the pool is still starting.

```typescript
import { WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(2);

pool.init().catch((error: unknown) => {
  if (error instanceof WorkerPoolDestroyedError) return; // canceled by destroy()
  console.error('WorkerPool failed to start:', error);
});
```

---

### StreamAnalyzerController

Analyzes a stream of audio chunks. Created by [`WorkerPool.createStreamAnalyzer(options)`](#createstreamanalyzeroptions), with options described in [`StreamAnalyzerOptions`](#streamanalyzeroptions).

The controller works in one of two modes:

- **Separate chunks** (`contextMs` and `lookaheadMs` both `0`, the default): each chunk is analyzed on its own as soon as it is added.
- **Windowed** (either option set): each chunk is analyzed inside a window of the surrounding audio, and only that chunk's cues are returned. Chunks that are ready at the same time share one analysis. For short streaming chunks this improves quality a lot; `{ contextMs: 500, lookaheadMs: 500 }` is the recommended setting. See [Context and Lookahead](./streaming-analysis.md#context-and-lookahead).

In both modes, cue times are relative to the chunk start. In windowed mode, a chunk with no cues of its own gets a single idle cue covering it (`X`, or `A` when `extendedShapes` excludes X).

```typescript
import type { LipSyncEngineResult, WorkerPool } from 'lip-sync-engine';

interface StreamAnalyzerStats {
  chunksAdded: number;
  chunksCompleted: number;
  poolStats: ReturnType<WorkerPool['getStats']>;
}

declare class StreamAnalyzerController {
  addChunk(chunk: Int16Array): number;
  end(): void;
  getResult(index: number): Promise<LipSyncEngineResult>;
  finalize(): Promise<LipSyncEngineResult[]>;
  getStats(): StreamAnalyzerStats;
}
```

`StreamAnalyzerStats` is not exported; see [Type Names](#type-names).

#### `addChunk(chunk)`

Adds the next chunk of the stream and returns its index. Returns at once without blocking the main thread.

When analysis starts depends on the mode. With separate chunks, the chunk is queued right away. In windowed mode, the chunk is copied and analyzed once `lookaheadMs` of following audio has arrived, or earlier when `end()` is called, when it must start to be ready before its estimated playback time, or after `maxWaitMs`. The first chunk does not wait for lookahead unless `firstChunkLookahead` is set.

**Parameters:**
- `chunk: Int16Array`: the next chunk of mono 16-bit PCM audio, at the analyzer's `sampleRate`.

**Returns:** `number`: the chunk's index, for `getResult()` and the `finalize()` results.

**Throws:** `Error('Cannot add chunks after end() has been called')` after `end()`, or `Error('Cannot add chunks after finalize() has been called')` after `finalize()`.

**Example:**
```typescript
import type { StreamAnalyzerController } from 'lip-sync-engine';

declare const stream: StreamAnalyzerController;
declare const audioChunk: Int16Array;

const index = stream.addChunk(audioChunk);
console.log(`Added chunk ${index}`);
```

#### `end()`

Signals that no more chunks will be added, so chunks waiting for lookahead are analyzed with the audio that follows them. Call it when the utterance's audio is complete. `finalize()` calls it too.

**Parameters:** none.

**Returns:** `void`.

**Example:**
```typescript
import type { StreamAnalyzerController } from 'lip-sync-engine';

declare const stream: StreamAnalyzerController;

stream.end(); // the speaker has finished
```

#### `getResult(index)`

Returns one chunk's result. Use it to play each chunk as soon as its cues are ready.

**Parameters:**
- `index: number`: a value returned by `addChunk()`.

**Returns:** `Promise<LipSyncEngineResult>`: the chunk's cues, with times relative to the chunk start.

**Throws:** the promise rejects with `Error('No chunk with index <index>')` when no chunk has that index, or with the chunk's analysis error (see [WorkerPool Errors](#workerpool-errors)).

**Example:**
```typescript
import type { MouthCue, StreamAnalyzerController } from 'lip-sync-engine';

declare const stream: StreamAnalyzerController;
declare const audioChunk: Int16Array;
declare function playChunk(audio: Int16Array, cues: MouthCue[]): void;

const index = stream.addChunk(audioChunk);
const { mouthCues } = await stream.getResult(index);
playChunk(audioChunk, mouthCues);
```

#### `finalize()`

Calls `end()`, waits for every chunk, and returns all results in the order the chunks were added.

**Parameters:** none.

**Returns:** `Promise<LipSyncEngineResult[]>`.

**Throws:** the promise rejects with the first chunk error (see [WorkerPool Errors](#workerpool-errors)).

**Example:**
```typescript
import type { StreamAnalyzerController } from 'lip-sync-engine';

declare const stream: StreamAnalyzerController;
declare const chunks: Int16Array[];

for (const chunk of chunks) {
  stream.addChunk(chunk);
}
const results = await stream.finalize();
console.log(`Analyzed ${results.length} chunks`);
```

#### `getStats()`

Returns the stream's progress and the pool's state.

**Parameters:** none.

**Returns:** `StreamAnalyzerStats`:
- `chunksAdded: number`: chunks added so far.
- `chunksCompleted: number`: chunks whose analysis has finished, successfully or with an error.
- `poolStats: WorkerPoolStats`: the result of [`WorkerPool.getStats()`](#getstats).

**Example:**
```typescript
import type { StreamAnalyzerController } from 'lip-sync-engine';

declare const stream: StreamAnalyzerController;

const stats = stream.getStats();
console.log(`Progress: ${stats.chunksCompleted}/${stats.chunksAdded} chunks done`);
console.log(`Workers: ${stats.poolStats.busyWorkers}/${stats.poolStats.totalWorkers} busy`);
```

---

### WasmLoader

Loads the engine's WASM module. `LipSyncEngine.init()` and the pool's workers use it for you; call it directly only to release the cached module or to load the engine yourself.

```typescript
import type { LipSyncEngineModule, WasmLoaderOptions } from 'lip-sync-engine';

declare class WasmLoader {
  static load(options?: WasmLoaderOptions): Promise<LipSyncEngineModule>;
  static loadModule(options?: WasmLoaderOptions): Promise<LipSyncEngineModule>;
  static reset(): void;
}
```

#### `load(options?)`

Loads the module once per page and caches it. Later calls return the cached module, or the load in progress, and ignore their options. `LipSyncEngine.init()` loads through this method. A failed load is not cached: the next call loads again. On the main thread the loader script (`jsPath`) is added to the page once and reused by later loads; if it fails to load, it is removed from the page and the `.data` and `.wasm` downloads are canceled.

**Parameters:**
- `options?: WasmLoaderOptions`: file paths and preloaded assets (see [`WasmLoaderOptions`](#wasmloaderoptions)).

**Returns:** `Promise<LipSyncEngineModule>` (see [`LipSyncEngineModule`](#lipsyncenginemodule)).

**Throws:** the promise rejects with:
- `Error('Failed to load WASM module from <jsPath>')` when the loader script cannot be fetched.
- `Error('Failed to load model data from <dataPath>: <reason>')` when the `.data` file cannot be downloaded (`<reason>` is `HTTP <status>` or the network error). A network error is retried once, bypassing the HTTP cache, before the promise rejects.
- The error raised while the module starts.

**Example:**
```typescript
import { WasmLoader } from 'lip-sync-engine';

const module = await WasmLoader.load();
```

#### `loadModule(options?)`

Loads a new, uncached module instance on every call. The pool's workers use it.

**Parameters:**
- `options?: WasmLoaderOptions`: file paths and preloaded assets.

**Returns:** `Promise<LipSyncEngineModule>`.

**Throws:** the same errors as [`load()`](#loadoptions).

**Example:**
```typescript
import { WasmLoader } from 'lip-sync-engine';

const module = await WasmLoader.loadModule({ jsPath: '/lip-sync-engine/lip-sync-engine.js' });
```

#### `reset()`

Drops the module cached by `load()`, so it can be garbage-collected once nothing else holds it, and the next `load()` loads again. A load in progress when `reset()` is called still resolves for its callers but is not cached. Call it after [`LipSyncEngine.destroy()`](#destroy) to release the engine's memory.

**Parameters:** none.

**Returns:** `void`.

**Example:**
```typescript
import { LipSyncEngine, WasmLoader } from 'lip-sync-engine';

LipSyncEngine.getInstance().destroy();
WasmLoader.reset();
```

---

## Convenience Functions

### `analyze(pcm16, options?)`

Shorthand for `LipSyncEngine.getInstance().analyze(pcm16, options)`: analyzes on the main thread, loading the engine if needed with the options of an earlier `init(options)` call, or with the default paths if there was none.

**Parameters:**
- `pcm16: Int16Array`: mono 16-bit PCM audio.
- `options?: LipSyncEngineOptions`: analysis options.

**Returns:** `Promise<LipSyncEngineResult>`.

**Throws:** the errors of [`LipSyncEngine.analyze()`](#analyzepcm16-options).

**Example:**
```typescript
import { analyze } from 'lip-sync-engine';

declare const pcm16: Int16Array;

const result = await analyze(pcm16, {
  dialogText: 'Hello world',
  sampleRate: 16000,
});
```

### `analyzeAsync(pcm16, options?)`

Shorthand for `LipSyncEngine.getInstance().analyzeAsync(pcm16, options)`: analyzes in a worker of the shared `WorkerPool`, starting the pool with its defaults if it is not running. The pool keeps running afterwards; call `WorkerPool.getInstance().destroy()` when you no longer need it.

**Parameters:**
- `pcm16: Int16Array`: mono 16-bit PCM audio.
- `options?: LipSyncEngineOptions`: analysis options.

**Returns:** `Promise<LipSyncEngineResult>`.

**Throws:** see [WorkerPool Errors](#workerpool-errors).

**Example:**
```typescript
import { analyzeAsync } from 'lip-sync-engine';

declare const pcm16: Int16Array;

const result = await analyzeAsync(pcm16, {
  dialogText: 'Hello world',
});
```

## Audio Utilities

### `recordAudio(durationMs, sampleRate?)`

Records from the microphone for a fixed time. Asks for microphone permission.

**Parameters:**
- `durationMs: number`: recording length in milliseconds.
- `sampleRate?: number`: sample rate of the returned audio. Default `16000`.

**Returns:** `Promise<{ pcm16: Int16Array; audioBuffer: AudioBuffer }>`: the recording as mono PCM, and the decoded `AudioBuffer`.

**Throws:** the promise rejects when microphone access is denied or unavailable, or when the recording cannot be decoded.

**Example:**
```typescript
import { recordAudio } from 'lip-sync-engine';

const { pcm16 } = await recordAudio(5000); // 5 seconds
```

### `loadAudio(source, targetSampleRate?)`

Fetches or reads an audio file and decodes it.

**Parameters:**
- `source: string | File`: a URL or a `File`.
- `targetSampleRate?: number`: sample rate of the returned audio. Default `16000`.

**Returns:** `Promise<{ pcm16: Int16Array; audioBuffer: AudioBuffer }>`: the first channel as PCM, and the decoded `AudioBuffer`.

**Throws:** the promise rejects when the file cannot be fetched, read, or decoded.

**Example:**
```typescript
import { loadAudio } from 'lip-sync-engine';

declare const fileInput: HTMLInputElement;

// From a URL
const fromUrl = await loadAudio('https://example.com/audio.mp3');

// From a file input
const file = fileInput.files?.[0];
if (file) {
  const fromFile = await loadAudio(file);
}
```

### `audioBufferToInt16(audioBuffer, targetSampleRate?)`

Converts the first channel of an `AudioBuffer` to 16-bit PCM, resampling it with `resample()` when its rate differs from `targetSampleRate`.

**Parameters:**
- `audioBuffer: AudioBuffer`: Web Audio buffer.
- `targetSampleRate?: number`: sample rate of the returned audio. Default `16000`.

**Returns:** `Int16Array`.

**Example:**
```typescript
import { audioBufferToInt16 } from 'lip-sync-engine';

declare const audioBuffer: AudioBuffer;

const pcm16 = audioBufferToInt16(audioBuffer, 16000);
```

### `float32ToInt16(float32)`

Converts float samples to 16-bit PCM. Values outside -1 to 1 are clipped.

**Parameters:**
- `float32: Float32Array`: samples between -1 and 1.

**Returns:** `Int16Array`.

**Example:**
```typescript
import { float32ToInt16 } from 'lip-sync-engine';

declare const float32Data: Float32Array;

const pcm16 = float32ToInt16(float32Data);
```

### `resample(input, fromRate, toRate)`

Changes the sample rate by picking the nearest earlier sample, without filtering. Returns `input` itself when the rates are equal. Use a dedicated resampler when audio quality matters.

**Parameters:**
- `input: Float32Array`: input samples.
- `fromRate: number`: input sample rate.
- `toRate: number`: output sample rate.

**Returns:** `Float32Array`.

**Example:**
```typescript
import { resample } from 'lip-sync-engine';

declare const float32Data: Float32Array;

const resampled = resample(float32Data, 44100, 16000);
```

## Types

### Type Names

`WorkerPoolInitOptions`, `WorkerPoolStats`, and `StreamAnalyzerStats` are names this page uses for types the package does not export. In TypeScript, refer to them as:

```typescript
import type { StreamAnalyzerController, WorkerPool } from 'lip-sync-engine';

type WorkerPoolInitOptions = NonNullable<Parameters<WorkerPool['init']>[0]>;
type WorkerPoolStats = ReturnType<WorkerPool['getStats']>;
type StreamAnalyzerStats = ReturnType<StreamAnalyzerController['getStats']>;
```

Every other type on this page is exported; import it with `import type`.

### `MouthCue`

One mouth shape and when it is shown.

```typescript
interface MouthCue {
  start: number; // start time in seconds
  end: number;   // end time in seconds
  value: string; // mouth shape: A-H or X (A-F only with extendedShapes: '')
}
```

See [Mouth Shapes](#mouth-shapes) for the values.

### `LipSyncEngineResult`

Result of an analysis.

```typescript
import type { MouthCue } from 'lip-sync-engine';

interface LipSyncEngineResult {
  mouthCues: MouthCue[];
  metadata?: {
    duration: number;    // end of the last cue, in seconds
    sampleRate: number;  // sample rate used
    dialogText?: string; // transcript, if given
  };
}
```

Only `LipSyncEngine.analyze()` (and the `analyze()` function) sets `metadata` as shown. Results from `WorkerPool`, `analyzeAsync()`, and stream analyzers carry different metadata; use `mouthCues` for timing.

### `LipSyncEngineOptions`

Options for one analysis.

```typescript
interface LipSyncEngineOptions {
  dialogText?: string;     // expected transcript; improves recognition
  sampleRate?: number;     // sample rate of the audio in Hz (default 16000)
  extendedShapes?: string; // extended shapes on top of A-F (default 'GHX')
}
```

- `dialogText`: when you know what is said, pass it. The `'phonetic'` recognizer ignores it.
- `sampleRate`: must match the audio. Higher rates are converted down to 16 kHz internally. Rates below 16 kHz are not supported: the analysis fails with an `Analysis error: ...` message.
- `extendedShapes`: any combination of `G`, `H`, and `X` (see [Mouth Shapes](#mouth-shapes)), in any order and case. `'GHX'` (the default) gives all nine shapes; `''` gives A-F only, for avatars without G, H, and X art. Any other character makes the analysis fail with `Unknown extended shape '<letter>'. Use any of G, H, X.`

### `StreamAnalyzerOptions`

Options for [`WorkerPool.createStreamAnalyzer()`](#createstreamanalyzeroptions): everything in `LipSyncEngineOptions`, plus these windowing options. All are optional.

| Option | Default | Meaning |
|---|---|---|
| `contextMs` | `0` | Earlier audio analyzed together with each chunk, in milliseconds. |
| `lookaheadMs` | `0` | Later audio to wait for and analyze together with each chunk, in milliseconds. |
| `firstChunkLookahead` | `false` | Also wait for lookahead before the first chunk. Off by default because nothing can play until the first chunk's cues are back. |
| `deadlineMarginMs` | `150` | Waiting for lookahead stops early enough for a chunk's cues to be ready this many milliseconds before it plays. Playback is assumed to start when the first result returns and to run in real time. |
| `maxWaitMs` | `2000` | Longest any chunk waits for lookahead, in milliseconds. |
| `maxConcurrent` | `2` | Analyses of this stream running at once (windowed mode only). Needs at least this many started pool workers to run in parallel. |
| `maxBatchMs` | `3000` | Most chunk audio covered by one batched analysis, in milliseconds. Batches are also kept small enough to finish before their first chunk plays. |

With `contextMs` and `lookaheadMs` both `0`, chunks are analyzed separately; with either set, the analyzer works in windowed mode (see [StreamAnalyzerController](#streamanalyzercontroller)). Recommended: `{ contextMs: 500, lookaheadMs: 500 }`. See [Context and Lookahead](./streaming-analysis.md#context-and-lookahead) and the measurements in [BENCHMARK.md](../BENCHMARK.md#mouth-cue-quality).

### `WasmLoaderOptions`

Where to load the engine from. Used by `LipSyncEngine.init()` and `WasmLoader`.

```typescript
interface WasmLoaderOptions {
  wasmPath?: string;               // URL of the .wasm file
  dataPath?: string;               // URL of the .data (model) file
  jsPath?: string;                 // URL of the .js loader
  wasmModule?: WebAssembly.Module; // already compiled .wasm (skips its download and compile)
  dataBuffer?: ArrayBuffer;        // contents of the .data file (skips its download; used once)
}
```

Paths default to the [default asset URLs](#default-asset-urls).

### `PrewarmMode`

When pool workers build their speech decoder. See the `prewarm` option of [`WorkerPool.init()`](#initoptions-1).

```typescript
type PrewarmMode = boolean | 'first';
```

### `RecognizerKind`

Speech recognizer used by pool workers. See the `recognizer` option of [`WorkerPool.init()`](#initoptions-1).

```typescript
type RecognizerKind = 'pocketsphinx' | 'phonetic';
```

- `'pocketsphinx'` (default): recognizes words with a language model, then aligns phones. Uses `dialogText` when given.
- `'phonetic'`: recognizes phones without words. Faster and lighter, with clearly worse mouth shapes. Ignores `dialogText`.

### `LipSyncEngineModule`

Low-level interface to the compiled engine, returned by `WasmLoader.load()` and `WasmLoader.loadModule()`. `LipSyncEngine` and the pool's workers call it for you; apps normally do not use it directly.

## Mouth Shapes

`MouthCue.value` is one of Rhubarb Lip Sync's mouth shapes. A to F are the basic Hanna-Barbera shapes. G, H, and X are extended shapes, returned only when `extendedShapes` includes them (the default `'GHX'` includes all three). For an image and example sounds for each shape, see [Mouth Shapes in the README](../README.md#mouth-shapes).

- `A`: Closed (M, B, P)
- `B`: Clenched teeth
- `C`: Open
- `D`: Wide open
- `E`: Rounded
- `F`: Puckered
- `G`: F/V (upper teeth on lower lip)
- `H`: L (tongue raised)
- `X`: Idle
