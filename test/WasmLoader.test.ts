import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { WasmLoader, compileWasm, fetchDataFile, loadModuleWithAssets } from '../src/ts/WasmLoader';
import type { LipSyncEngineModule } from '../src/ts/types';

/**
 * The tests run WasmLoader in its worker code path: `self` is a
 * WorkerGlobalScope stand-in and importScripts() installs a fake Emscripten
 * factory, so no real WASM is involved.
 */
class StubWorkerGlobalScope {
  createLipSyncEngineModule?: (options: Record<string, unknown>) => Promise<LipSyncEngineModule>;
}

const DATA_PATH = 'https://example.test/lip-sync-engine.data';
const PATHS = {
  wasmPath: 'https://example.test/lip-sync-engine.wasm',
  dataPath: DATA_PATH,
  jsPath: 'https://example.test/lip-sync-engine.js',
  // A precompiled module skips the .wasm fetch, so fetch only sees the .data file
  wasmModule: {} as WebAssembly.Module,
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

type FetchOutcome = 'ok' | 'network-error' | 'body-error' | number;

/** fetch stub answering the .data URL with the given outcomes in order */
function stubFetch(...outcomes: FetchOutcome[]): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const outcome = outcomes.shift() ?? 'ok';
    if (outcome === 'network-error') throw new TypeError('Failed to fetch');
    const status = typeof outcome === 'number' ? outcome : 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      arrayBuffer: async () => {
        if (outcome === 'body-error') throw new TypeError('network error');
        return new ArrayBuffer(8);
      },
    };
  });
  return calls;
}

let scope: StubWorkerGlobalScope;
let factoryCalls: Array<Record<string, unknown>>;
/** Resolves the next module created by the fake factory; replaced per test when needed */
let createModule: (options: Record<string, unknown>) => Promise<LipSyncEngineModule>;

beforeEach(() => {
  WasmLoader.reset();
  factoryCalls = [];
  scope = new StubWorkerGlobalScope();
  createModule = async options => {
    // Like Emscripten: take the preloaded .data contents once
    const getPreloadedPackage = options.getPreloadedPackage as () => ArrayBuffer | undefined;
    if (!(getPreloadedPackage() instanceof ArrayBuffer)) throw new Error('no data');
    return { id: factoryCalls.length } as unknown as LipSyncEngineModule;
  };
  vi.stubGlobal('WorkerGlobalScope', StubWorkerGlobalScope);
  vi.stubGlobal('self', scope);
  vi.stubGlobal('importScripts', () => {
    scope.createLipSyncEngineModule = options => {
      factoryCalls.push(options);
      return createModule(options);
    };
  });
});

afterEach(() => {
  WasmLoader.reset();
  vi.unstubAllGlobals();
});

