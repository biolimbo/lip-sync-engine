# Svelte Example

A Svelte 4 app that analyzes recorded or loaded audio with `lip-sync-engine` in four execution modes and animates the resulting mouth shapes.

## Features

- Record from the microphone for 5 to 60 seconds, or load an audio file (MP3, WAV, and other formats the browser can decode).
- Optional dialog text to improve accuracy.
- Four execution modes:
  - Single Thread: main thread (blocks the UI).
  - Web Worker: one worker, so the UI stays responsive.
  - Chunked: splits audio across up to 4 workers with `analyzeChunks()`. Each chunk is analyzed on its own, so cues near chunk edges are less accurate.
  - Streaming: feeds the chunks to `createStreamAnalyzer()` with 500 ms of context and lookahead, as a live source would.
- Performance metrics: execution time, cue count, workers used, and chunks processed.
- Adjustable recording duration and chunk size.
- Mouth shape animation synchronized with audio playback, with Play and Stop controls.
- Results timeline with every mouth cue and its timestamps.
- Timestamped log of each processing step.

## Setup

```bash
npm install
npm run dev
```

Then open http://localhost:3002.

To run the example against a local build of the library, see [Testing Against the Examples](../../docs/development.md#testing-against-the-examples).

## WASM Files and Worker Script

This example passes no init options, so the WASM files and the worker script load from unpkg at the installed package version; see [Self-Hosting the WASM Files](../../docs/getting-started.md#self-hosting-the-wasm-files) to serve them yourself.

## Worker Pool

The store creates one pool of up to 4 workers, shares it across modes and analyses, and keeps it alive until `lipSyncEngineStore.destroy()`; see [Pool Lifecycle and Sizing](../../docs/worker-usage.md#pool-lifecycle-and-sizing).

## Streaming

Streaming mode analyzes each chunk with 500 ms of audio before and after it (`contextMs: 500, lookaheadMs: 500`); see [Context and Lookahead](../../docs/streaming-analysis.md#context-and-lookahead).

## Project Structure

```
examples/svelte/
├── src/
│   ├── stores/
│   │   └── lipSyncEngine.ts    # Svelte store
│   ├── App.svelte              # Main application
│   ├── main.ts                 # Entry point
│   └── app.css                 # Global styles
├── index.html                  # HTML template
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
├── tsconfig.node.json          # TypeScript config for vite.config.ts
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
    try {
      const { pcm16 } = await recordAudio(5000); // mono 16 kHz Int16
      await lipSyncEngineStore.analyze(pcm16, { dialogText: 'Hello world', sampleRate: 16000 });
    } catch {
      // Recording failed, or analyze() failed and set `error` or `initError`
    }
  }
</script>

<button on:click={() => lipSyncEngineStore.setMode('streaming')}>Streaming</button>
<!-- analyze() waits for a mode that is still starting -->
<button
  on:click={handleRecord}
  disabled={$lipSyncEngineStore.isAnalyzing || $lipSyncEngineStore.initError !== null}
>
  {$lipSyncEngineStore.isAnalyzing ? 'Analyzing...' : 'Record'}
</button>

{#if $lipSyncEngineStore.initError}
  <p>Failed to initialize: {$lipSyncEngineStore.initError.message}</p>
{:else if !$lipSyncEngineStore.isInitialized}
  <p>Initializing...</p>
{/if}
```

Selecting a mode starts what it needs: the engine for Single Thread, one worker for Web Worker, and all workers for Chunked and Streaming. `isInitialized` turns true when that startup finishes, and `initError` is set if it fails. `analyze()` also starts the mode if needed, so recording can begin while the mode is still starting; only a failed startup disables it.

`analyze()` resolves with the result. It throws on failure: it sets `initError` (and throws a `StartupError`) when the selected mode fails to start, and sets `error` when the analysis itself fails. The library keeps a failed WASM load, so after a Single Thread failure reload the page to retry. A worker pool that failed to start tries again when a worker mode is selected again, so for the worker modes switch modes or reload the page.

`lipSyncEngineStore.destroy()` frees the engine and the workers when the app no longer needs them. It sets `stopped` in the store, and the next `analyze()` or mode change starts the selected mode again.

### Mouth Shape Animation

`App.svelte` plays the audio with one shared `AudioContext` (closed in `onDestroy`) and picks the mouth shape for the current playback time on every animation frame. The reactive block that auto-plays a result remembers the last result it played; otherwise it would run again on every store update (moving a slider, changing mode) and replay the audio.

## Building for Production

```bash
npm run build
npm run preview
```

Run `npm run check` to type-check the app with svelte-check.

## Technologies

- Svelte 4
- TypeScript
- Vite
- `lip-sync-engine` (npm package, WASM files from unpkg by default)
- Web Audio API
