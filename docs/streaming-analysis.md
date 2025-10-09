# Streaming Analysis Guide

This guide explains how to use the `StreamAnalyzerController` for dynamic, real-time audio chunk processing with minimal main thread overhead.

## Overview

The `StreamAnalyzerController` allows you to:
- **Add chunks dynamically** as they arrive from a stream
- **Queue jobs immediately** without blocking the main thread
- **Process chunks in parallel** across multiple Web Workers
- **Maintain insertion order** in the final results

## Quick Start

```typescript
import { WorkerPool } from 'lip-sync-engine';

const pool = WorkerPool.getInstance(4); // 4 workers
await pool.init({ /* paths */ });
await pool.warmup(); // Pre-create all workers

const stream = pool.createStreamAnalyzer({
  dialogText: "Expected dialog text",
  sampleRate: 16000
});

// Add chunks as they arrive
for await (const chunk of audioStream) {
  stream.addChunk(chunk); // Non-blocking, returns immediately
}

// Get all results in order
const results = await stream.finalize();
```

## API Reference

### `WorkerPool.createStreamAnalyzer(options)`

Creates a new streaming analyzer controller.

**Parameters:**
- `options` - `LipSyncEngineOptions` - Configuration applied to all chunks

**Returns:** `StreamAnalyzerController`

### `StreamAnalyzerController.addChunk(chunk)`

Queues a chunk for analysis. Returns immediately without blocking.

**Parameters:**
- `chunk` - `Int16Array` - Audio chunk to analyze

**Returns:** `number` - Index of this chunk in the result array

**Example:**
```typescript
const index = stream.addChunk(audioChunk);
console.log(`Queued chunk ${index}`);
```

### `StreamAnalyzerController.finalize()`

Waits for all chunks to complete and returns results in insertion order.

**Returns:** `Promise<LipSyncEngineResult[]>`

**Example:**
```typescript
const results = await stream.finalize();
console.log(`Processed ${results.length} chunks`);
```

### `StreamAnalyzerController.getStats()`

Returns current streaming statistics.

**Returns:**
```typescript
{
  chunksAdded: number;        // Total chunks added
  chunksCompleted: number;    // Chunks that finished processing
  poolStats: {                // WorkerPool statistics
    totalWorkers: number;
    busyWorkers: number;
    idleWorkers: number;
    queuedJobs: number;
    maxWorkers: number;
  }
}
```

## Usage Patterns

### Pattern 1: Async Iterator (For Await)

Perfect for async generators and streams:

```typescript
const stream = pool.createStreamAnalyzer({ sampleRate: 16000 });

for await (const chunk of audioStream) {
  stream.addChunk(chunk);
}

const results = await stream.finalize();
```

### Pattern 2: Event-Driven (WebSocket)

Perfect for event-based APIs:

```typescript
const stream = pool.createStreamAnalyzer({ sampleRate: 16000 });

ws.addEventListener('message', (event) => {
  const chunk = new Int16Array(event.data);
  stream.addChunk(chunk);
});

ws.addEventListener('close', async () => {
  const results = await stream.finalize();
  console.log('Stream complete:', results);
});
```

### Pattern 3: MediaRecorder Integration

Perfect for live audio recording:

```typescript
const stream = pool.createStreamAnalyzer({ sampleRate: 16000 });

mediaRecorder.addEventListener('dataavailable', async (event) => {
  const pcm16 = await convertBlobToPCM16(event.data);
  stream.addChunk(pcm16);
});

mediaRecorder.addEventListener('stop', async () => {
  const results = await stream.finalize();
  // Process results
});

mediaRecorder.start(1000); // 1 second chunks
```

### Pattern 4: Real-Time Feedback

Monitor progress as chunks are processed:

```typescript
const stream = pool.createStreamAnalyzer({ sampleRate: 16000 });

const interval = setInterval(() => {
  const stats = stream.getStats();
  console.log(`Progress: ${stats.chunksAdded} queued, ${stats.poolStats.busyWorkers} workers busy`);
}, 500);

for await (const chunk of audioStream) {
  stream.addChunk(chunk);
}

clearInterval(interval);
const results = await stream.finalize();
```

## Performance Best Practices

### 1. Pre-warm the Worker Pool

Create all workers upfront to avoid initialization overhead:

```typescript
const pool = WorkerPool.getInstance(4);
await pool.init({ /* paths */ });
await pool.warmup(); // Creates all 4 workers immediately

const stream = pool.createStreamAnalyzer({ /* options */ });
```

### 2. Choose Optimal Worker Count