describe('fetchDataFile', () => {
  it('retries a network error once without the HTTP cache', async () => {
    const calls = stubFetch('body-error', 'ok');

    await expect(fetchDataFile(DATA_PATH)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(calls).toHaveLength(2);
    expect(calls[0].init?.cache).toBeUndefined();
    expect(calls[1].init?.cache).toBe('no-store');
  });

  it('rejects with the URL and reason when the retry fails too', async () => {
    stubFetch('network-error', 'body-error');

    await expect(fetchDataFile(DATA_PATH)).rejects.toThrow(
      `Failed to load model data from ${DATA_PATH}: network error`
    );
  });

  it('does not retry an HTTP error status', async () => {
    const calls = stubFetch(404);

    await expect(fetchDataFile(DATA_PATH)).rejects.toThrow(
      `Failed to load model data from ${DATA_PATH}: HTTP 404`
    );
    expect(calls).toHaveLength(1);
  });
});

describe('WasmLoader.loadModule', () => {
  it('rejects when the .data file fails to load, without creating the module', async () => {
    stubFetch('network-error', 'network-error');

    await expect(WasmLoader.loadModule(PATHS)).rejects.toThrow(
      `Failed to load model data from ${DATA_PATH}: Failed to fetch`
    );
    expect(factoryCalls).toHaveLength(0);
  });

  it('passes the downloaded .data contents to Emscripten', async () => {
    stubFetch('ok');

    await expect(WasmLoader.loadModule(PATHS)).resolves.toBeDefined();
    expect(factoryCalls).toHaveLength(1);
  });

  it('uses dataBuffer instead of downloading the .data file', async () => {
    const calls = stubFetch();

    await WasmLoader.loadModule({ ...PATHS, dataBuffer: new ArrayBuffer(4) });
    expect(calls).toHaveLength(0);
  });
});

describe('WasmLoader.load', () => {
  it('does not cache a failed load: the next call loads again', async () => {
    stubFetch(500, 'ok');

    await expect(WasmLoader.load(PATHS)).rejects.toThrow('HTTP 500');
    const module = await WasmLoader.load(PATHS);

    expect(module).toBeDefined();
    expect(factoryCalls).toHaveLength(1);
    await expect(WasmLoader.load(PATHS)).resolves.toBe(module);
  });

  it('shares one load between concurrent calls', async () => {
    stubFetch('ok');

    const [a, b] = await Promise.all([WasmLoader.load(PATHS), WasmLoader.load(PATHS)]);
    expect(a).toBe(b);
    expect(factoryCalls).toHaveLength(1);
  });

  it('does not let a load started before reset() fill the cache', async () => {
    stubFetch('ok', 'ok');
    let finishFirst!: () => void;
    const firstModule = { first: true } as unknown as LipSyncEngineModule;
    createModule = () => new Promise(resolve => { finishFirst = () => resolve(firstModule); });

    const stale = WasmLoader.load(PATHS);
    await vi.waitFor(() => expect(factoryCalls).toHaveLength(1));
    WasmLoader.reset();
    finishFirst();
    // The caller of the stale load still gets its module
    await expect(stale).resolves.toBe(firstModule);

    createModule = async () => ({ second: true }) as unknown as LipSyncEngineModule;
    const fresh = await WasmLoader.load(PATHS);
    expect(fresh).not.toBe(firstModule);
    expect(factoryCalls).toHaveLength(2);
  });
});

describe('compileWasm', () => {
  const WASM_PATH = 'https://example.test/lip-sync-engine.wasm';
  const compiledModule = {} as WebAssembly.Module;
  type Compile = (source: unknown) => Promise<WebAssembly.Module>;
  let compile: Mock<Parameters<Compile>, ReturnType<Compile>>;
  let compileStreaming: Mock<Parameters<Compile>, ReturnType<Compile>>;

  function stubWasmFetch(status: number, contentType: string | null): void {
    vi.stubGlobal('fetch', async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name === 'Content-Type' ? contentType : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
  }

  beforeEach(() => {
    compile = vi.fn<Parameters<Compile>, ReturnType<Compile>>(async () => compiledModule);
    compileStreaming = vi.fn<Parameters<Compile>, ReturnType<Compile>>(async () => compiledModule);
    vi.stubGlobal('WebAssembly', { compile, compileStreaming });
  });

  it('resolves undefined for an HTTP error status, without compiling', async () => {
    stubWasmFetch(404, 'text/html');

    await expect(compileWasm(WASM_PATH)).resolves.toBeUndefined();
    expect(compile).not.toHaveBeenCalled();
    expect(compileStreaming).not.toHaveBeenCalled();
  });

  it('compiles while streaming when the server sends application/wasm', async () => {
    stubWasmFetch(200, 'application/wasm');

    await expect(compileWasm(WASM_PATH)).resolves.toBe(compiledModule);
    expect(compileStreaming).toHaveBeenCalledTimes(1);
    expect(compile).not.toHaveBeenCalled();
  });

  it('compiles the downloaded bytes for any other content type', async () => {
    stubWasmFetch(200, 'application/octet-stream');

    await expect(compileWasm(WASM_PATH)).resolves.toBe(compiledModule);
    expect(compile).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(compileStreaming).not.toHaveBeenCalled();
  });

  it('resolves undefined when the compile fails', async () => {
    stubWasmFetch(200, 'application/wasm');
    compileStreaming.mockRejectedValue(new Error('bad module'));

    await expect(compileWasm(WASM_PATH)).resolves.toBeUndefined();
  });
});

describe('loadModuleWithAssets', () => {
  it('uses the downloads it is given instead of starting its own', async () => {
    const calls = stubFetch();
    const { wasmModule: _unused, ...paths } = PATHS;

    await loadModuleWithAssets(paths, {
      data: Promise.resolve(new ArrayBuffer(4)),
      compiled: Promise.resolve(undefined),
    });

    // No .data download and no second .wasm compile; Emscripten loads the .wasm itself
    expect(calls).toHaveLength(0);
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].instantiateWasm).toBeUndefined();
  });
});

