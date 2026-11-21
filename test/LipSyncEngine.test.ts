import { afterEach, describe, expect, it, vi } from 'vitest';
import { LipSyncEngine, analyze } from '../src/ts/LipSyncEngine';
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

describe('LipSyncEngine init options', () => {
  const SELF_HOSTED = {
    wasmPath: '/assets/lip-sync-engine.wasm',
    dataPath: '/assets/lip-sync-engine.data',
    jsPath: '/assets/lip-sync-engine.js',
  };
  const LOAD_ERROR = new Error('Failed to load model data from /assets/lip-sync-engine.data: HTTP 503');

  it('retries a failed init(options) with the same options when analyze() loads', async () => {
    const load = vi.spyOn(WasmLoader, 'load').mockRejectedValue(LOAD_ERROR);
    const engine = LipSyncEngine.getInstance();

    await expect(engine.init(SELF_HOSTED)).rejects.toThrow(LOAD_ERROR.message);
    await expect(engine.analyze(new Int16Array(1))).rejects.toThrow(LOAD_ERROR.message);
    await expect(analyze(new Int16Array(1))).rejects.toThrow(LOAD_ERROR.message);
    await expect(engine.init()).rejects.toThrow(LOAD_ERROR.message);

    expect(load.mock.calls.map(([options]) => options)).toEqual([
      SELF_HOSTED, SELF_HOSTED, SELF_HOSTED, SELF_HOSTED,
    ]);
  });

  it('uses the options of a later init(options) call after a failure', async () => {
    const fixed = { ...SELF_HOSTED, dataPath: '/fixed/lip-sync-engine.data' };
    const load = vi.spyOn(WasmLoader, 'load').mockRejectedValue(LOAD_ERROR);
    const engine = LipSyncEngine.getInstance();

    await expect(engine.init(SELF_HOSTED)).rejects.toThrow();
    await expect(engine.init(fixed)).rejects.toThrow();
    await expect(engine.init()).rejects.toThrow();

    expect(load.mock.calls.map(([options]) => options)).toEqual([SELF_HOSTED, fixed, fixed]);
  });

  it('keeps the other paths when a retry passes only the fixed one', async () => {
    const fix = { dataPath: '/fixed/lip-sync-engine.data' };
    const load = vi.spyOn(WasmLoader, 'load').mockRejectedValue(LOAD_ERROR);
    const engine = LipSyncEngine.getInstance();

    await expect(engine.init(SELF_HOSTED)).rejects.toThrow();
    await expect(engine.init(fix)).rejects.toThrow();

    expect(load.mock.calls[1][0]).toEqual({ ...SELF_HOSTED, ...fix });
  });

  it('ignores the options of a call made while a load is in progress', async () => {
    let failLoad!: (error: Error) => void;
    const load = vi
      .spyOn(WasmLoader, 'load')
      .mockReturnValueOnce(new Promise((_, reject) => { failLoad = reject; }))
      .mockRejectedValue(LOAD_ERROR);
    const engine = LipSyncEngine.getInstance();

    const first = engine.init(SELF_HOSTED);
    const shared = engine.init({ dataPath: '/ignored.data' });
    failLoad(LOAD_ERROR);
    await expect(first).rejects.toThrow();
    await expect(shared).rejects.toThrow();
    await expect(engine.init()).rejects.toThrow();

    expect(load.mock.calls.map(([options]) => options)).toEqual([SELF_HOSTED, SELF_HOSTED]);
  });

  it('forgets the options on destroy()', async () => {
    const load = vi.spyOn(WasmLoader, 'load').mockRejectedValue(LOAD_ERROR);

    await expect(LipSyncEngine.getInstance().init(SELF_HOSTED)).rejects.toThrow();
    LipSyncEngine.getInstance().destroy();
    await expect(LipSyncEngine.getInstance().init()).rejects.toThrow();

    expect(load.mock.calls.map(([options]) => options)).toEqual([SELF_HOSTED, {}]);
  });
});
