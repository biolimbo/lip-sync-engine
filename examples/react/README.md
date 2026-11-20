# React Example

Complete working React application demonstrating LipSyncEngine.js integration with a dark mode UI.

## Features

- 🎙️ **Record Audio** - Record from microphone with adjustable duration (5-60 seconds)
- 📁 **Load Audio File** - Load any audio file (MP3, WAV, etc.)
- 📝 **Dialog Text Input** - Provide optional text for better accuracy
- ⚡ **Four Execution Modes**:
  - Single Thread - Runs on the main thread (blocks the UI)
  - Web Worker - Non-blocking, one worker
  - Chunked Workers - Splits the audio and analyses the chunks in parallel with `analyzeChunks()`. Each chunk is analysed on its own, so cues near chunk edges are less accurate.
  - Streaming - Feeds the chunks to `createStreamAnalyzer()` with the recommended 2.0.0 settings (500 ms of context and lookahead), as a live source would
- 📊 **Performance Metrics** - View execution time, cue count, and worker usage
- 🎛️ **Adjustable Settings** - Control recording duration and chunk size
- 🎭 **Real-time Viseme Display** - Animated mouth shapes synchronized with audio playback
- ▶️ **Replay Button** - Play back animations on demand
- 📋 **Results Timeline** - View all detected mouth cues with timestamps
- 📝 **Timestamped Logs** - Processing steps with color-coded types

## Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Then open http://localhost:3000

### Testing a local build

Until `lip-sync-engine@2.0.0` is on npm (and unpkg), install the package built in this repository instead. This does not change `package.json`:

```bash
# From the repository root
npm run build
# From this example
npm install --no-save ../..
```

The WASM files and the worker script still load from unpkg by default (see below). To use the local ones, pass their paths to `init()`.

## WASM Files and Worker Script

With no options, `init()` loads the `.wasm`, `.data` and Emscripten `.js` files (and, for `WorkerPool`, the worker script) from unpkg at the installed package version. Nothing needs to be copied or configured, and this works with any bundler.

To self-host them, copy `node_modules/lip-sync-engine/dist/` to your public folder and pass absolute URLs (workers resolve relative paths against the worker script, not the page):

```typescript
const base = new URL('/lip-sync-engine/', location.href).href;
const paths = {
  wasmPath: `${base}wasm/lip-sync-engine.wasm`,
  dataPath: `${base}wasm/lip-sync-engine.data`,
  jsPath: `${base}wasm/lip-sync-engine.js`,
};

await LipSyncEngine.getInstance().init(paths);
await WorkerPool.getInstance(4).init({ ...paths, workerScriptUrl: `${base}worker.js` });
```

## Keep the Pool Alive

The example creates the engine and the worker pool once, at module level, and shares them across modes, analyses and component instances. Since 2.0.0 each worker keeps its speech decoder between calls, so only pool start-up pays for building it. Destroying and re-creating the pool for every analysis (or on every mode change) pays that cost again each time. Call `WorkerPool.getInstance().destroy()` only when the app no longer needs lip sync.

The pool is capped at 4 workers because each worker holds its own copy of the models (about 39 MB plus the WebAssembly heap).

## Streaming

Short chunks analysed on their own lose most of their mouth shapes. The streaming mode uses the recommended setup:

```typescript
const stream = pool.createStreamAnalyzer({ sampleRate: 16000, contextMs: 500, lookaheadMs: 500 });
const index = stream.addChunk(chunk);           // as audio arrives
stream.getResult(index).then(playChunk);        // cue times are relative to the chunk
stream.end();                                   // when the utterance is complete
```

See [`../stream-example.ts`](../stream-example.ts) for WebSocket and microphone sources.

## Project Structure

```
examples/react/
├── src/
│   ├── hooks/
│   │   └── useLipSyncEngine.ts # Custom React hook
│   ├── App.tsx                 # Main application
│   ├── App.css                 # Dark mode styles
│   ├── main.tsx                # Entry point
│   └── index.css               # Global styles
├── index.html                  # HTML template
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
└── vite.config.ts              # Vite config (serves ../assets as /visemes/...)
```

## How It Works

### Custom Hook

The `useLipSyncEngine` hook exposes the analysis state and settings:

```tsx
import { useLipSyncEngine } from './hooks/useLipSyncEngine';
import type { ExecutionMode } from './hooks/useLipSyncEngine';
import { recordAudio } from 'lip-sync-engine';

function MyComponent() {
  const { analyze, result, isAnalyzing, isInitialized, mode, setMode } = useLipSyncEngine();

  const handleRecord = async () => {
    const { pcm16 } = await recordAudio(5000); // mono 16 kHz Int16
    await analyze(pcm16, { dialogText: 'Hello world', sampleRate: 16000 });
  };

  return (
    <div>
      <select value={mode} onChange={(e) => setMode(e.target.value as ExecutionMode)}>
        <option value="single">Single Thread</option>
        <option value="worker">Web Worker</option>
        <option value="chunked">Chunked Workers</option>
        <option value="streaming">Streaming</option>
      </select>
      <button onClick={handleRecord} disabled={!isInitialized || isAnalyzing}>
        {isAnalyzing ? 'Analyzing...' : 'Record 5s'}
      </button>
      {result && <p>{result.mouthCues.length} cues</p>}
    </div>
  );
}
```

`analyze()` throws on failure (and also sets `error`).

### Viseme Animation

`App.tsx` plays the audio with one shared `AudioContext` (closed on unmount) and picks the viseme for the current playback time on every animation frame. Starting a new playback stops the previous one and cancels its animation loop.

## Building for Production

```bash
npm run build
npm run preview
```

## Technologies

- React 18
- TypeScript
- Vite
- LipSyncEngine.js (npm package, WASM files from unpkg by default)
- Web Audio API
