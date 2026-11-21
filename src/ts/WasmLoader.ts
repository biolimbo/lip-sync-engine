import type { LipSyncEngineModule, WasmLoaderOptions } from './types';
import packageJson from '../../package.json';

// Declare worker globals for TypeScript
declare const WorkerGlobalScope: any;
declare function importScripts(...urls: string[]): void;

/**
 * Compile the .wasm file. Resolves undefined when that fails, so Emscripten's
 * own loading can try instead and report the error.
 */
export async function compileWasm(
  wasmPath: string,
  signal?: AbortSignal
): Promise<WebAssembly.Module | undefined> {
  try {
    const response = await fetch(wasmPath, signal ? { signal } : undefined);
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

async function downloadData(
  dataPath: string,
  cache?: RequestCache,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch(dataPath, cache || signal ? { cache, signal } : undefined);
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
export async function fetchDataFile(dataPath: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  try {
    try {
      return await downloadData(dataPath, undefined, signal);
    } catch (error) {
      if (error instanceof DataStatusError || signal?.aborted) throw error;
      // A network error. When the browser cannot store the file in its HTTP
      // cache (for example in a private window), concurrent downloads of the
      // same URL can fail while sharing one cache entry. Retry once without
      // the cache.
      return await downloadData(dataPath, 'no-store', signal);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load model data from ${dataPath}: ${reason}`);
  }
}

/** Downloads already started by the caller, used instead of starting new ones */
export interface StartedAssets {
  /** Contents of the .data file */
  data: Promise<ArrayBuffer>;
  /** Compiled .wasm; undefined lets Emscripten fetch and compile it */
  compiled: Promise<WebAssembly.Module | undefined>;
}

/**
 * Loads the WASM module
 * This is a singleton loader that handles WASM initialization
 */
export class WasmLoader {
  private static modulePromise: Promise<LipSyncEngineModule> | null = null;
  private static module: LipSyncEngineModule | null = null;
  /** Incremented by reset(), so a load started before it cannot fill the cache */
  private static generation = 0;

  /**
   * Load the WASM module once and cache it. Later calls return the cached
   * module or the load in progress, and ignore their options. A failed load
   * is not cached: the next call loads again.
   * @param options - Optional paths to WASM files
   * @returns Promise resolving to the loaded WASM module
   */
  static async load(options: WasmLoaderOptions = {}): Promise<LipSyncEngineModule> {
    if (this.module) {
      return this.module;
    }
    if (this.modulePromise) {
      return this.modulePromise;
    }

    const generation = this.generation;
    const promise: Promise<LipSyncEngineModule> = loadModuleImpl(options).then(
      (module) => {
        if (this.generation === generation) {
          this.module = module;
        }
        return module;
      },
      (error) => {
        if (this.modulePromise === promise) {
          this.modulePromise = null;
        }
        throw error;
      }
    );
    this.modulePromise = promise;
    return promise;
  }

  /**
   * Load a new module instance on every call, without caching.
   * The pool's workers use it.
   */
  static async loadModule(options: WasmLoaderOptions = {}): Promise<LipSyncEngineModule> {
    return loadModuleImpl(options);
  }

  /**
   * Drop the module cached by load(), so it can be garbage-collected and the
   * next load() loads again. A load in progress still resolves for its
   * callers but is not cached.
   */
  static reset(): void {
    this.generation++;
    this.module = null;
    this.modulePromise = null;
  }
}

/**
 * Load a new module instance from downloads the caller already started. The
 * worker uses it to download the .data file while it compiles the .wasm.
 */
export function loadModuleWithAssets(
  options: WasmLoaderOptions,
  assets: StartedAssets
): Promise<LipSyncEngineModule> {
  return loadModuleImpl(options, assets);
}

/**
 * Implementation of module loading that works in both window and worker contexts
 */
async function loadModuleImpl(
  options: WasmLoaderOptions,
  started?: StartedAssets
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
  // loads. Errors surface when the module is created. On the main thread the
  // downloads are aborted if the loader script fails to load.
  const downloads = isWorker ? undefined : new AbortController();
  const dataPromise = started?.data ?? (options.dataBuffer
    ? Promise.resolve(options.dataBuffer)
    : fetchDataFile(dataPath, downloads?.signal));
  dataPromise.catch(() => {});
  const compiledPromise = started?.compiled ?? (wasmModule
    ? Promise.resolve(wasmModule)
    : compileWasm(wasmPath, downloads?.signal));

  // Emscripten has no failure callback for instantiateWasm, so report
  // instantiation errors through a promise raced against module creation.
  let hookFailed: (error: unknown) => void = () => {};
  const hookFailure = new Promise<never>((_, reject) => { hookFailed = reject; });
  hookFailure.catch(() => {});

  const createWithHooks = async (createModule: ModuleFactory): Promise<LipSyncEngineModule> => {
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
    // importScripts() defines the factory in the worker's global scope
    importScripts(jsPath);
    const createModule: ModuleFactory | undefined = (self as any).createLipSyncEngineModule;
    if (!createModule) {
      throw new Error(
        'WASM module factory not found in worker. Make sure lip-sync-engine.js exports createLipSyncEngineModule.'
      );
    }
    return createWithHooks(createModule);
  }

  // Main thread: the loader script defines the factory on window. It can
  // create any number of modules, so a script that already ran is reused.
  const existing: ModuleFactory | undefined = (window as any).createLipSyncEngineModule;
  if (existing) {
    return createWithHooks(existing);
  }
  const createModule = await new Promise<ModuleFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = jsPath;
    script.async = true;
    const fail = (error: Error) => {
      script.remove();
      downloads?.abort();
      reject(error);
    };
    script.onload = () => {
      const factory: ModuleFactory | undefined = (window as any).createLipSyncEngineModule;
      if (factory) {
        resolve(factory);
      } else {
        fail(new Error('WASM module factory not found. Make sure lip-sync-engine.js is loaded correctly.'));
      }
    };
    script.onerror = () => fail(new Error(`Failed to load WASM module from ${jsPath}`));
    document.head.appendChild(script);
  });
  return createWithHooks(createModule);
}

type ModuleFactory = (moduleOptions: Record<string, unknown>) => Promise<LipSyncEngineModule>;
