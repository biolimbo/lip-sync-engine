// Main exports
export { LipSyncEngine, analyze, analyzeAsync } from './LipSyncEngine';
export { WasmLoader } from './WasmLoader';
export { WorkerPool } from './WorkerPool';

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
