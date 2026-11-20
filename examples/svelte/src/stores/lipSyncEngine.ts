import { writable, get } from 'svelte/store';
import { LipSyncEngine, WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';
import type { LipSyncEngineResult, LipSyncEngineOptions, MouthCue } from 'lip-sync-engine';

export type ExecutionMode = 'single' | 'worker' | 'chunked' | 'streaming';

export interface PerformanceMetrics {
  executionTime: number;
  cuesCount: number;
  workersUsed?: number;
  chunksProcessed?: number;
}

// The engine and the worker pool are singletons shared by the whole app. Each
// worker keeps its speech decoder between calls, so keep the pool alive between
// analyses and call lipSyncEngineStore.destroy() only when the app no longer
// needs lip sync.
//
// No init options are passed, so the WASM files and the worker script load
// from unpkg at the installed package version. To self-host them, pass
// wasmPath, dataPath, jsPath (and workerScriptUrl for the pool) to init().

// Each worker holds its own copy of the models, so cap the pool size.
const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 4);

/**
 * Start what a mode needs. Repeated calls share the library's in-flight
 * startup, and a destroyed pool starts again on the next call.
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

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Resolve after the browser paints, so a status set just before shows up */
function nextPaint(): Promise<void> {
  // requestAnimationFrame runs just before the next paint, and the timeout runs after it
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * Thrown by analyze() when the selected mode fails to start. The failure is
 * also stored as `initError`, so callers need not show it again.
 */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
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
  /**
   * Set when the selected mode failed to start. The library keeps a failed
   * WASM load, so Single Thread needs a page reload; a worker pool that failed
   * to start tries again when a worker mode is selected again.
   */
  initError: Error | null;
  /** True after destroy(), until the next analyze() or mode change starts a mode again */
  stopped: boolean;
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
 *     try {
 *       const { pcm16 } = await recordAudio(5000);
 *       await lipSyncEngineStore.analyze(pcm16, { dialogText: 'Hello world', sampleRate: 16000 });
 *     } catch {
 *       // Recording failed, or analyze() failed and set `error` or `initError`
 *     }
 *   }
 * </script>
 *
 * <button on:click={() => lipSyncEngineStore.setMode('single')}>Single Thread</button>
 * <button on:click={() => lipSyncEngineStore.setMode('worker')}>Web Worker</button>
 * <button on:click={() => lipSyncEngineStore.setMode('chunked')}>Chunked</button>
 * <button on:click={() => lipSyncEngineStore.setMode('streaming')}>Streaming</button>
 *
 * <!-- analyze() waits for a mode that is still starting -->
 * <button on:click={handleAnalyze} disabled={$lipSyncEngineStore.isAnalyzing || $lipSyncEngineStore.initError !== null}>
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
    initError: null,
    stopped: false,
    error: null,
    metrics: null,
    chunkSize: 5, // seconds
    recordingDuration: 10, // seconds
  });
  const { subscribe, update } = store;

  // Each startup gets a number, so the outcome of a startup that a mode change
  // or destroy() superseded is ignored
  let startId = 0;

  // Start what a mode needs
  const startMode = (mode: ExecutionMode) => {
    const id = ++startId;
    update((state) => ({ ...state, mode, isInitialized: false, initError: null, stopped: false }));
    prepare(mode).then(
      () => update((state) => (id === startId ? { ...state, isInitialized: true } : state)),
      (err) => {
        // destroy() rejects pending startups; that is teardown, not a failure
        if (err instanceof WorkerPoolDestroyedError) return;
        update((state) => (id === startId ? { ...state, initError: toError(err) } : state));
      }
    );
  };
  startMode('single');

  return {
    subscribe,

    /**
     * Analyze audio in the selected mode, starting it first if needed.
     * Resolves with the result, or with null if destroy() ran meanwhile.
     * Throws on failure: a StartupError (and sets `initError`) when the mode
     * fails to start, otherwise the analysis error (and sets `error`).
     */
    analyze: async (pcm16: Int16Array, options: LipSyncEngineOptions = {}): Promise<LipSyncEngineResult | null> => {
      const { mode, chunkSize } = get(store);
      update((state) => ({ ...state, isAnalyzing: true, error: null, metrics: null, stopped: false }));

      try {
        const sampleRate = options.sampleRate ?? 16000;
        try {
          await prepare(mode);
        } catch (err) {
          const error = toError(err);
          if (!(err instanceof WorkerPoolDestroyedError)) {
            update((state) => (state.mode === mode ? { ...state, initError: error } : state));
          }
          throw err instanceof WorkerPoolDestroyedError ? err : new StartupError(error.message);
        }
        update((state) => (state.mode === mode ? { ...state, isInitialized: true, initError: null } : state));

        let startTime = performance.now();
        let result: LipSyncEngineResult;
        let performanceMetrics: PerformanceMetrics;

        if (mode === 'single') {
          // Runs on the main thread and blocks the UI, so paint the
          // "Analyzing" status first
          await nextPaint();
          startTime = performance.now();
          result = await LipSyncEngine.getInstance().analyze(pcm16, options);
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length
          };

        } else if (mode === 'worker') {
          // Runs in a Web Worker; the UI stays responsive
          result = await WorkerPool.getInstance(MAX_WORKERS).analyze(pcm16, options);
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: 1
          };

        } else if (mode === 'chunked') {
          // Splits the audio and analyzes the chunks in parallel. Each chunk is
          // analyzed on its own, so cues near chunk edges are less accurate.
          // Fine for long chunks; streaming mode adds context for short ones.
          const pool = WorkerPool.getInstance(MAX_WORKERS);
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
          // Streaming with the recommended settings. Each chunk is analyzed
          // with 500 ms of audio before and after it and only its own cues are
          // returned (times relative to the chunk). Short chunks analyzed
          // alone lose most of their mouth shapes.
          const stream = WorkerPool.getInstance(MAX_WORKERS).createStreamAnalyzer({
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
        return result;
      } catch (err) {
        if (err instanceof WorkerPoolDestroyedError) {
          // destroy() ran during the analysis; nothing to report
          update((state) => ({ ...state, isAnalyzing: false }));
          return null;
        }
        const error = toError(err);
        update((state) => ({
          ...state,
          error: error instanceof StartupError ? null : error,
          isAnalyzing: false
        }));
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

    /**
     * Free the engine and terminate the workers (only when lip sync is no
     * longer needed). Sets `stopped`; the next analyze() or mode change
     * starts the selected mode again.
     */
    destroy: () => {
      startId++; // ignore startups still in flight
      LipSyncEngine.getInstance().destroy();
      WorkerPool.getInstance().destroy();
      update((state) => ({ ...state, isInitialized: false, initError: null, stopped: true }));
    },
  };
}

export const lipSyncEngineStore = createLipSyncEngineStore();
