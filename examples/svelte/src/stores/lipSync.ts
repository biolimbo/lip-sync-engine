import { writable } from 'svelte/store';
import { LipSync } from 'lip-sync-js';
import type { LipSyncResult, LipSyncOptions } from 'lip-sync-js';

/**
 * Example Svelte store for lip-sync-js
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```svelte
 * <script>
 * import { lipSyncStore } from './stores/lipSync';
 * import { recordAudio } from 'lip-sync-js';
 *
 * async function handleAnalyze() {
 *   const { pcm16 } = await recordAudio(5000);
 *   await lipSyncStore.analyze(pcm16, { dialogText: "Hello world" });
 * }
 * </script>
 *
 * <button on:click={handleAnalyze} disabled={$lipSyncStore.isAnalyzing}>
 *   {$lipSyncStore.isAnalyzing ? 'Analyzing...' : 'Record & Analyze'}
 * </button>
 *
 * {#if $lipSyncStore.error}
 *   <div>Error: {$lipSyncStore.error.message}</div>
 * {/if}
 *
 * {#if $lipSyncStore.result}
 *   <div>Found {$lipSyncStore.result.mouthCues.length} cues</div>
 * {/if}
 * ```
 */
interface LipSyncState {
  result: LipSyncResult | null;
  isAnalyzing: boolean;
  error: Error | null;
}

function createLipSyncStore() {
  const { subscribe, set, update } = writable<LipSyncState>({
    result: null,
    isAnalyzing: false,
    error: null,
  });

  let lipSync: LipSync | null = null;

  const init = async () => {
    if (!lipSync) {
      lipSync = LipSync.getInstance();
      await lipSync.init({
        wasmPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.wasm',
        dataPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.data',
        jsPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.js'
      });
    }
  };

  return {
    subscribe,

    analyze: async (pcm16: Int16Array, options?: LipSyncOptions) => {
      try {
        await init();

        update((state) => ({ ...state, isAnalyzing: true, error: null }));

        const result = await lipSync!.analyzeAsync(pcm16, options);

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
      lipSync?.destroy();
    },
  };
}

export const lipSyncStore = createLipSyncStore();