describe('WasmLoader.load on the main thread', () => {
  /** A <script> element stand-in that records removal */
  interface StubScript {
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    removed: boolean;
    remove(): void;
  }

  const MAIN_PATHS = {
    wasmPath: 'https://example.test/lip-sync-engine.wasm',
    dataPath: DATA_PATH,
    jsPath: 'https://example.test/lip-sync-engine.js',
  };

  let win: { createLipSyncEngineModule?: (options: Record<string, unknown>) => Promise<LipSyncEngineModule> };
  let scripts: StubScript[];
  /** What happens when a script is added to the page; set per test */
  let scriptOutcome: 'load' | 'error' | 'load-without-factory';
  let signals: AbortSignal[];

  const factory = (options: Record<string, unknown>) => {
    factoryCalls.push(options);
    return createModule(options);
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('WorkerGlobalScope', undefined);
    win = {};
    scripts = [];
    scriptOutcome = 'load';
    signals = [];
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', {
      createElement: () => {
        const script: StubScript = {
          src: '',
          onload: null,
          onerror: null,
          removed: false,
          remove() { this.removed = true; },
        };
        scripts.push(script);
        return script;
      },
      head: {
        appendChild: (script: StubScript) => {
          setTimeout(() => {
            if (scriptOutcome === 'error') {
              script.onerror?.();
              return;
            }
            if (scriptOutcome === 'load') win.createLipSyncEngineModule = factory;
            script.onload?.();
          }, 0);
        },
      },
    });
    // Downloads stay pending until aborted, so the test sees whether they were
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) signals.push(signal);
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
  });

  it('reuses the loader script that already ran instead of adding it again', async () => {
    stubFetch('ok', 'ok');
    win.createLipSyncEngineModule = factory;

    await expect(WasmLoader.load(MAIN_PATHS)).resolves.toBeDefined();
    expect(scripts).toHaveLength(0);
    expect(factoryCalls).toHaveLength(1);
  });

  it('removes the script and aborts the downloads when the loader script fails to load', async () => {
    scriptOutcome = 'error';

    await expect(WasmLoader.load(MAIN_PATHS)).rejects.toThrow(
      `Failed to load WASM module from ${MAIN_PATHS.jsPath}`
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0].removed).toBe(true);
    // One signal for the .data download and one for the .wasm compile
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(factoryCalls).toHaveLength(0);
  });

  it('removes the script and aborts the downloads when the script defines no factory', async () => {
    scriptOutcome = 'load-without-factory';

    await expect(WasmLoader.load(MAIN_PATHS)).rejects.toThrow('WASM module factory not found');
    expect(scripts[0].removed).toBe(true);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('adds the script again on the next load after it failed', async () => {
    scriptOutcome = 'error';
    await expect(WasmLoader.load(MAIN_PATHS)).rejects.toThrow('Failed to load WASM module');

    scriptOutcome = 'load';
    stubFetch('ok', 'ok');
    await expect(WasmLoader.load(MAIN_PATHS)).resolves.toBeDefined();
    expect(scripts).toHaveLength(2);
    expect(scripts[1].removed).toBe(false);
    expect(factoryCalls).toHaveLength(1);
  });
});
