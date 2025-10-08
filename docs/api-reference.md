# API Reference

Complete API documentation for lip-sync-engine.

## Core Classes

### LipSyncEngine

Main singleton class for lip-sync analysis.

```typescript
class LipSyncEngine {
  static getInstance(): LipSyncEngine
  async init(options?: WasmLoaderOptions): Promise<void>
  async analyze(pcm16: Int16Array, options?: LipSyncEngineOptions): Promise<LipSyncEngineResult>
  async analyzeAsync(pcm16: Int16Array, options?: LipSyncEngineOptions): Promise<LipSyncEngineResult>
  destroy(): void
}
```

#### `getInstance()`

Get the singleton instance.

**Returns:** `LipSyncEngine` - The singleton instance

**Example:**
```typescript
const lipSyncEngine = LipSyncEngine.getInstance();
```

#### `init(options?)`

Initialize the WASM module. Must be called before analysis.

**Parameters:**
- `options?: WasmLoaderOptions` - Optional WASM file paths

**Returns:** `Promise<void>`

**Example:**
```typescript
await lipSyncEngine.init();

// Or with custom paths
await lipSyncEngine.init({
  wasmPath: '/custom/path/lip-sync-engine.wasm',
  dataPath: '/custom/path/lip-sync-engine.data',
  jsPath: '/custom/path/lip-sync-engine.js'
});
```

#### `analyze(pcm16, options?)`

Analyze audio and generate lip-sync data (blocking).

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer (mono)
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Throws:**
- `TypeError` - If pcm16 is not an Int16Array
- `Error` - If buffer is empty or analysis fails

**Example:**
```typescript
const result = await lipSyncEngine.analyze(pcm16, {
  dialogText: "Hello world",
  sampleRate: 16000
});
```

#### `analyzeAsync(pcm16, options?)`

Analyze audio using Web Worker (non-blocking).

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer (mono)
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Example:**
```typescript
const result = await lipSyncEngine.analyzeAsync(pcm16, {
  dialogText: "Hello world"
});
```

#### `destroy()`

Clean up resources and destroy the instance.

**Example:**
```typescript
lipSyncEngine.destroy();
```

## Convenience Functions

### `analyze(pcm16, options?)`

One-off analysis without managing instance.

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Example:**
```typescript
import { analyze } from 'lip-sync-engine';

const result = await analyze(pcm16, {
  dialogText: "Hello world",
  sampleRate: 16000
});
```

### `analyzeAsync(pcm16, options?)`

One-off async analysis with Web Worker.

**Parameters:**
- `pcm16: Int16Array` - 16-bit PCM audio buffer
- `options?: LipSyncEngineOptions` - Analysis options

**Returns:** `Promise<LipSyncEngineResult>`

**Example:**
```typescript
import { analyzeAsync } from 'lip-sync-engine';

const result = await analyzeAsync(pcm16, {
  dialogText: "Hello world"
});
```

## Audio Utilities

### `recordAudio(durationMs, sampleRate?)`

Record audio from microphone.

**Parameters:**
- `durationMs: number` - Recording duration in milliseconds
- `sampleRate?: number` - Target sample rate (default: 16000)

**Returns:** `Promise<{ pcm16: Int16Array, audioBuffer: AudioBuffer }>`

**Example:**
```typescript
import { recordAudio } from 'lip-sync-engine';

// Record 5 seconds
const { pcm16, audioBuffer } = await recordAudio(5000);
```

### `loadAudio(source, targetSampleRate?)`

Load audio from URL or File.

**Parameters:**
- `source: string | File` - URL or File object
- `targetSampleRate?: number` - Target sample rate (default: 16000)

**Returns:** `Promise<{ pcm16: Int16Array, audioBuffer: AudioBuffer }>`

**Example:**
```typescript
import { loadAudio } from 'lip-sync-engine';

// From URL
const { pcm16 } = await loadAudio('https://example.com/audio.mp3');

// From File input
const file = event.target.files[0];
const { pcm16 } = await loadAudio(file);
```

### `audioBufferToInt16(audioBuffer, targetSampleRate?)`

Convert AudioBuffer to Int16Array PCM.

