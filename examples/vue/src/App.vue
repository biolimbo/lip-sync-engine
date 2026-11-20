<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue';
import { recordAudio, loadAudio } from 'lip-sync-engine';
import type { MouthCue } from 'lip-sync-engine';
import { useLipSyncEngine } from './composables/useLipSyncEngine';
import type { ExecutionMode } from './composables/useLipSyncEngine';

interface LogEntry {
  message: string;
  type: 'info' | 'error' | 'success';
  timestamp: string;
}

const {
  analyze,
  result,
  isAnalyzing,
  isInitialized,
  initError,
  error,
  metrics,
  reset,
  mode,
  setMode,
  chunkSize,
  setChunkSize,
  recordingDuration,
  setRecordingDuration
} = useLipSyncEngine();

const dialogText = ref('');
const isRecording = ref(false);
const currentViseme = ref('X');
const isPlaying = ref(false);
const audioBuffer = ref<AudioBuffer | null>(null);
const logs = ref<LogEntry[]>([]);
const logsEnd = ref<HTMLElement | null>(null);
const isBusy = computed(() => isAnalyzing.value || isRecording.value);
// Recording and loading need a started mode; switching modes stays possible
const canAnalyze = computed(() => !isBusy.value && !initError.value);
// One AudioContext for all playback, closed on unmount
let audioContext: AudioContext | null = null;
let audioSource: AudioBufferSourceNode | null = null;
let animationFrame: number | null = null;

const modes: { id: ExecutionMode; name: string; description: string }[] = [
  { id: 'single', name: 'Single Thread', description: 'Main thread (blocks the UI)' },
  { id: 'worker', name: 'Web Worker', description: 'One worker (the UI stays responsive)' },
  { id: 'chunked', name: 'Chunked', description: 'Splits audio across up to 4 workers' },
  { id: 'streaming', name: 'Streaming', description: 'Chunks with 500 ms context and lookahead' },
];

const modeName = (m: ExecutionMode): string => modes.find((entry) => entry.id === m)?.name ?? m;

const visemes = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const visemeNames: Record<string, string> = {
  A: 'Closed (M, B, P)',
  B: 'Clenched teeth',
  C: 'Open',
  D: 'Wide open',
  E: 'Rounded',
  F: 'Puckered',
  G: 'F/V (upper teeth on lower lip)',
  H: 'L (tongue raised)',
  X: 'Idle',
};

// The library keeps a failed WASM load, so Single Thread needs a reload. A
// worker pool that failed to start tries again when a worker mode is selected.
const initErrorMessage = computed(() => {
  if (!initError.value) return '';
  const message = initError.value.message.replace(/\.+$/, '');
  return mode.value === 'single'
    ? `${message}. Reload the page to retry.`
    : `${message}. Switch modes or reload the page to retry.`;
});

const statusText = computed(() => {
  if (isRecording.value) return 'Recording. Speak now.';
  if (isAnalyzing.value) return 'Analyzing audio...';
  if (initError.value) return 'Failed to initialize';
  if (!isInitialized.value) return 'Initializing...';
  return 'Ready to analyze audio';
});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const addLog = (message: string, type: LogEntry['type'] = 'info') => {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = (hours % 12 || 12).toString();
  const timestamp = `[${displayHours}:${minutes}:${seconds} ${ampm}]`;

  logs.value.push({ message, type, timestamp });
  nextTick(() => {
    logsEnd.value?.scrollIntoView({ behavior: 'smooth' });
  });
};

// Log each mode's startup and its outcome
watch(mode, (m) => addLog(`Initializing ${modeName(m)}...`), { immediate: true });
watch(isInitialized, (ready) => {
  if (ready) addLog(`${modeName(mode.value)} ready`, 'success');
});
watch(initErrorMessage, (message) => {
  if (message) addLog(`Failed to initialize ${modeName(mode.value)}: ${message}`, 'error');
});

