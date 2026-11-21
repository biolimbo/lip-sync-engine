import { useState, useRef, useEffect } from 'react';
import { recordAudio, loadAudio } from 'lip-sync-engine';
import type { MouthCue } from 'lip-sync-engine';
import { useLipSyncEngine, StartupError } from './hooks/useLipSyncEngine';
import type { ExecutionMode } from './hooks/useLipSyncEngine';
import './App.css';

interface LogEntry {
  message: string;
  type: 'info' | 'error' | 'success';
  timestamp: string;
}

const SAMPLE_RATE = 16000;

const SHAPE_NAMES: Record<string, string> = {
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

const MODES: { id: ExecutionMode; title: string; description: string }[] = [
  { id: 'single', title: 'Single Thread', description: 'Main thread (blocks the UI)' },
  { id: 'worker', title: 'Web Worker', description: 'One worker (the UI stays responsive)' },
  { id: 'chunked', title: 'Chunked', description: 'Splits audio across up to 4 workers' },
  { id: 'streaming', title: 'Streaming', description: 'Chunks with 500 ms context and lookahead' },
];

function App() {
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

  const [dialogText, setDialogText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false); // decoding an audio file
  const [currentViseme, setCurrentViseme] = useState('X');
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const lastStartupLogRef = useRef('');
  // One AudioContext for all playback, closed on unmount
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const busy = isAnalyzing || isRecording || isLoading;
  // Recording and loading work while the mode starts (analyze() waits for it),
  // but not after the mode failed to start
  const canAnalyze = !busy && !initError;
  const initFailureText = initError ? startupFailureMessage(initError) : '';

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    const timestamp = `[${new Date().toLocaleTimeString()}]`;
    setLogs(prev => [...prev, { message, type, timestamp }]);
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Log each startup step once. StrictMode runs effects twice in development,
  // so skip a message identical to the previous one.
  useEffect(() => {
    const message = initError
      ? `Failed to initialize ${modeLabel(mode)}: ${initFailureText}`
      : isInitialized
        ? `Ready (${modeLabel(mode)})`
        : `Initializing (${modeLabel(mode)})...`;
    if (message === lastStartupLogRef.current) return;
    lastStartupLogRef.current = message;
    addLog(message, initError ? 'error' : isInitialized ? 'success' : 'info');
  }, [mode, isInitialized, initError]);

  const stopPlayback = () => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioSourceRef.current) {
      audioSourceRef.current.onended = null;
      audioSourceRef.current.stop();
      audioSourceRef.current = null;
    }
    setCurrentViseme('X');
    setIsPlaying(false);
  };

  useEffect(() => {
    return () => {
      stopPlayback();
      audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, []);

  const playAnimation = (mouthCues: MouthCue[], buffer: AudioBuffer) => {
    stopPlayback();

    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
    const audioContext = audioContextRef.current;
    void audioContext.resume();

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    audioSourceRef.current = source;

    const startTime = audioContext.currentTime;
    source.start();
    setIsPlaying(true);

    let currentCueIndex = 0;

    const updateViseme = () => {
      const elapsed = audioContext.currentTime - startTime;

      while (currentCueIndex < mouthCues.length && mouthCues[currentCueIndex].end < elapsed) {
        currentCueIndex++;
      }

      if (currentCueIndex < mouthCues.length) {
        setCurrentViseme(mouthCues[currentCueIndex].value);
        animationFrameRef.current = requestAnimationFrame(updateViseme);
      } else {
        setCurrentViseme('X');
        animationFrameRef.current = null;
      }
    };

    updateViseme();

    source.onended = () => {
      audioSourceRef.current = null;
      setCurrentViseme('X');
      setIsPlaying(false);
    };
  };

  // Clear the previous result and playback before new audio arrives
  const startOver = () => {
    stopPlayback();
    reset();
    setAudioBuffer(null);
  };

  const runAnalysis = async (pcm16: Int16Array, buffer: AudioBuffer) => {
    setAudioBuffer(buffer);
    const text = dialogText.trim();
    addLog(text ? `Analyzing with dialog text "${text}"...` : 'Analyzing...');
    try {
      const { metrics: m } = await analyze(pcm16, {
        dialogText: text || undefined,
        sampleRate: SAMPLE_RATE,
      });
      addLog(`Analyzed in ${Math.round(m.executionTime)} ms: ${m.cuesCount} cues (${modeLabel(mode)})`, 'success');
    } catch (err) {
      // A startup failure is already logged and shown as initError
      if (!(err instanceof StartupError)) addLog(`Analysis failed: ${errorMessage(err)}`, 'error');
    }
  };

  const handleRecord = async () => {
    startOver();
    setIsRecording(true);
    let recording: Awaited<ReturnType<typeof recordAudio>>;
    try {
      addLog(`Recording ${recordingDuration} s (allow microphone access if asked)...`);
      recording = await recordAudio(recordingDuration * 1000);
    } catch (err) {
      addLog(`Recording failed: ${errorMessage(err)}`, 'error');
      return;
    } finally {
      setIsRecording(false);
    }
    addLog(`Recorded ${seconds(recording.pcm16)} s`);
    await runAnalysis(recording.pcm16, recording.audioBuffer);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ''; // allow loading the same file again
    if (!file) return;

    startOver();
    setIsLoading(true);
    let audio: Awaited<ReturnType<typeof loadAudio>>;
    try {
      addLog(`Loading ${file.name}...`);
      audio = await loadAudio(file);
    } catch (err) {
      addLog(`Could not load ${file.name}: ${errorMessage(err)}`, 'error');
      return;
    } finally {
      setIsLoading(false);
    }
    addLog(`Loaded ${file.name} (${seconds(audio.pcm16)} s)`);
    await runAnalysis(audio.pcm16, audio.audioBuffer);
  };

  const handlePlay = () => {
    if (result && audioBuffer) {
      playAnimation(result.mouthCues, audioBuffer);
    }
  };

  // Play each new result once (audioBuffer is set before analysis starts)
  useEffect(() => {
    if (result && audioBuffer) {
      playAnimation(result.mouthCues, audioBuffer);
    }
  }, [result]);

  const statusClass = isRecording ? 'recording'
    : isAnalyzing || isLoading ? 'analyzing'
    : initError ? 'error'
    : !isInitialized ? 'analyzing'
    : '';
  const statusText = isRecording ? 'Recording. Speak now.'
    : isAnalyzing ? 'Analyzing audio...'
    : isLoading ? 'Loading audio file...'
    : initError ? 'Failed to initialize'
    : !isInitialized ? 'Initializing...'
    : 'Ready to analyze audio';

  return (
    <div className="app">
      <div className="container">
        <h1>lip-sync-engine</h1>
        <p className="subtitle">React example with four execution modes</p>

        <div className="mode-selector">
          <h3>Execution Mode</h3>
          <div className="mode-buttons">
            {MODES.map(({ id, title, description }) => (
              <button
                key={id}
                className={`mode-btn ${mode === id ? 'active' : ''}`}
                onClick={() => setMode(id)}
                disabled={busy}
              >
                <div className="mode-title">{title}</div>
                <div className="mode-desc">{description}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="chunk-settings">
          <label htmlFor="recordingDuration">
            Recording Duration: {recordingDuration} s
          </label>
          <input
            id="recordingDuration"
            type="range"
            min="5"
            max="60"
            step="5"
            value={recordingDuration}
            onChange={(e) => setRecordingDuration(Number(e.target.value))}
            disabled={busy}
          />
          <small>5 to 60 seconds</small>
        </div>

        {(mode === 'chunked' || mode === 'streaming') && (
          <div className="chunk-settings">
            <label htmlFor="chunkSize">
              Chunk Size: {chunkSize} s
            </label>
            <input
              id="chunkSize"
              type="range"
              min="1"
              max="10"
              step="1"
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
              disabled={busy}
            />
            <small>
              {mode === 'chunked'
                ? 'Chunks are analyzed alone: smaller chunks run more in parallel but lose accuracy at the edges'
                : 'Chunks are analyzed with up to 500 ms of audio before and after them'}
            </small>
          </div>
        )}

        <div className="input-group">
          <label htmlFor="dialogText">
            Dialog Text (optional, improves accuracy)
          </label>
          <input
            id="dialogText"
            type="text"
            value={dialogText}
            onChange={(e) => setDialogText(e.target.value)}
            placeholder="Enter the text that will be spoken"
            disabled={busy}
          />
        </div>

        <div className="controls">
          <button
            onClick={handleRecord}
            disabled={!canAnalyze}
            className="btn"
          >
            {isRecording ? 'Recording...' : `Record Audio (${recordingDuration} s)`}
          </button>
          <label className={`btn ${canAnalyze ? '' : 'disabled'}`} aria-disabled={!canAnalyze}>
            Load Audio File
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              disabled={!canAnalyze}
              hidden
            />
          </label>
        </div>

        <div className={`status ${statusClass}`}>{statusText}</div>

        {metrics && (
          <div className="metrics">
            <h3>Performance Metrics</h3>
            <div className="metrics-grid">
              <div className="metric">
                <div className="metric-label">Execution Time</div>
                <div className="metric-value">{Math.round(metrics.executionTime)} ms</div>
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
              {Object.keys(SHAPE_NAMES).map((viseme) => (
                <img
                  key={viseme}
                  src={`/visemes/${viseme}.png`}
                  alt={viseme}
                  className={currentViseme === viseme ? 'active' : ''}
                />
              ))}
            </div>
            <div className="viseme-label">
              {currentViseme}: {SHAPE_NAMES[currentViseme]}
            </div>
          </div>
        </div>

        {result && (
          <div className="results">
            <div className="results-header">
              <h3>Lip Sync Results</h3>
              <button
                className="play-btn"
                onClick={isPlaying ? stopPlayback : handlePlay}
                disabled={!audioBuffer}
              >
                {isPlaying ? 'Stop' : 'Play'}
              </button>
            </div>
            <div className="cues-list">
              {result.mouthCues.map((cue, index) => (
                <div key={index} className="cue">
                  <span className="cue-time">
                    {cue.start.toFixed(2)} s to {cue.end.toFixed(2)} s
                  </span>
                  <span className="cue-value">{cue.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {initError && (
          <div className="error">{initFailureText}</div>
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

/** Short mode name used in log lines */
function modeLabel(mode: ExecutionMode): string {
  switch (mode) {
    case 'single': return 'Single Thread';
    case 'worker': return 'Web Worker';
    case 'chunked': return 'Chunked';
    case 'streaming': return 'Streaming';
  }
}

/**
 * Error text for a mode that failed to start. The library does not keep a
 * failed startup, so selecting the mode again tries again.
 */
function startupFailureMessage(error: Error): string {
  return `${error.message.replace(/\.+$/, '')}. Switch modes or reload the page to retry.`;
}

function seconds(pcm16: Int16Array): string {
  return (pcm16.length / SAMPLE_RATE).toFixed(2);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default App;
