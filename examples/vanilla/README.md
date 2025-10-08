# Vanilla JavaScript Example

Complete vanilla JavaScript example demonstrating LipSync.js with real-time viseme playback and modern dark mode UI.

This example uses the published npm package via unpkg.com CDN - **this is the recommended approach for end users**.

## Running

**Requirements:**
- No build step needed
- Works standalone
- Can be run from any directory or served by any static server

**Option 1: Local server**
```bash
# From examples/vanilla/
python3 -m http.server 8000
# Open http://localhost:8000/
```

**Option 2: Any static file server**
Simply open `index.html` in your browser via any static file server.

## Features

- 🎙️ **Record Audio** - Record from microphone (5 seconds)
- 📁 **Load Audio File** - Load any audio file (MP3, WAV, etc.)
- 📝 **Dialog Text Input** - Provide optional text for better accuracy
- 🎭 **Real-time Viseme Display** - Animated mouth shapes using PNG images with opacity-based switching
- ▶️ **Replay Button** - Play back animations on demand
- 📊 **Results Timeline** - View all detected mouth cues with timestamps
- 📝 **Timestamped Logs** - Terminal-style logs showing all processing steps with color coding
- 🎨 **Modern Dark Mode UI** - Professional, contemporary interface

## For Package Users

If you're using lip-sync-js in your own project, refer to `index-cdn.html` for the recommended approach:

### Option 1: CDN (unpkg.com)

```html
<script type="module">
  import { LipSync, recordAudio, loadAudio } from 'https://unpkg.com/lip-sync-js@latest/dist/index.mjs';

  const lipSync = LipSync.getInstance();
  await lipSync.init({
    wasmPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.wasm',
    dataPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.data',
    jsPath: 'https://unpkg.com/lip-sync-js@latest/dist/wasm/lip-sync.js'
  });
</script>
```

### Option 2: Self-hosted

1. Install the package: `npm install lip-sync-js`
2. Copy WASM files to your public directory:
   ```bash
   cp node_modules/lip-sync-js/dist/wasm/* public/wasm/
   ```
3. Import and configure:
   ```javascript
   import { LipSync } from 'lip-sync-js';

   const lipSync = LipSync.getInstance();
   await lipSync.init({
     wasmPath: '/wasm/lip-sync.wasm',
     dataPath: '/wasm/lip-sync.data',
     jsPath: '/wasm/lip-sync.js'
   });
   ```

### Option 3: Using a Bundler (Vite, Webpack, etc.)

See the React, Vue, or Svelte examples for bundler-based setups.

## How It Works

### 1. Import the library
```javascript
import { LipSync, recordAudio, loadAudio } from 'lip-sync-js';
```

### 2. Initialize LipSync
```javascript
const lipSync = LipSync.getInstance();
await lipSync.init();
```

### 3. Get Audio Data
- Record from microphone: `const { pcm16, audioBuffer } = await recordAudio(5000);`
- Load from file: `const { pcm16, audioBuffer } = await loadAudio(file);`

### 4. Analyze
```javascript
const result = await lipSync.analyze(pcm16, {
  dialogText: "Hello world",
  sampleRate: 16000
});
```

### 5. Animate Visemes
```javascript
function playAnimation(mouthCues, audioBuffer) {
  const audioContext = new AudioContext();
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start(0);

  // Update viseme images frame by frame
  function updateViseme() {
    const elapsed = audioContext.currentTime - startTime;
    // Find current viseme based on elapsed time
    setViseme(mouthCues[currentCueIndex].value);
    requestAnimationFrame(updateViseme);
  }
}
```

### 6. Display Results
- Show mouth cues timeline with timestamps
- Animate visemes synchronized with audio playback
- Display color-coded logs with timestamps

## Viseme Images

The example uses 9 viseme PNG images (X, A, B, C, D, E, F, G, H) stored in `../assets/visemes/`. All images are stacked with absolute positioning and opacity-based switching for instant transitions.

## Logging

The example includes comprehensive logging with:
- **Info** (blue): General information
- **Success** (green): Successful operations
- **Warning** (yellow): Warnings
- **Error** (red): Errors

All logs include timestamps in 12-hour format.

## Browser Requirements

- Modern browser with ES6 module support
- WebAssembly support
- Web Audio API support
- MediaDevices API (for microphone access)

## Tips

1. **Improve Accuracy**: Always provide dialog text when you know what will be spoken
2. **Audio Quality**: Clear audio with minimal background noise works best
3. **Browser Permissions**: Grant microphone access when prompted
4. **File Formats**: Supports MP3, WAV, OGG, and other browser-supported formats
5. **CDN Versions**: For production, pin to a specific version (e.g., `@1.0.0`) instead of `@latest`
