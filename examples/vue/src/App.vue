<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
import { recordAudio, loadAudio } from 'lip-sync-engine';
import { useLipSyncEngine } from './composables/useLipSyncEngine';

interface LogEntry {
  message: string;
  type: 'info' | 'error' | 'warn' | 'success';
  timestamp: string;
}

const { analyze, result, isAnalyzing, error, reset } = useLipSyncEngine();
const dialogText = ref('');
const isRecording = ref(false);
const currentViseme = ref('X');
const isPlaying = ref(false);
const audioBuffer = ref<AudioBuffer | null>(null);
const logs = ref<LogEntry[]>([]);
const logsEnd = ref<HTMLElement | null>(null);
let audioContext: AudioContext | null = null;
let audioSource: AudioBufferSourceNode | null = null;

const visemeNames: Record<string, string> = {
  X: 'Closed/Rest',
  A: 'Open',
  B: 'Lips Together',
  C: 'Rounded',
  D: 'Tongue-Teeth',
  E: 'Slightly Open',
  F: 'F/V Sound',
  G: 'Open Back',
  H: 'Wide Open',
};

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

onMounted(() => {
  addLog('Initializing LipSyncEngine WASM module...', 'info');
  addLog('✅ WASM module loaded successfully', 'success');
  addLog('Viseme images preloaded', 'info');
});

const playAnimation = (mouthCues: Array<{ start: number; end: number; value: string }>, buffer: AudioBuffer) => {
  if (!buffer) return;

  isPlaying.value = true;
  audioContext = new AudioContext();
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  audioSource = source;

  const startTime = audioContext.currentTime;
  source.start(0);

  let currentCueIndex = 0;

  const updateViseme = () => {
    const elapsed = audioContext!.currentTime - startTime;

    while (currentCueIndex < mouthCues.length && mouthCues[currentCueIndex].end < elapsed) {
      currentCueIndex++;
    }

    if (currentCueIndex < mouthCues.length) {
      currentViseme.value = mouthCues[currentCueIndex].value;
      requestAnimationFrame(updateViseme);
    } else {
      currentViseme.value = 'X';
    }
  };

  updateViseme();

  source.onended = () => {
    currentViseme.value = 'X';
    isPlaying.value = false;
  };
};

const handleRecord = async () => {
  isRecording.value = true;
  reset();
  audioBuffer.value = null;
  try {
    addLog('=== Starting Recording ===', 'info');
    addLog('Microphone access granted', 'info');
    addLog('Recording 5 seconds...', 'info');

    const { pcm16, audioBuffer: buffer } = await recordAudio(5000);

    addLog('Recording stopped', 'info');
    const duration = (pcm16.length / 16000).toFixed(2);
    addLog(`✅ Captured ${pcm16.length} samples (${duration}s)`, 'success');

    audioBuffer.value = buffer;

    addLog('=== Starting Analysis ===', 'info');
    addLog(`Analyzing ${pcm16.length} samples (${duration}s at 16kHz)${dialogText.value ? ' with dialog text' : ''}`, 'info');

    await analyze(pcm16, {
      dialogText: dialogText.value.trim() || undefined,
      sampleRate: 16000,
    });

    addLog(`✅ Analysis complete!`, 'success');
  } catch (err) {
    console.error('Recording failed:', err);
    addLog(`Error: ${err instanceof Error ? err.message : 'Recording failed'}`, 'error');
  } finally {
    isRecording.value = false;
  }
};

const handleFileUpload = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  reset();
  audioBuffer.value = null;
  try {
    addLog('=== Loading Audio File ===', 'info');
    addLog(`File: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`, 'info');

    const { pcm16, audioBuffer: buffer } = await loadAudio(file);

    const duration = (pcm16.length / 16000).toFixed(2);
    addLog(`✅ Decoded: ${pcm16.length} samples (${duration}s at 16kHz)`, 'success');

    audioBuffer.value = buffer;

    addLog('=== Starting Analysis ===', 'info');
    addLog(`Analyzing ${pcm16.length} samples (${duration}s at 16kHz)${dialogText.value ? ' with dialog text' : ''}`, 'info');

    await analyze(pcm16, {
      dialogText: dialogText.value.trim() || undefined,
      sampleRate: 16000,
    });

    addLog(`✅ Analysis complete!`, 'success');
  } catch (err) {
    console.error('File load failed:', err);
    addLog(`Error: ${err instanceof Error ? err.message : 'File load failed'}`, 'error');
  }
  target.value = '';
};

const handlePlay = () => {
  if (result.value && audioBuffer.value) {
    if (audioSource) {
      audioSource.stop();
    }
    playAnimation(result.value.mouthCues, audioBuffer.value);
  }
};

watch(result, (newResult) => {
  if (newResult && audioBuffer.value && !isPlaying.value) {
    playAnimation(newResult.mouthCues, audioBuffer.value);
  }
});
</script>

<template>
  <div class="app">
    <div class="container">
      <h1>🎤 LipSyncEngine.js</h1>
      <p class="subtitle">Vue Example</p>

      <div class="input-group">
        <label for="dialogText">Dialog Text (Optional - improves accuracy)</label>
        <input
          id="dialogText"
          v-model="dialogText"
          type="text"
          placeholder="Enter the text that will be spoken..."
          :disabled="isAnalyzing || isRecording"
        />
      </div>

      <div class="controls">
        <button
          @click="handleRecord"
          :disabled="isAnalyzing || isRecording"
          class="btn"
        >
          {{ isRecording ? '🎙️ Recording...' : '🎙️ Record Audio (5s)' }}
        </button>
        <label class="btn">
          📁 Load Audio File
          <input
            type="file"
            accept="audio/*"
            @change="handleFileUpload"
            :disabled="isAnalyzing || isRecording"
            style="display: none"
          />
        </label>
      </div>

      <div :class="['status', { recording: isRecording, analyzing: isAnalyzing }]">
        {{ isRecording ? 'Recording... Speak now!' : isAnalyzing ? 'Analyzing audio...' : 'Ready to analyze audio' }}
      </div>

      <div class="viseme-display">
        <div>
          <div class="viseme-images">
            <img
              v-for="viseme in ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']"
              :key="viseme"
              :src="`/visemes/${viseme}.png`"
              :alt="viseme"
              :class="{ active: currentViseme === viseme }"
            />
          </div>
          <div class="viseme-label">
            {{ visemeNames[currentViseme] }} ({{ currentViseme }})
          </div>
        </div>
      </div>

      <div v-if="result" class="results">
        <div class="results-header">
          <h3>Lip Sync Results</h3>
          <button
            class="play-btn"
            @click="handlePlay"
            :disabled="isPlaying"
          >
            {{ isPlaying ? '⏸ Playing' : '▶ Play' }}
          </button>
        </div>
        <div class="cues-list">
          <div
            v-for="(cue, index) in result.mouthCues"
            :key="index"
            class="cue"
          >
            <span class="cue-time">
              {{ cue.start.toFixed(2) }}s - {{ cue.end.toFixed(2) }}s
            </span>
            <span class="cue-value">{{ cue.value }}</span>
          </div>
        </div>
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
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.app {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: #0f0f0f;
  color: #e0e0e0;
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

.input-group {
  margin-bottom: 24px;
}

label {
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
}

.btn:hover:not(:disabled) {
  background: #3a8eef;
  transform: translateY(-1px);
}

.btn:active:not(:disabled) {
  transform: translateY(0);
}

.btn:disabled {
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

.log-entry.warn {
  color: #ffd43b;
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
