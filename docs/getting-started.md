# Getting Started with lip-sync-engine

This guide covers installing `lip-sync-engine`, analyzing your first audio, framework integration,
and self-hosting the WASM files.

## Installation

```bash
npm install lip-sync-engine
```

## Basic Usage

### 1. Get Audio Data

The library analyzes mono 16-bit PCM audio (`Int16Array`). Use one of these helpers to get it.

#### Option A: Record from the Microphone

```typescript
import { recordAudio } from 'lip-sync-engine';

// Record 5 seconds of audio as 16 kHz PCM
const { pcm16, audioBuffer } = await recordAudio(5000);
```

Recording needs a secure page (HTTPS or `localhost`), an available microphone, and the user's
permission. See [Microphone Access Fails](#microphone-access-fails).

#### Option B: Load from a File or URL

```typescript
import { loadAudio } from 'lip-sync-engine';

// From a file input
const input = document.querySelector<HTMLInputElement>('input[type="file"]');
const file = input?.files?.[0];
if (file) {
  const fromFile = await loadAudio(file);
  console.log(fromFile.pcm16.length);
}

// From a URL
const fromUrl = await loadAudio('https://example.com/audio.mp3');
```

Both calls decode the audio and return `{ pcm16, audioBuffer }` at 16 kHz.

#### Option C: Convert an Existing AudioBuffer

```typescript
import { audioBufferToInt16 } from 'lip-sync-engine';

// For example, an AudioBuffer decoded with the Web Audio API
const response = await fetch('https://example.com/audio.mp3');
const myAudioBuffer = await new AudioContext().decodeAudioData(await response.arrayBuffer());

// Uses the first channel and resamples it to 16 kHz
const pcm16 = audioBufferToInt16(myAudioBuffer, 16000);
```

### 2. Analyze Audio

```typescript
import { analyze, recordAudio } from 'lip-sync-engine';

const { pcm16 } = await recordAudio(5000);

const result = await analyze(pcm16, {
  dialogText: 'Hello world', // optional: the words being spoken
  sampleRate: 16000          // must match the sample rate of pcm16
});

for (const cue of result.mouthCues) {
  console.log(`${cue.start.toFixed(2)}-${cue.end.toFixed(2)} s: ${cue.value}`);
}

// Example output:
// 0.00-0.35 s: X  (Idle, before speech)
// 0.35-0.50 s: D  (Wide open)
// 0.50-0.85 s: B  (Clenched teeth)
// ...
```

`analyze()` loads the WASM files on first use, so calling `init()` first is optional.

### 3. Read the Results

`result.mouthCues` is an array of timed mouth shapes. Each cue has a `start` and `end` time in
seconds and a `value`, which is one of nine shapes: `A` Closed (M, B, P), `B` Clenched teeth, `C`
Open, `D` Wide open, `E` Rounded, `F` Puckered, `G` F/V (upper teeth on lower lip), `H` L (tongue
raised), and `X` Idle. Pass `extendedShapes: ''` to get only A-F. See [Mouth Shapes](../README.md#mouth-shapes) for images of
each shape.

### 4. Analyze Without Blocking the UI

`analyze()` blocks the page while it runs. In interactive pages, use `analyzeAsync()`, which runs
the same analysis in a Web Worker (see [Why Use Workers?](./worker-usage.md#why-use-workers)):

```typescript
import { analyzeAsync, recordAudio } from 'lip-sync-engine';

const { pcm16 } = await recordAudio(5000);
const result = await analyzeAsync(pcm16, { dialogText: 'Hello world' });
```

`analyzeAsync()` starts a shared `WorkerPool` with one worker on first use. To analyze several
buffers in parallel, or to stream live audio, use `WorkerPool` directly. See the
[Web Worker Usage Guide](./worker-usage.md) and the [Streaming Analysis Guide](./streaming-analysis.md).

## Framework Integration

`LipSyncEngine.getInstance()` returns one engine shared by the whole app. Start loading it when a
component mounts (`init()` is safe to call more than once), and do not destroy it when a component
unmounts. See [Clean Up Resources](#4-clean-up-resources).

### React

```tsx
import { useEffect, useState } from 'react';
import { LipSyncEngine, recordAudio } from 'lip-sync-engine';
import type { LipSyncEngineResult } from 'lip-sync-engine';

const engine = LipSyncEngine.getInstance();

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function LipSyncDemo() {
  const [result, setResult] = useState<LipSyncEngineResult | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Start loading the WASM files early
    engine.init().catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  const handleRecord = async () => {
    setIsRecording(true);
    setError(null);
    try {
      const { pcm16 } = await recordAudio(5000);
      setResult(await engine.analyze(pcm16, { dialogText: 'Hello world' }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsRecording(false);
    }
  };

  return (
    <div>
      <button onClick={handleRecord} disabled={isRecording}>
        {isRecording ? 'Recording...' : 'Record'}
      </button>
      {error && <div>{error}</div>}
      {result && <div>Found {result.mouthCues.length} cues</div>}
    </div>
  );
}
```

See [examples/react](../examples/react) for a complete example.

### Vue

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { LipSyncEngine, recordAudio } from 'lip-sync-engine';
import type { LipSyncEngineResult } from 'lip-sync-engine';

const engine = LipSyncEngine.getInstance();

const result = ref<LipSyncEngineResult | null>(null);
const isRecording = ref(false);
const error = ref<string | null>(null);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

onMounted(() => {
  // Start loading the WASM files early
  engine.init().catch((err: unknown) => {
    error.value = errorMessage(err);
  });
});

const handleRecord = async () => {
  isRecording.value = true;
  error.value = null;
  try {
    const { pcm16 } = await recordAudio(5000);
    result.value = await engine.analyze(pcm16, { dialogText: 'Hello world' });
  } catch (err) {
    error.value = errorMessage(err);
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
    <div v-if="error">{{ error }}</div>
    <div v-if="result">Found {{ result.mouthCues.length }} cues</div>
  </div>
</template>
```

See [examples/vue](../examples/vue) for a complete example.

### Svelte

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { LipSyncEngine, recordAudio } from 'lip-sync-engine';
  import type { LipSyncEngineResult } from 'lip-sync-engine';

  const engine = LipSyncEngine.getInstance();

  let result: LipSyncEngineResult | null = null;
  let isRecording = false;
  let error: string | null = null;

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // onMount runs only in the browser, so this is safe with server-side rendering
  onMount(() => {
    engine.init().catch((err: unknown) => {
      error = errorMessage(err);
    });
  });

  async function handleRecord() {
    isRecording = true;
    error = null;
    try {
      const { pcm16 } = await recordAudio(5000);
      result = await engine.analyze(pcm16, { dialogText: 'Hello world' });
    } catch (err) {
      error = errorMessage(err);
    } finally {
      isRecording = false;
    }
  }
</script>

<button on:click={handleRecord} disabled={isRecording}>
  {isRecording ? 'Recording...' : 'Record'}
</button>
{#if error}
  <div>{error}</div>
{/if}
{#if result}
  <div>Found {result.mouthCues.length} cues</div>
{/if}
```

See [examples/svelte](../examples/svelte) for a complete example.

## Best Practices

### 1. Provide Dialog Text When You Know It

If you know the words being spoken, pass them as `dialogText`. Recognition is more accurate with it:

```typescript
import { analyze, loadAudio } from 'lip-sync-engine';

const { pcm16 } = await loadAudio('speech.mp3');

// Recommended: with dialog text
const withText = await analyze(pcm16, {
  dialogText: 'The actual words being spoken'
});

// Less accurate: without dialog text
const withoutText = await analyze(pcm16);
```

### 2. Pass the Buffer's Real Sample Rate

Set `sampleRate` to the rate of the buffer you pass (default 16000). Higher rates are converted down
to 16 kHz internally. Rates below 16 kHz are not supported: the analysis fails with an
`Analysis error: ...` message. `recordAudio()` and `loadAudio()` return 16 kHz audio by default.

```typescript
import { analyze, recordAudio } from 'lip-sync-engine';

// Default: 16 kHz audio and the default sampleRate
const { pcm16 } = await recordAudio(5000);
const result16k = await analyze(pcm16);

// Another rate: pass the same rate to analyze()
const recording44k = await recordAudio(5000, 44100);
const result44k = await analyze(recording44k.pcm16, { sampleRate: 44100 });
```

### 3. Handle Errors

`loadAudio()` and `analyze()` reject if the audio cannot be decoded, the WASM files fail to load,
or the input is invalid. `catch` receives an `unknown` value, so check its type before reading
`message`:

```typescript
import { analyze, loadAudio } from 'lip-sync-engine';

try {
  const { pcm16 } = await loadAudio('speech.mp3');
  const result = await analyze(pcm16);
  console.log(result.mouthCues);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Analysis failed:', message);
}
```

### 4. Clean Up Resources

Initialize the engine once and keep it for the life of the app. Call `destroy()` only when the app
is done with lip sync, not when a component unmounts:

```typescript
import { LipSyncEngine, WasmLoader } from 'lip-sync-engine';

// On app teardown
LipSyncEngine.getInstance().destroy(); // resets the shared instance
WasmLoader.reset();                    // optional: lets the cached WASM module be garbage-collected
```

Without `WasmLoader.reset()`, the WASM module stays cached and a later `init()` is fast. For
`WorkerPool`, see
[Pool Lifecycle and Sizing](./worker-usage.md#pool-lifecycle-and-sizing).

## Self-Hosting the WASM Files

By default the library loads three WASM files, and the worker script for `WorkerPool`, from
`https://unpkg.com/lip-sync-engine@<version>/dist/`, where `<version>` is the installed version.
Host them yourself when the page cannot reach unpkg.com: for example, when a Content Security Policy
blocks it, or when the app must work offline or on an internal network.

1. Copy the files from the installed package to a folder your server publishes:

   ```bash
   mkdir -p public/lip-sync-engine
   cp node_modules/lip-sync-engine/dist/wasm/* node_modules/lip-sync-engine/dist/worker.js public/lip-sync-engine/
   ```

   `dist/wasm/` contains `lip-sync-engine.js`, `lip-sync-engine.wasm`, and `lip-sync-engine.data`.
   Copy the files again whenever you upgrade the package.

2. Pass the paths to `LipSyncEngine.init()` before any `analyze()` call. `analyze()` loads the
   default CDN paths if the engine is not initialized yet, and options passed after the first load
   are ignored.

3. If you use `WorkerPool` or `analyzeAsync()`, pass the same paths plus `workerScriptUrl` to
   `WorkerPool.init()` before the first analysis.

```typescript
import { LipSyncEngine, WorkerPool } from 'lip-sync-engine';

const assets = {
  wasmPath: '/lip-sync-engine/lip-sync-engine.wasm',
  dataPath: '/lip-sync-engine/lip-sync-engine.data',
  jsPath: '/lip-sync-engine/lip-sync-engine.js'
};

// Main thread
await LipSyncEngine.getInstance().init(assets);

// Web Workers
await WorkerPool.getInstance(2).init({
  ...assets,
  workerScriptUrl: '/lip-sync-engine/worker.js'
});
```

Use root-relative paths (starting with `/`) or full URLs. If the files are on another origin, that
server must send CORS headers (`Access-Control-Allow-Origin`) for them. If the files fail to load,
`LipSyncEngine.init()` and `WorkerPool.init()` reject. Neither keeps the failure: fix the paths and
call `init()` again, without reloading the page.

## Common Issues

### Microphone Access Fails

`recordAudio()` rejects when the browser cannot open the microphone. It needs a secure page (HTTPS
or `localhost`) and an available microphone, and the user must allow access:

```typescript
import { recordAudio } from 'lip-sync-engine';

try {
  const { pcm16 } = await recordAudio(5000);
  console.log(pcm16.length);
} catch (error) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    alert('Please allow microphone access.');
  } else if (error instanceof DOMException && error.name === 'NotFoundError') {
    alert('No microphone was found.');
  } else {
    throw error;
  }
}
```

### Poor Recognition Accuracy

If the mouth shapes do not match the speech:

1. Provide `dialogText` when you know the words.
2. Make sure `sampleRate` matches the audio buffer.
3. Use clear audio with little background noise.
4. For streamed audio, analyze chunks with context and lookahead. See
   [Context and Lookahead](./streaming-analysis.md#context-and-lookahead).

## Next Steps

- [API Reference](./api-reference.md): every class, option, and error
- [Web Worker Usage Guide](./worker-usage.md): non-blocking and parallel analysis with `WorkerPool`
- [Streaming Analysis Guide](./streaming-analysis.md): lip sync for live or streamed audio
- [Examples](../examples/): vanilla JavaScript, React, Vue, and Svelte apps
- [Mouth Shapes](../README.md#mouth-shapes): images of each shape
