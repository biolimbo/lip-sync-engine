/**
 * Example: streaming analysis with WorkerPool (lip-sync-engine 2.0.0+)
 *
 * Audio arrives in chunks (from a WebSocket, the microphone, a TTS stream...).
 * Each chunk is added to a stream analyzer as soon as it arrives, and its
 * mouth cues are used as soon as they are ready.
 *
 * Recommended setup: `{ sampleRate: 16000, contextMs: 500, lookaheadMs: 500 }`,
 * `getResult(i)` per chunk, and `end()` when the utterance is complete. Short
 * chunks analysed alone lose most of their mouth shapes; with 500 ms of
 * context and lookahead each chunk is analysed with the audio around it.
 */

import { WorkerPool, loadAudio, resample, float32ToInt16 } from 'lip-sync-engine';
import type { MouthCue, StreamAnalyzerController } from 'lip-sync-engine';

const SAMPLE_RATE = 16000; // mono 16-bit PCM at 16 kHz is what the recognizer expects

// ---------------------------------------------------------------------------
// One pool for the whole app
// ---------------------------------------------------------------------------
// Since 2.0.0 each worker keeps its speech decoder between calls. Create the
// pool once and reuse it for every utterance; do not destroy and re-create it
// per utterance (that pays the start-up cost again every time).

let poolPromise: Promise<WorkerPool> | null = null;

export function getPool(): Promise<WorkerPool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      // Two workers match the stream analyzer's default maxConcurrent of 2.
      const pool = WorkerPool.getInstance(2);
      // No paths: files load from unpkg at the installed package version.
      // To self-host, pass wasmPath, dataPath, jsPath and workerScriptUrl.
      await pool.init();
      await pool.warmup(); // start the second worker now, not on first use
      return pool;
    })();
    poolPromise.catch(() => { poolPromise = null; }); // allow a retry
  }
  return poolPromise;
}

/** Called with each chunk's cues, in order, with times from the utterance start (seconds) */
export type CuesHandler = (cues: MouthCue[]) => void;

/**
 * Feeds one utterance's chunks to a stream analyzer and hands each chunk's
 * cues to `onCues` in order, as soon as they are ready.
 */
class Utterance {
  private stream: StreamAnalyzerController;
  private offset = 0; // seconds of audio added so far
  private delivered: Promise<void> = Promise.resolve();

  constructor(pool: WorkerPool, private onCues: CuesHandler, dialogText?: string) {
    this.stream = pool.createStreamAnalyzer({
      sampleRate: SAMPLE_RATE,
      contextMs: 500,
      lookaheadMs: 500,
      dialogText
    });
  }

  add(chunk: Int16Array): void {
    if (chunk.length === 0) return;
    const index = this.stream.addChunk(chunk);
    const start = this.offset;
    this.offset += chunk.length / SAMPLE_RATE;
    // Cue times are relative to the chunk start; shift them to utterance time.
    this.delivered = this.delivered
      .then(() => this.stream.getResult(index))
      .then((result) => this.onCues(result.mouthCues.map((cue) => ({
        ...cue,
        start: cue.start + start,
        end: cue.end + start
      }))));
  }

  /** No more audio: chunks waiting for lookahead are analysed now */
  async end(): Promise<void> {
    this.stream.end();
    await this.delivered;
  }
}

// ---------------------------------------------------------------------------
// Example 1: chunks from any async source
// ---------------------------------------------------------------------------

export async function analyzeChunks(
  chunks: AsyncIterable<Int16Array>,
  onCues: CuesHandler,
  dialogText?: string
): Promise<void> {
  const utterance = new Utterance(await getPool(), onCues, dialogText);
  for await (const chunk of chunks) {
    utterance.add(chunk);
  }
  await utterance.end();
}

/** Simulates a live source: yields a decoded file in chunks, in real time */
export async function* fileAsStream(url: string, chunkMs = 500): AsyncGenerator<Int16Array> {
  const { pcm16 } = await loadAudio(url, SAMPLE_RATE);
  const chunkSamples = Math.round((chunkMs / 1000) * SAMPLE_RATE);
  for (let i = 0; i < pcm16.length; i += chunkSamples) {
    await new Promise((resolve) => setTimeout(resolve, chunkMs));
    yield pcm16.subarray(i, i + chunkSamples);
  }
}

// ---------------------------------------------------------------------------
// Example 2: WebSocket that sends raw PCM (16 kHz, mono, 16-bit little endian)
// ---------------------------------------------------------------------------

export async function analyzeWebSocket(url: string, onCues: CuesHandler): Promise<void> {
  const utterance = new Utterance(await getPool(), onCues);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer'; // the default ('blob') would need async reads

  ws.addEventListener('message', (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    // Int16Array needs an even byte length; the server must not split samples.
    utterance.add(new Int16Array(event.data));
  });

  // The server closing the socket marks the end of the utterance.
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('close', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket error: ${url}`)), { once: true });
  });
  await utterance.end();
}

// ---------------------------------------------------------------------------
// Example 3: live microphone
// ---------------------------------------------------------------------------
// MediaRecorder chunks are compressed fragments that cannot be decoded one by
// one, so this taps raw samples with an AudioWorklet instead, converts them to
// 16 kHz Int16 and adds them in 250 ms chunks.

const TAP_PROCESSOR = `
registerProcessor('pcm-tap', class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0][0];
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
});
`;

/** Starts listening; call the returned function to stop and wait for the last cues */
export async function analyzeMicrophone(onCues: CuesHandler, chunkMs = 250): Promise<() => Promise<void>> {
  const utterance = new Utterance(await getPool(), onCues);
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });

  // Use the device's own sample rate (some browsers refuse to connect a
  // microphone to a context with a different rate) and resample below.
  const context = new AudioContext();
  const moduleUrl = URL.createObjectURL(new Blob([TAP_PROCESSOR], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }

  const source = context.createMediaStreamSource(media);
  const tap = new AudioWorkletNode(context, 'pcm-tap');
  source.connect(tap); // not connected to the speakers

  const chunkFrames = Math.round((chunkMs / 1000) * context.sampleRate);
  let pending: Float32Array[] = [];
  let pendingFrames = 0;

  const flush = () => {
    if (pendingFrames === 0) return;
    const samples = new Float32Array(pendingFrames);
    let pos = 0;
    for (const block of pending) {
      samples.set(block, pos);
      pos += block.length;
    }
    pending = [];
    pendingFrames = 0;
    utterance.add(float32ToInt16(resample(samples, context.sampleRate, SAMPLE_RATE)));
  };

  tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
    pending.push(event.data);
    pendingFrames += event.data.length;
    if (pendingFrames >= chunkFrames) flush();
  };

  return async () => {
    tap.port.onmessage = null;
    source.disconnect();
    tap.disconnect();
    media.getTracks().forEach((track) => track.stop());
    await context.close();
    flush();
    await utterance.end();
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
//   const log: CuesHandler = (cues) => console.log(cues);
//
//   // Two utterances in a row share the same warm pool.
//   await analyzeChunks(fileAsStream('/speech-1.wav'), log, 'Hello world');
//   await analyzeChunks(fileAsStream('/speech-2.wav'), log);
//
//   const stop = await analyzeMicrophone(log);
//   // ...later
//   await stop();
