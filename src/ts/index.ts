// Main exports
export { LipSync, analyze, analyzeAsync } from './LipSync';
export { WasmLoader } from './WasmLoader';
export { WorkerPool } from './WorkerPool';

// Utilities
export * from './utils/AudioConverter';

// Types
export type {
  MouthCue,
  LipSyncResult,
  LipSyncOptions,
  LipSyncModule,
  ProgressCallback,
  WasmLoaderOptions,
} from './types';
