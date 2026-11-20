# Streaming Analysis Guide

How to analyze audio that arrives in chunks (a text-to-speech stream, a WebSocket, a microphone) with `StreamAnalyzerController`, and use each chunk's mouth cues as soon as they are ready. For the full method and option list, see [`StreamAnalyzerController`](./api-reference.md#streamanalyzercontroller) and [`StreamAnalyzerOptions`](./api-reference.md#streamanalyzeroptions) in the API Reference.

## Overview

A stream analyzer is created from a started [`WorkerPool`](./worker-usage.md) and lets you:

- **Add chunks as they arrive.** `addChunk()` returns the chunk's index at once; analysis runs in the pool's workers, not on the main thread.
- **Analyze each chunk with the audio around it.** With `contextMs` and `lookaheadMs` (recommended: 500 each), each chunk is analyzed inside a window of earlier and later audio. See [Context and Lookahead](#context-and-lookahead).
- **Get each chunk's cues as soon as they are ready** with `getResult(index)`, or all of them, in the order the chunks were added, with `finalize()`.

## Quick Start

```typescript
import { WorkerPool } from 'lip-sync-engine';

// Create the pool once and keep it for the session
const pool = WorkerPool.getInstance(2);
await pool.init();
await pool.warmup(); // start the second worker

const SAMPLE_RATE = 16000;

/** Analyzes one utterance: 16 kHz mono Int16Array chunks, in order */
export async function lipSyncStream(audio: AsyncIterable<Int16Array>): Promise<void> {
  const stream = pool.createStreamAnalyzer({
    sampleRate: SAMPLE_RATE,
    contextMs: 500,   // earlier audio analyzed with each chunk
    lookaheadMs: 500  // later audio, waited for only while playback allows
  });

  let offset = 0; // seconds of audio added so far
  for await (const chunk of audio) {
    const index = stream.addChunk(chunk);
    const chunkStart = offset;
    offset += chunk.length / SAMPLE_RATE;

    // Cue times are relative to the chunk start
    stream.getResult(index)
      .then(result => {
        for (const cue of result.mouthCues) {
          console.log(`${(chunkStart + cue.start).toFixed(2)}s: ${cue.value}`);
        }
      })
      .catch(error => console.error(`Chunk ${index} failed:`, error));
  }

  // No more audio: finalize() calls end(), so chunks still waiting for
  // lookahead are analyzed at once, then it waits for every chunk.
  await stream.finalize();
}
```

Use one stream per utterance. Once `end()` or `finalize()` has been called, `addChunk()` throws. If you use only `getResult()`, call `stream.end()` when the utterance's audio is complete, so the last chunks do not wait for lookahead that will never arrive.

## Context and Lookahead

Speech recognition needs the audio around a sound to recognize it. Chunks analyzed on their own lose most mouth shapes, and the mouth often snaps shut at chunk boundaries. With the default nine mouth shapes, chunks of 250 to 1000 ms analyzed alone matched only 31.9% to 65.1% of the frames of a whole-utterance analysis. With `contextMs: 500, lookaheadMs: 500` and audio arriving faster than playback, 85.1% to 86.4% matched ([BENCHMARK.md](../BENCHMARK.md)).

```typescript
import type { StreamAnalyzerOptions } from 'lip-sync-engine';

// Pass to pool.createStreamAnalyzer(options)
const options: StreamAnalyzerOptions = {
  sampleRate: 16000,
  contextMs: 500,   // earlier audio
  lookaheadMs: 500  // later audio
};
```

With either option set, each chunk is analyzed inside a window of the surrounding audio, and its result holds only that chunk's cues, with times relative to the chunk start. The controller schedules the analyses like this:

- **The first chunk is analyzed at once,** without lookahead, so playback can start quickly. Set `firstChunkLookahead: true` to wait for it too.
- **Each later chunk waits for its lookahead,** until `lookaheadMs` of later audio has arrived, `end()` is called, or `maxWaitMs` (default 2000 ms) has passed since it was added, whichever comes first.
- **Waiting aims to stop in time for playback.** The controller assumes playback starts when the first result returns and runs in real time. From a running estimate of analysis speed, it starts each analysis so that it should finish `deadlineMarginMs` (default 150 ms) before the chunk plays, and shortens the lookahead when the full lookahead would not fit. This is best effort, not a guarantee.
- **Chunks that are ready together are batched:** they are analyzed in one window covering all of them (at most `maxBatchMs`, default 3000 ms of chunk audio), which keeps CPU use down.
- **At most `maxConcurrent` analyses (default 2) of a stream run at once.** The pool needs at least that many started workers (`warmup()`) to run them in parallel.

### Limits

- **Chunks shorter than about 250 ms cause stalls.** Playback then starts after very little audio, and every later chunk must be analyzed within that rhythm. With 100 ms chunks the benchmark measured stalls of about 0.3 to 0.9 s per utterance. Join short chunks into chunks of at least 250 ms before adding them.
- **Lookahead needs audio that arrives ahead of playback,** for example from a text-to-speech service that sends audio faster than real time. When audio arrives no faster than real time (a live microphone, for example), the controller's estimated playback deadline for each chunk comes before the chunk's later audio arrives, so chunks are analyzed with their context but little or no lookahead.

### Opting Out

Leave `contextMs` and `lookaheadMs` at their default of `0` to analyze every chunk on its own, as soon as it is added. Chunks then go straight to the pool, run in parallel on every started worker, and never wait for later audio, but they lose the quality described above. Consider it only for long chunks, or for very short chunks where stalls are worse than poor mouth shapes.

## Usage Patterns

### Async Iterator

To collect every result at the end, add the chunks and call `finalize()`. Results come back in the order the chunks were added. Convert cue times to utterance time with each chunk's start, computed from the chunk lengths:

```typescript
import type { MouthCue, WorkerPool } from 'lip-sync-engine';

export async function lipSyncAll(pool: WorkerPool, audio: AsyncIterable<Int16Array>): Promise<MouthCue[]> {
  const stream = pool.createStreamAnalyzer({ sampleRate: 16000, contextMs: 500, lookaheadMs: 500 });

  const chunkStarts: number[] = [];
  let offset = 0;
  for await (const chunk of audio) {
    stream.addChunk(chunk);
    chunkStarts.push(offset);
    offset += chunk.length / 16000;
  }

  const results = await stream.finalize();
  return results.flatMap((result, i) =>
    result.mouthCues.map(cue => ({ ...cue, start: cue.start + chunkStarts[i], end: cue.end + chunkStarts[i] }))
  );
}
```

### WebSocket

```typescript
import type { WorkerPool } from 'lip-sync-engine';

/** The server sends raw 16 kHz mono 16-bit PCM and closes the socket at the end of the utterance */
export function lipSyncWebSocket(pool: WorkerPool, url: string): void {
  const stream = pool.createStreamAnalyzer({ sampleRate: 16000, contextMs: 500, lookaheadMs: 500 });
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer'; // messages arrive as Blob otherwise

  ws.addEventListener('message', (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    // Int16Array needs an even byte length; the server must not split samples
    const index = stream.addChunk(new Int16Array(event.data));
    stream.getResult(index)
      .then(result => console.log(`Chunk ${index}:`, result.mouthCues))
      .catch(error => console.error(`Chunk ${index} failed:`, error));
  });

  ws.addEventListener('close', () => {
    stream.finalize()
      .then(results => console.log(`Analyzed ${results.length} chunks`))
      .catch(error => console.error('Stream failed:', error));
  });
}
```

### Microphone

`MediaRecorder` is not suitable: its timeslice chunks are fragments of one compressed file, and only the first one can be decoded on its own. Capture raw samples with an `AudioWorklet` instead, convert them with `resample()` and `float32ToInt16()`, and add them in order in chunks of about 250 ms. [`examples/stream-example.ts`](../examples/stream-example.ts) contains a complete microphone capture (`analyzeMicrophone`) built this way.

See [Limits](#limits): microphone audio arrives in real time, so it gets context but little lookahead.

### Monitor Progress

`getStats()` reports how many chunks were added and how many have finished (successfully or not). The difference is the number of chunks still waiting for lookahead or being analyzed:

```typescript
import type { StreamAnalyzerController } from 'lip-sync-engine';

export function logProgress(stream: StreamAnalyzerController): void {
  const { chunksAdded, chunksCompleted, poolStats } = stream.getStats();
  const pending = chunksAdded - chunksCompleted;
  console.log(`${chunksCompleted}/${chunksAdded} chunks done, ${pending} pending, ` +
    `${poolStats.busyWorkers}/${poolStats.totalWorkers} workers busy`);
}
```

A few pending chunks are normal: they are waiting for lookahead or running in a worker. When audio arrives in real time, a pending count that keeps growing means analysis is falling behind. When it arrives in a burst, a large count right after the burst is expected.

Do not use `poolStats.queuedJobs` for this: with context and lookahead, the controller sends at most `maxConcurrent` analyses to the pool at a time, so the pool queue stays short even when chunks are waiting.

## Per-Chunk Results

`getResult(index)` returns a promise for one chunk's result, using the index that `addChunk()` returned. Keep these points in mind:

- **Times are relative to the chunk start.** Add the chunk's start time (the total length of the chunks before it) to place cues on the utterance timeline.
- **Results can resolve out of order.** Two analyses can run at once, and either can finish first. If you need them in order, chain the promises, as [`examples/stream-example.ts`](../examples/stream-example.ts) does.
- **Handle every rejection.** Attach `.catch()` (or a second `.then()` argument) to every `getResult()` promise; a failed chunk otherwise becomes an unhandled rejection.

```typescript
import type { MouthCue, StreamAnalyzerController } from 'lip-sync-engine';

/** Adds a chunk and delivers its cues on the utterance timeline, in order */
export function addInOrder(
  stream: StreamAnalyzerController,
  chunk: Int16Array,
  chunkStart: number,
  previous: Promise<void>,
  onCues: (cues: MouthCue[]) => void
): Promise<void> {
  const index = stream.addChunk(chunk);
  return previous
    .then(() => stream.getResult(index))
    .then(result => onCues(result.mouthCues.map(cue => ({
      ...cue,
      start: cue.start + chunkStart,
      end: cue.end + chunkStart
    }))))
    .catch(error => console.error(`Chunk ${index} failed:`, error));
}
```

## Error Handling

```typescript
import { WorkerPoolDestroyedError } from 'lip-sync-engine';
import type { LipSyncEngineResult, WorkerPool } from 'lip-sync-engine';

export async function lipSyncSafely(
  pool: WorkerPool,
  audio: AsyncIterable<Int16Array>
): Promise<LipSyncEngineResult[] | null> {
  const stream = pool.createStreamAnalyzer({ sampleRate: 16000, contextMs: 500, lookaheadMs: 500 });
  try {
    for await (const chunk of audio) {
      stream.addChunk(chunk);
    }
    return await stream.finalize();
  } catch (error) {
    if (error instanceof WorkerPoolDestroyedError) return null; // the pool was destroyed on purpose
    console.error('Streaming analysis failed:', error);
    return null;
  }
}
```

- `createStreamAnalyzer()` throws if the pool has not finished `init()`.
- `addChunk()` throws after `end()` or `finalize()`.
- If a chunk fails, its `getResult()` promise rejects, and `finalize()` rejects with the first error. Without `contextMs`/`lookaheadMs`, a failed chunk does not affect the others. With them, chunks analyzed in the same batch fail together.
- If the pool is destroyed, chunks already handed to the pool reject with [`WorkerPoolDestroyedError`](./api-reference.md#workerpooldestroyederror). With context and lookahead, chunks not yet sent reject with `Error('WorkerPool not initialized. Call init() first.')` instead.

For errors from the pool itself, see [Worker Usage: Troubleshooting](./worker-usage.md#troubleshooting).

## Performance

Numbers below come from [BENCHMARK.md](../BENCHMARK.md) (real speech, headless Chromium).

- **Create the pool once and keep it.** A new pool builds every worker's decoder again before the first chunk. See [Pool Lifecycle and Sizing](./worker-usage.md#pool-lifecycle-and-sizing).
- **Use one or two workers.** A warm worker analyzes a 250 ms chunk in about 70 to 100 ms, so two workers (matching the default `maxConcurrent` of 2) keep up with real-time speech. See [Pool Lifecycle and Sizing](./worker-usage.md#pool-lifecycle-and-sizing).
- **Use chunks of at least 250 ms.** See [Limits](#limits).
- **Keep `dialogText` the same for the whole stream.** It applies to every chunk. Each worker keeps one decoder for the most recent dialog text; a new text makes each worker build a decoder for it (about 0.5 s of CPU) before analyzing its first chunk with that text, which delays the first cues of that utterance. Workers build their decoder without dialog text at start-up.

## Static vs Streaming

### Static (`analyzeChunks`)

```typescript
import type { LipSyncEngineResult, WorkerPool } from 'lip-sync-engine';

// All chunks are known up front; each is analyzed on its own
function analyzeRecording(pool: WorkerPool, chunks: Int16Array[]): Promise<LipSyncEngineResult[]> {
  return pool.analyzeChunks(chunks);
}
```

**Use when:**
- You have the whole recording up front (pre-recorded audio files)
- You want simple parallel batch processing of long chunks

For a single recording, analyzing it in one `pool.analyze()` call gives the best quality. See [Chunked Processing](./worker-usage.md#chunked-processing).

### Streaming (`createStreamAnalyzer`)

```typescript
import type { LipSyncEngineResult, WorkerPool } from 'lip-sync-engine';

// Chunks are added as they arrive and analyzed with the audio around them
async function analyzeLive(pool: WorkerPool, liveStream: AsyncIterable<Int16Array>): Promise<LipSyncEngineResult[]> {
  const stream = pool.createStreamAnalyzer({ sampleRate: 16000, contextMs: 500, lookaheadMs: 500 });
  for await (const chunk of liveStream) {
    stream.addChunk(chunk);
  }
  return stream.finalize();
}
```

**Use when:**
- Chunks arrive over time (text-to-speech output, WebSocket, microphone)
- You need each chunk's cues before the whole utterance has arrived, for example to animate a voice avatar while it speaks

## See Also

- [API Reference](./api-reference.md#streamanalyzercontroller): `StreamAnalyzerController` and its options
- [Worker Usage](./worker-usage.md): pool lifecycle, worker count, memory and troubleshooting
- [`examples/stream-example.ts`](../examples/stream-example.ts): async source, WebSocket and microphone streaming
- [Examples](../examples/): complete working apps
