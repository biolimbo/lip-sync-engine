# Svelte Example

Complete working Svelte application demonstrating LipSyncEngine.js integration with a modern dark mode UI.

## Features

- 🎙️ **Record Audio** - Record from microphone with adjustable duration (5-60 seconds)
- 📁 **Load Audio File** - Load any audio file (MP3, WAV, etc.)
- 📝 **Dialog Text Input** - Provide optional text for better accuracy
- ⚡ **Three Execution Modes**:
  - Single Thread - Traditional blocking mode
  - Web Worker - Non-blocking with single worker
  - Chunked Workers - Parallel processing with multiple workers
- 📊 **Performance Metrics** - View execution time, cue count, and worker usage
- 🎛️ **Adjustable Settings** - Control recording duration and chunk size
- 🎭 **Real-time Viseme Display** - Animated mouth shapes synchronized with audio playback
- ▶️ **Replay Button** - Play back animations on demand
- 📋 **Results Timeline** - View all detected mouth cues with timestamps
- 📝 **Timestamped Logs** - Terminal-style logs showing all processing steps
- 🎨 **Modern Dark Mode UI** - Professional, contemporary interface

## Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Then open http://localhost:3002

## WASM Files via CDN

This example uses unpkg.com CDN to load WASM files - **this is the recommended approach for end users** as it requires no additional configuration or file copying.

The initialization uses CDN URLs:
```typescript
await lipSyncEngine.init({
  wasmPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.wasm',
  dataPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.data',
  jsPath: 'https://unpkg.com/lip-sync-engine@latest/dist/wasm/lip-sync-engine.js'
});
```

For production, pin to a specific version:
```typescript
await lipSyncEngine.init({
  wasmPath: 'https://unpkg.com/lip-sync-engine@1.0.2/dist/wasm/lip-sync-engine.wasm',
  dataPath: 'https://unpkg.com/lip-sync-engine@1.0.2/dist/wasm/lip-sync-engine.data',
  jsPath: 'https://unpkg.com/lip-sync-engine@1.0.2/dist/wasm/lip-sync-engine.js'
});
```

## Project Structure

```
examples/svelte/
├── public/
│   └── visemes/              # Symlink to shared viseme images
├── src/
│   ├── stores/
│   │   └── lipSyncEngine.ts   # Svelte store
│   ├── App.svelte              # Main application (dark mode)
│   ├── main.ts                 # Entry point
│   └── app.css                 # Global styles
├── index.html                  # HTML template
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
├── svelte.config.js            # Svelte config
└── vite.config.ts              # Vite config
```

## How It Works

### Svelte Store

The `lipSyncEngineStore` provides reactive state management:

```svelte
<script>
  import { lipSyncEngineStore } from './stores/lipSyncEngine';
  import { recordAudio } from 'lip-sync-engine';

  async function handleRecord() {
    const { pcm16 } = await recordAudio(5000);
    await lipSyncEngineStore.analyze(pcm16, { dialogText: "Hello world" });
  }
</script>

<button on:click={handleRecord} disabled={$lipSyncEngineStore.isAnalyzing}>
  {$lipSyncEngineStore.isAnalyzing ? 'Analyzing...' : 'Record'}
</button>
```

### Viseme Animation

The example demonstrates synchronized viseme animation with Svelte reactivity:

```svelte
<script lang="ts">
  let currentViseme = 'X';
  let audioBuffer: AudioBuffer | null = null;

  // Play animation synchronized with audio
  function playAnimation(mouthCues, buffer) {
    const audioContext = new AudioContext();
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);

    // Animate visemes frame by frame
    function updateViseme() {
      const elapsed = audioContext.currentTime - startTime;
      // Update current viseme based on elapsed time
      currentViseme = mouthCues[currentCueIndex].value;
      requestAnimationFrame(updateViseme);
    }
  }

  // Auto-play when result is available
  $: if ($lipSyncEngineStore.result && audioBuffer) {
    playAnimation($lipSyncEngineStore.result.mouthCues, audioBuffer);
  }
</script>

<div class="viseme-images">
  {#each ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as viseme}
    <img
      src="/visemes/{viseme}.png"
      alt={viseme}
      class:active={currentViseme === viseme}
    />
  {/each}
</div>
```

### Key Features

1. **Reactive Store** - Automatic reactivity with Svelte stores
2. **Simple API** - Subscribe with `$` syntax
3. **Reactive Statements** - `$:` for auto-play functionality
4. **Error Handling** - Comprehensive error states
5. **TypeScript** - Full type safety
6. **Async Analysis** - Non-blocking UI with `analyzeAsync()`
7. **Audio Playback** - Web Audio API integration for synchronized animation
8. **Timestamped Logging** - Detailed logs with color-coded types

## Building for Production

```bash
npm run build
npm run preview
```

## Technologies

- Svelte 4
- TypeScript
- Vite
- LipSyncEngine.js (via npm + CDN for WASM)
- Web Audio API
