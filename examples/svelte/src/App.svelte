<script lang="ts">
  import { onDestroy } from 'svelte';
  import { recordAudio, loadAudio } from 'lip-sync-engine';
  import type { LipSyncEngineResult, MouthCue } from 'lip-sync-engine';
  import { lipSyncEngineStore } from './stores/lipSyncEngine';
  import type { ExecutionMode } from './stores/lipSyncEngine';

  interface LogEntry {
    message: string;
    type: 'info' | 'error' | 'success';
    timestamp: string;
  }

  let dialogText = '';
  let isRecording = false;
  let currentViseme = 'X';
  let isPlaying = false;
  let audioBuffer: AudioBuffer | null = null;
  let logs: LogEntry[] = [];
  let logsEnd: HTMLDivElement;
  // One AudioContext for all playback, closed on destroy
  let audioContext: AudioContext | null = null;
  let audioSource: AudioBufferSourceNode | null = null;
  let animationFrame: number | null = null;
  let lastPlayedResult: LipSyncEngineResult | null = null;

  const SAMPLE_RATE = 16000;
  const VISEMES = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

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

  function addLog(message: string, type: LogEntry['type'] = 'info') {
    const timestamp = `[${new Date().toLocaleTimeString()}]`;
    logs = [...logs, { message, type, timestamp }];
    setTimeout(() => logsEnd?.scrollIntoView({ behavior: 'smooth' }), 0);
  }

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function modeLabel(mode: ExecutionMode): string {
    switch (mode) {
      case 'single': return 'Single Thread';
      case 'worker': return 'Web Worker';
      case 'chunked': return 'Chunked';
      case 'streaming': return 'Streaming';
    }
  }

  // Startup state of the selected mode
  $: initStatus = $lipSyncEngineStore.initError ? 'failed'
    : $lipSyncEngineStore.isInitialized ? 'ready'
    : 'initializing';
  $: initFailure = $lipSyncEngineStore.initError
    ? `Failed to initialize: ${$lipSyncEngineStore.initError.message.replace(/\.+$/, '')}. Reload the page to retry.`
    : '';

  // Log each startup step of the selected mode once
  let lastInitLog = '';
  $: {
    const key = `${$lipSyncEngineStore.mode}:${initStatus}`;
    if (key !== lastInitLog) {
      lastInitLog = key;
      const label = modeLabel($lipSyncEngineStore.mode);
      if (initStatus === 'ready') addLog(`${label} ready`, 'success');
      else if (initStatus === 'failed') addLog(initFailure, 'error');
      else addLog(`Initializing ${label}...`);
    }
  }

  function stopPlayback() {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    if (audioSource) {
      audioSource.onended = null;
      audioSource.stop();
      audioSource = null;
    }
    currentViseme = 'X';
    isPlaying = false;
  }

  onDestroy(() => {
    stopPlayback();
    audioContext?.close();
    audioContext = null;
  });

  function playAnimation(mouthCues: MouthCue[], buffer: AudioBuffer) {
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
    isPlaying = true;

    let currentCueIndex = 0;

    function updateViseme() {
      const elapsed = ctx.currentTime - startTime;

      while (currentCueIndex < mouthCues.length && mouthCues[currentCueIndex].end < elapsed) {
        currentCueIndex++;
      }

      if (currentCueIndex < mouthCues.length) {
        currentViseme = mouthCues[currentCueIndex].value;
        animationFrame = requestAnimationFrame(updateViseme);
      } else {
        currentViseme = 'X';
        animationFrame = null;
      }
    }

    updateViseme();

    source.onended = () => {
      audioSource = null;
      currentViseme = 'X';
      isPlaying = false;
    };
  }

  /** Analyze decoded audio in the selected mode and log the outcome */
  async function runAnalysis(pcm16: Int16Array) {
    const text = dialogText.trim();
    const duration = (pcm16.length / SAMPLE_RATE).toFixed(2);
    addLog(`Analyzing ${duration}s of audio${text ? ' with dialog text' : ''}...`);
    try {
      const result = await lipSyncEngineStore.analyze(pcm16, {
        dialogText: text || undefined,
        sampleRate: SAMPLE_RATE,
      });
      if (result) addLog(`Analysis complete: ${result.mouthCues.length} mouth cues`, 'success');
    } catch (err) {
      addLog(`Analysis failed: ${errorMessage(err)}`, 'error');
    }
  }

  async function handleRecord() {
    isRecording = true;
    lipSyncEngineStore.reset();
    audioBuffer = null;
    let pcm16: Int16Array;
    try {
      addLog(`Recording ${$lipSyncEngineStore.recordingDuration}s (allow microphone access if asked)...`);
      const recording = await recordAudio($lipSyncEngineStore.recordingDuration * 1000);
      pcm16 = recording.pcm16;
      audioBuffer = recording.audioBuffer;
      addLog(`Recorded ${(pcm16.length / SAMPLE_RATE).toFixed(2)}s of audio`, 'success');
    } catch (err) {
      addLog(`Recording failed: ${errorMessage(err)}`, 'error');
      return;
    } finally {
      isRecording = false;
    }
    await runAnalysis(pcm16);
  }

  async function handleFileUpload(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    target.value = '';
    if (!file) return;

    lipSyncEngineStore.reset();
    audioBuffer = null;
    let pcm16: Int16Array;
    try {
      addLog(`Loading ${file.name} (${(file.size / 1024).toFixed(2)} KB)...`);
      const loaded = await loadAudio(file);
      pcm16 = loaded.pcm16;
      audioBuffer = loaded.audioBuffer;
      addLog(`Decoded ${(pcm16.length / SAMPLE_RATE).toFixed(2)}s of audio`, 'success');
    } catch (err) {
      addLog(`Could not load the file: ${errorMessage(err)}`, 'error');
      return;
    }
    await runAnalysis(pcm16);
  }

  function handlePlay() {
    if ($lipSyncEngineStore.result && audioBuffer) {
      playAnimation($lipSyncEngineStore.result.mouthCues, audioBuffer);
    }
  }

  function handleModeChange(newMode: ExecutionMode) {
    if (newMode === $lipSyncEngineStore.mode) return;
    lipSyncEngineStore.setMode(newMode);
  }

  // Play each new result once. Without the check this block would run again
  // on every store update (mode, sliders) and replay the audio.
  $: if ($lipSyncEngineStore.result && audioBuffer && $lipSyncEngineStore.result !== lastPlayedResult) {
    lastPlayedResult = $lipSyncEngineStore.result;
    playAnimation($lipSyncEngineStore.result.mouthCues, audioBuffer);
  }
