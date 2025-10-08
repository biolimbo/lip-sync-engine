import type {
  LipSyncResult,
  LipSyncOptions,
  LipSyncModule,
  WasmLoaderOptions,
} from './types';
import { WasmLoader } from './WasmLoader';

/**
 * Main API class for Lip Sync
 * Framework-agnostic - works with vanilla JS, React, Vue, Svelte, etc.
 *
 * @example Vanilla JavaScript
 * ```typescript
 * import { LipSync } from 'lip-sync-js';
 *
 * const lipSync = LipSync.getInstance();
 * await lipSync.init();
 *
 * const result = await lipSync.analyze(pcm16Buffer, {
 *   dialogText: "Hello world",
 *   sampleRate: 16000
 * });
 *
 * console.log(result.mouthCues);
 * ```
 *
 * @example React
 * ```typescript
 * // Create a custom hook in your app
 * function useLipSync() {
 *   const [result, setResult] = useState(null);
 *   const lipSyncRef = useRef(LipSync.getInstance());
 *
 *   useEffect(() => {
 *     lipSyncRef.current.init();
 *     return () => lipSyncRef.current.destroy();
 *   }, []);
 *
 *   const analyze = async (pcm16, options) => {
 *     const result = await lipSyncRef.current.analyze(pcm16, options);
 *     setResult(result);
 *   };
 *
 *   return { analyze, result };
 * }
 * ```
 */
export class LipSync {
  private static instance: LipSync | null = null;
  private module: LipSyncModule | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): LipSync {
    if (!this.instance) {
      this.instance = new LipSync();
    }
    return this.instance;
  }

  /**
   * Initialize the WASM module
   * Call this once before using analyze()
   *
   * @param options - Optional paths to WASM files
   */
  async init(options: WasmLoaderOptions = {}): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Load WASM module
      this.module = await WasmLoader.load(options);

      // Initialize LipSync with models
      const modelsPath = '/models';
      const modelsPathLen = this.module.lengthBytesUTF8(modelsPath) + 1;
      const modelsPathPtr = this.module._malloc(modelsPathLen);

      try {
        this.module.stringToUTF8(modelsPath, modelsPathPtr, modelsPathLen);
        const result = this.module._lipsync_init(modelsPathPtr);

        if (result !== 0) {
          const errorPtr = this.module._lipsync_get_last_error();
          const error = errorPtr
            ? this.module.UTF8ToString(errorPtr)
            : 'Unknown error';
          throw new Error(`LipSync initialization failed: ${error}`);
        }

        this.initialized = true;
      } finally {
        this.module._free(modelsPathPtr);
      }
    })();

    return this.initPromise;
  }

  /**
   * Analyze audio and generate lip-sync data
   *
   * @param pcm16 - 16-bit PCM audio buffer (mono, 16kHz recommended)
   * @param options - Optional configuration
   * @returns Promise resolving to lip-sync result with mouth cues
   *
   * @throws {TypeError} If pcm16 is not an Int16Array
   * @throws {Error} If audio buffer is empty
   * @throws {Error} If analysis fails
   */
  async analyze(
    pcm16: Int16Array,
    options: LipSyncOptions = {}
  ): Promise<LipSyncResult> {
    await this.init();

    if (!this.module) {
      throw new Error('Module not initialized');
    }

    const { dialogText, sampleRate = 16000 } = options;

    // Validate input
    if (!(pcm16 instanceof Int16Array)) {
      throw new TypeError('pcm16 must be an Int16Array');
    }

    if (pcm16.length === 0) {
      throw new Error('pcm16 buffer is empty');
    }

    if (sampleRate <= 0) {
      throw new Error('sampleRate must be positive');
    }

    let pcm16Ptr = 0;
    let dialogPtr = 0;
    let resultPtr = 0;

    try {
      // Allocate PCM buffer in WASM memory
      const pcm16Bytes = pcm16.length * 2;
      pcm16Ptr = this.module._malloc(pcm16Bytes);
      this.module.HEAP16.set(pcm16, pcm16Ptr / 2);

      // Allocate dialog text if provided
      if (dialogText) {
        const dialogLen = this.module.lengthBytesUTF8(dialogText) + 1;
        dialogPtr = this.module._malloc(dialogLen);
        this.module.stringToUTF8(dialogText, dialogPtr, dialogLen);
      }

      // Call WASM function
      resultPtr = this.module._lipsync_analyze_pcm16(
        pcm16Ptr,
        pcm16.length,
        sampleRate,
        dialogPtr
      );

      if (!resultPtr) {
        const errorPtr = this.module._lipsync_get_last_error();
        const error = errorPtr
          ? this.module.UTF8ToString(errorPtr)
          : 'Analysis failed';
        throw new Error(error);
      }

      // Parse JSON result
      const resultJson = this.module.UTF8ToString(resultPtr);
      const result: LipSyncResult = JSON.parse(resultJson);

      // Add metadata
      result.metadata = {
        duration: result.mouthCues[result.mouthCues.length - 1]?.end || 0,
        sampleRate,
        dialogText,
      };

      return result;
    } finally {
      // Always cleanup allocated memory
      if (pcm16Ptr) this.module._free(pcm16Ptr);
      if (dialogPtr) this.module._free(dialogPtr);
      if (resultPtr) this.module._lipsync_free(resultPtr);
    }
  }

  /**
   * Analyze audio using Web Worker (non-blocking)
   * Recommended for long audio files to avoid blocking UI
   *
   * @param pcm16 - 16-bit PCM audio buffer
   * @param options - Optional configuration
   * @returns Promise resolving to lip-sync result
   */
  async analyzeAsync(
    pcm16: Int16Array,
    options: LipSyncOptions = {}
  ): Promise<LipSyncResult> {
    // Lazy load WorkerPool to avoid circular dependencies
    const { WorkerPool } = await import('./WorkerPool');
    const pool = WorkerPool.getInstance();
    return pool.analyze(pcm16, options);
  }

  /**
   * Destroy the instance and free resources
   * Call this when you're completely done with lip-sync analysis
   */
  destroy(): void {
    this.module = null;
    this.initialized = false;
    this.initPromise = null;
    LipSync.instance = null;
  }
}

/**
 * Convenience function for one-off analysis
 * Framework-agnostic - works everywhere
 */
export const analyze = async (
  pcm16: Int16Array,
  options?: LipSyncOptions
): Promise<LipSyncResult> => {
  const instance = LipSync.getInstance();
  await instance.init();
  return instance.analyze(pcm16, options);
};

/**
 * Convenience function for async analysis with Web Worker
 */
export const analyzeAsync = async (
  pcm16: Int16Array,
  options?: LipSyncOptions
): Promise<LipSyncResult> => {
  const instance = LipSync.getInstance();
  return instance.analyzeAsync(pcm16, options);
};