**Parameters:**
- `audioBuffer: AudioBuffer` - Web Audio API AudioBuffer
- `targetSampleRate?: number` - Target sample rate (default: 16000)

**Returns:** `Int16Array`

**Example:**
```typescript
import { audioBufferToInt16 } from 'lip-sync-engine';

const pcm16 = audioBufferToInt16(audioBuffer, 16000);
```

### `float32ToInt16(float32)`

Convert Float32Array to Int16Array PCM.

**Parameters:**
- `float32: Float32Array` - Float32 audio data

**Returns:** `Int16Array`

**Example:**
```typescript
import { float32ToInt16 } from 'lip-sync-engine';

const int16 = float32ToInt16(float32Data);
```

### `resample(input, fromRate, toRate)`

Resample audio to different sample rate.

**Parameters:**
- `input: Float32Array` - Input audio samples
- `fromRate: number` - Source sample rate
- `toRate: number` - Target sample rate

**Returns:** `Float32Array`

**Example:**
```typescript
import { resample } from 'lip-sync-engine';

const resampled = resample(float32Data, 44100, 16000);
```

## Types

### `MouthCue`

Represents a single mouth shape with timing.

```typescript
interface MouthCue {
  start: number;  // Start time in seconds
  end: number;    // End time in seconds
  value: string;  // Mouth shape: X, A, B, C, D, E, F, G, or H
}
```

### `LipSyncEngineResult`

Result of lip-sync analysis.

```typescript
interface LipSyncEngineResult {
  mouthCues: MouthCue[];
  metadata?: {
    duration: number;      // Total duration in seconds
    sampleRate: number;    // Sample rate used
    dialogText?: string;   // Dialog text (if provided)
  };
}
```

### `LipSyncEngineOptions`

Options for lip-sync analysis.

```typescript
interface LipSyncEngineOptions {
  dialogText?: string;  // Optional dialog text for better accuracy
  sampleRate?: number;  // Sample rate (default: 16000, recommended: 16000)
}
```

### `WasmLoaderOptions`

Options for WASM loading.

```typescript
interface WasmLoaderOptions {
  wasmPath?: string;  // Path to .wasm file
  dataPath?: string;  // Path to .data file
  jsPath?: string;    // Path to .js file
}
```

## Mouth Shape Reference

| Value | Name | Description | Phonemes |
|-------|------|-------------|----------|
| X | Closed/Rest | Mouth closed or at rest | Silence |
| A | Open | Mouth wide open | AH, AA, AO, AW |
| B | Lips Together | Lips pressed together | P, B, M |
| C | Rounded | Lips rounded | SH, CH, JH, ZH |
| D | Tongue-Teeth | Tongue touching teeth | TH, DH, T, D, N, L |
| E | Slightly Open | Slightly open | EH, AE, UH, ER |
| F | F/V Sound | Lower lip touching upper teeth | F, V |
| G | Open Back | Open with tongue back | K, G, NG |
| H | Wide Open | Wide open with spread lips | IY, IH, EY, AY |

## Best Practices

### Sample Rate

- **Recommended:** 16000 Hz (16kHz)
- **Why:** PocketSphinx is optimized for 16kHz
- **Higher rates:** Will be resampled, may reduce accuracy

### Dialog Text

Always provide dialog text when you know what will be said:

```typescript
// ✅ Good - with dialog text
const result = await analyze(pcm16, {
  dialogText: "Hello world, this is a test"
});

// ❌ Less accurate - without dialog text
const result = await analyze(pcm16);
```

### Memory Management

Clean up when done:

```typescript
const lipSyncEngine = LipSyncEngine.getInstance();
await lipSyncEngine.init();

// Use it...
const result = await lipSyncEngine.analyze(pcm16);

// Clean up when completely done
lipSyncEngine.destroy();
```

### Async vs Sync

Use `analyzeAsync()` for long audio to avoid blocking UI:

```typescript
// For short audio (< 5 seconds)
const result = await lipSyncEngine.analyze(pcm16);

// For long audio (> 5 seconds) - doesn't block UI
const result = await lipSyncEngine.analyzeAsync(pcm16);
```