const stopPlayback = () => {
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  if (audioSource) {
    audioSource.onended = null;
    audioSource.stop();
    audioSource = null;
  }
  currentViseme.value = 'X';
  isPlaying.value = false;
};

onUnmounted(() => {
  stopPlayback();
  audioContext?.close();
  audioContext = null;
});

const playAnimation = (mouthCues: MouthCue[], buffer: AudioBuffer) => {
  stopPlayback();

  if (!audioContext) audioContext = new AudioContext();
  const ctx = audioContext;
  void ctx.resume();

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  audioSource = source;

  const startTime = ctx.currentTime;
  source.start();
  isPlaying.value = true;

  let currentCueIndex = 0;

  const updateViseme = () => {
    const elapsed = ctx.currentTime - startTime;

    while (currentCueIndex < mouthCues.length && mouthCues[currentCueIndex].end < elapsed) {
      currentCueIndex++;
    }

    if (currentCueIndex < mouthCues.length) {
      currentViseme.value = mouthCues[currentCueIndex].value;
      animationFrame = requestAnimationFrame(updateViseme);
    } else {
      currentViseme.value = 'X';
      animationFrame = null;
    }
  };

  updateViseme();

  source.onended = () => {
    audioSource = null;
    currentViseme.value = 'X';
    isPlaying.value = false;
  };
};

/** Analyze decoded audio in the selected mode and log the outcome */
const runAnalysis = async (pcm16: Int16Array) => {
  const text = dialogText.value.trim();
  const name = modeName(mode.value);
  addLog(text ? `Analyzing with dialog text "${text}" (${name})...` : `Analyzing (${name})...`);

  try {
    await analyze(pcm16, { dialogText: text || undefined, sampleRate: 16000 });
    const m = metrics.value;
    if (m) addLog(`Analyzed in ${Math.round(m.executionTime)} ms: ${m.cuesCount} cues (${name})`, 'success');
  } catch (err) {
    // A startup failure is already logged by the initError watcher
    if (err !== initError.value) addLog(`Analysis failed: ${errorMessage(err)}`, 'error');
  }
};

const handleRecord = async () => {
  stopPlayback();
  reset();
  audioBuffer.value = null;

  let pcm16: Int16Array;
  isRecording.value = true;
  try {
    addLog(`Recording ${recordingDuration.value} s (allow microphone access if asked)...`);
    const recording = await recordAudio(recordingDuration.value * 1000);
    pcm16 = recording.pcm16;
    audioBuffer.value = recording.audioBuffer;
    addLog(`Recorded ${(pcm16.length / 16000).toFixed(2)} s`, 'success');
  } catch (err) {
    addLog(`Recording failed: ${errorMessage(err)}`, 'error');
    return;
  } finally {
    isRecording.value = false;
  }

  await runAnalysis(pcm16);
};

const handleFileUpload = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = ''; // allow loading the same file again
  if (!file) return;

  stopPlayback();
  reset();
  audioBuffer.value = null;

  let pcm16: Int16Array;
  try {
    addLog(`Loading ${file.name} (${(file.size / 1024).toFixed(2)} KB)...`);
    const decoded = await loadAudio(file);
    pcm16 = decoded.pcm16;
    audioBuffer.value = decoded.audioBuffer;
    addLog(`Decoded ${(pcm16.length / 16000).toFixed(2)} s`, 'success');
  } catch (err) {
    addLog(`File load failed: ${errorMessage(err)}`, 'error');
    return;
  }

  await runAnalysis(pcm16);
};

const handlePlay = () => {
  if (result.value && audioBuffer.value) {
    playAnimation(result.value.mouthCues, audioBuffer.value);
  }
};

const handleModeChange = (newMode: ExecutionMode) => {
  if (newMode !== mode.value) setMode(newMode);
};

watch(result, (newResult) => {
  if (newResult && audioBuffer.value) {
    playAnimation(newResult.mouthCues, audioBuffer.value);
  }
});
</script>

