import type {
  LipSyncEngineResult,
  LipSyncEngineOptions,
  LipSyncEngineModule,
  WasmLoaderOptions,
} from './types';
import { WasmLoader } from './WasmLoader';
import { applyExtendedShapes } from './extendedShapes';

/**
 * Main-thread lip sync engine (singleton).
 * Framework-agnostic: works with vanilla JS, React, Vue, Svelte, and others.
 *
 * @example Vanilla JavaScript
 * ```typescript
 * import { LipSyncEngine } from 'lip-sync-engine';
 *
 * const lipSyncEngine = LipSyncEngine.getInstance();
 * await lipSyncEngine.init(); // optional: analyze() loads the engine too
 *
 * const result = await lipSyncEngine.analyze(pcm16Buffer, {
 *   dialogText: 'Hello world',
 *   sampleRate: 16000,
 * });
 *
 * console.log(result.mouthCues);
 * ```
 *
 * @example React
 * ```typescript
 * import { useEffect, useState } from 'react';
 * import { LipSyncEngine } from 'lip-sync-engine';
 * import type { LipSyncEngineOptions, LipSyncEngineResult } from 'lip-sync-engine';
 *
 * // A custom hook in your app. The engine is shared by the whole page, so
 * // the hook does not destroy it when the component unmounts.
 * function useLipSyncEngine() {
 *   const [result, setResult] = useState<LipSyncEngineResult | null>(null);
 *
 *   useEffect(() => {
 *     // Start loading early. analyze() waits for this load, and loads again
 *     // (reporting the error) if it failed.
 *     LipSyncEngine.getInstance().init().catch(() => {});
 *   }, []);
 *
 *   const analyze = async (pcm16: Int16Array, options?: LipSyncEngineOptions) => {
 *     setResult(await LipSyncEngine.getInstance().analyze(pcm16, options));
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
   * Get the singleton instance, creating it on the first call or after destroy()
   */
  static getInstance(): LipSyncEngine {
    if (!this.instance) {
      this.instance = new LipSyncEngine();
    }
    return this.instance;
  }

  /**
   * Load the WASM module and start the engine.
   *
   * Optional: analyze() calls it with the default (CDN) paths. Call it
   * yourself, before any analyze(), to load self-hosted files or to load the
   * engine ahead of the first analysis. The module loads once per page;
   * calls made while it loads or after it loaded share that load and ignore
   * their options. A failed load is not kept: the next init() or analyze()
   * loads again.
   *
   * @param options - Optional paths to WASM files
   */
  async init(options: WasmLoaderOptions = {}): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    const promise: Promise<void> = (async () => {
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
    this.initPromise = promise;
    // Forget a failed start so the next call tries again
    promise.catch(() => {
      if (this.initPromise === promise) this.initPromise = null;
    });

    return promise;
  }

  /**
   * Analyze audio on the main thread and return its mouth cues. Calls init()
   * first if needed. The main thread is blocked while the analysis runs.
   *
   * @param pcm16 - 16-bit PCM audio buffer (mono, 16kHz recommended)
   * @param options - Optional configuration
   * @returns Promise resolving to lip-sync-engine result with mouth cues
   *
   * @throws {TypeError} If pcm16 is not an Int16Array
   * @throws {Error} If audio buffer is empty
   * @throws {Error} If the engine cannot load (see init())
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

    applyExtendedShapes(this.module, options.extendedShapes);

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
   * Analyze audio in a Web Worker so the main thread stays responsive. Uses
   * the shared WorkerPool: WorkerPool.getInstance() without arguments and
   * init() without options, so paths passed to this class's init() are not
   * used. To self-host or choose the worker count, start the pool yourself
   * before the first call. The pool keeps running afterwards.
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
    // Start the shared pool if the app has not (returns at once when running).
    // Uses the pool's own paths (CDN defaults unless WorkerPool.init() set them).
    await pool.init();
    return pool.analyze(pcm16, options);
  }

  /**
   * Drop this instance; the next getInstance() returns a new one. The loaded
   * WASM module stays cached and is reused by later instances; call
   * WasmLoader.reset() as well to let it be garbage-collected. Does not
   * affect the WorkerPool.
   */
  destroy(): void {
    this.module = null;
    this.initialized = false;
    this.initPromise = null;
    LipSyncEngine.instance = null;
  }
}

/**
 * Shorthand for LipSyncEngine.getInstance().analyze(): analyzes on the main
 * thread, loading the engine with the default paths if needed.
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
 * Shorthand for LipSyncEngine.getInstance().analyzeAsync(): analyzes in a
 * worker of the shared WorkerPool, starting the pool with its defaults if it
 * is not running.
 */
export const analyzeAsync = async (
  pcm16: Int16Array,
  options?: LipSyncEngineOptions
): Promise<LipSyncEngineResult> => {
  const instance = LipSyncEngine.getInstance();
  return instance.analyzeAsync(pcm16, options);
};
