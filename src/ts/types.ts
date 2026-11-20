/**
 * Represents a single mouth shape with timing information
 */
export interface MouthCue {
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Mouth shape: A-F, G (F, V), H (L) or X (idle). Only A-F with `extendedShapes: ''` */
  value: string;
}

/**
 * Result of lip-sync-engine analysis
 */
export interface LipSyncEngineResult {
  /** Array of mouth cues with precise timing */
  mouthCues: MouthCue[];
  /** Optional metadata about the analysis */
  metadata?: {
    /** Duration of analyzed audio in seconds */
    duration: number;
    /** Sample rate of input audio */
    sampleRate: number;
    /** Dialog text used for analysis (if provided) */
    dialogText?: string;
  };
}

/**
 * Options for lip-sync-engine analysis
 */
export interface LipSyncEngineOptions {
  /**
   * Optional dialog text for improved recognition accuracy
   * Providing the expected text significantly improves results
   */
  dialogText?: string;

  /**
   * Rhubarb's extended mouth shapes to use in addition to A-F: any
   * combination of 'G' (F, V), 'H' (L) and 'X' (idle). Default 'GHX' (all
   * nine shapes) since 2.0.0. Use '' for basic shapes A-F only, as in 1.x.
   */
  extendedShapes?: string;

  /**
   * Sample rate of the audio buffer
   * @default 16000
   * @recommended 16000 for best PocketSphinx results
   */
  sampleRate?: number;
}

/**
 * Speech recognizer used to find phones.
 * - 'pocketsphinx' (default): word recognition with a language model, then
 *   phone alignment. Best for English. Uses dialogText when given.
 * - 'phonetic': phone recognition without words. Starts faster and uses less
 *   memory; ignores dialogText. See BENCHMARK.md for the quality trade-off.
 */
export type RecognizerKind = 'pocketsphinx' | 'phonetic';

/**
 * Progress callback for analysis
 */
export type ProgressCallback = (progress: number) => void;

/**
 * WASM module interface (internal)
 */
export interface LipSyncEngineModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  _lipsyncengine_init(modelsPathPtr: number): number;
  /** Builds the speech decoder ahead of the first analysis (2.0.0+) */
  _lipsyncengine_prewarm?(): number;
  /** 0 = PocketSphinx words (default), 1 = phonetic (2.0.0+) */
  _lipsyncengine_set_recognizer?(kind: number): number;
  /** Extended shapes on top of A-F, any of "GHX" (2.0.0+) */
  _lipsyncengine_set_extended_shapes?(shapesPtr: number): number;
  _lipsyncengine_analyze_pcm16(
    pcm16Ptr: number,
    sampleCount: number,
    sampleRate: number,
    dialogPtr: number
  ): number;
  _lipsyncengine_free(ptr: number): void;
  _lipsyncengine_get_last_error(): number;
  _lipsyncengine_cleanup(): void; // Phase 0: Decoder cleanup
  HEAP16: Int16Array;
  lengthBytesUTF8(str: string): number;
  stringToUTF8(str: string, ptr: number, maxLen: number): void;
  UTF8ToString(ptr: number): string;
}

/**
 * WASM loader options
 */
export interface WasmLoaderOptions {
  /** Path to the .wasm file */
  wasmPath?: string;
  /** Path to the .data file */
  dataPath?: string;
  /** Path to the .js file */
  jsPath?: string;
  /**
   * Already compiled .wasm module (skips download and compile).
   * Used by WorkerPool to compile once and share with all workers.
   */
  wasmModule?: WebAssembly.Module;
  /**
   * Contents of the .data file, if you already have them (skips its
   * download). Used once.
   */
  dataBuffer?: ArrayBuffer;
}
