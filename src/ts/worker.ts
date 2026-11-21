/**
 * Web Worker entry point for lip-sync-engine
 * This file runs inside a Web Worker context and handles analysis requests
 */

import { WasmLoader, compileWasm } from './WasmLoader';
import { applyExtendedShapes } from './extendedShapes';
import type { LipSyncEngineModule, LipSyncEngineOptions, LipSyncEngineResult, RecognizerKind } from './types';

// Worker message types
export interface WorkerAnalyzeRequest {
  type: 'analyze';
  id: number;
  pcm16: Int16Array;
  options: LipSyncEngineOptions;
}

export interface WorkerAnalyzeResponse {
  type: 'result' | 'error';
  id: number;
  result?: LipSyncEngineResult;
  error?: string;
}

export interface WorkerInitRequest {
  type: 'init';
  wasmPath: string;
  dataPath: string;
  jsPath: string;
  /** Build the speech decoder during init (default true) */
  prewarm?: boolean;
  /** Speech recognizer (default 'pocketsphinx') */
  recognizer?: RecognizerKind;
  /** Compiled module shared by the pool (optional) */
  wasmModule?: WebAssembly.Module;
  /** .data contents shared by the pool (optional) */
  dataBuffer?: ArrayBuffer;
  /** Compile the .wasm here and send the module back in the ready message */
  returnModule?: boolean;
}

export interface WorkerInitResponse {
  type: 'ready' | 'error';
  error?: string;
  /** True when the speech decoder is already built */
  warm?: boolean;
  /** Compiled module, when the pool asked for it (returnModule) */
  wasmModule?: WebAssembly.Module;
}

export interface WorkerStatsRequest {
  type: 'stats';
  id: number;
}

export interface WorkerStatsResponse {
  type: 'stats';
  id: number;
  /** Size of this worker's WebAssembly memory in bytes */
  wasmHeapBytes: number;
}

export type WorkerRequest = WorkerAnalyzeRequest | WorkerInitRequest | WorkerStatsRequest;
export type WorkerResponse = WorkerAnalyzeResponse | WorkerInitResponse | WorkerStatsResponse;

// Worker state
let wasmModule: LipSyncEngineModule | null = null;
let modelsPath = '/models';

/**
 * Initialize WASM module in worker context
 */
