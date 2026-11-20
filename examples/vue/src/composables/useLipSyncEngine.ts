import { ref, watch } from 'vue';
import { LipSyncEngine, WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';
import type { LipSyncEngineResult, LipSyncEngineOptions, MouthCue } from 'lip-sync-engine';

export type ExecutionMode = 'single' | 'worker' | 'chunked' | 'streaming';

export interface PerformanceMetrics {
  executionTime: number;
  cuesCount: number;
  workersUsed?: number;
  chunksProcessed?: number;
}

// The engine and the worker pool are singletons shared by every mode and
// component. Workers keep their speech decoder between calls, so the pool stays
// alive between analyses; call WorkerPool.getInstance().destroy() only when the
// app no longer needs lip sync.
//
// No init options are passed, so the WASM files and the worker script load
// from unpkg at the installed package version.

// Each worker holds its own copy of the models, so cap the pool size.
const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 4);

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Resolve after the browser paints, so a status set just before shows up */
function nextPaint(): Promise<void> {
  // requestAnimationFrame runs just before the next paint, and the timeout runs after it
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * Start what a mode needs. Repeated calls share the library's in-flight
 * startup, so this is safe to call before every analysis.
 */
async function prepare(mode: ExecutionMode): Promise<void> {
  if (mode === 'single') {
    await LipSyncEngine.getInstance().init();
    return;
  }
  const pool = WorkerPool.getInstance(MAX_WORKERS);
  await pool.init();
  // Streaming warms all workers too because it shares the pool with chunked mode.
  if (mode === 'chunked' || mode === 'streaming') await pool.warmup();
}

function splitIntoChunks(pcm16: Int16Array, chunkSeconds: number, sampleRate: number): Int16Array[] {
  const chunkSamples = Math.round(chunkSeconds * sampleRate);
  const chunks: Int16Array[] = [];
  for (let i = 0; i < pcm16.length; i += chunkSamples) {
    chunks.push(pcm16.subarray(i, i + chunkSamples));
  }
  return chunks;
}

/** Join per-chunk results (cue times relative to each chunk) into one timeline */
function mergeChunkResults(results: LipSyncEngineResult[], chunks: Int16Array[], sampleRate: number): LipSyncEngineResult {
  const mouthCues: MouthCue[] = [];
  let offset = 0;
  results.forEach((chunkResult, i) => {
    for (const cue of chunkResult.mouthCues) {
      mouthCues.push({ start: cue.start + offset, end: cue.end + offset, value: cue.value });
    }
    offset += chunks[i].length / sampleRate;
  });
  return { mouthCues };
}

/**
 * Example Vue composable (not part of the package) that runs lip-sync-engine in one of four execution modes.
 */
export function useLipSyncEngine() {
  const mode = ref<ExecutionMode>('single');
  const result = ref<LipSyncEngineResult | null>(null);
  const isAnalyzing = ref(false);
  const error = ref<Error | null>(null);
  const metrics = ref<PerformanceMetrics | null>(null);
  const chunkSize = ref(5); // seconds
  const recordingDuration = ref(10); // seconds
  const isInitialized = ref(false);
  // Set when the selected mode fails to start. The library keeps a failed
  // WASM load, so Single Thread needs a page reload; a worker pool that failed
  // to start tries again when a worker mode is selected again.
  const initError = ref<Error | null>(null);

  // Start what the selected mode needs. Nothing is torn down when the mode
  // changes or the component unmounts: the engine and pool are app-wide.
  watch(
    mode,
    (newMode, _oldMode, onCleanup) => {
      let current = true;
      onCleanup(() => { current = false; });
      isInitialized.value = false;
      initError.value = null;
      prepare(newMode).then(
        () => { if (current) isInitialized.value = true; },
        (err) => {
          // A pool destroyed elsewhere during startup is teardown, not a failure
          if (current && !(err instanceof WorkerPoolDestroyedError)) initError.value = toError(err);
        }
      );
    },
    { immediate: true }
  );

  /** Analyze 16-bit PCM audio in the selected mode. Throws on failure (and sets error or initError). */
  const analyze = async (pcm16: Int16Array, options: LipSyncEngineOptions = {}) => {
    isAnalyzing.value = true;
    error.value = null;
    metrics.value = null;

    const currentMode = mode.value;
    const sampleRate = options.sampleRate ?? 16000;

    try {
      try {
        await prepare(currentMode);
      } catch (err) {
        initError.value = toError(err);
        throw initError.value;
      }
      initError.value = null;
      isInitialized.value = true;

      let startTime = performance.now();
      let analysisResult: LipSyncEngineResult;
      let performanceMetrics: PerformanceMetrics;

      if (currentMode === 'single') {
        // Runs on the main thread and blocks the UI, so paint the
        // "Analyzing" status first
        await nextPaint();
        startTime = performance.now();
        analysisResult = await LipSyncEngine.getInstance().analyze(pcm16, options);
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length
        };

      } else if (currentMode === 'worker') {
        // Runs in a Web Worker; the UI stays responsive
        const pool = WorkerPool.getInstance(MAX_WORKERS);
        analysisResult = await pool.analyze(pcm16, options);
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length,
          workersUsed: 1
        };

      } else if (currentMode === 'chunked') {
        // Splits the audio and analyzes the chunks in parallel. Each chunk is
        // analyzed on its own, so cues near chunk edges are less accurate.
        const pool = WorkerPool.getInstance(MAX_WORKERS);
        const chunks = splitIntoChunks(pcm16, chunkSize.value, sampleRate);
        const results = await pool.analyzeChunks(chunks, options);
        analysisResult = mergeChunkResults(results, chunks, sampleRate);
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length,
          workersUsed: Math.min(chunks.length, pool.getStats().totalWorkers),
          chunksProcessed: chunks.length
        };

      } else {
        // Streaming with the recommended settings: each chunk is analyzed with
        // 500 ms of audio before and after it, and only its own cues are
        // returned (times relative to the chunk).
        const pool = WorkerPool.getInstance(MAX_WORKERS);
        const stream = pool.createStreamAnalyzer({
          ...options,
          sampleRate,
          contextMs: 500,
          lookaheadMs: 500
        });

        // A live source would call addChunk() as audio arrives. This demo
        // splits the finished recording to simulate that.
        const chunks = splitIntoChunks(pcm16, chunkSize.value, sampleRate);
        const indexes = chunks.map((chunk) => stream.addChunk(chunk));
        stream.end(); // the utterance is complete

        // Each chunk's cues can be used (for example played) as soon as its
        // getResult() resolves; this demo waits for all of them.
        const results = await Promise.all(indexes.map((i) => stream.getResult(i)));
        analysisResult = mergeChunkResults(results, chunks, sampleRate);
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length,
          chunksProcessed: chunks.length
        };
      }

      result.value = analysisResult;
      metrics.value = performanceMetrics;
    } catch (err) {
      const e = toError(err);
      if (e !== initError.value) error.value = e;
      throw e;
    } finally {
      isAnalyzing.value = false;
    }
  };

  const reset = () => {
    result.value = null;
    error.value = null;
    isAnalyzing.value = false;
    metrics.value = null;
  };

  return {
    analyze,
    result,
    isAnalyzing,
    isInitialized,
    initError,
    error,
    metrics,
    reset,
    mode,
    setMode: (newMode: ExecutionMode) => { mode.value = newMode; },
    chunkSize,
    setChunkSize: (size: number) => { chunkSize.value = size; },
    recordingDuration,
    setRecordingDuration: (value: number) => { recordingDuration.value = value; },
  };
}
