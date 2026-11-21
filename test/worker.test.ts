import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LipSyncEngineModule } from '../src/ts/types';

const loadModule = vi.fn<[], Promise<LipSyncEngineModule>>();

vi.mock('../src/ts/WasmLoader', () => ({
  WasmLoader: { loadModule: () => loadModule() },
  compileWasm: async () => undefined,
}));

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
