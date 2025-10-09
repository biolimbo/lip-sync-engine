import { ref, onUnmounted } from 'vue';
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
 * Example Vue composable for lip-sync-engine with all execution modes
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```vue
 * <script setup>
 * import { useLipSyncEngine } from './composables/useLipSyncEngine';
 * import { recordAudio } from 'lip-sync-engine';
 *
 * const { analyze, result, isAnalyzing, error, mode, setMode } = useLipSyncEngine();
 *
 * const handleAnalyze = async () => {
 *   const { pcm16 } = await recordAudio(5000);
 *   await analyze(pcm16, { dialogText: "Hello world" });
 * };
 * </script>
 *
 * <template>
 *   <div>
 *     <button @click="() => setMode('single')">Single Thread</button>
 *     <button @click="() => setMode('worker')">Web Worker</button>
 *     <button @click="() => setMode('chunked')">Chunked Workers</button>
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
  const chunkSize = ref(5); // Default 5 seconds
  const recordingDuration = ref(10); // Default 10 seconds
  const isInitialized = ref(false);

  let lipSyncEngine: LipSyncEngine | null = null;
  let workerPool: WorkerPool | null = null;
  let currentInitializedMode: ExecutionMode | null = null;

  const init = async () => {
    // Skip if already initialized for this mode
    if (isInitialized.value && currentInitializedMode === mode.value) {
      return;
    }

    // Cleanup previous initialization
    if (currentInitializedMode !== mode.value) {
      lipSyncEngine?.destroy();
      workerPool?.destroy();
      lipSyncEngine = null;
      workerPool = null;
      isInitialized.value = false;
    }

    try {
      if (mode.value === 'single') {
        // Initialize LipSyncEngine for single thread mode
        console.log('Initializing LipSyncEngine (single thread)...');
        lipSyncEngine = LipSyncEngine.getInstance();
        await lipSyncEngine.init({
          wasmPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.wasm',
          dataPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.data',
          jsPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.js'
        });
        console.log('LipSyncEngine initialized');
      } else {
        // Initialize WorkerPool for worker and chunked modes
        workerPool = WorkerPool.getInstance();

        if (mode.value === 'worker') {
          console.log('Initializing WorkerPool (single worker mode)...');
          await workerPool.init({
            wasmPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.wasm',
            dataPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.data',
            jsPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.js',
            workerScriptUrl: 'https://unpkg.com/lip-sync-engine@latest/dist/worker.js'
          });
          console.log('✅ WorkerPool ready (1 worker)');
        } else {
          // Chunked or Streaming mode
          console.log(`Initializing WorkerPool (${mode.value} mode)...`);
          await workerPool.init({
            wasmPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.wasm',
            dataPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.data',
            jsPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.js',
            workerScriptUrl: 'https://unpkg.com/lip-sync-engine@latest/dist/worker.js'
          });
          console.log('Creating worker pool...');
          await workerPool.warmup();
          console.log(`✅ WorkerPool ready (${workerPool.getStats().totalWorkers} workers)`);
        }
      }

      currentInitializedMode = mode.value;
      isInitialized.value = true;
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

  const analyze = async (pcm16: Int16Array, options?: LipSyncEngineOptions) => {
    try {
      await init();

      isAnalyzing.value = true;
      error.value = null;
      metrics.value = null;

      const startTime = performance.now();

      let analysisResult: LipSyncEngineResult;
      let performanceMetrics: PerformanceMetrics;

      if (mode.value === 'single') {
        // Single thread mode - blocks UI
        if (!lipSyncEngine) {
          throw new Error('LipSyncEngine not initialized');
        }

        analysisResult = await lipSyncEngine.analyze(pcm16, options);

        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length
        };

      } else if (mode.value === 'worker') {
        // Web Worker mode - non-blocking
        if (!workerPool) {
          throw new Error('WorkerPool not initialized');
        }

        analysisResult = await workerPool.analyze(pcm16, options);

        const stats = workerPool.getStats();
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length,
          workersUsed: stats.totalWorkers
        };

      } else if (mode.value === 'chunked') {
        // Chunked Workers mode - parallel processing (static)
        if (!workerPool) {
          throw new Error('WorkerPool not initialized');
        }

        const chunks = splitIntoChunks(pcm16, chunkSize.value, options?.sampleRate || 16000);
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
          timeOffset += chunkSize.value;
        });

        analysisResult = { mouthCues: allCues };

        const stats = workerPool.getStats();
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length,
          workersUsed: Math.min(chunks.length, stats.maxWorkers),
          chunksProcessed: chunks.length
        };

      } else if (mode.value === 'streaming') {
        // Streaming mode - dynamic chunk processing
        if (!workerPool) {
          throw new Error('WorkerPool not initialized');
        }

        const stream = workerPool.createStreamAnalyzer(options);
        const chunks = splitIntoChunks(pcm16, chunkSize.value, options?.sampleRate || 16000);

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
          timeOffset += chunkSize.value;
        });

        analysisResult = { mouthCues: allCues };

        const stats = workerPool.getStats();
        performanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length,
          workersUsed: Math.min(chunks.length, stats.maxWorkers),
          chunksProcessed: chunks.length
        };

      } else {
        throw new Error(`Unknown mode: ${mode.value}`);
      }

      result.value = analysisResult;
      metrics.value = performanceMetrics;

    } catch (err) {
      error.value = err as Error;
      throw err;
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

  const setMode = (newMode: ExecutionMode) => {
    mode.value = newMode;
  };

  const setChunkSize = (size: number) => {
    chunkSize.value = size;
  };

  const getWorkerStats = () => {
    return workerPool?.getStats();
  };

  onUnmounted(() => {
    lipSyncEngine?.destroy();
    workerPool?.destroy();
  });

  return {
    analyze,
    result,
    isAnalyzing,
    error,
    metrics,
    reset,
    mode,
    setMode,
    chunkSize,
    setChunkSize,
    recordingDuration,
    setRecordingDuration: (value: number) => { recordingDuration.value = value; },
    getWorkerStats,
  };
}
