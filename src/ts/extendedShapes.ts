import type { LipSyncEngineModule } from './types';

const current = new WeakMap<LipSyncEngineModule, string>();

/**
 * Apply the extendedShapes option to a module before an analysis.
 * Only calls into WASM when the value changes.
 */
export function applyExtendedShapes(module: LipSyncEngineModule, shapes: string | undefined): void {
  const wanted = (shapes || '').toUpperCase();
  if ((current.get(module) ?? '') === wanted) return;
  if (typeof module._lipsyncengine_set_extended_shapes !== 'function') {
    if (wanted) throw new Error('This WASM build does not support extendedShapes');
    return;
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
