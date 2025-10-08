/**
 * Represents a single mouth shape with timing information
 */
export interface MouthCue {
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Mouth shape: X (closed), A-H (various open positions) */
  value: string;
}

/**
 * Result of lip-sync analysis
 */
export interface LipSyncResult {
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
 * Options for lip-sync analysis
 */
export interface LipSyncOptions {
  /**
   * Optional dialog text for improved recognition accuracy
   * Providing the expected text significantly improves results
   */
  dialogText?: string;

  /**
   * Sample rate of the audio buffer
   * @default 16000
   * @recommended 16000 for best PocketSphinx results
   */
  sampleRate?: number;
}

/**
 * Progress callback for analysis
 */
export type ProgressCallback = (progress: number) => void;

/**
 * WASM module interface (internal)
 */
export interface LipSyncModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  _lipsync_init(modelsPathPtr: number): number;
  _lipsync_analyze_pcm16(
    pcm16Ptr: number,
    sampleCount: number,
    sampleRate: number,
    dialogPtr: number
  ): number;
  _lipsync_free(ptr: number): void;
  _lipsync_get_last_error(): number;
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
}
