# API Reference

Complete API documentation for lip-sync-engine.

## Core Classes

### LipSyncEngine

Main singleton class for lip-sync analysis.

```typescript
class LipSyncEngine {
  static getInstance(): LipSyncEngine
  async init(options?: WasmLoaderOptions): Promise<void>
  async analyze(pcm16: Int16Array, options?: LipSyncEngineOptions): Promise<LipSyncEngineResult>
  async analyzeAsync(pcm16: Int16Array, options?: LipSyncEngineOptions): Promise<LipSyncEngineResult>
  destroy(): void
}
```

#### `getInstance()`

Get the singleton instance.

**Returns:** `LipSyncEngine` - The singleton instance

**Example:**
```typescript
const lipSyncEngine = LipSyncEngine.getInstance();
```

#### `init(options?)`

Initialize the WASM module. Must be called before analysis.

**Parameters:**
- `options?: WasmLoaderOptions` - Optional WASM file paths (defaults to unpkg CDN)

**Returns:** `Promise<void>`

**Example:**
```typescript
// Use default CDN paths (recommended)
await lipSyncEngine.init();

// Or with custom self-hosted paths
await lipSyncEngine.init({
  wasmPath: '/custom/path/lip-sync-engine.wasm',
  dataPath: '/custom/path/lip-sync-engine.data',
  jsPath: '/custom/path/lip-sync-engine.js'
});
```

**Default CDN URLs** (`<version>` is the installed package version):
- `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.wasm`
- `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.data`
- `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.js`

#### `analyze(pcm16, options?)`

Analyze audio and generate lip-sync data (blocking).

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer (mono)
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Throws:**
- `TypeError` - If pcm16 is not an Int16Array
- `Error` - If buffer is empty or analysis fails

**Example:**
```typescript
const result = await lipSyncEngine.analyze(pcm16, {
  dialogText: "Hello world",
  sampleRate: 16000
});
```

#### `analyzeAsync(pcm16, options?)`

Analyze audio in a Web Worker (non-blocking), using the shared `WorkerPool`. Starts the pool with its own settings if it is not running yet (CDN paths by default). Paths passed to `LipSyncEngine.init()` are not used; to self-host, call `WorkerPool.getInstance().init({ ...paths, workerScriptUrl })` first.

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer (mono)
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Example:**
```typescript
const result = await lipSyncEngine.analyzeAsync(pcm16, {
  dialogText: "Hello world"
});
```

#### `destroy()`

Drops this instance; the next `getInstance()` returns a new one. The loaded WASM module and its memory stay cached and are reused by later instances (call `WasmLoader.reset()` as well to let them be garbage-collected).

**Example:**
```typescript
lipSyncEngine.destroy();
```

---

### WorkerPool

Worker pool for non-blocking, parallel lip-sync analysis in Web Workers.

```typescript
class WorkerPool {
  static getInstance(maxWorkers?: number, workerScriptUrl?: string): WorkerPool
  async init(options?: WorkerPoolInitOptions): Promise<void>
  async warmup(): Promise<void>
  async analyze(pcm16: Int16Array, options?: LipSyncEngineOptions): Promise<LipSyncEngineResult>
  async analyzeChunks(chunks: Int16Array[], options?: LipSyncEngineOptions): Promise<LipSyncEngineResult[]>
  createStreamAnalyzer(options?: StreamAnalyzerOptions): StreamAnalyzerController
  getStats(): WorkerPoolStats
  async getMemoryStats(): Promise<{ workers: number[]; totalBytes: number }>
  destroy(): void
}
```

`WorkerPoolInitOptions`, `WorkerPoolStats` and `StreamAnalyzerStats` are names used in this document only; they are not exported. In TypeScript use `Parameters<WorkerPool['init']>[0]`, `ReturnType<WorkerPool['getStats']>` and `ReturnType<StreamAnalyzerController['getStats']>`. Exported option types: `PrewarmMode`, `RecognizerKind`, `StreamAnalyzerOptions`.

#### `getInstance(maxWorkers?, workerScriptUrl?)`

