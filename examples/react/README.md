# React Example

A React and TypeScript app that records or loads speech, analyzes it with `lip-sync-engine`, and plays the audio with animated mouth shapes.

## Features

- Record from the microphone for 5 to 60 seconds, or load an audio file (MP3, WAV, and other formats the browser can decode).
- Optional dialog text to improve recognition accuracy.
- Four execution modes:
  - **Main Thread**: runs `LipSyncEngine.analyze()` on the main thread, which blocks the UI.
  - **Web Worker**: runs `WorkerPool.analyze()` in one worker.
  - **Chunked**: splits the audio across up to 4 workers with `analyzeChunks()`. Each chunk is analyzed on its own, so cues near chunk edges are less accurate.
  - **Streaming**: feeds the chunks to `createStreamAnalyzer()` with 500 ms of context and lookahead, as a live source would.
- Adjustable chunk size for the chunked and streaming modes.
- Performance metrics: execution time, cue count, workers used, and chunks processed.
- Mouth shape display synchronized with audio playback, with Play and Stop controls.
- List of mouth cues with start and end times.
- Timestamped log of each step.

## Setup

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

To run the example against a local build of the library, see [Testing Against the Examples](../../docs/development.md#testing-against-the-examples).

## WASM Files and Worker Script

This example passes no paths to `init()`, so the WASM files and the worker script load from unpkg at the installed package version; see [Self-Hosting the WASM Files](../../docs/getting-started.md#self-hosting-the-wasm-files) to serve them yourself.

## Worker Pool

This example creates one `WorkerPool` of up to 4 workers, shares it across modes, and never destroys it; see [Pool Lifecycle and Sizing](../../docs/worker-usage.md#pool-lifecycle-and-sizing) for why and how to size it.

## Streaming

Streaming mode analyzes each chunk with `contextMs: 500` and `lookaheadMs: 500`; see [Context and Lookahead](../../docs/streaming-analysis.md#context-and-lookahead) for how these settings work.

## Project Structure

```
examples/react/
├── src/
│   ├── hooks/
│   │   └── useLipSyncEngine.ts # Hook that runs the analysis in each mode
│   ├── App.tsx                 # User interface, playback, and logs
│   ├── App.css                 # Component styles
│   ├── main.tsx                # Entry point
│   └── index.css               # Reset and base styles
├── index.html                  # HTML template
├── package.json                # Dependencies and scripts
├── package-lock.json           # Locked dependency versions
├── tsconfig.json               # TypeScript config for src/
├── tsconfig.node.json          # TypeScript config for vite.config.ts
└── vite.config.ts              # Vite config (serves ../assets, so images load from /visemes/)
```

## How It Works

### Custom Hook

`useLipSyncEngine` starts the engine or worker pool for the selected mode and exposes the analysis state and settings:

```tsx
import { recordAudio } from 'lip-sync-engine';
import { useLipSyncEngine } from './hooks/useLipSyncEngine';
import type { ExecutionMode } from './hooks/useLipSyncEngine';

function MyComponent() {
  const { analyze, result, isAnalyzing, isInitialized, initError, mode, setMode } = useLipSyncEngine();

  const handleRecord = async () => {
    const { pcm16 } = await recordAudio(5000); // mono 16 kHz Int16
    try {
      await analyze(pcm16, { dialogText: 'Hello world', sampleRate: 16000 });
    } catch {
      // analyze() also sets `error`
    }
  };

  return (
    <div>
      <select value={mode} onChange={(e) => setMode(e.target.value as ExecutionMode)}>
        <option value="single">Main Thread</option>
        <option value="worker">Web Worker</option>
        <option value="chunked">Chunked</option>
        <option value="streaming">Streaming</option>
      </select>
      <button onClick={handleRecord} disabled={!isInitialized || isAnalyzing}>
        {isAnalyzing ? 'Analyzing...' : 'Record 5 s'}
      </button>
      {initError && <p>Failed to initialize: {initError.message}. Reload the page to retry.</p>}
      {result && <p>{result.mouthCues.length} cues</p>}
    </div>
  );
}
```

`analyze()` resolves with the result and its metrics, and throws on failure after setting `error`. `initError` is set when the selected mode fails to start. The library keeps a failed WASM load, so reload the page to retry.

### Mouth Shape Animation

`App.tsx` plays the audio with one shared `AudioContext` (closed on unmount) and shows the mouth shape for the current playback time on every animation frame. Starting a new playback stops the previous one and cancels its animation loop.

## Type Checking and Building

```bash
npm run typecheck   # type check only
npm run build       # type check, then build to dist/
npm run preview     # serve the production build
```

## Technologies

- React 18
- TypeScript
- Vite
- `lip-sync-engine`
- Web Audio API
