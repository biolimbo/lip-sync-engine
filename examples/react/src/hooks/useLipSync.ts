import { useState, useCallback, useRef, useEffect } from 'react';
import { LipSync } from 'lip-sync-js';
import type { LipSyncResult, LipSyncOptions } from 'lip-sync-js';

/**
 * Example React hook for lip-sync-js
 * This is NOT part of the package - it's an example showing how to integrate
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { analyze, result, isAnalyzing, error } = useLipSync();
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
export function useLipSync() {
  const [result, setResult] = useState<LipSyncResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const lipSyncRef = useRef<LipSync | null>(null);

  useEffect(() => {
    // Initialize LipSync instance
    lipSyncRef.current = LipSync.getInstance();
    lipSyncRef.current.init({
      wasmPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.wasm',
      dataPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.data',
      jsPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.js'
    }).catch(setError);

    // Cleanup on unmount
    return () => {
      lipSyncRef.current?.destroy();
    };
  }, []);

  const analyze = useCallback(
    async (pcm16: Int16Array, options?: LipSyncOptions) => {
      if (!lipSyncRef.current) {
        setError(new Error('LipSync not initialized'));
        return;
      }

      setIsAnalyzing(true);
      setError(null);

      try {
        const result = await lipSyncRef.current.analyzeAsync(pcm16, options);
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
