import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LipSyncEngineModule, WasmLoaderOptions } from '../src/ts/types';
import type { StartedAssets } from '../src/ts/WasmLoader';

const loadModule = vi.fn<[WasmLoaderOptions, StartedAssets], Promise<LipSyncEngineModule>>();
const compileWasm = vi.fn<[string], Promise<WebAssembly.Module | undefined>>();
const fetchDataFile = vi.fn<[string], Promise<ArrayBuffer>>();

vi.mock('../src/ts/WasmLoader', () => ({
  loadModuleWithAssets: (options: WasmLoaderOptions, assets: StartedAssets) => loadModule(options, assets),
  compileWasm: (wasmPath: string) => compileWasm(wasmPath),
  fetchDataFile: (dataPath: string) => fetchDataFile(dataPath),
}));

/** Just enough of the module for the worker's init */
function fakeModule(): LipSyncEngineModule {
  return {
    _malloc: () => 8,
    _free: () => {},
    stringToUTF8: () => {},
    _lipsyncengine_init: () => 0,
    _lipsyncengine_get_last_error: () => 0,
    UTF8ToString: () => '',
  } as unknown as LipSyncEngineModule;
}

/** Worker global scope stand-in: records posted messages and listeners */
class StubScope {
  onmessage: ((event: MessageEvent) => Promise<void>) | null = null;
  posted: unknown[] = [];
  listeners = new Map<string, Set<(event: unknown) => void>>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Deliver an unhandled promise rejection like the browser does */
  rejectUnhandled(reason: unknown): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = { reason, preventDefault: vi.fn() };
    this.listeners.get('unhandledrejection')?.forEach(listener => listener(event));
    return event;
  }
}

const INIT = {
  type: 'init',
  wasmPath: '/lip-sync-engine.wasm',
  dataPath: '/lip-sync-engine.data',
  jsPath: '/lip-sync-engine.js',
};

let scope: StubScope;

beforeEach(async () => {
  vi.resetModules();
  loadModule.mockReset();
  compileWasm.mockReset().mockResolvedValue(undefined);
  fetchDataFile.mockReset().mockResolvedValue(new ArrayBuffer(8));
  scope = new StubScope();
  vi.stubGlobal('self', scope);
  await import('../src/ts/worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker init', () => {
  it('reports a failed .data load as an init error', async () => {
    loadModule.mockRejectedValue(
      new Error('Failed to load model data from /lip-sync-engine.data: network error')
    );

    await scope.onmessage!({ data: INIT } as MessageEvent);

    expect(scope.posted).toEqual([{
      type: 'error',
      error: 'Worker initialization failed: Failed to load model data from /lip-sync-engine.data: network error',
    }]);
  });

  it('reports an unhandled rejection while the module loads as an init error', async () => {
    loadModule.mockReturnValue(new Promise(() => {})); // never settles, like a stalled Emscripten start

    const handled = scope.onmessage!({ data: INIT } as MessageEvent);
    await vi.waitFor(() => expect(loadModule).toHaveBeenCalled());
    const event = scope.rejectUnhandled(new TypeError('network error'));
    await handled;

    expect(event.preventDefault).toHaveBeenCalled();
    expect(scope.posted).toEqual([{
      type: 'error',
      error: 'Worker initialization failed: network error',
    }]);
    // The listener only covers startup
    expect(scope.listeners.get('unhandledrejection')?.size ?? 0).toBe(0);
  });
});

describe('worker init downloads', () => {
  // Like the loader: wait for the .data file, then the compiled module
  const loadFromAssets = async (_options: WasmLoaderOptions, assets: StartedAssets) => {
    await assets.data;
    await assets.compiled;
    return fakeModule();
  };

  it('downloads the .data file while the .wasm compiles, and compiles once', async () => {
    let finishCompile!: (module: WebAssembly.Module) => void;
    compileWasm.mockReturnValue(new Promise(resolve => { finishCompile = resolve; }));
    loadModule.mockImplementation(loadFromAssets);
    const compiledModule = {} as WebAssembly.Module;

    const handled = scope.onmessage!({ data: { ...INIT, returnModule: true } } as MessageEvent);
    await vi.waitFor(() => expect(compileWasm).toHaveBeenCalled());
    // The compile has not finished, and the download has already started
    expect(fetchDataFile).toHaveBeenCalledWith(INIT.dataPath);
    finishCompile(compiledModule);
    await handled;

    expect(compileWasm).toHaveBeenCalledTimes(1);
    // The loader gets the compile in progress, so it does not compile again
    await expect(loadModule.mock.calls[0][1].compiled).resolves.toBe(compiledModule);
    expect(scope.posted).toEqual([{ type: 'ready', warm: false, wasmModule: compiledModule }]);
  });

  it('reports a .data download that fails before the compile finishes as an init error', async () => {
    let finishCompile!: (module: WebAssembly.Module | undefined) => void;
    compileWasm.mockReturnValue(new Promise(resolve => { finishCompile = resolve; }));
    fetchDataFile.mockRejectedValue(
      new Error('Failed to load model data from /lip-sync-engine.data: HTTP 404')
    );
    loadModule.mockImplementation(loadFromAssets);

    const handled = scope.onmessage!({ data: { ...INIT, returnModule: true } } as MessageEvent);
    await vi.waitFor(() => expect(fetchDataFile).toHaveBeenCalled());
    // Let the rejection settle while the compile is still running
    await new Promise(resolve => setTimeout(resolve, 0));
    finishCompile(undefined);
    await handled;

    expect(scope.posted).toEqual([{
      type: 'error',
      error: 'Worker initialization failed: Failed to load model data from /lip-sync-engine.data: HTTP 404',
    }]);
  });

  it('uses the module and data the pool shares instead of downloading them', async () => {
    const shared = { wasmModule: {} as WebAssembly.Module, dataBuffer: new ArrayBuffer(4) };
    loadModule.mockImplementation(loadFromAssets);

    await scope.onmessage!({ data: { ...INIT, ...shared } } as MessageEvent);

    expect(compileWasm).not.toHaveBeenCalled();
    expect(fetchDataFile).not.toHaveBeenCalled();
    const assets = loadModule.mock.calls[0][1];
    await expect(assets.compiled).resolves.toBe(shared.wasmModule);
    await expect(assets.data).resolves.toBe(shared.dataBuffer);
  });
});
