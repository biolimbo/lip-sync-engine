# Getting Started with lip-sync-js

This guide will help you get up and running with lip-sync-js in your project.

## Installation

```bash
npm install lip-sync-js
```

## Basic Usage

### 1. Import the Library

```typescript
import { analyze, recordAudio } from 'lip-sync-js';
```

### 2. Get Audio Data

You have several options:

#### Option A: Record from Microphone

```typescript
// Record 5 seconds of audio
const { pcm16, audioBuffer } = await recordAudio(5000);
```

#### Option B: Load from File

```typescript
import { loadAudio } from 'lip-sync-js';

// From file input
const file = event.target.files[0];
const { pcm16 } = await loadAudio(file);

// From URL
const { pcm16 } = await loadAudio('https://example.com/audio.mp3');
```

#### Option C: Convert Existing AudioBuffer

```typescript
import { audioBufferToInt16 } from 'lip-sync-js';

// You already have an AudioBuffer
const pcm16 = audioBufferToInt16(myAudioBuffer, 16000);
```

### 3. Analyze Audio

```typescript
const result = await analyze(pcm16, {
  dialogText: "Hello world", // Optional but recommended
  sampleRate: 16000
});
```

### 4. Use the Results

```typescript
// result.mouthCues is an array of timestamped mouth shapes
result.mouthCues.forEach(cue => {
  console.log(`${cue.start}s - ${cue.end}s: ${cue.value}`);
});

// Example output:
// 0.00s - 0.35s: X    (silence/closed)
// 0.35s - 0.50s: D    (th sound in "the")
// 0.50s - 0.85s: B    (p sound in "project")
// ...
```

## Complete Example

```typescript
import { analyze, recordAudio } from 'lip-sync-js';

async function analyzeSpeech() {
  try {
    // 1. Record audio
    console.log('Recording...');
    const { pcm16 } = await recordAudio(5000);

    // 2. Analyze
    console.log('Analyzing...');
    const result = await analyze(pcm16, {
      dialogText: "Hello, this is a test of lip sync",
      sampleRate: 16000
    });

    // 3. Use results
    console.log(`Found ${result.mouthCues.length} mouth cues`);
    result.mouthCues.forEach(cue => {
      console.log(`${cue.start.toFixed(2)}s: ${cue.value}`);
    });

  } catch (error) {
    console.error('Error:', error);
  }
}

analyzeSpeech();
```

## Framework Integration

### React

```tsx
import { useState, useEffect, useRef } from 'react';
import { LipSync, recordAudio } from 'lip-sync-js';

function LipSyncDemo() {
  const [result, setResult] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const lipSyncRef = useRef(LipSync.getInstance());

  useEffect(() => {
    lipSyncRef.current.init();
    return () => lipSyncRef.current.destroy();
  }, []);

  const handleRecord = async () => {
    setIsRecording(true);
    try {
      const { pcm16 } = await recordAudio(5000);
      const res = await lipSyncRef.current.analyze(pcm16, {
        dialogText: "Hello world"
      });
      setResult(res);
    } finally {
      setIsRecording(false);
    }
  };

  return (
    <div>
      <button onClick={handleRecord} disabled={isRecording}>
        {isRecording ? 'Recording...' : 'Record'}
      </button>
      {result && <div>Found {result.mouthCues.length} cues</div>}
    </div>
  );
}
```

See [examples/react](../examples/react) for complete examples.

### Vue

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { LipSync, recordAudio } from 'lip-sync-js';

const result = ref(null);
const isRecording = ref(false);
const lipSync = LipSync.getInstance();

onMounted(() => lipSync.init());
onUnmounted(() => lipSync.destroy());

const handleRecord = async () => {
  isRecording.value = true;
  try {
    const { pcm16 } = await recordAudio(5000);
    result.value = await lipSync.analyze(pcm16, {
      dialogText: "Hello world"
    });
  } finally {
    isRecording.value = false;
  }
};
</script>

<template>
  <div>
    <button @click="handleRecord" :disabled="isRecording">
      {{ isRecording ? 'Recording...' : 'Record' }}
    </button>
    <div v-if="result">Found {{ result.mouthCues.length }} cues</div>
  </div>
</template>
```

See [examples/vue](../examples/vue) for complete examples.

### Svelte

```svelte
<script>
import { writable } from 'svelte/store';
import { LipSync, recordAudio } from 'lip-sync-js';

const result = writable(null);
const isRecording = writable(false);
const lipSync = LipSync.getInstance();
lipSync.init();

async function handleRecord() {
  isRecording.set(true);
  try {
    const { pcm16 } = await recordAudio(5000);
    const res = await lipSync.analyze(pcm16, {
      dialogText: "Hello world"
    });
    result.set(res);
  } finally {
    isRecording.set(false);
  }
}
</script>

<button on:click={handleRecord} disabled={$isRecording}>
  {$isRecording ? 'Recording...' : 'Record'}
</button>
{#if $result}
  <div>Found {$result.mouthCues.length} cues</div>
{/if}
```

See [examples/svelte](../examples/svelte) for complete examples.

## Best Practices

### 1. Always Provide Dialog Text

Dialog text significantly improves accuracy:

```typescript
// ✅ Good - with dialog text
const result = await analyze(pcm16, {
  dialogText: "The actual words being spoken"
});

// ❌ Less accurate - without dialog text
const result = await analyze(pcm16);
```

### 2. Use 16kHz Sample Rate

PocketSphinx is optimized for 16kHz:

```typescript
// ✅ Recommended
const { pcm16 } = await recordAudio(5000, 16000);

// ⚠️ Will work but may be less accurate
const { pcm16 } = await recordAudio(5000, 44100);
```

### 3. Handle Errors

Always wrap in try-catch:

```typescript
try {
  const result = await analyze(pcm16);
  // Use result...
} catch (error) {
  console.error('Analysis failed:', error.message);
  // Show error to user...
}
```

### 4. Clean Up Resources

When done with the library:

```typescript
const lipSync = LipSync.getInstance();
// Use it...
lipSync.destroy(); // Clean up when completely done
```

## Common Issues

### WASM Not Loading

**Problem:** WASM files not found

**Solution:** Make sure WASM files are served from your web server:

```javascript
// Vite example (vite.config.js)
export default {
  publicDir: 'node_modules/lip-sync-js/dist/wasm'
};

// Webpack example (webpack.config.js)
module.exports = {
  module: {
    rules: [
      {
        test: /\.(wasm|data)$/,
        type: 'asset/resource'
      }
    ]
  }
};
```

### Microphone Permission Denied

**Problem:** `recordAudio()` fails

**Solution:** User must grant microphone permission:

```typescript
try {
  const { pcm16 } = await recordAudio(5000);
} catch (error) {
  if (error.name === 'NotAllowedError') {
    alert('Please allow microphone access');
  }
}
```

### Poor Recognition Accuracy

**Problem:** Mouth shapes don't match speech

**Solutions:**
1. Always provide dialog text
2. Use 16kHz sample rate
3. Ensure clear audio (no background noise)
4. Speak clearly at normal pace

## Next Steps

- Read the [API Reference](./api-reference.md) for complete API documentation
- Check out [Framework Examples](../examples/) for integration patterns
- See the [main README](../README.md) for more features