<template>
  <div class="app">
    <div class="container">
      <h1>lip-sync-engine</h1>
      <p class="subtitle">Vue example with all four execution modes</p>

      <!-- Mode Selector -->
      <div class="mode-selector">
        <h3>Execution Mode</h3>
        <div class="mode-buttons">
          <button
            v-for="m in modes"
            :key="m.id"
            :class="['mode-btn', { active: mode === m.id }]"
            @click="() => handleModeChange(m.id)"
            :disabled="isBusy"
          >
            <div class="mode-title">{{ m.name }}</div>
            <div class="mode-desc">{{ m.description }}</div>
          </button>
        </div>
      </div>

      <!-- Recording Duration Slider -->
      <div class="chunk-settings">
        <label for="recordingDuration">
          Recording Duration: {{ recordingDuration }} s
        </label>
        <input
          id="recordingDuration"
          type="range"
          min="5"
          max="60"
          step="5"
          :value="recordingDuration"
          @input="(e) => setRecordingDuration(Number((e.target as HTMLInputElement).value))"
          :disabled="isBusy"
        />
        <small>5 to 60 seconds</small>
      </div>

      <!-- Chunk Settings: only in chunked or streaming mode -->
      <div v-if="mode === 'chunked' || mode === 'streaming'" class="chunk-settings">
        <label for="chunkSize">
          Chunk Size: {{ chunkSize }} s
        </label>
        <input
          id="chunkSize"
          type="range"
          min="1"
          max="10"
          step="1"
          :value="chunkSize"
          @input="(e) => setChunkSize(Number((e.target as HTMLInputElement).value))"
          :disabled="isBusy"
        />
        <small>
          {{ mode === 'chunked'
            ? 'Chunks are analyzed alone: smaller chunks run more in parallel but lose accuracy at the edges'
            : 'Each chunk is analyzed with 500 ms of audio before and after it' }}
        </small>
      </div>

      <div class="input-group">
        <label for="dialogText">Dialog Text (optional, improves accuracy)</label>
        <input
          id="dialogText"
          v-model="dialogText"
          type="text"
          placeholder="Enter the text that will be spoken..."
          :disabled="isBusy"
        />
      </div>

      <div class="controls">
        <button
          @click="handleRecord"
          :disabled="!canAnalyze"
          class="btn"
        >
          {{ isRecording ? 'Recording...' : `Record Audio (${recordingDuration} s)` }}
        </button>
        <label :class="['btn', { disabled: !canAnalyze }]" :aria-disabled="!canAnalyze">
          Load Audio File
          <input
            type="file"
            accept="audio/*"
            @change="handleFileUpload"
            :disabled="!canAnalyze"
            style="display: none"
          />
        </label>
      </div>

      <div :class="['status', { recording: isRecording, analyzing: isAnalyzing || (!isInitialized && !initError), failed: !!initError && !isBusy }]">
        {{ statusText }}
      </div>

      <!-- Performance Metrics -->
      <div v-if="metrics" class="metrics">
        <h3>Performance Metrics</h3>
        <div class="metrics-grid">
          <div class="metric">
            <div class="metric-label">Execution Time</div>
            <div class="metric-value">{{ Math.round(metrics.executionTime) }} ms</div>
          </div>
          <div class="metric">
            <div class="metric-label">Mouth Cues</div>
            <div class="metric-value">{{ metrics.cuesCount }}</div>
          </div>
          <div v-if="metrics.workersUsed !== undefined" class="metric">
            <div class="metric-label">Workers Used</div>
            <div class="metric-value">{{ metrics.workersUsed }}</div>
          </div>
          <div v-if="metrics.chunksProcessed !== undefined" class="metric">
            <div class="metric-label">Chunks Processed</div>
            <div class="metric-value">{{ metrics.chunksProcessed }}</div>
          </div>
        </div>
      </div>

      <div class="viseme-display">
        <div>
          <div class="viseme-images">
            <img
              v-for="viseme in visemes"
              :key="viseme"
              :src="`/visemes/${viseme}.png`"
              :alt="viseme"
              :class="{ active: currentViseme === viseme }"
            />
          </div>
          <div class="viseme-label">
            {{ currentViseme }}: {{ visemeNames[currentViseme] }}
          </div>
        </div>
      </div>

      <div v-if="result" class="results">
        <div class="results-header">
          <h3>Lip Sync Results</h3>
          <button
            class="play-btn"
            @click="isPlaying ? stopPlayback() : handlePlay()"
            :disabled="!audioBuffer"
          >
            {{ isPlaying ? 'Stop' : 'Play' }}
          </button>
        </div>
        <div class="cues-list">
          <div
            v-for="(cue, index) in result.mouthCues"
            :key="index"
            class="cue"
          >
            <span class="cue-time">
              {{ cue.start.toFixed(2) }} s to {{ cue.end.toFixed(2) }} s
            </span>
            <span class="cue-value">{{ cue.value }}</span>
          </div>
        </div>
      </div>

      <div v-if="initError" class="error">
        {{ initErrorMessage }}
      </div>
      <div v-if="error" class="error">
        Error: {{ error.message }}
      </div>

      <div class="logs">
        <h3>Logs</h3>
        <div class="logs-content">
          <div
            v-for="(log, index) in logs"
            :key="index"
            :class="['log-entry', log.type]"
          >
            {{ log.timestamp }} {{ log.message }}
          </div>
          <div ref="logsEnd"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.container {
  background: #1a1a1a;
  border-radius: 16px;
  padding: 40px;
  max-width: 900px;
  width: 100%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  border: 1px solid #2a2a2a;
}

