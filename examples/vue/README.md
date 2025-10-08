# Vue Example

Complete working Vue 3 application demonstrating LipSyncEngine.js integration with a modern dark mode UI.

## Features

- 🎙️ **Record Audio** - Record from microphone (5 seconds)
- 📁 **Load Audio File** - Load any audio file (MP3, WAV, etc.)
- 📝 **Dialog Text Input** - Provide optional text for better accuracy
- 🎭 **Real-time Viseme Display** - Animated mouth shapes synchronized with audio playback
- ▶️ **Replay Button** - Play back animations on demand
- 📊 **Results Timeline** - View all detected mouth cues with timestamps
- 📝 **Timestamped Logs** - Terminal-style logs showing all processing steps
- 🎨 **Modern Dark Mode UI** - Professional, contemporary interface

## Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Then open http://localhost:3001

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
  wasmPath: 'https://unpkg.com/lip-sync-engine@1.0.0/dist/wasm/lip-sync-engine.wasm',
  dataPath: 'https://unpkg.com/lip-sync-engine@1.0.0/dist/wasm/lip-sync-engine.data',
  jsPath: 'https://unpkg.com/lip-sync-engine@1.0.0/dist/wasm/lip-sync-engine.js'
});
```

## Project Structure

```
examples/vue/
├── public/
│   └── visemes/              # Symlink to shared viseme images
├── src/
│   ├── composables/
│   │   └── useLipSyncEngine.ts # Vue composable
│   ├── App.vue                 # Main application (dark mode)
│   ├── main.ts                 # Entry point
│   └── style.css               # Global styles
├── index.html                  # HTML template
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
└── vite.config.ts              # Vite config
```

## How It Works

### Composable

The `useLipSyncEngine` composable provides a clean API:

```vue
<script setup lang="ts">
import { useLipSyncEngine } from './composables/useLipSyncEngine';
import { recordAudio } from 'lip-sync-engine';

const { analyze, result, isAnalyzing, error, reset } = useLipSyncEngine();

const handleRecord = async () => {
  const { pcm16 } = await recordAudio(5000);
  await analyze(pcm16, { dialogText: "Hello world" });
};
</script>

<template>
  <button @click="handleRecord" :disabled="isAnalyzing">
    {{ isAnalyzing ? 'Analyzing...' : 'Record' }}
  </button>
</template>
```

### Viseme Animation

The example demonstrates synchronized viseme animation with Vue reactivity:

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';

const currentViseme = ref('X');
const audioBuffer = ref<AudioBuffer | null>(null);

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
    currentViseme.value = mouthCues[currentCueIndex].value;
    requestAnimationFrame(updateViseme);
  }
}

// Auto-play when result is available
watch(result, (newResult) => {
  if (newResult && audioBuffer.value) {
    playAnimation(newResult.mouthCues, audioBuffer.value);
  }
});
</script>

<template>
  <div class="viseme-images">
    <img
      v-for="viseme in ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']"
      :key="viseme"
      :src="`/visemes/${viseme}.png`"
      :class="{ active: currentViseme === viseme }"
    />
  </div>
</template>
```

### Key Features

1. **Composition API** - Uses Vue 3's `<script setup>` syntax
2. **Reactive State** - All state is reactive using `ref()`
3. **Automatic Cleanup** - Resources freed on unmount
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

- Vue 3
- TypeScript
- Vite
- LipSyncEngine.js (via npm + CDN for WASM)
- Web Audio API
