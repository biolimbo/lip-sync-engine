import { writable, get } from 'svelte/store';
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
// Since 2.0.0 each worker keeps its speech decoder between calls, so keep the
// pool alive between analyses: destroying and re-creating it would pay the
// start-up cost again every time. Call lipSyncEngineStore.destroy() only when
// the app no longer needs lip sync.
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

interface LipSyncEngineState {
  mode: ExecutionMode;
  result: LipSyncEngineResult | null;
  isAnalyzing: boolean;
  isInitialized: boolean;
  error: Error | null;
  metrics: PerformanceMetrics | null;
  chunkSize: number;
  recordingDuration: number;
}

/**
 * Example Svelte store for lip-sync-engine with all execution modes.
 * This is not part of the package; it shows one way to integrate it.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { lipSyncEngineStore } from './stores/lipSyncEngine';
 *   import { recordAudio } from 'lip-sync-engine';
 *
 *   async function handleAnalyze() {
 *     const { pcm16 } = await recordAudio(5000);
 *     await lipSyncEngineStore.analyze(pcm16, { dialogText: 'Hello world', sampleRate: 16000 });
 *   }
 * </script>
 *
 * <button on:click={() => lipSyncEngineStore.setMode('single')}>Single Thread</button>
 * <button on:click={() => lipSyncEngineStore.setMode('worker')}>Web Worker</button>
 * <button on:click={() => lipSyncEngineStore.setMode('chunked')}>Chunked Workers</button>
 * <button on:click={() => lipSyncEngineStore.setMode('streaming')}>Streaming</button>
 *
 * <button on:click={handleAnalyze} disabled={$lipSyncEngineStore.isAnalyzing}>
 *   {$lipSyncEngineStore.isAnalyzing ? 'Analyzing...' : 'Record & Analyze'}
 * </button>
 *
 * {#if $lipSyncEngineStore.error}
 *   <div>Error: {$lipSyncEngineStore.error.message}</div>
 * {/if}
 *
 * {#if $lipSyncEngineStore.result}
 *   <div>Found {$lipSyncEngineStore.result.mouthCues.length} cues</div>
 * {/if}
 * ```
 */
function createLipSyncEngineStore() {
  const store = writable<LipSyncEngineState>({
    mode: 'single',
    result: null,
    isAnalyzing: false,
    isInitialized: false,
    error: null,
    metrics: null,
    chunkSize: 5, // seconds
    recordingDuration: 10, // seconds
  });
  const { subscribe, update } = store;

  // Start what a mode needs; ignore the outcome if the mode changed meanwhile
  const startMode = (mode: ExecutionMode) => {
    update((state) => ({ ...state, mode, isInitialized: false }));
    prepare(mode).then(
      () => update((state) => (state.mode === mode ? { ...state, isInitialized: true } : state)),
      (err) => update((state) => (state.mode === mode
        ? { ...state, error: err instanceof Error ? err : new Error(String(err)) }
        : state))
    );
  };
  startMode('single');

  return {
    subscribe,

    analyze: async (pcm16: Int16Array, options: LipSyncEngineOptions = {}) => {
      const { mode, chunkSize } = get(store);
      update((state) => ({ ...state, isAnalyzing: true, error: null, metrics: null }));

      try {
        const sampleRate = options.sampleRate ?? 16000;
        await prepare(mode);
        const startTime = performance.now();

        let result: LipSyncEngineResult;
        let performanceMetrics: PerformanceMetrics;

        if (mode === 'single') {
          // Runs on the main thread and blocks the UI
          const engine = await getEngine();
          result = await engine.analyze(pcm16, options);
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length
          };

        } else if (mode === 'worker') {
          // Runs in a Web Worker; the UI stays responsive
          const pool = await getPool();
          result = await pool.analyze(pcm16, options);
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: 1
          };

        } else if (mode === 'chunked') {
          // Splits the audio and analyses the chunks in parallel. Each chunk is
          // analysed on its own, so cues near chunk edges are less accurate.
          // Fine for long chunks; streaming mode adds context for short ones.
          const pool = await getWarmPool();
          const chunks = splitIntoChunks(pcm16, chunkSize, sampleRate);
          const results = await pool.analyzeChunks(chunks, options);
          result = mergeChunkResults(results, chunks, sampleRate);
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: Math.min(chunks.length, pool.getStats().totalWorkers),
            chunksProcessed: chunks.length
          };

        } else {
          // Streaming: recommended 2.0.0 setup. Each chunk is analysed with
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
          const chunks = splitIntoChunks(pcm16, chunkSize, sampleRate);
          const indexes = chunks.map((chunk) => stream.addChunk(chunk));
          stream.end(); // the utterance is complete

          // Each chunk's cues can be used (for example played) as soon as its
          // getResult() resolves; this demo waits for all of them.
          const results = await Promise.all(indexes.map((i) => stream.getResult(i)));
          result = mergeChunkResults(results, chunks, sampleRate);
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            chunksProcessed: chunks.length
          };
        }

        update((state) => ({
          ...state,
          result,
          metrics: performanceMetrics,
          isAnalyzing: false
        }));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        update((state) => ({ ...state, error, isAnalyzing: false }));
        throw error;
      }
    },

    setMode: (mode: ExecutionMode) => {
      if (get(store).mode !== mode) startMode(mode);
    },

    setChunkSize: (size: number) => {
      update((state) => ({ ...state, chunkSize: size }));
    },

    setRecordingDuration: (duration: number) => {
      update((state) => ({ ...state, recordingDuration: duration }));
    },

    reset: () => {
      update((state) => ({
        ...state,
        result: null,
        error: null,
        isAnalyzing: false,
        metrics: null
      }));
    },

    /** Free the engine and terminate the workers (only when lip sync is no longer needed) */
    destroy: () => {
      LipSyncEngine.getInstance().destroy();
      WorkerPool.getInstance().destroy();
      enginePromise = null;
      poolPromise = null;
      warmPoolPromise = null;
      update((state) => ({ ...state, isInitialized: false }));
    },
  };
}

export const lipSyncEngineStore = createLipSyncEngineStore();
