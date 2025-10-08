import type {
  LipSyncEngineResult,
  LipSyncEngineOptions,
  LipSyncEngineModule,
  WasmLoaderOptions,
} from './types';
import { WasmLoader } from './WasmLoader';

/**
 * Main API class for Lip Sync
 * Framework-agnostic - works with vanilla JS, React, Vue, Svelte, etc.
 *
 * @example Vanilla JavaScript
 * ```typescript
 * import { LipSyncEngine } from 'lip-sync-engine';
 *
 * const lipSyncEngine = LipSyncEngine.getInstance();
 * await lipSyncEngine.init();
 *
 * const result = await lipSyncEngine.analyze(pcm16Buffer, {
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
 * function useLipSyncEngine() {
 *   const [result, setResult] = useState(null);
 *   const lipSyncEngineRef = useRef(LipSyncEngine.getInstance());
 *
 *   useEffect(() => {
 *     lipSyncEngineRef.current.init();
 *     return () => lipSyncEngineRef.current.destroy();
 *   }, []);
 *
 *   const analyze = async (pcm16, options) => {
 *     const result = await lipSyncEngineRef.current.analyze(pcm16, options);
 *     setResult(result);
 *   };
 *
 *   return { analyze, result };
 * }
 * ```
 */
export class LipSyncEngine {
  private static instance: LipSyncEngine | null = null;
  private module: LipSyncEngineModule | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): LipSyncEngine {
    if (!this.instance) {
      this.instance = new LipSyncEngine();
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

      // Initialize LipSyncEngine with models
      const modelsPath = '/models';
      const modelsPathLen = this.module.lengthBytesUTF8(modelsPath) + 1;
      const modelsPathPtr = this.module._malloc(modelsPathLen);

      try {
        this.module.stringToUTF8(modelsPath, modelsPathPtr, modelsPathLen);
        const result = this.module._lipsyncengine_init(modelsPathPtr);

        if (result !== 0) {
          const errorPtr = this.module._lipsyncengine_get_last_error();
          const error = errorPtr
            ? this.module.UTF8ToString(errorPtr)
            : 'Unknown error';
          throw new Error(`LipSyncEngine initialization failed: ${error}`);
        }

        this.initialized = true;
      } finally {
        this.module._free(modelsPathPtr);
      }
    })();

    return this.initPromise;
  }

  /**
   * Analyze audio and generate lip-sync-engine data
   *
   * @param pcm16 - 16-bit PCM audio buffer (mono, 16kHz recommended)
   * @param options - Optional configuration
   * @returns Promise resolving to lip-sync-engine result with mouth cues
   *
   * @throws {TypeError} If pcm16 is not an Int16Array
   * @throws {Error} If audio buffer is empty
   * @throws {Error} If analysis fails
   */
  async analyze(
    pcm16: Int16Array,
    options: LipSyncEngineOptions = {}
  ): Promise<LipSyncEngineResult> {
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
      resultPtr = this.module._lipsyncengine_analyze_pcm16(
        pcm16Ptr,
        pcm16.length,
        sampleRate,
        dialogPtr
      );

      if (!resultPtr) {
        const errorPtr = this.module._lipsyncengine_get_last_error();
        const error = errorPtr
          ? this.module.UTF8ToString(errorPtr)
          : 'Analysis failed';
        throw new Error(error);
      }

      // Parse JSON result
      const resultJson = this.module.UTF8ToString(resultPtr);
      const result: LipSyncEngineResult = JSON.parse(resultJson);

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
      if (resultPtr) this.module._lipsyncengine_free(resultPtr);
    }
  }

  /**
   * Analyze audio using Web Worker (non-blocking)
   * Recommended for long audio files to avoid blocking UI
   *
   * @param pcm16 - 16-bit PCM audio buffer
   * @param options - Optional configuration
   * @returns Promise resolving to lip-sync-engine result
   */
  async analyzeAsync(
    pcm16: Int16Array,
    options: LipSyncEngineOptions = {}
  ): Promise<LipSyncEngineResult> {
    // Lazy load WorkerPool to avoid circular dependencies
    const { WorkerPool } = await import('./WorkerPool');
    const pool = WorkerPool.getInstance();
    return pool.analyze(pcm16, options);
  }

  /**
   * Destroy the instance and free resources
   * Call this when you're completely done with lip-sync-engine analysis
   */
  destroy(): void {
    this.module = null;
    this.initialized = false;
    this.initPromise = null;
    LipSyncEngine.instance = null;
  }
}

/**
 * Convenience function for one-off analysis
 * Framework-agnostic - works everywhere
 */
export const analyze = async (
  pcm16: Int16Array,
  options?: LipSyncEngineOptions
): Promise<LipSyncEngineResult> => {
  const instance = LipSyncEngine.getInstance();
  await instance.init();
  return instance.analyze(pcm16, options);
};

/**
 * Convenience function for async analysis with Web Worker
 */
export const analyzeAsync = async (
  pcm16: Int16Array,
  options?: LipSyncEngineOptions
): Promise<LipSyncEngineResult> => {
  const instance = LipSyncEngine.getInstance();
  return instance.analyzeAsync(pcm16, options);
};