h1 {
  color: #ffffff;
  margin-bottom: 8px;
  font-size: 2em;
  font-weight: 700;
}

.subtitle {
  color: #888;
  margin-bottom: 32px;
  font-size: 0.95em;
}

.mode-selector {
  margin-bottom: 32px;
}

.mode-selector h3 {
  color: #ffffff;
  font-size: 1.1em;
  font-weight: 600;
  margin-bottom: 16px;
}

.mode-buttons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.mode-btn {
  background: #0f0f0f;
  border: 2px solid #2a2a2a;
  border-radius: 10px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
}

.mode-btn:hover:not(:disabled) {
  border-color: #4a9eff;
  background: #1a1a1a;
  transform: translateY(-2px);
}

.mode-btn.active {
  border-color: #4a9eff;
  background: #1a2330;
}

.mode-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mode-title {
  color: #ffffff;
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 6px;
}

.mode-desc {
  color: #888;
  font-size: 12px;
  line-height: 1.4;
}

.chunk-settings {
  background: #0f0f0f;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  padding: 20px;
  margin-bottom: 24px;
}

.chunk-settings label {
  display: block;
  color: #b0b0b0;
  font-weight: 500;
  margin-bottom: 12px;
  font-size: 0.9em;
}

.chunk-settings input[type="range"] {
  width: 100%;
  margin-bottom: 8px;
}

.chunk-settings small {
  color: #666;
  font-size: 12px;
}

.metrics {
  background: #0f0f0f;
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
}

.metrics h3 {
  color: #ffffff;
  font-size: 1.1em;
  font-weight: 600;
  margin-bottom: 16px;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
}

.metric {
  background: #1a1a1a;
  border-radius: 8px;
  padding: 16px;
  text-align: center;
}

