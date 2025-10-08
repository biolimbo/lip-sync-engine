# 🎙️ LipSync.js

> High-quality lip-sync animation from audio in the browser

[![NPM Version](https://img.shields.io/npm/v/lip-sync-js)](https://www.npmjs.com/package/lip-sync-js)
[![License](https://img.shields.io/npm/l/lip-sync-js)](./LICENSE)

WebAssembly port of [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync) with TypeScript support.

## ✨ Features

- 🚀 **High Performance** - Runs natively in browser via WebAssembly
- 🎯 **Accurate** - Uses PocketSphinx speech recognition for precise phoneme detection
- 📦 **Small Bundle** - Only ~80KB JavaScript + 2.2MB WASM + models
- 🔧 **TypeScript** - Full type definitions included
- 🌐 **Framework-Agnostic** - Works with React, Vue, Svelte, vanilla JS, and any framework
- 🧵 **Web Workers** - Non-blocking analysis with worker pool
- 🎨 **Complete API** - Audio utilities, format conversion, microphone recording
- 📱 **Browser-Native** - No server required, runs entirely client-side

## 📦 Installation

```bash
npm install lip-sync-js
```

## 🚀 Quick Start

### Vanilla JavaScript / TypeScript

```typescript
import { analyze, recordAudio } from 'lip-sync-js';

// Record audio from microphone
const { pcm16 } = await recordAudio(5000); // 5 seconds

// Analyze
const result = await analyze(pcm16, {
  dialogText: "Hello world", // Optional, improves accuracy
  sampleRate: 16000
});

// Use mouth cues for animation
result.mouthCues.forEach(cue => {
  console.log(`${cue.start}s - ${cue.end}s: ${cue.value}`);
  // Output: 0.00s - 0.35s: X
  //         0.35s - 0.50s: D
  //         0.50s - 0.85s: B
  //         ...
});
```

### React

```tsx
import { useState, useEffect, useRef } from 'react';
import { LipSync, recordAudio } from 'lip-sync-js';

function useLipSync() {
  const [result, setResult] = useState(null);
  const lipSyncRef = useRef(LipSync.getInstance());

  useEffect(() => {
    lipSyncRef.current.init();
    return () => lipSyncRef.current.destroy();
  }, []);

  const analyze = async (pcm16, options) => {
    const result = await lipSyncRef.current.analyze(pcm16, options);
    setResult(result);
  };

  return { analyze, result };
}

function MyComponent() {
  const { analyze, result } = useLipSync();

  const handleRecord = async () => {
    const { pcm16 } = await recordAudio(5000);
    await analyze(pcm16, { dialogText: "Hello world" });
  };

  return (
    <div>
      <button onClick={handleRecord}>Record & Analyze</button>
      {result && <div>Found {result.mouthCues.length} mouth cues!</div>}
    </div>
  );
}
```

See [examples/react](./examples/react) for complete example.

### Vue

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { LipSync, recordAudio } from 'lip-sync-js';

const result = ref(null);
const lipSync = LipSync.getInstance();

onMounted(() => lipSync.init());
onUnmounted(() => lipSync.destroy());

const handleRecord = async () => {
  const { pcm16 } = await recordAudio(5000);
  result.value = await lipSync.analyze(pcm16, { dialogText: "Hello world" });
};
</script>

<template>
  <div>
    <button @click="handleRecord">Record & Analyze</button>
    <div v-if="result">Found {{ result.mouthCues.length }} mouth cues!</div>
  </div>
</template>
```

See [examples/vue](./examples/vue) for complete example.

### Svelte

```svelte
<script>
import { writable } from 'svelte/store';
import { LipSync, recordAudio } from 'lip-sync-js';

const result = writable(null);
const lipSync = LipSync.getInstance();
lipSync.init();

async function handleRecord() {
  const { pcm16 } = await recordAudio(5000);
  const res = await lipSync.analyze(pcm16, { dialogText: "Hello world" });
  result.set(res);
}
</script>

<button on:click={handleRecord}>Record & Analyze</button>
{#if $result}
  <div>Found {$result.mouthCues.length} mouth cues!</div>
{/if}
```

See [examples/svelte](./examples/svelte) for complete example.

## 📚 Documentation

- [Getting Started](./docs/getting-started.md)
- [API Reference](./docs/api-reference.md)
- Framework Examples:
  - [Vanilla JS](./examples/vanilla/README.md)
  - [React](./examples/react/README.md)
  - [Vue](./examples/vue/README.md)
  - [Svelte](./examples/svelte/README.md)

## 🎨 Mouth Shapes (Visemes)

LipSync.js generates 9 mouth shapes based on Preston Blair's phoneme categorization:

| Shape | Description | Example Sounds |
|-------|-------------|----------------|
| X | Closed/Rest | Silence |
| A | Open | ah, aa, aw |
| B | Lips together | p, b, m |
| C | Rounded | sh, ch, zh |
| D | Tongue-teeth | th, dh, t, d, n, l |
| E | Slightly open | eh, ae, uh |
| F | F/V sound | f, v |
| G | Open back | k, g, ng |
| H | Wide open | ee, ih, ey |

## 🔬 How It Works

1. **Speech Recognition** - PocketSphinx analyzes audio to detect phonemes
2. **Phoneme Mapping** - Phonemes are mapped to Preston Blair mouth shapes
3. **Timing Optimization** - Animation is smoothed for natural transitions
4. **JSON Output** - Returns timestamped mouth shape cues

## 📊 API Overview

### Core Functions

```typescript
// Simple one-off analysis
import { analyze } from 'lip-sync-js';
const result = await analyze(pcm16, options);

// Async analysis (non-blocking)
import { analyzeAsync } from 'lip-sync-js';
const result = await analyzeAsync(pcm16, options);

// Using the main class
import { LipSync } from 'lip-sync-js';
const lipSync = LipSync.getInstance();
await lipSync.init();
const result = await lipSync.analyze(pcm16, options);
```

### Audio Utilities

```typescript
import {
  recordAudio,
  loadAudio,
  audioBufferToInt16,
  float32ToInt16,
  resample
} from 'lip-sync-js';

// Record from microphone
const { pcm16, audioBuffer } = await recordAudio(5000); // 5 seconds

// Load from file or URL
const { pcm16, audioBuffer } = await loadAudio('audio.mp3');

// Convert formats
const int16 = audioBufferToInt16(audioBuffer, 16000);
const int16 = float32ToInt16(float32Array);
const resampled = resample(float32Array, 44100, 16000);
```

### Types

```typescript
interface MouthCue {
  start: number;  // seconds
  end: number;    // seconds
  value: string;  // X, A, B, C, D, E, F, G, or H
}

interface LipSyncResult {
  mouthCues: MouthCue[];
  metadata?: {
    duration: number;
    sampleRate: number;
    dialogText?: string;
  };
}

interface LipSyncOptions {
  dialogText?: string;  // Improves accuracy significantly
  sampleRate?: number;  // Default: 16000 (recommended)
}
```

## 🛠️ Development

```bash
# Install dependencies
npm install

# Build WASM module
npm run build:wasm

# Build TypeScript
npm run build:ts

# Build everything
npm run build

# Type check
npm run typecheck

# Clean build artifacts
npm run clean
```

## 📄 License

MIT License - see [LICENSE](./LICENSE)

## 🙏 Credits

- Original [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync) by Daniel Wolf
- [PocketSphinx](https://github.com/cmusphinx/pocketsphinx) for speech recognition
- Preston Blair for phoneme categorization system

## 🐛 Issues

Report issues at [https://github.com/biolimbo/lip-sync-js/issues](https://github.com/biolimbo/lip-sync-js/issues)

## 📈 Roadmap

- [ ] Full Web Worker implementation
- [ ] Multiple language support
- [ ] Custom phoneme-to-viseme mappings
- [ ] Real-time streaming analysis
- [ ] Three.js / Babylon.js helpers
- [ ] Unity WebGL bridge
