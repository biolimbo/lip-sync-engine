# Vue Example

A Vue 3 application that records or loads audio, analyzes it with `lip-sync-engine`, and plays the result as an animated mouth.

## Features

- Record from the microphone for 5 to 60 seconds, or load an audio file (MP3, WAV, and other formats the browser decodes)
- Optional dialog text to improve recognition accuracy
- Four execution modes:
  - Single Thread: runs on the main thread (blocks the UI)
  - Web Worker: runs in one worker, so the UI stays responsive
  - Chunked: splits the audio across up to 4 workers with `analyzeChunks()`. Each chunk is analyzed on its own, so cues near chunk edges are less accurate.
  - Streaming: feeds the chunks to `createStreamAnalyzer()` with 500 ms of context and lookahead, as a live source would
- Performance metrics: execution time, cue count, workers used, and chunks processed
- Adjustable recording duration and chunk size
- Mouth shape animation synchronized with audio playback, with Play and Stop controls
- Timeline of all mouth cues and a timestamped log of each step

## Setup

```bash
npm install
npm run dev
```

Then open http://localhost:3001.

To run the example against a local build of the library, see [Testing Against the Examples](../../docs/development.md#testing-against-the-examples).

## WASM Files and Worker Script

This example passes no paths to `init()`, so the WASM files and the worker script load from unpkg at the installed package version. To serve them yourself, see [Self-Hosting the WASM Files](../../docs/getting-started.md#self-hosting-the-wasm-files).

## Worker Pool

This example creates one pool of up to 4 workers, shares it across all modes and analyses, and never destroys it. See [Pool Lifecycle and Sizing](../../docs/worker-usage.md#pool-lifecycle-and-sizing) for worker count and memory use.

## Streaming

Streaming mode analyzes chunks with up to 500 ms of audio before and after them (`contextMs: 500, lookaheadMs: 500`, the recommended settings). See [Context and Lookahead](../../docs/streaming-analysis.md#context-and-lookahead) for how these settings work, and [`../stream-example.ts`](../stream-example.ts) for WebSocket and microphone sources.

## Project Structure

```
examples/vue/
├── src/
│   ├── composables/
│   │   └── useLipSyncEngine.ts # Vue composable
│   ├── App.vue                 # Main application
│   ├── main.ts                 # Entry point
│   └── style.css               # Global styles
├── index.html                  # HTML template
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config for the app
├── tsconfig.node.json          # TypeScript config for vite.config.ts
└── vite.config.ts              # Vite config (serves ../assets as /visemes/...)
```

## How It Works

### Composable

The `useLipSyncEngine` composable exposes the analysis state and settings as refs:

```vue
<script setup lang="ts">
import { recordAudio } from 'lip-sync-engine';
import { useLipSyncEngine } from './composables/useLipSyncEngine';

const { analyze, result, isAnalyzing, isInitialized, initError, setMode } = useLipSyncEngine();

const handleRecord = async () => {
  try {
    const { pcm16 } = await recordAudio(5000); // mono 16 kHz Int16
    await analyze(pcm16, { dialogText: 'Hello world', sampleRate: 16000 });
  } catch {
    // Recording failed, or analyze() failed and set `error` or `initError`
  }
};
</script>

<template>
  <button @click="setMode('streaming')">Streaming</button>
  <!-- analyze() waits for a mode that is still starting -->
  <button @click="handleRecord" :disabled="isAnalyzing || initError !== null">
    {{ isAnalyzing ? 'Analyzing...' : 'Record' }}
  </button>
  <p v-if="initError">Failed to initialize: {{ initError.message }}</p>
  <p v-else-if="!isInitialized">Initializing...</p>
  <p v-if="result">{{ result.mouthCues.length }} cues</p>
</template>
```

Selecting a mode starts what it needs: the engine for Single Thread, one worker for Web Worker, and all workers for Chunked and Streaming. `isInitialized` turns true when that startup finishes. `analyze()` also starts the mode if needed, so recording can begin while the mode is still starting.

`analyze()` throws on failure: it sets `initError` (and throws a `StartupError`) when the selected mode fails to start, and sets `error` when the analysis itself fails. The library keeps a failed WASM load, so after a Single Thread failure reload the page to retry. A worker pool that failed to start tries again when a worker mode is selected again, so for the worker modes switch modes or reload the page.

### Mouth Shape Animation

`App.vue` plays the audio with one shared `AudioContext` (closed in `onUnmounted`) and picks the mouth shape for the current playback time on every animation frame. A `watch` on `result` plays each new result once.

## Building for Production

```bash
npm run build
npm run preview
```

## Technologies

- Vue 3 (Composition API, `<script setup>`)
- TypeScript
- Vite
- `lip-sync-engine` (WASM files and worker script from unpkg by default)
- Web Audio API
