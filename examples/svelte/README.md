# Svelte Example

Complete working Svelte application demonstrating LipSyncEngine.js integration with a dark mode UI.

## Features

- 🎙️ **Record Audio** - Record from microphone with adjustable duration (5-60 seconds)
- 📁 **Load Audio File** - Load any audio file (MP3, WAV, etc.)
- 📝 **Dialog Text Input** - Provide optional text for better accuracy
- ⚡ **Four Execution Modes**:
  - Single Thread - Runs on the main thread (blocks the UI)
  - Web Worker - Non-blocking, one worker
  - Chunked Workers - Splits the audio and analyses the chunks in parallel with `analyzeChunks()`. Each chunk is analysed on its own, so cues near chunk edges are less accurate.
  - Streaming - Feeds the chunks to `createStreamAnalyzer()` with the recommended 1.1.0 settings (500 ms of context and lookahead), as a live source would
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

Then open http://localhost:3002

### Testing a local build

Until `lip-sync-engine@1.1.0` is on npm (and unpkg), install the package built in this repository instead. This does not change `package.json`:

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

The example creates the engine and the worker pool once, at module level, and shares them across modes, analyses and component instances. Since 1.1.0 each worker keeps its speech decoder between calls, so only pool start-up pays for building it. Destroying and re-creating the pool for every analysis (or on every mode change) pays that cost again each time. Call `WorkerPool.getInstance().destroy()` only when the app no longer needs lip sync.

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
examples/svelte/
├── src/
│   ├── stores/
│   │   └── lipSyncEngine.ts    # Svelte store
│   ├── App.svelte              # Main application (dark mode)
│   ├── main.ts                 # Entry point
│   └── app.css                 # Global styles
├── index.html                  # HTML template
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
├── svelte.config.js            # Svelte config
└── vite.config.ts              # Vite config (serves ../assets as /visemes/...)
```

## How It Works

### Svelte Store

`lipSyncEngineStore` holds the analysis state and settings:

```svelte
<script lang="ts">
  import { lipSyncEngineStore } from './stores/lipSyncEngine';
  import { recordAudio } from 'lip-sync-engine';

  async function handleRecord() {
    const { pcm16 } = await recordAudio(5000); // mono 16 kHz Int16
    await lipSyncEngineStore.analyze(pcm16, { dialogText: 'Hello world', sampleRate: 16000 });
  }
</script>

<button on:click={() => lipSyncEngineStore.setMode('streaming')}>Streaming</button>
<button
  on:click={handleRecord}
  disabled={!$lipSyncEngineStore.isInitialized || $lipSyncEngineStore.isAnalyzing}
>
  {$lipSyncEngineStore.isAnalyzing ? 'Analyzing...' : 'Record'}
</button>
```

`analyze()` throws on failure (and also sets `error` in the store). `lipSyncEngineStore.destroy()` frees the engine and the workers when the app no longer needs them.

### Viseme Animation

`App.svelte` plays the audio with one shared `AudioContext` (closed in `onDestroy`) and picks the viseme for the current playback time on every animation frame. The reactive block that auto-plays a result remembers the last result it played; otherwise it would run again on every store update (moving a slider, changing mode) and replay the audio.

## Building for Production

```bash
npm run build
npm run preview
npm run check   # svelte-check type checking
```

## Technologies

- Svelte 4
- TypeScript
- Vite
- LipSyncEngine.js (npm package, WASM files from unpkg by default)
- Web Audio API
