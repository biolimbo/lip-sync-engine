/**
 * Example: Dynamic streaming analysis with WorkerPool
 *
 * This example demonstrates how to use the StreamAnalyzerController
 * to analyze audio chunks as they arrive from a stream, with minimal
 * main thread involvement.
 */

import { WorkerPool } from '../src/ts/WorkerPool';

// Example 1: Using with an async audio stream
async function analyzeAudioStream() {
  const pool = WorkerPool.getInstance(4); // 4 workers

  await pool.init({
    wasmPath: '/dist/wasm/lip-sync-engine.wasm',
    dataPath: '/dist/wasm/lip-sync-engine.data',
    jsPath: '/dist/wasm/lip-sync-engine.js',
    workerScriptUrl: '/dist/worker.js'
  });

  // Pre-create all workers for maximum throughput
  await pool.warmup();

  // Create streaming analyzer
  const stream = pool.createStreamAnalyzer({
    dialogText: "Hello world from the stream",
    sampleRate: 16000
  });

  // Simulate chunks arriving from an audio stream
  // In real usage, this would be your actual audio stream
  const audioStream = simulateAudioStream();

  // Add chunks as they arrive - this is non-blocking!
  for await (const chunk of audioStream) {
    stream.addChunk(chunk); // Immediately queues in worker pool

    // Check stats (optional)
    const stats = stream.getStats();
    console.log(`Queued: ${stats.chunksAdded}, Pool: ${stats.poolStats.busyWorkers}/${stats.poolStats.totalWorkers} busy`);
  }

  // Wait for all chunks to complete
  const results = await stream.finalize();

  console.log(`Analyzed ${results.length} chunks`);
  console.log('First chunk mouth cues:', results[0].mouthCues);

  pool.destroy();
}

// Example 2: Using with a WebSocket audio stream
async function analyzeWebSocketAudioStream(ws: WebSocket) {
  const pool = WorkerPool.getInstance();
  await pool.init({ /* paths */ });
  await pool.warmup(); // Pre-create workers

  const stream = pool.createStreamAnalyzer({
    sampleRate: 16000
  });

  // Listen for audio chunks from WebSocket
  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      const chunk = new Int16Array(event.data);
      stream.addChunk(chunk); // Queues immediately, returns to event loop
    }
  });

  // When stream ends
  ws.addEventListener('close', async () => {
    const results = await stream.finalize();
    console.log(`Processed ${results.length} chunks from WebSocket`);
  });
}

// Example 3: Using with MediaRecorder chunks
async function analyzeMediaRecorderStream(mediaRecorder: MediaRecorder) {
  const pool = WorkerPool.getInstance();
  await pool.init({ /* paths */ });
  await pool.warmup();

  const stream = pool.createStreamAnalyzer({
    sampleRate: 16000
  });

  mediaRecorder.addEventListener('dataavailable', async (event) => {
    // Convert Blob to PCM16
    const arrayBuffer = await event.data.arrayBuffer();
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const pcm16 = convertToPCM16(audioBuffer);

    stream.addChunk(pcm16); // Non-blocking
  });

  mediaRecorder.addEventListener('stop', async () => {
    const results = await stream.finalize();
    console.log(`Processed ${results.length} chunks from MediaRecorder`);
  });

  mediaRecorder.start(1000); // 1 second chunks
}

// Helper: Simulate an async audio stream
async function* simulateAudioStream(): AsyncGenerator<Int16Array> {
  for (let i = 0; i < 10; i++) {
    // Simulate delay between chunks
    await new Promise(resolve => setTimeout(resolve, 100));

    // Generate dummy audio chunk
    const chunk = new Int16Array(16000); // 1 second at 16kHz
    for (let j = 0; j < chunk.length; j++) {
      chunk[j] = Math.floor(Math.random() * 32767);
    }

    yield chunk;
  }
}

// Helper: Convert AudioBuffer to PCM16
function convertToPCM16(audioBuffer: AudioBuffer): Int16Array {
  const float32 = audioBuffer.getChannelData(0);
  const pcm16 = new Int16Array(float32.length);

  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  return pcm16;
}

// Run example
analyzeAudioStream().catch(console.error);
