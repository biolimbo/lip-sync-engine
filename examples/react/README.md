# React Example

Complete working React application demonstrating LipSyncEngine.js integration with a modern dark mode UI.

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

Then open http://localhost:3000

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
examples/react/
├── public/
│   └── visemes/              # Symlink to shared viseme images
├── src/
│   ├── hooks/
│   │   └── useLipSyncEngine.ts # Custom React hook
│   ├── App.tsx                # Main application
│   ├── App.css                # Dark mode styles
│   ├── main.tsx               # Entry point
│   └── index.css              # Global styles
├── index.html                 # HTML template
├── package.json               # Dependencies
├── tsconfig.json              # TypeScript config
└── vite.config.ts             # Vite config
```

## How It Works

### Custom Hook

The `useLipSyncEngine` hook provides a clean API:

```typescript
import { useLipSyncEngine } from './hooks/useLipSyncEngine';
import { recordAudio } from 'lip-sync-engine';

function MyComponent() {
  const {
    analyze,
    result,
    isAnalyzing,
    error,
    reset,
    mode,
    setMode,
    recordingDuration,
    setRecordingDuration
  } = useLipSyncEngine();

  const handleRecord = async () => {
    const { pcm16 } = await recordAudio(recordingDuration * 1000);
    await analyze(pcm16, { dialogText: "Hello world" });
  };

  return (
    <div>
      <select value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="single">Single Thread</option>
        <option value="worker">Web Worker</option>
        <option value="chunked">Chunked Workers</option>
      </select>
      <input
        type="range"
        min="5"
        max="60"
        step="5"
        value={recordingDuration}
        onChange={(e) => setRecordingDuration(Number(e.target.value))}
      />
      <button onClick={handleRecord} disabled={isAnalyzing}>
        {isAnalyzing ? 'Analyzing...' : `Record ${recordingDuration}s`}
      </button>
    </div>
  );
}
```

### Viseme Animation

The example demonstrates synchronized viseme animation:

```typescript
const [currentViseme, setCurrentViseme] = useState('X');
const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);

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
    setCurrentViseme(mouthCues[currentCueIndex].value);
    requestAnimationFrame(updateViseme);
  }
}
```

### Key Features

1. **Mode-Based Initialization** - Different engines initialize based on selected mode
2. **Worker Pool Warmup** - Pre-initialize workers for chunked mode performance
3. **Adjustable Recording Duration** - User-controlled recording time (5-60s)
4. **Performance Metrics** - Track execution time, cues, workers, and chunks
5. **Cleanup on Unmount** - Resources are properly freed
6. **Error Handling** - Comprehensive error states
7. **TypeScript** - Full type safety
8. **Audio Playback** - Web Audio API integration for synchronized animation
9. **Timestamped Logging** - Detailed logs with color-coded types

## Building for Production

```bash
npm run build
npm run preview
```

## Technologies

- React 18
- TypeScript
- Vite
- LipSyncEngine.js (via npm + CDN for WASM)
- Web Audio API
