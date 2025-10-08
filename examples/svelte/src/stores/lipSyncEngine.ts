import { writable } from 'svelte/store';
import { LipSyncEngine } from 'lip-sync-engine';
import type { LipSyncEngineResult, LipSyncEngineOptions } from 'lip-sync-engine';

/**
 * Example Svelte store for lip-sync-engine
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```svelte
 * <script>
 * import { lipSyncEngineStore } from './stores/lipSyncEngine';
 * import { recordAudio } from 'lip-sync-engine';
 *
 * async function handleAnalyze() {
 *   const { pcm16 } = await recordAudio(5000);
 *   await lipSyncEngineStore.analyze(pcm16, { dialogText: "Hello world" });
 * }
 * </script>
 *
 * <button on:click={handleAnalyze} disabled={$lipSyncEngineStore.isAnalyzing}>
 *   {$lipSyncEngineStore.isAnalyzing ? 'Analyzing...' : 'Record & Analyze'}
 * </button>
 *
 * {#if $lipSyncEngineStore.error}
 *   <div>Error: {$lipSyncEngineStore.error.message}</div>
 * {/if}
 *
 * {#if $lipSyncEngineStore.result}
 *   <div>Found {$lipSyncEngineStore.result.mouthCues.length} cues</div>
 * {/if}
 * ```
 */
interface LipSyncEngineState {
  result: LipSyncEngineResult | null;
  isAnalyzing: boolean;
  error: Error | null;
}

function createLipSyncEngineStore() {
  const { subscribe, set, update } = writable<LipSyncEngineState>({
    result: null,
    isAnalyzing: false,
    error: null,
  });

  let lipSyncEngine: LipSyncEngine | null = null;

  const init = async () => {
    if (!lipSyncEngine) {
      lipSyncEngine = LipSyncEngine.getInstance();
      await lipSyncEngine.init({
        wasmPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.wasm',
        dataPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.data',
        jsPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.js'
      });
    }
  };

  return {
    subscribe,

    analyze: async (pcm16: Int16Array, options?: LipSyncEngineOptions) => {
      try {
        await init();

        update((state) => ({ ...state, isAnalyzing: true, error: null }));

        const result = await lipSyncEngine!.analyzeAsync(pcm16, options);

        update((state) => ({ ...state, result, isAnalyzing: false }));
      } catch (error) {
        update((state) => ({
          ...state,
          error: error as Error,
          isAnalyzing: false,
        }));
      }
    },

    reset: () => {
      set({ result: null, isAnalyzing: false, error: null });
    },

    destroy: () => {
      lipSyncEngine?.destroy();
    },
  };
}

export const lipSyncEngineStore = createLipSyncEngineStore();
