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

**Default CDN URLs:**
- `https://unpkg.com/lip-sync-engine@1.0.3/dist/wasm/lip-sync-engine.wasm`
- `https://unpkg.com/lip-sync-engine@1.0.3/dist/wasm/lip-sync-engine.data`
- `https://unpkg.com/lip-sync-engine@1.0.3/dist/wasm/lip-sync-engine.js`

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

Analyze audio using Web Worker (non-blocking).

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

Clean up resources and destroy the instance.

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
  createStreamAnalyzer(options?: LipSyncEngineOptions): StreamAnalyzerController
  getStats(): WorkerPoolStats
  destroy(): void
}
```

#### `getInstance(maxWorkers?, workerScriptUrl?)`

Get the singleton WorkerPool instance.

**Parameters:**
- `maxWorkers?: number` - Maximum number of workers (default: `navigator.hardwareConcurrency` or 4)
- `workerScriptUrl?: string` - Custom worker script URL (default: '/dist/worker.js')

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

Initialize the worker pool. Must be called before analysis.

**Parameters:**
- `options?: WorkerPoolInitOptions` - Worker initialization options (defaults to unpkg CDN)
  - `wasmPath?: string` - Path to WASM file
  - `dataPath?: string` - Path to data file
  - `jsPath?: string` - Path to JS loader file
  - `workerScriptUrl?: string` - Path to worker script

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
- WASM: `https://unpkg.com/lip-sync-engine@1.0.3/dist/wasm/lip-sync-engine.wasm`
- Data: `https://unpkg.com/lip-sync-engine@1.0.3/dist/wasm/lip-sync-engine.data`
- JS: `https://unpkg.com/lip-sync-engine@1.0.3/dist/wasm/lip-sync-engine.js`
- Worker: `https://unpkg.com/lip-sync-engine@1.0.3/dist/worker.js`

#### `warmup()`

Pre-create all workers up to maxWorkers. Call during app initialization to eliminate worker creation overhead for streaming workloads.

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
- ✅ Decoder reuse - 500-700ms faster after first call
- ✅ Automatic worker management
- ✅ Zero-copy buffer transfer (when possible)

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
- 🚀 Parallel processing across multiple workers
- ⚡ ~5x faster for 5 chunks (vs sequential)
- 🎯 Automatic load balancing

**Example:**
```typescript
// Split long audio into 5-second chunks
const chunkSize = 16000 * 5; // 5 seconds at 16kHz
const chunks: Int16Array[] = [];

for (let i = 0; i < fullAudio.length; i += chunkSize) {
  chunks.push(fullAudio.slice(i, i + chunkSize));
}

// Process all chunks in parallel
const results = await pool.analyzeChunks(chunks, {
  dialogText: "Dialog for all chunks"
});

// Combine results
const allCues = results.flatMap(r => r.mouthCues);
```

#### `createStreamAnalyzer(options?)`

Create a streaming analyzer for dynamic, real-time chunk processing. Perfect for live audio streams, WebSockets, or MediaRecorder.

**Parameters:**
- `options?: LipSyncEngineOptions` - Analysis options (applied to all chunks)

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
  dialogText: "Expected dialog",
  sampleRate: 16000
});

// Add chunks as they arrive (non-blocking!)
for await (const chunk of audioStream) {
  stream.addChunk(chunk); // Returns immediately
}

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

Terminate all workers and clean up resources.

**Example:**
```typescript
// Clean up when done
pool.destroy();
```

---

### StreamAnalyzerController

Controller for dynamic streaming analysis. Created via `WorkerPool.createStreamAnalyzer()`.

```typescript
class StreamAnalyzerController {
  addChunk(chunk: Int16Array): number
  async finalize(): Promise<LipSyncEngineResult[]>
  getStats(): StreamAnalyzerStats
}
```

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
- `chunksCompleted: number` - Chunks that finished processing
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
  value: string;  // Mouth shape: X, A, B, C, D, E, F, G, or H
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

### `LipSyncEngineOptions`

Options for lip-sync analysis.

```typescript
interface LipSyncEngineOptions {
  dialogText?: string;  // Optional dialog text for better accuracy
  sampleRate?: number;  // Sample rate (default: 16000, recommended: 16000)
}
```

### `WasmLoaderOptions`

Options for WASM loading.

```typescript
interface WasmLoaderOptions {
  wasmPath?: string;  // Path to .wasm file
  dataPath?: string;  // Path to .data file
  jsPath?: string;    // Path to .js file
}
```

## Mouth Shape Reference

| Value | Name | Description | Phonemes |
|-------|------|-------------|----------|
| X | Closed/Rest | Mouth closed or at rest | Silence |
| A | Open | Mouth wide open | AH, AA, AO, AW |
| B | Lips Together | Lips pressed together | P, B, M |
| C | Rounded | Lips rounded | SH, CH, JH, ZH |
| D | Tongue-Teeth | Tongue touching teeth | TH, DH, T, D, N, L |
| E | Slightly Open | Slightly open | EH, AE, UH, ER |
| F | F/V Sound | Lower lip touching upper teeth | F, V |
| G | Open Back | Open with tongue back | K, G, NG |
| H | Wide Open | Wide open with spread lips | IY, IH, EY, AY |

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

Clean up when done:

```typescript
const lipSyncEngine = LipSyncEngine.getInstance();
await lipSyncEngine.init();

// Use it...
const result = await lipSyncEngine.analyze(pcm16);

// Clean up when completely done
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