.metric-label {
  color: #888;
  font-size: 12px;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.metric-value {
  color: #4a9eff;
  font-size: 24px;
  font-weight: 700;
  font-family: 'SF Mono', Monaco, monospace;
}

.input-group {
  margin-bottom: 24px;
}

.input-group label {
  display: block;
  color: #b0b0b0;
  font-weight: 500;
  margin-bottom: 8px;
  font-size: 0.9em;
}

input[type="text"] {
  width: 100%;
  padding: 12px 16px;
  background: #0f0f0f;
  border: 1px solid #333;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 15px;
  transition: border-color 0.2s, background 0.2s;
}

input[type="text"]:focus {
  outline: none;
  border-color: #4a9eff;
  background: #141414;
}

input[type="text"]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.controls {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.btn {
  background: #4a9eff;
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
  flex: 1;
  min-width: 140px;
  text-align: center;
}

.btn:hover:not(:disabled):not(.disabled) {
  background: #3a8eef;
  transform: translateY(-1px);
}

.btn:active:not(:disabled):not(.disabled) {
  transform: translateY(0);
}

.btn:disabled,
.btn.disabled {
  background: #2a2a2a;
  color: #666;
  cursor: not-allowed;
}

.status {
  background: #0f0f0f;
  padding: 14px 18px;
  border-radius: 8px;
  margin-bottom: 24px;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 13px;
  color: #888;
  border: 1px solid #2a2a2a;
}

.status.recording {
  background: #2a1a1a;
  color: #ff6b6b;
  border-color: #4a2a2a;
}

.status.analyzing {
  background: #1a2330;
  color: #4a9eff;
  border-color: #2a3a4a;
}

.status.failed {
  background: #2a1a1a;
  color: #ff6b6b;
  border-color: #4a2a2a;
}

.viseme-display {
  background: #0f0f0f;
  border-radius: 12px;
  padding: 40px;
  margin-bottom: 24px;
  border: 1px solid #2a2a2a;
  position: relative;
  min-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.viseme-images {
  position: relative;
  width: 200px;
  height: 200px;
}

.viseme-images img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  object-fit: contain;
}

.viseme-images img.active {
  opacity: 1;
}

.viseme-label {
  text-align: center;
  margin-top: 16px;
  font-size: 14px;
  color: #888;
  font-weight: 500;
}

.results {
  background: #0f0f0f;
  border-radius: 12px;
  padding: 24px;
  border: 1px solid #2a2a2a;
}

.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.results h3 {
  color: #ffffff;
  font-size: 1.1em;
  font-weight: 600;
  margin: 0;
}

.play-btn {
  background: #51cf66;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
  min-width: auto;
  flex: none;
}

.play-btn:hover:not(:disabled) {
  background: #40c057;
  transform: translateY(-1px);
}

.play-btn:disabled {
  background: #2a2a2a;
  color: #666;
  cursor: not-allowed;
}

.cues-list {
  max-height: 300px;
  overflow-y: auto;
}

.cues-list::-webkit-scrollbar {
  width: 8px;
}

.cues-list::-webkit-scrollbar-track {
  background: #1a1a1a;
  border-radius: 4px;
}

.cues-list::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 4px;
}

.cues-list::-webkit-scrollbar-thumb:hover {
  background: #444;
}

.cue {
  background: #1a1a1a;
  padding: 12px 16px;
  border-radius: 6px;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-left: 3px solid #4a9eff;
}

.cue-time {
  color: #888;
  font-size: 13px;
  font-family: 'SF Mono', Monaco, monospace;
}

.cue-value {
  font-weight: 700;
  color: #4a9eff;
  font-size: 18px;
  font-family: 'SF Mono', Monaco, monospace;
}

.error {
  background: #2a1a1a;
  color: #ff6b6b;
  padding: 14px 18px;
  border-radius: 8px;
  margin-top: 16px;
  border: 1px solid #4a2a2a;
  font-size: 14px;
}

.logs {
  margin-top: 32px;
}

.logs-content {
  background: #0f0f0f;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  padding: 15px;
  margin-top: 16px;
  max-height: 300px;
  overflow-y: auto;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #888;
}

.log-entry.info {
  color: #4a9eff;
}

.log-entry.error {
  color: #ff6b6b;
}

.log-entry.success {
  color: #51cf66;
}

.logs-content::-webkit-scrollbar {
  width: 8px;
}

.logs-content::-webkit-scrollbar-track {
  background: #000;
  border-radius: 4px;
}

.logs-content::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 4px;
}

.logs-content::-webkit-scrollbar-thumb:hover {
  background: #444;
}
</style>
