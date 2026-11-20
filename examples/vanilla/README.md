# Vanilla JavaScript Example

Complete vanilla JavaScript example demonstrating LipSyncEngine.js with real-time viseme playback and a dark mode UI.

The page loads the published package from the unpkg.com CDN (pinned to `1.1.0`), so it needs no build step.

## Running

Serve the `examples/` folder (the page loads images from `../assets/visemes/`) with any static file server:

```bash
# From examples/
python3 -m http.server 8000
# Open http://localhost:8000/vanilla/
```

Opening `index.html` straight from disk (`file://`) does not work: browsers block module scripts and Web Workers there.

### Testing a local build

To use the library built in this repository (`dist/`) instead of the CDN, serve the repository root and add `?local` to the URL:

```bash
# From the repository root, after `npm run build`
python3 -m http.server 8000
# Open http://localhost:8000/examples/vanilla/?local
```

If your server sends `.mjs` files with the wrong MIME type (older Python versions do), use another static server such as `npx http-server`.

## Features

- 🎙️ **Record Audio** - Record from microphone with adjustable duration (5-60 seconds)
- 📁 **Load Audio File** - Load any audio file (MP3, WAV, etc.)
- 📝 **Dialog Text Input** - Provide optional text for better accuracy
- ⚡ **Three Execution Modes**:
  - Single Thread - Runs on the main thread (blocks the UI)
  - Web Worker - Non-blocking, one worker
  - Chunked Workers - Splits the audio and analyses the chunks in parallel
- 📊 **Performance Metrics** - View execution time, cue count, and worker usage
- 🎛️ **Adjustable Settings** - Control recording duration and chunk size
- 🎭 **Real-time Viseme Display** - Animated mouth shapes using PNG images with opacity-based switching
- ▶️ **Replay Button** - Play back animations on demand
- 📋 **Results Timeline** - View all detected mouth cues with timestamps

## Using the Library in Your Own Page

### Option 1: CDN (unpkg.com)

Pin the version in every URL. With no paths, `init()` loads the WASM files and the worker script from unpkg at the same version as the imported library.

```html
<script type="module">
  import { LipSyncEngine, WorkerPool, loadAudio } from 'https://unpkg.com/lip-sync-engine@1.1.0/dist/index.mjs';

  // Main thread
  const lipSyncEngine = LipSyncEngine.getInstance();
  await lipSyncEngine.init();

  // Or in Web Workers (recommended for anything longer than a few seconds)
  const pool = WorkerPool.getInstance(2);
  await pool.init();
</script>
```

### Option 2: Self-hosted

1. Install the package: `npm install lip-sync-engine`
2. Copy the files to your public directory:
   ```bash
   mkdir -p public/lip-sync-engine
   cp -r node_modules/lip-sync-engine/dist/* public/lip-sync-engine/
   ```
3. Import and configure. Use absolute URLs: workers resolve relative paths against the worker script, not the page.
   ```javascript
   import { LipSyncEngine, WorkerPool } from '/lip-sync-engine/index.mjs';

   const base = new URL('/lip-sync-engine/', location.href).href;
   const paths = {
     wasmPath: `${base}wasm/lip-sync-engine.wasm`,
     dataPath: `${base}wasm/lip-sync-engine.data`,
     jsPath: `${base}wasm/lip-sync-engine.js`
   };

   await LipSyncEngine.getInstance().init(paths);
   await WorkerPool.getInstance(2).init({ ...paths, workerScriptUrl: `${base}worker.js` });
   ```

### Option 3: Using a Bundler (Vite, Webpack, etc.)

See the React, Vue, or Svelte examples for bundler-based setups.

## How It Works

### 1. Initialize once, keep alive

```javascript
const lipSyncEngine = LipSyncEngine.getInstance();
await lipSyncEngine.init();

const pool = WorkerPool.getInstance(4);
await pool.init();      // starts one worker
await pool.warmup();    // optional: start the other workers now
```

Since 1.1.0 each worker keeps its speech decoder between calls. Create the pool once and reuse it for every analysis; destroying and re-creating it per analysis pays the start-up cost each time. Call `pool.destroy()` only when the page no longer needs lip sync.

### 2. Get audio data

- Record from microphone: `const { pcm16, audioBuffer } = await recordAudio(5000);`
- Load from file: `const { pcm16, audioBuffer } = await loadAudio(file);`

Both return mono 16 kHz Int16 PCM, which is what `sampleRate: 16000` below describes.

### 3. Analyze

```javascript
const result = await pool.analyze(pcm16, {
  dialogText: 'Hello world',
  sampleRate: 16000
});
```

Chunked mode uses `pool.analyzeChunks(chunks, options)`. Each chunk is analysed on its own, so cues near chunk edges are less accurate; that is fine for chunks of a few seconds. For short chunks from a live stream use `pool.createStreamAnalyzer({ sampleRate: 16000, contextMs: 500, lookaheadMs: 500 })`; see [`../stream-example.ts`](../stream-example.ts).

### 4. Animate visemes

```javascript
const audioContext = new AudioContext(); // create once, reuse for every playback

function playAnimation(mouthCues, audioBuffer) {
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  const startTime = audioContext.currentTime;
  source.start();

  let i = 0;
  function update() {
    const elapsed = audioContext.currentTime - startTime;
    while (i < mouthCues.length && mouthCues[i].end < elapsed) i++;
    if (i < mouthCues.length) {
      setViseme(mouthCues[i].value);
      requestAnimationFrame(update);
    } else {
      setViseme('X');
    }
  }
  update();
}
```

## Viseme Images

The example uses 9 viseme PNG images (X, A, B, C, D, E, F, G, H) stored in `../assets/visemes/`. All images are stacked with absolute positioning and opacity-based switching for instant transitions.

## Browser Requirements

- Modern browser with ES module support
- WebAssembly support
- Web Audio API support
- MediaDevices API (for microphone access)

## Tips

1. **Improve Accuracy**: Provide dialog text when you know what will be spoken
2. **Audio Quality**: Clear audio with little background noise works best
3. **Browser Permissions**: Grant microphone access when prompted
4. **File Formats**: Supports MP3, WAV, OGG, and other browser-supported formats
5. **CDN Versions**: Pin a specific version (for example `@1.1.0`) instead of `@latest`
