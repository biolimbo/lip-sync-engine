import type { LipSyncEngineModule } from './types';

/** All nine shapes; the engine's default since 2.0.0 */
export const DEFAULT_EXTENDED_SHAPES = 'GHX';

const current = new WeakMap<LipSyncEngineModule, string>();

/**
 * Apply the extendedShapes option to a module before an analysis.
 * Only calls into WASM when the value changes.
 */
export function applyExtendedShapes(module: LipSyncEngineModule, shapes: string | undefined): void {
  const wanted = (shapes ?? DEFAULT_EXTENDED_SHAPES).toUpperCase();
  if ((current.get(module) ?? DEFAULT_EXTENDED_SHAPES) === wanted) return;
  if (typeof module._lipsyncengine_set_extended_shapes !== 'function') {
    throw new Error('This WASM build does not support extendedShapes');
  }
  const len = module.lengthBytesUTF8(wanted) + 1;
  const ptr = module._malloc(len);
  try {
    module.stringToUTF8(wanted, ptr, len);
    if (module._lipsyncengine_set_extended_shapes(ptr) !== 0) {
      const errorPtr = module._lipsyncengine_get_last_error();
      throw new Error(errorPtr ? module.UTF8ToString(errorPtr) : 'Invalid extendedShapes');
    }
  } finally {
    module._free(ptr);
  }
  current.set(module, wanted);
}
