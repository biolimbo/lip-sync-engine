import { useState, useCallback, useRef, useEffect } from 'react';
import { LipSyncEngine } from 'lip-sync-engine';
import type { LipSyncEngineResult, LipSyncEngineOptions } from 'lip-sync-engine';

/**
 * Example React hook for lip-sync-engine
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { analyze, result, isAnalyzing, error } = useLipSyncEngine();
 *
 *   const handleAnalyze = async () => {
 *     const { pcm16 } = await recordAudio(5000);
 *     await analyze(pcm16, { dialogText: "Hello world" });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleAnalyze} disabled={isAnalyzing}>
 *         Analyze
 *       </button>
 *       {result && <div>{result.mouthCues.length} cues found</div>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useLipSyncEngine() {
  const [result, setResult] = useState<LipSyncEngineResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const lipSyncEngineRef = useRef<LipSyncEngine | null>(null);

  useEffect(() => {
    // Initialize LipSyncEngine instance
    lipSyncEngineRef.current = LipSyncEngine.getInstance();
    lipSyncEngineRef.current.init({
      wasmPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.wasm',
      dataPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.data',
      jsPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.js'
    }).catch(setError);

    // Cleanup on unmount
    return () => {
      lipSyncEngineRef.current?.destroy();
    };
  }, []);

  const analyze = useCallback(
    async (pcm16: Int16Array, options?: LipSyncEngineOptions) => {
      if (!lipSyncEngineRef.current) {
        setError(new Error('LipSyncEngine not initialized'));
        return;
      }

      setIsAnalyzing(true);
      setError(null);

      try {
        const result = await lipSyncEngineRef.current.analyzeAsync(pcm16, options);
        setResult(result);
      } catch (err) {
        setError(err as Error);
      } finally {
        setIsAnalyzing(false);
      }
    },
    []
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setIsAnalyzing(false);
  }, []);

  return { analyze, result, isAnalyzing, error, reset };
}
