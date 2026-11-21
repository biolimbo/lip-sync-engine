import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WasmLoader, fetchDataFile } from '../src/ts/WasmLoader';
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
