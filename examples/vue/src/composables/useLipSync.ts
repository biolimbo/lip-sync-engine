import { ref, onUnmounted } from 'vue';
import { LipSync } from 'lip-sync-js';
import type { LipSyncResult, LipSyncOptions } from 'lip-sync-js';

/**
 * Example Vue composable for lip-sync-js
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```vue
 * <script setup>
 * import { useLipSync } from './composables/useLipSync';
 * import { recordAudio } from 'lip-sync-js';
 *
 * const { analyze, result, isAnalyzing, error } = useLipSync();
 *
 * const handleAnalyze = async () => {
 *   const { pcm16 } = await recordAudio(5000);
 *   await analyze(pcm16, { dialogText: "Hello world" });
 * };
 * </script>
 *
 * <template>
 *   <div>
 *     <button @click="handleAnalyze" :disabled="isAnalyzing">
 *       {{ isAnalyzing ? 'Analyzing...' : 'Record & Analyze' }}
 *     </button>
 *     <div v-if="error">Error: {{ error.message }}</div>
 *     <div v-if="result">Found {{ result.mouthCues.length }} cues</div>
 *   </div>
 * </template>
 * ```
 */
export function useLipSync() {
  const result = ref<LipSyncResult | null>(null);
  const isAnalyzing = ref(false);
  const error = ref<Error | null>(null);

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

  const analyze = async (pcm16: Int16Array, options?: LipSyncOptions) => {
    try {
      await init();

      isAnalyzing.value = true;
      error.value = null;

      const analysisResult = await lipSync!.analyzeAsync(pcm16, options);
      result.value = analysisResult;
    } catch (err) {
      error.value = err as Error;
      throw err;
    } finally {
      isAnalyzing.value = false;
    }
  };

  const reset = () => {
    result.value = null;
    error.value = null;
    isAnalyzing.value = false;
  };

  onUnmounted(() => {
    lipSync?.destroy();
  });

  return {
    analyze,
    result,
    isAnalyzing,
    error,
    reset,
  };
}
