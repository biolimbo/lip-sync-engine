# React Example

Complete working React application demonstrating LipSync.js integration with a modern dark mode UI.

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

Then open http://localhost:3000

## WASM Files via CDN

This example uses unpkg.com CDN to load WASM files - **this is the recommended approach for end users** as it requires no additional configuration or file copying.

The initialization uses CDN URLs:
```typescript
await lipSync.init({
  wasmPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.wasm',
  dataPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.data',
  jsPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.js'
});
```

For production, pin to a specific version:
```typescript
await lipSync.init({
  wasmPath: 'https://unpkg.com/lip-sync-js@1.0.0/dist/wasm/lip-sync.wasm',
  dataPath: 'https://unpkg.com/lip-sync-js@1.0.0/dist/wasm/lip-sync.data',
  jsPath: 'https://unpkg.com/lip-sync-js@1.0.0/dist/wasm/lip-sync.js'
});
```

## Project Structure

```
examples/react/
├── public/
│   └── visemes/              # Symlink to shared viseme images
├── src/
│   ├── hooks/
│   │   └── useLipSync.ts     # Custom React hook
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

The `useLipSync` hook provides a clean API:

```typescript
import { useLipSync } from './hooks/useLipSync';
import { recordAudio } from 'lip-sync-js';

function MyComponent() {
  const { analyze, result, isAnalyzing, error, reset } = useLipSync();

  const handleRecord = async () => {
    const { pcm16 } = await recordAudio(5000);
    await analyze(pcm16, { dialogText: "Hello world" });
  };

  return (
    <button onClick={handleRecord} disabled={isAnalyzing}>
      {isAnalyzing ? 'Analyzing...' : 'Record'}
    </button>
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

1. **Automatic Initialization** - LipSync initializes on mount with CDN URLs
2. **Cleanup on Unmount** - Resources are properly freed
3. **Error Handling** - Comprehensive error states
4. **TypeScript** - Full type safety
5. **Async Analysis** - Non-blocking UI with `analyzeAsync()`
6. **Audio Playback** - Web Audio API integration for synchronized animation
7. **Timestamped Logging** - Detailed logs with color-coded types

## Building for Production

```bash
npm run build
npm run preview
```

## Technologies

- React 18
- TypeScript
- Vite
- LipSync.js (via npm + CDN for WASM)
- Web Audio API
