/**
 * Web Worker entry point for lip-sync-engine
 * This file runs inside a Web Worker context and handles analysis requests
 */

import { WasmLoader } from './WasmLoader';
import type { LipSyncEngineModule, LipSyncEngineOptions, LipSyncEngineResult } from './types';

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
}

export interface WorkerInitResponse {
  type: 'ready' | 'error';
  error?: string;
}

export type WorkerRequest = WorkerAnalyzeRequest | WorkerInitRequest;
export type WorkerResponse = WorkerAnalyzeResponse | WorkerInitResponse;

// Worker state
let wasmModule: LipSyncEngineModule | null = null;
let modelsPath = '/models';

/**
 * Initialize WASM module in worker context
 */
async function initializeWorker(wasmPath: string, dataPath: string, jsPath: string): Promise<void> {
  try {
    wasmModule = await WasmLoader.loadModule({
      wasmPath,
      dataPath,
      jsPath
    });

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
  } catch (error) {
    throw new Error(`Worker initialization failed: ${error instanceof Error ? error.message : String(error)}`);
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
      await initializeWorker(message.wasmPath, message.dataPath, message.jsPath);
      const response: WorkerInitResponse = { type: 'ready' };
      self.postMessage(response);
    } catch (error) {
      const response: WorkerInitResponse = {
        type: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
      self.postMessage(response);
    }
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