Get the singleton WorkerPool instance.

**Parameters:**
- `maxWorkers?: number` - Maximum number of workers (default: `navigator.hardwareConcurrency` or 4)
- `workerScriptUrl?: string` - Custom worker script URL (default: `https://unpkg.com/lip-sync-engine@<version>/dist/worker.js`)

**Returns:** `WorkerPool` - The singleton instance

**Example:**
```typescript
// Default: auto-detect CPU cores
const pool = WorkerPool.getInstance();

// Custom: limit to 2 workers
const pool = WorkerPool.getInstance(2);

// Custom worker URL
const pool = WorkerPool.getInstance(4, '/custom/worker.js');
```

#### `init(options?)`

Initialize the worker pool. Must be called before analysis. Starts one worker; use `warmup()` to start the rest.

Concurrent calls share one startup, and the options of the first call apply. If `destroy()` is called before startup finishes, the promise rejects with [`WorkerPoolDestroyedError`](#workerpooldestroyederror).

**Parameters:**
- `options?: WorkerPoolInitOptions` - Worker initialization options (defaults to unpkg CDN)
  - `wasmPath?: string` - Path to WASM file
  - `dataPath?: string` - Path to data file
  - `jsPath?: string` - Path to JS loader file
  - `workerScriptUrl?: string` - Path to worker script
  - `prewarm?: boolean | 'first'` - When each worker builds its speech decoder (the acoustic model, dictionary and language model; about 0.5 s of CPU per worker). Since 2.0.0.
    - `true` (default): during `init()`/`warmup()`, so no analysis pays for it.
    - `'first'`: only the `init()` worker; `warmup()` workers build it on their first job. Jobs go to workers that already have a decoder first.
    - `false`: on each worker's first job (1.0.x timing).
  - `shareAssets?: boolean` - Compile the `.wasm` only once: the first worker sends its compiled module back, and later workers (and pools created later) reuse it (default `true`). Since 2.0.0.
  - `recognizer?: 'pocketsphinx' | 'phonetic'` - Speech recognizer for all workers (default `'pocketsphinx'`). `'phonetic'` recognizes phones without words: about 3x less CPU, about 60 MB less memory per worker and a much faster first chunk, but clearly worse mouth shapes (about 62% frame agreement against 87% in the streaming benchmark) and it ignores `dialogText`. Use it only on devices that cannot keep up otherwise. Since 2.0.0.

**Returns:** `Promise<void>`

**Example:**
```typescript
// Use default CDN paths (recommended)
await pool.init();

// Or with custom self-hosted paths
await pool.init({
  wasmPath: '/dist/wasm/lip-sync-engine.wasm',
  dataPath: '/dist/wasm/lip-sync-engine.data',
  jsPath: '/dist/wasm/lip-sync-engine.js',
  workerScriptUrl: '/dist/worker.js'
});
```

**Default CDN URLs:**
- WASM: `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.wasm`
- Data: `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.data`
- JS: `https://unpkg.com/lip-sync-engine@<version>/dist/wasm/lip-sync-engine.js`
- Worker: `https://unpkg.com/lip-sync-engine@<version>/dist/worker.js`

**Keep the pool alive.** Since 2.0.0 a worker keeps its speech decoder between calls, so only pool start-up pays for building it. Destroying and re-creating the pool for every utterance pays that cost again each time. (In 1.0.x each call rebuilt the decoder and a worker's memory ran out after roughly 500 calls; that no longer happens.)

#### `warmup()`

Pre-create all workers up to maxWorkers. Call during app initialization to eliminate worker creation overhead for streaming workloads.

Rejects as soon as one worker fails to start. Workers that started successfully stay in the pool, and calling `warmup()` again only starts the missing ones. Concurrent calls share one warmup. Rejects with `Error('WorkerPool not initialized. Call init() first.')` if `init()` has not finished, and with [`WorkerPoolDestroyedError`](#workerpooldestroyederror) if `destroy()` is called before it finishes.

**Returns:** `Promise<void>`

**Example:**
```typescript
await pool.init({ /* paths */ });
await pool.warmup(); // Creates all workers upfront
// Now all workers are ready for immediate chunked processing
```

#### `analyze(pcm16, options?)`

Analyze audio in a Web Worker (non-blocking).

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer (mono)
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Benefits:**
- ✅ Non-blocking - UI stays responsive
- ✅ Decoder reuse - each worker builds its speech decoder once (during `init()`/`warmup()` by default), saving about 0.4 s per call compared with 1.x
- ✅ Automatic worker management
- ✅ Your buffer is copied and the copy is transferred to the worker, so your array stays usable

**Example:**
```typescript
// Analyze without blocking UI
const result = await pool.analyze(pcm16, {
  dialogText: "Hello world",
  sampleRate: 16000
});

console.log(result.mouthCues);
```

#### `analyzeChunks(chunks, options?)`

Analyze multiple audio chunks in parallel using worker pool.

**Parameters:**
- `chunks: Int16Array[]` - Array of audio chunks to process
- `options?: LipSyncEngineOptions` - Analysis options (applied to all chunks)

**Returns:** `Promise<LipSyncEngineResult[]>` - Results in same order as input

**Performance:**
- 🚀 Runs in parallel across the workers that have started. `init()` starts one; call `await pool.warmup()` to start up to `maxWorkers`. The speed-up is limited by started workers and CPU cores.
- 🎯 Automatic load balancing
- Each chunk is analysed on its own (no context across chunks); for streaming speech use `createStreamAnalyzer()` with `contextMs`/`lookaheadMs`.

**Example:**
```typescript
// Split long audio into 5-second chunks
const chunkSize = 16000 * 5; // 5 seconds at 16kHz
const chunks: Int16Array[] = [];

for (let i = 0; i < fullAudio.length; i += chunkSize) {
  chunks.push(fullAudio.slice(i, i + chunkSize));
}

// Process all chunks in parallel (start all workers first)
await pool.warmup();
const results = await pool.analyzeChunks(chunks, {
  dialogText: "Dialog for all chunks"
});

// Combine results: each chunk's cue times start at 0, so add offsets
let offset = 0;
const allCues = results.flatMap((r, i) => {
  const cues = r.mouthCues.map(c => ({ ...c, start: c.start + offset, end: c.end + offset }));
  offset += chunks[i].length / 16000;
  return cues;
});
```

#### `createStreamAnalyzer(options?)`

Create a streaming analyzer for dynamic, real-time chunk processing. Perfect for live audio streams, WebSockets, or MediaRecorder.

**Parameters:**
- `options?: StreamAnalyzerOptions` - `LipSyncEngineOptions` applied to all chunks, plus the windowing options in [`StreamAnalyzerOptions`](#streamanalyzeroptions)

**Returns:** `StreamAnalyzerController`

**Use Cases:**
- 🎙️ Live audio streams (WebSocket, MediaRecorder)
- 📡 Real-time processing with minimal main thread overhead
- 🔄 Dynamic chunk arrival (don't need all chunks upfront)
- ⚡ Maximum parallelism with pre-warmed workers

**Example:**
```typescript
await pool.warmup(); // Pre-create workers

const stream = pool.createStreamAnalyzer({
  sampleRate: 16000,
  contextMs: 500,   // earlier audio analysed with each chunk
  lookaheadMs: 500  // later audio, waited for only while playback allows
});

// Add chunks as they arrive (non-blocking!)
for await (const chunk of audioStream) {
  stream.addChunk(chunk); // Returns immediately
}
stream.end(); // no more audio

// Get all results in order
const results = await stream.finalize();
```

See [Streaming Analysis Guide](./streaming-analysis.md) for detailed usage patterns.

#### `getStats()`

Get worker pool statistics.

**Returns:** `WorkerPoolStats`
- `totalWorkers: number` - Total workers created
- `busyWorkers: number` - Workers currently processing
- `idleWorkers: number` - Workers available
- `queuedJobs: number` - Jobs waiting for worker
- `maxWorkers: number` - Maximum workers configured

**Example:**
```typescript
const stats = pool.getStats();
console.log(`Workers: ${stats.busyWorkers}/${stats.totalWorkers} busy`);
console.log(`Queue: ${stats.queuedJobs} jobs waiting`);
```

#### `destroy()`

Terminate all workers, including workers that are still starting, and clean up resources. Pending `init()`, `warmup()`, and analysis promises reject with [`WorkerPoolDestroyedError`](#workerpooldestroyederror). In a stream analyzer using `contextMs`/`lookaheadMs`, chunks not yet sent to a worker reject with `Error('WorkerPool not initialized...')` instead. The next `getInstance()` call returns a new pool.

**Example:**
```typescript
// Clean up when done
pool.destroy();
```

#### `getMemoryStats()`

WebAssembly memory size of each worker, in bytes. Since 2.0.0. Each worker also holds a copy of the model file (about 39 MB) and its JS heap on top of this.

```typescript
const { workers, totalBytes } = await pool.getMemoryStats();
```

---

### WorkerPoolDestroyedError

Error used to reject pending `init()`, `warmup()`, and analysis promises when `destroy()` is called. Its `name` is `'WorkerPoolDestroyedError'`. Ignore it when destroying the pool during cleanup, for example when a component unmounts while the pool is still starting.

```typescript
import { WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';

pool.init().catch(error => {
  if (error instanceof WorkerPoolDestroyedError) return; // Cancelled by destroy()
  console.error('WorkerPool failed to start:', error);
});
```

If a worker crashes during analysis, the job it was running rejects. If every worker has failed, queued jobs reject and the pool must be started again with `init()`.

---

### StreamAnalyzerController

Controller for dynamic streaming analysis. Created via `WorkerPool.createStreamAnalyzer(options)`.

```typescript
class StreamAnalyzerController {
  addChunk(chunk: Int16Array): number
  getResult(index: number): Promise<LipSyncEngineResult>   // 2.0.0
  end(): void                                               // 2.0.0
  async finalize(): Promise<LipSyncEngineResult[]>
  getStats(): StreamAnalyzerStats
}
```

#### `StreamAnalyzerOptions`

Everything in `LipSyncEngineOptions`, plus (all since 2.0.0, all optional):

| Option | Default | Meaning |
|---|---|---|
| `contextMs` | `0` | Earlier audio analysed together with each chunk. |
| `lookaheadMs` | `0` | Later audio to wait for and analyse together with each chunk. |
| `firstChunkLookahead` | `false` | Also wait for lookahead before the first chunk. |
| `deadlineMarginMs` | `150` | Lookahead waiting stops early enough for a chunk's cues to be ready this long before it plays (assuming playback starts when the first result returns and runs in real time). |
| `maxWaitMs` | `2000` | Upper limit on any chunk's wait for lookahead. |
| `maxConcurrent` | `2` | Analyses of this stream running at once (windowed mode only). |
| `maxBatchMs` | `3000` | Most audio covered by one batched analysis. Batches are also kept small enough to finish before their first chunk plays. |

With `contextMs` and `lookaheadMs` both `0`, every chunk is analysed on its own, as in 1.0.x. With either set, each chunk is analysed inside a window of the surrounding audio and only that chunk's cues are returned, with times relative to the chunk start. Chunks that are ready at the same time share one analysis. For short streaming chunks this matters a lot for quality; `{ contextMs: 500, lookaheadMs: 500 }` is the measured recommendation (see `BENCHMARK.md`).

#### `getResult(index)`

Promise for one chunk's result. Use it to play each chunk as soon as its cues are ready.

#### `end()`

Tells the controller no more audio is coming, so chunks waiting for lookahead are analysed straight away. Call it when the utterance's audio is complete. `finalize()` calls it too. After `end()` (or `finalize()`), `addChunk()` throws.

#### `addChunk(chunk)`

Add a chunk to be analyzed. Immediately queues the chunk for processing without blocking the main thread.

**Parameters:**
- `chunk: Int16Array` - Audio chunk to analyze

**Returns:** `number` - Index of this chunk in the result array

**Example:**
```typescript
const stream = pool.createStreamAnalyzer({ sampleRate: 16000 });

// Add chunks as they arrive
const index = stream.addChunk(audioChunk);
console.log(`Queued chunk ${index}`);
```

#### `finalize()`

Wait for all chunks to complete and return results in insertion order.

**Returns:** `Promise<LipSyncEngineResult[]>` - Array of results in order chunks were added

**Example:**
```typescript
// Add all chunks
for (const chunk of chunks) {
  stream.addChunk(chunk);
}

// Wait for completion
const results = await stream.finalize();
console.log(`Processed ${results.length} chunks`);
```

#### `getStats()`

Get current streaming statistics.

**Returns:** `StreamAnalyzerStats`
- `chunksAdded: number` - Total chunks added so far
- `chunksCompleted: number` - Chunks that finished processing, successfully or with an error
- `poolStats: WorkerPoolStats` - Underlying pool statistics

**Example:**
```typescript
const stats = stream.getStats();
console.log(`Progress: ${stats.chunksAdded} queued`);
console.log(`Workers: ${stats.poolStats.busyWorkers}/${stats.poolStats.totalWorkers} busy`);
```

---

## Convenience Functions

### `analyze(pcm16, options?)`

One-off analysis without managing instance.

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Example:**
```typescript
import { analyze } from 'lip-sync-engine';

const result = await analyze(pcm16, {
  dialogText: "Hello world",
  sampleRate: 16000
});
```

### `analyzeAsync(pcm16, options?)`

One-off async analysis with Web Worker.

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Example:**
```typescript
import { analyzeAsync } from 'lip-sync-engine';

const result = await analyzeAsync(pcm16, {
  dialogText: "Hello world"
});
```

## Audio Utilities

### `recordAudio(durationMs, sampleRate?)`

Record audio from microphone.

**Parameters:**
- `durationMs: number` - Recording duration in milliseconds
- `sampleRate?: number` - Target sample rate (default: 16000)

**Returns:** `Promise<{ pcm16: Int16Array, audioBuffer: AudioBuffer }>`

**Example:**
```typescript
import { recordAudio } from 'lip-sync-engine';

// Record 5 seconds
const { pcm16, audioBuffer } = await recordAudio(5000);
```

### `loadAudio(source, targetSampleRate?)`

Load audio from URL or File.

**Parameters:**
- `source: string | File` - URL or File object
- `targetSampleRate?: number` - Target sample rate (default: 16000)

**Returns:** `Promise<{ pcm16: Int16Array, audioBuffer: AudioBuffer }>`

**Example:**
```typescript
import { loadAudio } from 'lip-sync-engine';

// From URL
const { pcm16 } = await loadAudio('https://example.com/audio.mp3');

// From File input
const file = event.target.files[0];
const { pcm16 } = await loadAudio(file);
```

### `audioBufferToInt16(audioBuffer, targetSampleRate?)`

Convert AudioBuffer to Int16Array PCM.

**Parameters:**
- `audioBuffer: AudioBuffer` - Web Audio API AudioBuffer
- `targetSampleRate?: number` - Target sample rate (default: 16000)

**Returns:** `Int16Array`

**Example:**
```typescript
import { audioBufferToInt16 } from 'lip-sync-engine';

const pcm16 = audioBufferToInt16(audioBuffer, 16000);
```

### `float32ToInt16(float32)`

Convert Float32Array to Int16Array PCM.

**Parameters:**
- `float32: Float32Array` - Float32 audio data

**Returns:** `Int16Array`

**Example:**
```typescript
import { float32ToInt16 } from 'lip-sync-engine';

const int16 = float32ToInt16(float32Data);
```

### `resample(input, fromRate, toRate)`

Resample audio to different sample rate.

**Parameters:**
- `input: Float32Array` - Input audio samples
- `fromRate: number` - Source sample rate
- `toRate: number` - Target sample rate

**Returns:** `Float32Array`

**Example:**
```typescript
import { resample } from 'lip-sync-engine';

const resampled = resample(float32Data, 44100, 16000);
```

## Types

### `MouthCue`

Represents a single mouth shape with timing.

```typescript
interface MouthCue {
  start: number;  // Start time in seconds
  end: number;    // End time in seconds
  value: string;  // Mouth shape: A-H or X (A-F only with extendedShapes: '')
}
```

### `LipSyncEngineResult`

Result of lip-sync analysis.

```typescript
interface LipSyncEngineResult {
  mouthCues: MouthCue[];
  metadata?: {
    duration: number;      // Total duration in seconds
    sampleRate: number;    // Sample rate used
    dialogText?: string;   // Dialog text (if provided)
  };
}
```

`metadata` is filled with `duration`, `sampleRate` and `dialogText` by `LipSyncEngine.analyze()` only. `WorkerPool` results carry the engine's own `{ soundFile, duration }`, and in windowed stream results `duration` is the analysed window's. Use `mouthCues` for timing.

### `LipSyncEngineOptions`

Options for lip-sync analysis.

```typescript
interface LipSyncEngineOptions {
  dialogText?: string;      // Optional dialog text for better accuracy
  sampleRate?: number;      // Sample rate (default: 16000, recommended: 16000)
  extendedShapes?: string;  // Since 2.0.0. Extra Rhubarb shapes on top of A-F:
                            // any of 'G' (F, V), 'H' (L), 'X' (idle).
                            // Default 'GHX' (all nine). '' = A-F only, as in 1.x
}
```

### `WasmLoaderOptions`

Options for WASM loading.

```typescript
interface WasmLoaderOptions {
  wasmPath?: string;                // Path to .wasm file
  dataPath?: string;                // Path to .data file
  jsPath?: string;                  // Path to .js file
  wasmModule?: WebAssembly.Module;  // Already compiled .wasm (skips download and compile). Since 2.0.0
  dataBuffer?: ArrayBuffer;         // Contents of the .data file (skips its download; used once). Since 2.0.0
}
```

## Mouth Shape Reference

| Value | Name | Description | Phonemes |
|-------|------|-------------|----------|
| X | Idle | Mouth at rest | Silence, pauses |
| A | Closed | Lips pressed together | M, B, P |
| B | Clenched teeth | Slightly open, teeth together | Most consonants (K, S, T), EE |
| C | Open | Mouth open | EH, AH, EY (men, sun, say) |
| D | Wide open | Mouth wide open | AA, AE, AY (father, bat, why) |
| E | Rounded | Slightly rounded | AO, ER (off) |
| F | Puckered | Lips puckered | UW, OW, W (you, boy, way) |
| G | F/V | Upper teeth on lower lip | F, V |
| H | L | Tongue raised behind teeth | L |

Definitions follow `src/cpp/core/Shape.h`. G, H and X appear only when `extendedShapes` includes them (the default since 2.0.0).

## Best Practices

### Sample Rate

- **Recommended:** 16000 Hz (16kHz)
- **Why:** PocketSphinx is optimized for 16kHz
- **Higher rates:** Will be resampled, may reduce accuracy

### Dialog Text

Always provide dialog text when you know what will be said:

```typescript
// ✅ Good - with dialog text
const result = await analyze(pcm16, {
  dialogText: "Hello world, this is a test"
});

// ❌ Less accurate - without dialog text
const result = await analyze(pcm16);
```

### Memory Management

Call `destroy()` when completely done. The WASM module stays cached for reuse (call `WasmLoader.reset()` too if you want it garbage-collected). For `WorkerPool`, keep the pool alive between utterances and call `pool.destroy()` only when done for good.

```typescript
const lipSyncEngine = LipSyncEngine.getInstance();
await lipSyncEngine.init();

// Use it...
const result = await lipSyncEngine.analyze(pcm16);

// When completely done
lipSyncEngine.destroy();
```

### Async vs Sync

Use `analyzeAsync()` for long audio to avoid blocking UI:

```typescript
// For short audio (< 5 seconds)
const result = await lipSyncEngine.analyze(pcm16);

// For long audio (> 5 seconds) - doesn't block UI
const result = await lipSyncEngine.analyzeAsync(pcm16);
```
