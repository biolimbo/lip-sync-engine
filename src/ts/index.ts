// Main exports
export { LipSyncEngine, analyze, analyzeAsync } from './LipSyncEngine';
export { WasmLoader } from './WasmLoader';
export { WorkerPool, StreamAnalyzerController } from './WorkerPool';

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
} from './types';

// Worker types
export type {
  WorkerAnalyzeRequest,
  WorkerAnalyzeResponse,
  WorkerInitRequest,
  WorkerInitResponse,
  WorkerRequest,
  WorkerResponse,
} from './worker';
