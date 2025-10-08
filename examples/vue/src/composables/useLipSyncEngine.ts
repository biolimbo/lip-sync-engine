import { ref, onUnmounted } from 'vue';
import { LipSyncEngine } from 'lip-sync-engine';
import type { LipSyncEngineResult, LipSyncEngineOptions } from 'lip-sync-engine';

/**
 * Example Vue composable for lip-sync-engine
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```vue
 * <script setup>
 * import { useLipSyncEngine } from './composables/useLipSyncEngine';
 * import { recordAudio } from 'lip-sync-engine';
 *
 * const { analyze, result, isAnalyzing, error } = useLipSyncEngine();
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
export function useLipSyncEngine() {
  const result = ref<LipSyncEngineResult | null>(null);
  const isAnalyzing = ref(false);
  const error = ref<Error | null>(null);

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

  const analyze = async (pcm16: Int16Array, options?: LipSyncEngineOptions) => {
    try {
      await init();

      isAnalyzing.value = true;
      error.value = null;

      const analysisResult = await lipSyncEngine!.analyzeAsync(pcm16, options);
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
    lipSyncEngine?.destroy();
  });

  return {
    analyze,
    result,
    isAnalyzing,
    error,
    reset,
  };
}
