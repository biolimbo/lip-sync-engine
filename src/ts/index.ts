// Main exports
export { LipSyncEngine, analyze, analyzeAsync } from './LipSyncEngine';
export { WasmLoader } from './WasmLoader';
export { WorkerPool, StreamAnalyzerController } from './WorkerPool';
export type { StreamAnalyzerOptions, PrewarmMode } from './WorkerPool';

// Utilities
export * from './utils/AudioConverter';

// Types
export type {
  MouthCue,
  LipSyncEngineResult,
  LipSyncEngineOptions,
  LipSyncEngineModule,
  ProgressCallback,
  WasmLoaderOptions,
  RecognizerKind,
} from './types';

// Worker types
export type {
  WorkerAnalyzeRequest,
  WorkerAnalyzeResponse,
  WorkerInitRequest,
  WorkerInitResponse,
  WorkerRequest,
  WorkerResponse,
  WorkerStatsRequest,
  WorkerStatsResponse,
} from './worker';
