import { afterEach, describe, expect, it, vi } from 'vitest';
import { LipSyncEngine } from '../src/ts/LipSyncEngine';
import { WasmLoader } from '../src/ts/WasmLoader';
import type { LipSyncEngineModule } from '../src/ts/types';

/** Just enough of the module for init() */
function fakeModule(initResult = 0): LipSyncEngineModule {
  return {
    lengthBytesUTF8: (text: string) => text.length,
    _malloc: () => 8,
    _free: () => {},
    stringToUTF8: () => {},
    _lipsyncengine_init: () => initResult,
    _lipsyncengine_get_last_error: () => 0,
    UTF8ToString: () => '',
  } as unknown as LipSyncEngineModule;
}

afterEach(() => {
  LipSyncEngine.getInstance().destroy();
  vi.restoreAllMocks();
});

describe('LipSyncEngine.init', () => {
  it('loads again after a failed load instead of returning the failure', async () => {
    const load = vi
      .spyOn(WasmLoader, 'load')
      .mockRejectedValueOnce(new Error('Failed to load WASM module from /lip-sync-engine.js'))
      .mockResolvedValueOnce(fakeModule());
    const engine = LipSyncEngine.getInstance();

    await expect(engine.init()).rejects.toThrow('Failed to load WASM module');
    await expect(engine.init()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);

    // Started: later calls do not load again
    await engine.init();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('starts the engine again after it failed to initialize', async () => {
    const module = fakeModule();
    const init = vi
      .spyOn(module, '_lipsyncengine_init')
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(0);
    vi.spyOn(WasmLoader, 'load').mockResolvedValue(module);
    const engine = LipSyncEngine.getInstance();

    await expect(engine.init()).rejects.toThrow('LipSyncEngine initialization failed');
    await expect(engine.init()).resolves.toBeUndefined();
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('shares one start between concurrent calls', async () => {
    const load = vi.spyOn(WasmLoader, 'load').mockResolvedValue(fakeModule());
    const engine = LipSyncEngine.getInstance();

    await Promise.all([engine.init(), engine.init()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
