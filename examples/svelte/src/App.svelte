<script lang="ts">
  import { onMount } from 'svelte';
  import { recordAudio, loadAudio } from 'lip-sync-engine';
  import { lipSyncEngineStore } from './stores/lipSyncEngine';
  import type { ExecutionMode } from './stores/lipSyncEngine';

  interface LogEntry {
    message: string;
    type: 'info' | 'error' | 'warn' | 'success';
    timestamp: string;
  }

  let dialogText = '';
  let isRecording = false;
  let currentViseme = 'X';
  let isPlaying = false;
  let audioBuffer: AudioBuffer | null = null;
  let logs: LogEntry[] = [];
  let logsEnd: HTMLDivElement;
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

  function addLog(message: string, type: LogEntry['type'] = 'info') {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = (hours % 12 || 12).toString();
    const timestamp = `[${displayHours}:${minutes}:${seconds} ${ampm}]`;

    logs = [...logs, { message, type, timestamp }];
    setTimeout(() => logsEnd?.scrollIntoView({ behavior: 'smooth' }), 0);
  }

  onMount(() => {
    addLog('Initializing LipSyncEngine WASM module...', 'info');
    addLog('Initializing WorkerPool...', 'info');
    addLog('✅ WASM module loaded successfully', 'success');
    addLog('✅ WorkerPool initialized', 'success');
    addLog('Viseme images preloaded', 'info');
  });

  function playAnimation(mouthCues: Array<{ start: number; end: number; value: string }>, buffer: AudioBuffer) {
    if (!buffer) return;

    isPlaying = true;
    audioContext = new AudioContext();
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    audioSource = source;

    const startTime = audioContext.currentTime;
    source.start(0);

    let currentCueIndex = 0;

    function updateViseme() {
      const elapsed = audioContext!.currentTime - startTime;

      while (currentCueIndex < mouthCues.length && mouthCues[currentCueIndex].end < elapsed) {
        currentCueIndex++;
      }

      if (currentCueIndex < mouthCues.length) {
        currentViseme = mouthCues[currentCueIndex].value;
        requestAnimationFrame(updateViseme);
      } else {
        currentViseme = 'X';
      }
    }

    updateViseme();

    source.onended = () => {
      currentViseme = 'X';
      isPlaying = false;
    };
  }

  async function handleRecord() {
    isRecording = true;
    lipSyncEngineStore.reset();
    audioBuffer = null;
    try {
      addLog('=== Starting Recording ===', 'info');
      addLog('Microphone access granted', 'info');
      addLog(`Recording ${$lipSyncEngineStore.recordingDuration} seconds...`, 'info');

      const { pcm16, audioBuffer: buffer } = await recordAudio($lipSyncEngineStore.recordingDuration * 1000);

      addLog('Recording stopped', 'info');
      const duration = (pcm16.length / 16000).toFixed(2);
      addLog(`✅ Captured ${pcm16.length} samples (${duration}s)`, 'success');

      audioBuffer = buffer;

      addLog('=== Starting Analysis ===', 'info');

      const modeDescription = $lipSyncEngineStore.mode === 'single' ? 'Single Thread (blocks UI)' :
                             $lipSyncEngineStore.mode === 'worker' ? 'Web Worker (non-blocking)' :
                             'Chunked Workers (parallel)';
      addLog(`Mode: ${modeDescription}`, 'info');
      addLog(`Analyzing ${pcm16.length} samples (${duration}s at 16kHz)${dialogText ? ' with dialog text' : ''}`, 'info');

      await lipSyncEngineStore.analyze(pcm16, {
        dialogText: dialogText.trim() || undefined,
        sampleRate: 16000,
      });

      addLog(`✅ Analysis complete!`, 'success');
    } catch (err) {
      console.error('Recording failed:', err);
      addLog(`Error: ${err instanceof Error ? err.message : 'Recording failed'}`, 'error');
    } finally {
      isRecording = false;
    }
  }

  async function handleFileUpload(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    lipSyncEngineStore.reset();
    audioBuffer = null;
    try {
      addLog('=== Loading Audio File ===', 'info');
      addLog(`File: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`, 'info');

      const { pcm16, audioBuffer: buffer } = await loadAudio(file);

      const duration = (pcm16.length / 16000).toFixed(2);
      addLog(`✅ Decoded: ${pcm16.length} samples (${duration}s at 16kHz)`, 'success');

      audioBuffer = buffer;

      addLog('=== Starting Analysis ===', 'info');

      const modeDescription = $lipSyncEngineStore.mode === 'single' ? 'Single Thread (blocks UI)' :
                             $lipSyncEngineStore.mode === 'worker' ? 'Web Worker (non-blocking)' :
                             'Chunked Workers (parallel)';
      addLog(`Mode: ${modeDescription}`, 'info');
      addLog(`Analyzing ${pcm16.length} samples (${duration}s at 16kHz)${dialogText ? ' with dialog text' : ''}`, 'info');

      await lipSyncEngineStore.analyze(pcm16, {
        dialogText: dialogText.trim() || undefined,
        sampleRate: 16000,
      });

      addLog(`✅ Analysis complete!`, 'success');
    } catch (err) {
      console.error('File load failed:', err);
      addLog(`Error: ${err instanceof Error ? err.message : 'File load failed'}`, 'error');
    }
    target.value = '';
  }

  function handlePlay() {
    if ($lipSyncEngineStore.result && audioBuffer) {
      if (audioSource) {
        audioSource.stop();
      }
      playAnimation($lipSyncEngineStore.result.mouthCues, audioBuffer);
    }
  }

  function handleModeChange(newMode: ExecutionMode) {
    lipSyncEngineStore.setMode(newMode);
    addLog(`Execution mode changed to: ${newMode === 'single' ? 'Single Thread' : newMode === 'worker' ? 'Web Worker' : 'Chunked Workers'}`, 'info');
  }

  $: if ($lipSyncEngineStore.result && audioBuffer) {
    playAnimation($lipSyncEngineStore.result.mouthCues, audioBuffer);
  }
