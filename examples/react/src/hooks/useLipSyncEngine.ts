import { useState, useCallback, useEffect } from 'react';
import { LipSyncEngine, WorkerPool, WorkerPoolDestroyedError } from 'lip-sync-engine';
import type { LipSyncEngineResult, LipSyncEngineOptions, MouthCue } from 'lip-sync-engine';

export type ExecutionMode = 'single' | 'worker' | 'chunked' | 'streaming';

export interface PerformanceMetrics {
  executionTime: number;
  cuesCount: number;
  workersUsed?: number;
  chunksProcessed?: number;
}

export interface AnalysisOutcome {
  result: LipSyncEngineResult;
  metrics: PerformanceMetrics;
}

// The engine and the worker pool are app-wide singletons. They stay alive
// across mode changes and unmounts so no analysis pays the startup cost again.
// No init options are passed, so the WASM files and the worker script load
// from unpkg at the installed package version.

// Each worker holds its own copy of the model, so cap the pool size.
const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 4);

/** Start what the mode needs. Repeated calls share the library's in-flight startup. */
async function prepare(mode: ExecutionMode): Promise<void> {
  if (mode === 'single') {
    await LipSyncEngine.getInstance().init();
    return;
  }
  const pool = WorkerPool.getInstance(MAX_WORKERS);
  await pool.init();
  // Streaming also starts every worker: it shares this pool with chunked mode.
  if (mode === 'chunked' || mode === 'streaming') await pool.warmup();
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
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

/** React hook that runs lip-sync-engine in one of four execution modes and tracks the result. */
export function useLipSyncEngine() {
  const [mode, setMode] = useState<ExecutionMode>('single');
  const [result, setResult] = useState<LipSyncEngineResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [chunkSize, setChunkSize] = useState(5); // seconds
  const [recordingDuration, setRecordingDuration] = useState(10); // seconds
  // Startup state belongs to a mode, so switching modes never shows the
  // previous mode's state.
  const [readyMode, setReadyMode] = useState<ExecutionMode | null>(null);
  const [initFailure, setInitFailure] = useState<{ mode: ExecutionMode; error: Error } | null>(null);
  const isInitialized = readyMode === mode;
  const initError = initFailure?.mode === mode ? initFailure.error : null;

  // Start what the selected mode needs. Nothing is torn down when the mode
  // changes or the component unmounts.
  useEffect(() => {
    let current = true;
    prepare(mode).then(
      () => { if (current) setReadyMode(mode); },
      (err) => {
        if (!current || err instanceof WorkerPoolDestroyedError) return;
        setInitFailure({ mode, error: toError(err) });
      }
    );
    return () => { current = false; };
  }, [mode]);

  const analyze = useCallback(
    async (pcm16: Int16Array, options: LipSyncEngineOptions = {}): Promise<AnalysisOutcome> => {
      setIsAnalyzing(true);
      setError(null);
      setMetrics(null);

      try {
        const sampleRate = options.sampleRate ?? 16000;
        await prepare(mode);
        setReadyMode(mode);
        setInitFailure(null);
        const startTime = performance.now();

        let analysisResult: LipSyncEngineResult;
        let workersUsed: number | undefined;
        let chunksProcessed: number | undefined;

        if (mode === 'single') {
          // Runs on the main thread and blocks the UI
          analysisResult = await LipSyncEngine.getInstance().analyze(pcm16, options);

        } else if (mode === 'worker') {
          // Runs in a Web Worker; the UI stays responsive
          analysisResult = await WorkerPool.getInstance(MAX_WORKERS).analyze(pcm16, options);
          workersUsed = 1;

        } else if (mode === 'chunked') {
          // Analyzes the chunks in parallel. Each chunk is analyzed on its own,
          // so cues near chunk edges are less accurate.
          const pool = WorkerPool.getInstance(MAX_WORKERS);
          const chunks = splitIntoChunks(pcm16, chunkSize, sampleRate);
          const results = await pool.analyzeChunks(chunks, options);
          analysisResult = mergeChunkResults(results, chunks, sampleRate);
          workersUsed = Math.min(chunks.length, pool.getStats().totalWorkers);
          chunksProcessed = chunks.length;

        } else {
          // Each chunk is analyzed with 500 ms of audio before and after it,
          // and only its own cues are returned (times relative to the chunk).
          const stream = WorkerPool.getInstance(MAX_WORKERS).createStreamAnalyzer({
            ...options,
            sampleRate,
            contextMs: 500,
            lookaheadMs: 500
          });

          // A live source would call addChunk() as audio arrives. This example
          // splits the finished recording to simulate that.
          const chunks = splitIntoChunks(pcm16, chunkSize, sampleRate);
          const indexes = chunks.map((chunk) => stream.addChunk(chunk));
          stream.end();

          // Each chunk's cues are usable as soon as its getResult() resolves;
          // this example waits for all of them.
          const results = await Promise.all(indexes.map((i) => stream.getResult(i)));
          analysisResult = mergeChunkResults(results, chunks, sampleRate);
          chunksProcessed = chunks.length;
        }

        const performanceMetrics: PerformanceMetrics = {
          executionTime: performance.now() - startTime,
          cuesCount: analysisResult.mouthCues.length,
          workersUsed,
          chunksProcessed
        };
        setResult(analysisResult);
        setMetrics(performanceMetrics);
        return { result: analysisResult, metrics: performanceMetrics };
      } catch (err) {
        const e = toError(err);
        setError(e);
        throw e;
      } finally {
        setIsAnalyzing(false);
      }
    },
    [mode, chunkSize]
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setIsAnalyzing(false);
    setMetrics(null);
  }, []);

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
    setMode,
    chunkSize,
    setChunkSize,
    recordingDuration,
    setRecordingDuration
  };
}