</script>

<div class="container">
  <h1>lip-sync-engine</h1>
  <p class="subtitle">Svelte example: all execution modes</p>

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
        <div class="mode-desc">Main thread (blocks the UI)</div>
      </button>
      <button
        class="mode-btn"
        class:active={$lipSyncEngineStore.mode === 'worker'}
        on:click={() => handleModeChange('worker')}
        disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
      >
        <div class="mode-title">Web Worker</div>
        <div class="mode-desc">One worker (the UI stays responsive)</div>
      </button>
      <button
        class="mode-btn"
        class:active={$lipSyncEngineStore.mode === 'chunked'}
        on:click={() => handleModeChange('chunked')}
        disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
      >
        <div class="mode-title">Chunked</div>
        <div class="mode-desc">Splits audio across up to 4 workers</div>
      </button>
      <button
        class="mode-btn"
        class:active={$lipSyncEngineStore.mode === 'streaming'}
        on:click={() => handleModeChange('streaming')}
        disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
      >
        <div class="mode-title">Streaming</div>
        <div class="mode-desc">Chunks with 500 ms context and lookahead</div>
      </button>
    </div>
  </div>

  <!-- Recording Duration Slider -->
  <div class="settings-panel">
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
  </div>

  <!-- Chunk size: only in chunked and streaming modes -->
  {#if $lipSyncEngineStore.mode === 'chunked' || $lipSyncEngineStore.mode === 'streaming'}
    <div class="settings-panel">
      <label for="chunkSize">
        Chunk Size: {$lipSyncEngineStore.chunkSize}s
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
      <small>
        {$lipSyncEngineStore.mode === 'chunked'
          ? 'Chunks are analyzed alone: smaller chunks run more in parallel but lose accuracy at the edges'
          : 'Each chunk is analyzed with 500 ms of audio before and after it'}
      </small>
    </div>
  {/if}

  <div class="input-group">
    <label for="dialogText">Dialog Text (optional, improves accuracy)</label>
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
      {isRecording ? 'Recording...' : `Record Audio (${$lipSyncEngineStore.recordingDuration}s)`}
    </button>
    <label class="btn">
      Load Audio File
      <input
        type="file"
        accept="audio/*"
        on:change={handleFileUpload}
        disabled={$lipSyncEngineStore.isAnalyzing || isRecording}
        style="display: none"
      />
    </label>
  </div>

  <div
    class="status"
    class:recording={isRecording}
    class:failed={!isRecording && !$lipSyncEngineStore.isAnalyzing && initStatus === 'failed'}
    class:analyzing={$lipSyncEngineStore.isAnalyzing || initStatus === 'initializing'}
  >
    {isRecording ? 'Recording. Speak now.'
      : $lipSyncEngineStore.isAnalyzing ? 'Analyzing audio...'
      : initStatus === 'failed' ? initFailure
      : initStatus === 'initializing' ? 'Initializing...'
      : 'Ready to analyze audio'}
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
        {#each VISEMES as viseme}
          <img
            src="/visemes/{viseme}.png"
            alt={viseme}
            class:active={currentViseme === viseme}
          />
        {/each}
      </div>
      <div class="viseme-label">
        {currentViseme}: {visemeNames[currentViseme]}
      </div>
    </div>
  </div>

  {#if $lipSyncEngineStore.result}
    <div class="results">
      <div class="results-header">
        <h3>Lip Sync Results</h3>
        <button class="play-btn" on:click={isPlaying ? stopPlayback : handlePlay}>
          {isPlaying ? 'Stop' : 'Play'}
        </button>
      </div>
      <div class="cues-list">
        {#each $lipSyncEngineStore.result.mouthCues as cue}
          <div class="cue">
            <span class="cue-time">
              {cue.start.toFixed(2)}s to {cue.end.toFixed(2)}s
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

<style>
  .container {
    background: #1a1a1a;
    border-radius: 16px;
    padding: 40px;
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

  .settings-panel {
    background: #0f0f0f;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 24px;
  }

  .settings-panel label {
    display: block;
    color: #b0b0b0;
    font-weight: 500;
    margin-bottom: 12px;
    font-size: 0.9em;
  }

  .settings-panel input[type="range"] {
    width: 100%;
    margin-bottom: 8px;
  }

  .settings-panel small {
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

  .status.recording,
  .status.failed {
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