Match worker count to your CPU cores and workload:

```typescript
// Auto-detect CPU cores
const pool = WorkerPool.getInstance(navigator.hardwareConcurrency);

// Or set explicitly
const pool = WorkerPool.getInstance(4); // 4 workers
```

### 3. Chunk Size Matters

Optimal chunk size balances throughput and latency:

```typescript
// Too small: High overhead from worker communication
const tooSmall = new Int16Array(1000); // ~60ms at 16kHz

// Optimal: 1-3 seconds of audio
const optimal = new Int16Array(16000 * 2); // 2 seconds at 16kHz

// Too large: Reduces parallelism potential
const tooLarge = new Int16Array(16000 * 30); // 30 seconds
```

### 4. Monitor Queue Depth

Check if workers are keeping up with incoming chunks:

```typescript
stream.addChunk(chunk);

const stats = stream.getStats();
if (stats.poolStats.queuedJobs > 10) {
  console.warn('Queue is backing up - consider more workers');
}
```

## Comparison: Static vs Streaming

### Static (analyzeChunks)
```typescript
// All chunks must be known upfront
const chunks = [chunk1, chunk2, chunk3];
const results = await pool.analyzeChunks(chunks);
```

**Use when:**
- You have all chunks available upfront
- Processing pre-recorded audio files
- Simple batch processing

### Streaming (createStreamAnalyzer)
```typescript
// Add chunks as they arrive
const stream = pool.createStreamAnalyzer();
for await (const chunk of liveStream) {
  stream.addChunk(chunk); // Dynamic!
}
const results = await stream.finalize();
```

**Use when:**
- Chunks arrive over time from a stream
- Processing live audio (WebSocket, MediaRecorder, etc.)
- Real-time applications
- You want minimal main thread blocking

## Advanced: Progress Callbacks

Track individual chunk completion:

```typescript
const stream = pool.createStreamAnalyzer({ sampleRate: 16000 });
const completed: LipSyncEngineResult[] = [];

// Add chunks with individual result tracking
for await (const chunk of audioStream) {
  const index = stream.addChunk(chunk);

  // Get result as soon as THIS chunk completes (optional)
  pool.analyze(chunk, { sampleRate: 16000 }).then(result => {
    console.log(`Chunk ${index} completed:`, result.mouthCues);
    completed.push(result);
  });
}

// Or just wait for all at once
const results = await stream.finalize();
```

## Error Handling

```typescript
const stream = pool.createStreamAnalyzer({ sampleRate: 16000 });

try {
  for await (const chunk of audioStream) {
    stream.addChunk(chunk);
  }

  const results = await stream.finalize();
} catch (error) {
  console.error('Analysis failed:', error);
}
```

**Note:** If any chunk fails, `finalize()` will reject with that error. Individual chunk errors don't affect other chunks in the queue.

## Complete Example

```typescript
import { WorkerPool } from 'lip-sync-engine';

async function processLiveAudio() {
  // 1. Initialize pool
  const pool = WorkerPool.getInstance(4);
  await pool.init({
    wasmPath: '/dist/wasm/lip-sync-engine.wasm',
    dataPath: '/dist/wasm/lip-sync-engine.data',
    jsPath: '/dist/wasm/lip-sync-engine.js',
    workerScriptUrl: '/dist/worker.js'
  });

  // 2. Pre-create workers
  await pool.warmup();

  // 3. Create streaming analyzer
  const stream = pool.createStreamAnalyzer({
    dialogText: "Expected dialog",
    sampleRate: 16000
  });

  // 4. Process chunks as they arrive
  const ws = new WebSocket('wss://audio-stream.example.com');

  ws.addEventListener('message', (event) => {
    const chunk = new Int16Array(event.data);
    stream.addChunk(chunk);

    // Monitor progress
    const stats = stream.getStats();
    console.log(`Queue: ${stats.chunksAdded}, Workers: ${stats.poolStats.busyWorkers}/${stats.poolStats.totalWorkers}`);
  });

  // 5. Get results when stream ends
  ws.addEventListener('close', async () => {
    const results = await stream.finalize();
    console.log(`Analyzed ${results.length} chunks`);

    // Combine all mouth cues
    const allMouthCues = results.flatMap(r => r.mouthCues);
    console.log('Total mouth cues:', allMouthCues.length);

    pool.destroy();
  });
}
```

## See Also

- [API Reference](./api-reference.md) - Complete API documentation
- [Worker Usage](./worker-usage.md) - Web Worker details
- [Examples](../examples/) - Complete working examples
