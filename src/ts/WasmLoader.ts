import type { LipSyncEngineModule, WasmLoaderOptions } from './types';
import packageJson from '../../package.json';

// Declare worker globals for TypeScript
declare const WorkerGlobalScope: any;
declare function importScripts(...urls: string[]): void;

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
   * Load module directly (for worker context)
   * This method doesn't use singleton caching and is suitable for workers
   */
  static async loadModule(options: WasmLoaderOptions = {}): Promise<LipSyncEngineModule> {
    return this._loadModuleImpl(options);
  }

  /**
   * Internal method to load the module
   */
  private static async _loadModule(
    options: WasmLoaderOptions
  ): Promise<LipSyncEngineModule> {
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
    } = options;

    // Detect if we're in a worker context
    const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

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
      });
    } else {
      // Window context - use dynamic script loading
      if (typeof window === 'undefined') {
        throw new Error('WasmLoader can only be used in browser or worker environments');
      }

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
  }

  /**
   * Reset the loader (useful for testing)
   */
  static reset(): void {
    this.module = null;
    this.modulePromise = null;
  }
}
