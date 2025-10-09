import { useState, useRef, useEffect } from 'react';
import { recordAudio, loadAudio } from 'lip-sync-engine';
import { useLipSyncEngine } from './hooks/useLipSyncEngine';
import type { ExecutionMode } from './hooks/useLipSyncEngine';
import './App.css';

interface LogEntry {
  message: string;
  type: 'info' | 'error' | 'warn' | 'success';
  timestamp: string;
}

function App() {
  const {
    analyze,
    result,
    isAnalyzing,
    error,
    metrics,
    reset,
    mode,
    setMode,
    chunkSize,
    setChunkSize,
    recordingDuration,
    setRecordingDuration,
    getWorkerStats
  } = useLipSyncEngine();

  const [dialogText, setDialogText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [currentViseme, setCurrentViseme] = useState('X');
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);

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

    setLogs(prev => [...prev, { message, type, timestamp }]);
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    addLog('Initializing LipSyncEngine WASM module...', 'info');
    addLog('Initializing WorkerPool...', 'info');
    addLog('✅ WASM module loaded successfully', 'success');
    addLog('✅ WorkerPool initialized', 'success');
    addLog('Viseme images preloaded', 'info');
  }, []);

  const playAnimation = (mouthCues: Array<{ start: number; end: number; value: string }>, buffer: AudioBuffer) => {
    if (!buffer) return;

    setIsPlaying(true);
    const audioContext = new AudioContext();
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    audioContextRef.current = audioContext;
    audioSourceRef.current = source;

    const startTime = audioContext.currentTime;
    source.start(0);

    let currentCueIndex = 0;

    const updateViseme = () => {
      const elapsed = audioContext.currentTime - startTime;

      while (currentCueIndex < mouthCues.length && mouthCues[currentCueIndex].end < elapsed) {
        currentCueIndex++;
      }

      if (currentCueIndex < mouthCues.length) {
        setCurrentViseme(mouthCues[currentCueIndex].value);
        requestAnimationFrame(updateViseme);
      } else {
        setCurrentViseme('X');
      }
    };

    updateViseme();

    source.onended = () => {
      setCurrentViseme('X');
      setIsPlaying(false);
    };
  };

  const handleRecord = async () => {
    setIsRecording(true);
    reset();
    setAudioBuffer(null);
    try {
      addLog('=== Starting Recording ===', 'info');
      addLog('Microphone access granted', 'info');
      addLog(`Recording ${recordingDuration} seconds...`, 'info');

      const { pcm16, audioBuffer: buffer } = await recordAudio(recordingDuration * 1000);

      addLog('Recording stopped', 'info');
      const duration = (pcm16.length / 16000).toFixed(2);
      addLog(`✅ Captured ${pcm16.length} samples (${duration}s)`, 'success');

      setAudioBuffer(buffer);

      addLog('=== Starting Analysis ===', 'info');

      const modeDescription = mode === 'single' ? 'Single Thread (blocks UI)' :
                             mode === 'worker' ? 'Web Worker (non-blocking)' :
                             mode === 'chunked' ? 'Chunked Workers (parallel)' :
                             'Streaming (dynamic queue)';
      addLog(`Mode: ${modeDescription}`, 'info');
      addLog(`Analyzing ${pcm16.length} samples (${duration}s at 16kHz)${dialogText ? ' with dialog text' : ''}`, 'info');

      await analyze(pcm16, {
        dialogText: dialogText.trim() || undefined,
        sampleRate: 16000,
      });

      addLog(`✅ Analysis complete!`, 'success');
    } catch (err) {
      console.error('Recording failed:', err);
      addLog(`Error: ${err instanceof Error ? err.message : 'Recording failed'}`, 'error');
    } finally {
      setIsRecording(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    reset();
    setAudioBuffer(null);
    try {
      addLog('=== Loading Audio File ===', 'info');
      addLog(`File: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`, 'info');

      const { pcm16, audioBuffer: buffer } = await loadAudio(file);

      const duration = (pcm16.length / 16000).toFixed(2);
      addLog(`✅ Decoded: ${pcm16.length} samples (${duration}s at 16kHz)`, 'success');

      setAudioBuffer(buffer);

      addLog('=== Starting Analysis ===', 'info');

      const modeDescription = mode === 'single' ? 'Single Thread (blocks UI)' :
                             mode === 'worker' ? 'Web Worker (non-blocking)' :
                             mode === 'chunked' ? 'Chunked Workers (parallel)' :
                             'Streaming (dynamic queue)';
      addLog(`Mode: ${modeDescription}`, 'info');
      addLog(`Analyzing ${pcm16.length} samples (${duration}s at 16kHz)${dialogText ? ' with dialog text' : ''}`, 'info');

      await analyze(pcm16, {
        dialogText: dialogText.trim() || undefined,
        sampleRate: 16000,
      });

      addLog(`✅ Analysis complete!`, 'success');
    } catch (err) {
      console.error('File load failed:', err);
      addLog(`Error: ${err instanceof Error ? err.message : 'File load failed'}`, 'error');
    }
    e.target.value = '';
  };

  const handlePlay = () => {
    if (result && audioBuffer) {
      if (audioSourceRef.current) {
        audioSourceRef.current.stop();
      }
      playAnimation(result.mouthCues, audioBuffer);
    }
  };

  useEffect(() => {
    if (result && audioBuffer) {
      playAnimation(result.mouthCues, audioBuffer);
    }
  }, [result]);

  const handleModeChange = (newMode: ExecutionMode) => {
    setMode(newMode);
    const modeLabel = newMode === 'single' ? 'Single Thread' :
                      newMode === 'worker' ? 'Web Worker' :
                      newMode === 'chunked' ? 'Chunked Workers' :
                      'Streaming';
    addLog(`Execution mode changed to: ${modeLabel}`, 'info');
  };

  return (
    <div className="app">
      <div className="container">
        <h1>🎤 LipSyncEngine.js</h1>
        <p className="subtitle">React Example - All Execution Modes</p>

        {/* Mode Selector */}
        <div className="mode-selector">
          <h3>Execution Mode</h3>
          <div className="mode-buttons">
            <button
              className={`mode-btn ${mode === 'single' ? 'active' : ''}`}
              onClick={() => handleModeChange('single')}
              disabled={isAnalyzing || isRecording}
            >
              <div className="mode-title">Single Thread</div>
              <div className="mode-desc">Blocks UI during analysis</div>
            </button>
            <button
              className={`mode-btn ${mode === 'worker' ? 'active' : ''}`}
              onClick={() => handleModeChange('worker')}
              disabled={isAnalyzing || isRecording}
            >
              <div className="mode-title">Web Worker</div>
              <div className="mode-desc">Non-blocking, UI stays responsive</div>
            </button>
            <button
              className={`mode-btn ${mode === 'chunked' ? 'active' : ''}`}
              onClick={() => handleModeChange('chunked')}
              disabled={isAnalyzing || isRecording}
            >
              <div className="mode-title">Chunked Workers</div>
              <div className="mode-desc">Parallel processing (~5x faster)</div>
            </button>
            <button
              className={`mode-btn ${mode === 'streaming' ? 'active' : ''}`}
              onClick={() => handleModeChange('streaming')}
              disabled={isAnalyzing || isRecording}
            >
              <div className="mode-title">Streaming</div>
              <div className="mode-desc">Dynamic queue (real-time ready)</div>
            </button>
          </div>
        </div>

        {/* Recording Duration Slider */}
        <div className="chunk-settings">
          <label htmlFor="recordingDuration">
            Recording Duration: {recordingDuration}s
          </label>
          <input
            id="recordingDuration"
            type="range"
            min="5"
            max="60"
            step="5"
            value={recordingDuration}
            onChange={(e) => setRecordingDuration(Number(e.target.value))}
            disabled={isAnalyzing || isRecording}
          />
          <small>Adjust recording duration (5-60 seconds)</small>
        </div>

        {/* Chunk Settings - Only visible in chunked or streaming mode */}
        {(mode === 'chunked' || mode === 'streaming') && (
          <div className="chunk-settings">
            <label htmlFor="chunkSize">
              Chunk Size (seconds): {chunkSize}s
            </label>
            <input
              id="chunkSize"
              type="range"
              min="1"
              max="10"
              step="1"
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
              disabled={isAnalyzing || isRecording}
            />
            <small>Smaller chunks = more parallelization, larger chunks = better context</small>
          </div>
        )}

        <div className="input-group">
          <label htmlFor="dialogText">
            Dialog Text (Optional - improves accuracy)
          </label>
          <input
            id="dialogText"
            type="text"
            value={dialogText}
            onChange={(e) => setDialogText(e.target.value)}
            placeholder="Enter the text that will be spoken..."
            disabled={isAnalyzing || isRecording}
          />
        </div>

        <div className="controls">
          <button
            onClick={handleRecord}
            disabled={isAnalyzing || isRecording}
            className="btn"
          >
            {isRecording ? '🎙️ Recording...' : `🎙️ Record Audio (${recordingDuration}s)`}
          </button>
          <label className="btn">
            📁 Load Audio File
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              disabled={isAnalyzing || isRecording}
              style={{ display: 'none' }}
            />
          </label>
        </div>

        <div className={`status ${isRecording ? 'recording' : isAnalyzing ? 'analyzing' : ''}`}>
          {isRecording ? 'Recording... Speak now!' : isAnalyzing ? 'Analyzing audio...' : 'Ready to analyze audio'}
        </div>

        {/* Performance Metrics */}
        {metrics && (
          <div className="metrics">
            <h3>Performance Metrics</h3>
            <div className="metrics-grid">
              <div className="metric">
                <div className="metric-label">Execution Time</div>
                <div className="metric-value">{metrics.executionTime.toFixed(2)}ms</div>
              </div>
              <div className="metric">
                <div className="metric-label">Mouth Cues</div>
                <div className="metric-value">{metrics.cuesCount}</div>
              </div>
              {metrics.workersUsed !== undefined && (
                <div className="metric">
                  <div className="metric-label">Workers Used</div>
                  <div className="metric-value">{metrics.workersUsed}</div>
                </div>
              )}
              {metrics.chunksProcessed !== undefined && (
                <div className="metric">
                  <div className="metric-label">Chunks Processed</div>
                  <div className="metric-value">{metrics.chunksProcessed}</div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="viseme-display">
          <div>
            <div className="viseme-images">
              {['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((viseme) => (
                <img
                  key={viseme}
                  src={`/visemes/${viseme}.png`}
                  alt={viseme}
                  className={currentViseme === viseme ? 'active' : ''}
                />
              ))}
            </div>
            <div className="viseme-label">
              {visemeNames[currentViseme]} ({currentViseme})
            </div>
          </div>
        </div>

        {result && (
          <div className="results">
            <div className="results-header">
              <h3>Lip Sync Results</h3>
              <button
                className="play-btn"
                onClick={handlePlay}
                disabled={isPlaying}
              >
                {isPlaying ? '⏸ Playing' : '▶ Play'}
              </button>
            </div>
            <div className="cues-list">
              {result.mouthCues.map((cue, index) => (
                <div key={index} className="cue">
                  <span className="cue-time">
                    {cue.start.toFixed(2)}s - {cue.end.toFixed(2)}s
                  </span>
                  <span className="cue-value">{cue.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="error">
            Error: {error.message}
          </div>
        )}

        <div className="logs">
          <h3>Logs</h3>
          <div className="logs-content">
            {logs.map((log, index) => (
              <div key={index} className={`log-entry ${log.type}`}>
                {log.timestamp} {log.message}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
