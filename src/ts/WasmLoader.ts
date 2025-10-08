import type { LipSyncEngineModule, WasmLoaderOptions } from './types';

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

    this.modulePromise = this._loadModule(options);
    this.module = await this.modulePromise;
    return this.module;
  }

  /**
   * Internal method to load the module
   */
  private static async _loadModule(
    options: WasmLoaderOptions
  ): Promise<LipSyncEngineModule> {
    const {
      wasmPath = '/dist/wasm/lip-sync-engine.wasm',
      dataPath = '/dist/wasm/lip-sync-engine.data',
      jsPath = '/dist/wasm/lip-sync-engine.js',
    } = options;

    // Check if we're in a browser environment
    if (typeof window === 'undefined') {
      throw new Error('WasmLoader can only be used in a browser environment');
    }

    // Dynamically load the Emscripten-generated JS file
    // This creates a global function (e.g., createLipSyncEngineModule)
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = jsPath;
      script.async = true;

      script.onload = async () => {
        try {
          // The Emscripten module should expose a factory function
          // We need to get it from the global scope
          const createModule = (window as any).createLipSyncEngineModule;

          if (!createModule) {
            throw new Error(
              'WASM module factory not found. Make sure lip-sync-engine.js is loaded correctly.'
            );
          }

          const module = await createModule({
            locateFile: (path: string) => {
              if (path.endsWith('.wasm')) {
                return wasmPath;
              }
              if (path.endsWith('.data')) {
                return dataPath;
              }
              return path;
            },
          });

          resolve(module as LipSyncEngineModule);
        } catch (error) {
          reject(error);
        }
      };

      script.onerror = () => {
        reject(new Error(`Failed to load WASM module from ${jsPath}`));
      };

      document.head.appendChild(script);
    });
  }

  /**
   * Reset the loader (useful for testing)
   */
  static reset(): void {
    this.module = null;
    this.modulePromise = null;
  }
}
