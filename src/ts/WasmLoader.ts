import type { LipSyncEngineModule, WasmLoaderOptions } from './types';
import packageJson from '../../package.json';

// Declare worker globals for TypeScript
declare const WorkerGlobalScope: any;
declare function importScripts(...urls: string[]): void;

/**
 * Compile the .wasm file. Resolves undefined when that fails, so Emscripten's
 * own loading can try instead and report the error.
 */
export async function compileWasm(wasmPath: string): Promise<WebAssembly.Module | undefined> {
  try {
    const response = await fetch(wasmPath);
    if (!response.ok) {
      return undefined;
    }
    // Streaming compilation needs the application/wasm content type
    const streamable = typeof WebAssembly.compileStreaming === 'function' &&
      (response.headers.get('Content-Type') ?? '').startsWith('application/wasm');
    return streamable
      ? await WebAssembly.compileStreaming(response)
      : await WebAssembly.compile(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

/** HTTP error status for the .data file; not retried */
class DataStatusError extends Error {}

async function downloadData(dataPath: string, cache?: RequestCache): Promise<ArrayBuffer> {
  const response = await fetch(dataPath, cache ? { cache } : undefined);
  if (!response.ok) {
    throw new DataStatusError(`HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

/**
 * Download the .data file. Emscripten's own download leaves the module
 * pending forever when it fails, so the loader downloads the file itself and
 * hands it over through getPreloadedPackage.
 */
export async function fetchDataFile(dataPath: string): Promise<ArrayBuffer> {
  try {
    try {
      return await downloadData(dataPath);
    } catch (error) {
      if (error instanceof DataStatusError) throw error;
      // A network error. When the browser cannot store the file in its HTTP
      // cache (for example in a private window), concurrent downloads of the
      // same URL can fail while sharing one cache entry. Retry once without
      // the cache.
      return await downloadData(dataPath, 'no-store');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load model data from ${dataPath}: ${reason}`);
  }
}

/**
 * Loads the WASM module
 * This is a singleton loader that handles WASM initialization
 */
export class WasmLoader {
  private static modulePromise: Promise<LipSyncEngineModule> | null = null;
  private static module: LipSyncEngineModule | null = null;

  /**
   * Load the WASM module
   * @param options - Optional paths to WASM files
   * @returns Promise resolving to the loaded WASM module
   */
  static async load(options: WasmLoaderOptions = {}): Promise<LipSyncEngineModule> {
    // Return cached module if already loaded
    if (this.module) {
      return this.module;
    }

    // Return in-progress load if already loading
    if (this.modulePromise) {
      return this.modulePromise;
    }

    this.modulePromise = this._loadModuleImpl(options);
    this.module = await this.modulePromise;
    return this.module;
  }

  /**
   * Load a new module instance on every call, without caching.
   * The pool's workers use it.
   */
  static async loadModule(options: WasmLoaderOptions = {}): Promise<LipSyncEngineModule> {
    return this._loadModuleImpl(options);
  }

  /**
   * Implementation of module loading that works in both window and worker contexts
   */
  private static async _loadModuleImpl(
    options: WasmLoaderOptions
  ): Promise<LipSyncEngineModule> {
    const version = packageJson.version;
    const {
      wasmPath = `https://unpkg.com/lip-sync-engine@${version}/dist/wasm/lip-sync-engine.wasm`,
      dataPath = `https://unpkg.com/lip-sync-engine@${version}/dist/wasm/lip-sync-engine.data`,
      jsPath = `https://unpkg.com/lip-sync-engine@${version}/dist/wasm/lip-sync-engine.js`,
      wasmModule,
    } = options;

    const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
    if (!isWorker && typeof window === 'undefined') {
      throw new Error('WasmLoader can only be used in browser or worker environments');
    }

    // Download the .data file and compile the .wasm while the loader script
    // loads. Errors surface when the module is created.
    const dataPromise = options.dataBuffer
      ? Promise.resolve(options.dataBuffer)
      : fetchDataFile(dataPath);
    dataPromise.catch(() => {});
    const compiledPromise = wasmModule ? Promise.resolve(wasmModule) : compileWasm(wasmPath);

    // Emscripten has no failure callback for instantiateWasm, so report
    // instantiation errors through a promise raced against module creation.
    let hookFailed: (error: unknown) => void = () => {};
    const hookFailure = new Promise<never>((_, reject) => { hookFailed = reject; });
    hookFailure.catch(() => {});

    const createWithHooks = async (
      createModule: (moduleOptions: Record<string, unknown>) => Promise<LipSyncEngineModule>
    ): Promise<LipSyncEngineModule> => {
      let dataBuffer: ArrayBuffer | undefined = await dataPromise;
      const compiled = await compiledPromise;
      const hooks: Record<string, unknown> = {
        getPreloadedPackage: () => {
          const buffer = dataBuffer;
          dataBuffer = undefined; // used once; let it be collected with the FS
          return buffer;
        },
        locateFile: (path: string) => {
          if (path.endsWith('.wasm')) {
            return wasmPath;
          }
          if (path.endsWith('.data')) {
            return dataPath;
          }
          return path;
        },
      };
      if (compiled) {
        // Reuse the compiled module instead of fetching and compiling again
        hooks.instantiateWasm = (
          imports: WebAssembly.Imports,
          receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
        ) => {
          WebAssembly.instantiate(compiled, imports)
            .then((instance) => receive(instance, compiled))
            .catch((error) => hookFailed(error));
          return {};
        };
      }
      return Promise.race([hookFailure, createModule(hooks)]);
    };

    if (isWorker) {
      // Worker context - use importScripts
      return new Promise(async (resolve, reject) => {
        try {
          // Import the Emscripten JS file
          importScripts(jsPath);

          // The factory function is now available in global scope
          const createModule = (self as any).createLipSyncEngineModule;

          if (!createModule) {
            throw new Error(
              'WASM module factory not found in worker. Make sure lip-sync-engine.js exports createLipSyncEngineModule.'
            );
          }

          const module = await createWithHooks(createModule);

          resolve(module as LipSyncEngineModule);
        } catch (error) {
          reject(error);
        }
      });
    } else {
      // Window context - use dynamic script loading
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = jsPath;
        script.async = true;

        script.onload = async () => {
          try {
            // The Emscripten module should expose a factory function
            const createModule = (window as any).createLipSyncEngineModule;

            if (!createModule) {
              throw new Error(
                'WASM module factory not found. Make sure lip-sync-engine.js is loaded correctly.'
              );
            }

            const module = await createWithHooks(createModule);

            resolve(module as LipSyncEngineModule);
          } catch (error) {
            reject(error);
          }
        };

        script.onerror = () => {
          script.remove();
          reject(new Error(`Failed to load WASM module from ${jsPath}`));
        };

        document.head.appendChild(script);
      });
    }
  }

  /**
   * Reset the loader (useful for testing)
   */
  static reset(): void {
    this.module = null;
    this.modulePromise = null;
  }
}