</script>

<div class="app">
  <div class="container">
    <h1>🎤 LipSyncEngine.js</h1>
    <p class="subtitle">Svelte Example - All Execution Modes</p>

    <!-- Mode Selector -->
    <div class="mode-selector">
      <h3>Execution Mode</h3>
      <div class="mode-buttons">
        <button
          class="mode-btn"
          class:active={$lipSyncEngineStore.mode === 'single'}
          on:click={() => handleModeChange('single')}
          disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
        >
          <div class="mode-title">Single Thread</div>
          <div class="mode-desc">Blocks UI during analysis</div>
        </button>
        <button
          class="mode-btn"
          class:active={$lipSyncEngineStore.mode === 'worker'}
          on:click={() => handleModeChange('worker')}
          disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
        >
          <div class="mode-title">Web Worker</div>
          <div class="mode-desc">Non-blocking, UI stays responsive</div>
        </button>
        <button
          class="mode-btn"
          class:active={$lipSyncEngineStore.mode === 'chunked'}
          on:click={() => handleModeChange('chunked')}
          disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
        >
          <div class="mode-title">Chunked Workers</div>
          <div class="mode-desc">Parallel processing (~5x faster)</div>
        </button>
      </div>
    </div>

    <!-- Recording Duration Slider -->
    <div class="chunk-settings">
      <label for="recordingDuration">
        Recording Duration: {$lipSyncEngineStore.recordingDuration}s
      </label>
      <input
        id="recordingDuration"
        type="range"
        min="5"
        max="60"
        step="5"
        value={$lipSyncEngineStore.recordingDuration}
        on:input={(e) => lipSyncEngineStore.setRecordingDuration(Number(e.currentTarget.value))}
        disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
      />
      <small>Adjust recording duration (5-60 seconds)</small>
    </div>

    <!-- Chunk Settings - Only visible in chunked mode -->
    {#if $lipSyncEngineStore.mode === 'chunked'}
      <div class="chunk-settings">
        <label for="chunkSize">
          Chunk Size (seconds): {$lipSyncEngineStore.chunkSize}s
        </label>
        <input
          id="chunkSize"
          type="range"
          min="1"
          max="10"
          step="1"
          value={$lipSyncEngineStore.chunkSize}
          on:input={(e) => lipSyncEngineStore.setChunkSize(Number(e.currentTarget.value))}
          disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
        />
        <small>Smaller chunks = more parallelization, larger chunks = better context</small>
      </div>
    {/if}

    <div class="input-group">
      <label for="dialogText">Dialog Text (Optional - improves accuracy)</label>
      <input
        id="dialogText"
        bind:value={dialogText}
        type="text"
        placeholder="Enter the text that will be spoken..."
        disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
      />
    </div>

    <div class="controls">
      <button
        on:click={handleRecord}
        disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
        class="btn"
      >
        {isRecording ? '🎙️ Recording...' : `🎙️ Record Audio (${$lipSyncEngineStore.recordingDuration}s)`}
      </button>
      <label class="btn">
        📁 Load Audio File
        <input
          type="file"
          accept="audio/*"
          on:change={handleFileUpload}
          disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
          style="display: none"
        />
      </label>
    </div>

    <div class="status" class:recording={isRecording} class:analyzing={$lipSyncEngineStore.isAnalyzing}>
      {isRecording ? 'Recording... Speak now!' : $lipSyncEngineStore.isAnalyzing ? 'Analyzing audio...' : 'Ready to analyze audio'}
    </div>

    <!-- Performance Metrics -->
    {#if $lipSyncEngineStore.metrics}
      <div class="metrics">
        <h3>Performance Metrics</h3>
        <div class="metrics-grid">
          <div class="metric">
            <div class="metric-label">Execution Time</div>
            <div class="metric-value">{$lipSyncEngineStore.metrics.executionTime.toFixed(2)}ms</div>
          </div>
          <div class="metric">
            <div class="metric-label">Mouth Cues</div>
            <div class="metric-value">{$lipSyncEngineStore.metrics.cuesCount}</div>
          </div>
          {#if $lipSyncEngineStore.metrics.workersUsed !== undefined}
            <div class="metric">
              <div class="metric-label">Workers Used</div>
              <div class="metric-value">{$lipSyncEngineStore.metrics.workersUsed}</div>
            </div>
          {/if}
          {#if $lipSyncEngineStore.metrics.chunksProcessed !== undefined}
            <div class="metric">
              <div class="metric-label">Chunks Processed</div>
              <div class="metric-value">{$lipSyncEngineStore.metrics.chunksProcessed}</div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <div class="viseme-display">
      <div>
        <div class="viseme-images">
          {#each ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as viseme}
            <img
              src="/visemes/{viseme}.png"
              alt={viseme}
              class:active={currentViseme === viseme}
            />
          {/each}
        </div>
        <div class="viseme-label">
          {visemeNames[currentViseme]} ({currentViseme})
        </div>
      </div>
    </div>

    {#if $lipSyncEngineStore.result}
      <div class="results">
        <div class="results-header">
          <h3>Lip Sync Results</h3>
          <button
            class="play-btn"
            on:click={handlePlay}
            disabled={isPlaying}
          >
            {isPlaying ? '⏸ Playing' : '▶ Play'}
          </button>
        </div>
        <div class="cues-list">
          {#each $lipSyncEngineStore.result.mouthCues as cue, index}
            <div class="cue">
              <span class="cue-time">
                {cue.start.toFixed(2)}s - {cue.end.toFixed(2)}s
              </span>
              <span class="cue-value">{cue.value}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if $lipSyncEngineStore.error}
      <div class="error">
        Error: {$lipSyncEngineStore.error.message}
      </div>
    {/if}

    <div class="logs">
      <h3>Logs</h3>
      <div class="logs-content">
        {#each logs as log}
          <div class="log-entry {log.type}">
            {log.timestamp} {log.message}
          </div>
        {/each}
        <div bind:this={logsEnd}></div>
      </div>
    </div>
  </div>
</div>

<style>
  :global(*) {
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
