import { writable } from 'svelte/store';
import { LipSyncEngine, WorkerPool } from 'lip-sync-engine';
import type { LipSyncEngineResult, LipSyncEngineOptions } from 'lip-sync-engine';

export type ExecutionMode = 'single' | 'worker' | 'chunked' | 'streaming';

export interface PerformanceMetrics {
  executionTime: number;
  cuesCount: number;
  workersUsed?: number;
  chunksProcessed?: number;
}

/**
 * Example Svelte store for lip-sync-engine with all execution modes
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```svelte
 * <script>
 * import { lipSyncEngineStore } from './stores/lipSyncEngine';
 * import { recordAudio } from 'lip-sync-engine';
 *
 * async function handleAnalyze() {
 *   const { pcm16 } = await recordAudio(5000);
 *   await lipSyncEngineStore.analyze(pcm16, { dialogText: "Hello world" });
 * }
 * </script>
 *
 * <button on:click={() => lipSyncEngineStore.setMode('single')}>Single Thread</button>
 * <button on:click={() => lipSyncEngineStore.setMode('worker')}>Web Worker</button>
 * <button on:click={() => lipSyncEngineStore.setMode('chunked')}>Chunked Workers</button>
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
interface LipSyncEngineState {
  mode: ExecutionMode;
  result: LipSyncEngineResult | null;
  isAnalyzing: boolean;
  error: Error | null;
  metrics: PerformanceMetrics | null;
  chunkSize: number;
  recordingDuration: number;
}

function createLipSyncEngineStore() {
  const { subscribe, set, update } = writable<LipSyncEngineState>({
    mode: 'single',
    result: null,
    isAnalyzing: false,
    error: null,
    metrics: null,
    chunkSize: 5, // Default 5 seconds
    recordingDuration: 10, // Default 10 seconds
  });

  let lipSyncEngine: LipSyncEngine | null = null;
  let workerPool: WorkerPool | null = null;
  let isInitialized = false;
  let currentInitializedMode: ExecutionMode | null = null;

  const init = async (mode: ExecutionMode) => {
    // Skip if already initialized for this mode
    if (isInitialized && currentInitializedMode === mode) {
      return;
    }

    // Cleanup previous initialization
    if (currentInitializedMode !== mode) {
      lipSyncEngine?.destroy();
      workerPool?.destroy();
      lipSyncEngine = null;
      workerPool = null;
      isInitialized = false;
    }

    try {
      if (mode === 'single') {
        // Initialize LipSyncEngine for single thread mode
        console.log('Initializing LipSyncEngine (single thread)...');
        lipSyncEngine = LipSyncEngine.getInstance();
        // No options needed - uses CDN by default
        await lipSyncEngine.init();
        console.log('LipSyncEngine initialized');
      } else {
        // Initialize WorkerPool for worker and chunked modes
        workerPool = WorkerPool.getInstance();

        if (mode === 'worker') {
          console.log('Initializing WorkerPool (single worker mode)...');
          // No options needed - uses CDN by default
          await workerPool.init();
          console.log('✅ WorkerPool ready (1 worker)');
        } else {
          // Chunked or Streaming mode
          console.log(`Initializing WorkerPool (${mode} mode)...`);
          // No options needed - uses CDN by default
          await workerPool.init();
          console.log('Creating worker pool...');
          await workerPool.warmup();
          console.log(`✅ WorkerPool ready (${workerPool.getStats().totalWorkers} workers)`);
        }
      }

      currentInitializedMode = mode;
      isInitialized = true;
      console.log('Initialization complete');
    } catch (err) {
      console.error('Initialization error:', err);
      throw err;
    }
  };

  /**
   * Split audio into chunks for parallel processing
   */
  const splitIntoChunks = (pcm16: Int16Array, chunkDurationSec: number, sampleRate: number = 16000): Int16Array[] => {
    const chunkSizeSamples = chunkDurationSec * sampleRate;
    const chunks: Int16Array[] = [];

    for (let i = 0; i < pcm16.length; i += chunkSizeSamples) {
      chunks.push(pcm16.slice(i, Math.min(i + chunkSizeSamples, pcm16.length)));
    }

    return chunks;
  };

  return {
    subscribe,

    analyze: async (pcm16: Int16Array, options?: LipSyncEngineOptions) => {
      try {
        // Get current mode from store
        let currentMode: ExecutionMode = 'single';
        let currentChunkSize = 5;
        subscribe((state) => {
          currentMode = state.mode;
          currentChunkSize = state.chunkSize;
        })();

        await init(currentMode);

        update((state) => ({ ...state, isAnalyzing: true, error: null, metrics: null }));

        const startTime = performance.now();
        let result: LipSyncEngineResult;
        let performanceMetrics: PerformanceMetrics;

        if (currentMode === 'single') {
          // Single thread mode - blocks UI
          if (!lipSyncEngine) {
            throw new Error('LipSyncEngine not initialized');
          }

          result = await lipSyncEngine.analyze(pcm16, options);

          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length
          };

        } else if (currentMode === 'worker') {
          // Web Worker mode - non-blocking
          if (!workerPool) {
            throw new Error('WorkerPool not initialized');
          }

          result = await workerPool.analyze(pcm16, options);

          const stats = workerPool.getStats();
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: stats.totalWorkers
          };

        } else if (currentMode === 'chunked') {
          // Chunked Workers mode - parallel processing (static)
          if (!workerPool) {
            throw new Error('WorkerPool not initialized');
          }

          const chunks = splitIntoChunks(pcm16, currentChunkSize, options?.sampleRate || 16000);
          const results = await workerPool.analyzeChunks(chunks, options);

          // Combine results with time offsets
          const allCues = [];
          let timeOffset = 0;

          results.forEach((chunkResult) => {
            chunkResult.mouthCues.forEach(cue => {
              allCues.push({
                start: cue.start + timeOffset,
                end: cue.end + timeOffset,
                value: cue.value
              });
            });
            timeOffset += currentChunkSize;
          });

          result = { mouthCues: allCues };

          const stats = workerPool.getStats();
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: Math.min(chunks.length, stats.maxWorkers),
            chunksProcessed: chunks.length
          };

        } else if (currentMode === 'streaming') {
          // Streaming mode - dynamic chunk processing
          if (!workerPool) {
            throw new Error('WorkerPool not initialized');
          }

          const stream = workerPool.createStreamAnalyzer(options);
          const chunks = splitIntoChunks(pcm16, currentChunkSize, options?.sampleRate || 16000);

          // Add chunks dynamically
          for (const chunk of chunks) {
            stream.addChunk(chunk);
          }

          const results = await stream.finalize();

          // Combine results with time offsets
          const allCues = [];
          let timeOffset = 0;

          results.forEach((chunkResult) => {
            chunkResult.mouthCues.forEach(cue => {
              allCues.push({
                start: cue.start + timeOffset,
                end: cue.end + timeOffset,
                value: cue.value
              });
            });
            timeOffset += currentChunkSize;
          });

          result = { mouthCues: allCues };

          const stats = workerPool.getStats();
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: Math.min(chunks.length, stats.maxWorkers),
            chunksProcessed: chunks.length
          };

        } else {
          throw new Error(`Unknown mode: ${currentMode}`);
        }

        update((state) => ({
          ...state,
          result,
          metrics: performanceMetrics,
          isAnalyzing: false
        }));

      } catch (error) {
        update((state) => ({
          ...state,
          error: error as Error,
          isAnalyzing: false,
        }));
      }
    },

    setMode: (mode: ExecutionMode) => {
      update((state) => ({ ...state, mode }));
    },

    setChunkSize: (size: number) => {
      update((state) => ({ ...state, chunkSize: size }));
    },

    setRecordingDuration: (duration: number) => {
      update((state) => ({ ...state, recordingDuration: duration }));
    },

    getWorkerStats: () => {
      return workerPool?.getStats();
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

    destroy: () => {
      lipSyncEngine?.destroy();
      workerPool?.destroy();
    },
  };
}

export const lipSyncEngineStore = createLipSyncEngineStore();
