import { ref, watch } from 'vue';
import { LipSyncEngine, WorkerPool } from 'lip-sync-engine';
import type { LipSyncEngineResult, LipSyncEngineOptions, MouthCue } from 'lip-sync-engine';

export type ExecutionMode = 'single' | 'worker' | 'chunked' | 'streaming';

export interface PerformanceMetrics {
  executionTime: number;
  cuesCount: number;
  workersUsed?: number;
  chunksProcessed?: number;
}

// The engine and the worker pool are created once and shared by the whole app.
// Since 1.1.0 each worker keeps its speech decoder between calls, so keep the
// pool alive between analyses: destroying and re-creating it would pay the
// start-up cost again every time. Call WorkerPool.getInstance().destroy() only
// when the app no longer needs lip sync.
//
// No init options are passed, so the WASM files and the worker script load
// from unpkg at the installed package version. To self-host them, pass
// wasmPath, dataPath, jsPath (and workerScriptUrl for the pool) to init().

// Each worker holds its own copy of the models, so cap the pool size.
const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 4);

let enginePromise: Promise<LipSyncEngine> | null = null;
let poolPromise: Promise<WorkerPool> | null = null;
let warmPoolPromise: Promise<WorkerPool> | null = null;

function getEngine(): Promise<LipSyncEngine> {
  if (!enginePromise) {
    const engine = LipSyncEngine.getInstance();
    enginePromise = engine.init().then(() => engine);
    enginePromise.catch(() => { enginePromise = null; }); // allow a retry
  }
  return enginePromise;
}

/** Pool with one worker (what init() starts) */
function getPool(): Promise<WorkerPool> {
  if (!poolPromise) {
    const pool = WorkerPool.getInstance(MAX_WORKERS);
    poolPromise = pool.init().then(() => pool);
    poolPromise.catch(() => { poolPromise = null; });
  }
  return poolPromise;
}

/** Pool with all workers started, for modes that analyse chunks in parallel */
function getWarmPool(): Promise<WorkerPool> {
  if (!warmPoolPromise) {
    warmPoolPromise = getPool().then(async (pool) => {
      await pool.warmup();
      return pool;
    });
    warmPoolPromise.catch(() => { warmPoolPromise = null; });
  }
  return warmPoolPromise;
}

function prepare(mode: ExecutionMode): Promise<unknown> {
  if (mode === 'single') return getEngine();
  if (mode === 'worker') return getPool();
  return getWarmPool();
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
 * Example Vue composable for lip-sync-engine with all execution modes.
 * This is not part of the package; it shows one way to integrate it.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useLipSyncEngine } from './composables/useLipSyncEngine';
 * import { recordAudio } from 'lip-sync-engine';
 *
 * const { analyze, result, isAnalyzing, error, setMode } = useLipSyncEngine();
 *
 * const handleAnalyze = async () => {
 *   const { pcm16 } = await recordAudio(5000);
 *   await analyze(pcm16, { dialogText: 'Hello world', sampleRate: 16000 });
 * };
 * </script>
 *
 * <template>
 *   <div>
 *     <button @click="setMode('single')">Single Thread</button>
 *     <button @click="setMode('worker')">Web Worker</button>
 *     <button @click="setMode('chunked')">Chunked Workers</button>
 *     <button @click="setMode('streaming')">Streaming</button>
 *     <button @click="handleAnalyze" :disabled="isAnalyzing">
 *       {{ isAnalyzing ? 'Analyzing...' : 'Record & Analyze' }}
 *     </button>
 *     <div v-if="error">Error: {{ error.message }}</div>
 *     <div v-if="result">Found {{ result.mouthCues.length }} cues</div>
 *   </div>
 * </template>
 * ```
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

  // Start what the selected mode needs. Nothing is torn down when the mode
  // changes or the component unmounts: the engine and pool are app-wide.
  watch(
    mode,
    (newMode, _oldMode, onCleanup) => {
      let current = true;
      onCleanup(() => { current = false; });
      isInitialized.value = false;
      prepare(newMode).then(
        () => { if (current) isInitialized.value = true; },
        (err) => { if (current) error.value = err instanceof Error ? err : new Error(String(err)); }
      );
    },
    { immediate: true }
  );

  const analyze = async (pcm16: Int16Array, options: LipSyncEngineOptions = {}) => {
    isAnalyzing.value = true;
    error.value = null;
    metrics.value = null;

    try {
      const currentMode = mode.value;
      const sampleRate = options.sampleRate ?? 16000;
      await prepare(currentMode);
      const startTime = performance.now();

      let analysisResult: LipSyncEngineResult;
      let performanceMetrics: PerformanceMetrics;

      if (currentMode === 'single') {
        // Runs on the main thread and blocks the UI
        const engine = await getEngine();
        analysisResult = await engine.analyze(pcm16, options);
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length
        };

      } else if (currentMode === 'worker') {
        // Runs in a Web Worker; the UI stays responsive
        const pool = await getPool();
        analysisResult = await pool.analyze(pcm16, options);
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length,
          workersUsed: 1
        };

      } else if (currentMode === 'chunked') {
        // Splits the audio and analyses the chunks in parallel. Each chunk is
        // analysed on its own, so cues near chunk edges are less accurate.
        // Fine for long chunks; streaming mode adds context for short ones.
        const pool = await getWarmPool();
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
        // Streaming: recommended 1.1.0 setup. Each chunk is analysed with
        // 500 ms of audio before and after it and only its own cues are
        // returned (times relative to the chunk). Short chunks analysed
        // alone lose most of their mouth shapes.
        const pool = await getWarmPool();
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
      const e = err instanceof Error ? err : new Error(String(err));
      error.value = e;
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
