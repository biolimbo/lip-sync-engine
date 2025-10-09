import { useState, useCallback, useRef, useEffect } from 'react';
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
 * Example React hook for lip-sync-engine with all execution modes
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { analyze, result, isAnalyzing, error, mode, setMode } = useLipSyncEngine();
 *
 *   const handleAnalyze = async () => {
 *     const { pcm16 } = await recordAudio(5000);
 *     await analyze(pcm16, { dialogText: "Hello world" });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={() => setMode('single')}>Single Thread</button>
 *       <button onClick={() => setMode('worker')}>Web Worker</button>
 *       <button onClick={() => setMode('chunked')}>Chunked Workers</button>
 *       <button onClick={handleAnalyze} disabled={isAnalyzing}>
 *         Analyze
 *       </button>
 *       {result && <div>{result.mouthCues.length} cues found</div>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useLipSyncEngine() {
  const [mode, setMode] = useState<ExecutionMode>('single');
  const [result, setResult] = useState<LipSyncEngineResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [chunkSize, setChunkSize] = useState(5); // Default 5 seconds
  const [recordingDuration, setRecordingDuration] = useState(10); // Default 10 seconds
  const [isInitialized, setIsInitialized] = useState(false);

  const lipSyncEngineRef = useRef<LipSyncEngine | null>(null);
  const workerPoolRef = useRef<WorkerPool | null>(null);

  useEffect(() => {
    const initialize = async () => {
      try {
        // Only initialize LipSyncEngine for single thread mode
        if (mode === 'single') {
          console.log('Initializing LipSyncEngine (single thread)...');
          lipSyncEngineRef.current = LipSyncEngine.getInstance();
          // No options needed - uses CDN by default
          await lipSyncEngineRef.current.init();
          console.log('LipSyncEngine initialized');
        } else {
          // Initialize WorkerPool for worker and chunked modes
          workerPoolRef.current = WorkerPool.getInstance();

          if (mode === 'worker') {
            console.log('Initializing WorkerPool (single worker mode)...');
            // No options needed - uses CDN by default
            await workerPoolRef.current.init();
            console.log('✅ WorkerPool ready (1 worker)');
          } else {
            // Chunked or Streaming mode
            console.log(`Initializing WorkerPool (${mode} mode)...`);
            // No options needed - uses CDN by default
            await workerPoolRef.current.init();
            console.log('Creating worker pool...');
            await workerPoolRef.current.warmup();
            console.log(`✅ WorkerPool ready (${workerPoolRef.current.getStats().totalWorkers} workers)`);
          }
        }

        setIsInitialized(true);
        console.log('Initialization complete');
      } catch (err) {
        console.error('Initialization error:', err);
        setError(err as Error);
      }
    };

    initialize();

    // Cleanup on unmount
    return () => {
      lipSyncEngineRef.current?.destroy();
      workerPoolRef.current?.destroy();
    };
  }, [mode]); // Re-initialize when mode changes

  /**
   * Split audio into chunks for parallel processing
   */
  const splitIntoChunks = useCallback((pcm16: Int16Array, chunkDurationSec: number, sampleRate: number = 16000): Int16Array[] => {
    const chunkSizeSamples = chunkDurationSec * sampleRate;
    const chunks: Int16Array[] = [];

    for (let i = 0; i < pcm16.length; i += chunkSizeSamples) {
      chunks.push(pcm16.slice(i, Math.min(i + chunkSizeSamples, pcm16.length)));
    }

    return chunks;
  }, []);

  const analyze = useCallback(
    async (pcm16: Int16Array, options?: LipSyncEngineOptions) => {
      if (!isInitialized) {
        setError(new Error('Engine not initialized yet. Please wait...'));
        return;
      }

      setIsAnalyzing(true);
      setError(null);
      setMetrics(null);

      const startTime = performance.now();

      try {
        let result: LipSyncEngineResult;
        let performanceMetrics: PerformanceMetrics;

        if (mode === 'single') {
          // Single thread mode - blocks UI
          if (!lipSyncEngineRef.current) {
            throw new Error('LipSyncEngine not initialized');
          }

          result = await lipSyncEngineRef.current.analyze(pcm16, options);

          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length
          };

        } else if (mode === 'worker') {
          // Web Worker mode - non-blocking
          if (!workerPoolRef.current) {
            throw new Error('WorkerPool not initialized');
          }

          result = await workerPoolRef.current.analyze(pcm16, options);

          const stats = workerPoolRef.current.getStats();
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: stats.totalWorkers
          };

        } else if (mode === 'chunked') {
          // Chunked Workers mode - parallel processing (static)
          if (!workerPoolRef.current) {
            throw new Error('WorkerPool not initialized');
          }

          const chunks = splitIntoChunks(pcm16, chunkSize, options?.sampleRate || 16000);
          const results = await workerPoolRef.current.analyzeChunks(chunks, options);

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
            timeOffset += chunkSize;
          });

          result = { mouthCues: allCues };

          const stats = workerPoolRef.current.getStats();
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: Math.min(chunks.length, stats.maxWorkers),
            chunksProcessed: chunks.length
          };

        } else if (mode === 'streaming') {
          // Streaming mode - dynamic chunk processing
          if (!workerPoolRef.current) {
            throw new Error('WorkerPool not initialized');
          }

          const stream = workerPoolRef.current.createStreamAnalyzer(options);
          const chunks = splitIntoChunks(pcm16, chunkSize, options?.sampleRate || 16000);

          // Simulate streaming by adding chunks dynamically
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
            timeOffset += chunkSize;
          });

          result = { mouthCues: allCues };

          const stats = workerPoolRef.current.getStats();
          performanceMetrics = {
            executionTime: performance.now() - startTime,
            cuesCount: result.mouthCues.length,
            workersUsed: Math.min(chunks.length, stats.maxWorkers),
            chunksProcessed: chunks.length
          };

        } else {
          throw new Error(`Unknown mode: ${mode}`);
        }

        setResult(result);
        setMetrics(performanceMetrics);

      } catch (err) {
        setError(err as Error);
      } finally {
        setIsAnalyzing(false);
      }
    },
    [mode, chunkSize, splitIntoChunks, isInitialized]
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setIsAnalyzing(false);
    setMetrics(null);
  }, []);

  const getWorkerStats = useCallback(() => {
    return workerPoolRef.current?.getStats();
  }, []);

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
    setRecordingDuration,
    getWorkerStats
  };
}