async function initializeWorker(
  message: WorkerInitRequest
): Promise<{ warm: boolean; compiled?: WebAssembly.Module }> {
  const { wasmPath, dataPath, jsPath } = message;
  const prewarm = message.prewarm !== false;
  // An error in one of Emscripten's own async steps is an unhandled
  // rejection that leaves the module pending forever. Treat it as a failed
  // start while the module loads.
  let onUnhandled: (event: PromiseRejectionEvent) => void = () => {};
  const unhandled = new Promise<never>((_, reject) => {
    onUnhandled = (event) => {
      event.preventDefault();
      reject(event.reason);
    };
  });
  unhandled.catch(() => {});
  self.addEventListener('unhandledrejection', onUnhandled);
  try {
    const compiled = message.wasmModule ?? (message.returnModule ? await compileWasm(wasmPath) : undefined);
    wasmModule = await Promise.race([
      unhandled,
      WasmLoader.loadModule({
        wasmPath,
        dataPath,
        jsPath,
        wasmModule: compiled,
        dataBuffer: message.dataBuffer
      })
    ]);
    const sendBack = message.returnModule ? compiled : undefined;

    // Initialize the engine
    const modelsPathPtr = wasmModule._malloc(modelsPath.length + 1);
    wasmModule.stringToUTF8(modelsPath, modelsPathPtr, modelsPath.length + 1);

    const initResult = wasmModule._lipsyncengine_init(modelsPathPtr);
    wasmModule._free(modelsPathPtr);

    if (initResult !== 0) {
      const errorPtr = wasmModule._lipsyncengine_get_last_error();
      const errorMsg = errorPtr ? wasmModule.UTF8ToString(errorPtr) : 'Unknown initialization error';
      throw new Error(errorMsg);
    }

    if (message.recognizer === 'phonetic') {
      if (typeof wasmModule._lipsyncengine_set_recognizer !== 'function') {
        throw new Error('This WASM build does not support the phonetic recognizer');
      }
      wasmModule._lipsyncengine_set_recognizer(1);
    }

    // Build the speech decoder now (off the main thread) so the first chunk
    // does not pay for loading the models.
    if (prewarm && typeof wasmModule._lipsyncengine_prewarm === 'function') {
      if (wasmModule._lipsyncengine_prewarm() !== 0) {
        const errorPtr = wasmModule._lipsyncengine_get_last_error();
        throw new Error(errorPtr ? wasmModule.UTF8ToString(errorPtr) : 'Unknown prewarm error');
      }
      return { warm: true, compiled: sendBack };
    }
    return { warm: false, compiled: sendBack };
  } catch (error) {
    throw new Error(`Worker initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    self.removeEventListener('unhandledrejection', onUnhandled);
  }
}

/**
 * Analyze audio in worker context
 */
function analyzeAudio(pcm16: Int16Array, options: LipSyncEngineOptions): LipSyncEngineResult {
  if (!wasmModule) {
    throw new Error('Worker not initialized');
  }

  const sampleRate = options.sampleRate || 16000;
  const dialogText = options.dialogText || '';

  applyExtendedShapes(wasmModule, options.extendedShapes);

  // Allocate memory for PCM buffer
  const pcmByteLength = pcm16.length * 2;
  const pcmPtr = wasmModule._malloc(pcmByteLength);
  wasmModule.HEAP16.set(pcm16, pcmPtr / 2);

  // Allocate memory for dialog text (if provided)
  let dialogPtr = 0;
  if (dialogText) {
    const dialogByteLength = wasmModule.lengthBytesUTF8(dialogText) + 1;
    dialogPtr = wasmModule._malloc(dialogByteLength);
    wasmModule.stringToUTF8(dialogText, dialogPtr, dialogByteLength);
  }

  try {
    // Call analysis function
    const resultPtr = wasmModule._lipsyncengine_analyze_pcm16(
      pcmPtr,
      pcm16.length,
      sampleRate,
      dialogPtr
    );

    // Check for errors
    if (!resultPtr) {
      const errorPtr = wasmModule._lipsyncengine_get_last_error();
      const errorMsg = errorPtr ? wasmModule.UTF8ToString(errorPtr) : 'Unknown analysis error';
      throw new Error(errorMsg);
    }

    // Parse JSON result
    const jsonString = wasmModule.UTF8ToString(resultPtr);
    const result = JSON.parse(jsonString) as LipSyncEngineResult;

    // Free result memory
    wasmModule._lipsyncengine_free(resultPtr);

    return result;
  } finally {
    // Always free allocated memory
    wasmModule._free(pcmPtr);
    if (dialogPtr) {
      wasmModule._free(dialogPtr);
    }
  }
}

/**
 * Message handler for worker
 */
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === 'init') {
    try {
      const { warm, compiled } = await initializeWorker(message);
      const response: WorkerInitResponse = { type: 'ready', warm, wasmModule: compiled };
      self.postMessage(response);
    } catch (error) {
      const response: WorkerInitResponse = {
        type: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
      self.postMessage(response);
    }
  } else if (message.type === 'stats') {
    const response: WorkerStatsResponse = {
      type: 'stats',
      id: message.id,
      wasmHeapBytes: wasmModule ? wasmModule.HEAP16.buffer.byteLength : 0
    };
    self.postMessage(response);
  } else if (message.type === 'analyze') {
    try {
      const result = analyzeAudio(message.pcm16, message.options);
      const response: WorkerAnalyzeResponse = {
        type: 'result',
        id: message.id,
        result
      };
      self.postMessage(response);
    } catch (error) {
      const response: WorkerAnalyzeResponse = {
        type: 'error',
        id: message.id,
        error: error instanceof Error ? error.message : String(error)
      };
      self.postMessage(response);
    }
  }
};
